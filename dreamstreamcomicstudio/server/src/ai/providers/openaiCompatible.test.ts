import { describe, it, expect, vi, afterEach } from 'vitest';
import { createOpenAICompatibleProvider } from './openaiCompatible.js';
import { staticModelsFor } from './staticModels.js';
import type { ProviderContext } from './types.js';

// Build a fake streaming Response whose body is a ReadableStream of the given SSE text,
// matching what generateTextStream reads via res.body.getReader().
const streamResponse = (sse: string): any => ({
  ok: true,
  body: new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse));
      controller.close();
    }
  })
});

describe('openai-compatible provider factory', () => {
  const provider = createOpenAICompatibleProvider({
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://example.invalid/v1',
    timeoutMs: 1000,
    modelsPath: '/models',
    supportsTools: true
  });

  it('returns the curated static seed when no key is supplied (no network)', async () => {
    const models = await provider.listModels();
    const seed = staticModelsFor('openai');
    expect(models.map((m) => m.id).sort()).toEqual(seed.map((m) => m.id).sort());
    expect(models.every((m) => m.source === 'openai')).toBe(true);
  });

  it('implements the full AIProvider surface', () => {
    expect(provider.id).toBe('openai');
    expect(typeof provider.generateText).toBe('function');
    expect(typeof provider.generateTextStream).toBe('function');
    expect(typeof provider.generateImage).toBe('function');
    expect(typeof provider.listModels).toBe('function');
  });

  it('a text-only provider refuses image generation with a clear error', async () => {
    await expect(provider.generateImage({ model: 'x', prompt: 'y' }, { apiKey: 'k', byok: true })).rejects.toThrow(/text provider/i);
  });
});

describe('openai-compatible generateTextStream index-less tool_calls (Gemini OpenAI-compat)', () => {
  const provider = createOpenAICompatibleProvider({
    id: 'gemini',
    label: 'Gemini',
    baseUrl: 'https://example.invalid/v1',
    timeoutMs: 1000,
    modelsPath: null,
    supportsTools: true
  });
  const ctx: ProviderContext = { apiKey: 'k', byok: false };
  const baseReq = () => ({ model: 'gemini-2.5-flash', messages: [{ role: 'user' as const, content: 'hi' }] });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps two index-less tool_calls in one delta as two separate, parseable calls', async () => {
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[' +
      '{"id":"a","function":{"name":"update_brief","arguments":"{\\"x\\":1}"}},' +
      '{"id":"b","function":{"name":"upsert_character","arguments":"{\\"y\\":2}"}}' +
      ']}}]}\n' +
      'data: [DONE]\n';
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(sse)));

    const result = await provider.generateTextStream!(baseReq(), ctx, () => {});
    expect(result.toolCalls).toHaveLength(2);
    const names = result.toolCalls!.map((c) => c.name).sort();
    expect(names).toEqual(['update_brief', 'upsert_character']);
    for (const c of result.toolCalls!) {
      expect(() => JSON.parse(c.arguments)).not.toThrow();
    }
    // Ids are distinct so two calls never collide on the same tool_call_id.
    const ids = new Set(result.toolCalls!.map((c) => c.id));
    expect(ids.size).toBe(2);
  });

  it('reassembles one index-less call whose arguments are split across deltas', async () => {
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[{"id":"a","function":{"name":"update_brief","arguments":"{\\"x\\":"}}]}}]}\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"arguments":"1}"}}]}}]}\n' +
      'data: [DONE]\n';
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(sse)));

    const result = await provider.generateTextStream!(baseReq(), ctx, () => {});
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe('update_brief');
    expect(JSON.parse(result.toolCalls![0].arguments)).toEqual({ x: 1 });
  });

  it('synthesizes a unique fallback id when the provider omits ids', async () => {
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[' +
      '{"function":{"name":"update_brief","arguments":"{}"}},' +
      '{"function":{"name":"update_brief","arguments":"{}"}}' +
      ']}}]}\n' +
      'data: [DONE]\n';
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(sse)));

    const result = await provider.generateTextStream!(baseReq(), ctx, () => {});
    expect(result.toolCalls).toHaveLength(2);
    const ids = new Set(result.toolCalls!.map((c) => c.id));
    expect(ids.size).toBe(2);
  });

  it('still handles well-behaved indexed streaming tool_calls', async () => {
    const sse =
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"update_brief","arguments":"{\\"x\\":"}}]}}]}\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]}}]}\n' +
      'data: [DONE]\n';
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse(sse)));

    const result = await provider.generateTextStream!(baseReq(), ctx, () => {});
    expect(result.toolCalls).toHaveLength(1);
    expect(JSON.parse(result.toolCalls![0].arguments)).toEqual({ x: 1 });
  });
});

