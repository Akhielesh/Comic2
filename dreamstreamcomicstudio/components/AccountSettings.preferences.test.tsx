// navtheme NT-2c (its Appearance part): Settings → Preferences is the permanent home of Appearance, the same control as
// the account menu's (Light, Dark, Paper, System), with Paper offered only where Comic Studio's Paper look applies (the
// comics host). The tab names it, and it shows no money.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ comicsHost: false }));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: '11111111-2222-3333-4444-555555555555', email: 'reader.one@dreamstream.test' },
    signOut: vi.fn(),
    signOutAll: vi.fn(),
    signOutOthers: vi.fn(),
    resendVerificationEmail: vi.fn(),
    changePassword: vi.fn()
  })
}));
vi.mock('../services/supabase', () => ({
  supabase: { storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: '' } }) }) } }
}));
vi.mock('../services/db', () => ({
  getPrivateProfile: vi.fn(async () => ({ id: 'u', dob: '1990-01-01', phone_number: '', first_name: 'Reader', last_name: 'One' })),
  getUserProfile: vi.fn(async () => ({ id: 'u', username: 'reader_one', avatar_url: '' })),
  saveImage: vi.fn(),
  saveAvatarImage: vi.fn(),
  savePublicContactMessage: vi.fn(),
  syncMarketingConsentLegacy: vi.fn(),
  updateUserProfile: vi.fn(),
  upsertPrivateProfile: vi.fn()
}));
vi.mock('../services/billing', () => ({
  getAdminAccess: vi.fn(async () => ({ isAdmin: false, isModerator: false })),
  getBillingSummary: vi.fn(async () => {
    throw new Error('offline');
  })
}));
vi.mock('../services/deviceSessions', () => ({ listDevices: vi.fn(async () => []), removeDevice: vi.fn(), currentDeviceId: () => 'device-1' }));
vi.mock('../services/studioAccessApi', () => ({ fetchAccountAccess: vi.fn(async () => null) }));
vi.mock('../services/invites', () => ({ getReferral: vi.fn(async () => null), sendReferral: vi.fn() }));
vi.mock('../services/productHost', async (orig) => ({ ...(await orig<object>()), isComicsHost: () => h.comicsHost }));
vi.mock('./admin/AdminConsole', () => ({ AdminConsole: () => null }));
vi.mock('./ApiConfiguration', () => ({ ApiConfiguration: () => null }));
vi.mock('./account/StudiosAccess', () => ({ StudiosAccess: () => null }));
vi.mock('./RedeemInvite', () => ({ RedeemInvite: () => null }));

const { AccountSettings } = await import('./AccountSettings');

const root = document.documentElement;

beforeEach(() => {
  h.comicsHost = false;
  window.history.replaceState({}, '', '/');
  window.sessionStorage.clear();
  localStorage.clear();
});

afterEach(() => {
  vi.clearAllMocks();
  root.classList.remove('dark', 'ds-no-transitions');
  root.removeAttribute('data-comic-theme');
});

const openPreferences = async () => {
  const view = render(<AccountSettings onClose={() => undefined} initialTab="preferences" />);
  await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Preferences' })).toBeInTheDocument());
  return view;
};
const card = () => screen.getByRole('heading', { level: 3, name: 'Appearance' }).closest('div') as HTMLElement;
const choices = () => within(card()).getAllByRole('radio').map((r) => r.textContent);

describe('Settings › Preferences: Appearance', () => {
  it('opens with an Appearance card, before Generation Cost, with Light, Dark and System off the comics host', async () => {
    await openPreferences();
    expect(within(card()).getByRole('radiogroup', { name: 'Appearance' })).toBeInTheDocument();
    expect(choices()).toEqual(['Light', 'Dark', 'System']);
    const cost = screen.getByRole('heading', { level: 3, name: 'Generation Cost' });
    expect(card().compareDocumentPosition(cost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('offers Paper on the comics host', async () => {
    h.comicsHost = true;
    await openPreferences();
    expect(choices()).toEqual(['Light', 'Dark', 'Paper', 'System']);
  });

  it('choosing Dark puts .dark on <html> at once, with no Save press', async () => {
    await openPreferences();
    fireEvent.click(within(card()).getByRole('radio', { name: 'Dark' }));
    expect(root.classList.contains('dark')).toBe(true);
    expect(within(card()).getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    expect(localStorage.getItem('ds.theme.v1')).toBe('dark');
  });

  it('the tab says what it holds', async () => {
    await openPreferences();
    expect(screen.getAllByText('Appearance, generation cost policy and email.').length).toBeGreaterThan(0);
  });

  it('shows no money: no "$" and no cents anywhere in the tab', async () => {
    const { container } = await openPreferences();
    const tab = container.querySelector('h2')!.parentElement as HTMLElement;
    expect(tab.textContent).not.toMatch(/\$|¢|\bcents?\b/i);
  });
});
