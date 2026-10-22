// @vitest-environment node
// Direct calls — the rules for who may be rung, rate limits, tickets and the
// small lists a member keeps. The point of the block rules: a blocked caller
// hears exactly what anyone else would.
import { describe, expect, it } from 'vitest';
import {
  allowStart,
  appendLog,
  CLAIM_STALE_MS,
  cleanPerson,
  cleanPrefs,
  cleanUids,
  ctxText,
  DAY,
  DEFAULT_PREFS,
  familyFrom,
  hashTicket,
  HOUR,
  mintTicket,
  newCallId,
  noteCaller,
  overallStatus,
  ringCtx,
  ringDecision,
  setPerson,
  START_BURST,
  START_DAY,
  statusOf,
  STRANGERS_DAY,
  type CallerHistory,
} from './directCalls';

const T = 1_700_000_000_000;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const base = { claimed: true, verifiedAt: T - HOUR, now: T, blocked: false, prefs: DEFAULT_PREFS, family: false, history: null as CallerHistory | null, via: 'app' as const };

describe('ringDecision', () => {
  it('rings a claimed line that can be reached', () => {
    expect(ringDecision(base)).toBe('ring');
    expect(ringDecision({ ...base, via: 'push' })).toBe('ring');
  });

  it('is unavailable when never claimed, when the claim lapsed, or with nothing to ring', () => {
    expect(ringDecision({ ...base, claimed: false })).toBe('unavailable');
    expect(ringDecision({ ...base, verifiedAt: T - CLAIM_STALE_MS - 1 })).toBe('unavailable');
    expect(ringDecision({ ...base, via: 'none' })).toBe('unavailable');
  });

  it('family-only refuses people outside the family, honestly', () => {
    expect(ringDecision({ ...base, prefs: { who: 'family' } })).toBe('restricted');
    expect(ringDecision({ ...base, prefs: { who: 'family' }, family: true })).toBe('ring');
  });

  it('a blocked caller is silenced — and hears exactly what anyone else would', () => {
    expect(ringDecision({ ...base, blocked: true })).toBe('silent');
    // From outside, silent and ring are the same answer…
    expect(statusOf(ringDecision({ ...base, blocked: true }))).toBe(statusOf(ringDecision(base)));
    // …in every situation the caller could otherwise tell apart.
    for (const over of [{ via: 'none' as const }, { prefs: { who: 'family' as const } }, { claimed: false }, { family: true }, { via: 'push' as const }]) {
      expect(statusOf(ringDecision({ ...base, ...over, blocked: true }))).toBe(statusOf(ringDecision({ ...base, ...over })));
    }
  });

  it('silences a caller outside the family after 3 rings in an hour, or 2 declines in a day', () => {
    expect(ringDecision({ ...base, history: { rings: [T - 10, T - 20], declines: [] } })).toBe('ring');
    expect(ringDecision({ ...base, history: { rings: [T - 10, T - 20, T - 30], declines: [] } })).toBe('silent');
    expect(ringDecision({ ...base, history: { rings: [T - HOUR - 1, T - 20, T - 30], declines: [] } })).toBe('ring');
    expect(ringDecision({ ...base, history: { rings: [], declines: [T - 5, T - DAY + 10] } })).toBe('silent');
    expect(ringDecision({ ...base, history: { rings: [], declines: [T - 5, T - DAY - 10] } })).toBe('ring');
    // Family is never rate-limited.
    expect(ringDecision({ ...base, family: true, history: { rings: [T, T, T, T], declines: [T, T] } })).toBe('ring');
  });

  it('several people asked: ringing if anyone rings, restricted only when all are family-only', () => {
    expect(overallStatus(['unavailable', 'ringing'])).toBe('ringing');
    expect(overallStatus(['restricted', 'restricted'])).toBe('restricted');
    expect(overallStatus(['restricted', 'unavailable'])).toBe('unavailable');
    expect(overallStatus([])).toBe('unavailable');
  });
});

describe('caller limits', () => {
  it('8 calls per 10 minutes', () => {
    let rate = undefined as Parameters<typeof allowStart>[0];
    for (let i = 0; i < START_BURST; i++) {
      const r = allowStart(rate, T + i * 1000, []);
      expect(r.ok).toBe(true);
      rate = r.rate;
    }
    expect(allowStart(rate, T + 9000, []).ok).toBe(false);
    expect(allowStart(rate, T + 10 * 60_000 + 1, []).ok).toBe(true);
  });

  it('40 a day', () => {
    const rate = { starts: Array.from({ length: START_DAY }, (_, i) => T - 14 * HOUR + i * 20 * 60_000), strangers: {} };
    expect(allowStart(rate, T + 10 * 60_000, []).ok).toBe(false);
    expect(allowStart(rate, T + DAY, []).ok).toBe(true);
  });

  it('15 different people outside the family a day (calling the same one again is fine)', () => {
    let rate = { starts: [] as number[], strangers: {} as Record<string, number> };
    for (let i = 0; i < STRANGERS_DAY; i++) {
      const r = allowStart({ ...rate, starts: [] }, T + i, [U(i)]);
      expect(r.ok).toBe(true);
      rate = r.rate;
    }
    expect(allowStart({ ...rate, starts: [] }, T + 100, [U(99)]).ok).toBe(false);
    expect(allowStart({ ...rate, starts: [] }, T + 100, [U(3)]).ok).toBe(true);
    expect(allowStart({ ...rate, starts: [] }, T + DAY + 100, [U(99)]).ok).toBe(true);
  });
});

