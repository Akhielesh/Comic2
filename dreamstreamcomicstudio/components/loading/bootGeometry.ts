/**
 * The boot screen's measurements, shared by the two places that draw it:
 *   - the static splash in index.html (#app-splash, inline CSS, painted before any script runs), and
 *   - AppLoader's `boot` variant (React), which replaces the splash when the app mounts.
 * Both draw the same thing in the same place: the DreamStream mark and wordmark, and under them a thin
 * indeterminate bar. Because every number matches, the swap from HTML to React is invisible, and
 * AppLoader carries on the bar's sweep from the phase the splash had reached (bootPhase.ts).
 * bootSplash.test.ts reads index.html and fails if the splash drifts from these values.
 */
export const BOOT = {
  /** The mark's side, px. */
  markPx: 40,
  /** The wordmark's size, px (Space Grotesk 600, "Studio" at 55 %). */
  wordPx: 22,
  /** Between the mark and the wordmark, px. */
  lockupGapPx: 12,
  /** Between the lockup and the bar, px. */
  stackGapPx: 28,
  /** The bar's track, px. */
  trackWidthPx: 160,
  trackHeightPx: 2,
  /** The moving segment's share of the track (the ds-progress-indeterminate shape). */
  barShare: 0.4,
  /** One sweep across the track, ms (as .ds-progress-indeterminate in styles/ds-motion.css). */
  sweepMs: 1300,
  /** The caption line under the bar (a label or the wake hint), px from the bar. */
  captionGapPx: 20,
} as const;

/** The splash's moving bar, which AppLoader reads its phase from (bootPhase.ts). */
export const SPLASH_BAR_SELECTOR = '#app-splash .ds-boot-bar';
