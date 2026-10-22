// HTTP + SSE client for Comic Studio (v4) — `/api/comic/*` (server/src/routes/comic.ts).
//
// Every call goes through services/apiClient (auth token, BYOK provider keys, source
// governance headers), and every failure surfaces as a StudioApiError whose `message`
// is safe to show the user verbatim. The stream reader adds what a long-lived studio
// stream needs on top of readSSEStream: tolerant event parsing (unknown/malformed events
// are skipped), a 45 s idle watchdog (any byte — including the server's 15 s keep-alive
// comments — resets it), early-close detection, and caller cancellation.

import { get, post, postStream } from '../../services/apiClient';
import { readSSEStream } from '../../services/sse';
import { normalizeDoc, type ComicDoc, type QualityTier } from '../../shared/comic/doc';
import { STREAM_EVENT_NAMES, type StreamRequest, type StudioEvent } from '../../shared/comic/events';
import type { ImageModelSpec, TierPreset } from '../../shared/comic/models';

/** No bytes for this long (the server heartbeats every 15 s) ⇒ the connection is dead. */
export const STREAM_IDLE_TIMEOUT_MS = 45_000;
/** Paths per /urls request. */
const SIGN_BATCH = 100;

// ── Errors ───────────────────────────────────────────────────────────────────

export type StudioApiErrorKind =
  | 'billing'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'bad_request'
  | 'rate_limit'
  | 'network'
  | 'connection_lost'
  | 'server'
  | 'aborted';

export class StudioApiError extends Error {
  readonly kind: StudioApiErrorKind;
  /** HTTP status (0 = never reached the server). */
  readonly status: number;
  /** Whether "Try again" is a sensible next step. */
  readonly retryable: boolean;
  /** Raw server/transport message, for logs. */
  readonly detail?: string;

  constructor(kind: StudioApiErrorKind, message: string, opts: { status?: number; retryable?: boolean; detail?: string } = {}) {
    super(message);
    this.name = 'StudioApiError';
    this.kind = kind;
    this.status = opts.status ?? 0;
    this.retryable = opts.retryable ?? false;
    if (opts.detail) this.detail = opts.detail;
  }
}

export const isAbortError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; kind?: string };
  return e.name === 'AbortError' || e.kind === 'aborted';
};

const abortError = () => new StudioApiError('aborted', 'Cancelled.');

const connectionLost = () =>
  new StudioApiError('connection_lost', 'Connection lost — the studio stopped responding. Resyncing your comic…', {
    retryable: true
  });

interface ErrorLike {
  status?: unknown;
  message?: unknown;
  name?: unknown;
}

/**
 * Map any thrown error (apiClient ApiError, fetch TypeError, our own) to a StudioApiError
 * with a friendly message. Server-provided messages are kept for 4xx answers (the studio
 * routes send user-safe text); transport and 5xx failures get our own wording.
 */
export const toStudioApiError = (err: unknown, context: 'project' | 'public' | 'generic' = 'generic'): StudioApiError => {
  if (err instanceof StudioApiError) return err;
  if (isAbortError(err)) return abortError();
  const e = (err && typeof err === 'object' ? err : {}) as ErrorLike;
  const status = typeof e.status === 'number' ? e.status : undefined;
  const raw = typeof e.message === 'string' ? e.message.trim() : '';
  // apiClient falls back to the HTTP status text when the body has no message.
  const serverSaid = raw && !/^(bad request|unauthorized|payment required|forbidden|not found|conflict|internal server error|bad gateway|service unavailable|gateway timeout)$/i.test(raw) ? raw : '';

  switch (status) {
    case undefined:
      return new StudioApiError('network', raw || 'Something went wrong talking to the studio.', { retryable: true, detail: raw });
    case 0:
      return new StudioApiError(
        'network',
        "Couldn't reach the studio server. It may be waking up — check your connection and try again in a moment.",
        { status: 0, retryable: true, detail: raw }
      );
    case 401:
      return new StudioApiError('auth', 'Your session expired — sign in again to keep working on this comic.', { status, detail: raw });
    case 402:
      return new StudioApiError(
        'billing',
        serverSaid || "You're out of studio credit for now. Top up, or connect your own Gemini or OpenRouter key in Settings → API keys.",
        { status, detail: raw }
      );
    case 403:
      return new StudioApiError('forbidden', serverSaid || "You don't have access to do that with this comic.", { status, detail: raw });
    case 404:
      return new StudioApiError(
        'not_found',
        context === 'public'
          ? "This comic isn't published, or its creator made it private."
          : context === 'project'
            ? "This comic doesn't exist or you don't have access to it."
            : serverSaid || "That wasn't found — it may have been deleted.",
        { status, detail: raw }
      );
    case 409:
      return new StudioApiError('conflict', serverSaid || 'That changed in the meantime — refresh and try again.', { status, retryable: true, detail: raw });
    case 429:
      return new StudioApiError('rate_limit', 'Too many requests in a short time. Give it a few seconds and try again.', {
        status,
        retryable: true,
        detail: raw
      });
    default:
      if (status >= 500) {
        return new StudioApiError(
          'server',
          status === 502 || status === 503
            ? 'The studio server is starting up or briefly unavailable. Try again in a moment.'
            : 'The studio server hit a problem. Try again in a moment.',
          { status, retryable: true, detail: raw }
        );
      }
      return new StudioApiError('bad_request', serverSaid || "The studio couldn't do that.", { status, detail: raw });
  }
};

