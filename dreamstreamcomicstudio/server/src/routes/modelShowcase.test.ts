// @vitest-environment node
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ModelShowcaseResponse } from '../../../shared/modelShowcase.js';
import { createModelShowcaseRouter } from './modelShowcase.js';

const body: ModelShowcaseResponse = {
  generatedAt: '2026-11-13T00:00:00Z', windowDays: 30, windowStart: '2026-10-14T00:00:00Z', scope: 'platform',
  sourceStatus: { samples: 'ready', metrics: 'ready', ownSamples: 'not_requested' }, rows: []
};
const load = vi.fn(async (_userId?: string) => body);
const app = express();
app.use((req, _res, next) => { if (req.header('x-test-auth') === 'valid') req.user = { id: 'verified-owner' }; next(); });
app.use('/api/models/showcase', createModelShowcaseRouter(load));
let server: http.Server;
let base: string;
beforeAll(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('Models showcase route', () => {
  it('uses only verified request identity, never query parameters, and prevents shared caching', async () => {
    const guest = await fetch(`${base}/api/models/showcase?userId=victim`);
    expect(guest.status).toBe(200);
    expect(load).toHaveBeenLastCalledWith(undefined);
    expect(guest.headers.get('cache-control')).toBe('no-store');
    const own = await fetch(`${base}/api/models/showcase?userId=victim`, { headers: { 'x-test-auth': 'valid' } });
    expect(own.status).toBe(200);
    expect(load).toHaveBeenLastCalledWith('verified-owner');
    expect(own.headers.get('cache-control')).toBe('private, no-store');
    expect(own.headers.get('vary')).toBe('Authorization');
  });

  it('rejects writes without invoking any data or generation work', async () => {
    const before = load.mock.calls.length;
    const response = await fetch(`${base}/api/models/showcase`, { method: 'POST', body: '{}' });
    expect(response.status).toBe(405);
    expect(load.mock.calls).toHaveLength(before);
  });
});
