import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyCounters, type UsageMonth } from '@/shared/stream/usage';
import {
  NURSERY_CHECK_EVERY_MS,
  acceptAccountUsage,
  accountLineUp,
  checkNurseryAllowance,
  dueRelayNotice,
  knownNurseryRelay,
  parseAccountUsage,
  parseNurseryUsage,
  requestAccountUsage,
  requestNurseryUsage,
  resetAccountLineForTests,
  setAccountLine,
  type QueryLike,
} from './usageClient';

const NOW = Date.UTC(2026, 9, 23, 12);
const month = (turnBytes: number, kind: 'call' | 'monitor' = 'call', m = '2026-10'): UsageMonth => ({
  month: m,
  scope: kind === 'call' ? 'account' : 'nursery',
  counters: { [kind]: { ...emptyCounters(), minutes: { lan: 0, direct: 0, turn: 30, server: 0 }, turnBytes } },
  updatedAt: NOW,
});
const query = (reply: unknown): QueryLike & { asked: number } => {
  const q = {
    asked: 0,
    ask: async <T,>() => {
      q.asked += 1;
      return reply as T;
    },
  };
  return q;
};
const nurseryReply = (u: UsageMonth) => ({ t: 'r', id: 'q1', q: 'usage', usage: u, allowances: { relayDataGb: 10, serverPictureHoursPerDay: 16 } });

beforeEach(() => {
  localStorage.clear();
  resetAccountLineForTests();
});
afterEach(() => vi.useRealTimers());

describe('parsing what the rooms send', () => {
  it('the account month (UserLine) and the nursery month (MonitorRoom), with the fair-use defaults', () => {
    expect(parseAccountUsage({ t: 'usage', usage: month(5) })?.allowances).toEqual({ relayDataGb: 10, cloudCopyGb: 10 });
    expect(parseAccountUsage({ t: 'other', usage: month(5) })).toBeNull();
    expect(parseAccountUsage({ t: 'usage', usage: { month: 'bad' } })).toBeNull();
    expect(parseNurseryUsage({ error: 'forbidden' })).toBe('forbidden');
    expect(parseNurseryUsage(null)).toBeNull();
    const n = parseNurseryUsage(nurseryReply(month(5, 'monitor')));
    expect(n && n !== 'forbidden' && n.allowances).toEqual({ relayDataGb: 10, serverPictureHoursPerDay: 16 });
  });
});

describe('the account’s line', () => {
  it('one question serves everyone asking at once; an answer settles them all', async () => {
    const sent: unknown[] = [];
    setAccountLine((m) => (sent.push(m), true));
    const a = requestAccountUsage();
    const b = requestAccountUsage();
    expect(sent).toEqual([{ t: 'usage_get' }]);
    acceptAccountUsage({ t: 'usage', usage: month(1e9) });
    expect((await a)?.usage.counters.call?.turnBytes).toBe(1e9);
    expect((await b)?.usage.month).toBe('2026-10');
  });

  it('no line: null at once; the line closing: null for anyone waiting; no answer: null after the one-off timeout', async () => {
    await expect(requestAccountUsage()).resolves.toBeNull();
    setAccountLine(() => true);
    const waiting = requestAccountUsage();
    setAccountLine(null);
    await expect(waiting).resolves.toBeNull();
    vi.useFakeTimers();
    setAccountLine(() => true);
    const late = requestAccountUsage(5000);
    vi.advanceTimersByTime(5000);
    await expect(late).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a question asked while the line connects goes out when it says hello', async () => {
    let up = false;
    const sent: unknown[] = [];
    setAccountLine((m) => (up ? (sent.push(m), true) : false));
    const p = requestAccountUsage();
    expect(sent).toEqual([]);
    up = true;
    accountLineUp();
    expect(sent).toEqual([{ t: 'usage_get' }]);
    acceptAccountUsage({ t: 'usage', usage: month(0) });
    expect(await p).not.toBeNull();
  });
});

describe('a nursery’s month and its notices', () => {
  it('remembers this month’s relay data for the relay pill (and forgets it next month)', async () => {
    await requestNurseryUsage(query(nurseryReply(month(2.1e9, 'monitor'))), 'n1');
    expect(knownNurseryRelay('n1', NOW)).toEqual({ month: '2026-10', bytes: 2.1e9, limitGb: 10, measured: true });
    expect(knownNurseryRelay('n1', Date.UTC(2026, 10, 1))).toBeNull();
    expect(knownNurseryRelay('n2', NOW)).toBeNull();
    await expect(requestNurseryUsage(null)).resolves.toBeNull();
    await expect(requestNurseryUsage({ ask: async () => { throw new Error('gone'); } })).resolves.toBeNull();
  });

  it('a notice is due once per level per month on this device', () => {
    expect(dueRelayNotice('account', 'u1', month(5e9), 10)).toBeNull();
    const warn = dueRelayNotice('account', 'u1', month(8.4e9), 10);
    expect(warn?.level).toBe('warn');
    expect(dueRelayNotice('account', 'u1', month(8.9e9), 10)).toBeNull(); // said already
    expect(dueRelayNotice('account', 'u1', month(10.1e9), 10)?.level).toBe('full');
    expect(dueRelayNotice('account', 'u1', month(10.1e9, 'call', '2026-11'), 10)?.level).toBe('full');
  });

  it('a parent’s monitor looks at most twice a day, and says it in the app at 80% and 100%', async () => {
    const said: string[] = [];
    const q = query(nurseryReply(month(8.3e9, 'monitor')));
    await checkNurseryAllowance(q, 'n1', (t) => said.push(t), NOW);
    expect(q.asked).toBe(1);
    expect(said).toEqual(['This nursery has used 8.3 GB of this nursery’s 10 GB of relay data this month. Direct and Home Wi-Fi don’t count. Resets November 1.']);
    await checkNurseryAllowance(q, 'n1', (t) => said.push(t), NOW + NURSERY_CHECK_EVERY_MS - 1);
    expect(q.asked).toBe(1);
    await checkNurseryAllowance(q, 'n1', (t) => said.push(t), NOW + NURSERY_CHECK_EVERY_MS);
    expect(q.asked).toBe(2);
    expect(said).toHaveLength(1); // the 80% notice was already said this month
    // Not a parent: the room says forbidden — nothing to say.
    await checkNurseryAllowance(query({ error: 'forbidden' }), 'n2', (t) => said.push(t), NOW);
    expect(said).toHaveLength(1);
  });
});
