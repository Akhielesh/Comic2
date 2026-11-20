// The account menu shows the @handle and the photo it remembered from the profile row (components/account). Settings is
// where both change, so what Settings reads and what it saves is what the menu shows next: a handle or photo changed
// here (or elsewhere) never waits for a reload to reach the trigger and the panel.
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const USER_ID = '11111111-2222-3333-4444-555555555555';
const PHOTO_A = 'https://cdn.example.invalid/avatars/a.png';
const h = vi.hoisted(() => ({
  row: { id: '', username: 'reader_one', avatar_url: '' } as { id: string; username: string; avatar_url: string },
  updateUserProfile: vi.fn(async () => undefined),
  saveAvatarImage: vi.fn(async () => 'avatars/b.png')
}));

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
  supabase: { storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.example.invalid/${p}` } }) }) } }
}));
vi.mock('../services/db', () => ({
  getPrivateProfile: vi.fn(async () => ({ id: 'u', dob: '1990-01-01', phone_number: '', first_name: 'Reader', last_name: 'One' })),
  getUserProfile: vi.fn(async () => ({ ...h.row })),
  saveImage: vi.fn(),
  saveAvatarImage: h.saveAvatarImage,
  savePublicContactMessage: vi.fn(),
  syncMarketingConsentLegacy: vi.fn(),
  updateUserProfile: h.updateUserProfile,
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
vi.mock('./admin/AdminConsole', () => ({ AdminConsole: () => null }));
vi.mock('./ApiConfiguration', () => ({ ApiConfiguration: () => null }));
vi.mock('./account/StudiosAccess', () => ({ StudiosAccess: () => null }));
vi.mock('./RedeemInvite', () => ({ RedeemInvite: () => null }));

const { AccountSettings } = await import('./AccountSettings');
const { forgetRememberedProfiles, rememberProfile, usePersonWithProfile } = await import('./account/AccountContext');

/** What the account menu would show for this person: the remembered handle and photo. */
function MenuFace() {
  const person = usePersonWithProfile({ id: USER_ID, name: 'Reader One', initial: 'R' });
  return <p data-testid="face">{`@${person?.username ?? '-'} ${person?.avatarUrl ?? 'no photo'}`}</p>;
}

const face = () => screen.getByTestId('face').textContent;

const openProfile = async () => {
  render(
    <>
      <MenuFace />
      <AccountSettings onClose={() => undefined} initialTab="profile" />
    </>
  );
  await waitFor(() => expect(screen.getByLabelText(/Username/)).toHaveValue(h.row.username));
};

beforeEach(() => {
  h.row = { id: USER_ID, username: 'reader_one', avatar_url: PHOTO_A };
  h.updateUserProfile.mockReset().mockResolvedValue(undefined);
  h.saveAvatarImage.mockReset().mockResolvedValue('avatars/b.png');
  window.history.replaceState({}, '', '/');
  window.sessionStorage.clear();
  localStorage.clear();
  rememberProfile(USER_ID, { username: 'reader_one', avatarUrl: PHOTO_A });
});

afterEach(() => {
  vi.clearAllMocks();
  forgetRememberedProfiles();
});

const pickPhoto = async () => {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: [new File(['x'], 'me.png', { type: 'image/png' })], configurable: true });
  fireEvent.change(input);
  await waitFor(() => expect(h.saveAvatarImage).toHaveBeenCalledTimes(1));
  // The form shows the new photo (not saved yet).
  await waitFor(() => expect(document.querySelector('img[src="https://cdn.example.invalid/avatars/b.png"]')).not.toBeNull());
};

describe('Settings › Profile keeps the account menu’s face current', () => {
  it('what Settings reads replaces what the menu remembered (a handle or photo changed since the menu read it)', async () => {
    h.row = { id: USER_ID, username: 'reader_renamed', avatar_url: 'https://cdn.example.invalid/avatars/elsewhere.png' };
    await openProfile();
    expect(face()).toBe('@reader_renamed https://cdn.example.invalid/avatars/elsewhere.png');
  });

  it('a saved handle and photo reach the menu at once; an unsaved one does not', async () => {
    await openProfile();
    expect(face()).toBe(`@reader_one ${PHOTO_A}`);
    await pickPhoto();
    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: 'reader_two' } });
    // Not saved yet: the menu still shows what the account has.
    expect(face()).toBe(`@reader_one ${PHOTO_A}`);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    });
    await screen.findByText('Profile updated successfully.');
    expect(h.updateUserProfile).toHaveBeenCalledWith(USER_ID, { username: 'reader_two', avatar_url: 'https://cdn.example.invalid/avatars/b.png' });
    expect(face()).toBe('@reader_two https://cdn.example.invalid/avatars/b.png');
  });

  it('a save that fails leaves the menu showing what the account still has', async () => {
    h.updateUserProfile.mockRejectedValue(new Error('Username is taken.'));
    await openProfile();
    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: 'reader_two' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
    });
    await screen.findByText('Username is taken.');
    expect(face()).toBe(`@reader_one ${PHOTO_A}`);
  });
});
