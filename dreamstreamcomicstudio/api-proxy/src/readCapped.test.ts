// @vitest-environment node
// S16: every edge body read is capped — an unsized (chunked / HTTP-2) upload is cancelled past the
// cap instead of being buffered whole, and a declared oversize length is refused unread.
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './proxy';
import { readCappedText } from './readCapped';

const SLUG = 'Ab3dEf6hIj9kLm2nP';
const CHUNK = 16384;
const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

/** A body with no Content-Length that counts how much of it was pulled. */
function streamed(total: number, chunk = CHUNK, fill = 0x7b /* "{" */) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(c) {
        if (state.pulled >= total) return c.close();
        const n = Math.min(chunk, total - state.pulled);
        state.pulled += n;
        c.enqueue(new Uint8Array(n).fill(fill));
      },
      cancel() {
        state.cancelled = true;
      }
    },
    { highWaterMark: 0 }
  );
  return { state, body };
}

const streamRequest = (url: string, body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) =>
  new Request(url, { method: 'POST', body, headers, duplex: 'half' } as RequestInit);

const call = async (req: Request, env: Record<string, unknown>) => {
  const waits: Promise<unknown>[] = [];
  const res = await worker.fetch(req, env as never, { waitUntil: (p) => waits.push(p) });
  await Promise.all(waits);
  return res;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('readCappedText', () => {
  it('refuses a declared Content-Length over the cap without reading anything', async () => {
    const { state, body } = streamed(4096);
    const req = streamRequest('https://x.test/', body, { 'content-length': '999999' });
    expect(await readCappedText(req, 1024)).toBeNull();
    expect(state.pulled).toBe(0);
  });

  it('cancels an unsized body as soon as it passes the cap', async () => {
    const { state, body } = streamed(16 * 1024 * 1024);
    expect(await readCappedText(streamRequest('https://x.test/', body), CHUNK)).toBeNull();
    expect(state.pulled).toBeLessThanOrEqual(2 * CHUNK);
    expect(state.cancelled).toBe(true);
  });

  it('accepts exactly max bytes and refuses max + 1', async () => {
    const exact = streamed(1024, 300, 0x61);
    expect(await readCappedText(streamRequest('https://x.test/', exact.body), 1024)).toBe('a'.repeat(1024));
    const over = streamed(1025, 300, 0x61);
    expect(await readCappedText(streamRequest('https://x.test/', over.body), 1024)).toBeNull();
  });

  it('decodes a multibyte character split across chunks', async () => {
    const bytes = new TextEncoder().encode('తెలుగు ✓');
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 2));
        c.enqueue(bytes.slice(2, 7));
        c.enqueue(bytes.slice(7));
        c.close();
      }
    });
    expect(await readCappedText(streamRequest('https://x.test/', body), 1024)).toBe('తెలుగు ✓');
  });

  it('returns null for a stream that errors, and "" for no body', async () => {
    const broken = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error('reset'));
      }
    });
    expect(await readCappedText(streamRequest('https://x.test/', broken), 1024)).toBeNull();
    expect(await readCappedText(new Request('https://x.test/', { method: 'POST' }), 1024)).toBe('');
    expect(await readCappedText(new Request('https://x.test/', { method: 'POST', body: '{"a":1}' }), 1024)).toBe('{"a":1}');
  });
});

describe('edge routes never buffer an unsized body past their cap', () => {
  const env = (extra: Record<string, unknown> = {}) => ({
    BACKEND_TARGET: 'origin',
    BACKEND_ORIGIN: 'https://backend.example',
    VITE_SUPABASE_URL: 'https://bdjfmxfmhqhzvgrhbbzm.supabase.co',
    ...extra
  });

  it('POST /api/csp-report: 204, stops after ~16 KB, logs nothing, never calls out', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { state, body } = streamed(1024 * 1024);
    const res = await call(
      streamRequest('https://dreamstreamstudio.ai/api/csp-report', body, { 'user-agent': HUMAN, 'content-type': 'application/csp-report' }),
      env({ CSP_REPORT_SAMPLE: '1' })
    );
    expect(res.status).toBe(204);
    expect(state.pulled).toBeLessThanOrEqual(16 * 1024 + CHUNK);
    expect(log).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POST /api/comic/public/s/:slug/event: 204, stops after ~1 KB, no tracking RPC', async () => {
    const fetchSpy = vi.fn(async () => new Response('null'));
    vi.stubGlobal('fetch', fetchSpy);
    const { state, body } = streamed(1024 * 1024);
    const res = await call(
      streamRequest(`https://dreamstreamstudio.ai/api/comic/public/s/${SLUG}/event`, body, { 'user-agent': HUMAN, 'cf-connecting-ip': '203.0.113.9' }),
      env({ SHARE_VIEW_SALT: 's'.repeat(40) })
    );
    expect(res.status).toBe(204);
    expect(state.pulled).toBeLessThanOrEqual(1024 + CHUNK);
    expect(fetchSpy.mock.calls.some((c) => String((c as unknown[])[0]).includes('comic_publication_track'))).toBe(false);
  });

  it('POST /api/agent-gate/checkin (production route): 400 "under 120 KB", stops after ~120 KB', async () => {
    const { state, body } = streamed(1024 * 1024);
    const res = await call(
      streamRequest('https://dreamstreamstudio.ai/api/agent-gate/checkin', body, { 'user-agent': 'ClaudeBot/1.0', 'content-type': 'application/json' }),
      env()
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/under 120 KB/);
    expect(state.pulled).toBeLessThanOrEqual(120_000 + CHUNK);
  });

  it('small, unsized bodies still work (a real report, a real event, a real check-in)', async () => {
    const fetchSpy = vi.fn(async () => new Response('null'));
    vi.stubGlobal('fetch', fetchSpy);
    const textStream = (s: string) =>
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(s));
          c.close();
        }
      });
    const event = await call(
      streamRequest(`https://dreamstreamstudio.ai/api/comic/public/s/${SLUG}/event`, textStream('{"type":"view"}'), { 'user-agent': HUMAN }),
      env({ SHARE_VIEW_SALT: 's'.repeat(40) })
    );
    expect(event.status).toBe(204);
    expect(fetchSpy.mock.calls.some((c) => String((c as unknown[])[0]).includes('comic_publication_track'))).toBe(true);
    const checkin = await call(
      streamRequest('https://dreamstreamstudio.ai/api/agent-gate/checkin', textStream('{"answers":{"q1":"ClaudeBot"}}'), { 'user-agent': 'ClaudeBot/1.0', 'content-type': 'application/json' }),
      env()
    );
    expect((await checkin.json()).answered).toBe(1);
  });
});
