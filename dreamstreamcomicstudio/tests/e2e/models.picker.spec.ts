// models.picker.spec.ts (M1-PICKER-UI; models.md §5.1 acceptance, AT-10): the image-model picker and its confirms
// measured in the real browser at the smoke viewports (360×740 phone … 1440×900 desktop) and the 320 px reflow width
// (qa/ModelScenes.tsx, `surface=kit`):
//   model-picker   Easy (≤ 3 rows + Compare all), the Pro table, a free plan with a blocked row, missing live data,
//                  the QualityPanel lock line — then the real sheet and its confirm (default focus "Keep {Current}")
//   model-confirm  C (redraw chosen, dollars), C for a governed user (no "$"), a redraw we can't price (no "$"),
//                  D before the lock — then the real modal
// Each step runs in both themes with the full layout scanner + axe (serious/critical, colour contrast included) and
// checks every control is a 44 px target and nothing scrolls sideways.

import type { Page } from '@playwright/test';
import { test, expect } from './helpers/harness';
import type { QaQuery } from './helpers/harness';

const KIT = { hinge: null };
const KIT_AXE = { hinge: null, axe: true };

const scene = (kit: 'model-picker' | 'model-confirm', theme: 'light' | 'dark'): QaQuery => ({ surface: 'kit', kit: kit as unknown as QaQuery['kit'], fixture: 'heist-12p', theme });

/**
 * Measure the topmost modal on its own: everything behind it is hidden for the scan, as the scrim hides it for the
 * user (the scanner treats `role="dialog"` layers as layering but not `role="alertdialog"`; see the wave notes).
 */
const isolateModal = async (page: Page) =>
  page.addStyleTag({ content: 'body > *:not([data-model-confirm-layer]) { visibility: hidden !important; }' });
const restoreModal = async (page: Page, tag: Awaited<ReturnType<Page['addStyleTag']>>) => tag.evaluate((el) => (el as Element).remove());

/** No sideways scroll, and every visible control inside `root` is at least 44 × 44 px (or 44 px tall and wide enough). */
const measure = (page: Page, root: string) =>
  page.evaluate((sel) => {
    const els = Array.from(document.querySelectorAll<HTMLElement>(`${sel} button, ${sel} select, ${sel} summary, ${sel} label[data-scope]`));
    const small = els
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({ text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40), r: el.getBoundingClientRect() }))
      .filter((x) => x.r.height < 43.5 || x.r.width < 43.5)
      .map((x) => `${x.text} ${Math.round(x.r.width)}×${Math.round(x.r.height)}`);
    return { overflow: document.documentElement.scrollWidth - window.innerWidth, small, count: els.length };
  }, root);

