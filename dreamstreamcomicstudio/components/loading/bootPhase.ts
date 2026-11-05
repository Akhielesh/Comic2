import { BOOT, SPLASH_BAR_SELECTOR } from './bootGeometry';

/**
 * How far the static splash's bar has swept, as a negative CSS animation-delay ("-640ms"), so the React
 * boot screen that replaces it carries on from the same point instead of jumping back to the start.
 *
 * Read during AppLoader's first render: React clears #root (and the splash in it) only when it commits,
 * so the splash's bar is still in the document then. Anything missing (no splash, a browser without
 * getAnimations, an animation that is not running, reduced motion) gives "0ms": the bar simply starts
 * from the left, as it always did. Never throws.
 */
export function splashSweepDelay(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): string {
  try {
    const bar = doc?.querySelector<HTMLElement>(SPLASH_BAR_SELECTOR);
    const animations = bar && typeof bar.getAnimations === 'function' ? bar.getAnimations() : [];
    for (const animation of animations) {
      // A document-timeline animation reports milliseconds as a number (a scroll timeline would not).
      const ms = animation.currentTime;
      if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) return `-${Math.round(ms % BOOT.sweepMs)}ms`;
    }
  } catch {
    /* the bar just starts from the left */
  }
  return '0ms';
}