// ── Response validation ──────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const asUrls = (v: unknown): Record<string, string> => {
  if (!isObject(v)) return {};
  const out: Record<string, string> = {};
  for (const [path, url] of Object.entries(v)) if (typeof url === 'string' && url) out[path] = url;
  return out;
};

const asDoc = (v: unknown): ComicDoc => {
  if (!isObject(v) || typeof v.id !== 'string' || !v.id) {
    throw new StudioApiError('server', 'The studio sent back an unreadable comic. Try reloading.', { status: 200 });
  }
  return normalizeDoc(v as Partial<ComicDoc> & { id: string });
};

const projectPath = (id: string) => `/api/comic/projects/${encodeURIComponent(id)}`;

// ── Projects ─────────────────────────────────────────────────────────────────

export async function createStudioProject(input: {
  title?: string;
  importFromProjectId?: string;
}): Promise<{ projectId: string; doc: ComicDoc; urls: Record<string, string> }> {
  try {
    const res = await post<typeof input, { projectId?: unknown; doc?: unknown; urls?: unknown }>('/api/comic/projects', input);
    const doc = asDoc(res?.doc);
    const projectId = typeof res?.projectId === 'string' && res.projectId ? res.projectId : doc.id;
    return { projectId, doc, urls: asUrls(res?.urls) };
  } catch (err) {
    throw toStudioApiError(err, 'generic');
  }
}

export async function loadStudioProject(id: string, opts: { signal?: AbortSignal } = {}): Promise<{ doc: ComicDoc; urls: Record<string, string> }> {
  try {
    const res = await get<{ doc?: unknown; urls?: unknown }>(projectPath(id), { signal: opts.signal });
    return { doc: asDoc(res?.doc), urls: asUrls(res?.urls) };
  } catch (err) {
    throw toStudioApiError(err, 'project');
  }
}

/** Published comic for the public reader. Works logged out (the token is optional). */
export async function loadPublicComic(id: string, opts: { signal?: AbortSignal } = {}): Promise<{ doc: ComicDoc; urls: Record<string, string> }> {
  try {
    const res = await get<{ doc?: unknown; urls?: unknown }>(`/api/comic/public/${encodeURIComponent(id)}`, { signal: opts.signal });
    return { doc: asDoc(res?.doc), urls: asUrls(res?.urls) };
  } catch (err) {
    throw toStudioApiError(err, 'public');
  }
}

/** Ask the server to stop the current director turn and any not-yet-started renders. */
export async function cancelStudio(id: string): Promise<void> {
  try {
    await post<Record<string, never>, unknown>(`${projectPath(id)}/cancel`, {});
  } catch (err) {
    throw toStudioApiError(err, 'project');
  }
}

/** Fresh signed URLs for storage paths the doc references (missing paths are omitted). */
export async function signStudioUrls(id: string, paths: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(paths.filter((p) => typeof p === 'string' && p))];
  if (!unique.length) return {};
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < unique.length; i += SIGN_BATCH) {
      const res = await post<{ paths: string[] }, { urls?: unknown }>(`${projectPath(id)}/urls`, { paths: unique.slice(i, i + SIGN_BATCH) });
      Object.assign(out, asUrls(res?.urls));
    }
  } catch (err) {
    throw toStudioApiError(err, 'project');
  }
  return out;
}

export async function getStudioModels(): Promise<{ models: ImageModelSpec[]; tiers: Record<QualityTier, TierPreset> }> {
  try {
    const res = await get<{ models?: unknown; tiers?: unknown }>('/api/comic/models');
    return {
      models: Array.isArray(res?.models) ? (res.models as ImageModelSpec[]) : [],
      tiers: (isObject(res?.tiers) ? res.tiers : {}) as Record<QualityTier, TierPreset>
    };
  } catch (err) {
    throw toStudioApiError(err, 'generic');
  }
}

// ── Stream ───────────────────────────────────────────────────────────────────

const EVENT_NAMES = new Set<string>(STREAM_EVENT_NAMES);

/**
 * Parse one SSE block into a StudioEvent. The data is the event JSON; its `type` wins,
 * else the SSE `event:` name is used. Returns null for unknown or malformed events so a
 * newer server never breaks an older client.
 */
