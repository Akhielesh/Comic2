// perf.spec.ts (mobile.md §8/§10.4; pixel-8 only, CPU throttled 4×): the Pages grid of a 40-page
// book uses the 480w variants (no thumbnail decodes a > 600 px image), the reader keeps the image
// budget (≤ 8 full-size images mounted after scrolling end to end) and loads without layout shift
// (CLS < 0.05).

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
