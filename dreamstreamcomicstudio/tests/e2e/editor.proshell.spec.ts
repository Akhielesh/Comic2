// The Pro shell, measured in Chromium (PE-SHELL; master plan §2.7, §2.12): the qa/pro scenes (qa/pro/index.tsx) at the
// widths the row names. Runs on the device projects (DEVICE_SPECS matches editor.*.spec.ts); each test picks its own
// viewport and skips projects whose pointer it does not measure.
//
//   - 320 (reflow) and 360: no horizontal overflow, nothing in the editor off screen, the header fits;
//   - 320: the phone toolbar's "Mark up" and "Lettering" are not truncated (DC-0 #10);
//   - coarse pointers: every control in the header, the rail and the thumb bar is ≥ 44 × 44;
//   - 1280 × 800: the docked inspector does not overlap the page (with and without stand-in parts), and at 1440 the
//     left rail does not either.
//
// PE-QA (S3) folds these into tests/e2e/editor.pro.spec.ts and the perf scenario.

import { test, expect } from './helpers/harness';

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

const PHONE_SCENES = ['shell-easy', 'shell-pro', 'shell-pro-selected', 'shell-pro-parts', 'shell-flag-off'] as const;

const overflowOf = async (page: import('@playwright/test').Page, width: number) =>
  page.evaluate((vw) => {
    const doc = document.documentElement;
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
    const off: string[] = [];
    for (const el of Array.from((dialog ?? document.body).querySelectorAll<HTMLElement>('button, [role="radio"], [role="tab"], h2, [data-testid="pro-tool-rail"], [data-testid="editor-toolbar"]'))) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') continue;
      // Inside a horizontally scrolling strip (the rail's tool row) an item may sit past the edge on purpose.
      if (el.closest('[data-testid="pro-tool-rail"]') && el.getAttribute('data-slot') === 'tool-button') continue;
      if (r.right > vw + 0.5 || r.left < -0.5) off.push(`${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 30)}" ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    return { scrollWidth: doc.scrollWidth, off };
  }, width);

test.describe('Pro shell @proshell', () => {
  for (const width of [320, 360]) {
    test(`no overflow at ${width} px (every qa/pro scene)`, async ({ qa, page, device }) => {
      test.skip(!device.coarse || device.viewport.width > 480, 'phone projects measure the phone widths');
      await page.setViewportSize({ width, height: width === 320 ? 640 : 740 });
      for (const scene of PHONE_SCENES) {
        await qa.open({ surface: 'pro', scene });
        await page.waitForSelector('[data-testid="editor-header"]');
        const { scrollWidth, off } = await overflowOf(page, width);
        expect.soft(scrollWidth, `${scene} @${width}: page scroll width`).toBeLessThanOrEqual(width);
        expect.soft(off, `${scene} @${width}: controls off screen`).toEqual([]);
      }
    });
  }

  test('"Mark up" and "Lettering" are not truncated at 320 px (DC-0 #10)', async ({ qa, page, device }) => {
    test.skip(!device.coarse || device.viewport.width > 480, 'phone projects measure the phone toolbar');
    await page.setViewportSize({ width: 320, height: 640 });
    for (const scene of ['shell-flag-off', 'shell-easy', 'shell-pro'] as const) {
      await qa.open({ surface: 'pro', scene });
      const labels = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('[data-testid="editor-toolbar"] button > span:not([aria-hidden="true"])'))
          .filter((s) => s.textContent && s.getBoundingClientRect().width > 0)
          .map((s) => ({ text: s.textContent!.trim(), truncated: s.scrollWidth > s.clientWidth + 0.5 }))
      );
      for (const want of ['Mark up', 'Lettering']) {
        const hit = labels.find((l) => l.text === want);
        expect.soft(hit, `${scene}: "${want}" is shown`).toBeTruthy();
        expect.soft(hit?.truncated, `${scene}: "${want}" is not truncated`).toBe(false);
      }
      expect.soft(labels.filter((l) => l.truncated).map((l) => l.text), `${scene}: no truncated toolbar label`).toEqual([]);
    }
  });

  test('44 px targets under a coarse pointer (header, rail, thumb bar)', async ({ qa, page, device }) => {
    test.skip(!device.coarse, 'coarse projects only');
    for (const scene of ['shell-pro', 'shell-pro-selected', 'shell-pro-parts'] as const) {
      await qa.open({ surface: 'pro', scene });
      const small = await page.evaluate(() =>
        Array.from(document.querySelectorAll<HTMLElement>('[data-testid="editor-header"] button, [data-testid="pro-tool-rail"] button, [data-testid="editor-toolbar"] button, [data-testid="pro-coach"] button'))
          .map((b) => ({ b, r: b.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && r.height > 0)
          .filter(({ r }) => r.width < 43.5 || r.height < 43.5)
          .map(({ b, r }) => `${(b.getAttribute('aria-label') || b.textContent || '').trim().slice(0, 30)} ${Math.round(r.width)}x${Math.round(r.height)}`)
      );
      expect.soft(small, `${scene}: targets under 44 px`).toEqual([]);
    }
  });

  for (const [w, h] of [
    [1280, 800],
    [1024, 768],
    [1440, 900]
  ] as const) {
    test(`the docked inspector never overlaps the page at ${w} × ${h}`, async ({ qa, page, device }) => {
      test.skip(device.coarse, 'a fine pointer measures the docked desktop layout');
      await page.setViewportSize({ width: w, height: h });
      for (const scene of ['shell-pro', 'shell-pro-parts', 'shell-pro-selected'] as const) {
        await qa.open({ surface: 'pro', scene });
        await page.waitForSelector('[data-testid="pro-dock"]');
        const m = await page.evaluate(() => {
          const rect = (sel: string): Rect | null => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
          };
          const floating = document.querySelector('[data-testid="lettering-inspector"][data-presentation="floating"]');
          return {
            page: rect('[data-pro-canvas] [data-testid="comic-page"]'),
            dock: rect('[data-testid="pro-dock"]'),
            left: rect('[data-testid="pro-left-rail"]'),
            rail: rect('[data-testid="pro-tool-rail"]'),
            floating: floating ? (floating.getBoundingClientRect().toJSON() as Rect) : null,
            scrollWidth: document.documentElement.scrollWidth
          };
        });
        expect(m.page, `${scene}: the page is drawn`).toBeTruthy();
        expect(m.dock, `${scene}: the dock is there`).toBeTruthy();
        expect.soft(m.page!.right, `${scene} @${w}: page right ≤ dock left`).toBeLessThanOrEqual(m.dock!.left + 0.5);
        expect.soft(m.dock!.width, `${scene} @${w}: dock width`).toBe(w >= 1200 ? 400 : 360);
        if (m.rail) expect.soft(m.page!.left, `${scene} @${w}: page clears the rail`).toBeGreaterThanOrEqual(m.rail.right - 0.5);
        if (m.left) expect.soft(m.page!.left, `${scene} @${w}: page clears the left rail`).toBeGreaterThanOrEqual(m.left.right - 0.5);
        // The fallback lettering panel (no inspector part) stays inside the dock column.
        if (m.floating) expect.soft(m.floating.left, `${scene} @${w}: the lettering panel stays in the dock`).toBeGreaterThanOrEqual(m.dock!.left - 0.5);
        expect.soft(m.scrollWidth, `${scene} @${w}: no page overflow`).toBeLessThanOrEqual(w);
      }
    });
  }
});
