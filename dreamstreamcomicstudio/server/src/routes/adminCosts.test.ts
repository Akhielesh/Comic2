// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// The admin gate resolves roles through rbac; drive it per test without touching Supabase.
const access = vi.hoisted(() => ({ isAdmin: false }));
vi.mock('../services/rbac.js', () => ({
  resolveAccessProfile: vi.fn(async () => ({
    isAdmin: access.isAdmin,
    isModerator: access.isAdmin,
    isResearcher: access.isAdmin,
    bootstrapAdmin: false,
    roles: access.isAdmin ? ['admin'] : []
  }))
}));

// Never hit the database: the report itself is covered by costCentre.test.ts.
const getReport = vi.hoisted(() => vi.fn(async (days: number) => ({ range: { days }, totals: {}, notes: [] })));
vi.mock('../services/costCentre.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/costCentre.js')>()),
  getCostCentreReport: getReport
}));

const { requireAdmin } = await import('../middleware/requireAdmin.js');
const { adminCostsRouter } = await import('./adminCosts.js');

// Mirrors the production mount in server/src/index.ts:
//   app.use('/api/admin/costs', requireAdmin, adminCostsRouter)
// with a stand-in for requireAuth that signs the caller in (or not).
let signedIn = true;
const app = express();
app.use((req, _res, next) => {
  if (signedIn) req.user = { id: 'user-1', email: 'someone@example.com' };
  next();
});
app.use('/api/admin/costs', requireAdmin, adminCostsRouter);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  signedIn = true;
  access.isAdmin = false;
  getReport.mockClear();
});

describe('GET /api/admin/costs', () => {
  it('rejects signed-in non-admins with 403 and never builds the report', async () => {
    const res = await fetch(`${base}/api/admin/costs?days=7`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { message: 'Admin access required' } });
    expect(getReport).not.toHaveBeenCalled();
  });

  it('rejects anonymous callers with 403', async () => {
    signedIn = false;
    const res = await fetch(`${base}/api/admin/costs`);
    expect(res.status).toBe(403);
    expect(getReport).not.toHaveBeenCalled();
  });

  it('serves admins, defaulting an invalid range to 30 days', async () => {
    access.isAdmin = true;
    const ok = await fetch(`${base}/api/admin/costs?days=7&fresh=1`);
    expect(ok.status).toBe(200);
    expect(getReport).toHaveBeenLastCalledWith(7, { fresh: true });
    expect(ok.headers.get('cache-control')).toContain('no-store');

    await fetch(`${base}/api/admin/costs?days=365`);
    expect(getReport).toHaveBeenLastCalledWith(30, { fresh: false });
  });
});
