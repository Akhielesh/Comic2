// @vitest-environment jsdom
// Settings → Security (ADR 0006 WS-5): TOTP enrol/verify (mocked Supabase MFA), "Your devices"
// with one-tap sign-out, recent security activity, and "Sign out everywhere".
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OFF = { ok: true, on: false, factors: [], aal: 'aal1', available: true, codesLeft: null, grace: false };
const CODES = Array.from({ length: 10 }, (_, i) => `abcd-efgh-jk${'mnpqrstuvw'[i]}2`);

const h = vi.hoisted(() => ({
  status: {} as Record<string, unknown>,
  fresh: vi.fn(async () => false),
  confirmPassword: vi.fn(async (_p: string) => ({ ok: true }) as Record<string, unknown>),
  regenerate: vi.fn(),
  enroll: vi.fn(),
  verify: vi.fn(),
  cancel: vi.fn(async () => undefined),
  unenroll: vi.fn(),
  devices: { ok: true, devices: [] } as Record<string, unknown>,
  revoke: vi.fn(),
  unconfirmed: [] as string[],
  events: { ok: true, events: [] } as Record<string, unknown>,
  stepUp: vi.fn(async (_reason?: string) => true),
  signOutEverywhere: vi.fn(async () => ({ kicked: true, global: true })),
  openAuth: vi.fn(),
}));

vi.mock('../../account', () => ({
  failed: (r: { ok: boolean }) => r.ok === false,
  useAccount: () => ({ status: 'member', email: 'ada@example.com' }),
  signInIsFresh: h.fresh,
  openAuth: h.openAuth,
  confirmPassword: h.confirmPassword,
  regenerateRecoveryCodes: h.regenerate,
  mfaStatus: vi.fn(async () => h.status),
  enrollTotp: h.enroll,
  verifyTotp: h.verify,
  cancelTotpEnrollment: h.cancel,
  unenrollTotp: h.unenroll,
  listMyDevices: vi.fn(async () => h.devices),
  revokeMyDevice: h.revoke,
  unconfirmedRevokes: () => h.unconfirmed,
  listSecurityEvents: vi.fn(async () => h.events),
  signOutEverywhere: h.signOutEverywhere,
  signOutEverywhereMessage: (r: { kicked: boolean }) => (r.kicked ? 'Signed out everywhere — disconnected.' : 'Signed out everywhere.'),
}));
vi.mock('./StepUp', () => ({ ensureStepUp: h.stepUp }));
vi.mock('@/services/liveLink', () => ({ mainAppUrl: (p: string) => `https://dreamstreamstudio.ai${p}` }));

import { SecurityPanel, SIGN_OUT_EVERYWHERE_CONFIRM, confirmAndSignOutEverywhere } from './SecurityPanel';

const push = vi.fn();
const flush = () => act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  h.status = { ...OFF };
  h.devices = { ok: true, devices: [] };
  h.events = { ok: true, events: [] };
  h.unconfirmed = [];
  for (const fn of [h.enroll, h.verify, h.unenroll, h.revoke, h.stepUp, h.signOutEverywhere, h.cancel, h.fresh, h.confirmPassword, h.regenerate, push]) fn.mockClear();
  h.stepUp.mockResolvedValue(true);
  h.fresh.mockResolvedValue(false);
  h.confirmPassword.mockResolvedValue({ ok: true });
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => {
  confirmSpy.mockRestore();
});

async function mount(onSignOutEverywhere = vi.fn()) {
  render(<SecurityPanel push={push} onSignOutEverywhere={onSignOutEverywhere} />);
  await flush();
  return onSignOutEverywhere;
}

const ON = (over: Record<string, unknown> = {}) => ({
  ...OFF,
  on: true,
  factors: [{ id: 'f-1', name: 'Authenticator 1', createdAt: '2026-10-28T10:00:00Z' }],
  codesLeft: 10,
  ...over,
});
const enrolment = { ok: true, factorId: 'f-1', qr: 'data:image/svg+xml;utf-8,<svg/>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://x' };
const click = async (name: string | RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
  await flush();
};

