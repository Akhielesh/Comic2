// refs.md §9 client: the upload queue — states with real XHR progress, concurrency 3, retry/back-off,
// cancel (xhr.abort), 422 → rejected with no retry, 409 LIMIT → over cap, duplicate short-circuit by
// hash, inline over-cap before any upload.
import { describe, expect, it, vi } from 'vitest';
import type { ComicDoc, RefAsset, RefOwner } from '../../../shared/comic/doc';
import type { PreparedImage } from './downscale';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { BLOCKED_COPY, RefUploadError, createUploadQueue, refsQuery, xhrUploadRef, type UploadResponse, type UploadTransport } from './useRefUpload';

const MAYA: RefOwner = { kind: 'character', id: 'ch_maya' };
const ref = (n: number, extra: Partial<RefAsset> = {}): RefAsset => ({ path: `u/u1/p/p1/ref/r${n}.webp`, source: 'upload', at: n, ...extra });
const file = (name: string) => new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], name, { type: 'image/jpeg' });
const flush = async (n = 6) => {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setTimeout(r, 0));
};

interface Call {
  name: string;
  hash?: string;
  progress(f: number): void;
  resolve(r: UploadResponse): void;
  reject(e: unknown): void;
  signal: AbortSignal;
}

const setup = (mutate?: (doc: ComicDoc) => void) => {
  const doc = makeSampleDoc((d) => {
    d.cast[0].refs = [];
    mutate?.(d);
  });
  const calls: Call[] = [];
  const transport: UploadTransport = ({ params, onProgress, signal }) =>
    new Promise<UploadResponse>((resolve, reject) => {
      const call: Call = { name: params.name || '', hash: params.hash, progress: onProgress, resolve, reject, signal };
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      calls.push(call);
    });
  const prepare = vi.fn(
    async (f: Blob & { name?: string }): Promise<PreparedImage> => ({ blob: f, mimeType: 'image/webp', w: 1000, h: 800, hash: `h_${f.name}`.padEnd(16, '0').slice(0, 16), name: f.name || 'x', bytes: f.size, sourceBytes: f.size })
  );
  const sleeps: number[] = [];
  const onUploaded = vi.fn();
  const queue = createUploadQueue({ projectId: 'p1', getDoc: () => doc, transport, prepare, sleep: async (ms) => void sleeps.push(ms), onUploaded });
  return { doc, calls, queue, prepare, sleeps, onUploaded };
};
const stateOf = (q: ReturnType<typeof setup>['queue']) => q.getSnapshot().map((i) => i.state);

