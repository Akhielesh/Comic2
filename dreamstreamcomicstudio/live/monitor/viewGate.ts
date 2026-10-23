/**
 * Is anyone looking at this viewer's picture? (ADR 0006 WS-6; feature doc §7 C5.)
 *
 * A viewer whose screen is hidden — phone locked, another app or tab in front — gets SOUND
 * ONLY: the camera stops sending it video (peer to peer), and the room stops forwarding it relay
 * pictures (it keeps the sound). No video minutes go to a screen nobody can see. Sound and
 * alerts never stop.
 *
 *  - Shown = the page is visible, OR its picture is popped out (picture-in-picture is a picture
 *    someone is watching while the page itself is hidden) — `pageShown`. A browser that can't
 *    tell us whether its own picture-in-picture is showing the video counts as shown.
 *  - The viewer says so AT ONCE, both ways — a phone that locks may be frozen a moment later, so
 *    it can't be trusted to say "hidden" 20 s from now. The receivers (the room for the relay,
 *    the camera for the direct picture) wait HIDDEN_GRACE_MS before taking the picture away, so
 *    a glance at a message and back keeps it (no flapping, no wait for a key frame); shown
 *    again, the picture comes back at once.
 *
 * It also says whether the camera's data channel is delivering (`dc`): a viewer that hears the
 * camera's status straight from it every 2 s doesn't need the room to pass it on, so the room
 * lets the camera report only what changes (`live_want`, statusCadence.ts).
 *
 * The room hears `{t:'view', vis, dc}` only when one of them changes (`due`). Pure: the clock
 * is passed in (viewGate.unit.test.ts).
 */

/** Hidden this long before the picture is taken away (applied by the room and the camera). */
export const HIDDEN_GRACE_MS = 20_000;
/** The camera sends its status over the data channel every 2 s: nothing for this long = not delivering. */
export const DC_STALE_MS = 6000;

export interface ViewState {
  vis: boolean;
  dc: boolean;
}

/**
 * Is this page's picture on a screen? The page is visible, or its video is popped out in
 * picture-in-picture — the standard API (`document.pictureInPictureElement`) or Safari's
 * presentation mode. A browser with neither can't say whether ITS OWN picture-in-picture is
 * showing the video (Firefox puts a pop-out toggle on every video but has no Picture-in-Picture
 * API), so it always counts as shown: a picture a parent may be watching is never taken away —
 * that browser's hidden tabs just keep the picture, as before sound-only-when-hidden.
 */
export function pageShown(
  doc: { visibilityState: string; pictureInPictureElement?: Element | null },
  video?: { webkitPresentationMode?: string } | null,
): boolean {
  if (doc.visibilityState === 'visible' || doc.pictureInPictureElement) return true;
  if (video?.webkitPresentationMode === 'picture-in-picture') return true;
  const canTell = 'pictureInPictureElement' in doc || typeof video?.webkitPresentationMode === 'string';
  return !canTell;
}

/** Hidden long enough that the picture can go (`hiddenAt`: when it was hidden; null = shown). */
export const pictureOff = (hiddenAt: number | null | undefined, now: number): boolean => hiddenAt != null && now - hiddenAt >= HIDDEN_GRACE_MS;

export class ViewGate {
  private shown: boolean;
  private dcAt: number | null = null;
  private sent: ViewState | null = null;

  constructor(shown = true) {
    this.shown = shown;
  }

  /** The page's visibility (or picture-in-picture) changed. */
  setShown(shown: boolean): void {
    this.shown = shown;
  }

  get isShown(): boolean {
    return this.shown;
  }

  /** A message arrived on the camera's data channel. */
  dcMessage(now: number): void {
    this.dcAt = now;
  }

  /** The data channel closed (or the call ended). */
  dcClosed(): void {
    this.dcAt = null;
  }

  state(now: number): ViewState {
    return { vis: this.shown, dc: this.dcAt != null && now - this.dcAt < DC_STALE_MS };
  }

  /** What to tell the room, when it changed since the last time (null = nothing to say). */
  due(now: number): ViewState | null {
    const s = this.state(now);
    if (this.sent && this.sent.vis === s.vis && this.sent.dc === s.dc) return null;
    this.sent = s;
    return s;
  }

  /** A new room connection knows nothing: the next `due` says it again. */
  reset(): void {
    this.sent = null;
  }
}