describe('caller history', () => {
  it('keeps rings for an hour and declines for a day', () => {
    let h = noteCaller({}, U(1), 'ring', T);
    h = noteCaller(h, U(1), 'decline', T + 1);
    expect(h[U(1)]).toEqual({ rings: [T], declines: [T + 1] });
    h = noteCaller(h, U(2), 'ring', T + HOUR + 1);
    expect(h[U(1)]).toEqual({ rings: [], declines: [T + 1] });
    h = noteCaller(h, U(2), 'ring', T + DAY + 2);
    expect(h[U(1)]).toBeUndefined();
  });
});

describe('tickets', () => {
  it('are random, url-safe, and only their hash is kept', async () => {
    const a = mintTicket();
    const b = mintTicket();
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a).not.toBe(b);
    expect(await hashTicket(a)).toBe(await hashTicket(a));
    expect(await hashTicket(a)).not.toBe(a);
    expect(newCallId()).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('sanitisers', () => {
  it('people are member ids with a short name', () => {
    expect(cleanPerson({ uid: U(1), name: '  Sam  ' })).toEqual({ uid: U(1), name: 'Sam' });
    expect(cleanPerson({ uid: U(1), name: '' })).toEqual({ uid: U(1), name: 'Member' });
    expect(cleanPerson({ uid: 'g:guest', name: 'x' })).toBeNull();
    expect(cleanPerson(null)).toBeNull();
    expect(cleanUids([U(1), U(1), 'nope', U(2), U(3), U(4)], 3)).toEqual([U(1), U(2), U(3)]);
    expect(cleanPrefs({ who: 'family' })).toEqual({ who: 'family' });
    expect(cleanPrefs({ who: 'anyone' })).toEqual({ who: 'everyone' });
  });

  it('favourites and blocks: add, remove, capped', () => {
    let l = setPerson([], { uid: U(1), name: 'A' }, true, 2, T);
    l = setPerson(l, { uid: U(2), name: 'B' }, true, 2, T);
    l = setPerson(l, { uid: U(1), name: 'A' }, true, 2, T + 1);
    expect(l.map((p) => p.uid)).toEqual([U(2), U(1)]);
    l = setPerson(l, { uid: U(3), name: 'C' }, true, 2, T);
    expect(l.map((p) => p.uid)).toEqual([U(1), U(3)]);
    expect(setPerson(l, { uid: U(1), name: 'A' }, false, 2, T).map((p) => p.uid)).toEqual([U(3)]);
  });

  it('history: a call logged twice is replaced; 60 at most', () => {
    let log: { id: string; n: number }[] = [];
    for (let i = 0; i < 65; i++) log = appendLog(log, { id: `c${i}`, n: i });
    expect(log).toHaveLength(60);
    expect(log[0].id).toBe('c5');
    log = appendLog(log, { id: 'c10', n: 99 });
    expect(log.at(-1)).toEqual({ id: 'c10', n: 99 });
    expect(log.filter((r) => r.id === 'c10')).toHaveLength(1);
  });
});

describe('family', () => {
  it('everyone sharing a nursery, named by the nursery', () => {
    const map = familyFrom(
      [{ id: 'n1', name: 'Nursery', baby_name: 'Aria' }, { id: 'n2', name: 'Lake house', baby_name: null }],
      { n1: [{ user_id: U(1), label: 'Grandma' }, { user_id: U(9), is_me: true }], n2: [{ user_id: U(1), label: 'Nana' }, { user_id: U(2), label: null }] },
    );
    expect(map).toEqual({ [U(1)]: { label: 'Grandma', where: 'Aria’s family' }, [U(2)]: { label: null, where: 'Lake house' } });
  });

  it('how a ring reads: their own family map first, the caller’s side when that’s stale', () => {
    expect(ringCtx({ label: 'Grandma', where: 'Aria’s family' }, { family: false, where: null })).toEqual({ family: true, label: 'Grandma', where: 'Aria’s family' });
    expect(ringCtx(undefined, { family: true, where: 'Aria’s family' })).toEqual({ family: true, label: null, where: 'Aria’s family' });
    const stranger = ringCtx(undefined, { family: false, where: null });
    expect(ctxText(stranger)).toBe('Stream Studio member · not in your family');
  });
});
