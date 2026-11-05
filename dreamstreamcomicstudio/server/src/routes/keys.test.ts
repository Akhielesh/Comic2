// @vitest-environment node
// POST /api/keys/validate only ever checks a key the CALLER owns (its provider header or the
// signed-in user's account key) — never the platform env key attachKeys falls back to — and
// answers with { provider, status, valid, message } only. Before BK-0 the route sat in front of
// requireAuth and, called with no key header, validated the PLATFORM OpenRouter key and returned
// its live /key record (usage, limits) to anyone.
//
// The app below is the production chain from server/src/index.ts with the REAL middleware:
// attachKeys → requireAuth → attachAccountKeys → /api/keys. Only the edges are faked: the
// Supabase token lookup and account-key table, the secure store, the allowance budget, and the
// outbound provider fetch.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  rows: [] as { provider: string; encrypted_key: string; iv: string }[],
  allowance: { on: false, usePlatformAllowance: true, exhausted: false }
}));

vi.mock('../services/supabase.js', () => ({
  supabase: {
    auth: {
      getUser: vi.fn(async (token: string) =>
        token === 'good-token'
          ? { data: { user: { id: 'user-1', email: 'u1@example.com' } }, error: null }
          : { data: { user: null }, error: { message: 'bad token' } }
      )
    }
  },
  getSupabaseCapabilityStatus: () => ({ storagePersistenceEnabled: true }),
  getSupabaseAdmin: () => ({
    from: () => ({ select: () => ({ eq: async () => ({ data: store.rows, error: null }) }) })
  })
}));
const logs = vi.hoisted(() => ({ warn: [] as { event: string; fields?: Record<string, unknown> }[] }));
vi.mock('../lib/logger.js', () => ({
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: (event: string, fields?: Record<string, unknown>) => { logs.warn.push({ event, fields }); },
    error: () => undefined
  }
}));
vi.mock('../lib/secureStore.js', () => ({
  isSecureStoreAvailable: () => true,
  decryptSecret: (enc: string) => enc
}));
vi.mock('../services/platformAllowance.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/platformAllowance.js')>()),
  allowanceEnabled: () => store.allowance.on,
  getBillingPrefs: async () => ({ usePlatformAllowance: store.allowance.usePlatformAllowance, byokFallbackMode: 'never' }),
  getAllowanceStatus: async () => ({
    enabled: true,
    governed: true,
    exhausted: store.allowance.exhausted,
    exempt: false,
    allowPro: false,
    capUsd: 10,
    usedUsd: 1,
    pctUsed: 10,
    pctLeft: 90,
    period: 'lifetime',
    resetsAt: null,
    crossed: []
  })
}));

const { attachKeys } = await import('../middleware/keys.js');
const { requireAuth } = await import('../middleware/auth.js');
const { attachAccountKeys, invalidateAccountKeys } = await import('../middleware/accountKeys.js');
const { keysRouter } = await import('./keys.js');

// Platform env keys for every provider the route can be asked about. None may ever be validated.
const PLATFORM = {
  OPENROUTER_API_KEY: 'sk-or-PLATFORM-secret',
  NVIDIA_API_KEY: 'nvapi-PLATFORM-secret',
  GEMINI_API_KEY: 'AIza-PLATFORM-secret',
  OPENAI_API_KEY: 'sk-PLATFORM-openai',
  ANTHROPIC_API_KEY: 'sk-ant-PLATFORM-secret',
  PIXAZO_API_KEY: 'pix-PLATFORM-secret',
  IDEOGRAM_API_KEY: 'ideo-PLATFORM-secret'
};

// What OpenRouter's GET /key returns for a good key: the account record that must never leave.
const OPENROUTER_KEY_RECORD = {
  data: {
    label: 'sk-or-v1-abc…',
    usage: 12.34,
    limit: 50,
    limit_remaining: 37.66,
    is_free_tier: false,
    rate_limit: { requests: 200, interval: '10s' }
  }
};

type Upstream = { url: string; headers: Record<string, string>; body?: unknown };
const upstream: Upstream[] = [];

