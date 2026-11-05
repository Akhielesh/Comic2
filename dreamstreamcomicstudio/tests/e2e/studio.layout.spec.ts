// studio.layout.spec.ts (mobile.md §10.4): the studio on every device project.
// Visits Chat, the Board (each sub-tab), settings, quality, spend and ⋯, asserting mobile.md §10.3
// assertions 1–6 plus the visualqa detector at each step, the expected layout class per device
// (single / single-rail / split / dual-screen via data-layout on the root), and that the tab bar or
// rail appears only on phones. QA_SCREENSHOTS=1 adds toHaveScreenshot baselines (CI-generated).

import { test, expect } from './helpers/harness';
import { closeTopLayer, markConversationScroller, openMoreMenu, openQuality, openSettings, openSpend } from './helpers/scenes';

const SCREENSHOTS = process.env.QA_SCREENSHOTS === '1';

test.describe('studio layout', () => {
  test('chat: layout class, navigation chrome and assertions', async ({ qa, device, page }) => {
    await qa.open({ surface: 'studio', fixture: 'heist-12p' });
    expect.soft(await qa.layout(), `data-layout on ${device.name}`).toBe(device.layout);
    const tabbar = await page.locator('[data-tabbar]').isVisible().catch(() => false);
    const rail = await page.locator('[data-rail]').isVisible().catch(() => false);
    if (device.layout === 'single') expect.soft(tabbar, 'phones portrait show the bottom tab bar').toBe(true);
    if (device.layout === 'single-rail') expect.soft(rail, 'phones landscape show the navigation rail').toBe(true);
    if (device.layout === 'split' || device.layout === 'dual-screen') expect.soft(tabbar || rail, 'no phone navigation on split layouts').toBe(false);
    await qa.check('studio', 'chat', { expectLayout: device.layout });
    const scroller = await markConversationScroller(page);
    if (scroller) {
      await qa.scroll(scroller, 'top');
      await qa.check('studio', 'chat-top');
    }
    if (SCREENSHOTS) await expect(page).toHaveScreenshot('chat.png', { fullPage: false, mask: [page.locator('[class*="shimmer"],[aria-busy="true"]')] });
  });

  for (const tab of ['story', 'cast', 'style', 'pages', 'read'] as const) {
    test(`board: ${tab}`, async ({ qa, page }) => {
      await qa.open({ surface: 'studio', fixture: 'heist-12p', tab });
      await qa.toBoard();
      await qa.check('board', tab);
      if (tab === 'pages') {
        await qa.scroll('#board-panel', 'bottom');
        await qa.check('board', 'pages-bottom');
      }
      if (SCREENSHOTS) await expect(page).toHaveScreenshot(`board-${tab}.png`, { mask: [page.locator('[class*="shimmer"],[aria-busy="true"]')] });
    });
  }

  test('header: quality, spend, more and settings', async ({ qa, page }) => {
    await qa.open({ surface: 'studio', fixture: 'heist-12p' });
    // Every one of these is reachable on every layout (phones: Quality via ⋯); a missing control is a
    // failure, not a silently skipped step.
    const quality = await openQuality(qa);
    expect.soft(quality, 'Quality is reachable (header, or ⋯ on phones)').toBe(true);
    if (quality) {
      await qa.settle(400);
      await qa.check('studio', 'quality');
      await closeTopLayer(page);
    }
    const spend = await openSpend(qa);
    expect.soft(spend, 'the spend chip is reachable').toBe(true);
    if (spend) {
      await qa.settle(400);
      await qa.check('studio', 'spend');
      await closeTopLayer(page);
    }
    const more = await openMoreMenu(qa);
    expect.soft(more, 'the ⋯ menu is reachable').toBe(true);
    if (more) {
      await qa.settle(400);
      await qa.check('studio', 'more');
      await closeTopLayer(page);
    }
    const settings = await openSettings(qa);
    expect.soft(settings, 'Settings is reachable').toBe(true);
    if (settings) {
      await qa.settle(500);
      await qa.check('studio', 'settings');
    }
  });

  test('page editor', async ({ qa }) => {
    await qa.open({ surface: 'editor', fixture: 'heist-12p', page: 1 });
    await qa.check('editor', 'open');
  });

  test('loading and failed-load states', async ({ qa }) => {
    await qa.open({ surface: 'studio', fixture: 'heist-12p', state: 'loading' });
    await qa.check('studio', 'loading', { checks: ['overflow', 'offscreen', 'collision', 'popover', 'landmarks'] });
    await qa.open({ surface: 'studio', fixture: 'heist-12p', state: 'load-error' });
    await qa.check('studio', 'load-error', { checks: ['overflow', 'offscreen', 'collision', 'popover', 'spill'] });
  });
});
