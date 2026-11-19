// A call made with a person's own key goes only to that maker's fixed address (shared/providers.ts
// PROVIDER_REGISTRY), whatever a *_BASE_URL override says, and never follows a redirect. Platform
// calls (byok: false) may still use the override (a deployment can point DreamStream's own key at a
// gateway). Every fetch here is stubbed; nothing leaves the process.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_REGISTRY, TEXT_PROVIDER_IDS } from '../../../../shared/providers.js';
import type { AIProvider, ProviderContext } from './types.js';

const EVIL = 'https://evil.example';
const OVERRIDES = [
  'OPENAI_BASE_URL',
  'XAI_BASE_URL',
  'ANTHROPIC_BASE_URL',
  'OPENROUTER_BASE_URL',
  'NVIDIA_BASE_URL',
  'GEMINI_OPENAI_BASE_URL',
  'DEEPSEEK_BASE_URL',
  'ZAI_BASE_URL',
  'MINIMAX_BASE_URL',
  'TENCENT_BASE_URL'
];

type Call = { url: string; init: RequestInit };
const calls: Call[] = [];

const okJson = () =>
  new Response(
    JSON.stringify({
      model: 'm',
      choices: [{ message: { content: 'ok' } }],
      content: [{ type: 'text', text: 'ok' }],
      data: [{ id: 'model-a', b64_json: 'AAAA' }]
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
const okStream = () =>
  new Response(new TextEncoder().encode('data: [DONE]\n\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });

let getProvider: (id?: string) => AIProvider;
let fetchOpenRouterKeyStatus: (key: string) => Promise<unknown>;

beforeAll(async () => {
  for (const name of OVERRIDES) vi.stubEnv(name, EVIL);
  vi.resetModules();
  ({ getProvider } = await import('../gateway.js'));
  ({ fetchOpenRouterKeyStatus } = await import('./openrouter.js'));
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push({ url, init });
      const body = typeof init.body === 'string' ? init.body : '';
      return body.includes('"stream":true') ? okStream() : okJson();
    })
  );
});

const own: ProviderContext = { apiKey: 'test-own-key-0000', byok: true };
const platform: ProviderContext = { apiKey: 'test-platform-key-0000', byok: false };
const req = { model: 'some-model', messages: [{ role: 'user' as const, content: 'hi' }], retries: 1 };

const exercise = async (provider: AIProvider, ctx: ProviderContext) => {
  await provider.generateText(req, ctx);
  if (provider.generateTextStream) await provider.generateTextStream(req, ctx, () => {});
  await provider.listModels(ctx);
};

describe('own-key calls go to the registry host', () => {
  it.each(TEXT_PROVIDER_IDS)('%s: every byok call uses the registry base URL and redirect: error', async (id) => {
    const provider = getProvider(id);
    expect(provider.id).toBe(id);
    await exercise(provider, own);
    const base = PROVIDER_REGISTRY[id].baseUrl;
    // NVIDIA's public model list is fetched without any key on purpose; every call that carries
    // the person's key is pinned to the registry host.
    const keyed = calls.filter((c) => JSON.stringify(c.init.headers ?? {}).includes(own.apiKey));
    expect(keyed.length).toBeGreaterThanOrEqual(provider.generateTextStream ? 2 : 1);
    for (const call of keyed) {
      expect(call.url.startsWith(`${base}/`), `${id} sent an own-key call to ${call.url}`).toBe(true);
      expect(call.url).not.toContain('evil.example');
    }
    for (const call of calls) expect(call.init.redirect).toBe('error');
  });

  it('an own OpenAI or xAI key draws pictures on the registry host too', async () => {
    await getProvider('openai').generateImage({ model: 'gpt-image-1', prompt: 'a fox' }, own);
    await getProvider('xai').generateImage({ model: 'grok-2-image', prompt: 'a fox' }, own);
    expect(calls.map((c) => c.url)).toEqual([
      `${PROVIDER_REGISTRY.openai.baseUrl}/images/generations`,
      `${PROVIDER_REGISTRY.xai.baseUrl}/images/generations`
    ]);
    expect(calls.every((c) => c.init.redirect === 'error')).toBe(true);
  });

  it("the OpenRouter key check goes to OpenRouter's own host", async () => {
    await fetchOpenRouterKeyStatus('test-own-key-0000');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${PROVIDER_REGISTRY.openrouter.baseUrl}/key`);
    expect(calls[0].init.redirect).toBe('error');
  });
});

describe('platform calls keep the deployment override', () => {
  it.each(['openai', 'anthropic', 'openrouter', 'nvidia', 'xai'] as const)('%s: a byok:false call may use the override', async (id) => {
    const provider = getProvider(id);
    await provider.generateText(req, platform);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url.startsWith(`${EVIL}/`)).toBe(true);
      expect(call.init.redirect).toBe('error');
    }
  });

  it('the public OpenRouter catalog (no key) keeps the override', async () => {
    await getProvider('openrouter').listModels();
    expect(calls[0].url).toBe(`${EVIL}/models`);
    expect(calls[0].init.redirect).toBe('error');
  });
});
