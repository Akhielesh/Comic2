import { describe, it, expect, vi, afterEach } from 'vitest';
import { openRouterProvider } from './openrouter.js';
import { registerZeroPricedModelLookup } from '../privacy/openrouterPolicy.js';

// The provider asks the catalog lookup the chat routes register (only for requests that carry
// connected-account content) which models are priced at $0. A fake one here.
const catalog = { models: [] as { id: string; costClass: string }[], fail: false, reads: 0 };
const fakeLookup = async (ids: readonly string[]) => {
  catalog.reads += 1;
  if (catalog.fail) throw new Error('catalog down');
  const zero = new Set(catalog.models.filter((m) => m.costClass === 'free_verified').map((m) => m.id.toLowerCase()));
  return new Set(ids.map((id) => id.toLowerCase()).filter((id) => zero.has(id)));
};
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
  catalog.models = [];
  catalog.fail = false;
  catalog.reads = 0;
  registerZeroPricedModelLookup(undefined);
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

// ── Review fixes: catalog-free models, capacity copy, refusal copy, egress probe ───────────────
import { connectorEgressProbe } from '../privacy/scope.js';
import { __resetSharedKeyCircuit } from '../providerCircuit.js';

describe('openrouter connected-account privacy: review fixes', () => {
  it('a model the catalog prices at $0 without the `:free` suffix is a free model for connector content', async () => {
    registerZeroPricedModelLookup(fakeLookup);
    catalog.models = [
      { id: 'vendor/zero', costClass: 'free_verified' },
      { id: 'paid/net', costClass: 'paid' }
    ];
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal('fetch', fetchMock);
    await runWithConnectorPrivacy(true, () =>
      openRouterProvider.generateText(baseReq({ model: 'vendor/zero', models: ['vendor/zero', 'paid/b'], fallbackModel: 'paid/net' }), ctx)
    );
    const [body] = sentBodies(fetchMock);
    expect(body.model).toBe('paid/net');
    expect(JSON.stringify(body)).not.toContain('vendor/zero');

    // Free only: refused (never moved to a paid model), with the Free only advice.
    fetchMock.mockClear();
    await expect(
      runWithConnectorPrivacy(true, () => openRouterProvider.generateText(baseReq({ model: 'vendor/zero', freeOnly: true }), ctx))
    ).rejects.toMatchObject({ status: 409, publicMessage: expect.stringContaining('turn off Free only') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the same $0 model outside the scope is untouched, and a plain request never reads the catalog', async () => {
    registerZeroPricedModelLookup(fakeLookup);
    catalog.models = [{ id: 'vendor/zero', costClass: 'free_verified' }];
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal('fetch', fetchMock);
    await openRouterProvider.generateText(baseReq({ model: 'vendor/zero' }), ctx);
    expect(sentBodies(fetchMock)[0].model).toBe('vendor/zero');
    expect(catalog.reads).toBe(0);
  });

  it('when the catalog cannot be read, the `:free` rule still applies and the request still denies data collection', async () => {
    registerZeroPricedModelLookup(fakeLookup);
    catalog.fail = true;
    const fetchMock = vi.fn(async () => answer());
    vi.stubGlobal('fetch', fetchMock);
    await runWithConnectorPrivacy(true, () =>
      openRouterProvider.generateText(baseReq({ model: 'vendor/w:free', fallbackModel: 'paid/net' }), ctx)
    );
    const [body] = sentBodies(fetchMock);
    expect(body.model).toBe('paid/net');
    expect(body.provider).toEqual({ data_collection: 'deny' });
  });

  it('a refusal that is not Free only advises picking a standard model, never "turn off Free only"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer()));
    const err = await runWithConnectorPrivacy(true, () =>
      openRouterProvider.generateText(baseReq({ model: 'vendor/w:free' }), ctx)
    ).catch((e) => e);
    expect(err).toMatchObject({ status: 409, publicCode: 'CONNECTED_DATA_NEEDS_STANDARD_MODEL' });
    expect(err.publicMessage).toContain('Pick a standard model instead of the free one');
    expect(err.publicMessage).not.toContain('Free only');
  });

  it('a capacity failure on connector content never advises switching to a free model; elsewhere the copy is unchanged', async () => {
    const capped = () => jsonResponse({ error: { message: 'Key limit exceeded (total limit)' } }, 403);
    vi.stubGlobal('fetch', vi.fn(async () => capped()));
    try {
      const err = await runWithConnectorPrivacy(true, () => openRouterProvider.generateText(baseReq({ retries: 1 }), ctx)).catch((e) => e);
      expect(err).toMatchObject({ status: 503, publicCode: 'PROVIDER_CAPACITY' });
      expect(err.publicMessage).not.toMatch(/switch to a free model/i);
      expect(err.publicMessage).toContain('never sent to free models');
      expect(err.publicMessage).toContain('add your own API key');
      expect(String(err.message)).toContain('403'); // the log message (and retriable checks) keep the provider text

      const plain = await openRouterProvider.generateText(baseReq({ retries: 1 }), ctx).catch((e) => e);
      expect(plain.publicMessage).toContain('switch to a free model');
    } finally {
      __resetSharedKeyCircuit();
    }
  });

  it('the egress probe learns when a scoped body really carries connector content, and only then', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer()));
    const withRag = connectorEgressProbe();
    await runWithConnectorPrivacy(
      true,
      () =>
        openRouterProvider.generateText(
          baseReq({ messages: [{ role: 'system', content: 'Base.\n\n## Connected account data (the user\'s authorized sources)\n- [Gmail] Lunch' }, { role: 'user', content: 'hi' }] }),
          ctx
        ),
      withRag
    );
    expect(withRag.sent).toBe(true);

    const toolOutput = connectorEgressProbe();
    await runWithConnectorPrivacy(
      true,
      () =>
        openRouterProvider.generateText(
          baseReq({
            messages: [
              { role: 'user', content: 'mail?' },
              { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'gmail_search', arguments: '{}' } }] },
              { role: 'tool', tool_call_id: 'c1', content: 'r' }
            ]
          }),
          ctx
        ),
      toolOutput
    );
    expect(toolOutput.sent).toBe(true);

    const nothing = connectorEgressProbe();
    await runWithConnectorPrivacy(true, () => openRouterProvider.generateText(baseReq(), ctx), nothing);
    expect(nothing.sent).toBe(false);
  });
});