describe('two-step sign-in', () => {
  it('turns on only after saying what changes (the nursery camera stays on), a fresh sign-in, and saved recovery codes', async () => {
    h.events = {
      ok: true,
      events: [
        { id: 2, kind: 'sign_in', method: 'password', ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36', ip: '203.0.113.x', at: '2026-10-20T09:00:00Z', this_session: false, active: true, secured: false, detail: null },
        { id: 1, kind: 'sign_in', method: 'password', ua: 'Mozilla/5.0 (Macintosh) Chrome/130.0 Safari/537.36', ip: '198.51.100.x', at: '2026-10-27T09:00:00Z', this_session: true, active: true, secured: false, detail: null },
        { id: 0, kind: 'sign_in', method: 'password', ua: 'Old', ip: null, at: '2026-09-27T09:00:00Z', this_session: false, active: false, secured: false, detail: null },
      ],
    };
    h.enroll.mockResolvedValue(enrolment);
    h.verify.mockResolvedValue({ ok: true, first: true, codes: CODES });
    await mount();
    expect(screen.getByText('Off')).toBeInTheDocument();
    await click('Turn on two-step sign-in');
    // 1. What changes, plainly — the camera line first — and who is signed in right now.
    const intro = screen.getByRole('group', { name: 'Before you turn on two-step sign-in' });
    expect(intro).toHaveTextContent(/Devices already signed in stay signed in and keep working — including a phone running as a nursery camera/);
    const now = within(intro).getByRole('list', { name: 'Signed in right now' });
    expect(within(now).getAllByRole('listitem')).toHaveLength(2); // only sessions still active
    expect(now).toHaveTextContent('Chrome on Android');
    expect(now).toHaveTextContent('Chrome on macOS — this device');
    expect(h.enroll).not.toHaveBeenCalled();
    // 2. Not a fresh sign-in: the password first.
    await click('Continue');
    expect(h.enroll).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'correct horse' } });
    await click('Continue');
    expect(h.confirmPassword).toHaveBeenCalledWith('correct horse');
    // 3. The QR code and setup key.
    expect(screen.getByAltText(/QR code to add DreamStream/)).toHaveAttribute('src', 'data:image/svg+xml;utf-8,<svg/>');
    expect(screen.getByLabelText('Setup key')).toHaveTextContent('JBSW Y3DP EHPK 3PXP');
    h.status = ON();
    fireEvent.change(screen.getByLabelText('6-digit code from your authenticator app'), { target: { value: '123456' } });
    await click('Turn on');
    expect(h.verify).toHaveBeenCalledWith('f-1', '123456');
    // 4. Recovery codes, once — not done until they're saved.
    const codes = screen.getByRole('list', { name: 'Recovery codes' });
    expect(within(codes).getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText(/one of these gets you back in/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(push).not.toHaveBeenCalledWith('Two-step sign-in is on', expect.anything());
    fireEvent.click(screen.getByLabelText('I’ve saved these codes somewhere safe'));
    await click('Done');
    expect(push).toHaveBeenCalledWith('Two-step sign-in is on', { icon: 'check' });
    expect(screen.getByText('On')).toBeInTheDocument();
    expect(screen.getByText('Authenticator 1')).toBeInTheDocument();
    expect(screen.getByText(/10 left/)).toBeInTheDocument();
    // The first one needs no step-up: there's nothing to step up to yet.
    expect(h.stepUp).not.toHaveBeenCalled();
  });

  it('a just-signed-in session skips the password; a wrong password changes nothing', async () => {
    h.enroll.mockResolvedValue(enrolment);
    await mount();
    h.confirmPassword.mockResolvedValueOnce({ ok: false, code: 'wrong_password', error: 'That password isn’t right. Nothing has changed on your account.' });
    await click('Turn on two-step sign-in');
    await click('Continue');
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'nope' } });
    await click('Continue');
    expect(screen.getByRole('alert')).toHaveTextContent('That password isn’t right');
    expect(h.enroll).not.toHaveBeenCalled();
    // No password (signed in with a link from DreamStream): a way to get one, never a dead end.
    await click('Forgot password');
    expect(h.openAuth).toHaveBeenCalledWith('reset');
    await click('Cancel');
    h.fresh.mockResolvedValue(true);
    await click('Turn on two-step sign-in');
    await click('Continue');
    expect(h.enroll).toHaveBeenCalledOnce();
    expect(screen.getByAltText(/QR code to add DreamStream/)).toBeInTheDocument();
  });

  it('an authenticator Supabase holds but that was never switched on is explained — never a request for a code nobody has', async () => {
    h.fresh.mockResolvedValue(true);
    h.enroll.mockResolvedValue({ ok: false, code: 'step_up', error: 'Confirm it’s you with a code from your authenticator app first.' });
    await mount();
    await click('Turn on two-step sign-in');
    await click('Continue');
    expect(h.stepUp).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/never finished is still attached.*removed automatically within an hour.*Sign out everywhere/);
    expect(screen.getByRole('button', { name: 'Turn on two-step sign-in' })).toBeInTheDocument();
  });

  it('a wrong first code is explained; Cancel removes the half-done set-up', async () => {
    h.fresh.mockResolvedValue(true);
    h.enroll.mockResolvedValue({ ok: true, factorId: 'f-1', qr: 'data:x', secret: 'ABCD', uri: 'otpauth://x' });
    h.verify.mockResolvedValue({ ok: false, code: 'invalid_code', error: 'That code didn’t match.' });
    await mount();
    await click('Turn on two-step sign-in');
    await click('Continue');
    fireEvent.change(screen.getByLabelText('6-digit code from your authenticator app'), { target: { value: '000000' } });
    await click('Turn on');
    expect(screen.getByRole('alert')).toHaveTextContent('That code didn’t match.');
    await click('Cancel');
    expect(h.cancel).toHaveBeenCalledWith('f-1');
  });

  it('if the server won’t switch it on (no fresh sign-in), it starts over — nothing is left half-on', async () => {
    h.fresh.mockResolvedValue(true);
    h.enroll.mockResolvedValue(enrolment);
    h.verify.mockResolvedValue({ ok: false, code: 'reauth', error: 'For your safety, turning on two-step sign-in needs your password typed again first.' });
    await mount();
    await click('Turn on two-step sign-in');
    await click('Continue');
    fireEvent.change(screen.getByLabelText('6-digit code from your authenticator app'), { target: { value: '123456' } });
    await click('Turn on');
    expect(screen.getByRole('alert')).toHaveTextContent(/password typed again/);
    expect(screen.getByRole('button', { name: 'Turn on two-step sign-in' })).toBeInTheDocument();
  });

  it('says plainly when it can’t be turned on yet — and offers no button that would fail', async () => {
    h.status = { ...OFF, available: false };
    await mount();
    expect(screen.getByText(/isn’t switched on for DreamStream accounts yet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Turn on two-step sign-in' })).toBeNull();
    // …and when the server's MFA switch is off, enrolment says the same.
    h.status = { ...OFF };
    h.fresh.mockResolvedValue(true);
    h.enroll.mockResolvedValue({ ok: false, code: 'disabled', error: 'x' });
    document.body.innerHTML = '';
    await mount();
    await click('Turn on two-step sign-in');
    await click('Continue');
    expect(screen.getByText(/isn’t switched on for DreamStream accounts yet/)).toBeInTheDocument();
  });

  it('turning it off asks for the code first — and stops if the code isn’t given', async () => {
    h.status = ON();
    h.unenroll.mockResolvedValue({ ok: true });
    await mount();
    h.stepUp.mockResolvedValueOnce(false);
    await click('Turn off');
    expect(h.stepUp).toHaveBeenCalledWith('Turning off two-step sign-in');
    expect(h.unenroll).not.toHaveBeenCalled();
    await click('Turn off');
    expect(h.unenroll).toHaveBeenCalledWith('f-1');
    expect(push).toHaveBeenCalledWith('Two-step sign-in is off', { icon: 'check' });
  });

  it('adding a second authenticator needs the code too', async () => {
    h.status = ON({ aal: 'aal2' });
    h.enroll.mockResolvedValue({ ok: true, factorId: 'f-2', qr: 'data:x', secret: 'ABCD', uri: 'otpauth://x' });
    await mount();
    await click('Add another authenticator');
    expect(h.stepUp).toHaveBeenCalledWith('Adding an authenticator');
    expect(h.enroll).toHaveBeenCalledOnce();
  });

  it('recovery codes: how many are left, and new ones (with the code) shown once', async () => {
    h.status = ON({ codesLeft: 1 });
    h.regenerate.mockResolvedValue({ ok: true, codes: CODES });
    await mount();
    expect(screen.getByText(/1 left/)).toBeInTheDocument();
    await click('Get new codes');
    expect(h.stepUp).toHaveBeenCalledWith('Making new recovery codes');
    expect(within(screen.getByRole('list', { name: 'Recovery codes' })).getAllByRole('listitem')).toHaveLength(10);
    expect(screen.getByText(/the old ones have stopped working/)).toBeInTheDocument();
  });

  it('tells a device signed in before it was turned on that it keeps working without the code', async () => {
    h.status = ON({ grace: true });
    await mount();
    expect(screen.getByRole('status')).toHaveTextContent(/signed in before two-step sign-in was turned on, so it keeps working without the code/);
  });
});

