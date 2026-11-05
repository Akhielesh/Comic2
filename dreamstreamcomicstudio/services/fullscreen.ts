// One full-screen helper for every reader (classic ComicReader, the v4 ComicReaderView, the immersive reader's
// useImmersive).
//
// Rules (mobile-reading hotfix, 2026-10-29):
// - Capability detection first: iPhone browsers (Safari and Chrome for iOS) have no element full screen at all, an
//   iframe without allow="fullscreen" reports fullscreenEnabled=false, iPad Safari only has the webkit-prefixed API.
// - The request is made SYNCHRONOUSLY inside the tap (user activation does not survive an await):
//   requestFullscreen({ navigationUI: 'hide' }), else webkitRequestFullscreen.
// - When the API is missing or the browser refuses, the caller's reading-mode fallback runs (exactly once). The
//   helper never throws and never leaves an unhandled rejection, so a Full screen button is never dead.
// - Full-screen STATE comes only from fullscreenchange / webkitfullscreenchange (onFullscreenChange +
//   isFullscreenActive) or the caller's own reading-mode flag — never optimistically from the tap, so a refused
//   request can never leave an "Exit" label behind.
// - Back leaves a fallback before it closes the reader: each fallback (the classic reading mode, the v4 viewport mode)
//   is a 'fullscreen' layer on the Back stack (components/comicstudio/mobile/backStack.ts useBackLayer), above the
//   reader's own 'reader:<id>' layer; native full screen needs none (the browser leaves it on Back itself). The
//   immersive reader is an 'immersive' layer on the same stack (useImmersive): one history owner for every reader.

type WebkitElement = Element & {
  webkitRequestFullscreen?: () => void | Promise<void>;
  webkitRequestFullScreen?: () => void | Promise<void>;
};

type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitCurrentFullScreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => void | Promise<void>;
};

export type FullscreenApi = 'standard' | 'webkit' | 'none';
export type FullscreenFallbackReason = 'unsupported' | 'rejected';

/** How long a webkit request (no promise) may stay silent before the reading mode takes over. */
const WEBKIT_SETTLE_MS = 1500;

const doc = (): WebkitDocument | null => (typeof document === 'undefined' ? null : (document as WebkitDocument));

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  !!value && (typeof value === 'object' || typeof value === 'function') && typeof (value as PromiseLike<unknown>).then === 'function';

/** Which full-screen API this element can use. 'none' means the reader must use its own reading mode. */
export const fullscreenApi = (el?: Element | null): FullscreenApi => {
  const d = doc();
  if (!d) return 'none';
  const target = (el ?? d.documentElement) as WebkitElement | null;
  if (!target) return 'none';
  // An iframe without allow="fullscreen" (or a browser policy) refuses every request: skip straight to the fallback.
  if (d.fullscreenEnabled === false && d.webkitFullscreenEnabled !== true) return 'none';
  if (typeof target.requestFullscreen === 'function') return 'standard';
  if (typeof target.webkitRequestFullscreen === 'function' || typeof target.webkitRequestFullScreen === 'function') return 'webkit';
  return 'none';
};

/** The element currently shown full screen (standard or webkit-prefixed), or null. */
export const fullscreenElement = (): Element | null => {
  const d = doc();
  if (!d) return null;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? d.webkitCurrentFullScreenElement ?? null;
};

/** True when `el` (or, without `el`, anything) is full screen right now. */
export const isFullscreenActive = (el?: Element | null): boolean => {
  const current = fullscreenElement();
  if (!current) return false;
  return el ? current === el : true;
};

/** Subscribe to full-screen changes (both event names). Returns the unsubscribe function. */
export const onFullscreenChange = (cb: () => void): (() => void) => {
  const d = doc();
  if (!d) return () => undefined;
  const names = ['fullscreenchange', 'webkitfullscreenchange'];
  names.forEach((n) => d.addEventListener(n, cb));
  return () => names.forEach((n) => d.removeEventListener(n, cb));
};

export interface EnterFullscreenOptions {
  /** The reader's own reading mode: runs at most once, when native full screen is missing or refused. */
  onFallback: (reason: FullscreenFallbackReason) => void;
  /**
   * Runs at most once when the request succeeded (its promise resolved, or a change event arrived): a caller that
   * reads its state there (isFullscreenActive / fullscreenElement) reads the browser's own answer, never a guess.
   */
  onEntered?: () => void;
}

/**
 * Ask for native full screen on `el`. Call it directly from the tap/click handler (no await before it).
 * Returns 'fallback' when the reading mode ran synchronously (no API), else 'requested' — the outcome then arrives
 * as a fullscreenchange event, or as onFallback('rejected').
 */