// How the fake upstream answers: a normal 200, a fixed HTTP status, or a thrown network error
// whose text carries internal detail (an internal IP) that must never reach the caller.
const LEAKY_NETWORK_ERROR = 'connect ECONNREFUSED 10.0.0.7:443';
let upstreamMode: 'ok' | 'refused' | number = 'ok';

const realFetch = globalThis.fetch;
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (/^http:\/\/127\.0\.0\.1:/.test(url)) return realFetch(input, init);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
  upstream.push({ url, headers, body: init?.body });
  // Like the real fetch: an unparseable URL (a malformed operator-set *_BASE_URL) throws with it.
  try { new URL(url); } catch { throw new TypeError(`Failed to parse URL from ${url}`); }
  if (upstreamMode === 'refused') throw new TypeError(LEAKY_NETWORK_ERROR);
  if (typeof upstreamMode === 'number') return new Response('{"error":"upstream"}', { status: upstreamMode });
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/key')) return json(OPENROUTER_KEY_RECORD);
  if (url.includes('/v1beta/models')) return json({ models: [{ name: 'models/x' }] });
  if (url.endsWith('/models')) return json({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  return new Response('not found', { status: 404 });
}) as typeof fetch;

const app = express();
app.use(express.json());
app.use(attachKeys);
app.use('/api', requireAuth);
app.use('/api', attachAccountKeys);
app.use('/api/keys', keysRouter);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  return new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  upstream.length = 0;
  upstreamMode = 'ok';
  logs.warn = [];
  store.rows = [];
  store.allowance = { on: false, usePlatformAllowance: true, exhausted: false };
  invalidateAccountKeys('user-1');
  vi.stubGlobal('fetch', fakeFetch);
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries(PLATFORM)) vi.stubEnv(k, v);
});
afterEach(() => {
  // Whatever a test did, no platform key ever left the server in any outbound header or URL.
  for (const call of upstream) {
    expect(call.url).not.toMatch(/PLATFORM/);
    for (const value of Object.values(call.headers)) expect(value).not.toMatch(/PLATFORM/);
  }
});