export const parseStudioEvent = (eventName: string, data: string): StudioEvent | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const type = typeof parsed.type === 'string' && EVENT_NAMES.has(parsed.type) ? parsed.type : eventName;
  if (!EVENT_NAMES.has(type)) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

  switch (type) {
    case 'hello': {
      const rev = num(parsed.rev);
      return rev === undefined ? null : { type: 'hello', rev, turnId: str(parsed.turnId) || '' };
    }
    case 'ops': {
      const rev = num(parsed.rev);
      if (rev === undefined || !Array.isArray(parsed.ops)) return null;
      const ops = parsed.ops.filter((op) => isObject(op) && typeof op.op === 'string');
      return { type: 'ops', rev, ops: ops as unknown as Extract<StudioEvent, { type: 'ops' }>['ops'] };
    }
    case 'delta': {
      const msgId = str(parsed.msgId);
      const text = str(parsed.text);
      return msgId && text !== undefined ? { type: 'delta', msgId, text } : null;
    }
    case 'activity': {
      const id = str(parsed.id);
      const phase = parsed.phase === 'end' ? 'end' : parsed.phase === 'start' ? 'start' : undefined;
      if (!id || !phase) return null;
      return {
        type: 'activity',
        id,
        label: str(parsed.label) || '',
        phase,
        ...(typeof parsed.ok === 'boolean' ? { ok: parsed.ok } : {})
      };
    }
    case 'urls':
      return { type: 'urls', urls: asUrls(parsed.urls) };
    case 'error':
      return {
        type: 'error',
        message: str(parsed.message)?.trim() || 'Something went wrong in the studio.',
        ...(str(parsed.code) ? { code: str(parsed.code) } : {})
      };
    case 'done':
      return { type: 'done', rev: num(parsed.rev) ?? -1, spentUsd: num(parsed.spentUsd) ?? 0 };
    default:
      return null;
  }
};

/**
 * Re-expose a response body so every received chunk (heartbeats included) is reported,
 * and so aborting `signal` fails the pending read immediately — even on fetch
 * implementations that don't tear the body down on abort.
 */
const watchBody = (body: ReadableStream<Uint8Array>, onChunk: () => void, signal: AbortSignal): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  let finished = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = () => {
        if (finished) return;
        finished = true;
        controller.error(signal.reason ?? abortError());
        reader.cancel().catch(() => undefined);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (finished) return;
        if (done) {
          finished = true;
          controller.close();
          return;
        }
        onChunk();
        controller.enqueue(value);
      } catch (err) {
        if (finished) return;
        finished = true;
        controller.error(err);
      }
    },
    cancel(reason) {
      finished = true;
      return reader.cancel(reason);
    }
  });
};

/**
 * Run one studio turn or action: POST the request and deliver every StudioEvent until
 * the server's `done`. Resolves after `done` (or an `error` event followed by close).
 * Rejects with StudioApiError: `aborted` when `signal` fires, `connection_lost` on 45 s
 * of silence or an early close, or the mapped HTTP error.
 */
export async function streamStudio(
  id: string,
  req: StreamRequest,
  onEvent: (e: StudioEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw abortError();
  const ctrl = new AbortController();
  let idleFired = false;
  let sawDone = false;
  let sawError = false;
  let responded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      idleFired = true;
      ctrl.abort(connectionLost());
    }, STREAM_IDLE_TIMEOUT_MS);
  };
  const onCallerAbort = () => ctrl.abort(abortError());
  signal?.addEventListener('abort', onCallerAbort, { once: true });
  arm();

  try {
    const res = await postStream(`${projectPath(id)}/stream`, req, { signal: ctrl.signal });
    responded = true;
    arm();
    if (!res.body) throw connectionLost();
    await readSSEStream(watchBody(res.body, arm, ctrl.signal), (block) => {
      if (sawDone) return;
      const event = parseStudioEvent(block.event, block.data);
      if (!event) return;
      if (event.type === 'error') sawError = true;
      if (event.type === 'done') sawDone = true;
      try {
        onEvent(event);
      } catch (err) {
        // A consumer bug must not kill the stream (the doc would freeze mid-turn).
        console.error('[comicstudio] stream event handler failed', err);
      }
      // `done` is the last event — release the connection without waiting for the close.
      if (sawDone) ctrl.abort(abortError());
    });
    if (!sawDone && !sawError) throw connectionLost();
  } catch (err) {
    if (sawDone) return;
    if (idleFired) throw connectionLost();
    if (signal?.aborted) throw abortError();
    if (err instanceof StudioApiError) throw err;
    // The body broke after the server answered (proxy drop, network change, sleep).
    if (responded) throw connectionLost();
    throw toStudioApiError(err, 'project');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}
