/**
 * The viewer's fallback when the direct (peer-to-peer) picture can't get
 * through: subscribe to the room's low-bandwidth relay, keep retrying P2P in
 * the background, and drop the relay the moment P2P connects.
 *
 * Pure so every transition is tested (linkFallback.unit.test.ts); the viewer
 * runs the effects. The bugs this replaced:
 *  - a late P2P connect (between the 15 s give-up and the retry) was torn down
 *    by the retry timer,
 *  - after the room socket reconnected, the relay subscription (kept per
 *    socket by the room) was never sent again, so the picture froze,
 *  - switching cameras while on the relay kept showing the other camera.
 */

import type { LinkState } from './rtc';

export interface Fallback {
  /** P2P failed: relay frames are wanted. */
  relay: boolean;
  /** The camera being watched (device id), null when there is none. */
  dev: string | null;
  link: LinkState;
  /** Failed P2P attempts in a row (sets the retry back-off). */
  fails: number;
  /** A P2P retry is scheduled. */
  retry: boolean;
}

export type FallbackInput =
  /** The P2P link changed state. */
  | { t: 'link'; state: LinkState }
  /** The room socket said hello — a fresh connection with no subscriptions. */
  | { t: 'hello' }
  /** The camera being watched changed (null: none in the room right now). */
  | { t: 'cam'; dev: string | null }
  /** The scheduled P2P retry is due. */
  | { t: 'retry' };

export type FallbackEffect =
  | { t: 'relay_on'; dev: string }
  | { t: 'relay_off' }
  | { t: 'retry_in'; ms: number }
  | { t: 'retry_clear' }
  | { t: 'connect' };

export const initialFallback = (): Fallback => ({ relay: false, dev: null, link: 'idle', fails: 0, retry: false });

/** 30 s, 1, 2, 4, then every 5 minutes: a network that blocks P2P rarely stops by itself. */
export const retryDelay = (fails: number): number => Math.min(300_000, 30_000 * 2 ** Math.max(0, fails - 1));

export function stepFallback(s: Fallback, input: FallbackInput): { s: Fallback; fx: FallbackEffect[] } {
  const fx: FallbackEffect[] = [];
  switch (input.t) {
    case 'link': {
      const state = input.state;
      if (state === 'failed') {
        // The link reports 'failed' from its own give-up timer and again from
        // the browser: count one failure per attempt.
        if (s.link === 'failed' && s.retry) return { s, fx };
        const fails = s.fails + 1;
        if (!s.relay && s.dev) fx.push({ t: 'relay_on', dev: s.dev });
        fx.push({ t: 'retry_in', ms: retryDelay(fails) });
        return { s: { ...s, link: state, relay: true, fails, retry: true }, fx };
      }
      if (state === 'connected') {
        // Includes ICE that got through after we'd given up: keep it, cancel the retry.
        if (s.retry) fx.push({ t: 'retry_clear' });
        if (s.relay) fx.push({ t: 'relay_off' });
        return { s: { ...s, link: state, relay: false, fails: 0, retry: false }, fx };
      }
      if (state === 'closed' && s.retry) {
        // No camera to retry; a new one (or this one back) starts its own attempt.
        fx.push({ t: 'retry_clear' });
        return { s: { ...s, link: state, retry: false }, fx };
      }
      return { s: { ...s, link: state }, fx };
    }
    case 'hello':
      // The room keeps the subscription per socket: a new socket starts with none.
      if (s.relay && s.dev) fx.push({ t: 'relay_on', dev: s.dev });
      return { s, fx };
    case 'cam': {
      if (input.dev === s.dev) return { s, fx };
      if (s.retry) fx.push({ t: 'retry_clear' });
      // The relay stays wanted while the camera is away: when it comes back
      // (same device), its frames resume right away while P2P reconnects.
      if (input.dev && s.relay) fx.push({ t: 'relay_on', dev: input.dev });
      return { s: { ...s, dev: input.dev, retry: false, fails: input.dev ? 0 : s.fails }, fx };
    }
    case 'retry':
      if (!s.retry) return { s, fx };
      if (s.dev && s.link !== 'connected') fx.push({ t: 'connect' });
      return { s: { ...s, retry: false }, fx };
  }
}
