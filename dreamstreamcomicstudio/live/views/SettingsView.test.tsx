import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Nav } from '../nav';

const acct = vi.hoisted(() => ({
  current: { status: 'needs_code', userId: 'u1', email: 'ada@example.com' } as Record<string, unknown>,
  updateDisplayName: vi.fn(async (name: string) => ({ ok: true, name })),
}));
vi.mock('../account', () => ({
  useAccount: () => acct.current,
  updateDisplayName: acct.updateDisplayName,
  openAuth: vi.fn(),
  signOutEverywhereLocal: vi.fn(async () => undefined),
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
