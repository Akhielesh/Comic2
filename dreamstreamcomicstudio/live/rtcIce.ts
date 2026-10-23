/**
 * Relay (TURN) credentials on the client — shared by the baby monitor (monitor/rtc.ts),
 * calls (calls/callMesh.ts) and Stream Studio (studio/rtc.ts).
 *
 * The rooms hand out short-lived TURN credentials (members ≤ 4 h, guests ≤ 2 h — see
 * live-worker/src/ice.ts) and say when to ask for fresh ones (`iceMs`). A connection only
 * uses new servers on its next ICE gathering, so whoever holds one:
 *  - applies a fresh list to its live connections (`setConfiguration`), and
 *  - when the credentials really changed and the connection is going through a relay,
 *    restarts ICE now — moving it onto them before the old ones lapse, so an all-night
 *    relayed picture or a long call never drops when a credential expires.
 */

/** A key for the TURN credentials in an ICE list ('' when there's no relay): a new key means fresh credentials. */
export function turnKey(ice: readonly RTCIceServer[] | undefined | null): string {
  if (!ice) return '';
  const names: string[] = [];
  for (const s of ice) {
    const urls = Array.isArray(s.urls) ? s.urls : [s.urls];
    if (urls.some((u) => /^turns?:/i.test(String(u)))) names.push(`${s.username ?? ''}:${urls.join(',')}`);
  }
  return names.sort().join('|');
}

/** True when `next` carries relay credentials that `prev` didn't (fresh ones, or the first). */
export const turnRenewed = (prev: readonly RTCIceServer[] | undefined | null, next: readonly RTCIceServer[] | undefined | null): boolean => {
  const k = turnKey(next);
  return k !== '' && k !== turnKey(prev);
};

/**
 * The list to use after the room answered `next`. A STUN-only answer (the TURN API failing for
 * a moment, or a pass that just ended — the room revokes those) never takes away relay
 * credentials we still hold: a relayed connection keeps working until they lapse on their own.
 */
export const keepRelay = (prev: RTCIceServer[], next: RTCIceServer[]): RTCIceServer[] => (turnKey(next) === '' && turnKey(prev) !== '' ? prev : next);

/** Never ask sooner than this (a room that says "now" by mistake can't make us spin)… */
export const ICE_ASK_MIN_MS = 30_000;
/** …nor wait longer than this (a credential never lives longer than 4 h). */
export const ICE_ASK_MAX_MS = 4 * 3600_000;

/**
 * Asks the room for fresh relay credentials when the current ones are due. The room says
 * when (`iceMs`); without it (STUN only, or a room from before credentials expired) nothing
 * is scheduled. One timer, re-armed by every delivery.
 */
export class IceClock {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private ask: () => void) {}

  arm(ms: number | null | undefined): void {
    this.stop();
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.ask();
    }, Math.min(ICE_ASK_MAX_MS, Math.max(ICE_ASK_MIN_MS, ms)));
  }

  get armed(): boolean {
    return this.timer !== undefined;
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** Point a live connection at a fresh ICE list (used from its next gathering). Never throws. */
export function applyIce(pc: RTCPeerConnection, ice: RTCIceServer[]): void {
  try {
    pc.setConfiguration({ ...pc.getConfiguration(), iceServers: ice });
  } catch {
    /* closed, or an older browser: the next connection picks the list up instead */
  }
}
