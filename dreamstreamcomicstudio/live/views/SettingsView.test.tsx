import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../nav';

const acct = vi.hoisted(() => ({
  current: { status: 'needs_code', userId: 'u1', email: 'ada@example.com' } as Record<string, unknown>,
  updateDisplayName: vi.fn(async (name: string) => ({ ok: true, name })),
  signOutThisDevice: vi.fn(async () => undefined),
  signOutEverywhere: vi.fn(async () => ({ kicked: true, global: true })),
}));
vi.mock('../account', () => ({
  useAccount: () => acct.current,
  updateDisplayName: acct.updateDisplayName,
  openAuth: vi.fn(),
  signOutThisDevice: acct.signOutThisDevice,
  signOutEverywhere: acct.signOutEverywhere,
  signOutEverywhereMessage: (r: { kicked: boolean }) => (r.kicked ? 'Signed out everywhere — open monitors and calls on your other devices were disconnected.' : 'Signed out everywhere.'),
  // Settings → Security (views/account/SecurityPanel.tsx)
  failed: (r: { ok: boolean }) => r.ok === false,
  mfaStatus: vi.fn(async () => ({ ok: true, on: false, factors: [], aal: 'aal1' })),
  listMyDevices: vi.fn(async () => ({ ok: true, devices: [] })),
  listSecurityEvents: vi.fn(async () => ({ ok: true, events: [] })),
  stepUpNeeded: vi.fn(async () => false),
  registerSecondStepOpener: vi.fn(),
}));
// The server's answer (GET /api/account/studios) — the name for people who aren't members yet.
vi.mock('../components/StudiosCard', () => ({
  StudiosCard: () => null,
  useAccountAccess: () => ({ account: { id: 'u1', email: 'ada@example.com', name: 'Ada Lovelace', username: 'ada_1', since: null, plan: null, admin: false }, confined: false, studios: [] }),
}));
vi.mock('../sync', () => ({
  fetchStudioAccess: vi.fn(async () => ({ signedIn: true, allowed: true, scope: 'full' })),
  pullPrefsFromCloud: vi.fn(async () => false),
  pushPrefsToCloud: vi.fn(async () => undefined),
  syncMyEvents: vi.fn(async () => undefined),
}));
vi.mock('../driveUpload', () => ({
  DRIVE_PRIVACY_NOTE: '',
  DriveError: class DriveError extends Error {},
  connectDrive: vi.fn(),
  disconnectDrive: vi.fn(),
  driveErrorMessage: () => '',
  getDriveStatus: vi.fn(),
  openConsentWindow: () => null,
  useDriveStatus: () => null,
}));
vi.mock('../saveTargets', () => ({
  canPickFolder: () => false,
  forgetDriveFolder: vi.fn(async () => undefined),
  getDriveFolder: vi.fn(async () => null),
  pickDriveFolder: vi.fn(async () => null),
}));

import { SettingsView } from './SettingsView';
import { loadPrefs, savePrefs } from '../prefs';

const nav = { dashboard: vi.fn() } as unknown as Nav;

