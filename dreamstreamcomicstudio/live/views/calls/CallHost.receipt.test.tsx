import React from 'react';
import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyCounters } from '@/shared/stream/usage';
import type { CallReceipt } from '../../costCopy';

/** The end-of-call receipt (feature doc §4.4, B5) and the relay-data notice after a relayed call you placed (B7). */

const calls = vi.hoisted(() => ({ snap: { ringing: [], active: null, notice: null } as Record<string, unknown> }));
vi.mock('../../calls/callCenter', () => ({
  answerFromHash: () => null,
  takeAnswerProof: async () => false,
  useCalls: () => calls.snap,
  callCenter: { start: vi.fn(), stop: vi.fn(), setSuspended: vi.fn(), snapshot: () => calls.snap },
}));
vi.mock('../../calls/ringtone', () => ({ chime: vi.fn(), startRing: () => undefined, unlockCallAudio: vi.fn() }));
vi.mock('../../account', () => ({ useAccount: () => ({ status: 'member', userId: 'u1' }) }));
vi.mock('./CallScreen', () => ({ CallScreen: () => null }));

import { acceptAccountUsage, resetAccountLineForTests, setAccountLine } from '../../usage/usageClient';
import { CallHost } from './CallHost';

const ended = (receipt: CallReceipt | null) => ({ ringing: [], notice: null, active: { id: 'c1', state: 'ended', receipt } });

beforeEach(() => {
  localStorage.clear();
  resetAccountLineForTests();
});

describe('CallHost — the call’s receipt', () => {
  it('a direct call: "12 min · direct · free", said once', () => {
    const push = vi.fn();
    calls.snap = { ringing: [], notice: null, active: { id: 'c1', state: 'connected', receipt: null } };
    const { rerender } = render(<CallHost push={push} suspended={false} />);
    expect(push).not.toHaveBeenCalled();
    calls.snap = ended({ ms: 12 * 60_000, path: 'direct', turnBytes: 0, outgoing: true });
    rerender(<CallHost push={push} suspended={false} />);
    rerender(<CallHost push={push} suspended={false} />);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith('12 min · direct · free', { icon: 'check', duration: 5000 });
  });

  it('a relayed call you placed: the receipt, then one look at your month — a notice at 80%, said as the estimate it is', async () => {
    const push = vi.fn();
    const sent: unknown[] = [];
    setAccountLine((m) => {
      sent.push(m);
      queueMicrotask(() => acceptAccountUsage({
        t: 'usage',
        // What the server really keeps for calls: relayed minutes, no bytes (≈ 11.25 MB a minute).
        usage: { month: new Date().toISOString().slice(0, 7), scope: 'account', counters: { call: { ...emptyCounters(), minutes: { lan: 0, direct: 0, turn: 765, server: 0 } } }, updatedAt: 0 },
        allowances: { relayDataGb: 10, cloudCopyGb: 10 },
      }));
      return true;
    });
    calls.snap = ended({ ms: 12 * 60_000, path: 'turn', turnBytes: 1.4e8, outgoing: true });
    render(<CallHost push={push} suspended={false} />);
    // No GB figure from this device's own bytes: the account counts the call differently.
    expect(push).toHaveBeenCalledWith('12 min · encrypted relay · uses your relay data', { icon: 'globe', duration: 5000 });
    await waitFor(() => expect(push).toHaveBeenCalledTimes(2));
    expect(push.mock.calls[1][0]).toMatch(/^You’ve used ≈ 8\.6 GB of your 10 GB of relay data this month \(estimated from minutes\)\. Direct and Home Wi-Fi don’t count\./);
    expect(sent).toEqual([{ t: 'usage_get' }]);
  });

  it('a relayed call someone else placed counts toward theirs: no look at your month', async () => {
    const push = vi.fn();
    const send = vi.fn(() => true);
    setAccountLine(send);
    calls.snap = ended({ ms: 5 * 60_000, path: 'turn', turnBytes: 5e7, outgoing: false });
    render(<CallHost push={push} suspended={false} />);
    expect(push).toHaveBeenCalledWith('5 min · encrypted relay · counts toward the caller’s relay data', { icon: 'globe', duration: 5000 });
    expect(send).not.toHaveBeenCalled();
  });

  it('a call that never connected: no receipt', () => {
    const push = vi.fn();
    calls.snap = ended(null);
    render(<CallHost push={push} suspended={false} />);
    expect(push).not.toHaveBeenCalled();
  });
});
