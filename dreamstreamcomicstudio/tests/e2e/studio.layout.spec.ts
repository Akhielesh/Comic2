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
  // ── FX-15: studio controls show their whole words ─────────────────────────────────────────────────────────────
  // Measured in the browser (jsdom has no layout): components/comicstudio/board/segmented.width.test.tsx pins the
  // contract, these prove the result on every device project, plus 1280 and 390 on the desktop projects.

  /** Every radio label in the named groups: scrollWidth <= clientWidth on the radio and everything inside it. */
  const cutRadioLabels = (page: import('@playwright/test').Page, groups: RegExp) =>
    page.evaluate((src) => {
      const re = new RegExp(src);
      const out: Array<{ group: string; label: string; cut: number }> = [];
      for (const g of document.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label]')) {
        const name = g.getAttribute('aria-label') || '';
        if (!re.test(name) || !g.offsetParent) continue;
        for (const r of g.querySelectorAll<HTMLElement>('[role="radio"]')) {
          for (const el of [r, ...r.querySelectorAll<HTMLElement>('*')]) {
            if (el instanceof SVGElement) continue;
            const cut = el.scrollWidth - el.clientWidth;
            if (el.clientWidth > 0 && cut > 0) out.push({ group: name, label: (r.textContent || '').trim(), cut });
          }
        }
      }
      return out;
    }, groups.source);

  test('FX-15: every segmented label (Card size, cast tier, Editor view) shows its whole word', async ({ qa, page, device }) => {
    const widths = device.isMobile ? [null] : [{ width: 1280, height: 800 }, { width: 390, height: 844 }];
    for (const size of widths) {
      if (size) await page.setViewportSize(size);
      const at = size ? `${size.width}` : device.name;
      await qa.open({ surface: 'studio', fixture: 'heist-12p', tab: 'pages' });
      await qa.toBoard();
      expect.soft(await page.locator('[role="radiogroup"][aria-label="Card size"]').count(), `Card size is on the Pages tab (${at})`).toBe(1);
      expect.soft(await cutRadioLabels(page, /^Card size$/), `Card size labels whole at ${at}`).toEqual([]);
      // The board tab count: the 11 px chrome step, never the old 10 px.
      const badgePx = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[role="tablist"][aria-label="Board"] [role="tab"] > span.tabular-nums')].map((b) => parseFloat(getComputedStyle(b).fontSize))
      );
      expect.soft(badgePx.length, `a board tab carries a count (${at})`).toBeGreaterThan(0);
      for (const px of badgePx) expect.soft(px, `board tab count font size at ${at}`).toBeGreaterThanOrEqual(11);
      // The Easy | Pro switch in the regular header (wide windows only).
      expect.soft(await cutRadioLabels(page, /^Editor view$/), `Editor view labels whole at ${at}`).toEqual([]);

      await qa.open({ surface: 'studio', fixture: 'heist-12p', tab: 'cast' });
      await qa.toBoard();
      expect.soft(await page.locator('[role="radiogroup"][aria-label$=" tier"]').count(), `cast tiers are on the Cast tab (${at})`).toBeGreaterThan(0);
      expect.soft(await cutRadioLabels(page, / tier$/), `cast tier labels whole at ${at}`).toEqual([]);
    }
    // Phones: the Easy | Pro switch lives at the top of the ⋯ menu.
    if (device.isMobile) {
      await qa.open({ surface: 'studio', fixture: 'heist-12p' });
      if (await openMoreMenu(qa)) {
        await qa.settle(400);
        expect.soft(await cutRadioLabels(page, /^Editor view$/), 'Editor view labels whole in the ⋯ menu').toEqual([]);
        await closeTopLayer(page);
      }
    }
  });

  test('FX-15: one tap on the phone approval strip shows the full label and the full price', async ({ qa, page }) => {
    await qa.open({ surface: 'studio', fixture: 'heist-12p', tab: 'pages' });
    await qa.toBoard();
    const banner = page.locator('[data-gate-banner="compact"]');
    test.skip(!(await banner.isVisible().catch(() => false)), 'the one-line strip is for narrow boards (phones, narrow panes)');
    await banner.locator('[data-gate-summary]').click();
    await qa.settle(250);
    const parts = await banner.locator('[data-gate-summary] > span:not(.sr-only)').evaluateAll((els) =>
      els.map((el) => ({ text: (el.textContent || '').trim(), cut: el.scrollWidth - el.clientWidth, right: el.getBoundingClientRect().right }))
    );
    expect(parts.length, 'label and price').toBe(2);
    for (const p of parts) {
      expect.soft(p.cut, `"${p.text}" is not cut`).toBeLessThanOrEqual(0);
      expect.soft(p.right, `"${p.text}" stays on screen`).toBeLessThanOrEqual(page.viewportSize()!.width);
    }
    await qa.check('board', 'gate-open');
  });

  test('FX-15: Enter on Approve keeps focus there; a second Enter sends nothing', async ({ qa, page }) => {
    await qa.open({ surface: 'studio', fixture: 'heist-12p', tab: 'pages' });
    await qa.toBoard();
    const approve = page.locator('[data-gate-banner] button', { hasText: /^Approve$/ }).first();
    test.skip(!(await approve.isVisible().catch(() => false)), 'no approval banner on this layout');
    await qa.clearOps();
    await approve.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    expect(await approve.evaluate((el) => document.activeElement === el), 'focus on Approve 0.3 s later (was <body>)').toBe(true);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(4700);
    expect(await approve.evaluate((el) => document.activeElement === el), 'focus on Approve 5 s later').toBe(true);
    const approvals = (await qa.ops()).filter((o) => o.kind === 'act' && (o.payload as { type?: string } | undefined)?.type === 'approve_gate');
    expect(approvals.length, 'one approval sent for two Enters').toBe(1);
  });

  test('FX-15: the conflict card label stays inside its tile at 768', async ({ qa, page, device }) => {
    test.skip(device.isMobile, 'a set viewport; once per desktop project');
    await page.setViewportSize({ width: 768, height: 1024 });
    await qa.open({ surface: 'studio', fixture: 'heist-12p', state: 'conflict' });
    await qa.toChat();
    const scroller = await markConversationScroller(page);
    if (scroller) await qa.scroll(scroller, 'bottom');
    const tiles = await page.locator('[data-conflict-versions] > div').evaluateAll((els) =>
      els.map((tile) => {
        const label = tile.querySelector(':scope > span')!;
        const t = tile.getBoundingClientRect();
        const l = label.getBoundingClientRect();
        return { label: (label.textContent || '').trim(), spill: Math.max(l.right - (t.right - 1), label.scrollWidth - label.clientWidth) };
      })
    );
    expect(tiles.length, 'the conflict card renders its version tiles').toBeGreaterThan(0);
    for (const t of tiles) expect.soft(t.spill, `"${t.label}" inside its tile`).toBeLessThanOrEqual(0);
  });

  test('FX-15: Assets search and sort are 44 px on touch', async ({ qa, page, device }) => {
    test.skip(!device.coarse, 'coarse pointers only');
    await qa.open({ surface: 'studio', fixture: 'heist-12p', tab: 'media' });
    await qa.toBoard();
    const search = page.locator('#board-panel input[type="search"]').first();
    test.skip(!(await search.isVisible().catch(() => false)), 'the Assets tab shows once the comic has an image');
    const sort = page.locator('#board-panel select').first();
    for (const [name, el] of [['search', search], ['sort', sort]] as const) {
      const h = await el.evaluate((n) => n.getBoundingClientRect().height);
      expect.soft(h, `Assets ${name} height on touch`).toBeGreaterThanOrEqual(44);
    }
  });
});
