import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShareInfo } from '../../monitor/protocol';

const NID = '11111111-2222-4333-8444-555555555555';

const h = vi.hoisted(() => ({
  account: { status: 'member', userId: 'u-me', name: 'Alice' } as Record<string, unknown>,
  myRole: 'parent' as 'parent' | 'caregiver' | 'viewer',
  sockets: [] as { nid: string; mode: string; onMsg: (m: unknown) => void; onStatus: (s: string, d?: string) => void; sent: Record<string, unknown>[]; closed: boolean }[],
}));

vi.mock('../../account', () => ({
  useAccount: () => h.account,
  searchPeople: vi.fn(async () => []),
  openAuth: vi.fn(),
  accessToken: vi.fn(async () => 'tok'),
  supa: async () => null,
}));

vi.mock('../../monitor/client', async (orig) => ({
  ...(await orig<typeof import('../../monitor/client')>()),
  listNurseries: vi.fn(async () => ({
    ok: true,
    nurseries: [
      { id: NID, name: 'Nursery', baby_name: 'Aria', owner_id: 'u-me', owner_name: 'Alice', my_role: h.myRole, my_label: 'Mom', member_count: 2, created_at: '' },
      { id: 'other', name: 'Grandma’s house', baby_name: null, owner_id: 'u-gma', owner_name: 'Gma', my_role: 'viewer', my_label: null, member_count: 3, created_at: '' },
    ],
  })),
  listPeople: vi.fn(async (id: string) => ({
    ok: true,
    people:
      id === NID
        ? [
            { user_id: 'u-me', display_name: 'Alice', role: 'parent', label: 'Mom', is_owner: true, is_me: true },
            { user_id: 'u-bob', display_name: 'Bob', role: 'caregiver', label: 'Grandpa', is_owner: false, is_me: false },
          ]
        : [
            { user_id: 'u-me', display_name: 'Alice', role: 'viewer', label: null, is_owner: false, is_me: true },
            { user_id: 'u-jo', display_name: 'Jo Smith', role: 'viewer', label: null, is_owner: false, is_me: false },
          ],
  })),
  setMember: vi.fn(async () => ({ ok: true })),
  removeMember: vi.fn(async () => ({ ok: true })),
  announceMembersChanged: vi.fn(async () => undefined),
  noteMembersChanged: vi.fn(),
  openMonitorSocket: vi.fn((nid: string, mode: string, onMsg: (m: unknown) => void, _bin: unknown, onStatus: (s: string) => void) => {
    const s = { nid, mode, onMsg, onStatus, sent: [] as Record<string, unknown>[], closed: false };
    h.sockets.push(s);
    return { send: (m: Record<string, unknown>) => s.sent.push(m), sendBinary: () => false, bufferedAmount: () => 0, close: () => void (s.closed = true), open: true };
  }),
}));

import { searchPeople } from '../../account';
import { setMember } from '../../monitor/client';
import { passcodeProblem } from '../../monitor/guest';
import { openInvite, registerShareChannel, ShareChannel } from '../../monitor/invite';
import { InviteSheet } from './InviteSheet';
import { InviteHost } from './InviteHost';

const noLink: ShareInfo = { on: false, code: null, role: 'viewer', created_at: null, created_by: null, expires_at: null, locked_until: null, pass_at: null, max_guests: 10, guests: [], requests: [] };
const CODE = 'AbCdEfGhIjKlMnOpQrStUv';
const linkOn = (over: Partial<ShareInfo> = {}): ShareInfo => ({
  ...noLink,
  on: true,
  code: CODE,
  created_at: 1000,
  created_by: 'Alice',
  expires_at: Date.now() + 7 * 24 * 3600_000,
  pass_at: 1000,
  guests: [{ id: 'g1', name: 'Grandma Jo', role: 'viewer', created_at: Date.now() - 3600_000, last_seen: Date.now(), expires_at: Date.now() + 1e9 }],
  ...over,
});