for (const theme of ['light', 'dark'] as const) {
  test.describe(`model picker scenes (${theme})`, () => {
    test('model-picker: Easy, Pro, free plan, missing data, lock line; the real sheet and its confirm', async ({ qa, page }) => {
      await qa.open(scene('model-picker', theme), { settle: 600 });
      const easyRows = await page.locator('[data-testid="kit-model-easy"] li[data-model]').count();
      expect(easyRows, 'Easy shows at most 3 models').toBeLessThanOrEqual(3);
      await expect(page.locator('[data-testid="kit-model-easy"]').getByRole('button', { name: 'Compare all models' })).toBeVisible();
      await expect(page.locator('[data-testid="kit-model-pro"] li[data-model]')).toHaveCount(4);
      await expect(page.locator('[data-testid="kit-model-free"] li[data-model="nano-banana-pro"]')).toContainText('Needs a paid plan or your own key');
      // A governed user never sees dollars.
      expect(await page.locator('[data-testid="kit-model-free"]').innerText()).not.toMatch(/\$/);
      await expect(page.locator('[data-testid="kit-model-offline"]')).toContainText('from our price list, 2026-10-22');
      await expect(page.locator('[data-testid="kit-model-quality"]')).toContainText('Drawn with Nano Banana 2.1 · locked for this comic');
      const m = await measure(page, '#qa-main');
      expect(m.overflow, 'no sideways scroll').toBeLessThanOrEqual(1);
      expect(m.small, '44 px targets').toEqual([]);
      await qa.check('kit', `model-picker-${theme}`, KIT_AXE);
      await qa.scroll('#qa-main', 'bottom');
      await qa.check('kit', `model-picker-bottom-${theme}`, KIT);

      // The real sheet (suggested: Nano Banana Pro), then the confirm from a pick.
      await page.getByRole('button', { name: 'Open the picker sheet' }).click();
      const sheet = page.getByRole('dialog', { name: 'Image model' });
      await expect(sheet).toBeVisible();
      await qa.settle(400);
      await expect(sheet.locator('li[data-model="nano-banana-pro"]')).toHaveAttribute('data-suggested', 'true');
      // (The sheet's own frame — its close button — is the shared SideSheet/BottomSheet, measured by the studio specs.)
      const s = await measure(page, '[role="dialog"] [data-model-picker]');
      expect(s.overflow, 'no sideways scroll with the sheet open').toBeLessThanOrEqual(1);
      expect(s.small, '44 px targets in the sheet').toEqual([]);
      await qa.check('kit', `model-picker-sheet-${theme}`, KIT_AXE);

      await sheet.locator('li[data-model="nano-banana-pro"] [data-row-pick]').click();
      const confirm = page.getByRole('alertdialog', { name: 'Switch this comic to Nano Banana Pro?' });
      await expect(confirm).toBeVisible();
      await expect(confirm).toContainText('character consistency can be affected');
      await expect(confirm.getByRole('radio', { name: /Keep them as they are/ })).toBeChecked();
      await expect(confirm.getByRole('button', { name: 'Keep Nano Banana 2.1' })).toBeFocused();
      const c = await measure(page, '[role="alertdialog"]');
      expect(c.overflow).toBeLessThanOrEqual(1);
      expect(c.small, '44 px targets in the confirm').toEqual([]);
      const iso = await isolateModal(page);
      await qa.check('kit', `model-picker-confirm-${theme}`, KIT_AXE);
      await restoreModal(page, iso);
      // Keep: nothing is sent.
      await confirm.getByRole('button', { name: 'Keep Nano Banana 2.1' }).click();
      await expect(confirm).toBeHidden();
      expect((await qa.ops()).filter((o) => o.kind === 'act')).toEqual([]);
    });

    test('model-confirm: C (dollars and usage), an unpriced redraw, D; the real modal', async ({ qa, page }) => {
      await qa.open(scene('model-confirm', theme), { settle: 600 });
      const c = page.locator('[data-testid="kit-confirm-c"]');
      await expect(c.getByRole('radio', { name: /Redraw the pages and cover/ })).toBeChecked();
      await expect(c.locator('[data-confirm="primary"]')).toHaveText(/^Switch and redraw · ≈\$\d+\.\d\d$/);
      expect(await page.locator('[data-testid="kit-confirm-c-usage"]').innerText()).not.toMatch(/\$/);
      const unpriced = page.locator('[data-testid="kit-confirm-unpriced"]');
      for (const price of await unpriced.locator('[data-scope] [data-price]').allInnerTexts()) expect(price).not.toMatch(/\$/);
      await expect(unpriced).toContainText("We can't price this redraw yet. The first image will show the real cost.");
      await expect(page.locator('[data-testid="kit-confirm-d"]')).toContainText('character consistency can be affected');
      const m = await measure(page, '#qa-main');
      expect(m.overflow).toBeLessThanOrEqual(1);
      expect(m.small, '44 px targets').toEqual([]);
      await qa.check('kit', `model-confirm-${theme}`, KIT_AXE);
      await qa.scroll('#qa-main', 'bottom');
      await qa.check('kit', `model-confirm-bottom-${theme}`, KIT);

      await page.getByRole('button', { name: 'Open the confirm' }).click();
      const modal = page.getByRole('alertdialog', { name: 'Switch this comic to Nano Banana Pro?' }).and(page.locator('[aria-modal="true"]'));
      await expect(modal).toBeVisible();
      await expect(modal.getByRole('button', { name: 'Keep Nano Banana 2.1' })).toBeFocused();
      const box = await modal.boundingBox();
      const vw = page.viewportSize()!.width;
      expect(box && box.x >= -1 && box.x + box.width <= vw + 1, 'the modal fits the viewport').toBe(true);
      const iso = await isolateModal(page);
      await qa.check('kit', `model-confirm-modal-${theme}`, KIT_AXE);
      await restoreModal(page, iso);
      await page.keyboard.press('Escape');
      await expect(modal).toBeHidden();
    });
  });
}
