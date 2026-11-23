// @vitest-environment node
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { memberReferralsRouter } from './memberReferrals.js';
import { invitesRouter } from './invites.js';

const rpc = vi.hoisted(() => vi.fn());
vi.mock('../services/supabase.js', () => ({ getSupabaseAdmin: () => ({ rpc }) }));
const app = express();
app.use(express.json());
app.use((req, _res, next) => { if (req.headers.authorization === 'Bearer signed') req.user = { id: 'owner' } as NonNullable<typeof req.user>; next(); });
app.use('/member', memberReferralsRouter);
app.use('/invites', invitesRouter);
const code = 'a'.repeat(32);
let server: Server;
let origin: string;
beforeAll(async () => {
  await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
async function call(path: string, body?: Record<string, unknown>, signed = false) {
  const result = await fetch(origin + path, { method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(signed ? { Authorization: 'Bearer signed' } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: result.status, headers: result.headers, body: await result.json() };
}

afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });
describe('private member referral routes', () => {
  it('gets the verified owner aggregate only and ignores a supplied account id', async () => {
    expect((await call('/member/me?userId=another')).status).toBe(401);
    rpc.mockReturnValue({ maybeSingle: async () => ({ data: { code, verified_signups: 2, email: 'private@example.invalid' } }) });
    const res = await call('/member/me?owner=another',undefined,true);
    expect(res.body).toEqual({ code, verifiedSignups: 2 });
    expect(rpc).toHaveBeenCalledWith('member_referral_summary', { p_owner: 'owner' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
  it('retires member tester-code mint and mail routes without accepting recipients or awarding access',async () => {
    for(const res of [await call('/invites/referral'), await call('/invites/referral/send',{emails:'person@example.invalid'})]) {
      expect(res.status).toBe(410);
      expect(res.body.error.message).toMatch(/copy your personal referral link/);
    }
    expect(rpc).not.toHaveBeenCalled();
  });
});
