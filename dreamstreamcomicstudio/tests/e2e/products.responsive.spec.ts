// A bounded product regression check, separate from the full app-scene matrix.
// Mount the actual signed-out Model Library; its view selector, smart-pick actions
// and filter toolbar used to expand a 320px document to 524px.
import { test, expect } from './helpers/harness';

for (const viewport of [{ width: 320, height: 568 }, { width: 852, height: 393 }, { width: 1280, height: 800 }]) {
  test.describe(`Model Library at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport, hasTouch: viewport.width < 1000, isMobile: viewport.width < 1000 });

    test('all views stay within the screen and remain usable', async ({ page, qa }) => {
      await qa.open({ surface: 'model-library' });
      await expect(page.getByRole('heading', { name: 'Model Library', exact: true })).toBeVisible();
      await expect(page.getByText('QA Text One', { exact: true }).first()).toBeVisible();
      await expect(page.locator('vite-error-overlay, [data-qa-crash]')).toHaveCount(0);

      const views = page.getByRole('group', { name: 'Model library views' });
      const expectFits = async () => {
        expect((await qa.pageWidths()).scrollWidth, 'the document does not grow beyond the device').toBeLessThanOrEqual(viewport.width + 1);
        for (const button of await views.getByRole('button').all()) {
          const box = await button.boundingBox();
          expect(box).not.toBeNull();
          expect(box!.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
          expect(box!.height, 'view controls keep a 44px touch target').toBeGreaterThanOrEqual(44);
          expect(await button.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'view labels do not clip').toBe(true);
        }
      };
      await expectFits();

      for (const [name, content] of [
        ['Providers table', 'Provider aggregator'],
        ['Leaderboards', 'Coding leaderboard'],
        ['Benchmarks', 'No benchmark run published yet — scores will appear here after the next run.'],
        ['Library', 'Let the app pick']
      ]) {
        const button = views.getByRole('button', { name, exact: true });
        // Tap on phone/landscape, mouse on desktop; Playwright scrolls the target into view.
        if (viewport.width < 1000) await button.tap();
        else await button.click();
        await expect(button).toHaveAttribute('aria-pressed', 'true');
        await expect(views.getByRole('button', { pressed: true })).toHaveCount(1);
        await expect(page.getByText(content, { exact: true })).toBeVisible();
        await expectFits();
      }

      // Native button focus and Enter navigation work after the touch/mouse loop too.
      const providers = views.getByRole('button', { name: 'Providers table', exact: true });
      await providers.focus();
      await page.keyboard.press('Enter');
      await expect(providers).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByText('Provider aggregator', { exact: true })).toBeVisible();
      expect(qa.pageErrors).toEqual([]);
    });
  });
}
