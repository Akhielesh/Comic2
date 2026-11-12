// authz-data-5: admin / moderator come only from the server's admin flag (/api/admin/me). The
// settings screen used to fall back to `user.email === 'admin@test.com'` whenever that check
// failed, handing the admin console to anyone who could sign in with that address while the
// API was down or slow. Rendered with every network-facing module faked.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({
  user: { id: '11111111-2222-3333-4444-555555555555', email: 'admin@test.com' } as { id: string; email: string } | null,
  getAdminAccess: vi.fn()
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
  getPrivateProfile: vi.fn(async () => null),
  getUserProfile: vi.fn(async () => null),
  saveImage: vi.fn(),
  saveAvatarImage: vi.fn(),
  savePublicContactMessage: vi.fn(),
  syncMarketingConsentLegacy: vi.fn(),
  updateUserProfile: vi.fn(),
  upsertPrivateProfile: vi.fn()
}));
vi.mock('../services/billing', () => ({
  getAdminAccess: h.getAdminAccess,
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
vi.mock('./admin/AdminConsole', () => ({ AdminConsole: () => <div>ADMIN CONSOLE MOUNTED</div> }));
vi.mock('./ApiConfiguration', () => ({ ApiConfiguration: () => null }));
vi.mock('./account/StudiosAccess', () => ({ StudiosAccess: () => null }));
vi.mock('./InviteFriends', () => ({ InviteFriends: () => null }));
vi.mock('./RedeemInvite', () => ({ RedeemInvite: () => null }));

const { AccountSettings } = await import('./AccountSettings');

beforeEach(() => {
  h.user = { id: '11111111-2222-3333-4444-555555555555', email: 'admin@test.com' };
  h.getAdminAccess.mockReset();
  window.history.replaceState({}, '', '/');
  try {
    window.sessionStorage.clear();
  } catch {
    /* no storage */
  }
});

afterEach(() => vi.clearAllMocks());

describe('AccountSettings admin access', () => {
  it('admin@test.com with a failed admin check is NOT an admin (no nav entry, no console)', async () => {
    h.getAdminAccess.mockRejectedValue(new Error('503 Service Unavailable'));
    render(<AccountSettings onClose={() => undefined} initialTab="admin" />);
    await waitFor(() => expect(screen.getByText('No admin access')).toBeTruthy());
    expect(h.getAdminAccess).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('ADMIN CONSOLE MOUNTED')).toBeNull();
    expect(screen.queryAllByRole('button', { name: /Admin Console/i })).toHaveLength(0);
  });

  it('admin@test.com whom the server says is not an admin is not an admin', async () => {
    h.getAdminAccess.mockResolvedValue({ isAdmin: false, isModerator: false });
    render(<AccountSettings onClose={() => undefined} initialTab="admin" />);
    await waitFor(() => expect(screen.getByText('No admin access')).toBeTruthy());
    expect(screen.queryByText('ADMIN CONSOLE MOUNTED')).toBeNull();
  });

  it('the server admin flag (and only it) opens the console, whatever the email', async () => {
    h.user = { id: '99999999-2222-3333-4444-555555555555', email: 'someone@example.com' };
    h.getAdminAccess.mockResolvedValue({ isAdmin: true, isModerator: false });
    render(<AccountSettings onClose={() => undefined} initialTab="admin" />);
    await waitFor(() => expect(screen.getByText('ADMIN CONSOLE MOUNTED')).toBeTruthy());
    // The nav entry the negative cases look for really is a button when access is granted.
    expect(screen.queryAllByRole('button', { name: /Admin Console/i }).length).toBeGreaterThan(0);
  });
});