describe('SettingsView — one account name', () => {
  beforeEach(() => {
    localStorage.clear();
    acct.updateDisplayName.mockClear();
    acct.current = { status: 'needs_code', userId: 'u1', email: 'ada@example.com' };
  });

  it('lets someone without the welcome code yet see and change their one name', async () => {
    const push = vi.fn();
    render(<SettingsView nav={nav} push={push} />);
    const input = (await screen.findByLabelText('Your name')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('Ada Lovelace'));
    expect(screen.getByText(/@ada_1 stays your sign-in handle/)).toBeTruthy();
    expect(screen.getByText(/family and nursery members see it/)).toBeTruthy();

    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled(); // unchanged
    fireEvent.change(input, { target: { value: '  Ada   King ' } });
    fireEvent.click(save);
    await waitFor(() => expect(acct.updateDisplayName).toHaveBeenCalledWith('Ada King'));
    await waitFor(() => expect(push).toHaveBeenCalledWith('Name updated in every studio', { icon: 'check' }));
  });

  it('lets an on-stream name that was only a copy of the old name follow the rename', async () => {
    acct.current = { status: 'member', userId: 'u1', email: 'ada@example.com', name: 'Ada Lovelace' };
    savePrefs({ ...loadPrefs(), hostName: 'Ada Lovelace' });
    render(<SettingsView nav={nav} push={vi.fn()} />);
    const input = (await screen.findByLabelText('Your name')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Ada King' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(loadPrefs().hostName).toBe(''));
  });

  it('keeps an on-stream name the host chose on purpose', async () => {
    acct.current = { status: 'member', userId: 'u1', email: 'ada@example.com', name: 'Ada Lovelace' };
    savePrefs({ ...loadPrefs(), hostName: 'DJ Ada' });
    render(<SettingsView nav={nav} push={vi.fn()} />);
    const input = (await screen.findByLabelText('Your name')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Ada King' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(acct.updateDisplayName).toHaveBeenCalled());
    expect(loadPrefs().hostName).toBe('DJ Ada');
  });
});

describe('SettingsView — Usage (ADR 0007 Phase B6)', () => {
  beforeEach(() => {
    localStorage.clear();
    location.hash = '';
  });

  it('opens straight to Usage from Help (#/settings?s=usage) and loads the card there', async () => {
    acct.current = { status: 'member', userId: 'u1', email: 'ada@example.com', name: 'Ada Lovelace' };
    location.hash = '#/settings?s=usage';
    render(<SettingsView nav={nav} push={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Usage' })).toBeTruthy();
    expect(screen.getByText(/You’re never charged\. It loads when you open this page\./)).toBeTruthy();
    expect(screen.getByLabelText('Usage this month')).toBeTruthy();
  });

  it('is in the list of sections, and its card asks nothing while signed out', async () => {
    acct.current = { status: 'signed_out' };
    render(<SettingsView nav={nav} push={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Usage' }));
    expect(await screen.findByText(/Sign in to see your calls and 7-day copies here/)).toBeTruthy();
  });

  it('the 7-day copy toggle says what it uses before it is turned on', () => {
    location.hash = '#/settings?s=recording';
    render(<SettingsView nav={nav} push={vi.fn()} />);
    expect(screen.getByText(/Each recorded hour at .* uses ≈ .* GB of your upload and our storage — kept 7 days, up to 10 GB per account/)).toBeTruthy();
  });
});

describe('SettingsView — sign out (ADR 0006 WS-5)', () => {
  let confirmSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    localStorage.clear();
    location.hash = '';
    acct.current = { status: 'member', userId: 'u1', email: 'ada@example.com', name: 'Ada Lovelace' };
    acct.signOutThisDevice.mockClear();
    acct.signOutEverywhere.mockClear();
    confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  });
  afterEach(() => confirmSpy.mockRestore());

  it('"Sign out of this device" signs out here only', async () => {
    const push = vi.fn();
    render(<SettingsView nav={nav} push={push} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out of this device' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('Signed out on this device', { icon: 'check' }));
    expect(acct.signOutThisDevice).toHaveBeenCalledOnce();
    expect(acct.signOutEverywhere).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('"Sign out everywhere" warns about a nursery camera, then signs out every session and says what happened', async () => {
    const push = vi.fn();
    render(<SettingsView nav={nav} push={push} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));
    await waitFor(() => expect(acct.signOutEverywhere).toHaveBeenCalledOnce());
    expect(confirmSpy.mock.calls[0][0]).toMatch(/including a phone running as a nursery camera/);
    await waitFor(() =>
      expect(push).toHaveBeenCalledWith('Signed out everywhere — open monitors and calls on your other devices were disconnected.', { icon: 'check', duration: 7000 }),
    );
    expect(acct.signOutThisDevice).not.toHaveBeenCalled();
  });

  it('cancelling "Sign out everywhere" changes nothing', async () => {
    confirmSpy.mockReturnValue(false);
    render(<SettingsView nav={nav} push={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out everywhere' }));
    await new Promise((r) => setTimeout(r, 0));
    expect(acct.signOutEverywhere).not.toHaveBeenCalled();
  });

  it('a sign-in that still owes the two-step code says so, with the code and sign-out', async () => {
    acct.current = { status: 'needs_mfa', userId: 'u1', email: 'ada@example.com' };
    render(<SettingsView nav={nav} push={vi.fn()} />);
    expect(await screen.findByText('Finish signing in')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enter code' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(acct.signOutThisDevice).toHaveBeenCalledOnce());
  });

  it('has a Security section with two-step sign-in, devices and recent activity', async () => {
    location.hash = '#/settings?s=security';
    render(<SettingsView nav={nav} push={vi.fn()} />);
    expect(await screen.findByRole('heading', { name: 'Security' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Turn on two-step sign-in' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Your devices' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Recent security activity' })).toBeTruthy();
  });

  it('asks a signed-out visitor to sign in before showing security settings', () => {
    acct.current = { status: 'signed_out' };
    location.hash = '#/settings?s=security';
    render(<SettingsView nav={nav} push={vi.fn()} />);
    expect(screen.getByText(/Sign in to turn on two-step sign-in/)).toBeTruthy();
  });
});
