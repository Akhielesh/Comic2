/**
 * The viewer's relay picture versus its direct (peer-to-peer) one.
 *
 *  - Instant picture: if the direct picture hasn't connected within a second
 *    (INSTANT_DELAY_MS — on the home Wi-Fi it usually has, so nothing passes
 *    through the server), the viewer subscribes to the room's relay so
 *    something is on screen right away instead of after the full P2P
 *    handshake (or its 10 s give-up), and drops it once the direct picture has
 *    actually rendered a frame (not merely "connected" — the swap is seamless).
 *  - Fallback: when the direct picture can't get through (no TURN server and
 *    a network that blocks P2P, or the camera's direct slots are full), the
 *    relay stays, and P2P is retried in the background with back-off.
 *
 * Pure so every transition is tested (linkFallback.unit.test.ts); the viewer
 * runs the effects. The bugs this replaced:
 *  - a late P2P connect (between the 10 s give-up and the retry) was torn down
 *    by the retry timer,
 *  - a camera that's full lets the call connect and only then says so (it
 *    learns the viewer's network path once connected): resetting the back-off
 *    on 'connected' retried every 30 s all night — it's reset only once the
 *    direct picture is confirmed ('rendered': drawn, or connected for 5 s),
 *  - after the room socket reconnected, the relay subscription (kept per
 *    socket by the room) was never sent again, so the picture froze,
 *  - switching cameras while on the relay kept showing the other camera.
 */

import type { LinkState } from './rtc';

export interface Fallback {
  /** Relay frames are wanted (as the instant picture or as the fallback). */
  relay: boolean;
  /** The relay is only the instant picture while the direct one connects. */
  early: boolean;
  /** Subscribe while connecting (off for audio-only viewers, who need no picture). */
  instant: boolean;
  /** The camera being watched (device id), null when there is none. */
  dev: string | null;
  link: LinkState;
  /** Failed P2P attempts in a row (sets the retry back-off); reset only once a direct picture is confirmed. */
  fails: number;
  /** A P2P retry is scheduled. */
  retry: boolean;
  /** The instant picture is scheduled (the direct one gets a moment first). */
  pending: boolean;
}

export type FallbackInput =
  /** The P2P link changed state. */
  | { t: 'link'; state: LinkState }
  /** The direct picture's head start is over (instant_in elapsed). */
  | { t: 'instant_due' }
  /** The direct picture drew its first frame (or stayed connected RENDER_WAIT_MS without one). */
  | { t: 'rendered' }
  /** The room socket said hello — a fresh connection with no subscriptions. */
  | { t: 'hello' }
  /** The camera being watched changed (null: none in the room right now). */
  | { t: 'cam'; dev: string | null }
  /** Whether to use the instant picture (the viewer chose audio-only, or back). */
  | { t: 'instant'; on: boolean }
  /** The scheduled P2P retry is due. */
  | { t: 'retry' };

export type FallbackEffect =
  /** Subscribe; `instant` = only while the direct picture connects (parents don't see it as "on the relay"). */
  | { t: 'relay_on'; dev: string; instant: boolean }
  | { t: 'relay_off' }
  | { t: 'retry_in'; ms: number }
  | { t: 'retry_clear' }
  /** Feed {t:'instant_due'} after `ms` (cleared by instant_clear). */
  | { t: 'instant_in'; ms: number }
  | { t: 'instant_clear' }
  | { t: 'connect' };

export const initialFallback = (instant = true): Fallback => ({ relay: false, early: false, instant, dev: null, link: 'idle', fails: 0, retry: false, pending: false });

/** The direct picture's head start before the instant (relay) picture is asked for. */
export const INSTANT_DELAY_MS = 1000;

const connecting = (l: LinkState) => l === 'connecting' || l === 'reconnecting';

/** 30 s, 1, 2, 4, then every 5 minutes: a network that blocks P2P rarely stops by itself. */
export const retryDelay = (fails: number): number => Math.min(300_000, 30_000 * 2 ** Math.max(0, fails - 1));

/** Wait this long for the direct picture's first frame before dropping the relay anyway. */
export const RENDER_WAIT_MS = 5000;

