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

// ── Connected-account privacy (Google Limited Use) ─────────────────────────────────────────────
// A turn that carries content from the user's connected accounts sends
// `provider: { data_collection: 'deny' }` on EVERY OpenRouter call and never reaches a `:free`
// endpoint; every other turn's body is byte-identical to before.
import { runWithConnectorPrivacy } from '../privacy/scope.js';

const jsonResponse = (body: unknown, status = 200): any => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 200 ? 'OK' : 'Error',
  json: async () => body,
  text: async () => JSON.stringify(body)
});
const answer = (text = 'ok') => jsonResponse({ model: 'm', choices: [{ message: { content: text } }], usage: {} });
const sentBodies = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as { body: string }).body)));

describe('openrouter connected-account privacy', () => {
  it('a plain request is byte-identical to before: no provider field at all', async () => {
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal('fetch', fetchMock);
    await openRouterProvider.generateText(baseReq({ temperature: 0.3, maxTokens: 10 }), ctx);
    const [body] = sentBodies(fetchMock);
    expect(JSON.stringify(body)).toBe(
      JSON.stringify({ model: 'some/model', usage: { include: true }, temperature: 0.3, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] })
    );
    expect(body.provider).toBeUndefined();
  });

  it('inside the privacy scope every call (the first try and the fallback model) sends data_collection deny', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, 429)) // → fallback model
      .mockResolvedValueOnce(answer('from fallback'));
    vi.stubGlobal('fetch', fetchMock);
    const r = await runWithConnectorPrivacy(true, () =>
      openRouterProvider.generateText(baseReq({ fallbackModel: 'paid/fallback', retries: 1 }), ctx)
    );
    expect(r.text).toBe('from fallback');
    const bodies = sentBodies(fetchMock);
    expect(bodies.length).toBe(2);
    for (const b of bodies) expect(b.provider).toEqual({ data_collection: 'deny' });
    expect(bodies[1].model).toBe('paid/fallback');
  });

  it('the JSON repair round of a privacy-scoped call carries the flag too', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(answer('not json')).mockResolvedValueOnce(answer('{"a":1}'));
    vi.stubGlobal('fetch', fetchMock);
    const r = await runWithConnectorPrivacy(true, () => openRouterProvider.generateText(baseReq({ jsonMode: true }), ctx));
    expect(r.json).toEqual({ a: 1 });
    for (const b of sentBodies(fetchMock)) expect(b.provider).toEqual({ data_collection: 'deny' });
  });

  it('an explicit per-request dataCollection: deny works without a scope', async () => {
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal('fetch', fetchMock);
    await openRouterProvider.generateText({ ...baseReq(), dataCollection: 'deny' } as GenerateTextRequest, ctx);
    expect(sentBodies(fetchMock)[0].provider).toEqual({ data_collection: 'deny' });
  });

  it('streaming requests in the scope carry the flag; the same call outside the scope does not', async () => {
    const sse = 'data: {"choices":[{"delta":{"content":"hey"}}]}\n' + 'data: [DONE]\n';
    const fetchMock = vi.fn(async () => streamResponse(sse));
    vi.stubGlobal('fetch', fetchMock);
    await runWithConnectorPrivacy(true, () => openRouterProvider.generateTextStream!(baseReq(), ctx, () => {}));
    await openRouterProvider.generateTextStream!(baseReq(), ctx, () => {});
    const [inScope, outside] = sentBodies(fetchMock);
    expect(inScope.provider).toEqual({ data_collection: 'deny' });
    expect(inScope.stream).toBe(true);
    expect(outside.provider).toBeUndefined();
  });

  it('a nested scope that says false never clears the enclosing one (tool rounds, meta-tools)', async () => {
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal('fetch', fetchMock);
    await runWithConnectorPrivacy(true, async () => {
      await Promise.resolve();
      await runWithConnectorPrivacy(false, () => openRouterProvider.generateText(baseReq(), ctx));
    });
    expect(sentBodies(fetchMock)[0].provider).toEqual({ data_collection: 'deny' });
  });

  it('never sends connector content to a free model: free members leave the chain, a free primary goes to the paid net', async () => {
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal('fetch', fetchMock);
    await runWithConnectorPrivacy(true, () =>
      openRouterProvider.generateText(
        baseReq({ model: 'vendor/worker:free', models: ['vendor/worker:free', 'other/model:free', 'paid/b'], fallbackModel: 'paid/net' }),
        ctx
      )
    );
    const [body] = sentBodies(fetchMock);
    expect(body.model).toBe('paid/net');
    expect(body.models).toEqual(['paid/net', 'paid/b']);
    expect(JSON.stringify(body)).not.toMatch(/:free/);
    expect(body.provider).toEqual({ data_collection: 'deny' });
  });

  it('a free-only request with connector content is refused before anything is sent (never moved to a paid model)', async () => {
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      runWithConnectorPrivacy(true, () =>
        openRouterProvider.generateText(baseReq({ model: 'vendor/worker:free', freeOnly: true, fallbackModel: 'paid/net' }), ctx)
      )
    ).rejects.toMatchObject({ status: 409, publicCode: 'CONNECTED_DATA_NEEDS_STANDARD_MODEL' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a free model outside the scope is untouched (free models keep working on plain turns)', async () => {
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal('fetch', fetchMock);
    await openRouterProvider.generateText(baseReq({ model: 'vendor/worker:free', freeOnly: true }), ctx);
    expect(sentBodies(fetchMock)[0].model).toBe('vendor/worker:free');
  });

  it('when no private endpoint can serve the request, the failure is honest (not "model unavailable")', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: { message: 'No endpoints found matching your data policy' } }, 404));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      runWithConnectorPrivacy(true, () => openRouterProvider.generateText(baseReq({ fallbackModel: 'paid/net', retries: 1 }), ctx))
    ).rejects.toMatchObject({ publicCode: 'CONNECTED_DATA_NO_PRIVATE_ENDPOINT' });
    // The paid net was tried (still with the flag), never a free model.
    const bodies = sentBodies(fetchMock);
    expect(bodies.map((b) => b.model)).toEqual(['some/model', 'paid/net']);
    for (const b of bodies) expect(b.provider).toEqual({ data_collection: 'deny' });
  });

  it('an image generated inside a connector turn follows the same data policy', async () => {
    const img = jsonResponse({ model: 'img', choices: [{ message: { images: [{ image_url: { url: 'data:image/png;base64,AA' } }] } }] });
    const fetchMock = vi.fn(async () => img);
    vi.stubGlobal('fetch', fetchMock);
    await runWithConnectorPrivacy(true, () => openRouterProvider.generateImage({ model: 'img/model', prompt: 'p' }, ctx));
    await openRouterProvider.generateImage({ model: 'img/model', prompt: 'p' }, ctx);
    const [inScope, outside] = sentBodies(fetchMock);
    expect(inScope.provider).toEqual({ data_collection: 'deny' });
    expect(outside.provider).toBeUndefined();
  });
});
