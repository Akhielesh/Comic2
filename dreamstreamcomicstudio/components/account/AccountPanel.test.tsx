// @vitest-environment jsdom
// The account panel (navtheme NT-1): who you are, Appearance, the Settings rows (each opening the DreamStream settings
// inside the app at its tab, with the resume point), Help, and Sign out (the same two calls Settings makes). Anchored
// from 600 px, the studio's bottom sheet below that; Esc and a press outside close it and focus returns to the trigger.
import React, { useRef, useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ calls: [] as string[], signOut: vi.fn() }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: null, signOut: auth.signOut })
}));
const db = vi.hoisted(() => ({ getProfileFace: vi.fn() }));
vi.mock('../../services/db', () => ({ getProfileFace: db.getProfileFace }));

import { AccountPanel, type AccountPanelProps } from './AccountPanel';
import { AccountMenu } from './AccountMenu';
import { AccountProvider, forgetRememberedProfiles, type AccountContextValue, type AccountPerson } from './AccountContext';
import { ACCOUNT_SETTINGS_EVENT } from './accountNav';
import { FormFactorProvider } from '../comicstudio/mobile/useFormFactor';
import { DESKTOP_FORM_FACTOR, classifyViewport } from '../comicstudio/mobile/formFactor';

/** A 360 × 740 phone (compact width, coarse pointer). */
const PHONE = { ...DESKTOP_FORM_FACTOR, width: 360, height: 740, ...classifyViewport({ w: 360, h: 740, coarse: true }), coarse: true, anyFine: false, hover: false };

const PERSON: AccountPerson = { id: 'person-1', name: 'Ada Example', initial: 'A', username: 'ada_draws', avatarUrl: null };

const ctx = (over: Partial<AccountContextValue> = {}): AccountContextValue => ({
  person: PERSON,
  staff: false,
  onSignedOut: vi.fn(() => auth.calls.push('onSignedOut')),
  ...over
});

/** A trigger and the panel, opened and closed the way AccountMenu does it. */
function Harness({ value, panel }: { value: AccountContextValue; panel?: Partial<AccountPanelProps> }) {
  const [open, setOpen] = useState(true);
  const anchor = useRef<HTMLButtonElement>(null);
  return (
    <AccountProvider value={value}>
      <button ref={anchor} type="button" onClick={() => setOpen((v) => !v)}>
        trigger
      </button>
      <button type="button">elsewhere</button>
      {open && <AccountPanel anchorRef={anchor} onClose={() => setOpen(false)} paper {...panel} />}
    </AccountProvider>
  );
}

const requests: unknown[] = [];
const onRequest = (e: Event) => {
  requests.push((e as CustomEvent).detail);
  e.preventDefault();
};

beforeEach(() => {
  auth.calls.length = 0;
  auth.signOut.mockReset().mockImplementation(async () => {
    auth.calls.push('signOut');
  });
  db.getProfileFace.mockReset().mockResolvedValue({ id: 'person-1', username: 'ada_now', avatar_url: null });
  requests.length = 0;
  window.addEventListener(ACCOUNT_SETTINGS_EVENT, onRequest);
});

afterEach(() => {
  window.removeEventListener(ACCOUNT_SETTINGS_EVENT, onRequest);
  cleanup();
  forgetRememberedProfiles();
  localStorage.clear();
  document.documentElement.classList.remove('dark', 'ds-no-transitions');
  vi.restoreAllMocks();
});

const panel = () => screen.getByRole('dialog', { name: 'Account and settings' });
const rowNames = () =>
  within(panel())
    .getAllByRole('button')
    .map((b) => b.textContent?.trim());

