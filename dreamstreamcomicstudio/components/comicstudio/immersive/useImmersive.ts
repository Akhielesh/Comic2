// The immersive surface's platform glue (reader.md §11.3): Fullscreen API with an overlay fallback
// (iPhone Safari has no element fullscreen), page scroll lock, `theme-color` matched to the room, a
// screen wake lock while reading, and a history entry so the phone's Back gesture closes the reader
// instead of leaving the page. Everything degrades silently on older browsers.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FsDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
interface WakeLockSentinelLike {
  released?: boolean;
  release(): Promise<void>;
  addEventListener?(type: 'release', fn: () => void): void;
}
type WakeNavigator = Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } };

const HISTORY_KEY = '__dsReader';

export const fullscreenElement = (): Element | null => {
  if (typeof document === 'undefined') return null;
  const d = document as FsDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
};

export const fullscreenSupported = (): boolean => {
  if (typeof document === 'undefined') return false;
  const el = document.documentElement as FsElement;
  return typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function';
};

const requestFs = async (el: HTMLElement): Promise<boolean> => {
  const fe = el as FsElement;
  try {
    if (typeof fe.requestFullscreen === 'function') await fe.requestFullscreen({ navigationUI: 'hide' } as FullscreenOptions);
    else if (typeof fe.webkitRequestFullscreen === 'function') await fe.webkitRequestFullscreen();
    else return false;
    return !!fullscreenElement();
  } catch {
    return false;
  }
};

const exitFs = async () => {
  const d = document as FsDocument;
  try {
    if (!fullscreenElement()) return;
    if (typeof d.exitFullscreen === 'function') await d.exitFullscreen();
    else if (typeof d.webkitExitFullscreen === 'function') await d.webkitExitFullscreen();
  } catch {
    /* already out */
  }
};

export interface ImmersiveOptions {
  /** The reader is open. */
  active: boolean;
  /** Back gesture / explicit exit: the host unmounts the reader. */
  onExit(): void;
  /** `<meta name="theme-color">` while open. */
  themeColor?: string;
  /** Try the Fullscreen API on open (default true; needs the opening user gesture). */
  fullscreenOnOpen?: boolean;
}

export interface ImmersiveApi {
  /** Browser fullscreen is active (otherwise the overlay fills the viewport). */
  fullscreen: boolean;
  fullscreenSupported: boolean;
  wakeLockActive: boolean;
  toggleFullscreen(): Promise<void>;
  /** Leave the reader (removes the history entry, exits fullscreen, restores the page). */
  exit(): void;
}

export function useImmersive(root: RefObject<HTMLElement | null>, opts: ImmersiveOptions): ImmersiveApi {
  const { active, themeColor, fullscreenOnOpen = true } = opts;
  const onExitRef = useRef(opts.onExit);
  onExitRef.current = opts.onExit;
  const [fullscreen, setFullscreen] = useState(false);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const token = useRef(`r${Math.random().toString(36).slice(2, 10)}`);
  const closing = useRef(false);
  const cleanupTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Fullscreen (best effort) + scroll lock + fullscreen state.
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const html = document.documentElement;
    const body = document.body;
    const prev = { html: html.style.overflow, body: body.style.overflow };
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    const onFs = () => setFullscreen(!!fullscreenElement());
    document.addEventListener('fullscreenchange', onFs);
    document.addEventListener('webkitfullscreenchange', onFs);
    // Captured now: by cleanup time React has already detached the ref.
    const el = root.current;
    if (fullscreenOnOpen && el) void requestFs(el).then(onFs);
    return () => {
      document.removeEventListener('fullscreenchange', onFs);
      document.removeEventListener('webkitfullscreenchange', onFs);
      html.style.overflow = prev.html;
      body.style.overflow = prev.body;
      const fs = fullscreenElement();
      if (fs && el && (fs === el || el.contains(fs))) void exitFs();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Back gesture exits: one history entry for the reader (StrictMode-safe: a remount reuses it).
  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    if (cleanupTimer.current) {
      clearTimeout(cleanupTimer.current);
      cleanupTimer.current = null;
    }
    const ours = () => (window.history.state as Record<string, unknown> | null)?.[HISTORY_KEY] === token.current;
    try {
      if (!ours()) window.history.pushState({ ...((window.history.state as object) || {}), [HISTORY_KEY]: token.current }, '');
    } catch {
      /* sandboxed */
    }
    closing.current = false;
    const onPop = () => {
      if (ours()) return;
      if (closing.current) return;
      closing.current = true;
      onExitRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      cleanupTimer.current = setTimeout(() => {
        cleanupTimer.current = null;
        if (!closing.current && ours()) {
          closing.current = true;
          try {
            window.history.back();
          } catch {
            /* sandboxed */
          }
        }
      }, 0);
    };
  }, [active]);

  // theme-color follows the room.
  useEffect(() => {
    if (!active || typeof document === 'undefined' || !themeColor) return;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    const created = !meta;
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    const prev = meta.getAttribute('content');
    meta.setAttribute('content', themeColor);
    return () => {
      if (!meta) return;
      if (created) meta.remove();
      else if (prev !== null) meta.setAttribute('content', prev);
    };
  }, [active, themeColor]);

  // Screen wake lock while reading and visible; re-acquired when the tab comes back.
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || typeof document === 'undefined') return;
    const nav = navigator as WakeNavigator;
    if (!nav.wakeLock?.request) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let disposed = false;
    const acquire = async () => {
      if (disposed || document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return;
      try {
        const s = await nav.wakeLock!.request('screen');
        if (disposed) {
          void s.release().catch(() => undefined);
          return;
        }
        sentinel = s;
        setWakeLockActive(true);
        s.addEventListener?.('release', () => setWakeLockActive(false));
      } catch {
        setWakeLockActive(false);
      }
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    void acquire();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVis);
      if (sentinel && !sentinel.released) void sentinel.release().catch(() => undefined);
      sentinel = null;
      setWakeLockActive(false);
    };
  }, [active]);

  const toggleFullscreen = useCallback(async () => {
    if (fullscreenElement()) await exitFs();
    else if (root.current) await requestFs(root.current);
    setFullscreen(!!fullscreenElement());
  }, [root]);

  const exit = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    void exitFs();
    try {
      if ((window.history.state as Record<string, unknown> | null)?.[HISTORY_KEY] === token.current) window.history.back();
    } catch {
      /* sandboxed */
    }
    onExitRef.current();
  }, []);

  return { fullscreen, fullscreenSupported: fullscreenSupported(), wakeLockActive, toggleFullscreen, exit };
}
