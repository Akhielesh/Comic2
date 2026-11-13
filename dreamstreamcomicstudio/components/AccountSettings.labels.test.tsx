// FX-6 (Program 6, P6-A; sweep finding F2): every Settings field is found by its visible label, the photo upload
// is a real button a keyboard can reach, and no field shows a made-up person or an example.com address as a hint
// (PU-3). Before FX-6, Chromium's accessibility tree gave Email, Date of birth and the invite link no name at all,
// named Username and Phone by their placeholders ("Super_hero", "+1 555 123 4567"), and the photo upload was a
// <label> around a display:none input that no keyboard could reach. The phone layout (the profile row stacks, the
// section list is one row of chips) is measured in Chromium by tests/e2e/a11y.spec.ts.
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

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

const INVITE_URL = 'https://dreamstream.test/join/r-abc';

beforeEach(() => {
  h.user = { id: '11111111-2222-3333-4444-555555555555', email: 'reader.one@dreamstream.test' };
  h.getReferral.mockReset();
  h.avatarUrl = '';
  h.adminAccess.mockReset();
  h.adminAccess.mockResolvedValue({ isAdmin: false, isModerator: false });
  h.getReferral.mockResolvedValue({ url: INVITE_URL, used: 0, max: 5, invited: [], joinedViaLink: 0 });
  window.history.replaceState({}, '', '/');
  try {
    window.sessionStorage.clear();
  } catch {
    /* no storage */
  }
});

afterEach(() => vi.clearAllMocks());

const openProfile = async () => {
  render(<AccountSettings onClose={() => undefined} initialTab="profile" />);
  await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: 'Profile' })).toBeInTheDocument());
};

describe('Settings › Profile: every field is named by its own label (FX-6)', () => {
  it('Username, Email, Name, Phone and Date of birth are found by their label text', async () => {
    await openProfile();
    expect(screen.getByLabelText(/^Username/)).toHaveValue('reader_one');
    expect(screen.getByLabelText(/^Email$/)).toHaveTextContent('reader.one@dreamstream.test');
    expect(screen.getByLabelText(/^Name/)).toBeInTheDocument();
    expect(screen.getByLabelText(/^Phone number/i)).toHaveAttribute('type', 'tel');
    expect(screen.getByLabelText(/^Date of birth/i)).toHaveValue('1990-01-01');
  });

  it('the invite link is found by its label', async () => {
    await openProfile();
    await waitFor(() => expect(screen.getByLabelText('Your invite link')).toHaveValue(INVITE_URL));
    expect(screen.getByLabelText(/email them directly/i).tagName).toBe('TEXTAREA');
  });

  it('a disabled Copy says why (the link could not be loaded)', async () => {
    h.getReferral.mockRejectedValue(new Error('offline'));
    await openProfile();
    const copy = await screen.findByRole('button', { name: /copy/i });
    await waitFor(() => expect(copy).toBeDisabled());
    expect(copy).toHaveAccessibleDescription(/no link to copy/i);
  });

  it('the photo upload is a focusable button with a name that opens the file picker', async () => {
    await openProfile();
    const upload = screen.getByRole('button', { name: /profile photo/i });
    upload.focus();
    expect(document.activeElement).toBe(upload);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(input).not.toBeNull();
    const click = vi.spyOn(input as HTMLInputElement, 'click');
    fireEvent.click(upload);
    expect(click).toHaveBeenCalledTimes(1);
    // The input itself stays out of the tab order: the button is the one way in.
    expect(input).toHaveAttribute('tabindex', '-1');
  });

  it('the section list names the current section', async () => {
    await openProfile();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getByRole('button', { name: /Profile/ })).toHaveAttribute('aria-current', 'page');
  });
});

describe('Settings › Contact and Security: labels are tied to their fields (FX-6)', () => {
  it('Contact: email, phone and message', async () => {
    render(<AccountSettings onClose={() => undefined} initialTab="contact" />);
    expect(await screen.findByLabelText('Your Email')).toHaveValue('reader.one@dreamstream.test');
    expect(screen.getByLabelText(/^Phone Number \(Optional\)/)).toHaveAttribute('type', 'tel');
    expect(screen.getByLabelText(/^Message/).tagName).toBe('TEXTAREA');
  });

  it('Security: new and confirmed password', async () => {
    render(<AccountSettings onClose={() => undefined} initialTab="security" />);
    expect(await screen.findByLabelText('New Password')).toHaveAttribute('type', 'password');
    expect(screen.getByLabelText('Confirm Password')).toHaveAttribute('type', 'password');
  });
});