describe('upload queue', () => {
  it('walks queued → preparing → uploading (progress %) → checking → done', async () => {
    const { queue, calls, onUploaded } = setup();
    await queue.add([file('a.jpg')], MAYA);
    await flush();
    expect(stateOf(queue)).toEqual(['uploading']);
    calls[0].progress(0.42);
    expect(queue.getSnapshot()[0].progress).toBeCloseTo(0.42);
    calls[0].progress(1);
    expect(stateOf(queue)).toEqual(['checking']);
    calls[0].resolve({ ref: ref(1), ops: [], urls: {} });
    await flush();
    expect(queue.getSnapshot()[0]).toMatchObject({ state: 'done', ref: ref(1) });
    expect(onUploaded).toHaveBeenCalledTimes(1);
    expect(queue.busy()).toBe(false);
  });

  it('uploads at most 3 at a time and prepares one at a time', async () => {
    const { queue, calls, prepare } = setup();
    await queue.add(['a', 'b', 'c', 'd', 'e'].map((n) => file(`${n}.jpg`)), MAYA);
    await flush(20);
    expect(prepare).toHaveBeenCalledTimes(5);
    expect(calls).toHaveLength(3);
    calls[0].resolve({ ref: ref(1), ops: [], urls: {} });
    await flush(10);
    expect(calls).toHaveLength(4);
  });

  it('retries a network failure / 5xx twice with back-off, then succeeds', async () => {
    const { queue, calls, sleeps } = setup();
    await queue.add([file('a.jpg')], MAYA);
    await flush();
    calls[0].reject(new RefUploadError(0, 'net', 'NETWORK'));
    await flush();
    calls[1].reject(new RefUploadError(503, 'busy'));
    await flush();
    calls[2].resolve({ ref: ref(1), ops: [], urls: {} });
    await flush();
    expect(sleeps).toEqual([1000, 3000]);
    expect(queue.getSnapshot()[0]).toMatchObject({ state: 'done', attempts: 3 });
  });

  it('a 429 waits for its Retry-After; after the retries it fails with [Retry], which works', async () => {
    const { queue, calls, sleeps } = setup();
    await queue.add([file('a.jpg')], MAYA);
    await flush();
    calls[0].reject(new RefUploadError(429, 'slow down', 'RATE_LIMIT', 2000));
    await flush();
    calls[1].reject(new RefUploadError(0, 'net', 'NETWORK'));
    await flush();
    calls[2].reject(new RefUploadError(0, 'net', 'NETWORK'));
    await flush();
    expect(sleeps).toEqual([2000, 3000]);
    expect(queue.getSnapshot()[0]).toMatchObject({ state: 'failed', retryable: true, message: "Couldn't upload — check your connection." });
    queue.retry(queue.getSnapshot()[0].id);
    await flush();
    calls[3].resolve({ ref: ref(1), ops: [], urls: {} });
    await flush();
    expect(stateOf(queue)).toEqual(['done']);
  });

  it('422 → a red "rejected" row with no retry; 409 LIMIT → over cap; 415 → failed without retry', async () => {
    const { queue, calls } = setup();
    await queue.add([file('a.jpg'), file('b.jpg'), file('c.jpg')], MAYA);
    await flush(20);
    calls[0].reject(new RefUploadError(422, "This image doesn't fit DreamStream's content rules, so it wasn't added.", 'CONTENT_POLICY'));
    calls[1].reject(new RefUploadError(409, 'MAYA already has 12 photos (the limit) — remove one to add another.', 'LIMIT'));
    calls[2].reject(new RefUploadError(415, 'Use a JPG, PNG, WebP, GIF or AVIF image.'));
    await flush();
    const [a, b, c] = queue.getSnapshot();
    expect(a).toMatchObject({ state: 'rejected', message: BLOCKED_COPY });
    expect(a.previewUrl).toBeUndefined();
    expect(b).toMatchObject({ state: 'over_cap', message: expect.stringMatching(/already has 12 photos/) });
    expect(c).toMatchObject({ state: 'failed', retryable: false });
    expect(calls).toHaveLength(3);
  });

  it('cancel aborts the XHR and drops the row', async () => {
    const { queue, calls } = setup();
    await queue.add([file('a.jpg')], MAYA);
    await flush();
    queue.cancel(queue.getSnapshot()[0].id);
    await flush();
    expect(calls[0].signal.aborted).toBe(true);
    expect(queue.getSnapshot()).toEqual([]);
  });

  it('an exact duplicate (same original-file hash) is skipped without uploading', async () => {
    const { queue, calls } = setup((d) => {
      d.cast[0].refs = [ref(1, { hash: 'h_a.jpg000000000' })];
    });
    await queue.add([file('a.jpg')], MAYA);
    await flush();
    expect(queue.getSnapshot()[0]).toMatchObject({ state: 'duplicate', message: 'Already added' });
    expect(calls).toHaveLength(0);
  });

  it('over the cap: refused inline before anything uploads, with the limit in the copy', async () => {
    const { queue, calls } = setup((d) => {
      d.cast[0].refs = Array.from({ length: 11 }, (_, i) => ref(100 + i));
    });
    await queue.add([file('a.jpg'), file('b.jpg'), file('c.jpg')], MAYA);
    await flush();
    expect(stateOf(queue)).toEqual(['uploading', 'over_cap', 'over_cap']);
    expect(queue.getSnapshot()[1].message).toBe('MAYA can hold 12 photos — remove one to add more.');
    expect(calls).toHaveLength(1);
  });

  it('never uploads for a comic that is still loading or an owner that is gone (and says so)', async () => {
    const calls: unknown[] = [];
    const transport: UploadTransport = async () => {
      calls.push(1);
      return { ops: [], urls: {} };
    };
    const loading = createUploadQueue({ projectId: 'p1', getDoc: () => null, transport });
    await loading.add([file('a.jpg')], MAYA);
    expect(loading.getSnapshot()[0]).toMatchObject({ state: 'failed', retryable: false, message: 'The comic is still loading — add the photo again in a moment.' });
    const { queue } = setup();
    await queue.add([file('b.jpg')], { kind: 'character', id: 'ch_gone' });
    expect(queue.getSnapshot()[0]).toMatchObject({ state: 'failed', message: 'This character is no longer in the story, so nothing was uploaded.' });
    await flush();
    expect(calls).toHaveLength(0);
  });

  it('a near-duplicate is stored with the look-alike named', async () => {
    const { queue, calls } = setup((d) => {
      d.cast[0].refs = [ref(1), ref(2)];
    });
    await queue.add([file('a.jpg')], MAYA);
    await flush();
    calls[0].resolve({ ref: ref(3), notice: { kind: 'near_duplicate', of: ref(2).path }, ops: [], urls: {} });
    await flush();
    expect(queue.getSnapshot()[0]).toMatchObject({ state: 'near_duplicate', message: 'Looks the same as photo 2', nearOf: ref(2).path });
  });
});

