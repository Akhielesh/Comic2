// The reader's own "Reduce motion" and own page-turn pick, read on their own (readerPrefs.ts keeps every other
// preference under the same key, and validates the pick with the same rule, storedTurnPick). The comics landing's sample
// reader honours both on the landing's first load, so it imports only this, never the reader's whole preference model
// (nor shared/comic/doc.ts). Blocked or junk storage reads as no setting.

import type { PageTurnStyle } from '../../../shared/comic/doc';

/** The reader's preferences in localStorage (readerPrefs.ts reads and writes them; contract §13.5). */
export const PREFS_KEY = 'comicstudio.reader.prefs.v1';

/** The four page-turn styles (shared/comic/doc.ts PAGE_TURN_STYLES; readerPrefs.test.ts pins the two together). */
export const STORED_TURN_STYLES: readonly PageTurnStyle[] = ['flip', 'paper', 'slide', 'fade'];

/**
 * The reader's own page-turn pick in stored preferences, or undefined when there is none ('auto': the creator's style,
 * else the flip). Release #316's Reading mode switch wrote turn 'paper' whenever a reader went back to turning pages:
 * that was never a pick, so a stored 'paper' counts only with `turnPicked`. Flip, slide and fade could only ever be
 * picked, so they keep without it.
 */
export const storedTurnPick = (raw: { turn?: unknown; turnPicked?: unknown }): PageTurnStyle | undefined => {
  const turn = STORED_TURN_STYLES.find((s) => s === raw.turn);
  return turn && (turn !== 'paper' || raw.turnPicked === true) ? turn : undefined;
};

const readStored = (): Record<string, unknown> | null => {
  try {
    if (typeof window === 'undefined') return null;
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return null;
    const prefs: unknown = JSON.parse(raw);
    return prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? (prefs as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** True when the reader turned Reduce motion on in the full-screen reader's settings (on this device). */
export const readReduceMotionPref = (): boolean => readStored()?.reduceMotion === true;

/** The page-turn style the reader picked in the full-screen reader's settings (on this device), if they picked one. */
export const readTurnPick = (): PageTurnStyle | undefined => {
  const prefs = readStored();
  return prefs ? storedTurnPick(prefs) : undefined;
};
