/**
 * Jobs (plan §5.9, §5.10): `POST /v1/jobs` and `GET /v1/jobs/:id` for the host (signed), the poll URL a browser may
 * use (`GET /v1/jobs/:id?t=`, nothing else), and `verifyCallback` for the gateway's signed completion callback.
 */
import { check, s } from '../schema/index.js';
import { rfc3986Encode } from '../wire/canonical.js';
import { verifyRequest } from '../wire/headers.js';
import type { IncomingRequest } from '../wire/headers.js';
import { inputFailure, wireFailure } from '../wire/errors.js';
import { utf8Decode } from '../wire/bytes.js';
import type { WireClock, WireCrypto, WireFailure } from '../wire/types.js';
import { APP_ID_PATTERN, JOB_ID_PATTERN, WIRE_LIMITS } from '../wire/types.js';
import type { ClientContext, ResponseMeta, SignedPost } from './request.js';
import { badResponse, guard, isRecord, isText, jsonBody, readJson, send } from './request.js';

export const JOB_ID = new RegExp(JOB_ID_PATTERN);
const OP = /^[a-z][a-z0-9_.-]{0,63}$/;

export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type JobState = (typeof JOB_STATES)[number];

export interface JobStatus {
  state: JobState;
  /** 0 to 1. */
  progress: number;
  /** The job's result (JSON), once it succeeded. */
  result?: unknown;
  error?: { code: string; message: string };
}

export interface CreatedJob {
  jobId: string;
  /** For the browser's `GET /v1/jobs/:id?t=` (`jobPollUrl`). */
  pollToken: string;
  state: JobState;
}

export interface CreateJobInput extends SignedPost {
  op: string;
  input: { readonly [key: string]: unknown };
}

export interface GetJobInput {
  jobId: string;
  /** A `job-read` claim: the gateway reads only the caller's own jobs. */
  claim?: string;
}

export type CreateJobResult = { ok: true; job: CreatedJob; meta: ResponseMeta } | WireFailure;
export type GetJobResult = { ok: true; job: JobStatus; meta: ResponseMeta } | WireFailure;

const isState = (v: unknown): v is JobState => typeof v === 'string' && (JOB_STATES as readonly string[]).indexOf(v) !== -1;
const isPollToken = (v: unknown): v is string => isText(v, WIRE_LIMITS.pollTokenMax, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);

/** A job reference in a 202 answer (`/v1/pdf`, `/v1/render`, `/v1/jobs`), or null. */
export const parseJobRef = (v: unknown): { jobId: string; pollToken: string } | null =>
  isRecord(v) && isText(v.jobId, 128, JOB_ID) && isPollToken(v.pollToken) ? { jobId: v.jobId, pollToken: v.pollToken } : null;

/** A job's status, or null. */
export const parseJobStatus = (v: unknown): JobStatus | null => {
  if (!isRecord(v) || !isState(v.state) || typeof v.progress !== 'number' || !(v.progress >= 0 && v.progress <= 1)) return null;
  const out: JobStatus = { state: v.state, progress: v.progress };
  if (v.result !== undefined) out.result = v.result;
  if (v.error !== undefined) {
    if (!isRecord(v.error) || !isText(v.error.code, 64) || !isText(v.error.message, WIRE_LIMITS.errorMessageMax)) return null;
    out.error = { code: v.error.code, message: v.error.message };
  }
  return out;
};

export const createJob = (ctx: ClientContext, input: CreateJobInput): Promise<CreateJobResult> =>
  guard(async () => {
    if (!input || typeof input.op !== 'string' || !OP.test(input.op)) return inputFailure('input', 'op must be a job operation name');
    if (!isRecord(input.input)) return inputFailure('input', 'input must be a JSON object');
    const body = jsonBody({ op: input.op, input: input.input });
    if (!(body instanceof Uint8Array)) return body;
    const r = await send(ctx, {
      method: 'POST',
      path: '/v1/jobs',
      body,
      contentType: 'application/json',
      claim: input.claim,
      idempotencyKey: input.idempotencyKey,
    });
    if (r.ok === false) return r;
    const v = r.status === 200 || r.status === 201 || r.status === 202 ? readJson(r.body) : undefined;
    const ref = parseJobRef(v);
    if (ref === null || !isRecord(v) || !isState(v.state)) return badResponse('job', r.meta);
    return { ok: true, job: { jobId: ref.jobId, pollToken: ref.pollToken, state: v.state }, meta: r.meta };
  });