/** The sheet's own (admin) connection to the nursery: say hello and the share state. */
const connect = async (share: ShareInfo) => {
  await waitFor(() => expect(h.sockets.some((s) => s.mode === 'admin')).toBe(true));
  // The sheet binds to its channel in a state update scheduled right after the socket opened. Let
  // that commit first, so the messages below land in a subscribed component inside act() — not in
  // a render that follows the test's next assertion (it raced under CI load).
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  const s = h.sockets.find((x) => x.mode === 'admin')!;
  act(() => {
    s.onStatus('connected');
    s.onMsg({ t: 'hello', you: { sid: 'a', uid: 'u-me', name: 'Alice', role: 'parent', label: 'Mom', mode: 'admin', dev: 'd' }, nursery: { id: NID, name: 'Nursery', baby: 'Aria' } });
    s.onMsg({ t: 'share', share });
  });
  // A link that is on (or locked) opens the sheet on the link tab; be sure it has before returning.
  if (share.on || share.locked_until) {
    await waitFor(() => expect(screen.getByRole('tab', { name: /Share a link/ }).getAttribute('aria-selected')).toBe('true'));
  }
  return s;
};
const push = vi.fn();
const open = () => render(<InviteSheet nid={NID} onClose={vi.fn()} push={push} />);

beforeEach(() => {
  h.account = { status: 'member', userId: 'u-me', name: 'Alice' };
  h.myRole = 'parent';
  h.sockets.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('InviteSheet — add by name', () => {
  it('opens on Add by name, suggests people from my other nurseries, and searches after a pause', async () => {
    open();
    expect(await screen.findByRole('dialog', { name: 'Invite to Nursery' })).toBeTruthy();
    await connect(noLink);
    expect(screen.getByRole('tab', { name: /Add by name/ }).getAttribute('aria-selected')).toBe('true');
    expect(await screen.findByText('Jo Smith')).toBeTruthy();
    expect(screen.getByText('From your other nurseries')).toBeTruthy();

    vi.mocked(searchPeople).mockResolvedValue([{ user_id: 'u-bob', display_name: 'Bob' }, { user_id: 'u-bo', display_name: 'Bo Diddley' }]);
    const box = screen.getByRole('textbox', { name: 'Search people by name' });
    fireEvent.change(box, { target: { value: 'B' } });
    fireEvent.change(box, { target: { value: 'Bo' } });
    expect(await screen.findByText('Bo Diddley')).toBeTruthy();
    expect(vi.mocked(searchPeople).mock.calls).toEqual([['Bo']]);
    // Bob is already in this nursery.
    const bob = within(screen.getByLabelText('People found')).getByText('Bob').closest('button')!;
    expect(bob.disabled).toBe(true);
    expect(within(bob).getByText('Already added')).toBeTruthy();
  });

  it('adds as a Viewer by default, with a name, then tells the room who changed', async () => {
    open();
    const sock = await connect(noLink);
    fireEvent.click(await screen.findByText('Jo Smith'));
    expect(screen.getByRole('radio', { name: 'Viewer' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/Watch, listen and get alerts\. You can change this any time\./)).toBeTruthy();
    // Suggested from a shared nursery: no "is it the right Jo" warning.
    expect(screen.queryByText(/Check it’s the right/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Grandma' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Jo as Viewer' }));
    await screen.findByText('Jo can now watch Aria');
    expect(setMember).toHaveBeenCalledWith(NID, 'u-jo', 'viewer', 'Grandma');
    await waitFor(() => expect(sock.sent).toContainEqual({ t: 'members_changed', token: 'tok', uids: ['u-jo'] }));
    expect(push).toHaveBeenCalledWith('Jo can now watch Aria', expect.anything());

    const share = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, share });
    fireEvent.click(screen.getByRole('button', { name: 'Let them know' }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    expect((share.mock.calls[0] as unknown as [{ url: string }])[0].url).toBe(`${location.origin}/live#/monitor/${NID}/watch`);
  });

  it('warns to check the person when found by search, and offers a link when nobody matches', async () => {
    open();
    await connect(noLink);
    vi.mocked(searchPeople).mockResolvedValueOnce([{ user_id: 'u-sarah', display_name: 'Sarah Jones' }]);
    const box = await screen.findByRole('textbox', { name: 'Search people by name' });
    fireEvent.change(box, { target: { value: 'Sarah' } });
    fireEvent.click(await screen.findByText('Sarah Jones'));
    expect(screen.getByText(/Check it’s the right Sarah — they’ll see and hear the nursery live\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Choose someone else' }));

    vi.mocked(searchPeople).mockResolvedValueOnce([]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Search people by name' }), { target: { value: 'Zed' } });
    expect(await screen.findByText(/No Stream Studio account named “Zed”/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Share a link' }));
    expect(screen.getByRole('tab', { name: /Share a link/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('explains when the person hasn’t finished setting up', async () => {
    vi.mocked(setMember).mockResolvedValueOnce({ ok: false, error: 'not_member' });
    open();
    await connect(noLink);
    fireEvent.click(await screen.findByText('Jo Smith'));
    fireEvent.click(screen.getByRole('button', { name: 'Add Jo as Viewer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Jo hasn’t finished setting up Stream Studio yet — share a link instead.');
  });
});

describe('InviteSheet — share a link', () => {
  it('creates a link in one tap with a ready passcode, then shows it once with a QR code', async () => {
    open();
    const sock = await connect(noLink);
    fireEvent.click(screen.getByRole('tab', { name: /Share a link/ }));
    const pass = (screen.getByRole('textbox', { name: 'Passcode' }) as HTMLInputElement).value;
    expect(pass.length).toBeGreaterThanOrEqual(8);
    expect(passcodeProblem(pass, ['Aria', 'Nursery'])).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    expect(sock.sent).toContainEqual({ t: 'share_set', pass, role: 'viewer', days: 7 });

    act(() => sock.onMsg({ t: 'share', share: linkOn({ created_at: 5000, pass_at: 5000, guests: [] }) }));
    expect(screen.getByText(pass)).toBeTruthy();
    expect(screen.getByText(/You won’t see it again/)).toBeTruthy();
    expect(screen.getByRole('img', { name: 'QR code for the share link' })).toBeTruthy();
    expect(screen.getByText(`${location.host}/live#/monitor/join/${NID}/${CODE}`)).toBeTruthy();
  });

  it('Send never includes the passcode; without a share sheet it copies the link', async () => {
    open();
    const sock = await connect(noLink);
    fireEvent.click(screen.getByRole('tab', { name: /Share a link/ }));
    const pass = (screen.getByRole('textbox', { name: 'Passcode' }) as HTMLInputElement).value;
    fireEvent.click(screen.getByRole('button', { name: 'Create link' }));
    act(() => sock.onMsg({ t: 'share', share: linkOn({ created_at: 5000, pass_at: 5000 }) }));
    const link = `${location.origin}/live#/monitor/join/${NID}/${CODE}`;

    const share = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, share });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(share).toHaveBeenCalled());
    const sent = (share.mock.calls[0] as unknown as [{ text: string; url: string }])[0];
    expect(sent.url).toBe(link);
    expect(JSON.stringify(sent)).not.toContain(pass);

    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(link));
  });

  it('opens on the link when one is on; a new passcode keeps the link; Turn off asks first', async () => {
    open();
    const sock = await connect(linkOn());
    expect(screen.getByRole('tab', { name: /Share a link/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/Passcode hidden/)).toBeTruthy();
    expect(screen.getByText(/Watch & listen · ends .* · 1 of 10 guests · made by Alice/)).toBeTruthy();
    expect(screen.getByText(/2 of 20 people · link: 1 of 10 guests/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Set a new passcode' }));
    const np = (screen.getByRole('textbox', { name: 'New passcode — same link' }) as HTMLInputElement).value;
    fireEvent.click(screen.getByRole('button', { name: 'Save passcode' }));
    expect(sock.sent).toContainEqual({ t: 'share_pass', pass: np, signOut: false });
    act(() => sock.onMsg({ t: 'share', share: linkOn({ pass_at: 9000 }) }));
    expect(screen.getByText(np)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '+7 days' }));
    expect(sock.sent).toContainEqual({ t: 'share_extend', days: 7 });

    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    expect(sock.sent.some((m) => m.t === 'share_off')).toBe(false);
    expect(screen.getByText(/Turn the link off\? 1 guest is signed out right away\./)).toBeTruthy();
    fireEvent.click(within(screen.getByRole('group', { name: 'Turn off' })).getByRole('button', { name: 'Turn off' }));
    expect(sock.sent).toContainEqual({ t: 'share_off' });
  });

  it('lists guests and guests with an account, who can be made members', async () => {
    open();
    const sock = await connect(
      linkOn({ requests: [{ id: 'r1', uid: 'u-sam', account: 'Sam Smith', name: 'Uncle Sam', guest_id: 'g2', role: 'caregiver', at: 1 }] }),
    );
    expect(await screen.findByText('Grandma Jo')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Grandma Jo' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Remove' })).getByRole('button', { name: 'Remove' }));
    expect(sock.sent).toContainEqual({ t: 'guest_remove', id: 'g1' });

    expect(screen.getByText(/has a Stream Studio account \(Sam Smith\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Make member' }));
    await waitFor(() => expect(setMember).toHaveBeenCalledWith(NID, 'u-sam', 'caregiver', ''));
    await waitFor(() => expect(sock.sent).toContainEqual({ t: 'members_changed', token: 'tok', uids: ['u-sam'] }));
  });
});

describe('InviteSheet — what happened is said inside the sheet (the app’s toasts sit under its scrim, and the page behind is inert)', () => {
  const sam = { id: 'r1', uid: 'u-sam', account: 'Sam Smith', name: 'Uncle Sam', guest_id: 'g2', role: 'caregiver' as const, at: 1 };

  it('a failed "Make member" says why, next to it, as an alert — and it can be tried again', async () => {
    vi.mocked(setMember).mockResolvedValueOnce({ ok: false, error: 'limit_reached' });
    open();
    const sock = await connect(linkOn({ requests: [sam] }));
    const dialog = screen.getByRole('dialog', { name: 'Invite to Nursery' });
    fireEvent.click(screen.getByRole('button', { name: 'Make member' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('This nursery has 20 people — the most it can have. Remove someone, or share a link instead.');
    expect(alert.closest('.inv-req')).toHaveTextContent('Uncle Sam joined with the link');
    expect(push).not.toHaveBeenCalled();
    expect(sock.sent.some((m) => m.t === 'members_changed')).toBe(false);
    expect((screen.getByRole('button', { name: 'Make member' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a role change that doesn’t save says why under that person, and stays open to try again', async () => {
    vi.mocked(setMember).mockResolvedValueOnce({ ok: false, error: 'forbidden' });
    open();
    await connect(noLink);
    const dialog = screen.getByRole('dialog', { name: 'Invite to Nursery' });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Bob' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Only a parent of this nursery can add people.');
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
  });

  it('Copy says it worked (and the sheet reads it out), or that it didn’t', async () => {
    open();
    await connect(linkOn());
    const dialog = screen.getByRole('dialog', { name: 'Invite to Nursery' });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await within(dialog).findByText('Link copied.')).toBeTruthy();
    await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Link copied.'));

    writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Couldn’t copy — select it and copy by hand.');
    expect(push).not.toHaveBeenCalled();
  });

  it('"+7 days" is confirmed once the room has moved the end; offline it says it can’t, and sends nothing', async () => {
    open();
    const sock = await connect(linkOn());
    const dialog = screen.getByRole('dialog', { name: 'Invite to Nursery' });
    const end = linkOn().expires_at!;
    fireEvent.click(screen.getByRole('button', { name: '+7 days' }));
    expect(sock.sent).toContainEqual({ t: 'share_extend', days: 7 });
    expect(within(dialog).queryByText(/Link extended/)).toBeNull();
    act(() => sock.onMsg({ t: 'share', share: linkOn({ expires_at: end + 7 * 24 * 3600_000 }) }));
    expect(within(dialog).getByText(/Link extended — it now works until .*Guests who joined with it can watch as long\./)).toBeTruthy();

    act(() => sock.onStatus('reconnecting'));
    const sent = sock.sent.length;
    fireEvent.click(screen.getByRole('button', { name: '+7 days' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Not connected to the nursery right now — try again in a moment.');
    expect(sock.sent).toHaveLength(sent);
  });

  it('a change the room refuses shows its reason; one it never answers says so instead of nothing', async () => {
    open();
    const sock = await connect(linkOn());
    const dialog = screen.getByRole('dialog', { name: 'Invite to Nursery' });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Remove Grandma Jo' }));
      fireEvent.click(within(screen.getByRole('group', { name: 'Remove' })).getByRole('button', { name: 'Remove' }));
      expect(sock.sent).toContainEqual({ t: 'guest_remove', id: 'g1' });
      act(() => void vi.advanceTimersByTime(9000));
      expect(within(dialog).getByRole('alert')).toHaveTextContent('The nursery didn’t answer, so this may not have changed — check your connection and try again.');

      // Answered in time: nothing more to say.
      fireEvent.click(screen.getByRole('button', { name: '+7 days' }));
      act(() => sock.onMsg({ t: 'share', share: linkOn({ expires_at: Date.now() + 14 * 24 * 3600_000 }) }));
      act(() => void vi.advanceTimersByTime(9000));
      expect(within(dialog).getAllByText(/didn’t answer/)).toHaveLength(1); // only the removal's, still where it was
      expect(within(dialog).getByText(/Link extended/)).toBeTruthy();

      // Refused: the room's reason.
      fireEvent.click(screen.getByRole('button', { name: '+7 days' }));
      act(() => sock.onMsg({ t: 'share_err', msg: 'There’s no link to change — make a new one.' }));
      expect(within(dialog).getAllByRole('alert').map((x) => x.textContent)).toContain('There’s no link to change — make a new one.');
      act(() => void vi.advanceTimersByTime(9000));
      expect(within(dialog).getAllByText(/didn’t answer/)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('InviteSheet — a parent made a caregiver or viewer while the sheet is open', () => {
  it('the room ends the sheet’s connection; the sheet shows what this account can do now', async () => {
    open();
    const sock = await connect(linkOn());
    expect(screen.getByRole('tab', { name: /Share a link/ })).toBeTruthy();
    h.myRole = 'viewer';
    act(() => sock.onMsg({ t: 'error', code: 'forbidden', msg: 'Only parents can manage this nursery.' }));
    expect(await screen.findByText('Only parents can invite people — ask Alice.')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.queryByText(CODE, { exact: false })).toBeNull();
    expect(screen.queryByText('Grandma Jo')).toBeNull();
    await waitFor(() => expect(sock.closed).toBe(true));
  });
});

describe('InviteSheet — who sees what', () => {
  it('caregivers and viewers see who has access, and who to ask', async () => {
    h.myRole = 'viewer';
    open();
    expect(await screen.findByText('Only parents can invite people — ask Alice.')).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(await screen.findByText('Bob')).toBeTruthy();
    expect(h.sockets).toHaveLength(0); // no parent-only connection
  });

  it('a guest can leave (asked first), using the watch screen’s connection', async () => {
    h.account = { status: 'signed_out' };
    const leave = vi.fn();
    const ch = new ShareChannel(vi.fn(), leave);
    ch.set({ connected: true, me: { role: 'viewer', name: 'Grandma Jo', guest: true }, nursery: { name: 'Nursery', baby: 'Aria' } });
    const off = registerShareChannel(NID, ch);
    open();
    expect(await screen.findByText(/You’re watching Nursery as a guest/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Leave this nursery' }));
    expect(leave).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('group', { name: 'Leave' })).getByRole('button', { name: 'Leave' }));
    expect(leave).toHaveBeenCalled();
    off();
  });
});

describe('InviteSheet — a real dialog', () => {
  it('Esc closes it, the page behind is inert while open, and focus goes back to the button', async () => {
    render(
      <>
        <button onClick={() => openInvite(NID)}>Invite</button>
        <InviteHost push={push} />
      </>,
    );
    const btn = screen.getByRole('button', { name: 'Invite' });
    btn.focus();
    fireEvent.click(btn);
    const dialog = await screen.findByRole('dialog', { name: 'Invite to Nursery' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(btn.closest('[inert]')).not.toBeNull();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(btn.closest('[inert]')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(btn));
  });

  it('starts in the search field with a mouse or keyboard; the tabs follow the arrow keys', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: fine)', media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
    open();
    await connect(noLink);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Search people by name' })));
    const add = screen.getByRole('tab', { name: /Add by name/ });
    expect(add.getAttribute('tabindex')).toBe('0');
    add.focus();
    fireEvent.keyDown(add, { key: 'ArrowRight' });
    const link = screen.getByRole('tab', { name: /Share a link/ });
    expect(link.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(link);
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(link.id);
    fireEvent.keyDown(link, { key: 'Home' });
    expect(add.getAttribute('aria-selected')).toBe('true');
  });
});
