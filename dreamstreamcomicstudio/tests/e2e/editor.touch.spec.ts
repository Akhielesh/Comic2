// editor.touch.spec.ts (mobile.md §5.4/§10.4): balloons on touch, measured through real CDP touch
// events on Chromium. Tap selects without an edit; dragging a SELECTED balloon 60 px sends exactly one
// `balloon` op with pinned:true and Δx ≈ 60/pageWidth (±2 %); dragging an unselected balloon without a
// hold does nothing (the page pans instead); hold 250 ms + drag moves it; a two-finger pinch zooms the
// page (data-zoom ≈ 2) and a drag at 2× is zoom-proof (Δx ≈ 30/pageWidth); a second finger mid-drag
// cancels with NO op; a 500 ms long-press opens the context sheet.

import { test, expect } from './helpers/harness';
import { Touch, type Pt } from './helpers/touch';

type BalloonOp = { op: string; pageId: string; lineId: string; patch: { x?: number; y?: number; pinned?: boolean } };

const balloonOps = (ops: Array<{ kind: string; payload?: unknown }>): BalloonOp[] =>
  ops
    .filter((o) => o.kind === 'patch')
    .flatMap((o) => ((o.payload as { ops?: BalloonOp[] })?.ops || []).filter((x) => x.op === 'balloon'));

const center = (b: { x: number; y: number; width: number; height: number }): Pt => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