export const getJob = (ctx: ClientContext, input: GetJobInput): Promise<GetJobResult> =>
  guard(async () => {
    if (!input || typeof input.jobId !== 'string' || !JOB_ID.test(input.jobId)) return inputFailure('input', 'jobId is not a platform job id');
    const r = await send(ctx, { method: 'GET', path: `/v1/jobs/${input.jobId}`, claim: input.claim });
    if (r.ok === false) return r;
    const job = r.status === 200 ? parseJobStatus(readJson(r.body)) : null;
    if (job === null) return badResponse('job status', r.meta);
    return { ok: true, job, meta: r.meta };
  });

/**
 * The URL a browser polls (`GET /v1/jobs/:id?t=`): the only platform call a browser makes, with a token that is
 * bound to the job, lives at most an hour and allows GET only. Null for a bad origin, job id or token.
 */
export const jobPollUrl = (baseUrl: string, jobId: string, pollToken: string): string | null => {
  const origin = typeof baseUrl === 'string' ? baseUrl.replace(/\/+$/, '') : '';
  if (!/^(https:\/\/[A-Za-z0-9.-]+(:[0-9]{1,5})?|http:\/\/(localhost|127\.0\.0\.1)(:[0-9]{1,5})?)$/.test(origin)) return null;
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId) || !isPollToken(pollToken)) return null;
  return `${origin}/v1/jobs/${jobId}?t=${rfc3986Encode(pollToken)}`;
};

// ── The completion callback (plan §5.10; used only if async callbacks are adopted) ──────────────────────────────

export interface JobCompletedEvent {
  type: 'platform.job.completed';
  jobId: string;
  app: string;
  state: 'succeeded' | 'failed';
  resultRef?: string;
  error?: { code: string; message: string };
  /** ISO 8601, UTC. */
  finishedAt: string;
}

const JobCompletedS = s.object({
  type: s.literal('platform.job.completed'),
  jobId: s.text({ max: 128, pattern: JOB_ID_PATTERN, singleLine: true }),
  app: s.text({ max: 32, pattern: APP_ID_PATTERN, singleLine: true }),
  state: s.enum(['succeeded', 'failed']),
  resultRef: s.optional(s.text({ max: 256, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$', singleLine: true })),
  error: s.optional(s.object({ code: s.text({ max: 64, singleLine: true }), message: s.text({ max: WIRE_LIMITS.errorMessageMax }) })),
  finishedAt: s.text({ max: 40, pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,3})?Z$', singleLine: true }),
});

export interface CallbackRequest extends IncomingRequest {
  body: Uint8Array;
}

export interface VerifyCallbackOptions {
  /** The gateway's key ring for this host: the secret for (app, kid). */
  keys: (app: string, kid: string) => Uint8Array | null | undefined;
  crypto: WireCrypto;
  now: WireClock;
}

export type VerifyCallbackResult = { ok: true; event: JobCompletedEvent; app: string; kid: string } | WireFailure;

/**
 * Verify the gateway's completion callback: a signed POST (same HMAC scheme, Idempotency-Key, no claim), at most
 * `WIRE_LIMITS.callbackBodyMax` bytes, whose JSON is exactly a `JobCompletedEvent` for the signing app. Never
 * throws.
 */
export const verifyCallback = (req: CallbackRequest, opts: VerifyCallbackOptions): Promise<VerifyCallbackResult> =>
  guard(async () => {
    if (!req || req.method !== 'POST' || !(req.body instanceof Uint8Array)) return inputFailure('input', 'a callback is a POST with a body');
    if (req.body.length > WIRE_LIMITS.callbackBodyMax) return wireFailure('too-large', 'the callback body is too big');
    const v = await verifyRequest(req, req.body, { ...opts, claim: 'none', maxBodyBytes: WIRE_LIMITS.callbackBodyMax });
    if (v.ok === false) return v;
    const text = utf8Decode(req.body);
    let parsed: unknown;
    try {
      parsed = text === null ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const r = parsed === undefined ? null : check(JobCompletedS, parsed);
    if (r === null || r.ok === false) return inputFailure('input', 'the callback is not a platform.job.completed event');
    const event = r.value as JobCompletedEvent;
    if (event.app !== v.app) return wireFailure('wrong-app', 'the callback names another app');
    return { ok: true, event, app: v.app, kid: v.kid };
  });
