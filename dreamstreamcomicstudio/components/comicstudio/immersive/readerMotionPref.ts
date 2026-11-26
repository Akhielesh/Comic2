// The reader's own "Reduce motion", read on its own (readerPrefs.ts keeps every other preference under the same key).
// The comics landing's sample reader honours it on the landing's first load, so it imports only this, never the
// reader's whole preference model. Blocked or junk storage reads as off.

/** The reader's preferences in localStorage (readerPrefs.ts reads and writes them; contract §13.5). */
export const PREFS_KEY = 'comicstudio.reader.prefs.v1';

/** True when the reader turned Reduce motion on in the full-screen reader's settings (on this device). */
export const readReduceMotionPref = (): boolean => {
  try {
    if (typeof window === 'undefined') return false;
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return false;
    const prefs: unknown = JSON.parse(raw);
    return !!prefs && typeof prefs === 'object' && (prefs as { reduceMotion?: unknown }).reduceMotion === true;
  } catch {
    return false;
  }
};
