/**
 * useScrollRestore — a list comes back where you left it (redesign plan §4, §9: "hidden places keep only their
 * scroll position"; it replaces BoardPane's own scroll memory). The position is kept per key for this tab
 * (sessionStorage through storage.ts), written while scrolling at most once a frame and on unmount, and put
 * back once the scroller's content is tall enough to reach it.
 *
 * Lists whose items arrive after mount (the Library loads its comics, a grid pages in) start too short to reach
 * the remembered spot, so the restore waits: it tries again as the content grows (a ResizeObserver on the scroller
 * and its first child, a MutationObserver on what it holds), at most RESTORE_ATTEMPTS times. While it waits nothing
 * is written, so the 0 the list starts at never overwrites the remembered position; the person scrolling first ends
 * the wait (their position wins from then on).
 *
 * Pass the scroller's ref and a key naming what it shows (`library:grid`, `studio:<comicId>:pages`). A null
 * key turns it off. Nothing here fetches and nothing sets a timer; the only scheduling is one animation frame per
 * burst of scroll events, and the observers live only while a restore is waiting.
 */
import { useEffect, useLayoutEffect, type RefObject } from 'react';
import { readStored, scopedKey, storedNumberIn, writeStored } from './storage';

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;
const MAX_SCROLL = 10_000_000;
const parseTop = storedNumberIn(0, MAX_SCROLL);
/** How many content changes a waiting restore checks before it stops watching (the position stays remembered). */
export const RESTORE_ATTEMPTS = 60;

/** The remembered scroll position for `key` (0 when none). */
export function readScrollPosition(key: string): number {
  return readStored(scopedKey('scroll', key), 0, { area: 'session', parse: parseTop });
}

export function writeScrollPosition(key: string, top: number): void {
  if (!Number.isFinite(top) || top < 0) return;
  writeStored(scopedKey('scroll', key), Math.round(top), { area: 'session' });
}

export function useScrollRestore<T extends HTMLElement>(ref: RefObject<T | null>, key: string | null): void {
  useIsoLayoutEffect(() => {
    const el = ref.current;
    if (!el || !key) return;
    const want = readScrollPosition(key);
    // Waiting: a remembered position the content cannot reach yet. Nothing is saved while waiting.
    let waiting = want > 0;
    let attempts = 0;
    let watchers: Array<{ disconnect(): void }> = [];
    const stopWatching = () => {
      for (const w of watchers) w.disconnect();
      watchers = [];
    };
    const tryRestore = () => {
      if (!waiting) return;
      if (el.scrollHeight - el.clientHeight >= want) {
        waiting = false;
        stopWatching();
        el.scrollTop = want;
        return;
      }
      // Bounded: a list that never grows that tall stops being watched; its position stays remembered.
      attempts += 1;
      if (attempts >= RESTORE_ATTEMPTS) stopWatching();
    };
    tryRestore();
    if (waiting) {
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(tryRestore);
        ro.observe(el);
        if (el.firstElementChild) ro.observe(el.firstElementChild);
        watchers.push(ro);
      }
      if (typeof MutationObserver !== 'undefined') {
        const mo = new MutationObserver(tryRestore);
        mo.observe(el, { childList: true, subtree: true });
        watchers.push(mo);
      }
    }

    let frame: number | null = null;
    const save = () => {
      if (!waiting) writeScrollPosition(key, el.scrollTop);
    };
    const onScroll = () => {
      // The person scrolled before the content could reach the remembered spot: their position wins.
      if (waiting) {
        waiting = false;
        stopWatching();
      }
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
      stopWatching();
      if (frame !== null) window.cancelAnimationFrame(frame);
      save();
    };
  }, [ref, key]);
}
