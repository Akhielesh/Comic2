// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type BackendNamespace } from './proxy';
import { buildBackendEnv, loadBackendEnv, type EnvDb } from './backendEnv';
import { detectAgent } from './agent-gate';
import { onRequest } from '../../functions/_middleware';

const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const env: Record<string, unknown> = { BACKEND_TARGET: 'origin', BACKEND_ORIGIN: 'https://backend.example' };

function call(path: string, init: RequestInit & { ua?: string } = {}, workerEnv: Record<string, unknown> = env) {
  const headers = new Headers(init.headers);
  if (init.ua !== undefined) headers.set('user-agent', init.ua);
  const waits: Promise<unknown>[] = [];
  const res = worker.fetch(new Request(`https://dreamstreamstudio.ai${path}`, { ...init, headers }), workerEnv, { waitUntil: (p) => waits.push(p) });
  return { res, waits };
}

afterEach(() => vi.unstubAllGlobals());

describe('dreamstream-api agent gate', () => {
  it('turns AI agents away from the API without touching the backend', async () => {
    const backend = vi.fn();
    vi.stubGlobal('fetch', backend);
    const res = await call('/api/projects', { ua: 'Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)' }).res;
    expect(res.status).toBe(403);
    expect((await res.json()).checkin).toBe('https://dreamstreamstudio.ai/api/agent-gate');
    expect(backend).not.toHaveBeenCalled();
  });

  it('still proxies people, scripts and the product’s own /api/agents routes', async () => {
    const backend = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{"status":"ok"}', { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', backend);
    expect((await call('/api/agents/custom-1', { method: 'DELETE', ua: HUMAN }).res).status).toBe(200);
    expect((await call('/api/health', { ua: 'curl/8.5.0' }).res).status).toBe(200);
    expect((await call('/api/health', { ua: 'node' }).res).status).toBe(200);
    expect(backend.mock.calls.map((c) => String(c[0]))).toEqual([
      'https://backend.example/api/agents/custom-1',
      'https://backend.example/api/health',
      'https://backend.example/api/health',
    ]);
  });

  it('serves the check-in page with a canary and escapes request-supplied names', async () => {
    const res = await call('/api/agent-gate?from=/models', { ua: 'Mozilla/5.0', headers: { 'signature-agent': '"<script>x</script>"' } }).res;
    const html = await res.text();
    expect(res.headers.get('x-robots-tag')).toContain('noai');
    expect(html).toContain('dss-canary-');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('returns 50 questions as JSON and keeps only q1–q50 answers', async () => {
    const questions = await (await call('/api/agent-gate/checkin', { ua: 'ClaudeBot/1.0' }).res).json();
    expect(questions.questions).toHaveLength(50);
    expect(questions.sample.notice).toMatch(/SYNTHETIC/);
    const post = await call('/api/agent-gate/checkin', {
      method: 'POST',
      ua: 'ClaudeBot/1.0',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: { q1: 'ClaudeBot', q50: 'done', q51: 'ignored', toString: 'x' } }),
    }).res;
    expect((await post.json()).answered).toBe(2);
  });

  it('only flags automated browsers on pages, never on the API', () => {
    const headless = new Request('https://dreamstreamstudio.ai/', { headers: { 'user-agent': 'Mozilla/5.0 HeadlessChrome/140.0' } });
    expect(detectAgent(headless, 'page')?.kind).toBe('automation');
    expect(detectAgent(headless, 'api')).toBeNull();
    const google = new Request('https://dreamstreamstudio.ai/', { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' } });
    expect(detectAgent(google, 'page')).toBeNull();
  });
});

describe('Pages middleware', () => {
  const next = vi.fn(async () => new Response('app'));
  const run = (path: string, ua: string) => onRequest({ request: new Request(`https://dreamstreamstudio.ai${path}`, { headers: { 'user-agent': ua } }), next });

  it('redirects AI agents to the check-in and leaves everyone else alone', async () => {
    const agent = await run('/models', 'PerplexityBot/1.0');
    expect(agent.status).toBe(302);
    expect(agent.headers.get('location')).toBe('https://dreamstreamstudio.ai/api/agent-gate?from=%2Fmodels');
    expect(await (await run('/models', HUMAN)).text()).toBe('app');
    expect(await (await run('/share/abc', 'Twitterbot/1.0')).text()).toBe('app');
    expect(await (await run('/robots.txt', 'GPTBot/1.2')).text()).toBe('app');
    expect((await run('/agents', HUMAN)).headers.get('location')).toBe('https://dreamstreamstudio.ai/api/agent-gate');
  });
});

function fakeContainer(handler: (req: Request) => Promise<Response>) {
  const seen: { name: unknown; req: Request }[] = [];
  const ns: BackendNamespace = {
    idFromName: (name) => ({ name }),
    get: (id) => ({
      fetch: async (req) => {
        seen.push({ name: (id as { name: unknown }).name, req });
        return handler(req);
      },
    }),
  };
  return { ns, seen };
}

describe('backend routing', () => {
  it('sends API traffic to the single Backend container with the real client IP', async () => {
    const railway = vi.fn();
    vi.stubGlobal('fetch', railway);
    const { ns, seen } = fakeContainer(async (req) => new Response(await req.text(), { status: 201 }));
    const res = await call(
      '/api/projects?x=1',
      { method: 'POST', ua: HUMAN, body: '{"a":1}', headers: { 'cf-connecting-ip': '203.0.113.9', 'content-type': 'application/json' } },
      { BACKEND: ns, BACKEND_ORIGIN: 'https://railway.example' },
    ).res;
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('{"a":1}');
    expect(railway).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe('primary');
    expect(seen[0].req.url).toBe('https://dreamstreamstudio.ai/api/projects?x=1');
    expect(seen[0].req.headers.get('x-forwarded-for')).toBe('203.0.113.9');
    expect(seen[0].req.headers.get('x-forwarded-proto')).toBe('https');
  });

  it('falls back to the external origin only when told to (or when no container is bound)', async () => {
    const railway = vi.fn(async () => new Response('{"status":"ok"}'));
    vi.stubGlobal('fetch', railway);
    const { ns, seen } = fakeContainer(async () => new Response('container'));
    await call('/api/health', { ua: HUMAN }, { BACKEND: ns, BACKEND_TARGET: ' Origin ', BACKEND_ORIGIN: 'https://railway.example/' }).res;
    await call('/api/health', { ua: HUMAN }, { BACKEND_ORIGIN: 'https://railway.example' }).res;
    expect(seen).toHaveLength(0);
    expect(railway.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual(['https://railway.example/api/health', 'https://railway.example/api/health']);
  });

  it('answers with retryable JSON when no backend is reachable', async () => {
    const { ns } = fakeContainer(async () => {
      throw new Error('boom');
    });
    const broken = await call('/api/health', { ua: HUMAN }, { BACKEND: ns }).res;
    expect(broken.status).toBe(502);
    expect(broken.headers.get('retry-after')).toBe('5');
    const none = await call('/api/health', { ua: HUMAN }, {}).res;
    expect(none.status).toBe(503);
    expect((await none.json()).error.message).toMatch(/No backend/);
  });

  it('still keeps AI agents away from the container', async () => {
    const { ns, seen } = fakeContainer(async () => new Response('x'));
    expect((await call('/api/projects', { ua: 'GPTBot/1.2' }, { BACKEND: ns }).res).status).toBe(403);
    expect(seen).toHaveLength(0);
  });
});

describe('backend env', () => {
  it('merges D1 secrets under Worker vars/secrets and drops proxy-only settings and bindings', () => {
    const merged = buildBackendEnv(
      { BACKEND_TARGET: 'container', BACKEND_ORIGIN: 'https://x', CORS_ORIGIN: 'https://a', OPENROUTER_API_KEY: 'worker-secret', BACKEND: {}, AGENT_DB: {} },
      [
        { name: 'OPENROUTER_API_KEY', value: 'd1-value' },
        { name: 'SUPABASE_SERVICE_ROLE_KEY', value: 'svc' },
        { name: 'bad name', value: 'x' },
        { name: 'BACKEND_TARGET', value: 'origin' },
        { name: 'NUMERIC', value: 5 },
      ],
    );
    expect(merged).toEqual({ CORS_ORIGIN: 'https://a', OPENROUTER_API_KEY: 'worker-secret', SUPABASE_SERVICE_ROLE_KEY: 'svc' });
  });

  it('retries a failed D1 read once, then refuses to start half-configured', async () => {
    let calls = 0;
    const flaky: EnvDb = {
      prepare: () => ({
        all: async <T>() => {
          calls++;
          if (calls === 1) throw new Error('transient');
          return { results: [{ name: 'A_KEY', value: '1' }] as T[] };
        },
      }),
    };
    expect(await loadBackendEnv({ PORT: '8080' }, flaky)).toEqual({ A_KEY: '1', PORT: '8080' });
    const down: EnvDb = { prepare: () => ({ all: async () => { throw new Error('down'); } }) };
    await expect(loadBackendEnv({}, down)).rejects.toThrow(/unreadable/);
    expect(await loadBackendEnv({ X: 'y' }, undefined)).toEqual({ X: 'y' });
  });
});
