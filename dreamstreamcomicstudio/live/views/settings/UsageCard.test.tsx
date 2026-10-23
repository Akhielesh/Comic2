import React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyCounters, listValueUsd, type UsageCounters, type UsageMonth } from '@/shared/stream/usage';

const quota = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../cloudCopy', async (orig) => ({ ...(await orig<typeof import('../../cloudCopy')>()), fetchCloudCopyQuota: quota.fetch }));

import { approxUsd } from '../../costCopy';
import { addMyEvent } from '../../events';
import { addMonitorMs, addNightSegment, addSave } from '../../usage/ledger';
import { acceptAccountUsage, accountLineUp, knownNurseryRelay, resetAccountLineForTests, setAccountLine, type QueryLike } from '../../usage/usageClient';
import { AccountUsageCard, NurseryUsage, NurseryUsageCard } from './UsageCard';

/**
 * Settings → Usage and the nursery's Usage section (feature doc §4.5, B6): what the server's
 * month says, shown as it is — free next to through-our-servers, allowance meters, at most one
 * tip, our cost folded away — loaded once when opened, with no timers.
 */

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 23, 12);
const counters = (o: Partial<Omit<UsageCounters, 'minutes'>> & { minutes?: Partial<UsageCounters['minutes']> }): UsageCounters => ({
  ...emptyCounters(),
  ...o,
  minutes: { ...emptyCounters().minutes, ...(o.minutes ?? {}) },
});
const month = (c: UsageMonth['counters'], scope: UsageMonth['scope'] = 'account'): UsageMonth => ({ month: '2026-10', scope, counters: c, updatedAt: NOW });

/** A personal line that answers `usage_get` with this month (what UserLine sends). */
function line(usage: UsageMonth | null, opts: { connected?: boolean } = {}) {
  const sent: Record<string, unknown>[] = [];
  let connected = opts.connected ?? true;
  setAccountLine((msg) => {
    if (!connected) return false;
    sent.push(msg);
    if (msg.t === 'usage_get' && usage) queueMicrotask(() => acceptAccountUsage({ t: 'usage', usage, allowances: { relayDataGb: 10, cloudCopyGb: 10 } }));
    return true;
  });
  return {
    sent,
    up: () => {
      connected = true;
      accountLineUp();
    },
  };
}

