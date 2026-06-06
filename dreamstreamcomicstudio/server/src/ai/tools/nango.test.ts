import { describe, it, expect, vi, afterEach } from 'vitest';
import { NANGO_TOOLS, nangoEnabled } from './nango.js';

const byName = Object.fromEntries(NANGO_TOOLS.map((t) => [t.name, t]));
const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe('nango tools', () => {
  it('reports "not configured" (with a notice) when no secret key is set', async () => {
    delete process.env.NANGO_SECRET_KEY;
    expect(nangoEnabled()).toBe(false);
    const r = await byName.nango_search_integrations.execute({});
    expect(r.notice?.message).toMatch(/not configured/i);
  });

  it('search lists integrations from GET /integrations and filters by query', async () => {
    process.env.NANGO_SECRET_KEY = 'sk';
    process.env.NANGO_HOST = 'http://nango.test';
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe('http://nango.test/integrations');
      expect(init.headers.Authorization).toBe('Bearer sk');
      return new Response(JSON.stringify({ data: [
        { unique_key: 'slack-x', display_name: 'Slack', provider: 'slack' },
        { unique_key: 'stripe-y', display_name: 'Stripe', provider: 'stripe' },
      ] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await byName.nango_search_integrations.execute({ query: 'sla' });
    expect(r.content).toContain('slack-x');
    expect(r.content).not.toContain('stripe-y');
  });

  it('call_api requires a connection, then builds the proxy URL + headers', async () => {
    process.env.NANGO_SECRET_KEY = 'sk';
    process.env.NANGO_HOST = 'http://nango.test';
    delete process.env.NANGO_DEFAULT_CONNECTION_ID;

    const missing = await byName.nango_call_api.execute({ integration: 'slack-x', path: '/users' });
    expect(missing.content).toMatch(/connect a user|connectionId/i);

    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe('http://nango.test/proxy/users?limit=2');
      expect(init.method).toBe('GET');
      expect(init.headers['Connection-Id']).toBe('conn1');
      expect(init.headers['Provider-Config-Key']).toBe('slack-x');
      return new Response('{"ok":true}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await byName.nango_call_api.execute({ integration: 'slack-x', connectionId: 'conn1', path: 'users', query: { limit: 2 } });
    expect(r.content).toContain('ok');
  });

  it('call_api rejects unsupported methods', async () => {
    process.env.NANGO_SECRET_KEY = 'sk';
    const r = await byName.nango_call_api.execute({ integration: 'x', connectionId: 'c', path: 'p', method: 'TRACE' });
    expect(r.content).toMatch(/unsupported method/i);
  });

  it('connect returns the short-lived session token from POST /connect/sessions', async () => {
    process.env.NANGO_SECRET_KEY = 'sk';
    process.env.NANGO_HOST = 'http://nango.test';
    const fetchMock = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe('http://nango.test/connect/sessions');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body).allowed_integrations).toEqual(['slack-x']);
      return new Response(JSON.stringify({ data: { token: 'tok_123', expires_at: 'soon' } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const r = await byName.nango_connect_integration.execute({ integration: 'slack-x', endUserId: 'u1' });
    expect(r.content).toContain('tok_123');
  });
});
