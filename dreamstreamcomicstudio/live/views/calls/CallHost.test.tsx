// "Answer" on a call notification picks up the call in one tap — but only with
// the service worker's one-time proof that the button was really tapped. A
// plain link to #/call/d/<id>?answer=1 (anyone can send one while a call
// rings) just shows the call ringing; it must never turn the microphone on.
// And a ring from someone who added you to a call says who.
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallsSnapshot, Ringing } from '../../calls/callCenter';
import type { Call } from '../../calls/types';

const ME = '00000000-0000-4000-8000-0000000000a1';
const SAM = '00000000-0000-4000-8000-000000000005';
const ID = '0123456789abcdef';
const PROOF = '0123456789abcdef0123456789abcdef';

const h = vi.hoisted(() => ({
  snap: null as unknown as CallsSnapshot,
  accept: vi.fn(async (_nid: string, _id: string, _video: boolean) => null as string | null),
  decline: vi.fn((_nid: string, _id: string, _block?: boolean) => null as { who: { uid: string; name: string }; now: boolean } | null),
  proof: vi.fn(async (_x: { nid: string; id: string; proof: string }) => false),
}));

vi.mock('../../account', () => ({ useAccount: () => ({ status: 'member', name: 'Alice', userId: ME }), accessToken: async () => 'tok', supa: async () => null }));
vi.mock('../../calls/ringtone', () => ({ chime: () => undefined, startRing: () => () => undefined, unlockCallAudio: () => undefined }));
vi.mock('../../calls/callCenter', async (orig) => {
  const real = await orig<typeof import('../../calls/callCenter')>();
  return {
    answerFromHash: real.answerFromHash,
    takeAnswerProof: (x: { nid: string; id: string; proof: string }) => h.proof(x),
    useCalls: () => h.snap,
    callCenter: { accept: h.accept, decline: h.decline, start: vi.fn(), stop: vi.fn(), setSuspended: vi.fn(), snapshot: () => h.snap },
  };
});

import { CallHost } from './CallHost';

const call = (over: Partial<Call> = {}): Call => ({
  id: ID, from: { uid: SAM, name: 'Sam', label: null }, video: true, invited: [ME], declined: [], at: Date.now(), answeredAt: null,
  parts: [], ever: { [SAM]: 'Sam' }, ended: null, ...over,
});
const ringing = (over: Partial<Ringing> = {}): Ringing => ({ nid: `d:${ID}`, nursery: 'Stream Studio member · not in your family', call: call(), direct: { family: false, label: null, where: null }, ...over });
const snapshot = (over: Partial<CallsSnapshot> = {}): CallsSnapshot => ({
  on: true, uid: ME, lines: [], directReady: true, ringing: [], active: null, log: [], ringOn: false, favs: [], blocked: [], who: 'everyone', notice: null, ...over,
});
const settle = () => act(async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
});

beforeEach(() => {
  vi.clearAllMocks();
  h.snap = snapshot({ ringing: [ringing()] });
  h.proof.mockResolvedValue(false);
});

describe('answering from a call notification', () => {
  it('a plain ?answer=1 link only shows the call ringing — it never picks up', async () => {
    // Regression: any page could send the app to this address while it rang and the call was answered, mic on.
    history.replaceState(null, '', `/live#/call/d/${ID}?answer=1`);
    render(<CallHost push={vi.fn()} suspended={false} />);
    await settle();
    expect(h.accept).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: 'Sam is calling' })).toBeTruthy();
  });

  it('with the service worker’s proof it picks up at once — by voice for someone outside the family', async () => {
    h.proof.mockResolvedValue(true);
    history.replaceState(null, '', `/live#/call/d/${ID}?answer=${PROOF}`);
    render(<CallHost push={vi.fn()} suspended={false} />);
    await settle();
    expect(h.proof).toHaveBeenCalledWith({ nid: `d:${ID}`, id: ID, proof: PROOF });
    expect(h.accept).toHaveBeenCalledTimes(1);
    expect(h.accept).toHaveBeenCalledWith(`d:${ID}`, ID, false);
    // The address no longer carries the proof.
    expect(location.hash).not.toContain(PROOF);
  });

  it('a proof that doesn’t check out (used, expired, another call’s) answers nothing', async () => {
    history.replaceState(null, '', `/live#/call/d/${ID}?answer=${PROOF}`);
    render(<CallHost push={vi.fn()} suspended={false} />);
    await settle();
    expect(h.proof).toHaveBeenCalledTimes(1);
    expect(h.accept).not.toHaveBeenCalled();
  });

  it('arriving while the app is open (the notification navigates it): the same check', async () => {
    history.replaceState(null, '', '/live#/calls');
    render(<CallHost push={vi.fn()} suspended={false} />);
    await settle();
    history.replaceState(null, '', `/live#/call/d/${ID}?answer=1`);
    await act(async () => void window.dispatchEvent(new HashChangeEvent('hashchange')));
    await settle();
    expect(h.accept).not.toHaveBeenCalled();
  });
});

describe('the ring screen', () => {
  it('added to a call by someone else: says who', async () => {
    history.replaceState(null, '', '/live#/calls');
    h.snap = snapshot({ ringing: [ringing({ direct: { family: false, label: null, where: null, by: { uid: 'bob', name: 'Bob', family: false } } })] });
    render(<CallHost push={vi.fn()} suspended={false} />);
    expect(screen.getByText('Added by Bob')).toBeTruthy();
    expect(screen.getByText(/Bob isn’t in any of your nurseries/)).toBeTruthy();
  });

  it('Decline & block names whoever was blocked — and only says “blocked” once the line has it', async () => {
    history.replaceState(null, '', '/live#/calls');
    const push = vi.fn();
    render(<CallHost push={push} suspended={false} />);
    h.decline.mockReturnValueOnce({ who: { uid: 'bob', name: 'Bob' }, now: true });
    act(() => screen.getByRole('button', { name: /Decline & block/ }).click());
    expect(h.decline).toHaveBeenCalledWith(`d:${ID}`, ID, true);
    expect(push).toHaveBeenLastCalledWith('Bob is blocked — their calls won’t reach you. Unblock them in Calls.', expect.anything());
    // Regression: offline, it still said "blocked" while the block never reached the server.
    h.decline.mockReturnValueOnce({ who: { uid: SAM, name: 'Sam' }, now: false });
    act(() => screen.getByRole('button', { name: /Decline & block/ }).click());
    expect(push).toHaveBeenLastCalledWith(expect.stringMatching(/^Sam will be blocked as soon as you’re back online/), expect.anything());
  });
});
