// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIProvider, GenerateTextRequest, GenerateTextResult } from '../ai/providers/types.js';
import { makeProviderError, modelTimeoutError } from '../ai/providers/errors.js';
import { createLlmClient, toLlmStudioError } from './llm.js';
import { StudioError, type StudioKeys } from './types.js';

const OR_KEYS: StudioKeys = { openrouter: { key: 'sk-or-test', byok: false } };
const GEM_KEYS: StudioKeys = { gemini: { key: 'AIza-test', byok: true } };

const ok = (over: Partial<GenerateTextResult> = {}): GenerateTextResult => ({
  text: 'hello',
  model: 'google/gemini-3.8-flash',
  usage: { promptTokens: 10, completionTokens: 5, costUsd: 0.0012 },
  ...over
});

const makeProvider = (impl: Partial<AIProvider> = {}) => {
  const provider = {
    id: 'openrouter',
    generateText: vi.fn(async () => ok()),
    generateImage: vi.fn(),
    listModels: vi.fn(),
    ...impl
  } as unknown as AIProvider & { generateText: ReturnType<typeof vi.fn> };
  return provider;
};

const setup = (keys: StudioKeys, impl: Partial<AIProvider> = {}) => {
  const provider = makeProvider(impl);
  const getProvider = vi.fn(() => provider);
  const sleep = vi.fn(async () => undefined);
  const client = createLlmClient(keys, { getProvider, sleep });
  return { provider, getProvider, sleep, client };
};

describe('createLlmClient — routing', () => {
  beforeEach(() => {
    delete process.env.COMIC_WRITER_MODEL;
    delete process.env.COMIC_DIRECTOR_MODEL;
  });

  it('throws NO_TEXT_KEY without keys', async () => {
    const { client } = setup({});
    await expect(client.complete({ role: 'director', messages: [] })).rejects.toMatchObject({ code: 'NO_TEXT_KEY' });
  });

  it('routes OpenRouter with the fallback chain, role defaults, strict schema and one provider attempt', async () => {
    const { client, getProvider, provider } = setup(OR_KEYS, {
      generateText: vi.fn(async () => ok({ json: { pages: [] }, text: '{"pages":[]}' }))
    });
    const result = await client.complete({
      role: 'writer',
      messages: [{ role: 'user', content: 'plan' }],
      jsonSchema: { name: 'plan', schema: { type: 'object' } }
    });
    expect(getProvider).toHaveBeenCalledWith('openrouter');
    const [req, ctx] = (provider.generateText as ReturnType<typeof vi.fn>).mock.calls[0] as [GenerateTextRequest, { apiKey: string; byok: boolean }];
    expect(req.model).toBe('anthropic/claude-sonnet-5.5');
    expect(req.models).toEqual(['anthropic/claude-sonnet-5.5', 'google/gemini-4-argon', 'google/gemini-3.8-flash']);
    expect(req.jsonSchema).toEqual({ name: 'plan', schema: { type: 'object' }, strict: true });
    expect(req.temperature).toBe(0.8);
    // writer visible budget (16_000) + medium reasoning headroom (ceil(2048 * 1.5) = 3072).
    expect(req.maxTokens).toBe(19_072);
    expect(req.reasoningEffort).toBe('medium');
    expect(req.timeoutMs).toBe(150_000);
    expect(req.retries).toBe(1);
    expect(ctx).toEqual({ apiKey: 'sk-or-test', byok: false });
    expect(result).toMatchObject({
      json: { pages: [] },
      costUsd: 0.0012,
      promptTokens: 10,
      completionTokens: 5,
      byok: false,
      provider: 'openrouter'
    });
  });

  it('respects explicit temperature / maxTokens and an explicit non-strict schema', async () => {
    const { client, provider } = setup(OR_KEYS, { generateText: vi.fn(async () => ok({ json: {} })) });
    await client.complete({
      role: 'vision',
      messages: [],
      temperature: 0.3,
      maxTokens: 99,
      jsonSchema: { name: 'qc', schema: {}, strict: false }
    });
    const req = (provider.generateText as ReturnType<typeof vi.fn>).mock.calls[0][0] as GenerateTextRequest;
    expect(req.temperature).toBe(0.3);
    // explicit visible budget (99) + vision 'low' reasoning headroom (ceil(1024 * 1.5) = 1536).
    expect(req.maxTokens).toBe(1635);
    expect(req.reasoningEffort).toBe('low');
    expect(req.jsonSchema?.strict).toBe(false);
    expect(req.timeoutMs).toBe(60_000);
  });

  it('routes Gemini direct with stripped ids, a fallbackModel, BYOK flag and a schema instruction', async () => {
    const { client, getProvider, provider } = setup(GEM_KEYS, { generateText: vi.fn(async () => ok({ json: { a: 1 } })) });
    const result = await client.complete({
      role: 'writer',
      messages: [
        { role: 'system', content: 'You are a writer.' },
        { role: 'user', content: 'go' }
      ],
      jsonSchema: { name: 'plan', schema: { type: 'object', properties: { a: { type: 'number' } } } }
    });
    expect(getProvider).toHaveBeenCalledWith('gemini');
    const req = (provider.generateText as ReturnType<typeof vi.fn>).mock.calls[0][0] as GenerateTextRequest;
    expect(req.model).toBe('gemini-4-argon');
    expect(req.fallbackModel).toBe('gemini-3.8-flash');
    expect(req.models).toBeUndefined();
    expect(req.messages).toHaveLength(3);
    expect(req.messages[0].content).toBe('You are a writer.');
    expect(String(req.messages[1].content)).toContain('JSON Schema');
    expect(req.messages[2].content).toBe('go');
    expect(result.byok).toBe(true);
    expect(result.provider).toBe('gemini');
  });

  it('streams director narration through onDelta when the provider can stream', async () => {
    const deltas: string[] = [];
    const generateTextStream = vi.fn(async (_req: GenerateTextRequest, _ctx: unknown, onDelta: (d: { content?: string; reasoning?: string }) => void) => {
      onDelta({ content: 'Hel' });
      onDelta({ reasoning: 'thinking…' });
      onDelta({ content: 'lo' });
      return ok({ text: 'Hello', toolCalls: [{ id: 'c1', name: 'set_brief', arguments: '{}' }] });
    });
    const { client, provider } = setup(OR_KEYS, { generateTextStream });
    const result = await client.complete({
      role: 'director',
      messages: [],
      tools: [{ type: 'function', function: { name: 'set_brief', description: 'x', parameters: {} } }],
      onDelta: (t) => deltas.push(t)
    });
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(provider.generateText).not.toHaveBeenCalled();
    expect(result.toolCalls?.[0].name).toBe('set_brief');
    const req = generateTextStream.mock.calls[0][0];
    expect(req.tools).toHaveLength(1);
    expect(req.timeoutMs).toBe(90_000);
  });

  it('does not stream structured JSON requests (they need the parse + repair path)', async () => {
    const generateTextStream = vi.fn();
    const { client, provider } = setup(OR_KEYS, { generateTextStream, generateText: vi.fn(async () => ok({ json: {} })) });
    await client.complete({ role: 'writer', messages: [], jsonSchema: { name: 'p', schema: {} }, onDelta: () => undefined });
    expect(generateTextStream).not.toHaveBeenCalled();
    expect(provider.generateText).toHaveBeenCalledTimes(1);
  });
});

