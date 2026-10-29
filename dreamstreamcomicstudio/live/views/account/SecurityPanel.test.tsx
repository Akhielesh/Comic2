// @vitest-environment jsdom
// Settings → Security (ADR 0006 WS-5): TOTP enrol/verify (mocked Supabase MFA), "Your devices"
// with one-tap sign-out, recent security activity, and "Sign out everywhere".
import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  status: { ok: true, on: false, factors: [], aal: 'aal1' } as Record<string, unknown>,
  enroll: vi.fn(),
  verify: vi.fn(),
  cancel: vi.fn(async () => undefined),
  unenroll: vi.fn(),
  devices: { ok: true, devices: [] } as Record<string, unknown>,
  revoke: vi.fn(),
  events: { ok: true, events: [] } as Record<string, unknown>,
  stepUp: vi.fn(async (_reason?: string) => true),
  signOutEverywhere: vi.fn(async () => ({ kicked: true, global: true })),
}));

vi.mock('../../account', () => ({
  failed: (r: { ok: boolean }) => r.ok === false,
  mfaStatus: vi.fn(async () => h.status),
  enrollTotp: h.enroll,
  verifyTotp: h.verify,
  cancelTotpEnrollment: h.cancel,
  unenrollTotp: h.unenroll,
  listMyDevices: vi.fn(async () => h.devices),
  revokeMyDevice: h.revoke,
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
  h.status = { ok: true, on: false, factors: [], aal: 'aal1' };
  h.devices = { ok: true, devices: [] };
  h.events = { ok: true, events: [] };
  for (const fn of [h.enroll, h.verify, h.unenroll, h.revoke, h.stepUp, h.signOutEverywhere, h.cancel, push]) fn.mockClear();
  h.stepUp.mockResolvedValue(true);
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

describe('two-step sign-in', () => {
  it('turns on: QR code and setup key, then the first code verifies it', async () => {
    h.enroll.mockResolvedValue({ ok: true, factorId: 'f-1', qr: 'data:image/svg+xml;utf-8,<svg/>', secret: 'JBSWY3DPEHPK3PXP', uri: 'otpauth://x' });
    h.verify.mockResolvedValue({ ok: true });
    await mount();
    expect(screen.getByText('Off')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn on two-step sign-in' }));
    });
    await flush();
    expect(screen.getByAltText(/QR code to add DreamStream/)).toHaveAttribute('src', 'data:image/svg+xml;utf-8,<svg/>');
    expect(screen.getByLabelText('Setup key')).toHaveTextContent('JBSW Y3DP EHPK 3PXP');
    // Honest recovery guidance: no backup codes, keep the key.
    expect(screen.getByText(/There are no backup codes/)).toBeInTheDocument();

    h.status = { ok: true, on: true, factors: [{ id: 'f-1', name: 'Authenticator 1', createdAt: '2026-10-28T10:00:00Z' }], aal: 'aal2' };
    fireEvent.change(screen.getByLabelText('6-digit code from your authenticator app'), { target: { value: '123456' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    });
    await flush();
    expect(h.verify).toHaveBeenCalledWith('f-1', '123456');
    expect(push).toHaveBeenCalledWith('Two-step sign-in is on', { icon: 'check' });
    expect(screen.getByText('On')).toBeInTheDocument();
    expect(screen.getByText('Authenticator 1')).toBeInTheDocument();
    // The first one needs no step-up: there's nothing to step up to yet.
    expect(h.stepUp).not.toHaveBeenCalled();
  });

  it('a wrong first code is explained; Cancel removes the half-done set-up', async () => {
    h.enroll.mockResolvedValue({ ok: true, factorId: 'f-1', qr: 'data:x', secret: 'ABCD', uri: 'otpauth://x' });
    h.verify.mockResolvedValue({ ok: false, code: 'invalid_code', error: 'That code didn’t match.' });
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn on two-step sign-in' }));
    });
    await flush();
    fireEvent.change(screen.getByLabelText('6-digit code from your authenticator app'), { target: { value: '000000' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn on' }));
    });
    await flush();
    expect(screen.getByRole('alert')).toHaveTextContent('That code didn’t match.');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(h.cancel).toHaveBeenCalledWith('f-1');
  });

  it('says plainly when the server has TOTP switched off', async () => {
    h.enroll.mockResolvedValue({ ok: false, code: 'disabled', error: 'x' });
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn on two-step sign-in' }));
    });
    await flush();
    expect(screen.getByText(/isn’t switched on for DreamStream accounts yet/)).toBeInTheDocument();
  });

  it('turning it off asks for the code first — and stops if the code isn’t given', async () => {
    h.status = { ok: true, on: true, factors: [{ id: 'f-1', name: 'Authenticator 1', createdAt: '2026-10-28T10:00:00Z' }], aal: 'aal1' };
    h.unenroll.mockResolvedValue({ ok: true });
    await mount();
    h.stepUp.mockResolvedValueOnce(false);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    });
    expect(h.stepUp).toHaveBeenCalledWith('Turning off two-step sign-in');
    expect(h.unenroll).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    });
    await flush();
    expect(h.unenroll).toHaveBeenCalledWith('f-1');
    expect(push).toHaveBeenCalledWith('Two-step sign-in is off', { icon: 'check' });
  });

  it('adding a second authenticator needs the code too', async () => {
    h.status = { ok: true, on: true, factors: [{ id: 'f-1', name: 'Authenticator 1', createdAt: '2026-10-28T10:00:00Z' }], aal: 'aal2' };
    h.enroll.mockResolvedValue({ ok: true, factorId: 'f-2', qr: 'data:x', secret: 'ABCD', uri: 'otpauth://x' });
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add another authenticator' }));
    });
    await flush();
    expect(h.stepUp).toHaveBeenCalledWith('Adding an authenticator');
    expect(h.enroll).toHaveBeenCalledOnce();
  });
});

describe('your devices', () => {
  const watch = { id: 'd-1', platform: 'watchos', name: 'Ada’s Watch', created_at: '2026-10-01T10:00:00Z', last_seen: new Date().toISOString(), revoked_at: null };
  const old = { id: 'd-2', platform: 'web', name: 'Old laptop', created_at: '2026-09-01T10:00:00Z', last_seen: '2026-09-02T10:00:00Z', revoked_at: '2026-09-03T10:00:00Z' };

  it('lists them and signs one out after confirming and the code', async () => {
    h.devices = { ok: true, devices: [old, watch] };
    h.revoke.mockResolvedValue({ ok: true });
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
    expect(push).toHaveBeenCalledWith('Ada’s Watch is signed out', { icon: 'check' });
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