describe('your devices', () => {
  const watch = { id: 'd-1', platform: 'watchos', name: 'Ada’s Watch', created_at: '2026-10-01T10:00:00Z', last_seen: new Date().toISOString(), revoked_at: null };
  const old = { id: 'd-2', platform: 'web', name: 'Old laptop', created_at: '2026-09-01T10:00:00Z', last_seen: '2026-09-02T10:00:00Z', revoked_at: '2026-09-03T10:00:00Z' };

  it('lists them and signs one out after confirming and the code', async () => {
    h.devices = { ok: true, devices: [old, watch] };
    h.revoke.mockResolvedValue({ ok: true, confirmed: true });
    await mount();
    const list = screen.getByRole('list', { name: 'Your devices' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Ada’s Watch'); // active first
    expect(items[0]).toHaveTextContent(/Apple Watch · added .* · last used just now/);
    expect(items[1]).toHaveTextContent('Signed out');
    await act(async () => {
      fireEvent.click(within(items[0]).getByRole('button', { name: 'Sign out' }));
    });
    await flush();
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('Sign out “Ada’s Watch”?'));
    expect(h.stepUp).toHaveBeenCalledWith('Signing a device out');
    expect(h.revoke).toHaveBeenCalledWith('d-1');
    expect(push).toHaveBeenCalledWith('Ada’s Watch is signed out — its alerts and access stopped', { icon: 'check' });
  });

  it('never says a device is signed out when the server failed — and keeps a retry until every nursery has heard', async () => {
    h.devices = { ok: true, devices: [watch] };
    h.revoke.mockResolvedValueOnce({ ok: false, error: 'retry' });
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    });
    await flush();
    expect(push).toHaveBeenCalledWith(expect.stringMatching(/Couldn’t sign “Ada’s Watch” out just now — nothing changed/), expect.objectContaining({ icon: 'alert' }));
    expect(push).not.toHaveBeenCalledWith(expect.stringMatching(/is signed out/), expect.anything());
    // Signed out of the account, but not every room heard: honest toast, and a retry on the row.
    h.revoke.mockResolvedValueOnce({ ok: true, confirmed: false });
    h.devices = { ok: true, devices: [{ ...watch, revoked_at: new Date().toISOString() }] };
    h.unconfirmed = ['d-1'];
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    });
    await flush();
    expect(push).toHaveBeenLastCalledWith(expect.stringMatching(/may still get alerts\. Tap “Finish signing out”/), expect.objectContaining({ icon: 'alert' }));
    const retry = screen.getByRole('button', { name: 'Finish signing out' });
    h.revoke.mockResolvedValueOnce({ ok: true, confirmed: true });
    h.unconfirmed = [];
    confirmSpy.mockClear();
    await act(async () => {
      fireEvent.click(retry);
    });
    await flush();
    expect(confirmSpy).not.toHaveBeenCalled(); // already confirmed once
    expect(h.revoke).toHaveBeenLastCalledWith('d-1');
    expect(screen.getByText('Signed out')).toBeInTheDocument();
  });

  it('is honest before the security update is on the server', async () => {
    h.devices = { ok: false, error: 'setup' };
    await mount();
    expect(screen.getAllByText(/appears with the next security update/).length).toBeGreaterThan(0);
  });
});

