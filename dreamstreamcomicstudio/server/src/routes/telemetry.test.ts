// @vitest-environment node
// abuse-ops-3 (route side): a signed-out batch is cut to 20 events (signed-in: 50), and the
// telemetry limiter — mounted after optionalAuth in index.ts — refuses past 30 a minute per
// IPv4 address / IPv6 /64, for /events and /feedback alike.
import express from 'express';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ batches: [] as { n: number; userId: string | null }[] }));
vi.mock('../services/telemetryStore.js', () => ({
  recordTelemetryEvents: vi.fn(async (events: unknown[], ctx: { userId: string | null }) => {
    store.batches.push({ n: events.length, userId: ctx.userId });
    return { accepted: events.length, persisted: true };
  }),
  recordFeedback: vi.fn(async () => ({ persisted: true }))
}));

import { telemetryRouter } from './telemetry.js';
import { createRateLimit } from '../middleware/rateLimit.js';

let base = '';
let close: () => void = () => undefined;

beforeAll(async () => {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  // Stand-in for optionalAuth: a bearer "u1" is a signed-in user.
  app.use((req, _res, next) => {
    if (req.header('authorization') === 'Bearer u1') (req as unknown as { user: { id: string } }).user = { id: 'u1' };
    next();
  });
  app.use('/api/telemetry', createRateLimit({ scope: 'telemetry', windowMs: 60_000, maxRequests: 30 }), telemetryRouter);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterAll(() => close());
beforeEach(() => {
  store.batches.length = 0;
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/telemetry${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const events = (n: number) => ({ events: Array.from({ length: n }, () => ({ eventType: 'x', severity: 'error' })) });

describe('POST /api/telemetry/events', () => {
  it('takes 20 events from a signed-out sender and 50 from a signed-in one', async () => {
    await post('/events', events(100), { 'x-forwarded-for': '198.51.100.1' });
    await post('/events', events(100), { 'x-forwarded-for': '198.51.100.1', authorization: 'Bearer u1' });
    expect(store.batches).toEqual([
      { n: 20, userId: null },
      { n: 50, userId: 'u1' }
    ]);
  });

  it('30 requests a minute per IPv6 /64, shared by /events and /feedback', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 32; i++) {
      const ip = `2001:db8:77:1::${(i + 1).toString(16)}`;
      statuses.push((await (i % 2 ? post('/feedback', { vote: 'like' }, { 'x-forwarded-for': ip }) : post('/events', events(1), { 'x-forwarded-for': ip }))).status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(30)).toEqual([429, 429]);
    // Another network is unaffected.
    expect((await post('/events', events(1), { 'x-forwarded-for': '2001:db8:77:2::1' })).status).toBe(200);
  });
});
