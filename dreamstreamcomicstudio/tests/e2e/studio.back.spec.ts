// studio.back.spec.ts (mobile.md §3.10/§10.4): the system Back gesture closes the TOP layer first —
// a sheet, then the page editor — and never leaves the studio.

import { test, expect } from './helpers/harness';
import { openSettings } from './helpers/scenes';

const stillInStudio = async (page: import('@playwright/test').Page) =>
  page.evaluate(() => !!document.querySelector('.gesture-root') && !!window.__qa && location.pathname.endsWith('/qa/comic-qa.html'));

test.describe('Back closes the top layer', () => {
  test('page editor closes on Back, the studio stays', async ({ qa, page }) => {
    await qa.open({ surface: 'studio', fixture: 'heist-12p', tab: 'pages' });
    await qa.toBoard();
    const open = page.getByRole('button', { name: /^(edit|open) page 1$/i }).first();
    // Every layout shows the Pages grid here: a missing page card is a regression, never a skip. The
    // card's own control is "Edit page 1" ("Open page 1" while undrawn) — wave 2 removed the wrapping
    // "Open page n in the editor" button (nested-interactive), and PagesTab.test keeps it gone.
    await expect(open, 'page 1 has an "Edit / Open page 1" control').toBeVisible();
    await open.click({ timeout: 10_000 });
    const editor = page.getByRole('dialog', { name: /page 1 editor/i });
    await expect(editor).toBeVisible();
    await page.goBack();
    await expect(editor).toBeHidden({ timeout: 5_000 });
    expect(await stillInStudio(page)).toBe(true);
  });

  test('settings sheet closes on Back, then the editor', async ({ qa, page }) => {
    await qa.open({ surface: 'studio', fixture: 'heist-12p', tab: 'pages' });
    expect(await openSettings(qa), 'Settings is reachable on every layout').toBe(true);
    const sheet = page.getByRole('dialog', { name: /comic settings/i });
    await expect(sheet).toBeVisible();
    await page.goBack();
    await expect(sheet).toBeHidden({ timeout: 5_000 });
    expect(await stillInStudio(page)).toBe(true);
    // Second layer: the editor, opened after the sheet closed, is the new top layer.
    await qa.toBoard();
    const open = page.getByRole('button', { name: /^(edit|open) page 1$/i }).first();
    await expect(open, 'page 1 has an "Edit / Open page 1" control').toBeVisible();
    await open.click({ timeout: 10_000 });
    const editor = page.getByRole('dialog', { name: /page 1 editor/i });
    await expect(editor).toBeVisible();
    await page.goBack();
    await expect(editor).toBeHidden({ timeout: 5_000 });
    expect(await stillInStudio(page)).toBe(true);
  });
});
