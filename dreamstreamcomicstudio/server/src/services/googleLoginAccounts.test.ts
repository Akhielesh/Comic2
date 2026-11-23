import { beforeEach, describe, expect, it, vi } from 'vitest';
import { issueGoogleSession, resolveGoogleAccount } from './googleLoginAccounts.js';

const h = vi.hoisted(() => ({
  lookup: vi.fn(), createUser: vi.fn(), getUserById: vi.fn(), generateLink: vi.fn(), checkName: vi.fn(), factors: vi.fn()
}));
vi.mock('./supabase.js', () => ({ getSupabaseAdmin: () => ({
  rpc: () => ({ single: h.lookup }), auth: { admin: { ...h, mfa: { listFactors: h.factors } } },
  from: () => ({ select: () => ({ ilike: () => ({ limit: h.checkName }) }) })
}) }));
const identity = { sub: 'google-verified-sub', email: 'reader@example.test' };
const user = { id: 'member', email: identity.email, email_confirmed_at: '2026-01-01', app_metadata: { dreamstream_google_sub: identity.sub } };
const bound = { bound_id: user.id, login_email: user.email, email_in_use: true };
const missing = { bound_id: null, login_email: null, email_in_use: false };
const profile = { username: 'reader_one', firstName: 'Reader', dob: '2000-01-01', acceptedTerms: true };
beforeEach(() => {
  vi.resetAllMocks();
  h.lookup.mockResolvedValue({ data: bound });
  h.factors.mockResolvedValue({ data: { factors: [] } });
  h.getUserById.mockResolvedValue({ data: { user } });
  h.generateLink.mockResolvedValue({ data: { user, properties: { hashed_token: 'test-one-time-proof' } } });
  h.createUser.mockResolvedValue({ data: { user } });
});
describe('binding a verified Google identity to a DreamStream login', () => {
  it('creates one confirmed account with a protected subject and validated profile, including a referral', async () => {
    h.lookup.mockResolvedValueOnce({ data: missing });
    const referralCode = 'a'.repeat(32);
    await expect(issueGoogleSession(identity, { ...profile, referralCode })).resolves.toEqual({ tokenHash: 'test-one-time-proof' });
    expect(h.createUser).toHaveBeenCalledWith(expect.objectContaining({ email_confirm: true, app_metadata: { dreamstream_google_sub: identity.sub, dreamstream_referral_code: referralCode },
      user_metadata: expect.objectContaining({ username: 'reader_one', terms_accepted: true, marketing_consent: false }) }));
    expect(h.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: identity.email });
  });
  it('refuses account linking by email alone, including when another signup wins a race', async () => {
    const conflict = { ...missing, email_in_use: true };
    h.lookup.mockResolvedValue({ data: conflict });
    expect(await resolveGoogleAccount(identity)).toBe('email-conflict');
    await expect(issueGoogleSession(identity, profile)).rejects.toMatchObject({ code: 'email-conflict' });
    expect(h.createUser).not.toHaveBeenCalled();
    h.lookup.mockResolvedValueOnce({ data: missing });
    h.createUser.mockResolvedValueOnce({ data: { user: null }, error: {} });
    await expect(issueGoogleSession(identity, profile)).rejects.toMatchObject({ code: 'email-conflict' });
    expect(h.generateLink).not.toHaveBeenCalled();
  });
  it('rejects a different user in the OTP response and changed, banned, or unconfirmed identities', async () => {
    h.generateLink.mockResolvedValueOnce({ data: { user: { ...user, id: 'unrelated' }, properties: { hashed_token: 'wrong' } } });
    await expect(issueGoogleSession(identity)).rejects.toMatchObject({ code: 'identity-mismatch' });
    for (const patch of [{ email_confirmed_at: null }, { app_metadata: {} }, { banned_until: '2200-01-01' }, { email: 'changed@example.test' }]) {
      h.getUserById.mockResolvedValueOnce({ data: { user: { ...user, ...patch } } });
      await expect(issueGoogleSession(identity)).rejects.toMatchObject({ code: 'identity-mismatch' });
    }
    expect(h.generateLink).toHaveBeenCalledTimes(1);
  });
  it('requires a working second-factor check and leaves enrolled accounts on their established sign-in', async () => {
    h.factors.mockResolvedValueOnce({ data: { factors: [{ status: 'verified' }] } });
    await expect(issueGoogleSession(identity)).rejects.toMatchObject({ code: 'identity-mismatch' });
    h.factors.mockResolvedValueOnce({ data: null, error: {} });
    await expect(issueGoogleSession(identity)).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.generateLink).not.toHaveBeenCalled();
  });
  it('enforces age, valid names and explicit consent before creating a user', async () => {
    h.lookup.mockResolvedValue({ data: missing });
    for (const patch of [{ acceptedTerms: false }, { dob: new Date().toISOString().slice(0,10) }, { username: '@' }, { firstName: '' }]) {
      await expect(issueGoogleSession(identity, { ...profile, ...patch })).rejects.toMatchObject({ code: 'invalid-profile' });
    }
    expect(h.createUser).not.toHaveBeenCalled();
  });
});