export function stepFallback(s0: Fallback, input: FallbackInput): { s: Fallback; fx: FallbackEffect[] } {
  const fx: FallbackEffect[] = [];
  let s = s0;
  /** While the direct picture (re)connects: give it a head start, then the instant picture. */
  const schedule = () => {
    if (s.instant && s.dev && !s.relay && !s.pending && connecting(s.link)) {
      fx.push({ t: 'instant_in', ms: INSTANT_DELAY_MS });
      s = { ...s, pending: true };
    }
  };
  const unschedule = () => {
    if (!s.pending) return;
    fx.push({ t: 'instant_clear' });
    s = { ...s, pending: false };
  };
  switch (input.t) {
    case 'link': {
      const state = input.state;
      if (state === 'failed') {
        // The link reports 'failed' from its own give-up timer and again from
        // the browser: count one failure per attempt.
        if (s.link === 'failed' && s.retry) return { s, fx };
        unschedule();
        const fails = s.fails + 1;
        // A stopgap becomes the picture: tell the room (parents now see who's on the relay).
        if (s.dev && (!s.relay || s.early)) fx.push({ t: 'relay_on', dev: s.dev, instant: false });
        fx.push({ t: 'retry_in', ms: retryDelay(fails) });
        return { s: { ...s, link: state, relay: true, early: false, fails, retry: true }, fx };
      }
      if (connecting(state)) {
        s = { ...s, link: state };
        schedule();
        return { s, fx };
      }
      unschedule();
      if (state === 'connected') {
        // Includes ICE that got through after we'd given up: keep it, cancel the
        // retry. The relay stays until the direct picture has drawn a frame — and
        // the back-off stays too: a full camera connects first and turns us away
        // a moment later ({bye, full}), so 'connected' proves nothing yet.
        if (s.retry) fx.push({ t: 'retry_clear' });
        return { s: { ...s, link: state, retry: false }, fx };
      }
      if (state === 'closed') {
        // The camera hung up, or there's none: no retry; a stopgap relay goes too.
        if (s.retry) fx.push({ t: 'retry_clear' });
        if (s.relay && s.early) {
          fx.push({ t: 'relay_off' });
          return { s: { ...s, link: state, retry: false, relay: false, early: false }, fx };
        }
        return { s: { ...s, link: state, retry: false }, fx };
      }
      return { s: { ...s, link: state }, fx };
    }
    case 'instant_due':
      if (!s.pending) return { s, fx };
      s = { ...s, pending: false };
      // Still not through: a picture now, via the room, until the direct one renders.
      if (s.instant && s.dev && !s.relay && connecting(s.link)) {
        fx.push({ t: 'relay_on', dev: s.dev, instant: true });
        s = { ...s, relay: true, early: true };
      }
      return { s, fx };
    case 'rendered':
      if (s.link !== 'connected') return { s, fx };
      // The direct picture is confirmed: the next failure starts the back-off over.
      if (!s.relay) return { s: s.fails ? { ...s, fails: 0 } : s, fx };
      fx.push({ t: 'relay_off' });
      return { s: { ...s, relay: false, early: false, fails: 0 }, fx };
    case 'hello':
      // The room keeps the subscription per socket: a new socket starts with none.
      if (s.relay && s.dev) fx.push({ t: 'relay_on', dev: s.dev, instant: s.early });
      return { s, fx };
    case 'cam': {
      if (input.dev === s.dev) return { s, fx };
      if (s.retry) fx.push({ t: 'retry_clear' });
      // The relay stays wanted while the camera is away: when it comes back
      // (same device), its frames resume right away while P2P reconnects.
      if (input.dev && s.relay) fx.push({ t: 'relay_on', dev: input.dev, instant: s.early });
      s = { ...s, dev: input.dev, retry: false, fails: input.dev ? 0 : s.fails };
      // Already connecting to it (the camera arrived with the call): the instant picture too.
      if (!input.dev) unschedule();
      else schedule();
      return { s, fx };
    }
    case 'instant': {
      if (input.on === s.instant) return { s, fx };
      s = { ...s, instant: input.on };
      if (!input.on) {
        unschedule();
        if (s.relay && s.early) {
          fx.push({ t: 'relay_off' });
          s = { ...s, relay: false, early: false };
        }
      } else schedule();
      return { s, fx };
    }
    case 'retry':
      if (!s.retry) return { s, fx };
      if (s.dev && s.link !== 'connected') fx.push({ t: 'connect' });
      return { s: { ...s, retry: false }, fx };
  }
}