// ── XHR transport ────────────────────────────────────────────────────────────

class FakeXHR {
  static last: FakeXHR;
  method = '';
  url = '';
  headers: Record<string, string> = {};
  status = 0;
  responseText = '';
  timeout = 0;
  sent?: Blob;
  responseHeaders: Record<string, string> = {};
  upload: { onprogress?: (e: ProgressEvent) => void; onload?: () => void } = {};
  onload?: () => void;
  onerror?: () => void;
  ontimeout?: () => void;
  onabort?: () => void;
  constructor() {
    FakeXHR.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  getResponseHeader(k: string) {
    return this.responseHeaders[k] ?? null;
  }
  send(body: Blob) {
    this.sent = body;
  }
  abort() {
    this.onabort?.();
  }
  respond(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.responseText = JSON.stringify(body);
    this.responseHeaders = headers;
    this.onload?.();
  }
}

describe('xhrUploadRef', () => {
  const blob = new Blob([new Uint8Array(10)], { type: 'image/webp' });

  it('sends the raw body with the token, reports real upload progress and parses 201', async () => {
    const progress: number[] = [];
    const p = xhrUploadRef('proj 1', blob, { to: MAYA, name: 'IMG_1.jpg', hash: '0123456789abcdef', label: 'front', index: 0 }, { onProgress: (f) => progress.push(f), token: 'tok', XHR: FakeXHR as never });
    const x = FakeXHR.last;
    expect(x.method).toBe('POST');
    expect(x.url).toMatch(/\/api\/comic\/projects\/proj%201\/refs\?to=character%3Ach_maya&label=front&name=IMG_1.jpg&hash=0123456789abcdef&index=0$/);
    expect(x.headers).toMatchObject({ 'Content-Type': 'image/webp', Authorization: 'Bearer tok' });
    expect(x.sent).toBe(blob);
    x.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
    x.upload.onload?.();
    x.respond(201, { ref: ref(1), rev: 7, ops: [{ op: 'ref_add', owner: MAYA, ref: ref(1) }], urls: { [ref(1).path]: 'https://signed/x' } });
    await expect(p).resolves.toMatchObject({ ref: ref(1), rev: 7, urls: { [ref(1).path]: 'https://signed/x' } });
    expect(progress).toEqual([0.5, 1]);
  });

  it('maps errors: code + message from the body, Retry-After, network and abort', async () => {
    const p1 = xhrUploadRef('p', blob, { to: MAYA }, { XHR: FakeXHR as never });
    FakeXHR.last.respond(429, { error: { message: 'Too many uploads.', code: 'RATE_LIMIT' } }, { 'Retry-After': '12' });
    await expect(p1).rejects.toMatchObject({ status: 429, code: 'RATE_LIMIT', message: 'Too many uploads.', retryAfterMs: 12_000 });
    const p2 = xhrUploadRef('p', blob, { to: MAYA }, { XHR: FakeXHR as never });
    FakeXHR.last.onerror?.();
    await expect(p2).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
    const ctrl = new AbortController();
    const p3 = xhrUploadRef('p', blob, { to: MAYA }, { XHR: FakeXHR as never, signal: ctrl.signal });
    ctrl.abort();
    await expect(p3).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('refsQuery drops malformed hints', () => {
    expect(refsQuery({ to: { kind: 'inbox' }, hash: 'NOT-HEX', index: -1 })).toBe('to=inbox');
  });
});
