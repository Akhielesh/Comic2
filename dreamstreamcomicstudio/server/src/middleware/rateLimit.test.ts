// @vitest-environment node
// abuse-ops-8: anonymous callers are keyed by IPv4 address or IPv6 /64, so rotating through one
// subscriber's /64 (2^64 addresses) no longer resets the limit; signed-in callers stay per account.
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRateLimit, resolveRequesterKey } from './rateLimit.js';
import { assistantLimits } from './assistantLimits.js';

type Fake = { ip?: string; user?: { id: string } };
const keyOf = (r: Fake) => resolveRequesterKey(r as unknown as express.Request);

describe('resolveRequesterKey', () => {
  it('groups an IPv6 /64, keeps IPv4 per address and signed-in callers per account', () => {
    expect(keyOf({ ip: '2001:db8:5:6::1' })).toBe(keyOf({ ip: '2001:db8:5:6:ffff:1:2:3' }));
    expect(keyOf({ ip: '2001:db8:5:6::1' })).not.toBe(keyOf({ ip: '2001:db8:5:7::1' }));
    expect(keyOf({ ip: '::ffff:203.0.113.9' })).toBe('ip:4:203.0.113.9');
    expect(keyOf({ ip: '203.0.113.9', user: { id: 'u1' } })).toBe('user:u1');
    expect(keyOf({})).toBe('ip:unknown');
  });
});

describe('createRateLimit over HTTP (trust proxy, X-Forwarded-For as the API Worker sets it)', () => {
  let base = '';
  let close: () => void = () => undefined;

  beforeAll(async () => {
    const app = express();
    app.set('trust proxy', true);
    app.get('/limited', createRateLimit({ scope: 'test_v6', windowMs: 60_000, maxRequests: 3 }), (_req, res) => res.json({ ok: true }));
    app.get('/assistant', assistantLimits, (_req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  const hit = (path: string, ip: string) => fetch(`${base}${path}`, { headers: { 'x-forwarded-for': ip } });

  it('two IPv6 addresses in one /64 share a bucket; the next /64 and an IPv4 caller do not', async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 5; i++) statuses.push((await hit('/limited', `2001:db8:aa:bb::${i.toString(16)}`)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    const refused = await hit('/limited', '2001:db8:aa:bb:dead:beef:0:1');
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { details: { keyType: string } } }).error.details.keyType).toBe('ip');
    expect((await hit('/limited', '2001:db8:aa:bc::1')).status).toBe(200);
    expect((await hit('/limited', '203.0.113.50')).status).toBe(200);
  });

  it('the assistant guest allowance (5 an hour) is per /64 as well', async () => {
    const statuses: number[] = [];
    for (let i = 1; i <= 7; i++) statuses.push((await hit('/assistant', `2001:db8:cc:dd::${i}`)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429, 429]);
    expect((await hit('/assistant', '2001:db8:cc:de::1')).status).toBe(200);
  });
});
