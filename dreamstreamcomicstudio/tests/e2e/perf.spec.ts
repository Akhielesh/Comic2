// perf.spec.ts (mobile.md §8/§10.4; pixel-8 only, CPU throttled 4×): the Pages grid of a 40-page
// book uses the 480w variants (no thumbnail decodes a > 600 px image), page turns hold ≥ 55 fps at the
// 90th percentile (reader.md; the reader's own frame log, window.__comicReaderPerf), the reader keeps
// the image budget (≤ 8 full-size images mounted after scrolling end to end) and loads without layout
// shift (CLS < 0.05).

import { test, expect } from './helpers/harness';

test.describe('performance on a mid-range phone', () => {
  test.beforeEach(({ device }) => {
    test.skip(device.name !== 'pixel-8', 'pixel-8 profile only');
  });

  test('the Pages grid uses variants', async ({ qa, page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await qa.open({ surface: 'studio', fixture: 'deep-40p', tab: 'pages' }, { settle: 800 });
    await qa.toBoard();
    await qa.settle(800);
    const big = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#board-panel img'))
        .filter((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 600)
        .map((img) => `${(img as HTMLImageElement).naturalWidth}w ${(img as HTMLImageElement).currentSrc.split('/').pop()}`)
    );
    expect(big, 'grid thumbnails decode ≤ 600 px images (480w variants)').toEqual([]);
  });

  test('page turns hold ≥ 55 fps p90 (window.__comicReaderPerf)', async ({ qa, page }) => {
    // Real motion (the harness default is reduced motion, which turns pages with a crossfade).
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await qa.open({ surface: 'reader', fixture: 'heist-12p', page: 2, still: false }, { settle: 900 });
    await page.locator('[data-testid="immersive-reader"]').focus();
    // Forward through paper turns and spreads, then back (board turns at the cover end).
    for (const key of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft', 'ArrowLeft']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(1_100);
    }
    type TurnPerf = { kind: string; frames: number; p90: number; fps90: number };
    const perf = await page.evaluate(() => ((window as unknown as { __comicReaderPerf?: TurnPerf[] }).__comicReaderPerf || []).slice());
    test.info().annotations.push({ type: 'turn-perf', description: perf.map((t) => `${t.kind} ${t.frames}f p90 ${t.p90}ms = ${t.fps90} fps`).join(' · ') || 'no turns recorded' });
    expect(perf.length, 'animated turns were recorded').toBeGreaterThanOrEqual(3);
    // The reader adapts (low-power turns after slow frames), so the bar applies once it has settled:
    // the last three turns must each hold 55 fps at the 90th percentile.
    for (const t of perf.slice(-3)) expect.soft(t.fps90, `${t.kind} turn: ${t.fps90} fps p90 (${t.frames} frames)`).toBeGreaterThanOrEqual(55);
  });

  test('reader: image budget and layout shift', async ({ qa, page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.addInitScript(() => {
      (window as unknown as { __cls: number }).__cls = 0;
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) (window as unknown as { __cls: number }).__cls += e.value;
        }).observe({ type: 'layout-shift', buffered: true });
      } catch {
        /* unsupported */
      }
    });
    await qa.open({ surface: 'reader', fixture: 'webtoon-20p' }, { settle: 1200 });
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
    expect(cls, 'CLS on reader load').toBeLessThan(0.05);
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(60);
    }
    await qa.settle(600);
    const mounted = await page.evaluate(() => document.querySelectorAll('[data-heavy-img][src]:not([src=""])').length);
    expect(mounted, 'full-size images mounted after the full scroll').toBeLessThanOrEqual(8);
  });
});
