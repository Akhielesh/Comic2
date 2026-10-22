// Image memory budget (mobile.md §8.3). A 40-page comic decoded at full size is ~680 MB — an iOS tab
// crash. One shared IntersectionObserver tracks every heavy image (reader scroll pages, the Pages
// grid, chat render tiles, the media bin). Once more than the budget are mounted (8 on iOS or
// low-memory devices, else 16), images more than ~2 viewports away are RELEASED: the consumer drops
// its `src` (keeping the aspect box and placeholder) and gets it back as soon as it comes near.
// Images in a hidden pane (`hidden` / display:none) never intersect, so they release too.

import { useCallback, useEffect, useRef, useState } from 'react';

export const BUDGET_DEFAULT = 16;
export const BUDGET_LOW = 8;
/** "Near" = within this margin of the viewport (≈ 2 viewports above and below). */
export const NEAR_MARGIN = '200% 0px';

type Entry = { near: boolean; set: (released: boolean) => void; released: boolean };

const entries = new Map<Element, Entry>();
let observer: IntersectionObserver | null = null;
let budgetOverride: number | null = null;

const isIOS = (): boolean => {
  try {
    const ua = navigator.userAgent || '';
    return /iP(hone|ad|od)/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
  } catch {
    return false;
  }
};

/** Budget for this device. */
export const imageBudget = (): number => {
  if (budgetOverride !== null) return budgetOverride;
  let low = false;
  try {
    const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory;
    low = typeof mem === 'number' && mem > 0 && mem <= 4;
  } catch {
    /* unknown */
  }
  return low || isIOS() ? BUDGET_LOW : BUDGET_DEFAULT;
};

/**
 * Pure policy: which tracked images are released. Under the budget nothing is; over it, every image
 * that is not near the viewport is.
 */
export const releasePlan = (items: ReadonlyArray<{ near: boolean }>, budget: number): boolean[] =>
  items.length <= budget ? items.map(() => false) : items.map((it) => !it.near);

const rebalance = () => {
  const list = [...entries.values()];
  const plan = releasePlan(list, imageBudget());
  list.forEach((e, i) => {
    if (e.released !== plan[i]) {
      e.released = plan[i];
      e.set(plan[i]);
    }
  });
};

const ensureObserver = (): IntersectionObserver | null => {
  if (observer || typeof IntersectionObserver === 'undefined') return observer;
  observer = new IntersectionObserver(
    (records) => {
      for (const r of records) {
        const e = entries.get(r.target);
        if (e) e.near = r.isIntersecting;
      }
      rebalance();
    },
    { rootMargin: NEAR_MARGIN }
  );
  return observer;
};

const track = (el: Element, set: (released: boolean) => void) => {
  entries.set(el, { near: true, set, released: false });
  ensureObserver()?.observe(el);
  rebalance();
};

const untrack = (el: Element) => {
  observer?.unobserve(el);
  entries.delete(el);
  if (!entries.size && observer) {
    observer.disconnect();
    observer = null;
  }
  rebalance();
};

/**
 * Register a heavy image's box. Returns a ref for the element and whether its pixels should be
 * released right now (render the placeholder / an empty `src` while true). `heavy=false` opts out.
 */
export function useImageBudget<T extends Element>(heavy = true): [(el: T | null) => void, boolean] {
  const [released, setReleased] = useState(false);
  const current = useRef<T | null>(null);
  const ref = useCallback(
    (el: T | null) => {
      if (current.current === el) return;
      if (current.current) untrack(current.current);
      current.current = el;
      if (el && heavy) track(el, setReleased);
      else setReleased(false);
    },
    [heavy]
  );
  useEffect(
    () => () => {
      if (current.current) untrack(current.current);
      current.current = null;
    },
    []
  );
  return [ref, heavy && released];
}

/** Diagnostics / tests. */
export const trackedImageCount = (): number => entries.size;

/** Test hook: pin the budget (null = device default) and forget tracked images. */
export const resetImageBudget = (budget: number | null = null): void => {
  budgetOverride = budget;
  entries.clear();
  observer?.disconnect();
  observer = null;
};
