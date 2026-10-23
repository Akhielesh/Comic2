/**
 * How often the camera tells the ROOM its status (ADR 0006 Phase 0, WS-6/WS-9; feature doc §7 C4).
 *
 * The room used to get the camera's full status every 2 s, all night: ≈ 21,600 billed
 * messages per 12 h night, most of them saying nothing new. Now:
 *
 *  - On a MATERIAL change — at once for what a parent must know now (the baby's state, a
 *    privacy / interrupted pause, the detector, talk / call); within STATUS_MINOR_MS for the
 *    rest (the sound category, the screen staying awake, soothing, a 5 % battery step,
 *    charging, a visit, posture, the encoder's limit), so a TV flickering between "voices"
 *    and "music" can't turn it back into a message every 2 s.
 *  - Otherwise a keepalive every 2 minutes (≤ 30 an hour when nothing happens — ADR 0006 WS-6).
 *    The room's watchdog doesn't need it (the socket's own 25 s ping is its proof of life, and
 *    a new viewer is shown the camera as confirmed by that ping); it only refreshes what the
 *    room last heard.
 *  - Every 2 s while the room asks for it (`live_want`): a viewer is watching on screen without
 *    a direct data channel (it is still connecting, or on the relay picture) — or an app from
 *    before this change is watching (the room counts it as wanting live status).
 *
 * Until a room says otherwise — and again after every reconnect — the camera sends every 2 s:
 * a room from before this change never sends `live_want`, and its 45 s watchdog needs the beat.
 *
 * The data channel to viewers (`st`, peer to peer, free) keeps its 2 s pace either way; this
 * only decides what goes through our server. Sound and alerts are separate messages and are
 * never held back by it.
 */

export const STATUS_LIVE_MS = 2000;
export const STATUS_KEEPALIVE_MS = 120_000;
/** Material news that isn't urgent goes at most this often. */
export const STATUS_MINOR_MS = 10_000;

/** The parts of a camera status that decide whether it is news (protocol.ts CamStatus). */
export interface StatusLike {
  state?: unknown;
  sound?: unknown;
  model?: unknown;
  paused?: unknown;
  awake?: unknown;
  talk?: unknown;
  call?: unknown;
  soothing?: unknown;
  battery?: number | null;
  charging?: boolean | null;
  visit?: unknown;
  scene?: { posture?: unknown; adult?: unknown; baby?: unknown } | null;
  enc?: { lim?: unknown; relay?: number } | null;
}

/** What makes a status news. Levels, motion and light move all the time and are not (minute rows carry them). */
export function materialKey(st: StatusLike): string {
  const battery = typeof st.battery === 'number' ? Math.floor(st.battery / 5) : null;
  return JSON.stringify([
    st.state ?? null,
    st.sound ?? null,
    st.model ?? null,
    st.paused ?? null,
    st.awake ?? null,
    st.talk ?? null,
    st.call ?? null,
    st.soothing ?? null,
    battery,
    st.charging ?? null,
    !!st.visit,
    st.scene?.posture ?? null,
    !!st.scene?.adult,
    st.enc?.lim ?? null,
    // The relay starting or stopping changes what the camera's "who's watching" line says.
    (st.enc?.relay ?? 0) > 0,
  ]);
}

/** The news that can't wait: the baby's state, a pause, the detector, someone talking or calling. */
export function urgentKey(st: StatusLike): string {
  return JSON.stringify([st.state ?? null, st.paused ?? null, st.model ?? null, st.talk ?? null, st.call ?? null]);
}

export class StatusCadence {
  /** Every 2 s (the default until the room says otherwise). */
  private live = true;
  private lastKey: string | null = null;
  private lastUrgent: string | null = null;
  private lastAt = -Infinity;

  /** The room's `live_want`. */
  setLive(on: boolean): void {
    this.live = on;
  }

  get isLive(): boolean {
    return this.live;
  }

  /** A new room connection: the next status goes at once, at the 2 s pace until the room says otherwise. */
  reset(): void {
    this.live = true;
    this.lastKey = null;
    this.lastUrgent = null;
    this.lastAt = -Infinity;
  }

  /** Called on every 2 s tick with the status just built: send it to the room? */
  due(st: StatusLike, now: number): boolean {
    const key = materialKey(st);
    const urgent = urgentKey(st);
    const send =
      this.live ||
      urgent !== this.lastUrgent ||
      (key !== this.lastKey && now - this.lastAt >= STATUS_MINOR_MS) ||
      now - this.lastAt >= STATUS_KEEPALIVE_MS;
    if (!send) return false;
    this.lastKey = key;
    this.lastUrgent = urgent;
    this.lastAt = now;
    return true;
  }
}
