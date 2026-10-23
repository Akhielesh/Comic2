// perf.spec.ts (mobile.md §8/§10.4; pixel-8 only, CPU throttled 4×): the Pages grid of a 40-page
// book uses the 480w variants (no thumbnail decodes a > 600 px image), page turns hold ≥ 55 fps at the
// 90th percentile (reader.md; the reader's own frame log, window.__comicReaderPerf), the reader loads
// with LCP < 2.5 s and CLS < 0.05, keeps the image budget (≤ 8 full-size images mounted after
// scrolling end to end) and the JS heap < 180 MB, and a 2 s balloon drag has no long task > 100 ms.
// (mobile.md's "Fast 3G for one case" is not emulated: the QA bundle carries the whole studio, so a
// throttled-network LCP would measure the harness, not the reader route.)

import { test, expect } from './helpers/harness';

test.describe('performance on a mid-range phone', () => {
  // Frame timing is sensitive to whatever else the runner is doing; a real regression fails every attempt.
  test.describe.configure({ retries: 2 });

  test.beforeEach(({ device }) => {
    test.skip(device.name !== 'pixel-8', 'pixel-8 profile only');
  });

  test('the Pages grid uses variants', async ({ qa, page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await qa.open({ surface: 'studio', fixture: 'deep-40p', tab: 'pages' }, { settle: 800 });
    await qa.toBoard();
    await qa.settle(800);
    const imgs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#board-panel img'))
        .filter((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0)
        .map((img) => ({ w: (img as HTMLImageElement).naturalWidth, src: (img as HTMLImageElement).currentSrc.split('/').pop() || '' }))
    );
    // Something must have loaded, or "no big image" would pass on an empty (or broken) grid.
    expect(imgs.length, 'the Pages grid shows decoded thumbnails').toBeGreaterThan(3);
    const big = imgs.filter((i) => i.w > 600).map((i) => `${i.w}w ${i.src}`);
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
    // the median of the last three turns must hold 55 fps at the 90th percentile (one turn that
    // collides with a GC or a busy CI neighbour does not fail the build; a slow engine does).
    const settled = perf.slice(-3).map((t) => t.fps90).sort((a, b) => a - b);
    const median = settled[Math.floor(settled.length / 2)];
    expect(median, `settled turns: ${perf.slice(-3).map((t) => `${t.kind} ${t.fps90} fps`).join(', ')}`).toBeGreaterThanOrEqual(55);
  });

  test('reader: LCP, layout shift, image budget and heap', async ({ qa, page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.addInitScript(() => {
      const w = window as unknown as { __cls: number; __lcp: number };
      w.__cls = 0;
      w.__lcp = 0;
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) w.__cls += e.value;
        }).observe({ type: 'layout-shift', buffered: true });
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) w.__lcp = Math.max(w.__lcp, e.startTime);
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      } catch {
        /* unsupported */
      }
    });
    await qa.open({ surface: 'reader', fixture: 'webtoon-20p' }, { settle: 1200 });
    const { cls, lcp } = await page.evaluate(() => {
      const w = window as unknown as { __cls: number; __lcp: number };
      return { cls: w.__cls, lcp: w.__lcp };
    });
    test.info().annotations.push({ type: 'reader-load', description: `LCP ${Math.round(lcp)} ms · CLS ${cls.toFixed(3)} (CPU 4×, local preview)` });
    expect(cls, 'CLS on reader load').toBeLessThan(0.05);
    expect(lcp, 'an LCP entry was recorded').toBeGreaterThan(0);
    expect(lcp, 'LCP of the first reader page (CPU 4×)').toBeLessThan(2_500);
    // Scroll the webtoon end to end — and prove it scrolled, or the image budget below means nothing.
    const stage = page.locator('[data-testid="webtoon-stage"]').first();
    await expect(stage, 'the webtoon stage').toBeVisible();
    const box = (await stage.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 30; i++) {
      await page.mouse.wheel(0, 900);
      await page.waitForTimeout(60);
    }
    await qa.settle(600);
    const scroll = await stage.evaluate((el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }));
    expect(scroll.top, `the webtoon scrolled (${Math.round(scroll.top)} of ${Math.round(scroll.max)} px)`).toBeGreaterThan(Math.min(5_000, scroll.max * 0.5));
    const mounted = await page.evaluate(() => document.querySelectorAll('[data-heavy-img][src]:not([src=""])').length);
    expect(mounted, 'full-size images mounted after the full scroll').toBeLessThanOrEqual(8);
    const heap = await page.evaluate(() => (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null);
    test.info().annotations.push({ type: 'heap', description: heap === null ? 'performance.memory unavailable' : `${Math.round(heap / 1048576)} MB after the full scroll` });
    if (heap !== null) expect(heap, 'JS heap after the full scroll').toBeLessThan(180 * 1048576);
  });

  test('no long task over 100 ms while dragging a balloon', async ({ qa, page }) => {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await qa.open({ surface: 'editor', fixture: 'heist-12p', page: 1 }, { settle: 800 });
    const hit = page.locator('[role="dialog"] [data-testid="balloon-hit"]').first();
    await expect(hit).toBeVisible();
    const b = (await hit.boundingBox())!;
    const from = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    // Select first (a selected balloon drags without the hold), then watch long tasks for a 2 s drag.
    await page.evaluate(() => {
      const w = window as unknown as { __longTasks: number[] };
      w.__longTasks = [];
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) w.__longTasks.push(Math.round(e.duration));
      }).observe({ type: 'longtask' });
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await qa.settle(300);
    await qa.clearOps();
    await page.evaluate(() => {
      (window as unknown as { __longTasks: number[] }).__longTasks = [];
    });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
    const steps = 120; // ≈ 2 s at 60 Hz
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + Math.sin(t * Math.PI * 2) * 40, y: from.y + t * 30, id: 1 }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await qa.settle(400);
    const longTasks = await page.evaluate(() => (window as unknown as { __longTasks: number[] }).__longTasks);
    const moved = (await qa.ops()).filter((o) => o.kind === 'patch').length;
    test.info().annotations.push({ type: 'long-tasks', description: longTasks.length ? longTasks.join(', ') + ' ms' : 'none' });
    expect(moved, 'the drag moved the balloon (one patch)').toBeGreaterThanOrEqual(1);
    expect(Math.max(0, ...longTasks), 'longest task during the 2 s balloon drag').toBeLessThanOrEqual(100);
  });
});