describe('createLlmClient — failures', () => {
  it('retries once on a rate limit, then succeeds', async () => {
    const generateText = vi
      .fn()
      .mockRejectedValueOnce(makeProviderError(429, 'OpenRouter /chat/completions failed: 429 Too Many Requests'))
      .mockResolvedValueOnce(ok());
    const { client, sleep } = setup(OR_KEYS, { generateText });
    const result = await client.complete({ role: 'director', messages: [] });
    expect(result.text).toBe('hello');
    expect(generateText).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('gives up after one retry with a friendly RATE_LIMIT error', async () => {
    const generateText = vi.fn().mockRejectedValue(makeProviderError(429, 'OpenRouter /chat/completions failed: 429 rate limit'));
    const { client } = setup(OR_KEYS, { generateText });
    const err = await client.complete({ role: 'writer', messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(StudioError);
    expect(err.code).toBe('RATE_LIMIT');
    expect(err.userMessage).toMatch(/story planner is busy/);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('does not retry timeouts', async () => {
    const generateText = vi.fn().mockRejectedValue(modelTimeoutError(150_000));
    const { client } = setup(OR_KEYS, { generateText });
    const err = await client.complete({ role: 'writer', messages: [] }).catch((e) => e);
    expect(err.code).toBe('TIMEOUT');
    expect(err.retryable).toBe(true);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('does not retry an unreadable JSON reply (the provider already repaired once)', async () => {
    const generateText = vi.fn().mockRejectedValue(new Error('Could not parse JSON from model output'));
    const { client } = setup(OR_KEYS, { generateText });
    const err = await client.complete({ role: 'writer', messages: [], jsonSchema: { name: 'p', schema: {} } }).catch((e) => e);
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.userMessage).toMatch(/couldn't be read/);
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it('retries a truncated reply once with a doubled token budget and no backoff sleep', async () => {
    const truncated = Object.assign(new Error('Model reply truncated (finish_reason=length)'), { publicCode: 'TRUNCATED' });
    const generateText = vi.fn().mockRejectedValueOnce(truncated).mockResolvedValueOnce(ok({ json: { pages: [] } }));
    const { client, sleep, provider } = setup(OR_KEYS, { generateText });
    const result = await client.complete({ role: 'writer', messages: [], jsonSchema: { name: 'p', schema: {} } });
    expect(result.json).toEqual({ pages: [] });
    expect(generateText).toHaveBeenCalledTimes(2);
    // Truncation isn't a transient blip — it's retried immediately, not after a backoff.
    expect(sleep).not.toHaveBeenCalled();
    // Writer start budget 19_072 (16_000 visible + 3072 medium headroom) doubled on the retry.
    const req = (provider.generateText as ReturnType<typeof vi.fn>).mock.calls[1][0] as GenerateTextRequest;
    expect(req.maxTokens).toBe(38_144);
  });

  it('gives up after exactly one truncation retry', async () => {
    const generateText = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('Model reply truncated (finish_reason=length)'), { publicCode: 'TRUNCATED' }));
    const { client } = setup(OR_KEYS, { generateText });
    const err = await client.complete({ role: 'writer', messages: [], jsonSchema: { name: 'p', schema: {} } }).catch((e) => e);
    expect(err).toBeInstanceOf(StudioError);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('retries an empty reply once, then fails honestly', async () => {
    const generateText = vi.fn().mockResolvedValue(ok({ text: '  ', toolCalls: undefined }));
    const { client } = setup(OR_KEYS, { generateText });
    const err = await client.complete({ role: 'director', messages: [] }).catch((e) => e);
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(err.userMessage).toMatch(/empty reply/);
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('never retries after text already streamed (it would duplicate)', async () => {
    const generateTextStream = vi.fn(async (_r: GenerateTextRequest, _c: unknown, onDelta: (d: { content?: string }) => void) => {
      onDelta({ content: 'partial' });
      throw new Error('OpenRouter stream failed: 502 Bad Gateway');
    });
    const { client } = setup(OR_KEYS, { generateTextStream });
    const err = await client.complete({ role: 'director', messages: [], onDelta: () => undefined }).catch((e) => e);
    expect(err.code).toBe('PROVIDER_ERROR');
    expect(generateTextStream).toHaveBeenCalledTimes(1);
  });

  it('cancels immediately when the signal aborts mid-call and drops late deltas', async () => {
    let release: (v: GenerateTextResult) => void = () => undefined;
    const deltas: string[] = [];
    let emit: ((d: { content?: string }) => void) | undefined;
    const generateTextStream = vi.fn(
      (_r: GenerateTextRequest, _c: unknown, onDelta: (d: { content?: string }) => void) =>
        new Promise<GenerateTextResult>((resolve) => {
          emit = onDelta;
          release = resolve;
        })
    );
    const { client } = setup(OR_KEYS, { generateTextStream });
    const controller = new AbortController();
    const pending = client.complete({ role: 'director', messages: [], signal: controller.signal, onDelta: (t) => deltas.push(t) });
    await Promise.resolve();
    emit?.({ content: 'a' });
    controller.abort();
    emit?.({ content: 'late' });
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    release(ok());
    expect(deltas).toEqual(['a']);
  });

  it('rejects an already-aborted signal without calling the provider', async () => {
    const { client, provider } = setup(OR_KEYS);
    const controller = new AbortController();
    controller.abort();
    await expect(client.complete({ role: 'director', messages: [], signal: controller.signal })).rejects.toMatchObject({
      code: 'CANCELLED'
    });
    expect(provider.generateText).not.toHaveBeenCalled();
  });
});

describe('toLlmStudioError', () => {
  const ctx = { role: 'director' as const, route: 'openrouter' as const, byok: false };

  it('maps capacity errors differently for platform and BYOK keys', () => {
    const platform = toLlmStudioError(makeProviderError(402, 'failed: 402 requires more credits'), ctx);
    expect(platform.code).toBe('PROVIDER_ERROR');
    expect(platform.userMessage).toMatch(/shared AI service/);
    const byok = toLlmStudioError(makeProviderError(402, 'failed: 402 requires more credits'), { ...ctx, byok: true });
    expect(byok.userMessage).toMatch(/Your OpenRouter key is out of credits/);
  });

  it('maps a rejected key', () => {
    const err = toLlmStudioError(new Error('Gemini /chat/completions failed: 401 Unauthorized'), { ...ctx, route: 'gemini', byok: true });
    expect(err.userMessage).toBe('Your Gemini key was rejected. Check it in Settings → API keys.');
    expect(err.retryable).toBe(false);
  });

  it('maps missing models, 5xx and network failures', () => {
    expect(toLlmStudioError(new Error('OpenRouter failed: 404 No endpoints found'), ctx).userMessage).toMatch(/isn't available/);
    const bad = toLlmStudioError(makeProviderError(503, 'OpenRouter failed: 503 Service Unavailable'), ctx);
    expect(bad).toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
    expect(toLlmStudioError(new TypeError('fetch failed'), ctx)).toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
  });

  it('maps safety refusals and passes StudioErrors through', () => {
    expect(toLlmStudioError(new Error('failed: 400 flagged by content policy moderation'), ctx).code).toBe('SAFETY_BLOCKED');
    const original = new StudioError('BUDGET_EXCEEDED', 'x');
    expect(toLlmStudioError(original, ctx)).toBe(original);
  });

  it('never leaks raw provider bodies', () => {
    const err = toLlmStudioError(new Error('OpenRouter failed: 400 {"error":{"message":"secret internals"}}'), ctx);
    expect(err.userMessage).not.toContain('secret');
  });
});
