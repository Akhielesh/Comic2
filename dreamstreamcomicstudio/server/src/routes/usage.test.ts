// @vitest-environment node
// GET /api/usage/allowance speaks ONLY in percent + friendly units: no key anywhere in the
// payload may look like money (owner: "dont show it as amount rather show it as a available
// usage limit left").
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const who = vi.hoisted(() => ({ signedIn: true, email: 'tester@example.com', admin: false }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!who.signedIn) return res.status(401).json({ error: { message: 'Missing Authorization header' } });
    req.user = { id: 'tester-1', email: who.email };
    next();
  }
}));
vi.mock('../middleware/accountKeys.js', () => ({ accountKeyProviders: vi.fn(async () => ['gemini']) }));
vi.mock('../services/rbac.js', () => ({
  isBootstrapAdminEmail: () => false,
  getUserRoles: vi.fn(async () => (who.admin ? ['admin'] : []))
}));

const allowance = await import('../services/platformAllowance.js');
const { usageRouter } = await import('./usage.js');

const MONEY_KEY = /usd|cost|amount|budget/i;
const allKeys = (value: unknown): string[] =>
  value && typeof value === 'object' ? Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [k, ...allKeys(v)]) : [];

const status = vi.fn(async (_userId: string, _defaultUsd: number) => ({ governed: true, budget_usd: 10, spent_usd: 6.2, inflight_usd: 0.3, pct_used: 65, pct_left: 35, exhausted: false, period: 'lifetime' }) as unknown);

const app = express();
app.use('/api/usage', usageRouter);
let server: Server;
let base = '';
beforeAll(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  allowance.__resetPlatformAllowance();
  allowance.__setMeteringEnabledForTests(true);
  who.signedIn = true;
  who.admin = false;
  status.mockClear();
  allowance.setUsageBudgetRpc({ tryReserve: async () => ({}), status: (userId: string, defaultUsd: number) => status(userId, defaultUsd), adminList: async () => [] });
  // getBillingPrefs reads user_billing_prefs; without a service role it falls back to defaults.
});
afterEach(() => allowance.__resetPlatformAllowance());

describe('GET /api/usage/allowance', () => {
  it('returns usage left in percent + friendly units, and NO key that looks like money', async () => {
    const res = await fetch(`${base}/api/usage/allowance`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const body = await res.json();
    expect(body).toMatchObject({
      enabled: true,
      governed: true,
      pctUsed: 65,
      pctLeft: 35,
      exhausted: false,
      resetsAt: null,
      crossed: [30],
      byokAvailable: true,
      usePlatformAllowance: true,
      byokFallbackMode: 'ask'
    });
    expect(body.friendlyUnits.label).toMatch(/standard comic pages left/);
    expect(body.friendlyUnits.standardPages).toBeGreaterThan(0);
    expect(allKeys(body).filter((k) => MONEY_KEY.test(k))).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/\$|6\.2|0\.3\b|"10"/);
  });

  it('shows the exhausted state honestly (0% left, no reset for lifetime usage)', async () => {
    status.mockResolvedValueOnce({ governed: true, budget_usd: 10, spent_usd: 10.02, inflight_usd: 0, pct_used: 100, pct_left: 0, exhausted: true, period: 'lifetime' });
    const body = await (await fetch(`${base}/api/usage/allowance`)).json();
    expect(body).toMatchObject({ governed: true, pctLeft: 0, exhausted: true, resetsAt: null });
    expect(body.friendlyUnits.label).toBe('no usage left');
    expect(allKeys(body).filter((k) => MONEY_KEY.test(k))).toEqual([]);
  });

  it('admins are not governed (no meter, no database read)', async () => {
    who.admin = true;
    const body = await (await fetch(`${base}/api/usage/allowance`)).json();
    expect(body).toMatchObject({ enabled: true, governed: false, pctLeft: 100, exhausted: false, friendlyUnits: null });
    expect(status).not.toHaveBeenCalled();
  });

  it('hides the meter (enabled:false) when the status is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    status.mockRejectedValueOnce(new Error('db down'));
    const body = await (await fetch(`${base}/api/usage/allowance`)).json();
    expect(body.enabled).toBe(false);
    expect(allKeys(body).filter((k) => MONEY_KEY.test(k))).toEqual([]);
    warn.mockRestore();
  });

  it('requires sign-in', async () => {
    who.signedIn = false;
    expect((await fetch(`${base}/api/usage/allowance`)).status).toBe(401);
  });
});