describe('live model availability', () => {
  const provider = createOpenAICompatibleProvider({ id: 'openai', label: 'OpenAI', baseUrl: 'https://example.invalid/v1', timeoutMs: 1000, modelsPath: '/models' });
  afterEach(() => vi.unstubAllGlobals());
  it('uses the successful live list instead of retaining retired seed IDs', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'gpt-4o-mini' }, { id: 'brand-new-model' }, { id: 'brand-new-model' }] }))));
    const models = await provider.listModels({ apiKey: 'test-key', byok: true });
    expect(models.map((m) => m.id)).toEqual(['gpt-4o-mini', 'brand-new-model']);
    expect(models.every((m) => m.catalogOrigin === 'live')).toBe(true);
    expect(models.find((m) => m.id === 'gpt-4o-mini')?.pricingKnown).toBe(true);
    expect(models.find((m) => m.id === 'brand-new-model')).toMatchObject({ pricingKnown: false, isFree: false });
  });
  it('marks an invalid-key fallback as curated instead of verified live', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid key', { status: 401 })));
    const models = await provider.listModels({ apiKey: 'invalid', byok: true });
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.catalogOrigin === 'curated')).toBe(true);
  });
});

describe('structured JSON per provider (gateway wiring)', () => {
  const schema = {
    name: 'comic_translation',
    schema: { type: 'object', properties: { lines: { type: 'array', items: { type: 'string' } } }, required: ['lines'], additionalProperties: false }
  };
  const bodies: any[] = [];
  afterEach(() => {
    vi.unstubAllGlobals();
    bodies.length = 0;
  });
  const stubOk = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ model: 'm', choices: [{ message: { content: '{"lines":["a"]}' } }] }));
      })
    );

  it('openai with a schema sends strict json_schema', async () => {
    const { getProvider } = await import('../gateway.js');
    stubOk();
    const r = await getProvider('openai').generateText(
      { model: 'gpt-6-luna', messages: [{ role: 'user', content: 'x' }], jsonSchema: schema },
      { apiKey: 'test-key', byok: true }
    );
    expect(r.json).toEqual({ lines: ['a'] });
    expect(bodies[0].response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'comic_translation', schema: schema.schema, strict: true }
    });
  });

  it('openai honours an explicit strict:false and keeps json_object for bare JSON mode', async () => {
    const { getProvider } = await import('../gateway.js');
    stubOk();
    const openai = getProvider('openai');
    await openai.generateText({ model: 'm', messages: [{ role: 'user', content: 'x' }], jsonSchema: { ...schema, strict: false } }, { apiKey: 'k', byok: true });
    await openai.generateText({ model: 'm', messages: [{ role: 'user', content: 'x' }], jsonMode: true }, { apiKey: 'k', byok: true });
    expect(bodies[0].response_format.json_schema.strict).toBe(false);
    expect(bodies[1].response_format).toEqual({ type: 'json_object' });
  });

  it.each(['gemini', 'deepseek', 'xai'])('%s sends json_object for a schema', async (id) => {
    const { getProvider } = await import('../gateway.js');
    stubOk();
    await getProvider(id).generateText({ model: 'm', messages: [{ role: 'user', content: 'x' }], jsonSchema: schema }, { apiKey: 'k', byok: true });
    expect(bodies[0].response_format).toEqual({ type: 'json_object' });
  });
});

describe('vendor errors carry no key text', () => {
  const provider = createOpenAICompatibleProvider({ id: 'openai', label: 'OpenAI', baseUrl: 'https://example.invalid/v1', timeoutMs: 1000, modelsPath: '/models' });
  const echo = JSON.stringify({
    error: { message: `Incorrect API key provided: sk-proj-${'test0000'.repeat(6)}`, type: 'invalid_request_error', code: 'invalid_api_key' }
  });
  afterEach(() => vi.unstubAllGlobals());

  it('a 401 on a text call keeps the status and code and drops the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(echo, { status: 401, statusText: 'Unauthorized' })));
    const err = await provider.generateText({ model: 'm', messages: [{ role: 'user', content: 'x' }], retries: 1 }, { apiKey: 'k', byok: true }).catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/^OpenAI \/chat\/completions failed: 401 Unauthorized \(invalid_api_key\)/);
    expect(err.message).not.toContain('sk-');
  });

  it('a refused stream says the same and drops the key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(echo, { status: 401, statusText: 'Unauthorized' })));
    const err = await provider.generateTextStream!({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, { apiKey: 'k', byok: true }, () => {}).catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.message).toMatch(/^OpenAI stream failed: 401/);
    expect(err.message).not.toContain('sk-');
  });
});
