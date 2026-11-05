// @vitest-environment node
// N8: the IP a pinned request connects to is the IP its lookup checked (DNS rebinding between
// the check and the connect is closed). The lookup hook is tested directly with fake
// resolutions; the transport against a loopback server (allowed only through a permissive
// lookup, so the real refusal path is exercised too).
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSafeLookup, isPrivateAddress, pinnedFetch, requestWithLookup, type ResolvedAddress } from './safeNet.js';

const lookupOnce = (
  resolve: (h: string) => Promise<ResolvedAddress[]>,
  options: Record<string, unknown>
): Promise<{ err: NodeJS.ErrnoException | null; address: unknown; family?: number }> =>
  new Promise((done) => {
    createSafeLookup(resolve)('host.test', options as never, (err, address, family) => done({ err, address, family }));
  });

const fixed = (...addrs: ResolvedAddress[]) => async () => addrs;

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
    '224.0.0.1', '255.255.255.255', '198.18.0.1', '192.0.2.5',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:a9fe:a9fe', '::127.0.0.1',
    '64:ff9b::7f00:1', '64:ff9b::10.0.0.1', '2002:7f00:1::1', '2002:c0a8:0101::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2',
    '[::1]', 'not-an-ip', ''
  ])('%s is unsafe', (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::8.8.8.8', '2002:0808:0808::1'])(
    '%s is public',
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    }
  );
});

describe('createSafeLookup (the connect-time pin)', () => {
  it('passes a public v4 answer through, single-address form', async () => {
    const r = await lookupOnce(fixed({ address: '93.184.216.34', family: 4 }), {});
    expect(r.err).toBeNull();
    expect(r.address).toBe('93.184.216.34');
    expect(r.family).toBe(4);
  });

  it('passes every public address in the all:true form (autoSelectFamily)', async () => {
    const r = await lookupOnce(fixed({ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }), { all: true });
    expect(r.err).toBeNull();
    expect(r.address).toEqual([
      { address: '93.184.216.34', family: 4 },
      { address: '2606:2800:220:1::1', family: 6 }
    ]);
  });

  it('refuses when ANY answer is private (a rebinding answer mixed with a public one)', async () => {
    const r = await lookupOnce(fixed({ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }), { all: true });
    expect(r.err?.code).toBe('EUNSAFEADDR');
  });

  it.each([
    [{ address: '169.254.169.254', family: 4 }],
    [{ address: '::1', family: 6 }],
    [{ address: 'fd00::5', family: 6 }],
    [{ address: 'fe80::1', family: 6 }],
    [{ address: '::ffff:127.0.0.1', family: 6 }],
    [{ address: '::ffff:7f00:1', family: 6 }],
    [{ address: '::ffff:192.168.0.10', family: 6 }]
  ])('refuses %j (v4, v6 and mapped forms)', async (addr) => {
    const r = await lookupOnce(fixed(addr), {});
    expect(r.err?.code).toBe('EUNSAFEADDR');
    expect(r.err?.message).toMatch(/private\/internal/);
  });

  it('honours a family filter and reports ENOTFOUND for no answers', async () => {
    const v6only = await lookupOnce(fixed({ address: '93.184.216.34', family: 4 }, { address: '2606:2800:220:1::1', family: 6 }), { family: 6 });
    expect(v6only.address).toBe('2606:2800:220:1::1');
    const none = await lookupOnce(fixed(), {});
    expect(none.err?.code).toBe('ENOTFOUND');
  });

  it('passes resolver errors through', async () => {
    const r = await lookupOnce(async () => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND host.test'), { code: 'ENOTFOUND' });
    }, {});
    expect(r.err?.code).toBe('ENOTFOUND');
  });
});

describe('pinned transport', () => {
  let server: http.Server;
  let port = 0;
  // The test's own loopback server is reachable only through a hook that skips the policy
  // (the lookup plumbing — both call shapes — is still the real one Node uses).
  const allowLoopback = ((_hostname: string, options: unknown, cb?: (...a: unknown[]) => void) => {
    const done = (typeof options === 'function' ? options : cb) as (...a: unknown[]) => void;
    const all = typeof options === 'object' && options !== null && (options as { all?: boolean }).all;
    if (all) done(null, [{ address: '127.0.0.1', family: 4 }]);
    else done(null, '127.0.0.1', 4);
  }) as unknown as ReturnType<typeof createSafeLookup>;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/gzip') {
        res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(Buffer.from('<p>hello gzip</p>')));
      } else if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://127.0.0.1/' });
        res.end();
      } else if (req.url === '/slow') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.write('first');
        // never ends: the caller's abort must end the body read
      } else if (req.url === '/echo' && req.method === 'POST') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json', 'x-seen': String(req.headers['x-test'] || '') });
          res.end(body);
        });
      } else {
        res.writeHead(204);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('decodes gzip and hands back a web Response', async () => {
    const res = await requestWithLookup(`http://pinned.test:${port}/gzip`, {}, allowLoopback);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toBe('<p>hello gzip</p>');
  });

  it('returns a redirect as-is (never follows it)', async () => {
    const res = await requestWithLookup(`http://pinned.test:${port}/redirect`, {}, allowLoopback);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('http://127.0.0.1/');
  });

  it('sends a POST body and headers (the MCP JSON-RPC shape)', async () => {
    const res = await requestWithLookup(`http://pinned.test:${port}/echo`, { method: 'POST', headers: { 'x-test': 'yes' }, body: '{"a":1}' }, allowLoopback);
    expect(res.headers.get('x-seen')).toBe('yes');
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('an abort ends a body that never finishes', async () => {
    const controller = new AbortController();
    const res = await requestWithLookup(`http://pinned.test:${port}/slow`, { signal: controller.signal }, allowLoopback);
    const reader = res.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('first');
    setTimeout(() => controller.abort(), 20);
    await expect(reader.read()).rejects.toBeTruthy();
  });

  it('the real hook refuses a name that resolves to loopback (nothing is sent)', async () => {
    let hits = 0;
    server.on('request', () => (hits += 1));
    const before = hits;
    await expect(pinnedFetch(`http://localhost:${port}/gzip`)).rejects.toThrow(/private\/internal/);
    expect(hits).toBe(before);
  });

  it('refuses a private IP literal up front (no lookup runs for literals)', async () => {
    await expect(pinnedFetch(`http://127.0.0.1:${port}/gzip`)).rejects.toThrow(/private\/internal/);
    await expect(pinnedFetch(`http://[::1]:${port}/gzip`)).rejects.toThrow(/private\/internal/);
  });
});
