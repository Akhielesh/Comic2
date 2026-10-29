/**
 * Signals — the live Worker's privacy-safe counters for Admin → Costs (ADR 0006 WS-8;
 * shared/stream/signals.ts has the contract and the reader).
 *
 *   signal(env, 'mfa_refused', 'monitor')   count one (coalesced: ≤ 1 data point per minute per
 *                                           isolate per name+surface)
 *   flushSignals(env)                       write what is still in memory — rooms call it from their
 *                                           hourly usage flush and when their last socket closes
 *
 * Writes to the STREAM_USAGE Analytics Engine binding the rooms already use (no new binding). With no
 * binding nothing is counted and nothing breaks. Never throws, never awaits, never touches storage —
 * safe on every hot path, including a refusal at the edge during a flood.
 *
 * WHAT TO COUNT (the producers, wired by the workstreams that own those files):
 *   - edge (index.ts / origin.ts / kick.ts / members.ts, WS-7): rate_limited, origin_refused, kick,
 *     mfa_refused, session_revoked
 *   - rooms (monitorRoom.ts WS-9, userLine.ts / callRoom.ts WS-10): kick_closed, removed_closed,
 *     device_revoked_closed, session_expired, reauth_ok, mfa_refused, preauth_evicted, guest_lockout,
 *     camera_spoof_refused, glance_bump, push_sent / push_gone / push_failed (surface = transport)
 * Only the name and a surface word ever leave: no account, nursery, device, IP or token.
 */

import { SignalCounter, type SignalName, type SignalSink } from '../../shared/stream/signals';

export interface SignalEnv {
  STREAM_USAGE?: SignalSink;
}

/** One per isolate: every room and request in it shares the coalescing window. */
const counter = new SignalCounter();

/** Count `n` of a signal. Fire-and-forget. */
export function signal(env: SignalEnv | null | undefined, name: SignalName, surface?: string, n = 1): void {
  counter.bump(env?.STREAM_USAGE, name, surface, n);
}

/** Write any counts still held in memory. Returns how many data points were written. */
export function flushSignals(env: SignalEnv | null | undefined): number {
  try {
    return counter.flush(env?.STREAM_USAGE);
  } catch {
    return 0;
  }
}

/** For tests: a private counter with its own clock and window. */
export function makeSignalCounter(opts?: ConstructorParameters<typeof SignalCounter>[0]): SignalCounter {
  return new SignalCounter(opts);
}
