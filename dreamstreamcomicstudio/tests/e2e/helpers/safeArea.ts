// Safe-area and hinge emulation (P1-QA; mobile.md §10.3.4–5).
//
// Headless browsers report env(safe-area-inset-*) = 0, so the studio reads its insets from the
// `--sa-*` tokens on :root (index.css: `--sa-top: env(safe-area-inset-top, 0px)` …). Overriding
// those tokens inline on <html> emulates a notch / home indicator exactly the way the app sees one.
//
// Dual-screen foldables: Chromium can emulate a display feature through CDP
// (`Emulation.setDisplayFeaturesOverride`), which drives the viewport-segment media queries and
// `window.viewport.segments`. When the running browser does not support it, `stubSegments` installs
// a `window.viewport.segments` shim before the app boots so the same layout code path still runs;
// the spec records which one it used.

import type { Page } from '@playwright/test';
import type { ComicDevice, Insets } from '../devices';

export type { Insets };

/** Set `--sa-top/right/bottom/left` on :root (call after navigation, before measuring). */
export async function setSafeAreas(page: Page, insets: Insets): Promise<void> {
  await page.evaluate((sa) => {
    const s = document.documentElement.style;
    s.setProperty('--sa-top', `${sa.top}px`);
    s.setProperty('--sa-right', `${sa.right}px`);
    s.setProperty('--sa-bottom', `${sa.bottom}px`);
    s.setProperty('--sa-left', `${sa.left}px`);
    window.dispatchEvent(new Event('resize'));
  }, insets);
}

export async function clearSafeAreas(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const k of ['--sa-top', '--sa-right', '--sa-bottom', '--sa-left']) document.documentElement.style.removeProperty(k);
  });
}

/** The insets the device should be measured with (zero for desktop). */
export const safeAreaFor = (d: ComicDevice): Insets => d.safeArea;

export interface HingeResult {
  mode: 'cdp' | 'stub' | 'none';
  /** The fold band in CSS px (start = end for a zero-width fold). */
  band: { start: number; end: number } | null;
}

/** Install the fold BEFORE navigation. Returns how it was emulated. */
export async function emulateHinge(page: Page, d: ComicDevice): Promise<HingeResult> {
  if (!d.hinge) return { mode: 'none', band: null };
  const { offset, maskLength } = d.hinge;
  const band = { start: offset, end: offset + maskLength };
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setDisplayFeaturesOverride' as never, { features: [{ orientation: 'vertical', offset, maskLength }] } as never);
    return { mode: 'cdp', band };
  } catch {
    await stubSegments(page, d, band);
    return { mode: 'stub', band };
  }
}

/** Fallback: a `window.viewport.segments` shim with two side-by-side rects. */
export async function stubSegments(page: Page, d: ComicDevice, band: { start: number; end: number }): Promise<void> {
  await page.addInitScript(
    ({ w, h, start, end }) => {
      const rect = (x: number, width: number) => (typeof DOMRectReadOnly === 'function' ? new DOMRectReadOnly(x, 0, width, h) : ({ x, y: 0, left: x, top: 0, width, height: h, right: x + width, bottom: h } as DOMRectReadOnly));
      const segments = [rect(0, start), rect(end, w - end)];
      try {
        Object.defineProperty(window, 'viewport', { configurable: true, value: { segments } });
      } catch {
        /* read-only in this engine: the spec reports "none" */
      }
      (window as unknown as { __qaHingeStub?: boolean }).__qaHingeStub = true;
    },
    { w: d.viewport.width, h: d.viewport.height, start: band.start, end: band.end }
  );
}

/** Whether the page currently sees two side-by-side segments (either way). */
export async function pageSeesSegments(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const api = (window as unknown as { viewport?: { segments?: ArrayLike<unknown> | null } }).viewport;
    if (api?.segments && api.segments.length === 2) return true;
    return typeof window.matchMedia === 'function' && window.matchMedia('(horizontal-viewport-segments: 2)').matches;
  });
}
