// Layout smoke (visualqa.md §7): the per-PR regression check, 2–3 minutes on Chromium at
// 360×740, 768×1024, 1024×768 and 1440×900 (light). Runs the stress fixture through the scenes that
// broke in the v4 audit: conversation (top/bottom) with the gate, story, cast, pages, read, the page
// editor (drawn + planned), composer sheets, header sheets, settings and the public reader.
// Asserts: no page overflow / offscreen / popover / spill; no visible collisions; no clipped inputs or
// un-re-measured textareas; balloons inside the page and not colliding; the editor aside inside its
// dialog; the phone board ≥ 45 % of the height; one <main>. Known failures live in allowlist.json.

import { test, expect } from './helpers/harness';
import type { CheckId } from './helpers/allowlist';
import { markConversationScroller, openComposerOptions, openMoreMenu, openQuality, openSettings, openSpend, closeTopLayer, scrollEditorTools } from './helpers/scenes';

const SMOKE_CHECKS: CheckId[] = [
  'overflow',
  'offscreen',
  'popover',
  'spill',
  'collision',
  'input-clip',
  'textarea-clip',
  'balloon-outside',
  'balloon-collision',
  'editor-aside',
  'phone-content',
  'landmarks'
];

const opts = { checks: SMOKE_CHECKS };

test.describe('layout smoke @smoke', () => {
  test('conversation: bottom, top and the open gate', async ({ qa, page }) => {
    await qa.open({ surface: 'studio', fixture: 'stress', state: 'failed-send' });
    await qa.check('studio', 'conversation-bottom', opts);
    const scroller = await markConversationScroller(page);
    if (scroller) {
      await qa.scroll(scroller, 'top');
      await qa.check('studio', 'conversation-top', opts);
    }
    // The stress fixture always carries the open spend gate (qaFixtures: "Draw all twenty pages…").
    const gate = page.getByText(/Draw all twenty pages/i).first();
    await expect(gate, 'the stress fixture shows its open gate').toBeAttached();
    await gate.scrollIntoViewIfNeeded().catch(() => undefined);
    await qa.settle(250);
    await qa.check('studio', 'conversation-gate', opts);
  });

  test('streaming reply', async ({ qa }) => {
    await qa.open({ surface: 'studio', fixture: 'stress', state: 'streaming' });
    await qa.check('studio', 'streaming', opts);
  });

  for (const tab of ['story', 'cast', 'style', 'pages'] as const) {
    test(`board: ${tab}`, async ({ qa }) => {
      await qa.open({ surface: 'studio', fixture: 'stress', tab });
      await qa.toBoard();
      await qa.check('board', `${tab}-top`, opts);
      await qa.scroll('#board-panel', 'bottom');
      await qa.check('board', `${tab}-bottom`, opts);
    });
  }

  test('board: read', async ({ qa }) => {
    await qa.open({ surface: 'studio', fixture: 'stress', tab: 'read' });
    await qa.toBoard();
    await qa.check('board', 'read', opts);
    await qa.scroll('#board-panel', 'bottom');
    await qa.check('board', 'read-bottom', opts);
  });

  test('page editor: drawn page', async ({ qa, page }) => {
    await qa.open({ surface: 'editor', fixture: 'stress', page: 1 });
    await qa.check('editor', 'drawn-open', opts);
    await scrollEditorTools(page);
    await qa.check('editor', 'drawn-tools-bottom', opts);
  });

  // The lettering inspector with a balloon selected, Easy and Pro (visualqa P0-2: the aside left the
  // dialog at 1024 px). QA_SCREENSHOTS=1 also compares the classic-fixture lettering baseline.
  for (const mode of ['easy', 'pro'] as const) {
    test(`page editor: balloon selected (${mode} inspector)`, async ({ qa, page }) => {
      await qa.open({ surface: 'editor', fixture: 'heist-12p', page: 1, mode });
      const balloon = page.locator('[data-testid="balloon-hit"]').first();
      // heist-12p page 1 is lettered: no balloon here is a regression, never a skip.
      await expect(balloon, 'page 1 has an editable balloon').toBeVisible();
      await balloon.focus();
      await qa.settle(350);
      await expect.soft(page.locator('[data-testid="lettering-inspector"]').first(), 'selecting a balloon shows the lettering inspector').toBeVisible();
      await qa.check('editor', `selected-${mode}`, opts);
      await scrollEditorTools(page);
      await qa.check('editor', `selected-${mode}-tools-bottom`, opts);
      if (process.env.QA_SCREENSHOTS === '1' && mode === 'easy') {
        const pageEl = page.locator('[role="dialog"] [data-testid="comic-page"]').first();
        await expect(pageEl).toHaveScreenshot('lettering-heist-p1.png', { maxDiffPixelRatio: 0.01 });
      }
    });
  }

  test('page editor: planned page', async ({ qa, page }) => {
    await qa.open({ surface: 'editor', fixture: 'stress', page: 2 });
    await qa.check('editor', 'planned-open', opts);
    await scrollEditorTools(page);
    await qa.check('editor', 'planned-tools-bottom', opts);
  });

  test('composer sheets', async ({ qa }) => {
    await qa.open({ surface: 'studio', fixture: 'stress' });
    const opened = await openComposerOptions(qa);
    expect.soft(opened, 'the composer options are reachable').toBe(true);
    if (opened) {
      await qa.settle(400);
      await qa.check('studio', 'composer-options', opts);
      await closeTopLayer(qa.page);
    }
  });

  test('header sheets and settings', async ({ qa, page }) => {
    await qa.open({ surface: 'studio', fixture: 'stress', tab: 'pages' });
    // visualqa P0-4 (Quality / Spending popovers off-screen on phones): every sheet must be reached and
    // measured on every viewport — phones reach Quality through ⋯.
    const steps: Array<[string, () => Promise<boolean>, number]> = [
      ['header-quality', () => openQuality(qa), 400],
      ['header-spend', () => openSpend(qa), 400],
      ['header-more', () => openMoreMenu(qa), 400],
      ['settings', () => openSettings(qa), 600]
    ];
    for (const [scene, open, settle] of steps) {
      const opened = await open();
      expect.soft(opened, `${scene} is reachable`).toBe(true);
      if (!opened) continue;
      await qa.settle(settle);
      await qa.check('studio', scene, opts);
      if (scene !== 'settings') await closeTopLayer(page);
    }
  });

  test('public reader', async ({ qa, page }) => {
    await qa.open({ surface: 'public', fixture: 'stress' }, { settle: 800 });
    await qa.check('public', 'default', opts);
    await page.mouse.wheel(0, 20_000);
    await qa.settle(400);
    await qa.check('public', 'bottom', opts);
  });
});
