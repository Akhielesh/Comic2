// The immersive surface's platform glue (reader.md §11.3): Fullscreen API with an overlay fallback
// (iPhone Safari has no element fullscreen), page scroll lock, `theme-color` matched to the room, a
// screen wake lock while reading, and a layer on the Back stack (mobile/backStack.ts, key 'immersive') so the
// phone's Back gesture closes the reader instead of leaving the page. Everything degrades silently on older browsers.
//
// One history owner: the reader's entry is the Back stack's like every other layer's (the readers' own 'reader:<id>'
// layer, the 'fullscreen' fallbacks, sheets), so Back closes the topmost first and a reload never leaves a dead entry.
//
// Full screen goes through the one helper every reader shares (services/fullscreen.ts): requested inside
// the opening tap, standard then webkit, never throws; the state is the browser's own (fullscreenchange,
// or the element it reports once a request succeeds), never a guess; when the browser has no API or
// refuses, the overlay IS the fallback and the host hears about it (onFullscreenFallback).

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { enterFullscreen, exitFullscreen, fullscreenApi, fullscreenElement, onFullscreenChange, type FullscreenFallbackReason } from '../../../services/fullscreen';
import { historyLayers, layerKey, useBackLayer } from '../mobile/backStack';

export { fullscreenElement };

interface WakeLockSentinelLike {
  released?: boolean;
  release(): Promise<void>;
  addEventListener?(type: 'release', fn: () => void): void;
}
type WakeNavigator = Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } };

/** The immersive reader's layer on the Back stack (Back closes the reader). */
export const IMMERSIVE_LAYER = 'immersive';
/** The reader's own history entry is still the current one (it is popped as the reader closes). */
export const readerEntryOnTop = (): boolean => historyLayers().some((id) => layerKey(id) === IMMERSIVE_LAYER);

/** The browser can show an element full screen here (standard or webkit; not in an iframe that forbids it). */
export const fullscreenSupported = (): boolean => fullscreenApi() !== 'none';

export interface ImmersiveOptions {
  /** The reader is open. */
  active: boolean;
  /** Back gesture / explicit exit: the host unmounts the reader. */
  onExit(): void;
  /** `<meta name="theme-color">` while open. */
  themeColor?: string;
  /** Try the Fullscreen API on open (default true; needs the opening user gesture). */
  fullscreenOnOpen?: boolean;
  /** Native full screen is missing (iPhone) or was refused: the overlay is what the reader gets. */
  onFullscreenFallback?(reason: FullscreenFallbackReason): void;
}

export interface ImmersiveApi {
  /** Browser fullscreen is active (otherwise the overlay fills the viewport). */
  fullscreen: boolean;
  fullscreenSupported: boolean;
  wakeLockActive: boolean;
  toggleFullscreen(): Promise<void>;
  /** Leave the reader (exits fullscreen; as the host unmounts it, its history entry goes and the page is restored). */
  exit(): void;
}

export function useImmersive(root: RefObject<HTMLElement | null>, opts: ImmersiveOptions): ImmersiveApi {
  const { active, themeColor, fullscreenOnOpen = true } = opts;
  const onExitRef = useRef(opts.onExit);
  onExitRef.current = opts.onExit;
  const onFallbackRef = useRef(opts.onFullscreenFallback);
  onFallbackRef.current = opts.onFullscreenFallback;
  const [fullscreen, setFullscreen] = useState(false);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const closing = useRef(false);

  // Fullscreen (best effort) + scroll lock + fullscreen state.
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    const html = document.documentElement;
    const body = document.body;
    const prev = { html: html.style.overflow, body: body.style.overflow };
    html.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    const onFs = () => setFullscreen(!!fullscreenElement());
    const unsubscribe = onFullscreenChange(onFs);
    // Captured now: by cleanup time React has already detached the ref.
    const el = root.current;
    if (fullscreenOnOpen && el) enterFullscreen(el, { onEntered: onFs, onFallback: (reason) => onFallbackRef.current?.(reason) });
    return () => {
      unsubscribe();
      html.style.overflow = prev.html;
      body.style.overflow = prev.body;
      const fs = fullscreenElement();
      if (fs && el && (fs === el || el.contains(fs))) exitFullscreen();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Back gesture exits: the reader is one layer on the Back stack (one history entry above whatever opened it;
  // StrictMode-safe: a remount revives it). Back pops it and the reader closes; closing from the reader (exit) lets
  // the host unmount it, and the layer's entry goes with it (the Back stack's close-from-the-UI, one tick later).
  useEffect(() => {
    if (active) closing.current = false;
  }, [active]);
  const exitOnBack = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    onExitRef.current();
  }, []);
  useBackLayer(active, exitOnBack, IMMERSIVE_LAYER);

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

  // Called from the tap (the request stays inside the user gesture); the state follows the browser's events.
  const toggleFullscreen = useCallback(async () => {
    const sync = () => setFullscreen(!!fullscreenElement());
    if (fullscreenElement()) exitFullscreen();
    else if (root.current) enterFullscreen(root.current, { onEntered: sync, onFallback: (reason) => onFallbackRef.current?.(reason) });
    sync();
  }, [root]);

  const exit = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    exitFullscreen();
    // The host unmounts the reader: its Back-stack layer closes from the UI and pops its entry.
    onExitRef.current();
  }, []);

  return { fullscreen, fullscreenSupported: fullscreenSupported(), wakeLockActive, toggleFullscreen, exit };
}
