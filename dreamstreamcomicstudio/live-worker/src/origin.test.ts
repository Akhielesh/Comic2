// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-ignore -- the Worker's own config as text (Vite's ?raw); the Workers tsconfig has no module type for it.
import wranglerSource from '../wrangler.jsonc?raw';
import { clientKey, corsHeaders, ipv6Prefix64, LIMIT_PERIOD_S, originAllowed, refuseRateLimited, withinLimit, type RateLimiterLike } from './origin';

/** JSONC without its comments (a `//` inside a string, like a URL, stays). */
function parseJsonc(src: string): Record<string, unknown> {
  let out = '';
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === '\\') out += src[++i];
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
}

describe('wrangler.jsonc (the repo is public)', () => {
  const cfg = parseJsonc(wranglerSource as string);

  it('binds the ADR 0006 rate limits, each with its own namespace and the period origin.ts promises', () => {
    const rl = cfg.ratelimits as { name: string; namespace_id: string; simple: { limit: number; period: number } }[];
    const by = Object.fromEntries(rl.map((r) => [r.name, r.simple]));
    expect(by).toEqual({
      RL_WS: { limit: 60, period: 60 },
      RL_GUEST: { limit: 10, period: 60 },
      RL_GUEST_NID: { limit: 30, period: 60 },
      RL_EVENT: { limit: 10, period: 60 },
    });
    expect(new Set(rl.map((r) => r.namespace_id)).size).toBe(rl.length);
    for (const r of rl) expect(r.simple.period).toBe(LIMIT_PERIOD_S);
  });

  it('holds no secret: only public values in vars, and nothing that looks like a key', () => {
    const vars = cfg.vars as Record<string, string>;
    expect(Object.keys(vars).sort()).toEqual(['ALLOWED_ORIGINS', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_URL']);
    expect(vars.SUPABASE_PUBLISHABLE_KEY).toMatch(/^sb_publishable_/);
    const text = JSON.stringify(cfg);
    for (const pattern of [/"d"\s*:/, /BEGIN [A-Z ]*PRIVATE KEY/, /sb_secret_/, /service_role/, /"(DEVICE_TOKEN_JWK|ACT_TOKEN_KEY|SECURITY_HOOK_SECRET|OPS_KEY|TURN_KEY_API_TOKEN|APNS_KEY_P8|FCM_SA_JSON)"/]) {
      expect(text, String(pattern)).not.toMatch(pattern);
    }
  });

  it('every origin the API serves is https (or is the API itself)', () => {
    for (const o of String((cfg.vars as Record<string, string>).ALLOWED_ORIGINS).split(',')) expect(o.trim()).toMatch(/^https:\/\/[a-z0-9.-]+$/);
  });
});

const PROD = 'https://dreamstreamstudio.ai,https://stream.dreamstreamstudio.ai,https://comic2.pages.dev';
const env = { ALLOWED_ORIGINS: PROD };
const api = new URL('https://stream.dreamstreamstudio.ai/live-api/api/monitor/x/ws');

describe('WebSocket Origin allowlist', () => {
  it('lets our sites, the API’s own origin (React Native) and native code without an Origin in', () => {
    for (const o of ['https://dreamstreamstudio.ai', 'https://stream.dreamstreamstudio.ai', 'https://comic2.pages.dev', null, '']) {
      expect(originAllowed(o, api, env), String(o)).toBe(true);
    }
    // RN sends the socket URL's own origin; on workers.dev that's the Worker's host.
    const dev = new URL('https://dreamstream-live.example.workers.dev/api/calls/u/x/ws');
    expect(originAllowed('https://dreamstream-live.example.workers.dev', dev, env)).toBe(true);
  });

  it('refuses another site, a sandboxed frame’s null, look-alikes and unlisted preview hosts', () => {
    for (const o of [
      'https://evil.example',
      'null',
      'https://dreamstreamstudio.ai.evil.example',
      'http://dreamstreamstudio.ai', // wrong scheme
      'https://dreamstreamstudio.ai:8443', // wrong port
      'https://abc123.comic2.pages.dev', // a preview build nobody listed
      'https://stream.dreamstreamstudio.ai/live', // an Origin never has a path
      'file://',
    ]) {
      expect(originAllowed(o, api, env), o).toBe(false);
    }
  });

  it('localhost pages only while the Worker itself runs on localhost (wrangler dev)', () => {
    const local = new URL('http://localhost:8788/api/monitor/x/ws');
    expect(originAllowed('http://localhost:7000', local, env)).toBe(true);
    expect(originAllowed('http://127.0.0.1:5173', new URL('http://127.0.0.1:8788/x'), env)).toBe(true);
    expect(originAllowed('http://localhost:7000', api, env)).toBe(false);
  });

  it('a "*" allowlist (tests, local) allows everything', () => {
    expect(originAllowed('https://anything.example', api, { ALLOWED_ORIGINS: '*' })).toBe(true);
  });
});

describe('CORS for listed sites', () => {
  it('adds DELETE (device revoke) and If-None-Match (glance), exposes ETag — and nothing for strangers', () => {
    const ok = corsHeaders(new Request('https://w.example/x', { headers: { Origin: 'https://comic2.pages.dev' } }), env);
    expect(ok['Access-Control-Allow-Origin']).toBe('https://comic2.pages.dev');
    expect(ok['Access-Control-Allow-Methods']).toContain('DELETE');
    expect(ok['Access-Control-Allow-Headers']).toContain('if-none-match');
    expect(ok['Access-Control-Expose-Headers']).toContain('etag');
    // The ops key and device proofs are never sent by a browser: not allowed cross-origin.
    expect(ok['Access-Control-Allow-Headers']).not.toMatch(/x-ops-key|ds-proof/);
    expect(corsHeaders(new Request('https://w.example/x', { headers: { Origin: 'https://evil.example' } }), env)).toEqual({});
    expect(corsHeaders(new Request('https://w.example/x'), env)).toEqual({});
  });
});

describe('client keys for rate limits', () => {
  const req = (ip?: string) => new Request('https://w.example/', { headers: ip ? { 'cf-connecting-ip': ip } : {} });

  it('IPv4 by address, IPv6 by its /64, nothing without an edge address', () => {
    expect(clientKey(req('203.0.113.7'))).toBe('4:203.0.113.7');
    expect(clientKey(req('2001:db8:1:2:aaaa:bbbb:cccc:dddd'))).toBe('6:2001:0db8:0001:0002');
    // Every address in one /64 is one subscriber: same key.
    expect(clientKey(req('2001:db8:1:2::1'))).toBe(clientKey(req('2001:0DB8:0001:0002:ffff::9')));
    expect(clientKey(req('2001:db8:1:3::1'))).not.toBe(clientKey(req('2001:db8:1:2::1')));
    // An IPv4 address written as IPv6 is that IPv4 address (not a /64 every v4 client shares).
    expect(clientKey(req('::ffff:198.51.100.4'))).toBe('4:198.51.100.4');
    expect(clientKey(req())).toBeNull();
  });

  it('expands compressed IPv6 forms correctly', () => {
    expect(ipv6Prefix64('::1')).toBe('0000:0000:0000:0000');
    expect(ipv6Prefix64('fe80::1%eth0')).toBe('fe80:0000:0000:0000');
    expect(ipv6Prefix64('2001:db8::')).toBe('2001:0db8:0000:0000');
    expect(ipv6Prefix64('1:2:3:4:5:6:7:8')).toBe('0001:0002:0003:0004');
    expect(ipv6Prefix64('64:ff9b::192.0.2.33')).toBe('0064:ff9b:0000:0000');
    for (const bad of ['1:2:3:4:5:6:7', '1::2::3', '1:2:3:4:5:6:7:8:9', 'g::1', '1.2.3.4', '1::2:3:4:5:6:7:8']) expect(ipv6Prefix64(bad), bad).toBeNull();
  });
});

describe('rate limits fail open', () => {
  const binding = (success: boolean) => {
    const keys: string[] = [];
    const b: RateLimiterLike = { limit: async ({ key }) => (keys.push(key), { success }) };
    return { b, keys };
  };

  it('asks the binding with an edge: key, and obeys it', async () => {
    const yes = binding(true);
    expect(await withinLimit(yes.b, '4:203.0.113.7')).toBe(true);
    expect(yes.keys).toEqual(['edge:4:203.0.113.7']);
    expect(await withinLimit(binding(false).b, '4:203.0.113.7')).toBe(false);
  });

  it('no binding, no address, or a binding that throws: the request goes through', async () => {
    expect(await withinLimit(undefined, '4:203.0.113.7')).toBe(true);
    const never = binding(false);
    expect(await withinLimit(never.b, null)).toBe(true);
    expect(never.keys).toEqual([]);
    expect(await withinLimit({ limit: async () => Promise.reject(new Error('limiter down')) }, '4:1.2.3.4')).toBe(true);
  });
});

describe('refusals the app can read', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a socket upgrade is accepted, told why, and closed 4008 rate_limited', () => {
    const sent: string[] = [];
    const closed: [number, string][] = [];
    class FakeSocket {
      accept() {}
      send(m: string) {
        sent.push(m);
      }
      close(code: number, reason: string) {
        closed.push([code, reason]);
      }
    }
    vi.stubGlobal(
      'WebSocketPair',
      class {
        0 = new FakeSocket();
        1 = new FakeSocket();
      },
    );
    // Node's Response refuses 101; the Workers runtime allows it for upgrades.
    const Real = Response;
    vi.stubGlobal(
      'Response',
      class extends Real {
        constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
          super(body, init?.status === 101 ? { ...init, status: 200 } : init);
          if (init?.status === 101) Object.defineProperty(this, 'status', { get: () => 101 });
        }
      },
    );
    const res = refuseRateLimited(new Request('https://w.example/ws', { headers: { Upgrade: 'websocket' } }));
    expect(res.status).toBe(101);
    expect(closed).toEqual([[4008, 'rate_limited']]);
    expect(JSON.parse(sent[0])).toMatchObject({ t: 'error', code: 'rate_limited', retryMs: 60_000 });
  });

  it('anything else is a 429 with Retry-After, never cached', async () => {
    const res = refuseRateLimited(new Request('https://w.example/guest', { method: 'POST' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'rate_limited' });
  });
});