describe('recent security activity', () => {
  it('shows sign-ins in plain words, marks this device, and offers a way out', async () => {
    h.events = {
      ok: true,
      events: [
        { id: 2, kind: 'sign_in', method: 'password', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', ip: '203.0.113.x', at: '2026-10-28T09:00:00Z', this_session: false, active: true, secured: false, detail: null },
        { id: 1, kind: 'sign_in', method: 'password', ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', ip: '198.51.100.x', at: '2026-10-27T09:00:00Z', this_session: true, active: true, secured: false, detail: null },
      ],
    };
    const onOut = await mount();
    const list = screen.getByRole('list', { name: 'Recent security activity' });
    const [phone, mac] = within(list).getAllByRole('listitem');
    expect(phone).toHaveTextContent('Signed in with the password');
    expect(phone).toHaveTextContent('Safari on iPhone · near 203.0.113.x');
    expect(phone).toHaveTextContent('Still signed in');
    expect(mac).toHaveTextContent('Chrome on macOS');
    expect(mac).toHaveTextContent('This device');
    expect(list.textContent).not.toMatch(/Mozilla/); // never the raw user-agent
    fireEvent.click(screen.getByRole('button', { name: 'Sign out everywhere' }));
    expect(onOut).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Change password' })).toHaveAttribute('href', 'https://dreamstreamstudio.ai/?view=settings&tab=security');
  });
});

describe('sign out everywhere', () => {
  it('warns that a nursery camera on this account stops too, and does nothing if cancelled', async () => {
    confirmSpy.mockReturnValueOnce(false);
    expect(await confirmAndSignOutEverywhere(push)).toBe(false);
    expect(SIGN_OUT_EVERYWHERE_CONFIRM).toMatch(/nursery camera/);
    expect(h.signOutEverywhere).not.toHaveBeenCalled();
  });

  it('signs out everywhere and says what happened', async () => {
    expect(await confirmAndSignOutEverywhere(push)).toBe(true);
    expect(h.signOutEverywhere).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith('Signed out everywhere — disconnected.', { icon: 'check', duration: 7000 });
  });
});
