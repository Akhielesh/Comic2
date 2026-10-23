// @vitest-environment node
// P1-LIMITS route guards:
//   - POST /api/billing/reserve|settle are admin-only (a client must never settle its own spend);
//   - GET/PUT /api/admin/usage/budgets are admin-only, validated and audited.
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
  isBootstrapAdminEmail: (email?: string | null) => email === 'owner@example.com',
  getUserRoles: vi.fn(async () => (access.isAdmin ? ['admin'] : []))
}));

const ledger = vi.hoisted(() => ({
  reserveUsageTokens: vi.fn(async () => ({ allowed: true, reservation: { reservationId: 'r' } })),
  settleReservation: vi.fn(async () => ({ actualCt: 0 }))
}));
vi.mock('../services/billingLedger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/billingLedger.js')>()),
  ...ledger
}));

const budgets = vi.hoisted(() => ({
  listUsageBudgets: vi.fn(async () => [
    { userId: '17933bae-dcc5-49b9-bcf5-9658e3953a84', email: 'tester@example.com', hasRow: true, exempt: false, allowPro: false, budgetUsd: 10, period: 'lifetime', spentUsd: 4, inflightUsd: 0, pctUsed: 40, pctLeft: 60, exhausted: false },
    { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', email: 'owner@example.com', hasRow: false, exempt: false, allowPro: false, budgetUsd: 10, period: 'lifetime', spentUsd: 0, inflightUsd: 0, pctUsed: 0, pctLeft: 100, exhausted: false }
  ]),
  upsertUsageBudget: vi.fn(async (input: { userId: string; patch: Record<string, unknown> }) => ({
    before: null,
    after: { user_id: input.userId, budget_usd: input.patch.budgetUsd ?? 10 }
  }))
}));
vi.mock('../services/platformAllowance.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/platformAllowance.js')>()),
  ...budgets
}));

const audit = vi.hoisted(() => ({ recordAudit: vi.fn(async () => undefined) }));
vi.mock('../observability/auditLog.js', () => audit);

const profiles = vi.hoisted(() => ({ byEmail: new Map<string, string>([['tester@example.com', '17933bae-dcc5-49b9-bcf5-9658e3953a84']]), lastPattern: '' }));
vi.mock('../services/supabase.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/supabase.js')>()),
  getSupabaseAdmin: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        ilike: (_col: string, pattern: string) => {
          profiles.lastPattern = pattern;
          return q;
        },
        maybeSingle: async () => {
          const id = profiles.byEmail.get(profiles.lastPattern.replace(/\\/g, ''));
          return { data: table === 'profiles' && id ? { id } : null, error: null };
        },
        then: (resolve: (v: unknown) => void) => resolve({ data: table === 'user_roles' ? [] : null, error: null })
      };
      return q;
    }
  })
}));

const { billingRouter } = await import('./billing.js');
const { adminRouter } = await import('./admin.js');

let signedIn = true;
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  if (signedIn) req.user = { id: 'caller-1', email: 'someone@example.com' };
  next();
});
app.use('/api/billing', billingRouter);
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
  ledger.reserveUsageTokens.mockClear();
  ledger.settleReservation.mockClear();
  budgets.listUsageBudgets.mockClear();
  budgets.upsertUsageBudget.mockClear();
  audit.recordAudit.mockClear();
});

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = (path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('manual billing reserve/settle (metering-integrity hole)', () => {
  it('refuses signed-in non-admins with 403 and never touches the ledger', async () => {
    const settle = await post('/api/billing/settle', {
      reservationId: '11111111-1111-4111-8111-111111111111',
      byokBypass: true,
      actualEstimate: { provider: 'openrouter', model: 'm', operation: 'x' }
    });
    expect(settle.status).toBe(403);
    const reserve = await post('/api/billing/reserve', { provider: 'openrouter', model: 'm', operation: 'x' });
    expect(reserve.status).toBe(403);
    expect(ledger.reserveUsageTokens).not.toHaveBeenCalled();
    expect(ledger.settleReservation).not.toHaveBeenCalled();
  });

  it('refuses anonymous callers with 403', async () => {
    signedIn = false;
    expect((await post('/api/billing/settle', {})).status).toBe(403);
    expect((await post('/api/billing/reserve', {})).status).toBe(403);
  });
});

describe('admin usage budgets', () => {
  it('GET is admin-only and returns dollars AND percent, flagging admins', async () => {
    expect((await fetch(`${base}/api/admin/usage/budgets`)).status).toBe(403);
    expect(budgets.listUsageBudgets).not.toHaveBeenCalled();

    access.isAdmin = true;
    const res = await fetch(`${base}/api/admin/usage/budgets`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.json();
    expect(body).toMatchObject({ defaultBudgetUsd: 10, defaultPeriod: 'lifetime', maxBudgetUsd: 1000 });
    expect(body.users[0]).toMatchObject({ budgetUsd: 10, spentUsd: 4, pctUsed: 40, admin: false });
    expect(body.users[1]).toMatchObject({ email: 'owner@example.com', admin: true });
  });

  it('PUT is admin-only', async () => {
    const res = await put('/api/admin/usage/budgets/17933bae-dcc5-49b9-bcf5-9658e3953a84', { budgetUsd: 20 });
    expect(res.status).toBe(403);
    expect(budgets.upsertUsageBudget).not.toHaveBeenCalled();
    expect(audit.recordAudit).not.toHaveBeenCalled();
  });

  it('PUT validates, writes and audits (top-up by user id)', async () => {
    access.isAdmin = true;
    const bad = await put('/api/admin/usage/budgets/17933bae-dcc5-49b9-bcf5-9658e3953a84', { budgetUsd: 5000 });
    expect(bad.status).toBe(400);
    expect((await put('/api/admin/usage/budgets/17933bae-dcc5-49b9-bcf5-9658e3953a84', {})).status).toBe(400);
    expect(budgets.upsertUsageBudget).not.toHaveBeenCalled();

    const ok = await put('/api/admin/usage/budgets/17933bae-dcc5-49b9-bcf5-9658e3953a84', { budgetUsd: 15, note: 'top-up after beta week 1', resetPeriod: false });
    expect(ok.status).toBe(200);
    expect(budgets.upsertUsageBudget).toHaveBeenCalledWith({
      userId: '17933bae-dcc5-49b9-bcf5-9658e3953a84',
      actorId: 'caller-1',
      patch: { budgetUsd: 15, note: 'top-up after beta week 1', resetPeriod: false }
    });
    expect(audit.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'caller-1', action: 'usage_budget.update', targetType: 'user', targetId: '17933bae-dcc5-49b9-bcf5-9658e3953a84' })
    );
  });

  it('PUT resolves an email to the account (so a tester can be set up before first use)', async () => {
    access.isAdmin = true;
    const ok = await put(`/api/admin/usage/budgets/${encodeURIComponent('Tester@Example.com')}`, { exempt: true });
    expect(ok.status).toBe(200);
    expect(budgets.upsertUsageBudget.mock.calls[0][0]).toMatchObject({ userId: '17933bae-dcc5-49b9-bcf5-9658e3953a84', patch: { exempt: true } });
    const missing = await put(`/api/admin/usage/budgets/${encodeURIComponent('nobody@example.com')}`, { exempt: true });
    expect(missing.status).toBe(404);
    expect((await put('/api/admin/usage/budgets/not-an-id', { exempt: true })).status).toBe(400);
  });
});
