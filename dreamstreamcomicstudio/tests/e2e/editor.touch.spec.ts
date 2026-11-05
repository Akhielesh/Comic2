// editor.touch.spec.ts (mobile.md §5.4/§10.4): balloons on touch, measured through real CDP touch
// events on Chromium. Tap selects without an edit; dragging a SELECTED balloon 60 px sends exactly one
// `balloon` op with pinned:true and Δx ≈ 60/pageWidth (±2 %); dragging an unselected balloon without a
// hold does nothing (the page pans instead); hold 250 ms + drag moves it; a two-finger pinch zooms the
// page (data-zoom ≈ 2) and a drag at 2× is zoom-proof (Δx ≈ 30/pageWidth); a second finger mid-drag
// cancels with NO op; a 500 ms long-press opens the context sheet. One behaviour per test, so a known
// failure (allowlist.json knownTestFailures) never hides a regression in its neighbours.

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
    // mobile.md §10.4: the layout assertions hold at this step too — the selected balloon's tail and
    // width handles (role=slider) keep 44 px targets at zoom 1, nothing hover-only, nothing in the insets.
    await qa.check('editor', 'touch-selected', { checks: ['overflow', 'offscreen', 'popover', 'editor-aside', 'hit-target', 'hover-only', 'safe-area'] });

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
  });

  test('an unselected balloon lifts after a 250 ms hold, then drags', async ({ qa, page }) => {
    const touch = new Touch(page);
    test.skip(!(await touch.supported()), 'multi-touch needs Chromium (CDP)');
    await qa.open({ surface: 'editor', fixture: 'heist-12p', page: 1 });
    const dialog = page.getByRole('dialog', { name: /page 1 editor/i });
    const hits = dialog.locator('[data-testid="balloon-hit"]');
    const b = (await hits.nth(1).boundingBox())!;
    await qa.clearOps();
    await touch.drag(center(b), { x: center(b).x + 60, y: center(b).y }, { holdMs: 300, steps: 8 });
    await qa.settle(300);
    const ops = await qa.ops();
    expect(balloonOps(ops).length, `hold + drag moves the balloon (ops: ${ops.map((o) => o.kind).join(',') || 'none'})`).toBeGreaterThanOrEqual(1);
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
    const same = dialog.locator(`[data-testid="balloon-hit"][data-line-id="${lineId}"]`).first();
    // Measured against the page itself, so a dialog that scrolls during the gesture cannot fake a move.
    const offsetX = async () => {
      const [bb, pb] = await Promise.all([same.boundingBox(), pageEl.boundingBox()]);
      return bb && pb ? bb.x - pb.x : 0;
    };
    const startX = await offsetX();
    const b = (await hit.boundingBox())!;
    await touch.tap(center(b));
    await qa.settle(150);
    await qa.clearOps();
    await touch.drag(center(b), { x: center(b).x + 60, y: center(b).y }, { steps: 12 });
    await qa.settle(300);
    const moved = balloonOps(await qa.ops());
    expect(moved).toHaveLength(1);
    const endX = await offsetX();
    // The balloon followed the finger by ~60 CSS px (± 2 % of the page width), unless it was clamped at the edge.
    const delta = endX - startX;
    const clampedAtEdge = endX + b.width >= pageBox.width - 2;
    if (!clampedAtEdge) expect(Math.abs(delta - 60), `moved ${Math.round(delta)} px for a 60 px drag`).toBeLessThanOrEqual(0.02 * pageBox.width + 1);
  });

  test('a two-finger pinch zooms the page (TouchCanvas)', async ({ qa, page }) => {
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
  });

  test('a second finger mid-drag cancels the drag with no op', async ({ qa, page }) => {
    const touch = new Touch(page);
    test.skip(!(await touch.supported()), 'multi-touch needs Chromium (CDP)');
    await qa.open({ surface: 'editor', fixture: 'heist-12p', page: 1 });
    const hit = page.locator('[data-testid="balloon-hit"]').first();
    const b = (await hit.boundingBox())!;
    await touch.tap(center(b));
    await qa.settle(150);
    await qa.clearOps();
    await touch.dragThenSecondFinger(center(b), { x: center(b).x + 30, y: center(b).y }, { x: center(b).x - 80, y: center(b).y + 80 });
    await qa.settle(300);
    expect(balloonOps(await qa.ops()), 'a second finger cancels the drag with no op').toHaveLength(0);
  });

  test('a 500 ms long-press selects the balloon and never edits', async ({ qa, page }) => {
    const touch = new Touch(page);
    test.skip(!(await touch.supported()), 'multi-touch needs Chromium (CDP)');
    await qa.open({ surface: 'editor', fixture: 'heist-12p', page: 1 });
    const hit = page.locator('[data-testid="balloon-hit"]').first();
    await expect(hit, 'nothing is selected before the press').toHaveAttribute('aria-pressed', 'false');
    const b = (await hit.boundingBox())!;
    await qa.clearOps();
    await touch.longPress(center(b), 520);
    await qa.settle(300);
    await expect(hit, 'the long-pressed balloon is selected').toHaveAttribute('aria-pressed', 'true');
    expect(balloonOps(await qa.ops()), 'a long-press never edits').toHaveLength(0);
  });

  test('a 500 ms long-press surfaces the balloon actions (Duplicate, Delete)', async ({ qa, page }) => {
    // mobile.md §5.5: the balloon's actions behind a long-press. Today they arrive in the lettering
    // inspector layer ("Lettering"), which BalloonLayer opens by selecting on long-press/contextmenu; the
    // ContextMenuSheet list (Edit text · Style… · Duplicate · Bring to front · Lock · Reset · Delete) is
    // P2-EDITOR's. Either way a NEW layer (not the editor dialog itself) must carry the actions.
    const touch = new Touch(page);
    test.skip(!(await touch.supported()), 'multi-touch needs Chromium (CDP)');
    await qa.open({ surface: 'editor', fixture: 'heist-12p', page: 1 });
    const hit = page.locator('[data-testid="balloon-hit"]').first();
    const b = (await hit.boundingBox())!;
    const layers = page.locator('[role="menu"]:visible, [role="dialog"]:visible').filter({ hasNot: page.locator('[data-testid="balloon-hit"]') });
    const withActions = layers
      .filter({ has: page.getByRole('menuitem', { name: /duplicate/i }).or(page.getByRole('button', { name: /^duplicate/i })) })
      .filter({ has: page.getByRole('menuitem', { name: /delete/i }).or(page.getByRole('button', { name: /^delete/i })) });
    expect(await withActions.count(), 'no action layer before the press').toBe(0);
    await touch.longPress(center(b), 520);
    await qa.settle(350);
    expect(await withActions.count(), 'a layer with the balloon actions (Duplicate, Delete) opened').toBeGreaterThan(0);
    expect(balloonOps(await qa.ops()), 'a long-press never edits').toHaveLength(0);
  });

  test('after a 2× pinch a 60 px drag moves the balloon 30 px of page (zoom-proof)', async ({ qa, page }) => {
    const touch = new Touch(page);
    test.skip(!(await touch.supported()), 'multi-touch needs Chromium (CDP)');
    await qa.open({ surface: 'editor', fixture: 'heist-12p', page: 1 });
    const dialog = page.getByRole('dialog', { name: /page 1 editor/i });
    const pageBox0 = (await dialog.locator('[data-testid="comic-page"]').first().boundingBox())!;
    await touch.pinch({ x: pageBox0.x + pageBox0.width / 2, y: pageBox0.y + pageBox0.height * 0.55 }, 80, 160);
    await qa.settle(300);
    const zoom = await page.evaluate(() => Number(document.querySelector('[data-zoom]')?.getAttribute('data-zoom') || '1'));
    expect(zoom, 'the page zoomed').toBeGreaterThan(1.6);
    const hit = dialog.locator('[data-testid="balloon-hit"]').first();
    const lineId = (await hit.getAttribute('data-line-id'))!;
    const b = (await hit.boundingBox())!;
    await touch.tap(center(b));
    await qa.settle(150);
    const beforeX = await page.evaluate((id) => window.__qaDoc?.()?.pages[0]?.balloons.find((x) => x.lineId === id)?.x ?? null, lineId);
    await qa.clearOps();
    await touch.drag(center(b), { x: center(b).x + 60, y: center(b).y }, { steps: 12 });
    await qa.settle(300);
    const moved = balloonOps(await qa.ops());
    expect(moved, 'one balloon op').toHaveLength(1);
    expect(beforeX, 'the balloon has a stored position').not.toBeNull();
    // 60 screen px at 2× is 30 px of the UNZOOMED page.
    if (typeof moved[0].patch.x === 'number' && beforeX !== null) expect(Math.abs(moved[0].patch.x - beforeX - 30 / pageBox0.width)).toBeLessThanOrEqual(0.02);
  });
});
