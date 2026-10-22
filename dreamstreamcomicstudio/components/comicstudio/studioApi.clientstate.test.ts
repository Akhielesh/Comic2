// studioApi (P1-CLIENTSTATE): server error codes → calm, honest copy (never a raw error string),
// v5 stream event fields (ops origin/label, activity cost, done.savedUsd), and the ref upload over
// XHR with real progress, abort and coded errors.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), postStream: vi.fn(), del: vi.fn(), patch: vi.fn() }));
vi.mock('../../services/apiClient', () => api);
vi.mock('../../services/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'tok_123' } } }) } }
}));

import {
  STUDIO_ERROR_COPY,
  StudioApiError,
  UPLOAD_SENT_FRACTION,
  errorCodeOf,
  friendlyErrorMessage,
  isFriendlyMessage,
  parseStudioEvent,
  toStudioApiError,
  uploadStudioRef
} from './studioApi';

// apiClient's ApiError keeps the JSON body in `details`.
const apiError = (status: number, message: string, code?: string) => ({ status, message, details: code ? { error: { message, code } } : undefined });

describe('error mapping by server code', () => {
  it('maps CONTENT_POLICY, COOLDOWN, LIMIT, NOT_READY and RATE_LIMIT to typed kinds, keeping friendly server text', () => {
    const policy = toStudioApiError(apiError(422, "That line is past PG-13 for this comic — try a gentler word.", 'CONTENT_POLICY'));
    expect(policy).toMatchObject({ kind: 'content_policy', status: 422, code: 'CONTENT_POLICY', retryable: false });
    expect(policy.message).toBe("That line is past PG-13 for this comic — try a gentler word.");

    const cooldown = toStudioApiError(apiError(429, "Let's take a short break — you can keep chatting about your story in 12 min.", 'COOLDOWN'));
    expect(cooldown).toMatchObject({ kind: 'cooldown', retryable: true, code: 'COOLDOWN' });
    expect(cooldown.message).toMatch(/12 min/);

    expect(toStudioApiError(apiError(409, 'Maya can hold 12 photos — remove one to add more.', 'LIMIT'))).toMatchObject({
      kind: 'limit',
      message: 'Maya can hold 12 photos — remove one to add more.'
    });
    expect(toStudioApiError(apiError(422, 'Unprocessable Entity', 'NOT_READY'))).toMatchObject({ kind: 'not_ready', message: STUDIO_ERROR_COPY.NOT_READY.message });
    expect(toStudioApiError(apiError(429, 'Too Many Requests', 'RATE_LIMIT'))).toMatchObject({ kind: 'rate_limit', retryable: true, message: STUDIO_ERROR_COPY.RATE_LIMIT.message });
    expect(toStudioApiError(apiError(503, 'NOT_AVAILABLE', 'NOT_AVAILABLE'))).toMatchObject({ kind: 'not_available', message: "That isn't available yet." });
    expect(toStudioApiError(apiError(422, 'x', 'LANG_INCOMPLETE')).kind).toBe('not_ready');
    expect(toStudioApiError(apiError(422, 'x', 'SAFETY_BLOCKED')).kind).toBe('content_policy');
  });

  it('never shows a raw or technical error string — calm copy instead', () => {
    const technical = [
      'TypeError: Cannot read properties of undefined (reading "pages")',
      'duplicate key value violates unique constraint "comic_projects_pkey"',
      'Error: ECONNRESET',
      '<html><body>502 Bad Gateway</body></html>',
      '{"error":"boom"}',
      'NOT_AVAILABLE'
    ];
    for (const message of technical) {
      for (const status of [undefined, 400, 409, 422, 429, 500]) {
        const e = toStudioApiError({ status, message });
        expect(e.message, `${status} ${message}`).not.toContain(message);
        expect(isFriendlyMessage(e.message)).toBe(true);
      }
      const coded = toStudioApiError(apiError(422, message, 'CONTENT_POLICY'));
      expect(coded.message).toBe(STUDIO_ERROR_COPY.CONTENT_POLICY.message);
      expect(coded.detail).toBe(message); // kept for logs only
    }
    expect(toStudioApiError(new TypeError('x is not a function')).message).toMatch(/Something went wrong talking to the studio/);
  });

  it('401/404 keep their context copy even when coded; codes are read from every error shape', () => {
    expect(toStudioApiError(apiError(404, 'gone', 'NOT_FOUND'), 'project').message).toMatch(/doesn't exist/);
    expect(errorCodeOf({ code: 'LIMIT' })).toBe('LIMIT');
    expect(errorCodeOf({ details: { code: 'COOLDOWN' } })).toBe('COOLDOWN');
    expect(errorCodeOf({ details: { error: { code: 'not a code' } } })).toBeUndefined();
    expect(errorCodeOf(null)).toBeUndefined();
  });

  it('friendlyErrorMessage prefers friendly server text, then the code copy, then a calm default', () => {
    expect(friendlyErrorMessage('COOLDOWN', 'Back in 3 minutes — keep editing meanwhile.')).toBe('Back in 3 minutes — keep editing meanwhile.');
    expect(friendlyErrorMessage('COOLDOWN', 'Error: cooldown_active')).toBe(STUDIO_ERROR_COPY.COOLDOWN.message);
    expect(friendlyErrorMessage(undefined, 'TypeError: boom')).toBe('Something went wrong in the studio.');
  });
});

describe('v5 stream events', () => {
  it('ops carry origin and label; junk origins are dropped', () => {
    expect(parseStudioEvent('ops', JSON.stringify({ rev: 3, ops: [{ op: 'plan_status', status: 'approved' }], origin: 'director', label: '  Red shouts ' }))).toEqual({
      type: 'ops',
      rev: 3,
      ops: [{ op: 'plan_status', status: 'approved' }],
      origin: 'director',
      label: 'Red shouts'
    });
    expect(parseStudioEvent('ops', JSON.stringify({ rev: 3, ops: [], origin: 'admin' }))).toEqual({ type: 'ops', rev: 3, ops: [] });
  });

  it('activity keeps its cost badge; done keeps savedUsd; coded errors get calm copy', () => {
    expect(parseStudioEvent('activity', JSON.stringify({ id: 'a', label: 'Lettering', phase: 'start', cost: 'free' }))).toMatchObject({ cost: 'free' });
    expect(parseStudioEvent('activity', JSON.stringify({ id: 'a', label: 'x', phase: 'start', cost: 'gold' }))).not.toHaveProperty('cost');
    expect(parseStudioEvent('done', JSON.stringify({ rev: 4, spentUsd: 0, savedUsd: 0.12 }))).toEqual({ type: 'done', rev: 4, spentUsd: 0, savedUsd: 0.12 });
    expect(parseStudioEvent('done', JSON.stringify({ rev: 4, spentUsd: 0, savedUsd: 0 }))).toEqual({ type: 'done', rev: 4, spentUsd: 0 });
    expect(parseStudioEvent('error', JSON.stringify({ message: 'Error: stack at foo (bar.js:1)', code: 'CONTENT_POLICY' }))).toEqual({
      type: 'error',
      message: STUDIO_ERROR_COPY.CONTENT_POLICY.message,
      code: 'CONTENT_POLICY'
    });
  });
});

// ── XHR upload ───────────────────────────────────────────────────────────────

interface FakeXhrInstance {
  method?: string;
  url?: string;
  headers: Record<string, string>;
  body?: unknown;
  timeout: number;
  status: number;
  statusText: string;
  responseText: string;
  upload: { onprogress: ((e: ProgressEvent) => void) | null };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  ontimeout: (() => void) | null;
  onabort: (() => void) | null;
  aborted: boolean;
}

const makeFakeXhr = () => {
  const instances: FakeXhrInstance[] = [];
  class FakeXhr implements FakeXhrInstance {
    method?: string;
    url?: string;
    headers: Record<string, string> = {};
    body?: unknown;
    timeout = 0;
    status = 0;
    statusText = '';
    responseText = '';
    upload = { onprogress: null as ((e: ProgressEvent) => void) | null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    aborted = false;
    constructor() {
      instances.push(this);
    }
    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(k: string, v: string) {
      this.headers[k] = v;
    }
    send(body: unknown) {
      this.body = body;
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
  }
  const respond = (x: FakeXhrInstance, status: number, body: unknown) => {
    x.status = status;
    x.responseText = JSON.stringify(body);
    x.onload?.();
  };
  const progress = (x: FakeXhrInstance, loaded: number, total: number) =>
    x.upload.onprogress?.({ lengthComputable: true, loaded, total } as ProgressEvent);
  return { FakeXhr: FakeXhr as unknown as typeof XMLHttpRequest, instances, respond, progress };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('uploadStudioRef over XHR', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('reports real progress (bytes → 0..0.95, 1 once stored) and parses the 201 answer', async () => {
    const { FakeXhr, instances, respond, progress } = makeFakeXhr();
    const onProgress = vi.fn();
    const file = new Blob(['img'], { type: 'image/webp' });
    const done = uploadStudioRef('proj 1', file, { to: { kind: 'inbox' }, name: 'a.webp', hash: '0123456789abcdef' }, { onProgress, XHR: FakeXhr });
    await flush();
    const x = instances[0];
    expect(x.method).toBe('POST');
    expect(x.url).toBe('/api/comic/projects/proj%201/refs?to=inbox&name=a.webp&hash=0123456789abcdef');
    expect(x.headers).toEqual({ 'Content-Type': 'image/webp', Authorization: 'Bearer tok_123' });
    expect(x.body).toBe(file);
    expect(x.timeout).toBeGreaterThan(0);
    progress(x, 50, 100);
    progress(x, 100, 100);
    const ref = { path: 'u/x/p/ref/a.webp', source: 'upload', at: 1 };
    respond(x, 201, { ref, rev: 7, ops: [{ op: 'ref_add', owner: { kind: 'inbox' }, ref }], urls: { [ref.path]: 'https://s/a' } });
    await expect(done).resolves.toEqual({ ref, rev: 7, ops: [{ op: 'ref_add', owner: { kind: 'inbox' }, ref }], urls: { [ref.path]: 'https://s/a' } });
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual([0.5 * UPLOAD_SENT_FRACTION, UPLOAD_SENT_FRACTION, 1]);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('maps coded failures to calm typed errors', async () => {
    const { FakeXhr, instances, respond } = makeFakeXhr();
    const p = uploadStudioRef('p', new Blob(['x']), { to: { kind: 'character', id: 'c1' } }, { onProgress: () => undefined, XHR: FakeXhr });
    await flush();
    respond(instances[0], 409, { error: { message: 'Maya can hold 12 photos — remove one to add more.', code: 'LIMIT' } });
    await expect(p).rejects.toMatchObject({ kind: 'limit', code: 'LIMIT', message: 'Maya can hold 12 photos — remove one to add more.' });

    const q = uploadStudioRef('p', new Blob(['x']), { to: { kind: 'style' } }, { onProgress: () => undefined, XHR: FakeXhr });
    await flush();
    respond(instances[1], 422, { error: { message: 'CONTENT_POLICY', code: 'CONTENT_POLICY' } });
    await expect(q).rejects.toMatchObject({ kind: 'content_policy', message: STUDIO_ERROR_COPY.CONTENT_POLICY.message });

    const r = uploadStudioRef('p', new Blob(['x']), { to: { kind: 'style' } }, { onProgress: () => undefined, XHR: FakeXhr });
    await flush();
    instances[2].onerror?.();
    await expect(r).rejects.toMatchObject({ kind: 'network', retryable: true });
  });

  it('aborts via the signal (before and during the upload)', async () => {
    const { FakeXhr, instances } = makeFakeXhr();
    const ctrl = new AbortController();
    const p = uploadStudioRef('p', new Blob(['x']), { to: { kind: 'inbox' } }, { onProgress: () => undefined, signal: ctrl.signal, XHR: FakeXhr });
    await flush();
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
    expect(instances[0].aborted).toBe(true);

    const pre = new AbortController();
    pre.abort();
    await expect(uploadStudioRef('p', new Blob(['x']), { to: { kind: 'inbox' } }, { signal: pre.signal, XHR: FakeXhr })).rejects.toBeInstanceOf(StudioApiError);
  });
});
