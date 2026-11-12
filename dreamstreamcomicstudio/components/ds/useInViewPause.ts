/**
 * useInViewPause — Atlas hooks/useInViewPause.ts: holds the CSS loops inside an element (styles/ds-motion.css
 * `.ds-live-dot`, `.ds-caret`, `.ds-marquee`, and the `.ds-skeleton` / `.ds-shimmer-text` loading loops) still
 * while it is off screen or the tab is in the background, by marking it `data-inview="false"`. An infinite
 * animation keeps the browser producing a frame every 16 ms even where nobody can see it; this lets the page
 * go idle. ONE IntersectionObserver and one visibility listener serve every host on the page, and each
 * callback only flips an attribute, so a page full of live dots costs no React renders. Before the first
 * observation, and where IntersectionObserver is missing, the attribute is absent and the loops simply run.
 */
import { useEffect, type RefObject } from 'react';

/** The attribute styles/ds-motion.css reads to hold the ambient loops. */
export const inViewAttribute = 'data-inview';

/** Start a loop a little before it scrolls in, so it is already moving when it appears. */
export const inViewRootMargin = '96px 0px';

interface ObservedHost {
  /** How many hooks observe this element (normally one). */
  users: number;
  /** The last intersection the observer reported; null until its first report. */
  intersecting: boolean | null;
}

let sharedObserver: IntersectionObserver | null = null;
const hosts = new Map<Element, ObservedHost>();

const isPageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/** Writes the host's attribute from what is known: a hidden tab first, then the last intersection. */
function paint(element: Element, host: ObservedHost) {
  if (isPageHidden()) element.setAttribute(inViewAttribute, 'false');
  else if (host.intersecting === null) element.removeAttribute(inViewAttribute);
  else element.setAttribute(inViewAttribute, host.intersecting ? 'true' : 'false');
}

function markInView(entries: IntersectionObserverEntry[]) {
  for (const entry of entries) {
    const host = hosts.get(entry.target);
    if (!host) continue;
    host.intersecting = entry.isIntersecting;
    paint(entry.target, host);
  }
}

/** A background tab draws nothing, but its loops still count as running: hold them until it is shown again. */
function handleVisibilityChange() {
  hosts.forEach((host, element) => paint(element, host));
}

function observe(element: Element) {
  const existing = hosts.get(element);
  if (existing) {
    existing.users += 1;
    return;
  }
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver(markInView, { rootMargin: inViewRootMargin });
    document.addEventListener('visibilitychange', handleVisibilityChange);
  }
  const host: ObservedHost = { users: 1, intersecting: null };
  hosts.set(element, host);
  sharedObserver.observe(element);
  paint(element, host);
}

function unobserve(element: Element) {
  const host = hosts.get(element);
  if (!host || !sharedObserver) return;
  host.users -= 1;
  if (host.users > 0) return;
  hosts.delete(element);
  sharedObserver.unobserve(element);
  element.removeAttribute(inViewAttribute);
  if (hosts.size === 0) {
    sharedObserver.disconnect();
    sharedObserver = null;
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  }
}

/** Mark `ref`'s element data-inview="false" while it is off screen or the tab is hidden. */
export function useInViewPause<T extends Element>(ref: RefObject<T | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    observe(element);
    return () => unobserve(element);
  }, [ref]);
}
