import { describe, it, expect, vi, afterEach } from 'vitest';
import { openRouterProvider } from './openrouter.js';
import type { GenerateTextRequest, ProviderContext } from './types.js';

// Build a fake streaming Response whose body is a ReadableStream of the given SSE text,
// matching what streamOnce reads via res.body.getReader().
const streamResponse = (sse: string): any => ({
  ok: true,
  body: new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse));
      controller.close();
    }
  })
});

const baseReq = (over: Partial<GenerateTextRequest> = {}): GenerateTextRequest => ({
  model: 'some/model',
  messages: [{ role: 'user', content: 'hi' }],
  ...over
});

const ctx: ProviderContext = { apiKey: 'k', byok: false };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('openrouter generateTextStream mid-stream error handling', () => {
  it('throws a parseable "failed: NNN" error when the stream ends with an error event', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n' +
      'data: {"error":{"code":429,"message":"rate limited upstream"},"choices":[{"finish_reason":"error"}]}\n';
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(sse)));

    const deltas: string[] = [];
    await expect(
      openRouterProvider.generateTextStream!(baseReq(), ctx, (d) => {
        if (d.content) deltas.push(d.content);
      })
    ).rejects.toThrow(/OpenRouter stream failed: 429/);
    // The partial text that already streamed is surfaced to the caller via onDelta,
    // but the turn still fails rather than returning the truncated reply as success.
    expect(deltas.join('')).toBe('Hello');
  });

  it('does NOT retry on the fallback model once content has already streamed (no duplicate output)', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n' +
      'data: {"error":{"code":429,"message":"upstream rate limit"},"choices":[{"finish_reason":"error"}]}\n';
    const fetchMock = vi.fn(async () => streamResponse(sse));
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      openRouterProvider.generateTextStream!(
        baseReq({ fallbackModel: 'other/model' }),
        ctx,
        () => {}
      )
    ).rejects.toThrow(/OpenRouter stream failed: 429/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries on the fallback model when the error event is the only thing that arrived', async () => {
    const errorOnly = 'data: {"error":{"code":429,"message":"no capacity"},"choices":[{"finish_reason":"error"}]}\n';
    const good = 'data: {"choices":[{"delta":{"content":"recovered"}}]}\n' + 'data: [DONE]\n';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(streamResponse(errorOnly))
      .mockResolvedValueOnce(streamResponse(good));
    vi.stubGlobal('fetch', fetchMock);

    const result = await openRouterProvider.generateTextStream!(
      baseReq({ fallbackModel: 'other/model' }),
      ctx,
      () => {}
    );
    expect(result.text).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('coerces a non-numeric error code to 502 so statusOf still parses it', async () => {
    const sse = 'data: {"error":{"code":"server_error","message":"boom"},"choices":[{"finish_reason":"error"}]}\n';
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(sse)));

    await expect(
      openRouterProvider.generateTextStream!(baseReq(), ctx, () => {})
    ).rejects.toThrow(/OpenRouter stream failed: 502 boom/);
  });

  it('returns a normal result when the stream completes without an error event', async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"all "}}]}\n' +
      'data: {"choices":[{"delta":{"content":"good"}}]}\n' +
      'data: [DONE]\n';
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(sse)));

    const result = await openRouterProvider.generateTextStream!(baseReq(), ctx, () => {});
    expect(result.text).toBe('all good');
  });
});
