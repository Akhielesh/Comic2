// Missed-call badge for the Calls tab (kept out of CallsView so the shell
// doesn't load the Calls screen just to count).
import type { CallRecord } from '../calls/types';

export const CALLS_SEEN_KEY = 'ds-calls-seen';

/** Rung, never picked up (on any of your devices), and not declined. */
export function isMissed(r: CallRecord, uid: string | null): boolean {
  return !!uid && r.from.uid !== uid && !r.joined.some((j) => j.uid === uid) && r.why !== 'declined';
}
