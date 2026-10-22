// Calls: search for anyone on Stream Studio — family badged as family — call
// them, star them; a member with no nursery still gets search (not a dead
// end); a first call to someone outside the family is checked first; and who
// may call you, with the blocked list.
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallsSnapshot } from '../calls/callCenter';
import type { Nav } from '../nav';

const NID = '11111111-2222-4333-8444-555555555555';
const ME = '00000000-0000-4000-8000-0000000000a1';
const GMA = '00000000-0000-4000-8000-000000000003';
const SAM = '00000000-0000-4000-8000-000000000005';

const h = vi.hoisted(() => ({
  snap: null as unknown as CallsSnapshot,
  nurseries: [] as { id: string; name: string; baby_name: string | null; my_role: string }[],
  people: {} as Record<string, unknown[]>,
  search: vi.fn(async (_q: string) => [] as { user_id: string; display_name: string }[]),
  center: {
    refresh: vi.fn(async () => undefined),
    familyChanged: vi.fn(async () => undefined),
    call: vi.fn(async () => null),
    callUser: vi.fn(async () => null),
    setFav: vi.fn(() => true),
    setBlocked: vi.fn(() => true),
    setWho: vi.fn(() => true),
    enableRinging: vi.fn(async () => ({ ok: true })),
    disableRinging: vi.fn(async () => undefined),
    nameOf: vi.fn(() => null),
  },
}));

vi.mock('../account', () => ({
  useAccount: () => ({ status: 'member', name: 'Alice', userId: ME }),
  openAuth: vi.fn(),
  searchPeople: (q: string) => h.search(q),
}));
vi.mock('../calls/callCenter', () => ({ useCalls: () => h.snap, callCenter: h.center }));
vi.mock('../calls/ringtone', () => ({ unlockCallAudio: () => undefined }));
vi.mock('../monitor/client', () => ({
  listNurseries: async () => ({ ok: true, nurseries: h.nurseries }),
  listPeople: async (nid: string) => ({ ok: true, people: h.people[nid] ?? [] }),
}));
vi.mock('../monitor/push', () => ({ needsHomeScreen: () => false, pushSupported: () => true }));

import { CallsView } from './CallsView';

const nav = { monitor: vi.fn() } as unknown as Nav;
const snapshot = (over: Partial<CallsSnapshot> = {}): CallsSnapshot => ({
  on: true, uid: ME, lines: [], directReady: true, ringing: [], active: null, log: [], ringOn: false, favs: [], blocked: [], who: 'everyone', notice: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.nurseries = [];
  h.people = {};
  h.snap = snapshot();
  h.search.mockResolvedValue([]);
});

const search = async (q: string) => {
  fireEvent.change(screen.getByRole('searchbox', { name: /search people to call/i }), { target: { value: q } });
};