export const enterFullscreen = (el: Element | null | undefined, { onFallback, onEntered }: EnterFullscreenOptions): 'requested' | 'fallback' => {
  let settled = false;
  const cleanups: Array<() => void> = [];
  const settle = () => {
    settled = true;
    cleanups.splice(0).forEach((fn) => fn());
  };
  const entered = () => {
    if (settled) return;
    settle();
    try {
      onEntered?.();
    } catch {
      /* a caller bug must never escape */
    }
  };
  const fallback = (reason: FullscreenFallbackReason) => {
    if (settled) return;
    settle();
    try {
      onFallback(reason);
    } catch {
      /* a caller bug must never escape the tap */
    }
  };

  if (!el || fullscreenApi(el) === 'none') {
    fallback('unsupported');
    return 'fallback';
  }
  const target = el as WebkitElement;
  const d = doc();

  // Requests that report back only through events (webkit, or a standard API without a promise).
  const watchEvents = () => {
    if (!d) return;
    const onChange = () => {
      if (isFullscreenActive()) entered();
    };
    const onError = () => fallback('rejected');
    const names: Array<[string, () => void]> = [
      ['fullscreenchange', onChange],
      ['webkitfullscreenchange', onChange],
      ['fullscreenerror', onError],
      ['webkitfullscreenerror', onError]
    ];
    names.forEach(([n, fn]) => d.addEventListener(n, fn));
    cleanups.push(() => names.forEach(([n, fn]) => d.removeEventListener(n, fn)));
    const timer = setTimeout(() => {
      if (isFullscreenActive()) entered();
      else fallback('rejected');
    }, WEBKIT_SETTLE_MS);
    cleanups.push(() => clearTimeout(timer));
  };

  const tryWebkit = (): boolean => {
    const fn = target.webkitRequestFullscreen ?? target.webkitRequestFullScreen;
    if (typeof fn !== 'function') return false;
    try {
      watchEvents();
      const result = fn.call(target);
      if (isThenable(result)) result.then(() => entered(), () => fallback('rejected'));
      return true;
    } catch {
      return false;
    }
  };

  if (typeof target.requestFullscreen === 'function') {
    try {
      const result = target.requestFullscreen({ navigationUI: 'hide' });
      if (isThenable(result)) {
        result.then(
          () => entered(),
          () => fallback('rejected')
        );
      } else {
        watchEvents();
      }
      return 'requested';
    } catch {
      // Some engines throw synchronously (old option handling, sandboxing): try the prefixed API next.
      if (tryWebkit()) return 'requested';
      fallback('rejected');
      return 'requested';
    }
  }
  if (tryWebkit()) return 'requested';
  fallback('unsupported');
  return 'fallback';
};

/** Leave native full screen if this document is in it. Never throws; a refusal is swallowed. */
export const exitFullscreen = (): void => {
  const d = doc();
  if (!d) return;
  try {
    if (d.fullscreenElement && typeof d.exitFullscreen === 'function') {
      const result = d.exitFullscreen();
      if (isThenable(result)) result.then(undefined, () => undefined);
      return;
    }
    if ((d.webkitFullscreenElement || d.webkitCurrentFullScreenElement) && typeof d.webkitExitFullscreen === 'function') {
      const result = d.webkitExitFullscreen();
      if (isThenable(result)) result.then(undefined, () => undefined);
    }
  } catch {
    /* nothing to exit */
  }
};

// ── The one-time iPhone note ────────────────────────────────────────────────────────────────────────────────
// iPhone browsers have no element full screen, so the reading mode is the best a web page can do there. The
// manifest is display: standalone, so a Home Screen install opens edge-to-edge: say so once, honestly.

export const IOS_FULLSCREEN_NOTE = 'iPhone browsers keep their toolbars. Share → Add to Home Screen opens comics edge-to-edge.';

const NOTE_KEY = 'reader_ios_fullscreen_note';
let noteSeenThisSession = false;

/** iPhone / iPod (Safari, Chrome for iOS and every other iOS browser share the same engine and limits). */
export const isIPhone = (): boolean => typeof navigator !== 'undefined' && /iPhone|iPod/i.test(navigator.userAgent || '');

const isStandalone = (): boolean => {
  if (typeof window === 'undefined') return false;
  if ((window.navigator as Navigator & { standalone?: boolean }).standalone === true) return true;
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
  } catch {
    return false;
  }
};

export const shouldShowIosFullscreenNote = (): boolean => {
  if (!isIPhone() || isStandalone() || noteSeenThisSession) return false;
  try {
    return window.localStorage.getItem(NOTE_KEY) !== 'seen';
  } catch {
    return true;
  }
};

export const markIosFullscreenNoteSeen = (): void => {
  noteSeenThisSession = true;
  try {
    window.localStorage.setItem(NOTE_KEY, 'seen');
  } catch {
    /* private mode: remembered for this session only */
  }
};

/** Tests only: forget the in-memory flag (and, unless keepStorage, the stored one). */
export const resetIosFullscreenNoteForTests = (opts: { keepStorage?: boolean } = {}): void => {
  noteSeenThisSession = false;
  if (opts.keepStorage) return;
  try {
    window.localStorage.removeItem(NOTE_KEY);
  } catch {
    /* ignore */
  }
};
