// @vitest-environment node
// POST /api/keys/validate only ever checks a key the CALLER owns (its provider header or the
// signed-in user's account key) — never the platform env key attachKeys falls back to — and
// answers with { provider, status, valid, message } only. Before BK-0 the route sat in front of
// requireAuth and, called with no key header, validated the PLATFORM OpenRouter key and returned
// its live /key record (usage, limits) to anyone.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The real requireAuth runs; only the token lookup is faked (no Supabase round trip).
vi.mock('../services/supabase.js', () => ({
  supabase: {
    auth: {
      getUser: vi.fn(async (token: string) =>
        token === 'good-token'
          ? { data: { user: { id: 'user-1', email: 'u1@example.com' } }, error: null }
          : { data: { user: null }, error: { message: 'bad token' } }
      )
    }
  }
}));

const { attachKeys } = await import('../middleware/keys.js');
const { requireAuth } = await import('../middleware/auth.js');
const { keysRouter } = await import('./keys.js');

const PLATFORM = {
  OPENROUTER_API_KEY: 'sk-or-PLATFORM-secret',
  NVIDIA_API_KEY: 'nvapi-PLATFORM-secret',
  GEMINI_API_KEY: 'AIza-PLATFORM-secret',
  PIXAZO_API_KEY: 'pix-PLATFORM-secret',
  OPENAI_API_KEY: 'sk-PLATFORM-openai'
};

// What OpenRouter's GET /key returns for a good key: the account record that must never leave.
const OPENROUTER_KEY_RECORD = { data: { label: 'sk-or-v1-abc…', usage: 12.34, limit: 50, limit_remaining: 37.66, is_free_tier: false } };

type Upstream = { url: string; headers: Record<string, string>; body?: unknown };
const upstream: Upstream[] = [];

const realFetch = globalThis.fetch;
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (/^http:\/\/127\.0\.0\.1:/.test(url)) return realFetch(input, init);
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
  upstream.push({ url, headers, body: init?.body });
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/key')) return json(OPENROUTER_KEY_RECORD);
  if (url.includes('/v1beta/models')) return json({ models: [{ name: 'models/x' }] });
  if (url.endsWith('/models')) return json({ data: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
  return new Response('not found', { status: 404 });
}) as typeof fetch;

// Stand-in for attachAccountKeys: the signed-in user's stored account key fills a provider the
// request carried no header for, flagged BYOK — exactly what the real middleware does.
const account: { openrouter?: string } = {};
const fakeAccountKeys: express.RequestHandler = (req, _res, next) => {
  const k = req.apiKeys!;
  if (account.openrouter && !k.openRouterByok) {
    k.openRouterKey = account.openrouter;
    k.openRouterByok = true;
    k.providerKeys = { ...k.providerKeys, openrouter: { key: account.openrouter, byok: true } };
  }
  next();
};

// The production chain from server/src/index.ts: attachKeys → requireAuth → account keys → /api/keys.
const app = express();
app.use(express.json());
app.use(attachKeys);
app.use('/api', requireAuth);
app.use('/api', fakeAccountKeys);
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
  delete account.openrouter;
  vi.stubGlobal('fetch', fakeFetch);
  for (const [k, v] of Object.entries(PLATFORM)) vi.stubEnv(k, v);
});