describe('CallsView', () => {
  it('finds anyone on Stream Studio by name — family marked as family — with voice, video and a star', async () => {
    h.nurseries = [{ id: NID, name: 'Nursery', baby_name: 'Aria', my_role: 'parent' }];
    h.people = { [NID]: [{ user_id: ME, display_name: 'Alice', role: 'parent', label: 'Mom', is_owner: true, is_me: true }, { user_id: GMA, display_name: 'June', role: 'caregiver', label: 'Grandma', is_owner: false, is_me: false }] };
    h.snap = snapshot({ lines: [{ nid: NID, name: 'Nursery', baby: 'Aria', connected: true }] });
    h.search.mockResolvedValue([{ user_id: GMA, display_name: 'June' }, { user_id: SAM, display_name: 'Sam' }]);
    render(<CallsView nav={nav} push={vi.fn()} />);
    await screen.findByText('Grandma'); // the family card has loaded
    await search('ju');
    const results = await screen.findByText('In Aria’s family');
    const list = results.closest('.call-results') as HTMLElement;
    expect(within(list).getByText('Stream Studio member')).toBeInTheDocument();
    expect(h.search).toHaveBeenCalledWith('ju');
    expect(within(list).getByRole('button', { name: 'Video call Sam' })).toBeEnabled();
    expect(within(list).getByRole('button', { name: 'Voice call June' })).toBeEnabled();

    // Family: through the nursery, as always (no check needed).
    fireEvent.click(within(list).getByRole('button', { name: 'Voice call June' }));
    await waitFor(() => expect(h.center.call).toHaveBeenCalledWith(NID, [{ uid: GMA, name: 'Grandma' }], false));
    expect(h.center.callUser).not.toHaveBeenCalled();

    fireEvent.click(within(list).getByRole('button', { name: 'Add Sam to favourites' }));
    expect(h.center.setFav).toHaveBeenCalledWith({ uid: SAM, name: 'Sam' }, true);
  });

  it('a member with no nursery still gets search, and can call someone — after checking it’s the right person', async () => {
    h.search.mockResolvedValue([{ user_id: SAM, display_name: 'Sam' }]);
    render(<CallsView nav={nav} push={vi.fn()} />);
    expect(await screen.findByText(/Search above to call anyone on Stream Studio/)).toBeInTheDocument();
    await search('sam');
    fireEvent.click(await screen.findByRole('button', { name: 'Video call Sam' }));
    // First call to someone outside the family: a check, not a ring.
    const sheet = await screen.findByRole('dialog', { name: 'Call Sam?' });
    expect(h.center.callUser).not.toHaveBeenCalled();
    expect(within(sheet).getByText(/isn’t in any of your nurseries/)).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('button', { name: 'Video call' }));
    await waitFor(() => expect(h.center.callUser).toHaveBeenCalledWith([{ uid: SAM, name: 'Sam' }], true));
    // Checked once: the next call goes straight through.
    fireEvent.click(screen.getByRole('button', { name: 'Voice call Sam' }));
    await waitFor(() => expect(h.center.callUser).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('favourites are one tap away; a favourite needs no check', async () => {
    h.snap = snapshot({ favs: [{ uid: SAM, name: 'Sam', at: 1 }] });
    render(<CallsView nav={nav} push={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Video call Sam' }));
    await waitFor(() => expect(h.center.callUser).toHaveBeenCalledWith([{ uid: SAM, name: 'Sam' }], true));
  });

  it('who can call you, and the people you blocked', async () => {
    h.snap = snapshot({ blocked: [{ uid: SAM, name: 'Sam', at: 1 }] });
    const push = vi.fn();
    render(<CallsView nav={nav} push={push} />);
    const radio = await screen.findByRole('radio', { name: 'Only my nurseries' });
    expect(screen.getByRole('radio', { name: 'Everyone on Stream Studio' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(radio);
    expect(h.center.setWho).toHaveBeenCalledWith('family');
    fireEvent.click(screen.getByRole('button', { name: 'Unblock' }));
    expect(h.center.setBlocked).toHaveBeenCalledWith(expect.objectContaining({ uid: SAM }), false);
    expect(push).toHaveBeenCalledWith('Sam can call you again', expect.anything());
  });

  it('a recent direct call calls back directly', async () => {
    h.snap = snapshot({
      log: [{ id: 'd1', nid: 'direct', nursery: 'Stream Studio', from: { uid: SAM, name: 'Sam', label: null }, invited: [ME], joined: [{ uid: SAM, name: 'Sam' }], video: false, at: Date.now(), secs: 0, answered: false, why: 'no_answer' }],
    });
    render(<CallsView nav={nav} push={vi.fn()} />);
    const row = await screen.findByTitle('Call back');
    expect(row).toHaveTextContent('Incoming · Missed · Stream Studio');
    fireEvent.click(row);
    await waitFor(() => expect(h.center.callUser).toHaveBeenCalledWith([{ uid: SAM, name: 'Sam' }], false));
  });
});
