/**
 * `POST /v1/pdf` (plan §5.9): a PDF job on a staged file. The original is never modified: the answer is a new file
 * and the engine's report, or `202` with a job to poll. The job's own schema (`PdfJob`) arrives with wave 2; until
 * then the client sends any JSON object with an `op` and the gateway validates it.
 */
import { isBytes } from '../wire/bytes.js';
import { inputFailure } from '../wire/errors.js';
import type { WireFailure } from '../wire/types.js';
import { FILE_REF } from './files.js';
import { parseJobRef } from './jobs.js';
import type { ClientContext, ResponseMeta, SignedPost } from './request.js';
import { badResponse, guard, isRecord, isText, jsonBody, readJson, send } from './request.js';

export interface PdfJobSpec {
  readonly op: string;
  readonly [key: string]: unknown;
}

export interface PdfInput extends SignedPost {
  fileRef: string;
  job: PdfJobSpec;
}

export type PdfResult =
  | { ok: true; kind: 'done'; fileRef: string; report: { [key: string]: unknown }; meta: ResponseMeta }
  | { ok: true; kind: 'job'; jobId: string; pollToken: string; meta: ResponseMeta }
  | WireFailure;

export const pdf = (ctx: ClientContext, input: PdfInput): Promise<PdfResult> =>
  guard(async () => {
    if (!input || typeof input.fileRef !== 'string' || !FILE_REF.test(input.fileRef)) return inputFailure('input', 'fileRef is not a platform file reference');
    if (!isRecord(input.job) || typeof input.job.op !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(input.job.op)) return inputFailure('input', 'job must be an object with an op');
    const body = jsonBody({ fileRef: input.fileRef, job: input.job });
    if (!isBytes(body)) return body;
    const r = await send(ctx, { method: 'POST', path: '/v1/pdf', body, contentType: 'application/json', claim: input.claim, idempotencyKey: input.idempotencyKey });
    if (r.ok === false) return r;
    const v = readJson(r.body);
    if (r.status === 202) {
      const ref = parseJobRef(v);
      return ref === null ? badResponse('job', r.meta) : { ok: true, kind: 'job', jobId: ref.jobId, pollToken: ref.pollToken, meta: r.meta };
    }
    if (r.status !== 200 || !isRecord(v) || !isText(v.fileRef, 256, FILE_REF) || !isRecord(v.report)) return badResponse('PDF result', r.meta);
    return { ok: true, kind: 'done', fileRef: v.fileRef, report: v.report, meta: r.meta };
  });