describe('Settings hints show no made-up people (6B fold PU-3)', () => {
  const MADE_UP = /@|example\.(com|org|net)|super[ _]?hero|\bjohn\b|\bjane\b|\bdoe\b|friend/i;
  for (const file of ['components/AccountSettings.tsx', 'components/InviteFriends.tsx']) {
    it(`no placeholder in ${file} holds a made-up person or an example.com address`, () => {
      const source = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
      const placeholders = [...source.matchAll(/placeholder=(?:"([^"]*)"|\{['`"]([^'`"]*)['`"]\})/g)].map((m) => m[1] ?? m[2] ?? '');
      expect(placeholders.filter((p) => MADE_UP.test(p))).toEqual([]);
    });
  }
});

describe('Settings › Profile: the email, the photo and the chip row (FX-6 review fixes)', () => {
  it('the sign-in email is read-only text that wraps, can take focus and shows the whole address', async () => {
    const long = 'alexandra.reader-thompson.longname@dreamstream.test';
    h.user = { id: '11111111-2222-3333-4444-555555555555', email: long };
    await openProfile();
    const email = screen.getByRole('textbox', { name: 'Email' });
    // Not a disabled <input>: an input cannot wrap, and a disabled one cannot be focused, scrolled or selected.
    expect(email.tagName).not.toBe('INPUT');
    expect(email).toHaveAttribute('aria-readonly', 'true');
    expect(email).toHaveTextContent(long);
    expect(email.className).toContain('[overflow-wrap:anywhere]');
    email.focus();
    expect(document.activeElement).toBe(email);
  });

  it('with a photo, "View profile photo" opens the preview, its ring sits inside the round frame, and Close shuts it', async () => {
    h.avatarUrl = 'https://dreamstream.test/a.png';
    await openProfile();
    const view = await screen.findByRole('button', { name: 'View profile photo' });
    // The frame is overflow-hidden: an outline drawn outside the button would be clipped away.
    expect(view.className).toContain('focus-visible:outline-offset-[-4px]');
    expect(view.className).not.toContain('focus-visible:outline-offset-2');
    expect(screen.getByRole('button', { name: 'Change profile photo' })).toBeInTheDocument();
    fireEvent.click(view);
    const close = await screen.findByRole('button', { name: 'Close photo preview' });
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close photo preview' })).toBeNull());
  });

  it('picking the same photo twice uploads it twice (the input is reset after each pick)', async () => {
    await openProfile();
    const input = document.querySelector<HTMLInputElement>('input[type="file"]') as HTMLInputElement;
    const file = new File(['x'], 'me.png', { type: 'image/png' });
    // Record what the handler writes to value (jsdom's file input always reads back '').
    const writes: string[] = [];
    Object.defineProperty(input, 'value', { configurable: true, get: () => '', set: (v: string) => void writes.push(v) });
    const pick = () => {
      Object.defineProperty(input, 'files', { value: [file], configurable: true });
      fireEvent.change(input);
    };
    pick();
    await waitFor(() => expect(h.saveAvatarImage).toHaveBeenCalledTimes(1));
    // A browser only fires change for the same file again when value was cleared; the handler must clear it.
    expect(writes).toEqual(['']);
    pick();
    await waitFor(() => expect(h.saveAvatarImage).toHaveBeenCalledTimes(2));
    expect(writes).toEqual(['', '']);
  });

  it('a disabled Copy says why while the link is still loading', async () => {
    h.getReferral.mockReturnValue(new Promise(() => undefined));
    await openProfile();
    const copy = await screen.findByRole('button', { name: /copy/i });
    expect(copy).toBeDisabled();
    expect(copy).toHaveAccessibleDescription('No link to copy yet: it is still loading.');
  });

  // jsdom has no layout: give the chip row a width (375 px phone, or 1024 px when it is a desktop column) and record
  // what the effect sets. Returns a restore function.
  const fakeRowLayout = (rowWidth: { value: number }) => {
    const proto = HTMLElement.prototype;
    const saved = ['scrollWidth', 'clientWidth', 'offsetLeft', 'offsetWidth', 'scrollLeft'].map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
    const scrolled = new WeakMap<HTMLElement, number>();
    const isRow = (el: HTMLElement) => el.getAttribute('aria-label') === 'Settings sections';
    Object.defineProperty(proto, 'scrollWidth', { configurable: true, get() { return isRow(this) ? 915 : 0; } });
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get() { return isRow(this) ? rowWidth.value : 0; } });
    Object.defineProperty(proto, 'offsetLeft', { configurable: true, get() { return this.getAttribute('aria-current') === 'page' ? 700 : 0; } });
    Object.defineProperty(proto, 'offsetWidth', { configurable: true, get() { return this.getAttribute('aria-current') === 'page' ? 120 : 0; } });
    Object.defineProperty(proto, 'scrollLeft', { configurable: true, get() { return scrolled.get(this) ?? 0; }, set(v: number) { scrolled.set(this, v); } });
    return () => {
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(proto, k, d);
        else delete (proto as unknown as Record<string, unknown>)[k];
      }
    };
  };

  it('turning a tablet to phone width (crossing md) brings the current chip into view', async () => {
    const listeners: Array<() => void> = [];
    const realMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: (_: string, fn: () => void) => void listeners.push(fn),
      removeEventListener: (_: string, fn: () => void) => void listeners.splice(listeners.indexOf(fn), 1),
      addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false
    })) as unknown as typeof window.matchMedia;
    const width = { value: 1024 };
    const restore = fakeRowLayout(width);
    try {
      render(<AccountSettings onClose={() => undefined} initialTab="legal" />);
      const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
      expect(nav.scrollLeft).toBe(0); // a column at 1024: nothing to scroll
      width.value = 375;
      for (const fn of [...listeners]) fn();
      expect(nav.scrollLeft).toBe(572.5);
    } finally {
      restore();
      window.matchMedia = realMatchMedia;
    }
  });

  it('a phone deep link to the Admin Console scrolls its chip into view once admin access arrives', async () => {
    let grant: (v: { isAdmin: boolean; isModerator: boolean }) => void = () => undefined;
    h.adminAccess.mockReturnValue(new Promise((resolve) => (grant = resolve)));
    const restore = fakeRowLayout({ value: 375 });
    try {
      render(<AccountSettings onClose={() => undefined} initialTab="admin" />);
      const nav = await screen.findByRole('navigation', { name: 'Settings sections' });
      expect(nav.scrollLeft).toBe(0);
      grant({ isAdmin: true, isModerator: false });
      await waitFor(() => expect(within(nav).getByRole('button', { name: /Admin Console/ })).toHaveAttribute('aria-current', 'page'));
      // centre the 120 px chip at x = 700 in a 375 px row: 700 - (375 - 120) / 2
      await waitFor(() => expect(nav.scrollLeft).toBe(572.5));
    } finally {
      restore();
    }
  });
});