function nurseryQuery(reply: unknown): QueryLike & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ask: async <T,>(q: string) => {
      asked.push(q);
      return reply as T;
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  resetAccountLineForTests();
  quota.fetch.mockReset().mockResolvedValue(null);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('no timers, no polling', () => {
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

  it('the card has no timer at all; the client only a one-off timeout for an unanswered question', () => {
    const card = src('./UsageCard.tsx');
    expect(card).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
    const client = src('../../usage/usageClient.ts');
    expect(client).not.toMatch(/setInterval/);
    expect(client.match(/setTimeout\(/g)).toHaveLength(1);
  });

  it('once loaded, an hour on screen asks nothing more', async () => {
    const l = line(month({ call: counters({ minutes: { direct: 5 } }) }));
    addMyEvent({ id: 'ev1', hostKey: 'hk', title: 'Party', createdAt: NOW, scheduledAt: null });
    const q = nurseryQuery({ t: 'r', id: 'q1', q: 'usage', usage: month({}, 'nursery'), allowances: { relayDataGb: 10, serverPictureHoursPerDay: 16 } });
    render(
      <>
        <AccountUsageCard signedIn now={NOW} />
        <NurseryUsageCard query={q} nid="n1" now={NOW} />
      </>,
    );
    await screen.findByText('Calls you placed');
    await screen.findAllByText(/Nothing went through our servers this month/);
    vi.useFakeTimers();
    await act(async () => {
      vi.advanceTimersByTime(60 * 60_000);
    });
    expect(l.sent).toEqual([{ t: 'usage_get' }]);
    expect(quota.fetch).toHaveBeenCalledTimes(1);
    expect(q.asked).toEqual(['usage']);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('Settings → Usage (the account)', () => {
  it('shows the server’s month as it is: calls by path, relay data against 10 GB, 7-day copies against 10 GB, our cost folded away', async () => {
    const call = counters({ minutes: { lan: 30, direct: 90, turn: 12 }, turnBytes: 2.1e9, doRequestsEst: 70, rowsWrittenEst: 120 });
    const l = line(month({ call }));
    addMyEvent({ id: 'ev1', hostKey: 'hk', title: 'Party', createdAt: NOW - 86_400_000, scheduledAt: null, startedAt: NOW - 3 * 3_600_000, endedAt: NOW - 2 * 3_600_000 });
    quota.fetch.mockResolvedValue({ usedBytes: 3.1 * 1024 ** 3, limitBytes: 10 * 1024 ** 3, copies: 2, nextFreeAt: null });
    addSave('drive', 6.2 * 1024 ** 3, NOW);
    addMonitorMs('lan', NOW - 212 * 60 * MIN, NOW);

    render(<AccountUsageCard signedIn now={NOW} />);
    const card = await screen.findByLabelText('Usage this month');
    await waitFor(() => expect(within(card).getByText('Relay data · calls you placed')).toBeTruthy());

    expect(within(card).getByText('Usage · October')).toBeTruthy();
    expect(within(card).getByText('resets November 1')).toBeTruthy();
    // Free: calls on Home Wi-Fi + direct = 120 minutes; the monitor on this device; Drive saves.
    expect(within(card).getByText('Calls you placed').closest('.usage-row')?.textContent).toMatch(/2 h$/);
    expect(within(card).getByText('Baby monitor on this device').closest('.usage-row')?.textContent).toMatch(/212 h/);
    expect(within(card).getByText('Saved to Google Drive').closest('.usage-row')?.textContent).toMatch(/6\.20 GB/);
    // Through our servers: the server's own relay bytes (measured, so no ≈), and its share.
    const relay = within(card).getByText('Relay data · calls you placed').closest('.usage-row')!;
    expect(relay.textContent).toMatch(/2\.1 GB of 10 GB/);
    expect(relay.textContent).toMatch(/21%/);
    expect(relay.textContent).toMatch(/12 min of calls through our relay/);
    expect(relay.textContent).not.toMatch(/≈/);
    const copies = within(card).getByText('7-day cloud copies').closest('.usage-row')!;
    expect(copies.textContent).toMatch(/3\.1 GB of 10 GB/);
    expect(copies.textContent).toMatch(/31%/);
    expect(within(card).getByText('Broadcasts').closest('.usage-row')?.textContent).toMatch(/1 live stream from this device · free for you/);

    // What this costs DreamStream (est.): our list-price estimate of exactly those counters.
    const cost = card.querySelector('details.usage-cost')!;
    expect(cost.hasAttribute('open')).toBe(false);
    expect(cost.textContent).toMatch(/What this costs DreamStream \(est\.\)/);
    const expected = listValueUsd(call, 'call').usd + listValueUsd(counters({ cloudCopyBytes: 3.1 * 1024 ** 3 }), 'cloud_copy').usd;
    expect(cost.textContent).toContain(`${approxUsd(expected)} this month at list price`);
    expect(cost.textContent).toMatch(/You aren’t charged/);
    // Dollars appear nowhere else on the card.
    const outside = card.cloneNode(true) as HTMLElement;
    outside.querySelector('details.usage-cost')?.remove();
    expect(outside.textContent).not.toMatch(/\$/);

    // At most one tip.
    expect(card.querySelectorAll('.usage-tip').length).toBe(1);
    // One question, over the line that was already open.
    expect(l.sent).toEqual([{ t: 'usage_get' }]);
  });

  it('the empty state: nothing through our servers this month — that’s the goal', async () => {
    line(month({}));
    render(<AccountUsageCard signedIn now={NOW} />);
    expect(await screen.findByText(/Nothing went through our servers this month — everything stayed on your devices/)).toBeTruthy();
    const relay = screen.getByText('Relay data · calls you placed').closest('.usage-row')!;
    expect(relay.textContent).toMatch(/0 GB of 10 GB/);
    expect(relay.textContent).toMatch(/Direct and Home Wi-Fi don’t count/);
    expect(document.querySelectorAll('.usage-tip').length).toBe(0);
  });

  it('relay data estimated from minutes says ≈; at 80% and 100% the card says so, with the reset day', async () => {
    line(month({ call: counters({ minutes: { turn: 900 } }) })); // no bytes reported: ≈ from minutes (≈ 10.1 GB)
    const { unmount } = render(<AccountUsageCard signedIn now={NOW} />);
    const relay = (await screen.findByText('Relay data · calls you placed')).closest('.usage-row')!;
    expect(relay.textContent).toMatch(/≈ /);
    expect(relay.textContent).toMatch(/estimated from minutes/);
    expect(relay.querySelector('[role=status]')?.textContent).toMatch(/You’ve used this month’s 10 GB of relay data\..*Resets November 1\./);
    unmount();

    resetAccountLineForTests();
    line(month({ call: counters({ minutes: { turn: 60 }, turnBytes: 8.5e9 }) }));
    render(<AccountUsageCard signedIn now={NOW} />);
    const warn = (await screen.findByText('Relay data · calls you placed')).closest('.usage-row')!;
    expect(warn.className).toMatch(/is-warn/);
    expect(warn.querySelector('[role=status]')?.textContent).toBe('You’ve used 8.5 GB of your 10 GB of relay data this month. Direct and Home Wi-Fi don’t count. Resets November 1.');
  });

  it('asks once the personal line says hello, if it was still connecting', async () => {
    const l = line(month({ call: counters({ minutes: { direct: 5 } }) }), { connected: false });
    render(<AccountUsageCard signedIn now={NOW} />);
    expect(screen.getByText('Loading this month’s usage…')).toBeTruthy();
    expect(l.sent).toEqual([]);
    act(() => l.up());
    expect(await screen.findByText('Calls you placed')).toBeTruthy();
    expect(l.sent).toEqual([{ t: 'usage_get' }]);
  });

  it('no line: says it couldn’t load, and still shows what this device saved and watched', async () => {
    addSave('device', 3 * 1024 ** 3, NOW);
    render(<AccountUsageCard signedIn now={NOW} />);
    expect(await screen.findByText(/Couldn’t load this month’s usage right now/)).toBeTruthy();
    expect(screen.getByText('Saved to this device')).toBeTruthy();
    // No account month: no cost expander to show.
    expect(document.querySelector('details.usage-cost')).toBeNull();
  });

  it('signed out: asks nothing', () => {
    const l = line(month({}));
    render(<AccountUsageCard signedIn={false} now={NOW} />);
    expect(screen.getByText(/Sign in to see your calls and 7-day copies here/)).toBeTruthy();
    expect(l.sent).toEqual([]);
    expect(quota.fetch).not.toHaveBeenCalled();
  });
});

describe('a nursery’s Usage (parents)', () => {
  const monitor = counters({ minutes: { lan: 212 * 60, direct: 41 * 60, turn: 90, server: 190 }, turnBytes: 2.1e9, relayFrames: 171_000 });

  it('shows the room’s month: free by path, relay data against the nursery’s 10 GB, picture through our server, and remembers the relay data for the pill', async () => {
    const q = nurseryQuery({ t: 'r', id: 'q1', q: 'usage', usage: month({ monitor }, 'nursery'), allowances: { relayDataGb: 10, serverPictureHoursPerDay: 16 } });
    render(<NurseryUsageCard query={q} nid="n1" now={NOW} />);
    const card = await screen.findByLabelText('This nursery’s usage this month');
    await waitFor(() => expect(within(card).getByText('Home Wi-Fi')).toBeTruthy());
    expect(within(card).getByText('Home Wi-Fi').closest('.usage-row')?.textContent).toMatch(/212 h/);
    expect(within(card).getByText('Home Wi-Fi').closest('.usage-row')?.textContent).toMatch(/nothing left your home/);
    expect(within(card).getByText('Direct').closest('.usage-row')?.textContent).toMatch(/41 h/);
    const relay = within(card).getByText('Relay data · this nursery’s viewers').closest('.usage-row')!;
    expect(relay.textContent).toMatch(/2\.1 GB of 10 GB/);
    expect(relay.textContent).toMatch(/1 h 30 m through our relay/);
    const server = within(card).getByText('Picture through our server').closest('.usage-row')!;
    expect(server.textContent).toMatch(/3 h 10 m/);
    expect(server.textContent).toMatch(/sound and alerts are never limited/);
    expect(card.querySelector('details.usage-cost')?.textContent).toContain(`${approxUsd(listValueUsd(monitor, 'monitor').usd)} this month at list price`);
    expect(card.querySelectorAll('.usage-tip').length).toBe(1);
    expect(q.asked).toEqual(['usage']);
    expect(knownNurseryRelay('n1', NOW)).toEqual({ month: '2026-10', bytes: 2.1e9, limitGb: 10, measured: true });
  });

  it('caregivers and viewers: the room says forbidden, and the card says only parents see it', async () => {
    render(<NurseryUsageCard query={nurseryQuery({ t: 'r', id: 'q1', q: 'usage', error: 'forbidden' })} nid="n1" now={NOW} />);
    expect(await screen.findByText('Only the nursery’s parents see its usage.')).toBeTruthy();
  });

  it('Nursery settings: last night’s receipt straight away; the month is asked for only when opened', async () => {
    addNightSegment('n1', 'direct', NOW - 14 * 3_600_000, NOW - 4 * 3_600_000);
    const q = nurseryQuery({ t: 'r', id: 'q1', q: 'usage', usage: month({}, 'nursery'), allowances: { relayDataGb: 10, serverPictureHoursPerDay: 16 } });
    render(<NurseryUsage query={q} nid="n1" />);
    expect(screen.getByText(/· all direct · free/)).toBeTruthy();
    expect(q.asked).toEqual([]);
    const details = screen.getByText('This month’s usage · what was free · what went through our servers').closest('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    expect(await screen.findByText(/Nothing went through our servers this month/)).toBeTruthy();
    expect(q.asked).toEqual(['usage']);
  });
});
