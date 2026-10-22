import { afterEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  listNurseries: vi.fn(),
  listPeople: vi.fn(),
  announceMembersChanged: vi.fn(async () => undefined),
  noteMembersChanged: vi.fn(),
}));
vi.mock('./client', async (orig) => ({ ...(await orig<typeof import('./client')>()), ...client }));
vi.mock('../account', () => ({ accessToken: async () => 'tok-parent', supa: async () => null }));

import {
  addMemberError,
  addedMessage,
  announcePeople,
  knownPeople,
  linkMessage,
  openInvite,
  registerInviteOpener,
  registerShareChannel,
  shareChannelFor,
  ShareChannel,
  shareOrCopy,
  shareSummary,
} from './invite';
import { focusLayout } from './viewFocus';
import { markSetup, setupDone } from './setupProgress';
import type { ShareInfo } from './protocol';

const person = (user_id: string, display_name: string, is_me = false) => ({ user_id, display_name, role: 'viewer' as const, label: null, is_owner: false, is_me });
const nursery = (id: string, name: string) => ({ id, name, baby_name: null, owner_id: 'u-me', owner_name: 'Me', my_role: 'parent' as const, my_label: null, member_count: 2, created_at: '' });

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  vi.clearAllMocks();
});

describe('knownPeople (suggested first when adding someone)', () => {
  it('lists people from my other nurseries once each — not me, not this nursery’s — most shared first', async () => {
    client.listNurseries.mockResolvedValue({ ok: true, nurseries: [nursery('here', 'Nursery'), nursery('gma', 'Grandma’s house'), nursery('day', 'Daycare')] });
    client.listPeople.mockImplementation(async (id: string) => ({
      ok: true,
      people:
        id === 'gma'
          ? [person('u-me', 'Me', true), person('u-jo', 'Jo Smith'), person('u-ann', 'Ann Lee')]
          : id === 'day'
            ? [person('u-me', 'Me', true), person('u-jo', 'Jo Smith'), person('u-bea', 'Bea')]
            : [person('u-sam', 'Sam')],
    }));
    const k = await knownPeople('here');
    expect(k.map((p) => p.display_name)).toEqual(['Jo Smith', 'Ann Lee', 'Bea']);
    expect(k[0].from).toEqual(['Grandma’s house', 'Daycare']);
    expect(client.listPeople).not.toHaveBeenCalledWith('here');
  });
});

describe('messages', () => {
  it('the link message never carries a passcode; the member note links to the watch screen', () => {
    const m = linkMessage('https://x.test/live#/monitor/join/n/c', 'Aria', 'Nursery');
    expect(m.text).toBe('Watch Aria on our baby monitor. I’ll send you the passcode separately.');
    expect(m.url).toBe('https://x.test/live#/monitor/join/n/c');
    const a = addedMessage('nid-1', 'Aria', 'Nursery');
    expect(a.url).toBe(`${location.origin}/live#/monitor/nid-1/watch`);
    expect(a.text).toMatch(/Aria’s baby monitor/);
  });

  it('explains a failed add in plain words', () => {
    expect(addMemberError('not_member', 'Jo')).toBe('Jo hasn’t finished setting up Stream Studio yet — share a link instead.');
    expect(addMemberError('limit_reached', 'Jo')).toMatch(/20 people/);
    expect(addMemberError('forbidden', 'Jo')).toMatch(/Only a parent/);
  });

  it('sums up the link for the watch screen', () => {
    const base: ShareInfo = { on: true, code: 'c', role: 'viewer', created_at: 1, created_by: 'Mom', expires_at: null, locked_until: null, guests: [] };
    expect(shareSummary(null)).toMatch(/No share link/);
    expect(shareSummary(base)).toBe('Link on · nobody has joined yet · until you turn it off');
    const g = { id: 'g', name: 'Jo', role: 'viewer' as const, created_at: 1, last_seen: 1, expires_at: 2 };
    expect(shareSummary({ ...base, guests: [g, { ...g, id: 'h' }], expires_at: Date.now() + 6 * 24 * 3600_000 + 60_000 })).toBe('Link on · 2 guests · ends in 6 days');
  });
});

describe('shareOrCopy', () => {
  it('uses the phone’s share sheet when there is one', async () => {
    const share = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, share });
    expect(await shareOrCopy({ title: 't', text: 'x', url: 'u' }, 'u')).toBe('shared');
    expect(share).toHaveBeenCalledWith({ title: 't', text: 'x', url: 'u' });
  });

  it('copies instead where there is none, and respects a cancel', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    expect(await shareOrCopy({ title: 't', text: 'x', url: 'u' }, 'u')).toBe('copied');
    expect(writeText).toHaveBeenCalledWith('u');
    vi.stubGlobal('navigator', { clipboard: { writeText }, share: async () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })) });
    expect(await shareOrCopy({ title: 't', text: 'x', url: 'u' }, 'u')).toBe('cancelled');
  });
});

describe('opening and channels', () => {
  it('openInvite reaches the mounted sheet with what had focus', () => {
    const fn = vi.fn();
    registerInviteOpener(fn);
    const b = document.createElement('button');
    document.body.appendChild(b);
    b.focus();
    openInvite('nid-1', 'link');
    expect(fn).toHaveBeenCalledWith('nid-1', 'link', b);
    registerInviteOpener(null);
    b.remove();
  });

  it('a watch screen lends its socket; announcing names who changed, or falls back to the one-shot', async () => {
    const send = vi.fn();
    const ch = new ShareChannel(send);
    const off = registerShareChannel('nid-1', ch);
    expect(shareChannelFor('nid-1')).toBe(ch);
    ch.set({ connected: true });
    await announcePeople('nid-1', ch, ['u-jo']);
    expect(send).toHaveBeenCalledWith({ t: 'members_changed', token: 'tok-parent', uids: ['u-jo'] });
    off();
    expect(shareChannelFor('nid-1')).toBeNull();
    await announcePeople('nid-1', null, ['u-jo']);
    expect(client.announceMembersChanged).toHaveBeenCalledWith('nid-1');
  });
});

describe('watch-screen focus and the setup checklist', () => {
  it('sections that only All shows switch the layout for that visit', () => {
    expect(focusLayout('share')).toBe('all');
    expect(focusLayout('alerts')).toBe('all');
    expect(focusLayout('settings')).toBe('all');
    expect(focusLayout('people')).toBe('all');
    expect(focusLayout('stage')).toBeNull();
    expect(focusLayout(null)).toBeNull();
  });

  it('“Invite family” is done when a guest joined, not only when someone has an account', () => {
    expect(setupDone('n1', 1).family).toBe(false);
    expect(setupDone('n1', 2).family).toBe(true);
    markSetup('n1', 'family');
    expect(setupDone('n1', 1).family).toBe(true);
  });
});
