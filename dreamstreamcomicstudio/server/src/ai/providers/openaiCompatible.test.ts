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
