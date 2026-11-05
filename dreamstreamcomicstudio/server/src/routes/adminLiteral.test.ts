// @vitest-environment node
// authz-data-5 (server side): no admin decision is derived from the 'admin@test.com' literal any
// more. Anyone can sign up with that address, so it must neither make the assistant treat the
// caller as an admin nor count as an admin in the last-admin guard (which would let the last real
// admin's role be revoked).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  roleAdmins: [] as { user_id: string }[],
  profiles: [] as { id: string; email: string }[],
  billing: null as null | { plan: { id: string }; usage: { dailyRemainingCt: number }; wallet: { availableCt: number } } | Error
}));

vi.mock('../services/supabase.js', () => {
  const result = (table: string) =>
    table === 'user_roles' ? { data: db.roleAdmins, error: null } : table === 'profiles' ? { data: db.profiles, error: null } : { data: null };
  const chain = (table: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {
      select: () => c,
      eq: () => c,
      maybeSingle: async () => ({ data: null }),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result(table)).then(resolve, reject)
    };
    return c;
  };
  return { supabase: { from: chain }, getSupabaseAdmin: () => ({ from: chain }) };
});
vi.mock('../services/billingLedger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/billingLedger.js')>()),
  getBillingSummary: vi.fn(async () => {
    if (db.billing instanceof Error) throw db.billing;
    return db.billing;
  })
}));

const { resolveSafeAccountSummary } = await import('./assistant.js');
const { resolveActiveAdminCount } = await import('./admin.js');

const savedAdminEmails = process.env.ADMIN_EMAILS;
beforeEach(() => {
  delete process.env.ADMIN_EMAILS;
  db.roleAdmins = [];
  db.profiles = [];
  db.billing = null;
});
afterEach(() => {
  if (savedAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = savedAdminEmails;
});

describe('assistant account summary: admin only from the server-held plan', () => {
  const summary = (tier: string) => ({ plan: { id: tier }, usage: { dailyRemainingCt: 1 }, wallet: { availableCt: 2 } });

  it('admin@test.com on a free plan is not an admin', async () => {
    db.billing = summary('free');
    const out = await resolveSafeAccountSummary({ id: 'u1', email: 'admin@test.com' });
    expect(out).toMatchObject({ isAdmin: false, planTier: 'free' });
  });

  it.each([
    ['no billing answer', null],
    ['a billing error', new Error('ledger down')]
  ])('admin@test.com with %s falls back to free / not admin', async (_why, billing) => {
    db.billing = billing;
    const out = await resolveSafeAccountSummary({ id: 'u1', email: 'admin@test.com' });
    expect(out).toMatchObject({ isAdmin: false, planTier: 'free' });
  });

  it("the server's admin plan is what makes an admin, whatever the email", async () => {
    db.billing = summary('admin');
    const out = await resolveSafeAccountSummary({ id: 'u2', email: 'someone@example.com' });
    expect(out).toMatchObject({ isAdmin: true, planTier: 'admin' });
  });
});

describe('last-admin guard: the admin count', () => {
  it('a profile that signed up as admin@test.com is not counted (ADMIN_EMAILS unset)', async () => {
    db.roleAdmins = [{ user_id: 'real-admin' }];
    db.profiles = [
      { id: 'real-admin', email: 'boss@example.com' },
      { id: 'squatter', email: 'admin@test.com' }
    ];
    expect(await resolveActiveAdminCount()).toBe(1);
  });

  it('counts the bootstrap emails requireAdmin honours (ADMIN_EMAILS)', async () => {
    process.env.ADMIN_EMAILS = 'Ops@Example.com';
    db.roleAdmins = [{ user_id: 'real-admin' }];
    db.profiles = [
      { id: 'real-admin', email: 'boss@example.com' },
      { id: 'ops', email: 'ops@example.com' }
    ];
    expect(await resolveActiveAdminCount()).toBe(2);
  });
});
