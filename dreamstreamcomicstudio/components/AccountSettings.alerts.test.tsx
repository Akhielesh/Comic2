// Settings → Preferences (notify NF-5): the Alerts card is the first card of the tab, above Generation Cost.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({
  user: { id: '11111111-2222-3333-4444-555555555555', email: 'reader.one@dreamstream.test' } as { id: string; email: string } | null,
  getReferral: vi.fn(),
  avatarUrl: '',
  adminAccess: vi.fn(async () => ({ isAdmin: false, isModerator: false })),
  saveAvatarImage: vi.fn(async () => 'avatars/new.png')
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: h.user,
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
  getUserProfile: vi.fn(async () => ({ id: 'u', username: 'reader_one', avatar_url: h.avatarUrl })),
  saveImage: vi.fn(),
  saveAvatarImage: h.saveAvatarImage,
  savePublicContactMessage: vi.fn(),
  syncMarketingConsentLegacy: vi.fn(),
  updateUserProfile: vi.fn(),
  upsertPrivateProfile: vi.fn()
}));
vi.mock('../services/billing', () => ({
  getAdminAccess: h.adminAccess,
  getBillingSummary: vi.fn(async () => {
    throw new Error('offline');
  })
}));
vi.mock('../services/deviceSessions', () => ({
  listDevices: vi.fn(async () => []),
  removeDevice: vi.fn(),
  currentDeviceId: () => 'device-1'
}));
vi.mock('../services/studioAccessApi', () => ({ fetchAccountAccess: vi.fn(async () => null) }));
vi.mock('../services/invites', () => ({ getReferral: h.getReferral, sendReferral: vi.fn() }));
vi.mock('./admin/AdminConsole', () => ({ AdminConsole: () => null }));
vi.mock('./ApiConfiguration', () => ({ ApiConfiguration: () => null }));
vi.mock('./account/StudiosAccess', () => ({ StudiosAccess: () => null }));
vi.mock('./RedeemInvite', () => ({ RedeemInvite: () => null }));

const { AccountSettings } = await import('./AccountSettings');

beforeEach(() => {
  window.localStorage.clear();
  h.adminAccess.mockResolvedValue({ isAdmin: false, isModerator: false });
  h.getReferral.mockResolvedValue({ url: 'https://dreamstream.test/join/r-abc', used: 0, max: 5, invited: [], joinedViaLink: 0 });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Settings → Preferences', () => {
  it('shows the Alerts card first, above Generation Cost', async () => {
    render(<AccountSettings onClose={() => undefined} initialTab="preferences" />);
    const alerts = await screen.findByRole('heading', { name: 'Alerts' });
    const cost = screen.getByRole('heading', { name: 'Generation Cost' });
    expect(alerts.compareDocumentPosition(cost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Play a chime' })).toBeInTheDocument();
  });
});
