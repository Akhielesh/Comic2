// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './index';
import { detectAgent } from './agent-gate';
import { onRequest } from '../../functions/_middleware';

const HUMAN = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const env = { BACKEND_ORIGIN: 'https://backend.example' };

function call(path: string, init: RequestInit & { ua?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.ua !== undefined) headers.set('user-agent', init.ua);
  const waits: Promise<unknown>[] = [];
  const res = worker.fetch(new Request(`https://dreamstreamstudio.ai${path}`, { ...init, headers }), env, { waitUntil: (p) => waits.push(p) });
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
