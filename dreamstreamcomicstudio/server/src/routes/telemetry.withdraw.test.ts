// @vitest-environment node
// POST /api/telemetry/feedback/withdraw: a reply rating's Undo. Signed-in only; the store decides what may go.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const store = vi.hoisted(() => ({ withdrawFeedback: vi.fn() }));
vi.mock('../services/telemetryStore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/telemetryStore.js')>()),
  withdrawFeedback: store.withdrawFeedback
}));

import { telemetryRouter } from './telemetry.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const user = req.header('x-test-user');
    if (user) req.user = { id: user } as typeof req.user;
    next();
  });
  app.use('/api/telemetry', telemetryRouter);
  server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => store.withdrawFeedback.mockReset().mockResolvedValue({ withdrawn: true }));

const withdraw = (body: unknown, user?: string) =>
  fetch(`${base}/api/telemetry/feedback/withdraw`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user ? { 'x-test-user': user } : {}) },
    body: JSON.stringify(body)
  });

describe('POST /api/telemetry/feedback/withdraw', () => {
  it('a signed-in person takes back their own rating: the store is asked with who they are', async () => {
    const res = await withdraw({ targetType: 'comic_reply', targetId: 'msg_42' }, 'user-1');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: true, withdrawn: true });
    expect(store.withdrawFeedback).toHaveBeenCalledWith({ targetType: 'comic_reply', targetId: 'msg_42' }, expect.objectContaining({ userId: 'user-1' }));
  });

  it('nobody signed in: 401, nothing is removed', async () => {
    const res = await withdraw({ targetType: 'comic_reply', targetId: 'msg_42' });
    expect(res.status).toBe(401);
    expect(store.withdrawFeedback).not.toHaveBeenCalled();
  });

  it('reports a failed removal honestly', async () => {
    store.withdrawFeedback.mockResolvedValue({ withdrawn: false });
    expect(await (await withdraw({ targetType: 'comic_reply', targetId: 'msg_42' }, 'user-1')).json()).toEqual({ ok: true, withdrawn: false });
  });
});