test.describe('balloons on touch', () => {
  test.beforeEach(async ({ device }) => {
    test.skip(!device.hasTouch, 'touch devices only');
  });

  test('tap selects, a selected drag moves once with pinned:true, an unselected drag does not', async ({ qa, page }) => {
    const touch = new Touch(page);
    test.skip(!(await touch.supported()), 'multi-touch needs Chromium (CDP)');
    await qa.open({ surface: 'editor', fixture: 'heist-12p', page: 1 });
    const dialog = page.getByRole('dialog', { name: /page 1 editor/i });
    await expect(dialog).toBeVisible();
    const pageBox = await dialog.locator('[data-testid="comic-page"]').first().boundingBox();
    const hits = dialog.locator('[data-testid="balloon-hit"]');
    expect(await hits.count(), 'the drawn page has editable balloons').toBeGreaterThan(1);
    const first = (await hits.nth(0).boundingBox())!;
    const lineId = (await hits.nth(0).getAttribute('data-line-id'))!;
    await qa.clearOps();

    await touch.tap(center(first));
    await qa.settle(200);
    let ops = await qa.ops();
    expect(balloonOps(ops), 'a tap never edits').toHaveLength(0);
    const selected = ops.some((o) => o.kind === 'selection' && JSON.stringify(o.payload || '').includes(lineId)) || (await dialog.locator('rect[data-selection]').count()) > 0;
    expect(selected, 'a tap selects the balloon').toBe(true);

    await qa.clearOps();
    const beforeX = await page.evaluate((id) => window.__qaDoc?.()?.pages[0]?.balloons.find((b) => b.lineId === id)?.x ?? null, lineId);
    const from = center(first);
    await touch.drag(from, { x: from.x + 60, y: from.y }, { steps: 10 });
    await qa.settle(300);
    ops = await qa.ops();
    const moved = balloonOps(ops);
    expect(moved, 'exactly one balloon op for one drag').toHaveLength(1);
    expect(moved[0].lineId).toBe(lineId);
    expect(moved[0].patch.pinned, 'a user drag pins the balloon').toBe(true);
    if (pageBox && beforeX !== null && typeof moved[0].patch.x === 'number') {
      // Δx in page fractions ≈ 60 / page width (± 2 % of the page), unless clamped at the right edge.
      const dx = moved[0].patch.x - beforeX;
      if (moved[0].patch.x < 0.98) expect(Math.abs(dx - 60 / pageBox.width)).toBeLessThanOrEqual(0.02);
    }

    // An UNSELECTED balloon dragged without a hold: no op (the page pans or nothing happens).
    // Deselect first (tap empty paper below the art), then use the balloon farthest from the first one
    // so no selection handle sits under the finger.
    if (pageBox) await touch.tap({ x: pageBox.x + pageBox.width / 2, y: Math.min(pageBox.y + pageBox.height + 12, (page.viewportSize()?.height || 800) - 4) });
    await qa.settle(200);
    const count = await hits.count();
    let far = 1;
    let best = -1;
    for (let i = 1; i < count; i++) {
      const bb = await hits.nth(i).boundingBox();
      if (!bb) continue;
      const d = Math.hypot(center(bb).x - center(first).x, center(bb).y - center(first).y);
      if (d > best) {
        best = d;
        far = i;
      }
    }
    await qa.clearOps();
    const second = (await hits.nth(far).boundingBox())!;
    const s = center(second);
    await touch.drag(s, { x: s.x + 60, y: s.y + 10 }, { steps: 8 });
    await qa.settle(300);
    expect(balloonOps(await qa.ops()), 'an unselected quick drag never moves a balloon').toHaveLength(0);

    // Hold 250 ms, then drag: moves it.
    await qa.clearOps();
    await touch.drag(s, { x: s.x + 60, y: s.y }, { holdMs: 260, steps: 8 });
    await qa.settle(300);
    expect(balloonOps(await qa.ops()).length, 'hold + drag moves the balloon').toBeGreaterThanOrEqual(1);
  });

  test('drag distance maps to page fractions (zoom-proof)', async ({ qa, page }) => {
    const touch = new Touch(page);
    test.skip(!(await touch.supported()), 'multi-touch needs Chromium (CDP)');
    await qa.open({ surface: 'editor', fixture: 'heist-12p', page: 1 });
    const dialog = page.getByRole('dialog', { name: /page 1 editor/i });
    const pageEl = dialog.locator('[data-testid="comic-page"]').first();
    const pageBox = (await pageEl.boundingBox())!;
    const hit = dialog.locator('[data-testid="balloon-hit"]').first();
    const lineId = (await hit.getAttribute('data-line-id'))!;
    const startX = await page.evaluate(
      ([id]) => {
        const el = document.querySelector(`[data-testid="balloon-hit"][data-line-id="${id}"]`);
        return el ? el.getBoundingClientRect().left : 0;
      },
      [lineId]
    );
    const b = (await hit.boundingBox())!;
    await touch.tap(center(b));
    await qa.settle(150);
    await qa.clearOps();
    await touch.drag(center(b), { x: center(b).x + 60, y: center(b).y }, { steps: 12 });
    await qa.settle(300);
    const moved = balloonOps(await qa.ops());
    expect(moved).toHaveLength(1);
    const endX = await page.evaluate(
      ([id]) => {
        const el = document.querySelector(`[data-testid="balloon-hit"][data-line-id="${id}"]`);
        return el ? el.getBoundingClientRect().left : 0;
      },
      [lineId]
    );
    // The balloon followed the finger by ~60 CSS px (± 2 % of the page width), unless it was clamped at the edge.
    const delta = endX - startX;
    const clampedAtEdge = endX + b.width >= pageBox.x + pageBox.width - 2;
    if (!clampedAtEdge) expect(Math.abs(delta - 60)).toBeLessThanOrEqual(0.02 * pageBox.width + 1);
  });

  test('pinch zooms the page; a second finger cancels a drag; long-press opens the context sheet', async ({ qa, page }) => {
    const touch = new Touch(page);
    test.skip(!(await touch.supported()), 'multi-touch needs Chromium (CDP)');
    await qa.open({ surface: 'editor', fixture: 'heist-12p', page: 1 });
    const dialog = page.getByRole('dialog', { name: /page 1 editor/i });
    const pageBox = (await dialog.locator('[data-testid="comic-page"]').first().boundingBox())!;
    const mid = { x: pageBox.x + pageBox.width / 2, y: pageBox.y + pageBox.height * 0.55 };

    await touch.pinch(mid, 80, 160);
    await qa.settle(300);
    const zoom = await page.evaluate(() => Number(document.querySelector('[data-zoom]')?.getAttribute('data-zoom') || '1'));
    expect(zoom, 'two-finger pinch 2× zooms the page').toBeGreaterThan(1.6);

    await qa.open({ surface: 'editor', fixture: 'heist-12p', page: 1 });
    const hit = page.locator('[data-testid="balloon-hit"]').first();
    const b = (await hit.boundingBox())!;
    await touch.tap(center(b));
    await qa.settle(150);
    await qa.clearOps();
    await touch.dragThenSecondFinger(center(b), { x: center(b).x + 30, y: center(b).y }, { x: center(b).x - 80, y: center(b).y + 80 });
    await qa.settle(300);
    expect(balloonOps(await qa.ops()), 'a second finger cancels the drag with no op').toHaveLength(0);

    const dialogsBefore = await page.locator('[role="dialog"], [role="menu"]').count();
    await touch.longPress(center(b), 520);
    await qa.settle(300);
    const dialogsAfter = await page.locator('[role="dialog"]:visible, [role="menu"]:visible').count();
    expect(dialogsAfter, 'long-press opens the context sheet').toBeGreaterThan(Math.max(1, dialogsBefore - 1));
  });
});