const validate = async (provider: unknown, headers: Record<string, string> = {}, auth = true) => {
  const res = await fetch(`${base}/api/keys/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer good-token' } : {}), ...headers },
    body: JSON.stringify({ provider })
  });
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, unknown> };
};

const ALLOWED_FIELDS = ['message', 'provider', 'status', 'valid'];
// Anything from a provider account record (OpenRouter /key: label, usage, limit,
// limit_remaining, is_free_tier, rate_limit; /credits) or a platform key.
const LEAKY = /usage|label|is_free_tier|rate_limit|limit|credit|detail|PLATFORM/i;
const authOut = (u: Upstream) => u.headers.authorization ?? u.headers['x-api-key'] ?? u.headers['x-goog-api-key'];

describe('POST /api/keys/validate never touches the platform key', () => {
  it.each(['openrouter', 'nvidia', 'gemini', 'openai', 'anthropic', 'pixazo', 'ideogram'])(
    'signed in, no key header, platform %s key set → missing, no detail, and no upstream call',
    async (provider) => {
      const r = await validate(provider);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ provider, status: 'missing', valid: false });
      expect(r.body.detail).toBeUndefined();
      expect(Object.keys(r.body).sort()).toEqual(ALLOWED_FIELDS);
      expect(r.text).not.toMatch(LEAKY);
      expect(upstream).toEqual([]);
    }
  );

  it('a source the user turned off (X-Allowed-Sources) → missing, even with a key header, and no call', async () => {
    const r = await validate('nvidia', { 'X-Nvidia-Key': 'nvapi-user', 'X-Allowed-Sources': 'openrouter' });
    expect(r.body).toMatchObject({ provider: 'nvidia', status: 'missing', valid: false });
    expect(upstream).toEqual([]);
  });
});

describe('signed-out callers', () => {
  it('get 401 before anything is validated, even with a key header', async () => {
    for (const provider of ['openrouter', 'nvidia', 'gemini']) {
      const r = await validate(provider, { 'X-OpenRouter-Key': 'sk-or-user', 'X-Nvidia-Key': 'nvapi-user', 'X-Gemini-Key': 'AIza-user' }, false);
      expect(r.status).toBe(401);
      expect(r.body).not.toHaveProperty('status');
    }
    expect(upstream).toEqual([]);
  });

  it('index.ts mounts /api/keys once, after requireAuth and attachAccountKeys', () => {
    const src = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8');
    const mounts = [...src.matchAll(/^app\.use\('\/api\/keys',.*$/gm)];
    expect(mounts).toHaveLength(1);
    expect(mounts[0][0]).toBe("app.use('/api/keys', systemRateLimit, keysRouter);");
    const at = mounts[0].index!;
    const requireAuthAt = src.indexOf("app.use('/api', requireAuth);");
    const accountKeysAt = src.indexOf("app.use('/api', attachAccountKeys);");
    expect(requireAuthAt).toBeGreaterThan(0);
    expect(accountKeysAt).toBeGreaterThan(requireAuthAt);
    expect(at).toBeGreaterThan(accountKeysAt);
  });
});

describe('the caller’s own key', () => {
  it('OpenRouter header key: only Bearer sk-or-user goes out; the /key record never comes back', async () => {
    const r = await validate('openrouter', { 'X-OpenRouter-Key': 'sk-or-user' });
    expect(r.body).toEqual({ provider: 'openrouter', status: 'valid', valid: true, message: 'Valid OpenRouter key.' });
    expect(r.text).not.toMatch(LEAKY);
    expect(upstream).toHaveLength(1);
    expect(upstream[0].url).toMatch(/\/key$/);
    expect(upstream.map(authOut)).toEqual(['Bearer sk-or-user']);
  });

  it('NVIDIA header key: model count stays in the message, no detail object', async () => {
    const r = await validate('nvidia', { 'X-Nvidia-Key': 'nvapi-user' });
    expect(r.body).toEqual({ provider: 'nvidia', status: 'valid', valid: true, message: 'Valid — 3 models reachable.' });
    expect(upstream.map(authOut)).toEqual(['Bearer nvapi-user']);
  });

  it('direct providers use the header key only (OpenAI bearer, Anthropic x-api-key)', async () => {
    const openai = await validate('openai', { 'X-OpenAI-Key': 'sk-openai-user' });
    expect(Object.keys(openai.body).sort()).toEqual(ALLOWED_FIELDS);
    expect(openai.body).toMatchObject({ provider: 'openai', status: 'valid', valid: true });
    const anthropic = await validate('anthropic', { 'X-Anthropic-Key': 'sk-ant-user' });
    expect(anthropic.body).toMatchObject({ provider: 'anthropic', status: 'valid', valid: true });
    expect(upstream.map(authOut)).toEqual(['Bearer sk-openai-user', 'sk-ant-user']);
    expect(upstream[1].headers.authorization).toBeUndefined();
  });

  it('Gemini key goes upstream in the x-goog-api-key header, never in the URL or a body', async () => {
    const r = await validate('gemini', { 'X-Gemini-Key': 'AIza-user-secret' });
    expect(r.body).toEqual({ provider: 'gemini', status: 'valid', valid: true, message: 'Valid Gemini key.' });
    expect(upstream).toHaveLength(1);
    expect(upstream[0].headers['x-goog-api-key']).toBe('AIza-user-secret');
    expect(upstream[0].url).not.toContain('AIza-user-secret');
    expect(upstream[0].url).not.toMatch(/[?&]key=/);
    expect(upstream[0].body).toBeUndefined();
  });

  it('Pixazo and Ideogram header keys are stored but not live-checkable — no call', async () => {
    const pixazo = await validate('pixazo', { 'X-Pixazo-Key': 'pix-user' });
    expect(pixazo.body).toMatchObject({ provider: 'pixazo', status: 'unsupported', valid: false });
    const ideogram = await validate('ideogram', { 'X-Ideogram-Key': 'ideo-user' });
    expect(ideogram.status).toBe(200);
    expect(ideogram.body).toEqual({
      provider: 'ideogram',
      status: 'unsupported',
      valid: false,
      message: 'Stored — Ideogram has no validation endpoint, so it can’t be live-checked.'
    });
    expect(upstream).toEqual([]);
  });
});

describe('the signed-in user’s account key (real attachAccountKeys)', () => {
  const accountRow = () => { store.rows = [{ provider: 'openrouter', encrypted_key: 'sk-or-ACCOUNT', iv: 'iv' }]; };

  it('allowance off: the account key — and only it — is checked', async () => {
    accountRow();
    const r = await validate('openrouter');
    expect(r.body).toEqual({ provider: 'openrouter', status: 'valid', valid: true, message: 'Valid OpenRouter key.' });
    expect(upstream.map(authOut)).toEqual(['Bearer sk-or-ACCOUNT']);
  });

  it('allowance on and not used up: the platform key is kept (BYOK false) → missing, no call', async () => {
    accountRow();
    store.allowance = { on: true, usePlatformAllowance: true, exhausted: false };
    const r = await validate('openrouter');
    expect(r.body).toMatchObject({ provider: 'openrouter', status: 'missing', valid: false });
    expect(upstream).toEqual([]);
  });
});

describe('failures never echo internal detail', () => {
  it.each([
    ['nvidia', { 'X-Nvidia-Key': 'nvapi-user' }, 'Could not reach NVIDIA Build right now.'],
    ['gemini', { 'X-Gemini-Key': 'AIza-user' }, 'Could not reach Google right now.'],
    ['openai', { 'X-OpenAI-Key': 'sk-openai-user' }, 'Could not reach OpenAI right now.'],
    ['anthropic', { 'X-Anthropic-Key': 'sk-ant-user' }, 'Could not reach Anthropic right now.'],
    ['openrouter', { 'X-OpenRouter-Key': 'sk-or-user' }, 'Could not reach OpenRouter right now.']
  ])('%s: a network error (ECONNREFUSED) → the fixed message, no verdict', async (provider, headers, message) => {
    upstreamMode = 'refused';
    const r = await validate(provider, headers);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ provider, status: 'unavailable', valid: false, message });
    expect(r.text).not.toMatch(/ECONNREFUSED|10\.0\.0\.|connect/);
    expect(upstream).toHaveLength(1);
    // The detail is kept for operators — in the server log only.
    expect(logs.warn).toContainEqual({ event: 'key_validate_unreachable', fields: expect.objectContaining({ provider, message: LEAKY_NETWORK_ERROR }) });
  });

  it('a malformed operator-set base URL is never sent back', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'http//10.0.0.7:8443/internal-v1');
    const r = await validate('openai', { 'X-OpenAI-Key': 'sk-openai-user' });
    expect(r.body).toEqual({ provider: 'openai', status: 'unavailable', valid: false, message: 'Could not reach OpenAI right now.' });
    expect(r.text).not.toMatch(/10\.0\.0\.7|internal|parse/i);
  });

  it.each([
    ['nvidia', { 'X-Nvidia-Key': 'nvapi-user' }],
    ['gemini', { 'X-Gemini-Key': 'AIza-user' }],
    ['openai', { 'X-OpenAI-Key': 'sk-openai-user' }],
    ['openrouter', { 'X-OpenRouter-Key': 'sk-or-user' }]
  ])('%s: an upstream 503 is not a verdict on the key (unavailable, not invalid)', async (provider, headers) => {
    upstreamMode = 503;
    const r = await validate(provider, headers);
    expect(r.body).toMatchObject({ provider, status: 'unavailable', valid: false });
  });

  it.each([
    ['nvidia', { 'X-Nvidia-Key': 'nvapi-user' }],
    ['gemini', { 'X-Gemini-Key': 'AIza-user' }],
    ['openai', { 'X-OpenAI-Key': 'sk-openai-user' }],
    ['openrouter', { 'X-OpenRouter-Key': 'sk-or-user' }]
  ])('%s: an upstream 401 is a verdict (invalid)', async (provider, headers) => {
    upstreamMode = 401;
    const r = await validate(provider, headers);
    expect(r.body).toMatchObject({ provider, status: 'invalid', valid: false });
    expect(r.text).not.toMatch(/upstream/);
  });

  it.each([['<script>alert(1)</script>'], [{ a: 1 }], ['']])('unknown provider %j → 400 "Unknown provider." without echoing it', async (provider) => {
    const r = await validate(provider);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: { message: 'Unknown provider.' } });
    expect(r.text).not.toMatch(/script|object/i);
    expect(upstream).toEqual([]);
  });
});
