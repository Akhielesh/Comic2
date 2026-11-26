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
      const dockAssets = page.getByRole('region', { name: 'Book timeline', includeHidden: true }).getByRole('button', { name: 'Open Assets: every image in this comic', includeHidden: true });
      const rootFits = async () => {
        expect((await qa.pageWidths()).scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
        expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(viewport.height + 1);
      };
      await expect(board).toBeVisible();
      await expect(panel).toHaveAttribute('aria-label', 'Pages workspace');
      await expect(dockAssets).toHaveCount(phone ? 1 : 0);
      expect(await page.locator('[data-board-tabs]').count(), 'no second horizontal stage strip steals canvas height').toBe(0);
      const header = await page.getByRole('banner').boundingBox();
      expect(header!.height).toBeLessThanOrEqual(phone ? 45 : 49);
      await rootFits();

      // A wide desktop opens the side panel by default (SH-C1): start from its slim rail, as the phone starts closed.
      if (!phone) await page.getByRole('button', { name: 'Collapse project navigation' }).click();
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
      // The board's tabs grew into the comic's parts tree (SH-C2): its areas are 44 px rows everywhere, every row on touch.
      for (const row of await nav.getByRole('treeitem').all()) {
        const level = await row.getAttribute('aria-level');
        if (phone || level === '1') expect((await row.boundingBox())!.height, 'every part has a 44px touch target').toBeGreaterThanOrEqual(44);
      }
      await qa.check('studio', 'project-navigation', { checks: ['overflow', 'offscreen', ...(phone ? ['hit-target' as const] : []), 'collision', 'popover', 'landmarks', 'axe'] });
      await page.screenshot({ path: testInfo.outputPath('navigation.png') });
      const story = nav.getByRole('treeitem', { name: 'Story', exact: true });
      await story.focus();
      await page.keyboard.press('ArrowDown');
      await expect(nav.getByRole('treeitem', { name: 'Cast', exact: true })).toBeFocused();
      await expect(nav.getByRole('treeitem', { name: 'Pages', exact: true })).toHaveAttribute('aria-selected', 'true');
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
      await nav.getByRole('treeitem', { name: 'Assets', exact: true }).click();
      await expect(panel).toHaveAttribute('aria-label', 'Assets workspace');
      expect(await composer.inputValue(), 'draft after Assets stage').toBe('Keep the rooftop scene quiet.');
      if (phone) await toggle.click();
      await nav.getByRole('treeitem', { name: 'Pages', exact: true }).click();
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
      await expect(dockAssets).toHaveCount(phone ? 1 : 0);
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

// The studio header's breadcrumb (SH-C2) on the board, with a card in focus so the trail is as long as it gets: nothing it
// shows is cut. Every crumb is a whole target of at least 44 px inside the breadcrumb, the comic's name keeps a readable
// width and ends where its words do, and the header never scrolls sideways. For a person on DreamStream's usage (the
// wallet icon) and on their own key (the wider "$0.42" chip, which leaves the name less room on a phone).
for (const viewport of [{ width: 360, height: 740 }, { width: 852, height: 393 }, { width: 1440, height: 900 }]) {
  for (const byok of [false, true]) {
    test.describe(`Breadcrumb at ${viewport.width}×${viewport.height}${byok ? ', own key' : ''}`, () => {
      const phone = viewport.width < 1000;
      test.use({ viewport, hasTouch: phone, isMobile: phone });

      test('every crumb is whole and the name stays readable', async ({ page, qa }) => {
        await qa.open({ surface: 'studio', fixture: 'heist-12p', tab: 'pages', skin: 'atlas', byok });
        await qa.toBoard();
        await page.locator('[id^="board-page-card-"]').nth(2).locator('button').first().focus();
        const nav = page.getByRole('banner').getByRole('navigation', { name: 'Breadcrumb' });
        await expect(nav).toBeVisible();
        // A phone held upright has room for the name alone; held sideways, the name, the area and the part; a desktop
        // adds My comics.
        const expected = viewport.width < 600 ? [] : phone ? ['Pages', 'Page 3'] : ['My comics', 'Pages', 'Page 3'];
        await expect(nav.getByRole('button')).toHaveText(expected);
        const navBox = (await nav.boundingBox())!;
        const inside = (box: { x: number; width: number }) => box.x >= navBox.x - 0.5 && box.x + box.width <= navBox.x + navBox.width + 0.5;
        for (const crumb of await nav.getByRole('button').all()) {
          const box = (await crumb.boundingBox())!;
          expect(inside(box), `${await crumb.textContent()} is whole inside the breadcrumb`).toBe(true);
          expect(box.width, `${await crumb.textContent()} is a 44 px target`).toBeGreaterThanOrEqual(44);
          expect(await crumb.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 || !!el.querySelector('.truncate')), 'a cut crumb ends in an ellipsis').toBe(true);
        }
        const name = nav.getByRole('textbox', { name: 'Comic title' });
        const nameBox = (await name.boundingBox())!;
        expect(inside(nameBox), 'the name is whole inside the breadcrumb').toBe(true);
        expect(nameBox.width, 'the name keeps a readable width').toBeGreaterThanOrEqual(viewport.width < 600 ? 40 : 80);
        // The name ends where its words do: no gap before the next crumb when it fits.
        const slack = await name.evaluate((el) => {
          const input = el as HTMLInputElement;
          if (input.scrollWidth > input.clientWidth) return 0;
          // The words' own width, set in the field's type (a canvas would drop the shorthand the skin's font features make).
          const cs = getComputedStyle(input);
          const probe = document.createElement('span');
          for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'fontFeatureSettings', 'fontVariationSettings'] as const) probe.style[prop] = cs[prop];
          probe.style.whiteSpace = 'pre';
          probe.style.position = 'absolute';
          probe.style.visibility = 'hidden';
          probe.textContent = input.value;
          document.body.append(probe);
          const words = probe.getBoundingClientRect().width;
          probe.remove();
          return input.getBoundingClientRect().width - words;
        });
        expect(slack, 'the name field is as wide as its words (padding and one space)').toBeLessThan(32);
        // Nothing runs under the header's controls, and nothing scrolls sideways.
        const controls = page.locator('header[data-header] > div.ml-auto').first();
        const controlsBox = await controls.boundingBox();
        if (controlsBox) expect(navBox.x + navBox.width, 'the breadcrumb ends before the header’s controls').toBeLessThanOrEqual(controlsBox.x + 0.5);
        expect((await qa.pageWidths()).scrollWidth).toBeLessThanOrEqual(viewport.width + 1);
        expect(qa.pageErrors).toEqual([]);
      });
    });
  }
}
