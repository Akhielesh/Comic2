// shared.link.spec.ts (mobile.md §10.5; requirements addendum "share links — READ-ONLY + downloadable"):
// on every phone and tablet project a shared link opens straight into the reader — no auth wall, no
// studio chrome, no write control — on the requested page (`p=`), and offers a download only while
// the author's allowDownload is on.

import { test, expect } from './helpers/harness';

const pageNumber = (counter: string): number | null => {
  const m = /page\s+(\d+)/i.exec(counter) || /(\d+)/.exec(counter);
  return m ? Number(m[1]) : null;
};

/**
 * Download controls the reader offers: the HUD button, or — on compact phone HUDs — the one inside
 * Reader settings. Reveals the auto-hidden HUD and opens the settings sheet when needed.
 */
const downloadButtons = async (page: import('@playwright/test').Page): Promise<number> => {
  const btn = page.getByRole('button', { name: /^(download|preparing download…|preparing…)$/i });
  if ((await btn.count()) > 0) return btn.count();
  const settings = page.getByRole('button', { name: 'Reader settings' });
  const vp = page.viewportSize();
  if (!(await settings.count()) && vp) {
    // The HUD auto-hides on phones; a tap in the middle brings it back.
    await page.mouse.click(vp.width / 2, vp.height / 2);
    await page.waitForTimeout(450);
    if ((await btn.count()) > 0) return btn.count();
  }
  if (await settings.count()) {
    await settings.first().click();
    await page.waitForTimeout(450);
  }
  return btn.count();
};

test.describe('shared link', () => {
  test.beforeEach(({ device }) => {
    test.skip(device.kind === 'desktop', 'phones, tablets and foldables (mobile.md §10.5)');
  });

  test('opens in the reader on the requested page, read-only, with a download', async ({ qa, page }) => {
    await qa.open({ surface: 'reader', fixture: 'deep-40p', page: 5 }, { settle: 700 });
    const counter = (await page.locator('[data-testid="reader-hud-counter"]').first().textContent().catch(() => '')) || '';
    const n = pageNumber(counter.trim());
    expect(n === 5 || n === 4, `p=5 honoured (counter "${counter.trim()}")`).toBe(true);
    // The studio shell (its root carries data-layout; the immersive reader's root is excluded by its test id).
    expect(await page.locator('.gesture-root[data-layout]:not([data-testid="immersive-reader"]), section[aria-label="Conversation"], section[aria-label="Board"], [data-tabbar]').count(), 'no studio shell').toBe(0);
    await expect(page.getByRole('textbox', { name: /message the comic director/i }), 'no composer').toHaveCount(0);
    for (const write of [/^send$/i, /delete/i, /approve/i, /^edit/i, /redraw/i, /publish/i]) {
      await expect(page.getByRole('button', { name: write }), `no write control (${write})`).toHaveCount(0);
    }
    expect(await downloadButtons(page), 'a download control while allowDownload is on').toBeGreaterThan(0);
    // Read-only means no writes reached the controller either.
    const writes = (await qa.ops()).filter((o) => o.kind === 'patch' || o.kind === 'act' || o.kind === 'send' || o.kind === 'upload');
    expect(writes, 'the reader never writes').toEqual([]);
  });

  test('no download control when the author turns downloads off', async ({ qa, page }) => {
    await qa.open({ surface: 'reader', fixture: 'deep-40p', page: 2, download: '0' }, { settle: 700 });
    await expect(page.locator('[data-testid="immersive-reader"]'), 'the reader rendered').toBeVisible();
    expect(await downloadButtons(page), 'allowDownload=false hides every download control').toBe(0);
    // Prove the places a download would live were actually looked at (a blank page would also have none):
    // the HUD is showing, and on compact HUDs the Reader settings sheet is open.
    await expect(page.locator('[data-testid="reader-hud"][data-visible="true"]'), 'the reader HUD is showing').toHaveCount(1);
    await expect(page.getByRole('button', { name: /^close reader$/i }).first(), 'HUD controls are on screen').toBeVisible();
  });
});