describe('AccountPanel', () => {
  it('lists the person, Appearance, the Settings rows, Help and Sign out, in that order; no address', () => {
    render(<Harness value={ctx()} />);
    const p = panel();
    expect(within(p).getByText('Ada Example')).toBeInTheDocument();
    expect(within(p).getByText('@ada_draws')).toBeInTheDocument();
    const group = within(p).getByRole('radiogroup', { name: 'Appearance' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Light', 'Dark', 'Paper', 'System']);
    expect(rowNames()).toEqual(['Profile', 'Usage and API keys', 'Preferences', 'Security', 'Help', 'Sign out']);
    expect(p.textContent).not.toMatch(/@\S+\.\S+/);
    // Appearance comes before the rows, the person before Appearance.
    const order = [within(p).getByText('Ada Example'), group, within(p).getByRole('button', { name: 'Profile' })];
    expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('Admin console is listed for staff only, after Help', () => {
    render(<Harness value={ctx({ staff: true })} />);
    expect(rowNames()).toEqual(['Profile', 'Usage and API keys', 'Preferences', 'Security', 'Help', 'Admin console', 'Sign out']);
  });

  it('without Paper where Comic Studio’s Paper look does not apply', () => {
    render(<Harness value={ctx()} panel={{ paper: false }} />);
    const group = within(panel()).getByRole('radiogroup', { name: 'Appearance' });
    expect(within(group).getAllByRole('radio').map((r) => r.textContent)).toEqual(['Light', 'Dark', 'System']);
  });

  it('each row opens the settings inside the app at its tab, with the resume point, and closes the panel', () => {
    const rows: Array<[string, string]> = [
      ['Profile', 'profile'],
      ['Usage and API keys', 'settings'],
      ['Preferences', 'preferences'],
      ['Security', 'security'],
      ['Help', 'contact'],
      ['Admin console', 'admin']
    ];
    for (const [label, tab] of rows) {
      const { unmount } = render(<Harness value={ctx({ staff: true })} panel={{ resume: 'new-comic' }} />);
      fireEvent.click(within(panel()).getByRole('button', { name: label }));
      expect(requests.at(-1), label).toEqual({ tab, resume: 'new-comic' });
      expect(screen.queryByRole('dialog', { name: 'Account and settings' }), label).toBeNull();
      unmount();
    }
    render(<Harness value={ctx()} />);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Security' }));
    expect(requests.at(-1)).toEqual({ tab: 'security' });
  });

  it('Sign out calls the existing signOut, then App’s signed-out handler, in that order', async () => {
    const value = ctx();
    render(<Harness value={value} />);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(value.onSignedOut).toHaveBeenCalledTimes(1));
    expect(auth.signOut).toHaveBeenCalledTimes(1);
    expect(auth.calls).toEqual(['signOut', 'onSignedOut']);
    expect(requests).toEqual([]);
  });

  it('shows no money: no "$" and no cents anywhere, staff and busy included', () => {
    render(<Harness value={ctx({ staff: true })} />);
    expect(panel().textContent).not.toMatch(/\$|¢|\bcents?\b|USD/i);
  });

  it('the first row takes focus on open; Esc closes it and focus goes back to the trigger', async () => {
    render(<Harness value={ctx()} />);
    await waitFor(() => expect(document.activeElement).toBe(within(panel()).getByRole('button', { name: 'Profile' })));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Account and settings' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'trigger' })));
  });

  it('a press outside closes it; a press on the trigger is the trigger’s own (it toggles)', () => {
    render(<Harness value={ctx()} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'elsewhere' }));
    expect(screen.queryByRole('dialog', { name: 'Account and settings' })).toBeNull();
  });

  it('choosing Dark puts .dark on <html> at once and keeps the panel open', () => {
    render(<Harness value={ctx()} />);
    fireEvent.click(within(panel()).getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(panel()).toBeInTheDocument();
  });

  it('reads the @handle and photo once, on open, when App does not know them; a second open reads nothing', async () => {
    const value = ctx({ person: { id: 'person-1', name: 'Ada Example', initial: 'A' } });
    const { unmount } = render(<Harness value={value} />);
    expect(db.getProfileFace).toHaveBeenCalledWith('person-1');
    expect(await within(panel()).findByText('@ada_now')).toBeInTheDocument();
    unmount();
    render(<Harness value={value} />);
    expect(within(panel()).getByText('@ada_now')).toBeInTheDocument();
    expect(db.getProfileFace).toHaveBeenCalledTimes(1);
  });

  it('a person with no display name reads "Your account"; a handle App passed is never re-read', () => {
    render(<Harness value={ctx({ person: { id: 'p2', name: null, initial: 'Z', username: 'zed', avatarUrl: null } })} />);
    expect(within(panel()).getByText('Your account')).toBeInTheDocument();
    expect(within(panel()).getByText('@zed')).toBeInTheDocument();
    expect(db.getProfileFace).not.toHaveBeenCalled();
  });

  it('below 600 px it is the studio’s bottom sheet, titled Account; a row acts once the sheet has closed', async () => {
    render(
      <FormFactorProvider value={PHONE}>
        <Harness value={ctx()} />
      </FormFactorProvider>
    );
    const sheet = panel();
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(within(sheet).getByText('Account')).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Preferences' }));
    expect(screen.queryByRole('dialog', { name: 'Account and settings' })).toBeNull();
    await waitFor(() => expect(requests).toEqual([{ tab: 'preferences' }]));
  });

  it('keeps the new comic return target when a member opens settings from a phone', async () => {
    const popup = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<FormFactorProvider value={PHONE}><Harness value={ctx()} panel={{ resume: 'new-comic' }} /></FormFactorProvider>);
    fireEvent.click(within(panel()).getByRole('button', { name: 'Preferences' }));
    await waitFor(() => expect(requests).toEqual([{ tab: 'preferences', resume: 'new-comic' }]));
    expect(popup).not.toHaveBeenCalled();
  });

  it('presentation="sheet" asks for the sheet at any width (the ⋯ row inside a comic)', () => {
    render(
      <FormFactorProvider value={DESKTOP_FORM_FACTOR}>
        <Harness value={ctx()} panel={{ presentation: 'sheet' }} />
      </FormFactorProvider>
    );
    expect(panel()).toHaveAttribute('aria-modal', 'true');
  });
});

describe('AccountMenu with its real panel', () => {
  it('opens from the trigger, the first row has focus, Esc closes it and focus returns to the trigger', async () => {
    render(
      <AccountProvider value={ctx()}>
        <AccountMenu paper />
      </AccountProvider>
    );
    const trigger = screen.getByRole('button', { name: 'Account and settings' });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    const profile = await screen.findByRole('button', { name: 'Profile' });
    await waitFor(() => expect(document.activeElement).toBe(profile));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Account and settings' })).toBeNull());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    // The trigger toggles: open, then press it again.
    fireEvent.click(trigger);
    await screen.findByRole('dialog', { name: 'Account and settings' });
    act(() => {
      fireEvent.pointerDown(trigger);
      fireEvent.click(trigger);
    });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Account and settings' })).toBeNull());
  });
});
