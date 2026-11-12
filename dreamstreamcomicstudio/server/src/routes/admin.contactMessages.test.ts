// @vitest-environment node
// GET /api/admin/contact-messages and POST /api/admin/contact-messages/:id/handled (CONTACT-1):
// the only readers of Settings › Contact messages. Admin-only through requireAdmin (roles, never an
// address literal); a signed-in non-admin gets 403 and the store is never asked.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const access = vi.hoisted(() => ({ isAdmin: false }));
vi.mock('../services/rbac.js', () => ({
  resolveAccessProfile: vi.fn(async () => ({
    isAdmin: access.isAdmin,
    isModerator: access.isAdmin,
    isResearcher: access.isAdmin,
    bootstrapAdmin: false,
    roles: access.isAdmin ? ['admin'] : []
  })),
  isBootstrapAdminEmail: () => false,
  parseAdminEmails: () => [],
  getUserRoles: vi.fn(async () => (access.isAdmin ? ['admin'] : []))
}));

const ROW = {
  id: '6a1f3c2e-9b8d-4c7a-8e6f-5d4c3b2a1908',
  email: 'reply@example.com',
  message: 'The reader skips page 2 on my tablet.',
  created_at: '2026-11-12T09:00:00.000Z',
  handled_at: null
};
const contact = vi.hoisted(() => ({
  listContactMessages: vi.fn(),
  markContactMessageHandled: vi.fn()
}));
vi.mock('../services/contactStore.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/contactStore.js')>()),
  ...contact
}));
const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../observability/auditLog.js', () => audit);

const { adminRouter } = await import('./admin.js');

// Mirrors the production mount in server/src/index.ts (after the global requireAuth):
//   app.use('/api/admin', adminRateLimit, adminRouter)
let signedIn = true;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (signedIn) req.user = { id: 'admin-or-not', email: 'someone@example.com' };
  next();
});
app.use('/api/admin', adminRouter);

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
  contact.listContactMessages.mockReset();
  contact.markContactMessageHandled.mockReset();
  contact.listContactMessages.mockResolvedValue({ ok: true, items: [ROW] });
  contact.markContactMessageHandled.mockResolvedValue({ ok: true, handledAt: '2026-11-12T10:00:00.000Z' });
  audit.recordAudit.mockClear();
});

describe('GET /api/admin/contact-messages', () => {
  it('403 for a signed-in non-admin; the store is never read', async () => {
    const res = await fetch(`${base}/api/admin/contact-messages`);
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).not.toContain(ROW.email);
    expect(contact.listContactMessages).not.toHaveBeenCalled();
  });

  it('403 when nobody is signed in', async () => {
    signedIn = false;
    const res = await fetch(`${base}/api/admin/contact-messages`);
    expect(res.status).toBe(403);
    expect(contact.listContactMessages).not.toHaveBeenCalled();
  });

  it('serves admins the newest page, uncached, passing limit and cursor through', async () => {
    access.isAdmin = true;
    contact.listContactMessages.mockResolvedValue({ ok: true, items: [ROW], nextCursor: '50' });
    const res = await fetch(`${base}/api/admin/contact-messages?cursor=50&limit=50`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.json()).toEqual({ items: [ROW], nextCursor: '50', storageEnabled: true });
    expect(contact.listContactMessages).toHaveBeenCalledWith({ limit: '50', cursor: '50' });
  });

  it('says storage is off (empty, 200) before the SQL or the service role exist', async () => {
    access.isAdmin = true;
    contact.listContactMessages.mockResolvedValue({ ok: false, reason: 'unavailable' });
    const res = await fetch(`${base}/api/admin/contact-messages`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], storageEnabled: false });
  });

  it('503 with a calm, actionable message when the read fails', async () => {
    access.isAdmin = true;
    contact.listContactMessages.mockResolvedValue({ ok: false, reason: 'failed' });
    const res = await fetch(`${base}/api/admin/contact-messages`);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe('CONTACT_UNAVAILABLE');
    expect(body.error.message).toMatch(/contact_messages\.sql/);
  });
});

describe('POST /api/admin/contact-messages/:id/handled', () => {
  const mark = (id: string) => fetch(`${base}/api/admin/contact-messages/${id}/handled`, { method: 'POST' });

  it('403 for a non-admin; nothing changes', async () => {
    const res = await mark(ROW.id);
    expect(res.status).toBe(403);
    expect(contact.markContactMessageHandled).not.toHaveBeenCalled();
    expect(audit.recordAudit).not.toHaveBeenCalled();
  });

  it('marks it for an admin and audits who did', async () => {
    access.isAdmin = true;
    const res = await mark(ROW.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: ROW.id, handledAt: '2026-11-12T10:00:00.000Z' });
    expect(contact.markContactMessageHandled).toHaveBeenCalledWith(ROW.id);
    expect(audit.recordAudit).toHaveBeenCalledWith({
      actorId: 'admin-or-not',
      action: 'contact_message.handled',
      targetType: 'contact_message',
      targetId: ROW.id
    });
  });

  it('400 for an id that is not a uuid, before the store', async () => {
    access.isAdmin = true;
    const res = await mark('not-a-uuid');
    expect(res.status).toBe(400);
    expect(contact.markContactMessageHandled).not.toHaveBeenCalled();
  });

  it('404 for an unknown id, 503 when the store fails', async () => {
    access.isAdmin = true;
    contact.markContactMessageHandled.mockResolvedValueOnce({ ok: false, reason: 'not_found' });
    expect((await mark(ROW.id)).status).toBe(404);
    contact.markContactMessageHandled.mockResolvedValueOnce({ ok: false, reason: 'failed' });
    expect((await mark(ROW.id)).status).toBe(503);
    expect(audit.recordAudit).not.toHaveBeenCalled();
  });
});
