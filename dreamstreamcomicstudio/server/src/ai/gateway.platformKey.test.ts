// @vitest-environment node
// The platform OpenRouter key must never be handed to another vendor.
//
// Before this fix, platformKeyFor() fell back to the OpenRouter key for any provider without its own
// platform key. The public GET /api/models/catalog lists every direct provider's models on each
// request (withDirectProviderModels → getProviderModels(id, null)), so with only the OpenRouter key
// configured the server sent the OpenRouter secret to OpenAI, Anthropic, DeepSeek, xAI, … /models.
//
// These tests run the real gateway and the real provider clients; only the network is faked.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const OPENROUTER_SECRET = 'sk-or-PLATFORM-secret-do-not-leak';
const VENDOR_ENVS = [
  'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY',
  'MINIMAX_API_KEY', 'TENCENT_API_KEY', 'XAI_API_KEY', 'NVIDIA_API_KEY', 'DREAMSTREAMSTUDIO_ALL_KEY'
];
const saved: Record<string, string | undefined> = {};

let gateway: typeof import('./gateway.js');
let catalog: typeof import('../services/modelCatalog.js');
let providers: typeof import('../../../shared/providers.js');

const calls: Array<{ url: string; headers: Record<string, string> }> = [];
const headersOf = (init?: RequestInit): Record<string, string> => {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) h.forEach((v, k) => { out[k.toLowerCase()] = v; });
  else if (Array.isArray(h)) for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
  else for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
  return out;
};

beforeAll(async () => {
  for (const k of [...VENDOR_ENVS, 'OPENROUTER_API_KEY']) saved[k] = process.env[k];
  for (const k of VENDOR_ENVS) delete process.env[k];
  process.env.OPENROUTER_API_KEY = OPENROUTER_SECRET;
  vi.resetModules();
  gateway = await import('./gateway.js');
  catalog = await import('../services/modelCatalog.js');
  providers = await import('../../../shared/providers.js');
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.unstubAllGlobals();
});

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input instanceof Request ? input.url : input), headers: headersOf(init) });
    return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
});

describe('platformKeyFor: the OpenRouter key stays with OpenRouter', () => {
  it('a direct provider without its own platform key gets no key, never the OpenRouter key', () => {
    for (const id of ['openai', 'anthropic', 'gemini', 'deepseek', 'zai', 'minimax', 'tencent', 'xai', 'nvidia', 'OpenAI']) {
      expect(gateway.platformKeyFor(id), id).toBe('');
      const ctx = gateway.resolveProviderContext(undefined, id);
      expect(ctx.apiKey, id).toBe('');
      expect(ctx.byok).toBe(false);
    }
  });

  it('OpenRouter, and no provider at all, keep the OpenRouter platform key', () => {
    expect(gateway.platformKeyFor('openrouter')).toBe(OPENROUTER_SECRET);
    expect(gateway.platformKeyFor()).toBe(OPENROUTER_SECRET);
    expect(gateway.resolveProviderContext(null).apiKey).toBe(OPENROUTER_SECRET);
  });

  it("a caller's own key always wins (BYOK)", () => {
    expect(gateway.resolveProviderContext('sk-user-own', 'openai')).toEqual({ apiKey: 'sk-user-own', byok: true });
  });
});

describe('the public catalog path never sends the OpenRouter key to another vendor', () => {
  it('listing every direct provider with no caller key makes no request carrying the OpenRouter secret', async () => {
    const direct = providers.TEXT_PROVIDER_IDS.filter((id) => id !== 'openrouter');
    expect(direct.length).toBeGreaterThan(3);
    for (const id of direct) await catalog.getProviderModels(id as never, null);
    const leaked = calls.filter((c) => Object.values(c.headers).some((v) => v.includes(OPENROUTER_SECRET)) || c.url.includes(OPENROUTER_SECRET));
    expect(leaked.map((c) => c.url)).toEqual([]);
  });

  it('a caller-supplied vendor key is still used for that vendor (live list, not the seed)', async () => {
    await catalog.getProviderModels('openai' as never, 'sk-user-openai');
    const toOpenAI = calls.filter((c) => /openai\.com/.test(c.url));
    expect(toOpenAI.length).toBeGreaterThan(0);
    expect(Object.values(toOpenAI[0].headers).join(' ')).toContain('sk-user-openai');
  });
});
