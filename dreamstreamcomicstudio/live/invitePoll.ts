/**
 * When the invite page looks at its event again (ADR 0007 C2).
 *
 * Budget: **≤ 12 requests per waiting tab-hour**, down from 240 (a look every 30 s,
 * each one a Worker request plus a Durable Object request). So a tab makes at most
 * 6 looks in any 60 minutes — guaranteed by a sliding-window cap, whatever the
 * schedule or the user's tab-switching asks for.
 *
 * Within that budget, look when it matters:
 *  - Long before a scheduled start: every 30 min, landing 1 min before the start.
 *  - Around the start, past it, or with no start time ("Starting soon"): after 2, 6
 *    and 12 min, then every 20 min — so the page flips to the watch page within
 *    about 2 minutes of a host who goes live on time, and never sits silent longer
 *    than 20 min once the start has come.
 *  - Ended: never again. Live: the page has already moved to the watch page.
 *  - Hidden tab: never (the caller stops its timer). Coming back looks once if the
 *    last look is a minute old and the budget allows.
 */
import type { EventMeta } from './protocol';

const MIN = 60_000;
const HOUR = 60 * MIN;

export const INVITE_POLL = {
  /** Each look is 2 billed requests (Worker + Durable Object): 6 looks = 12 requests. */
  maxLooksPerHour: 6,
  /** Cadence far from a scheduled start. */
  farMs: 30 * MIN,
  /** Land a look this long before a scheduled start. */
  leadMs: MIN,
  /** Around/after the start (or with no start time): gaps between looks. */
  backoffMs: [2 * MIN, 6 * MIN, 12 * MIN, 20 * MIN] as readonly number[],
  /** Coming back to the tab looks again only if the last look is older than this. */
  returnGapMs: MIN,
} as const;

export interface InviteCheckPlan {
  /** Milliseconds until the next look, or null for never. */
  inMs: number | null;
  /** The next look is part of the around-the-start backoff. */
  near: boolean;
}

/** Earliest time another look fits the hourly budget, given the looks already made. */
export function budgetOpensAt(recent: readonly number[], now: number): number {
  const max = INVITE_POLL.maxLooksPerHour;
  const inHour = recent.filter((t) => t > now - HOUR).sort((a, b) => a - b);
  return inHour.length < max ? now : inHour[inHour.length - max] + HOUR;
}

/**
 * @param nearLooks looks already made in the around-the-start backoff (0 = none yet).
 * @param recent    when this tab looked (the last hour is enough).
 */
export function planInviteCheck(
  meta: Pick<EventMeta, 'status' | 'scheduledAt'>,
  now: number,
  nearLooks: number,
  recent: readonly number[] = [],
): InviteCheckPlan {
  if (meta.status === 'ended' || meta.status === 'live' || meta.status === 'paused') return { inMs: null, near: false };
  const { farMs, leadMs, backoffMs } = INVITE_POLL;
  const start = meta.scheduledAt;
  let at: number;
  let near: boolean;
  if (start != null && start - now > 2 * leadMs) {
    at = Math.min(now + farMs, start - leadMs);
    near = false;
  } else {
    at = now + backoffMs[Math.min(Math.max(0, nearLooks), backoffMs.length - 1)];
    near = true;
  }
  at = Math.max(at, budgetOpensAt(recent, now));
  return { inMs: Math.max(1000, at - now), near };
}

/** May a look happen right now (coming back to the tab)? */
export function canLookNow(recent: readonly number[], now: number): boolean {
  const last = recent.length ? Math.max(...recent) : -Infinity;
  return now - last >= INVITE_POLL.returnGapMs && budgetOpensAt(recent, now) <= now;
}

/** Keep only the looks that still count against the hourly budget. */
export const pruneLooks = (recent: number[], now: number): number[] => recent.filter((t) => t > now - HOUR);
