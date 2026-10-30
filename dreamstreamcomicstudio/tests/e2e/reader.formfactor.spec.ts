// reader.formfactor.spec.ts (mobile.md §7.1/§10.4; P1-READER): the immersive reader picks the right
// default per device — phones and tablet portrait: one page; tablet landscape and desktop: a spread;
// a dual-screen foldable: one page per segment, none crossing the fold; a webtoon: vertical scroll —
// the page sits inside the viewport, `page=5` opens on page 5, a swipe turns the page (RTL turns
// the other way), the phone HUD auto-hides and comes back with a centre tap, and a hidden HUD never
// takes a tap. (mobile.md's "double-tap → zoom 2.5" is superseded by reader.md: a double-tap opens
// Guided View on that panel; pinch zooms.)

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
    const stage = document.querySelector('[data-testid="book-stage"]');
    return {
      stageW: stage ? stage.getBoundingClientRect().width : innerWidth,
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
    // mobile.md §7.1: a phone in landscape reads at fit:width (the page fills the stage width and
    // scrolls vertically); everything else fits the whole page inside the viewport.
    const fitWidth = device.kind === 'phone' && device.viewport.width > device.viewport.height;
    for (const r of s.visible) {
      expect.soft(r.left, 'page inside the viewport (left)').toBeGreaterThanOrEqual(-1);
      expect.soft(r.right, 'page inside the viewport (right)').toBeLessThanOrEqual(s.vw + 1);
      if (fitWidth) {
        expect.soft(Math.abs(r.width - s.stageW), `phone landscape: fit:width (page ${Math.round(r.width)} px, stage ${Math.round(s.stageW)} px)`).toBeLessThanOrEqual(2);
        continue;
      }
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
      // SVG data-URL art: the gesture is under test, not image loading (PNG fixtures are rendered on
      // demand by sharp, which on a busy runner can hold the next page and drop the turn).
      await qa.open({ surface: 'reader', fixture: 'deep-40p', page: 4, rtl, img: 'svg' }, { settle: 900 });
      const before = pageNumber((await readerState(page)).counter);
      // Across most of the visible page (right edge → left), so the turn commits on position even when a
      // busy machine slows the gesture below the flick speed (flipPhysics: a flick > 0.35 px/ms OR
      // progress > 0.5 commits). Measured from the page itself: landscape phones read at fit:width.
      const swipe = async () => {
        const st = await readerState(page);
        const left = Math.max(1, Math.min(...st.visible.map((r) => r.left), device.viewport.width));
        const right = Math.min(device.viewport.width - 1, Math.max(...st.visible.map((r) => r.right), 0));
        const top = Math.max(0, st.visible[0]?.top ?? 0);
        const bottom = Math.min(device.viewport.height, st.visible[0]?.bottom ?? device.viewport.height);
        const span = right - left;
        await touch.swipe({ x: right - span * 0.06, y: (top + bottom) / 2 }, -span * 0.85, 0, 10);
      };
      await swipe();
      expect(before, 'counter readable').not.toBeNull();
      if (before === null) continue;
      const now = async () => pageNumber((await readerState(page)).counter) ?? before;
      const turned = (n: number) => (rtl ? n < before : n > before);
      // The turn animates and the runner may be busy: wait for the counter. A gesture dropped under load
      // is retried ONCE (and annotated); a reader that ignores two swipes fails.
      const deadline = Date.now() + 3_000;
      while (!turned(await now()) && Date.now() < deadline) await page.waitForTimeout(150);
      if (!turned(await now())) {
        test.info().annotations.push({ type: 'swipe-retry', description: `${rtl ? 'RTL' : 'LTR'}: first swipe did not turn on ${device.name}` });
        await swipe();
      }
      if (rtl) await expect.poll(now, { timeout: 4_000, message: 'RTL: a left swipe goes back' }).toBeLessThan(before);
      else await expect.poll(now, { timeout: 4_000, message: 'LTR: a left swipe goes forward' }).toBeGreaterThan(before);
    }
  });

  test('phones: the HUD auto-hides after ~3 s and a centre tap brings it back', async ({ qa, device, page }) => {
    test.skip(device.kind !== 'phone' || !device.hasTouch, 'mobile.md §10.4: phone chrome');
    const touch = new Touch(page);
    test.skip(!(await touch.supported()), 'needs Chromium (CDP) touch');
    await qa.open({ surface: 'reader', fixture: 'heist-12p', page: 3 }, { settle: 300 });
    const hud = page.locator('[data-testid="reader-hud"]');
    await expect(hud, 'the HUD tucks itself away').toHaveAttribute('data-visible', 'false', { timeout: 6_000 });
    const vp = page.viewportSize()!;
    await touch.tap({ x: vp.width / 2, y: vp.height / 2 });
    await expect(hud, 'a centre tap shows the HUD').toHaveAttribute('data-visible', 'true', { timeout: 3_000 });
    const shownAt = Date.now();
    await expect(hud, 'and it hides again after ~3 s idle').toHaveAttribute('data-visible', 'false', { timeout: 5_000 });
    expect(Date.now() - shownAt, 'not before ~2 s (readers need time to find a control)').toBeGreaterThan(1_800);
  });

  test('a hidden HUD takes no taps', async ({ qa, device, page }) => {
    test.skip(!device.hasTouch, 'touch: an invisible control under the finger');
    await qa.open({ surface: 'reader', fixture: 'heist-12p', page: 3 }, { settle: 300 });
    const hud = page.locator('[data-testid="reader-hud"]');
    await expect(hud).toHaveAttribute('data-visible', 'false', { timeout: 6_000 });
    // Once the chrome has faded out, a tap where "Close reader" (or any HUD control) was must reach the
    // page, never an invisible button.
    const live = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="reader-hud"] button, [data-testid="reader-hud"] [role="button"], [data-testid="reader-hud"] a[href]'))
        .filter((b) => {
          const r = b.getBoundingClientRect();
          if (r.width < 2 || r.height < 2 || r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return false;
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !!hit && (hit === b || b.contains(hit));
        })
        .map((b) => b.getAttribute('aria-label') || (b.textContent || '').trim() || b.tagName)
    );
    expect(live, 'HUD controls still hit-testable while hidden').toEqual([]);
  });

  test('a webtoon scrolls vertically on every device', async ({ qa, page }) => {
    await qa.open({ surface: 'reader', fixture: 'webtoon-20p' }, { settle: 700 });
    expect((await readerState(page)).layout).toBe('scroll');
    await qa.check('reader', 'webtoon', { checks: ['overflow', 'offscreen', 'popover', 'collision'] });
  });
});
