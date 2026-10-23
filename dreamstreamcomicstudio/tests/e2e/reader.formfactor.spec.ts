// reader.formfactor.spec.ts (mobile.md §7.1/§10.4; P1-READER): the immersive reader picks the right
// default per device — phones and tablet portrait: one page; tablet landscape and desktop: a spread;
// a dual-screen foldable: one page per segment, none crossing the fold; a webtoon: vertical scroll —
// the page sits inside the viewport, `page=5` opens on page 5, and a swipe turns the page (RTL turns
// the other way).

import { test, expect } from './helpers/harness';
import { Touch } from './helpers/touch';
import type { ComicDevice } from './devices';

const expectedLayout = (d: ComicDevice): 'single' | 'spread' => {
  if (d.hinge) return 'spread';
  const { width: w, height: h } = d.viewport;
  return w >= 900 && w > h && h >= 480 ? 'spread' : 'single';
};

const readerState = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const root = document.querySelector('[data-testid="immersive-reader"]');
    const visible = Array.from(document.querySelectorAll('[data-slot][data-visible="true"]')).map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    });
    return {
      layout: root?.getAttribute('data-layout') || null,
      counter: document.querySelector('[data-testid="reader-hud-counter"]')?.textContent?.trim() || '',
      visible,
      vw: innerWidth,
      vh: innerHeight
    };
  });

const pageNumber = (counter: string): number | null => {
  const m = /page\s+(\d+)/i.exec(counter) || /(\d+)/.exec(counter);
  return m ? Number(m[1]) : null;
};

test.describe('immersive reader per form factor', () => {
  test('default layout and the page fits the viewport', async ({ qa, device, page }) => {
    await qa.open({ surface: 'reader', fixture: 'heist-12p', page: 3 }, { settle: 700 });
    const s = await readerState(page);
    expect.soft(s.layout, `reader layout on ${device.name}`).toBe(expectedLayout(device));
    expect.soft(s.visible.length, 'visible pages').toBeGreaterThan(0);
    for (const r of s.visible) {
      expect.soft(r.left, 'page inside the viewport (left)').toBeGreaterThanOrEqual(-1);
      expect.soft(r.right, 'page inside the viewport (right)').toBeLessThanOrEqual(s.vw + 1);
      expect.soft(r.top, 'page inside the viewport (top)').toBeGreaterThanOrEqual(-1);
      expect.soft(r.bottom, 'page inside the viewport (bottom)').toBeLessThanOrEqual(s.vh + 1);
    }
    if (device.hinge && qa.hingeResult.band) {
      const { start, end } = qa.hingeResult.band;
      for (const r of s.visible) expect.soft(r.left < end - 1 && r.right > start + 1, 'no page crosses the fold').toBe(false);
    }
    await qa.check('reader', 'default', { checks: ['overflow', 'offscreen', 'popover', 'collision', 'hit-target', 'safe-area', 'hinge'] });
  });

  test('opens on the requested page', async ({ qa, page }) => {
    // deep-40p: every page is drawn, so page numbers and reader positions coincide.
    await qa.open({ surface: 'reader', fixture: 'deep-40p', page: 5 }, { settle: 700 });
    const s = await readerState(page);
    const n = pageNumber(s.counter);
    expect(n === 5 || n === 4, `counter "${s.counter}" shows page 5 (or its spread)`).toBe(true);
  });

  test('swipe turns the page (and RTL turns the other way)', async ({ qa, device, page }) => {
    test.skip(!device.hasTouch, 'touch swipe');
    const touch = new Touch(page);
    test.skip(!(await touch.supported()), 'needs Chromium (CDP) touch');
    for (const rtl of [false, true]) {
      await qa.open({ surface: 'reader', fixture: 'deep-40p', page: 4, rtl }, { settle: 700 });
      const before = pageNumber((await readerState(page)).counter);
      await touch.swipe({ x: device.viewport.width * 0.75, y: device.viewport.height * 0.5 }, -device.viewport.width * 0.5);
      await qa.settle(900);
      const after = pageNumber((await readerState(page)).counter);
      expect(before, 'counter readable').not.toBeNull();
      if (before !== null && after !== null) {
        if (rtl) expect.soft(after, 'RTL: a left swipe goes back').toBeLessThan(before);
        else expect.soft(after, 'LTR: a left swipe goes forward').toBeGreaterThan(before);
      }
    }
  });

  test('a webtoon scrolls vertically on every device', async ({ qa, page }) => {
    await qa.open({ surface: 'reader', fixture: 'webtoon-20p' }, { settle: 700 });
    expect((await readerState(page)).layout).toBe('scroll');
    await qa.check('reader', 'webtoon', { checks: ['overflow', 'offscreen', 'popover', 'collision'] });
  });
});
