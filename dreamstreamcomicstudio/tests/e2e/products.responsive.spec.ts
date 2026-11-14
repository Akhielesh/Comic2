// Three representative sizes, using the Models app scene's offline production component.
// Exercise every tab: the full app matrix only measures the initially selected image panel.
import type { Locator } from '@playwright/test';
import { test, expect } from './helpers/harness';

for (const viewport of [{ width: 320, height: 568 }, { width: 852, height: 393 }, { width: 1280, height: 800 }]) {
  test.describe(`Models at ${viewport.width}×${viewport.height}`, () => {
    const touch = viewport.width < 1000;
    test.use({ viewport, hasTouch: touch, isMobile: touch });

    test('tabs, filters and comparisons stay usable within the screen', async ({ page, qa }, testInfo) => {
      // Keep successful-run visual evidence in the existing CI report. These are
      // synthetic QA fixtures, not platform output or screenshot baselines.
      const attachModelShot = async (name: string, fullPage = false) => {
        if (viewport.width === 852) return;
        await testInfo.attach(`models-qa-synthetic-${name}-${viewport.width}.png`, {
          body: await page.screenshot({ fullPage, animations: 'disabled' }),
          contentType: 'image/png'
        });
      };
      await qa.open({ surface: 'model-library', skin: 'atlas' });
      await expect(page.getByRole('heading', { name: 'Models', exact: true })).toBeVisible();
      await expect(page.getByRole('article')).toHaveCount(5);
      await expect(page.locator('vite-error-overlay, [data-qa-crash]')).toHaveCount(0);
      expect(await qa.legacyClasses()).toEqual([]);
      const tabs = page.getByRole('tablist', { name: 'Model comparisons' });
      const activate = async (control: Locator) => { if (touch) await control.tap(); else await control.click(); };
      const expectFits = async () => {
        expect((await qa.pageWidths()).scrollWidth, 'document stays within the device').toBeLessThanOrEqual(viewport.width + 1);
        for (const tab of await tabs.getByRole('tab').all()) {
          const box = (await tab.boundingBox())!;
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
          expect(box.height, 'tab touch target').toBeGreaterThanOrEqual(44);
          expect(await tab.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), 'full tab label fits').toBe(true);
        }
        await expect(tabs.getByRole('tab', { selected: true })).toHaveCount(1);
      };
      const expectTouchTarget = async (control: Locator) => {
        if (!touch) return;
        await control.scrollIntoViewIfNeeded();
        expect(await control.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return [[-21, 0], [21, 0], [0, -21], [0, 21], [-15, -15], [15, 15]].every(([dx, dy]) => {
            const hit = document.elementFromPoint(r.x + r.width / 2 + dx, r.y + r.height / 2 + dy);
            return hit === el || (hit !== null && el.contains(hit));
          });
        }), 'control owns the edges of its 44px target').toBe(true);
      };
      const expectDialogFits = async (dialog: Locator) => {
        const box = (await dialog.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.y).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
        expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      };
      await expectFits();
      await attachModelShot('image-overview', true);
      await expectTouchTarget(page.getByRole('link', { name: /Artificial Analysis/ }).first());
      const nextOutput = page.getByRole('button', { name: 'Next Nano Banana 2.1 output', exact: true });
      await expectTouchTarget(nextOutput);
      await activate(nextOutput);
      await expect(page.getByRole('article', { name: 'Nano Banana 2.1', exact: true })).toContainText('2/2');
      await expect(page.getByRole('checkbox', { name: 'Compare Nano Banana 2.1', exact: true })).not.toBeChecked();

      for (const name of ['Nano Banana 2.1', 'Nano Banana Pro', 'FLUX.3']) {
        await page.getByRole('checkbox', { name: `Compare ${name}`, exact: true }).check();
      }
      await expect(page.getByRole('checkbox', { name: 'Compare GPT Image 2.6 Flare', exact: true })).toBeDisabled();
      const compareImages = page.getByRole('button', { name: 'Compare outputs', exact: true });
      await activate(compareImages);
      const imagesDialog = page.getByRole('dialog', { name: 'Compare image outputs', exact: true });
      await expectDialogFits(imagesDialog);
      await attachModelShot('image-comparison');
      // Native dialog scrolling reaches the final comparison, including in short landscape.
      await imagesDialog.getByRole('article', { name: 'FLUX.3', exact: true }).scrollIntoViewIfNeeded();
      const inspect = imagesDialog.getByRole('button', { name: 'Inspect Nano Banana 2.1 output', exact: true });
      await activate(inspect);
      const inspection = page.getByRole('dialog', { name: 'Generated in Comic Studio', exact: true });
      await expectDialogFits(inspection);
      await page.keyboard.press('Escape');
      await expect(inspection).toHaveCount(0);
      await expect(inspect).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(imagesDialog).toHaveCount(0);
      await expect(compareImages).toBeFocused();

      await activate(tabs.getByRole('tab', { name: 'Language models', exact: true }));
      const search = page.getByRole('textbox', { name: 'Search language models' });
      await search.fill('QA OpenAI model');
      await page.getByRole('combobox', { name: 'Sort language models' }).selectOption('price');
      const detailOpener = page.getByRole('button', { name: /^QA OpenAI model via OpenRouter/ });
      await expect(detailOpener).toBeVisible();
      await expectTouchTarget(detailOpener);
      await activate(detailOpener);
      const detail = page.getByRole('dialog', { name: 'QA OpenAI model', exact: true });
      await expectDialogFits(detail);
      await page.keyboard.press('Escape');
      await expect(detail).toHaveCount(0);
      await expect(detailOpener).toBeFocused();
      await search.fill('');
      for (const name of ['QA OpenAI model', 'QA Anthropic model', 'QA Google model']) {
        await page.getByRole('checkbox', { name: `Compare ${name} via OpenRouter`, exact: true }).check();
      }
      const compareLanguage = page.getByRole('button', { name: 'Compare 3 models', exact: true });
      await activate(compareLanguage);
      const languageDialog = page.getByRole('dialog', { name: 'Compare language models', exact: true });
      await expectDialogFits(languageDialog);
      if (!touch) await attachModelShot('language-comparison');
      await languageDialog.getByRole('button', { name: 'Set text default', exact: true }).last().scrollIntoViewIfNeeded();
      await page.keyboard.press('Escape');
      await expect(languageDialog).toHaveCount(0);
      await expect(compareLanguage).toBeFocused();
      await expectFits();

      await activate(tabs.getByRole('tab', { name: 'Usage', exact: true }));
      await expect(page.getByRole('heading', { name: 'Recorded model usage' })).toBeVisible();
      await activate(page.getByRole('button', { name: 'Refresh usage', exact: true }));
      await expect(page.getByRole('list', { name: 'Monthly requests' })).toBeVisible();
      await expectFits();
      // Canonical tabs retain roving keyboard navigation and automatic panel activation.
      await tabs.getByRole('tab', { name: 'Usage', exact: true }).focus();
      await page.keyboard.press('Home');
      await expect(tabs.getByRole('tab', { name: 'Image models', exact: true })).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(tabs.getByRole('tab', { name: 'Language models', exact: true })).toHaveAttribute('aria-selected', 'true');
      expect(qa.pageErrors).toEqual([]);
      expect((await qa.ops()).filter((op) => op.kind === 'net' && String((op.payload as { path?: string })?.path).startsWith('/api/models/'))).toEqual([]);
    });
  });
}
