/**
 * The boot splash hand-off. live.html paints a static splash inside #live-root (mark, wordmark, a
 * progress line) until React replaces it; for a gated screen the first thing React draws is the
 * account splash (SignInGate's GateSplash), which uses the same markup and the same rules (the
 * <style> in live.html), so the swap moves nothing. What a swap would still restart is the progress
 * line's animations: main.tsx reads the static line's start time just before React renders, and the
 * account splash continues from it — no second fade-in, no jump back to the start of the sweep.
 */
import type { CSSProperties } from 'react';

/** The bar fades in this long after the splash first paints (live.html .boot-bar). */
const BAR_DELAY_MS = 400;
/** One sweep of the line (live.html .boot-bar i). */
const SWEEP_MS = 1400;

let startedAt: number | null = null;

const timelineNow = (): number | null => {
  try {
    const t = document.timeline?.currentTime;
    return typeof t === 'number' ? t : null;
  } catch {
    return null;
  }
};

/** Call once, before createRoot(...).render: remembers when the static splash's line started. */
export function captureBootSplash(root: ParentNode | null): void {
  try {
    const line = root?.querySelector<HTMLElement>('[data-live-boot] .boot-bar i');
    const anim = line?.getAnimations?.()[0];
    if (anim && typeof anim.startTime === 'number') startedAt = anim.startTime;
  } catch {
    /* no Web Animations API: the account splash starts its own line */
  }
}

/** Inline styles that continue the static splash's line (empty when there was none to continue). */
export function bootLineStyles(): { bar?: CSSProperties; sweep?: CSSProperties } {
  if (startedAt == null) return {};
  const now = timelineNow();
  if (now == null) return {};
  const elapsed = Math.max(0, now - startedAt);
  return {
    bar: elapsed >= BAR_DELAY_MS ? { animation: 'none', opacity: 1 } : { animationDelay: `${Math.round(BAR_DELAY_MS - elapsed)}ms` },
    sweep: { animationDelay: `${-Math.round(elapsed % SWEEP_MS)}ms` },
  };
}

/** Tests only. */
export function resetBootSplash(): void {
  startedAt = null;
}
