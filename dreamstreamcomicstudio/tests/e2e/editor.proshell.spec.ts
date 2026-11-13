// The Pro shell, measured in Chromium (PE-SHELL; master plan §2.7, §2.12): the qa/pro scenes (qa/pro/index.tsx) at the
// widths the row names. Runs on the device projects (DEVICE_SPECS matches editor.*.spec.ts); each test picks its own
// viewport and skips projects whose pointer it does not measure.
//
//   - 320 (reflow) and 360: no horizontal overflow, nothing in the editor off screen, the header fits, and the header's
//     "Page n" is never truncated (scrollWidth ≤ clientWidth: an off-screen check alone passes a cut-off title);
//   - 360 × 740 and 740 × 360: the phone Layers sheet sits above the thumb bar and the page re-fits above it (portrait),
//     or is a 320 px side sheet beside the page (landscape) — the page stays fully visible;
//   - 768 × 1024 (tablet, coarse): the tool row's Layers / Assets toggles open the left drawer with the free footer, and a
//     selection opens the inspector part in a sheet ≤ 40 % tall that the page clears;
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
        const title = await page.evaluate(() => {
          const h2 = document.querySelector<HTMLElement>('[data-testid="editor-header"] h2');
          return h2 ? { text: (h2.textContent || '').trim(), scroll: h2.scrollWidth, client: h2.clientWidth } : null;
        });
        expect(title, `${scene} @${width}: the header title is drawn`).toBeTruthy();
        expect.soft(title!.scroll, `${scene} @${width}: "${title!.text}" is not truncated`).toBeLessThanOrEqual(title!.client);
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

  test('phones: the Layers sheet never covers the thumb bar, and the page stays fully visible', async ({ qa, page, device }) => {
    test.skip(!device.coarse || device.viewport.width > 480, 'phone projects measure the phone sheet');
    for (const [w, h] of [
      [360, 740],
      [740, 360]
    ] as const) {
      await page.setViewportSize({ width: w, height: h });
      await qa.open({ surface: 'pro', scene: 'shell-pro-parts' });
      await page.click('[data-testid="toolbar-layers"]');
      await page.waitForSelector('[data-testid="pro-layers-sheet"]');
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => {
        const r = (sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height };
        };
        return { sheet: r('[data-testid="pro-layers-sheet"]'), page: r('[data-testid="editor-stage"] [data-testid="comic-page"]'), toolbar: r('[data-testid="editor-toolbar"]'), variant: document.querySelector('[data-testid="pro-layers-sheet"]')?.getAttribute('data-variant') };
      });
      expect(m.sheet && m.page && m.toolbar, `${w}×${h}: sheet, page and thumb bar are drawn`).toBeTruthy();
      const visible = (a: NonNullable<typeof m.page>, b: NonNullable<typeof m.sheet>) => {
        const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        return 1 - (ix * iy) / (a.width * a.height);
      };
      expect.soft(visible(m.page!, m.sheet!), `${w}×${h}: share of the page not under the Layers sheet`).toBeGreaterThanOrEqual(0.99);
      if (w < h) {
        expect.soft(m.variant, `${w}×${h}: a bottom sheet`).toBe('bottom');
        expect.soft(m.sheet!.bottom, `${w}×${h}: the sheet ends above the thumb bar`).toBeLessThanOrEqual(m.toolbar!.top + 0.5);
      } else {
        expect.soft(m.variant, `${w}×${h}: a side sheet`).toBe('side');
        expect.soft(Math.round(m.sheet!.width), `${w}×${h}: the side sheet is 320 px`).toBe(320);
      }
    }
  });

  test('768 tablet: Layers in the left drawer, the inspector in a sheet ≤ 40 % that the page clears', async ({ qa, page, device }) => {
    test.skip(!device.coarse || device.viewport.width > 480, 'a coarse project measures the tablet');
    await page.setViewportSize({ width: 768, height: 1024 });
    await qa.open({ surface: 'pro', scene: 'shell-pro-parts' });
    await page.waitForSelector('[data-testid="pro-tool-rail"][data-orientation="horizontal"]');
    await page.click('[data-testid="pro-drawer-layers"]');
    const drawer = await page.waitForSelector('[data-testid="pro-drawer"][data-drawer="layers"]');
    expect(await drawer.$('[data-qa-stub-part="Layers"]'), 'the Layers part is in the drawer').toBeTruthy();
    expect(await drawer.$('[data-testid="pro-free-footer"]'), 'the drawer reads the free footer').toBeTruthy();
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="pro-drawer"]', { state: 'detached' });
    // Select the first balloon (the Show me path): the inspector part opens in its sheet.
    await page.locator('[data-testid="balloon-hit"]').first().click();
    const sheet = await page.waitForSelector('[data-testid="pro-inspector-sheet"]');
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const b = (sel: string) => document.querySelector(sel)?.getBoundingClientRect() ?? null;
      const s = b('[data-testid="pro-inspector-sheet"]');
      const p = b('[data-testid="editor-stage"] [data-testid="comic-page"]');
      return { sheetTop: s?.top ?? 0, sheetH: s?.height ?? 0, pageBottom: p?.bottom ?? 0, vh: innerHeight, scrollWidth: document.documentElement.scrollWidth };
    });
    expect(await sheet.$('[data-qa-stub-part="Properties"]'), 'the inspector part is in the sheet').toBeTruthy();
    expect.soft(m.sheetH, 'the inspector sheet is at most 40 % of the screen').toBeLessThanOrEqual(m.vh * 0.4 + 0.5);
    expect.soft(m.pageBottom, 'the page clears the inspector sheet').toBeLessThanOrEqual(m.sheetTop + 0.5);
    expect.soft(m.scrollWidth, 'no page overflow at 768').toBeLessThanOrEqual(768);
  });
});
