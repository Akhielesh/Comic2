import { describe, expect, it } from 'vitest';
import { INVITE_POLL, budgetOpensAt, canLookNow, planInviteCheck } from './invitePoll';
import type { EventMeta } from './protocol';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.UTC(2026, 9, 22, 18);

type M = Pick<EventMeta, 'status' | 'scheduledAt'>;

/**
 * Every look a tab makes from `openAt` for `spanMs` (the first load included), the way
 * EventPage drives the planner. `returns` are moments the user comes back to the tab.
 */
function looks(meta: M, openAt: number, spanMs: number, returns: number[] = []): number[] {
  const at = [openAt];
  let near = 0;
  let next = (() => {
    const p = planInviteCheck(meta, openAt, near, at);
    return p.inMs == null ? null : { t: openAt + p.inMs, near: p.near };
  })();
  const pending = [...returns].sort((a, b) => a - b);
  for (;;) {
    const r = pending[0];
    if (next == null && r == null) break;
    let t: number;
    if (r != null && (next == null || r < next.t)) {
      pending.shift();
      t = r;
      if (!canLookNow(at, t)) continue;
    } else {
      t = next!.t;
      near = next!.near ? near + 1 : 0;
    }
    if (t >= openAt + spanMs) break;
    at.push(t);
    const p = planInviteCheck(meta, t, near, at);
    next = p.inMs == null ? null : { t: t + p.inMs, near: p.near };
  }
  return at;
}

/** The most looks in any 60-minute window. */
const worstHour = (at: number[]) => Math.max(...at.map((a) => at.filter((b) => b >= a && b < a + HOUR).length));

describe('invite page: ≤ 12 requests per waiting tab-hour (ADR 0007 C2)', () => {
  it('each look is a Worker + a Durable Object request, so the cap is 6 looks', () => {
    expect(INVITE_POLL.maxLooksPerHour * 2).toBeLessThanOrEqual(12);
  });

  const cases: [string, M][] = [
    ['no start time (“Starting soon”)', { status: 'idle', scheduledAt: null }],
    ['starts in 90 s', { status: 'idle', scheduledAt: T0 + 90_000 }],
    ['starts in 5 min', { status: 'idle', scheduledAt: T0 + 5 * MIN }],
    ['starts in 21 min', { status: 'idle', scheduledAt: T0 + 21 * MIN }],
    ['starts in 50 min', { status: 'idle', scheduledAt: T0 + 50 * MIN }],
    ['starts in 3 h', { status: 'idle', scheduledAt: T0 + 3 * HOUR }],
    ['starts in 3 days', { status: 'idle', scheduledAt: T0 + 72 * HOUR }],
    ['host is 2 h late', { status: 'idle', scheduledAt: T0 - 2 * HOUR }],
  ];
  for (const [label, meta] of cases) {
    it(`${label}: never more than 6 looks in any hour over a 6-hour wait, and never silent for long`, () => {
      const at = looks(meta, T0, 6 * HOUR);
      expect(worstHour(at)).toBeLessThanOrEqual(INVITE_POLL.maxLooksPerHour);
      for (let i = 1; i < at.length; i++) {
        // Never silent longer than the far cadence; once the start has come, 20 min.
        const started = meta.scheduledAt == null || at[i - 1] >= meta.scheduledAt;
        expect(at[i] - at[i - 1]).toBeLessThanOrEqual(started ? 20 * MIN : INVITE_POLL.farMs);
      }
    });
  }

  it('holds even when the user keeps switching back to the tab', () => {
    const returns = Array.from({ length: 200 }, (_, i) => T0 + 30_000 + i * 70_000);
    for (const [, meta] of cases) {
      expect(worstHour(looks(meta, T0, 4 * HOUR, returns))).toBeLessThanOrEqual(INVITE_POLL.maxLooksPerHour);
    }
  });

  it('is there for the start: a look 1 min before it and 1 min after it', () => {
    for (const lead of [5 * MIN, 50 * MIN, 3 * HOUR]) {
      const at = looks({ status: 'idle', scheduledAt: T0 + lead }, T0, lead + HOUR);
      expect(at).toContain(T0 + lead - MIN);
      expect(at).toContain(T0 + lead + MIN);
    }
  });

  it('with no start time it looks again after 2 min, then backs off to every 20 min', () => {
    const meta: M = { status: 'idle', scheduledAt: null };
    expect(planInviteCheck(meta, T0, 0)).toEqual({ inMs: 2 * MIN, near: true });
    expect(planInviteCheck(meta, T0, 1).inMs).toBe(6 * MIN);
    expect(planInviteCheck(meta, T0, 2).inMs).toBe(12 * MIN);
    expect(planInviteCheck(meta, T0, 99).inMs).toBe(20 * MIN);
  });

  it('a spent budget pushes the next look to when the oldest one ages out', () => {
    const recent = [0, 1, 2, 3, 4, 5].map((i) => T0 + i * MIN);
    expect(budgetOpensAt(recent, T0 + 6 * MIN)).toBe(T0 + HOUR);
    expect(planInviteCheck({ status: 'idle', scheduledAt: null }, T0 + 6 * MIN, 0, recent).inMs).toBe(HOUR - 6 * MIN);
    expect(canLookNow(recent, T0 + 30 * MIN)).toBe(false);
    expect(canLookNow(recent.slice(0, 2), T0 + 30 * MIN)).toBe(true);
    expect(canLookNow([T0], T0 + 30_000)).toBe(false); // looked half a minute ago
  });

  it('an ended event is never asked again; a live one has already moved to the watch page', () => {
    expect(planInviteCheck({ status: 'ended', scheduledAt: null }, T0, 0).inMs).toBeNull();
    expect(planInviteCheck({ status: 'live', scheduledAt: null }, T0, 0).inMs).toBeNull();
    expect(planInviteCheck({ status: 'paused', scheduledAt: null }, T0, 0).inMs).toBeNull();
  });
});
