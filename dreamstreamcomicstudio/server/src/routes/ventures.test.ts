// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

// VENTURES_ENABLED is off by default, so the gate lets admins through; drive that per test.
const access = vi.hoisted(() => ({ isAdmin: true }));
vi.mock('../services/rbac.js', () => ({
  resolveAccessProfile: vi.fn(async () => ({
    isAdmin: access.isAdmin,
    isModerator: access.isAdmin,
    isResearcher: access.isAdmin,
    bootstrapAdmin: false,
    roles: access.isAdmin ? ['admin'] : []
  }))
}));

// Never hit the database: an in-memory venture with one open roadmap checkpoint.
const repo = vi.hoisted(() => ({
  getVenture: vi.fn(async (_userId: string, id: string) => (id === 'v1' ? { id: 'v1', status: 'roadmap_pending' } : null)),
  listOpenCheckpoints: vi.fn(async () => [
    { id: 'cp1', kind: 'roadmap_approval' },
    { id: 'cp2', kind: 'prod_deploy' }
  ]),
  resolveCheckpointRow: vi.fn(async () => true),
  setVentureStatus: vi.fn(async () => true),
  appendEvent: vi.fn(async () => undefined),
  createVenture: vi.fn(async () => ({ id: 'v-new' })),
  listVentures: vi.fn(async () => []),
  getBudget: vi.fn(async () => null),
  upsertBudget: vi.fn(async () => undefined),
  createCheckpoint: vi.fn(async () => undefined),
  listEvents: vi.fn(async () => []),
  recordSpend: vi.fn(async () => undefined)
}));
vi.mock('../ventures/repository.js', () => repo);
vi.mock('../ventures/controlPlane.js', () => ({
  createGoal: vi.fn(async () => ({ id: 'g1' })),
  createGoals: vi.fn(async () => undefined),
  listGoals: vi.fn(async () => []),
  listConnections: vi.fn(async () => [])
}));
const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => undefined), listAudit: vi.fn(async () => []) }));
vi.mock('../observability/auditLog.js', () => audit);

const { venturesRouter } = await import('./ventures.js');
const { BUILD_RETIRED_MESSAGE } = await import('../ventures/tickRunner.js');

// Mirrors the production mount in server/src/index.ts:
//   app.use('/api/ventures', systemRateLimit, venturesRouter)
// behind the global requireAuth (stand-in: always signed in, no model keys resolved).
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = { id: 'user-1', email: 'owner@example.com' };
  next();
});
app.use('/api/ventures', venturesRouter);

let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  access.isAdmin = true;
  for (const fn of [...Object.values(repo), audit.recordAudit]) fn.mockClear();
});

const send = (method: string, path: string, body?: unknown) =>
  fetch(`${base}/api/ventures${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });

describe('PATCH /api/ventures/:id/status', () => {
  it('refuses to resume a venture with 410 VENTURES_BUILD_RETIRED', async () => {
    const res = await send('PATCH', '/v1/status', { status: 'active' });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: { message: BUILD_RETIRED_MESSAGE, code: 'VENTURES_BUILD_RETIRED' } });
    expect(repo.setVentureStatus).not.toHaveBeenCalled();
  });

  it('still pauses (manual) and archives', async () => {
    const paused = await send('PATCH', '/v1/status', { status: 'paused' });
    expect(paused.status).toBe(200);
    expect(repo.setVentureStatus).toHaveBeenLastCalledWith('user-1', 'v1', 'paused', 'manual');
    const archived = await send('PATCH', '/v1/status', { status: 'archived' });
    expect(archived.status).toBe(200);
    expect(repo.setVentureStatus).toHaveBeenLastCalledWith('user-1', 'v1', 'archived', null);
  });

  it('keeps the non-admin gate while VENTURES_ENABLED is off', async () => {
    access.isAdmin = false;
    const res = await send('PATCH', '/v1/status', { status: 'paused' });
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe('VENTURES_DISABLED');
  });
});

describe('POST /api/ventures/:id/approve-roadmap', () => {
  it('approves only the roadmap checkpoints and leaves the venture paused (build_retired)', async () => {
    const res = await send('POST', '/v1/approve-roadmap');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 'paused', pauseReason: 'build_retired', approved: 1 });
    expect(repo.resolveCheckpointRow).toHaveBeenCalledTimes(1);
    expect(repo.resolveCheckpointRow).toHaveBeenCalledWith('user-1', 'cp1', { to: 'approved', resolvedBy: 'user-1' });
    expect(repo.setVentureStatus).toHaveBeenCalledWith('user-1', 'v1', 'paused', 'build_retired');
    expect(repo.setVentureStatus).not.toHaveBeenCalledWith('user-1', 'v1', 'active', expect.anything());
    expect(repo.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'venture.paused', message: expect.stringContaining(BUILD_RETIRED_MESSAGE) })
    );
  });

  it('404s for a venture the caller does not own', async () => {
    const res = await send('POST', '/nope/approve-roadmap');
    expect(res.status).toBe(404);
    expect(repo.setVentureStatus).not.toHaveBeenCalled();
  });
});

describe('POST /api/ventures/intake', () => {
  it('answers 400 NO_MODEL_KEY when the caller has no model key, and creates nothing', async () => {
    const res = await send('POST', '/intake', { idea: 'A habit tracker for night-shift nurses' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('NO_MODEL_KEY');
    expect(repo.createVenture).not.toHaveBeenCalled();
  });

  it('requires an idea', async () => {
    const res = await send('POST', '/intake', {});
    expect(res.status).toBe(400);
  });
});
