import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StudioEvent } from '../../shared/comic/events';

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  postStream: vi.fn()
}));

vi.mock('../../services/apiClient', () => api);

import {
  STREAM_IDLE_TIMEOUT_MS,
  StudioApiError,
  cancelStudio,
  createStudioProject,
  loadPublicComic,
  loadStudioProject,
  parseStudioEvent,
  signStudioUrls,
  streamStudio,
  toStudioApiError
} from './studioApi';

const enc = new TextEncoder();

/** A response body we can push SSE text into (and close) from the test. */
const controllableBody = () => {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    }
  });
  return {
    body,
    push: (text: string) => ctrl.enqueue(enc.encode(text)),
    close: () => ctrl.close()
  };
};

const sse = (event: StudioEvent) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;

const flush = async (times = 6) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

beforeEach(() => {
  api.get.mockReset();
  api.post.mockReset();
  api.postStream.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('parseStudioEvent', () => {
  it('uses the data type, falling back to the SSE event name', () => {
    expect(parseStudioEvent('message', JSON.stringify({ type: 'delta', msgId: 'm', text: 'hi' }))).toEqual({ type: 'delta', msgId: 'm', text: 'hi' });
    expect(parseStudioEvent('ops', JSON.stringify({ rev: 3, ops: [{ op: 'note_add', text: 'x' }] }))).toEqual({
      type: 'ops',
      rev: 3,
      ops: [{ op: 'note_add', text: 'x' }]
    });
  });

  it('skips unknown, malformed and incomplete events', () => {
    expect(parseStudioEvent('mystery', '{"a":1}')).toBeNull();
    expect(parseStudioEvent('ops', 'not json')).toBeNull();
    expect(parseStudioEvent('ops', '{"rev":"3","ops":[]}')).toBeNull();
    expect(parseStudioEvent('delta', '{"text":"no id"}')).toBeNull();
    expect(parseStudioEvent('activity', '{"id":"a","label":"x","phase":"middle"}')).toBeNull();
    expect(parseStudioEvent('hello', '[]')).toBeNull();
  });

  it('drops malformed ops inside a batch and fills defaults', () => {
    expect(parseStudioEvent('ops', '{"rev":1,"ops":[{"op":"note_add","text":"a"},null,{"nope":1}]}')).toEqual({
      type: 'ops',
      rev: 1,
      ops: [{ op: 'note_add', text: 'a' }]
    });
    expect(parseStudioEvent('error', '{}')).toEqual({ type: 'error', message: 'Something went wrong in the studio.' });
    expect(parseStudioEvent('done', '{"rev":4}')).toEqual({ type: 'done', rev: 4, spentUsd: 0 });
    expect(parseStudioEvent('urls', '{"urls":{"a":"https://x","b":5}}')).toEqual({ type: 'urls', urls: { a: 'https://x' } });
  });
});

describe('streamStudio', () => {
  it('posts the request and delivers events in order across chunk boundaries, ignoring heartbeats', async () => {
    const b = controllableBody();
    api.postStream.mockResolvedValue({ body: b.body });
    const events: StudioEvent[] = [];
    const done = streamStudio('proj 1', { kind: 'message', text: 'Hi' }, (e) => events.push(e));
    await flush();
    expect(api.postStream).toHaveBeenCalledWith('/api/comic/projects/proj%201/stream', { kind: 'message', text: 'Hi' }, expect.objectContaining({ signal: expect.any(AbortSignal) }));

    const hello = sse({ type: 'hello', rev: 4, turnId: 't1' });
    b.push(': keep-alive\n\n');
    b.push(hello.slice(0, 10));
    b.push(hello.slice(10) + sse({ type: 'delta', msgId: 'a1', text: 'Hel' }));
    // multi-line data: lines are joined with "\n", which is valid JSON whitespace
    b.push('event: delta\ndata: {"type":"delta",\ndata: "msgId":"a1","text":"lo"}\n\n');
    b.push(sse({ type: 'ops', rev: 5, ops: [{ op: 'note_add', text: 'noir' }] }));
    b.push(sse({ type: 'done', rev: 5, spentUsd: 0.01 }));
    await done;
    expect(events.map((e) => e.type)).toEqual(['hello', 'delta', 'delta', 'ops', 'done']);
    expect(events[2]).toEqual({ type: 'delta', msgId: 'a1', text: 'lo' });
  });

  it('resolves right after done even if the server keeps the connection open', async () => {
    const b = controllableBody();
    api.postStream.mockResolvedValue({ body: b.body });
    const done = streamStudio('p', { kind: 'action', action: { type: 'approve_plan' } }, () => undefined);
    await flush();
    b.push(sse({ type: 'done', rev: 1, spentUsd: 0 }));
    await expect(done).resolves.toBeUndefined();
  });

  it('a stream that closes without done is a lost connection', async () => {
    const b = controllableBody();
    api.postStream.mockResolvedValue({ body: b.body });
    const done = streamStudio('p', { kind: 'message', text: 'x' }, () => undefined);
    await flush();
    b.push(sse({ type: 'hello', rev: 1, turnId: 't' }));
    b.close();
    await expect(done).rejects.toMatchObject({ kind: 'connection_lost' });
  });

  it('an error event followed by close resolves (the error was delivered as an event)', async () => {
    const b = controllableBody();
    api.postStream.mockResolvedValue({ body: b.body });
    const events: StudioEvent[] = [];
    const done = streamStudio('p', { kind: 'message', text: 'x' }, (e) => events.push(e));
    await flush();
    b.push(sse({ type: 'error', message: 'Connect a key', code: 'NO_TEXT_KEY' }));
    b.close();
    await expect(done).resolves.toBeUndefined();
    expect(events).toEqual([{ type: 'error', message: 'Connect a key', code: 'NO_TEXT_KEY' }]);
  });

  it('a consumer exception does not kill the stream', async () => {
    const b = controllableBody();
    api.postStream.mockResolvedValue({ body: b.body });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: string[] = [];
    const done = streamStudio('p', { kind: 'message', text: 'x' }, (e) => {
      seen.push(e.type);
      if (e.type === 'hello') throw new Error('boom');
    });
    await flush();
    b.push(sse({ type: 'hello', rev: 1, turnId: 't' }) + sse({ type: 'done', rev: 1, spentUsd: 0 }));
    await done;
    expect(seen).toEqual(['hello', 'done']);
    spy.mockRestore();
  });

  it('times out after 45 s of silence; heartbeats keep it alive', async () => {
    vi.useFakeTimers();
    const b = controllableBody();
    api.postStream.mockResolvedValue({ body: b.body });
    const done = streamStudio('p', { kind: 'message', text: 'x' }, () => undefined);
    const outcome = done.then(
      () => 'resolved',
      (e: StudioApiError) => e.kind
    );
    await vi.advanceTimersByTimeAsync(30_000);
    b.push(': keep-alive\n\n');
    await vi.advanceTimersByTimeAsync(30_000); // 60 s total, but only 30 s since the heartbeat
    let settled = false;
    void outcome.then(() => (settled = true));
    await flush();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS);
    expect(await outcome).toBe('connection_lost');
  });

  it('times out while waiting for the response headers too', async () => {
    vi.useFakeTimers();
    api.postStream.mockImplementation(
      (_path: string, _body: unknown, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );
    const outcome = streamStudio('p', { kind: 'message', text: 'x' }, () => undefined).catch((e: StudioApiError) => e);
    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 10);
    expect(await outcome).toMatchObject({ kind: 'connection_lost' });
  });

  it('the caller can cancel; the request signal is aborted too', async () => {
    const b = controllableBody();
    let requestSignal: AbortSignal | undefined;
    api.postStream.mockImplementation(async (_p: string, _b: unknown, opts: { signal: AbortSignal }) => {
      requestSignal = opts.signal;
      return { body: b.body };
    });
    const ctrl = new AbortController();
    const done = streamStudio('p', { kind: 'message', text: 'x' }, () => undefined, ctrl.signal);
    await flush();
    ctrl.abort();
    await expect(done).rejects.toMatchObject({ kind: 'aborted' });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('an already-aborted signal never sends', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(streamStudio('p', { kind: 'message', text: 'x' }, () => undefined, ctrl.signal)).rejects.toMatchObject({ kind: 'aborted' });
    expect(api.postStream).not.toHaveBeenCalled();
  });

  it('maps HTTP failures to friendly typed errors', async () => {
    api.postStream.mockRejectedValueOnce({ status: 402, message: 'You have used your included image credits for this month.' });
    await expect(streamStudio('p', { kind: 'message', text: 'x' }, () => undefined)).rejects.toMatchObject({
      kind: 'billing',
      status: 402,
      message: 'You have used your included image credits for this month.'
    });
    api.postStream.mockRejectedValueOnce({ status: 401, message: 'Unauthorized' });
    await expect(streamStudio('p', { kind: 'message', text: 'x' }, () => undefined)).rejects.toMatchObject({ kind: 'auth', message: expect.stringMatching(/sign in/i) });
    api.postStream.mockRejectedValueOnce({ status: 404, message: 'Not Found' });
    await expect(streamStudio('p', { kind: 'message', text: 'x' }, () => undefined)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('a body that breaks mid-stream is a lost connection', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull() {
        throw new TypeError('network error');
      }
    });
    api.postStream.mockResolvedValue({ body });
    await expect(streamStudio('p', { kind: 'message', text: 'x' }, () => undefined)).rejects.toMatchObject({ kind: 'connection_lost' });
  });
});

describe('toStudioApiError', () => {
  it('uses server text for 4xx, our own for transport and 5xx', () => {
    expect(toStudioApiError({ status: 0, message: 'Failed to fetch' }).kind).toBe('network');
    expect(toStudioApiError({ status: 402, message: 'Payment Required' }).message).toMatch(/credit/);
    expect(toStudioApiError({ status: 409, message: 'That approval is no longer open.' }).message).toBe('That approval is no longer open.');
    expect(toStudioApiError({ status: 500, message: 'TypeError: x is undefined' }).message).toMatch(/studio server hit a problem/);
    expect(toStudioApiError({ status: 503, message: 'x' }).retryable).toBe(true);
    expect(toStudioApiError(new DOMException('a', 'AbortError')).kind).toBe('aborted');
    expect(toStudioApiError({ status: 404 }, 'public').message).toMatch(/isn't published/);
    expect(toStudioApiError({ status: 404 }, 'project').message).toMatch(/doesn't exist/);
  });
});

describe('project endpoints', () => {
  const rawDoc = { id: 'proj_1', brief: { title: 'T' } };

  it('loads a project and normalizes the doc', async () => {
    api.get.mockResolvedValue({ doc: rawDoc, urls: { a: 'https://x/a', b: 7 } });
    const res = await loadStudioProject('proj_1');
    expect(api.get).toHaveBeenCalledWith('/api/comic/projects/proj_1', expect.anything());
    expect(res.doc.pages).toEqual([]);
    expect(res.doc.settings.quality).toBe('standard');
    expect(res.urls).toEqual({ a: 'https://x/a' });
  });

  it('rejects an unreadable doc', async () => {
    api.get.mockResolvedValue({ doc: null });
    await expect(loadStudioProject('x')).rejects.toBeInstanceOf(StudioApiError);
  });

  it('loads a public comic without requiring auth and explains a private one', async () => {
    api.get.mockResolvedValueOnce({ doc: rawDoc, urls: {} });
    await loadPublicComic('proj_1');
    expect(api.get).toHaveBeenCalledWith('/api/comic/public/proj_1', expect.anything());
    api.get.mockRejectedValueOnce({ status: 404, message: 'Not Found' });
    await expect(loadPublicComic('proj_2')).rejects.toMatchObject({ kind: 'not_found', message: expect.stringMatching(/private/) });
  });

  it('keeps the amended public fields: languages, lang and a live publication (legacy ?view=read&id=)', async () => {
    api.get.mockResolvedValueOnce({
      doc: rawDoc,
      urls: {},
      languages: [
        { code: 'en', endonym: 'English', english: 'English', complete: true, isSource: true },
        { code: 'te', endonym: 'తెలుగు', english: 'Telugu', complete: true, isSource: false },
        { code: '<script>', endonym: 'x', english: 'x', complete: true, isSource: false }
      ],
      lang: 'te',
      publication: { slug: 'abcdefghijklmnopq', visibility: 'public', languages: ['en', 'te'], allowDownload: true, allowEmbed: true, publishedAt: 1, updatedAt: 1, card: {} }
    });
    const res = await loadPublicComic('proj_1', { lang: 'te' });
    expect(api.get).toHaveBeenCalledWith('/api/comic/public/proj_1?lang=te', expect.anything());
    expect(res.languages.map((l) => l.code)).toEqual(['en', 'te']);
    expect(res.lang).toBe('te');
    expect(res.publication?.slug).toBe('abcdefghijklmnopq');
    expect(res.preview).toBeUndefined();
  });

  it('the owner preview carries preview:true and never a publication; a junk slug is dropped', async () => {
    api.get.mockResolvedValueOnce({ doc: rawDoc, urls: {}, languages: [], preview: true, publication: { slug: 'abcdefghijklmnopq', visibility: 'public' } });
    const owner = await loadPublicComic('proj_1');
    expect(owner.preview).toBe(true);
    expect(owner.publication).toBeUndefined();
    api.get.mockResolvedValueOnce({ doc: rawDoc, urls: {}, publication: { slug: '../../x', visibility: 'public' } });
    const junk = await loadPublicComic('proj_1', { lang: 'not a lang' });
    expect(api.get).toHaveBeenLastCalledWith('/api/comic/public/proj_1', expect.anything());
    expect(junk.publication).toBeUndefined();
    expect(junk.languages).toEqual([]);
  });

  it('creates a project', async () => {
    api.post.mockResolvedValue({ projectId: 'proj_9', doc: { ...rawDoc, id: 'proj_9' }, urls: {} });
    const res = await createStudioProject({ title: 'New' });
    expect(api.post).toHaveBeenCalledWith('/api/comic/projects', { title: 'New' });
    expect(res.projectId).toBe('proj_9');
  });

  it('signs urls in batches and skips empty requests', async () => {
    expect(await signStudioUrls('p', [])).toEqual({});
    expect(api.post).not.toHaveBeenCalled();
    const paths = Array.from({ length: 150 }, (_, i) => `p/${i}.webp`);
    api.post.mockImplementation(async (_path: string, body: { paths: string[] }) => ({
      urls: Object.fromEntries(body.paths.map((p) => [p, `https://cdn/${p}`]))
    }));
    const urls = await signStudioUrls('p', [...paths, paths[0]]);
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(Object.keys(urls)).toHaveLength(150);
  });

  it('cancel posts to the cancel endpoint and maps failures', async () => {
    api.post.mockResolvedValueOnce({ ok: true });
    await cancelStudio('p');
    expect(api.post).toHaveBeenCalledWith('/api/comic/projects/p/cancel', {});
    api.post.mockRejectedValueOnce({ status: 0, message: 'Failed to fetch' });
    await expect(cancelStudio('p')).rejects.toMatchObject({ kind: 'network' });
  });
});
