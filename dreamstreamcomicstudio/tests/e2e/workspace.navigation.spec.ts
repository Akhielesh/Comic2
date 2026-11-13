// One real editor fixture at three representative sizes; no full device-matrix multiplication.
import { test, expect } from './helpers/harness';

for (const viewport of [{ width: 320, height: 568 }, { width: 852, height: 393 }, { width: 1440, height: 900 }]) {
  test.describe(`Project navigation at ${viewport.width}×${viewport.height}`, () => {
    const phone = viewport.width < 1000;
    test.use({ viewport, hasTouch: phone, isMobile: phone });

    test('stages, canvas space and drafts survive navigation', async ({ page, qa }, testInfo) => {
      await qa.open({ surface: 'studio', fixture: 'heist-12p', tab: 'pages', skin: 'atlas' });
      const composer = page.locator('textarea[aria-label="Message the Comic Director"]');
      await composer.fill('Keep the rooftop scene quiet.');
      await qa.toBoard();
      const board = page.locator('[data-board]');
      const panel = page.locator('#board-panel');
      const rootFits = async () => {
        expect((await qa.pageWidths()).scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
        expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(viewport.height + 1);
      };
      await expect(board).toBeVisible();
      await expect(panel).toHaveAttribute('aria-label', 'Pages workspace');
      expect(await page.locator('[data-board-tabs]').count(), 'no second horizontal stage strip steals canvas height').toBe(0);
      const header = await page.getByRole('banner').boundingBox();
      expect(header!.height).toBeLessThanOrEqual(phone ? 45 : 49);
      await rootFits();

      const toggle = page.getByRole('button', { name: phone ? 'Open project navigation' : 'Expand project navigation' });
      const widthBefore = (await board.boundingBox())!.width;
      await toggle.click();
      const nav = page.getByRole('navigation', { name: 'Project navigation', exact: true });
      await expect(nav).toBeVisible();
      if (phone) {
        const dialog = page.getByRole('dialog', { name: 'Project navigation', exact: true });
        await expect(dialog).toBeVisible();
        const box = (await dialog.boundingBox())!;
        expect(box.x, 'navigation is a left drawer').toBe(0);
        expect(box.height).toBeGreaterThan(viewport.height - 10);
      }
      for (const tab of await nav.getByRole('tab').all()) {
        expect((await tab.boundingBox())!.height, 'every stage has a 44px touch target').toBeGreaterThanOrEqual(44);
      }
      await qa.check('studio', 'project-navigation', { checks: ['overflow', 'offscreen', ...(phone ? ['hit-target' as const] : []), 'collision', 'popover', 'landmarks', 'axe'] });
      await page.screenshot({ path: testInfo.outputPath('navigation.png') });
      const story = nav.getByRole('tab', { name: 'Story', exact: true });
      await story.focus();
      await page.keyboard.press('ArrowDown');
      await expect(nav.getByRole('tab', { name: 'Cast', exact: true })).toBeFocused();
      await expect(nav.getByRole('tab', { name: 'Pages', exact: true })).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Home');
      await expect(story).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(panel).toHaveAttribute('aria-label', 'Story workspace');
      expect(await composer.inputValue(), 'draft after Story stage').toBe('Keep the rooftop scene quiet.');
      if (phone) {
        await expect(page.getByRole('dialog', { name: 'Project navigation', exact: true })).toHaveCount(0);
        await expect(toggle).toBeFocused();
        await toggle.click();
      }
      await nav.getByRole('tab', { name: 'Assets', exact: true }).click();
      await expect(panel).toHaveAttribute('aria-label', 'Assets workspace');
      expect(await composer.inputValue(), 'draft after Assets stage').toBe('Keep the rooftop scene quiet.');
      if (phone) await toggle.click();
      await nav.getByRole('tab', { name: 'Pages', exact: true }).click();
      await expect(panel).toHaveAttribute('aria-label', 'Pages workspace');
      await panel.evaluate((el) => { el.scrollTop = 200; });
      const scrollBefore = await panel.evaluate((el) => el.scrollTop);
      expect(scrollBefore).toBeGreaterThan(0);
      if (phone) {
        await toggle.click();
        await page.keyboard.press('Escape');
        await expect(toggle).toBeFocused();
      } else {
        await page.getByRole('button', { name: 'Collapse project navigation' }).click();
        expect((await board.boundingBox())!.width).toBeCloseTo(widthBefore, 0);
        expect(await composer.inputValue(), 'draft before canvas mode').toBe('Keep the rooftop scene quiet.');
        await page.getByRole('radio', { name: 'Board only', exact: true }).click();
        expect(await composer.inputValue(), 'draft in canvas mode').toBe('Keep the rooftop scene quiet.');
        expect((await board.boundingBox())!.width).toBeGreaterThan(widthBefore + 300);
      }
      expect(await panel.evaluate((el) => el.scrollTop), 'changing chrome keeps the current canvas scroll').toBe(scrollBefore);
      await rootFits();
      await page.screenshot({ path: testInfo.outputPath('workspace.png') });
      await page.getByRole('button', { name: phone ? 'Open project navigation' : 'Expand project navigation' }).click();
      await nav.getByRole('button', { name: 'Ask the Director' }).click();
      await expect(composer).toBeVisible();
      await expect(composer).toHaveValue('Keep the rooftop scene quiet.');
      await rootFits();
      expect(qa.pageErrors).toEqual([]);
    });
  });
}
