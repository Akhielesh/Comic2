/**
 * useScrollRestore — a list comes back where you left it (redesign plan §4, §9: "hidden places keep only their
 * scroll position"; it replaces BoardPane's own scroll memory). The position is kept per key for this tab
 * (sessionStorage through storage.ts), written while scrolling at most once a frame and on unmount, and put
 * back once when the scroller mounts with content tall enough to reach it.
 *
 * Pass the scroller's ref and a key naming what it shows (`library:grid`, `studio:<comicId>:pages`). A null
 * key turns it off. Nothing here fetches; the only scheduling is one animation frame per burst of scroll events.
 */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { readStored, scopedKey, storedNumberIn, writeStored } from './storage';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const MAX_SCROLL = 10_000_000;
const parseTop = storedNumberIn(0, MAX_SCROLL);

/** The remembered scroll position for `key` (0 when none). */
export function readScrollPosition(key: string): number {
  return readStored(scopedKey('scroll', key), 0, { area: 'session', parse: parseTop });
}

export function writeScrollPosition(key: string, top: number): void {
  if (!Number.isFinite(top) || top < 0) return;
  writeStored(scopedKey('scroll', key), Math.round(top), { area: 'session' });
}

export function useScrollRestore<T extends HTMLElement>(ref: RefObject<T | null>, key: string | null): void {
  const restored = useRef<string | null>(null);

  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || !key || restored.current === key) return;
    restored.current = key;
    const top = readScrollPosition(key);
    if (top > 0) el.scrollTop = top;
  }, [ref, key]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !key) return;
    let frame: number | null = null;
    const save = () => writeScrollPosition(key, el.scrollTop);
    const onScroll = () => {
      if (frame !== null) return;
      if (typeof window.requestAnimationFrame !== 'function') {
        save();
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = null;
        save();
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (frame !== null) window.cancelAnimationFrame(frame);
      save();
    };
  }, [ref, key]);
}
