// PeopleCard (ADR 0006 Phase 0, WS-6): after a guest is removed the room may change the share
// link and its passcode — parents see the new ones once, with one tap to pass the link on —
// and admin actions ask for the second sign-in step first.
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../account', () => ({ accessToken: vi.fn(async () => 'tok'), supa: async () => null }));

import { registerStepUp } from '../../monitor/client';
import type { ShareInfo, ViewerPresence } from '../../monitor/protocol';
import { PeopleCard } from './PeopleCard';

const NID = '11111111-2222-4333-8444-555555555555';
const share: ShareInfo = { on: true, code: 'OldCodeOldCodeOldCode1', role: 'viewer', created_at: 1, created_by: 'Alice', expires_at: null, locked_until: null, pass_at: 1, max_guests: 10, guests: [], requests: [] };
const viewers: ViewerPresence[] = [
  { sid: 's-me', name: 'Alice', label: 'Mom', role: 'parent', dn: 'Laptop', since: 1, relay: false } as ViewerPresence,
  { sid: 's-2', name: 'Bob', label: 'Dad', role: 'parent', dn: 'Phone', since: 1, relay: false } as ViewerPresence,
];

function card(over: Partial<React.ComponentProps<typeof PeopleCard>> = {}) {
  const props = {
    me: { sid: 's-me', role: 'parent' as const },
    guest: false,
    viewers,
    share,
    send: vi.fn(),
    onInvite: vi.fn(),
    onLeave: vi.fn(),
    nid: NID,
    nursery: { name: 'Nursery', baby: 'Aria' },
    rotated: { code: 'NewCodeNewCodeNewCode2', pass: '12345678', removed: 'Grandma Jo' },
    onRotatedDone: vi.fn(),
    say: vi.fn(),
    ...over,
  };
  render(<PeopleCard {...props} />);
  return props;
}

beforeEach(() => registerStepUp(null));
afterEach(() => {
  registerStepUp(null);
  vi.unstubAllGlobals();
});

describe('PeopleCard: the share link changed after a guest was removed', () => {
  it('parents see the new link and passcode once, and pass the link on in one tap', async () => {
    const shared: unknown[] = [];
    vi.stubGlobal('navigator', { ...navigator, share: async (d: unknown) => void shared.push(d) });
    const p = card();
    expect(screen.getByText('Link and passcode changed')).toBeTruthy();
    expect(screen.getByText(/Grandma Jo can’t use the old one/)).toBeTruthy();
    expect(screen.getByText('1234 5678')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Share the new link/ }));
    await waitFor(() => expect(shared).toHaveLength(1));
    const d = shared[0] as { url: string; text: string };
    expect(d.url).toMatch(new RegExp(`/live#/monitor/join/${NID}/NewCodeNewCodeNewCode2$`));
    // The passcode never travels with the link.
    expect(JSON.stringify(d)).not.toMatch(/12345678/);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(p.onRotatedDone).toHaveBeenCalled();
  });

  it('no share sheet (a desktop): the link is copied, and it says so', async () => {
    const copied: string[] = [];
    vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void copied.push(t) } });
    const p = card({ rotated: { code: 'NewCodeNewCodeNewCode2', pass: null, removed: null } });
    expect(screen.getByText('Link changed')).toBeTruthy();
    expect(screen.getByText(/The person you removed can’t use the old one/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Share the new link/ }));
    await waitFor(() => expect(copied).toHaveLength(1));
    expect(copied[0]).toMatch(/NewCodeNewCodeNewCode2$/);
    expect(p.say).toHaveBeenCalledWith(expect.stringMatching(/copied/));
  });

  it('only parents see it', () => {
    card({ me: { sid: 's-me', role: 'caregiver' } });
    expect(screen.queryByText(/changed/)).toBeNull();
  });
});

describe('PeopleCard: admin actions ask for the second sign-in step first', () => {
  it('“End other sessions” goes ahead only once the step is given', async () => {
    let answer = false;
    const asked: string[] = [];
    registerStepUp(async (why) => {
      asked.push(why);
      return answer;
    });
    const p = card({ rotated: null });
    fireEvent.click(screen.getByRole('button', { name: /End other sessions/ }));
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /End other sessions/ }).at(-1)!));
    expect(asked).toHaveLength(1);
    expect(p.send).not.toHaveBeenCalled();
    answer = true;
    fireEvent.click(screen.getByRole('button', { name: /End other sessions/ }));
    await act(async () => fireEvent.click(screen.getAllByRole('button', { name: /End other sessions/ }).at(-1)!));
    expect(p.send).toHaveBeenCalledWith({ t: 'end_all' });
  });

  it('Invite (parents): cancelled step → the sheet stays closed; viewers just see who has access', async () => {
    registerStepUp(async () => false);
    const p = card({ rotated: null });
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Invite' })));
    expect(p.onInvite).not.toHaveBeenCalled();
    registerStepUp(async () => true);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Invite' })));
    expect(p.onInvite).toHaveBeenCalled();
  });
});