const validate = async (provider: string, headers: Record<string, string> = {}, auth = true) => {
  const res = await fetch(`${base}/api/keys/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer good-token' } : {}), ...headers },
    body: JSON.stringify({ provider })
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

const ALLOWED_FIELDS = ['message', 'provider', 'status', 'valid'];
const LEAKY = /usage|limit|credit|detail|PLATFORM/i;

describe('POST /api/keys/validate never touches the platform key', () => {
  it.each(['openrouter', 'nvidia', 'gemini', 'openai'])(
    'signed in, no key header, platform %s key set → missing, and no upstream call',
    async (provider) => {
      const r = await validate(provider);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ provider, status: 'missing', valid: false, message: 'No key provided to validate.' });
      expect(upstream).toEqual([]);
    }
  );

  it('pixazo with only the platform key set → missing (not "Stored")', async () => {
    const r = await validate('pixazo');
    expect(r.body).toMatchObject({ provider: 'pixazo', status: 'missing', valid: false });
    expect(upstream).toEqual([]);
  });

  it('a platform-key probe returns only the allowed fields — no usage, limits or detail', async () => {
    for (const provider of ['openrouter', 'nvidia', 'gemini']) {
      const r = await validate(provider);
      expect(Object.keys(r.body).sort()).toEqual(ALLOWED_FIELDS);
      expect(JSON.stringify(r.body)).not.toMatch(LEAKY);
    }
    expect(upstream).toEqual([]);
  });
});

describe('signed-out callers', () => {
  it('get 401 before anything is validated, even with a key header', async () => {
    for (const provider of ['openrouter', 'nvidia', 'gemini']) {
      const r = await validate(provider, { 'X-OpenRouter-Key': 'sk-or-mine', 'X-Nvidia-Key': 'nvapi-mine', 'X-Gemini-Key': 'AIza-mine' }, false);
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
  it('OpenRouter header key: checked with THAT key, answered with the allowed fields only', async () => {
    const r = await validate('openrouter', { 'X-OpenRouter-Key': 'sk-or-mine' });
    expect(r.body).toEqual({ provider: 'openrouter', status: 'valid', valid: true, message: 'Valid OpenRouter key.' });
    expect(Object.keys(r.body).sort()).toEqual(ALLOWED_FIELDS);
    expect(JSON.stringify(r.body)).not.toMatch(LEAKY);
    expect(upstream).toHaveLength(1);
    expect(upstream[0].url).toMatch(/\/key$/);
    expect(upstream[0].headers.authorization).toBe('Bearer sk-or-mine');
  });

  it('NVIDIA header key: model count stays in the message, no detail object', async () => {
    const r = await validate('nvidia', { 'X-Nvidia-Key': 'nvapi-mine' });
    expect(r.body).toEqual({ provider: 'nvidia', status: 'valid', valid: true, message: 'Valid — 3 models reachable.' });
    expect(upstream.map((u) => u.headers.authorization)).toEqual(['Bearer nvapi-mine']);
  });

  it('direct provider header key: allowed fields only, checked with the caller key', async () => {
    const r = await validate('openai', { 'X-OpenAI-Key': 'sk-mine-openai' });
    expect(Object.keys(r.body).sort()).toEqual(ALLOWED_FIELDS);
    expect(r.body).toMatchObject({ provider: 'openai', status: 'valid', valid: true });
    expect(upstream.map((u) => u.headers.authorization)).toEqual(['Bearer sk-mine-openai']);
  });

  it('signed-in user’s account key (no header) is checked — the platform key is not', async () => {
    account.openrouter = 'sk-or-ACCOUNT';
    const r = await validate('openrouter');
    expect(r.body).toEqual({ provider: 'openrouter', status: 'valid', valid: true, message: 'Valid OpenRouter key.' });
    expect(upstream.map((u) => u.headers.authorization)).toEqual(['Bearer sk-or-ACCOUNT']);
  });

  it('Gemini key goes upstream in the x-goog-api-key header, never in the URL or a body', async () => {
    const r = await validate('gemini', { 'X-Gemini-Key': 'AIza-mine-secret' });
    expect(r.body).toEqual({ provider: 'gemini', status: 'valid', valid: true, message: 'Valid Gemini key.' });
    expect(upstream).toHaveLength(1);
    expect(upstream[0].headers['x-goog-api-key']).toBe('AIza-mine-secret');
    expect(upstream[0].url).not.toContain('AIza-mine-secret');
    expect(upstream[0].url).not.toMatch(/[?&]key=/);
    expect(upstream[0].body).toBeUndefined();
  });
});
