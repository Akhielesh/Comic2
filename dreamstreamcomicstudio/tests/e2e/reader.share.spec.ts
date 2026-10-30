// reader.share.spec.ts (mobile.md §10.4): sharing from the immersive reader. `navigator.share` is
// stubbed (it records its arguments) and so is `navigator.clipboard`. The Share control keeps a 44 px
// target; it hands the comic's title and link to the system share sheet; without Web Share the link is
// copied and a "Link copied" status appears. Share lives in the HUD on wide screens and in Reader
// settings on compact (phone) HUDs. (The reader shares the whole comic; a "this page" link with `p=`
// is not offered yet.)

import { test, expect } from './helpers/harness';
import type { Locator, Page } from '@playwright/test';

type ShareCall = { title?: string; url?: string; text?: string };

/** The visible Share control: the HUD button, or the one inside Reader settings on compact HUDs. */
const shareControl = async (page: Page): Promise<Locator> => {
  const hud = page.getByRole('button', { name: /^share this comic$/i }).first();
  const reveal = async () => {
    if (await page.locator('[data-testid="reader-hud"][data-visible="true"]').count()) return;
    const vp = page.viewportSize()!;
    await page.mouse.click(vp.width / 2, vp.height / 2);
    await page.waitForTimeout(450);
  };
  await reveal();
  if (await hud.isVisible().catch(() => false)) return hud;
  const settings = page.getByRole('button', { name: 'Reader settings' }).first();
  await expect(settings, 'Reader settings is reachable').toBeVisible();
  await settings.click();
  await page.waitForTimeout(400);
  return page.getByRole('button', { name: /^share$/i }).first();
};

const targetSize = (btn: Locator) =>
  btn.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const a = getComputedStyle(el, '::after');
    return { w: Math.max(r.width, parseFloat(a.width) || 0), h: Math.max(r.height, parseFloat(a.height) || 0) };
  });

test.describe('reader share', () => {
  test('Share hands the title and the link to the system share sheet', async ({ qa, page, device }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __shares: unknown[] };
      w.__shares = [];
      Object.defineProperty(Navigator.prototype, 'share', {
        configurable: true,
        value: async (data: unknown) => {
          w.__shares.push(data);
        }
      });
    });
    await qa.open({ surface: 'reader', fixture: 'heist-12p', page: 2, share: true }, { settle: 700 });
    const btn = await shareControl(page);
    await expect(btn, 'a Share control').toBeVisible();
    if (device.coarse) {
      const size = await targetSize(btn);
      expect(Math.min(size.w, size.h), `Share target ${Math.round(size.w)}x${Math.round(size.h)} ≥ 44`).toBeGreaterThanOrEqual(44);
    }
    await btn.click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __shares: unknown[] }).__shares.length), { message: 'navigator.share was called once' }).toBe(1);
    const [call] = (await page.evaluate(() => (window as unknown as { __shares: unknown[] }).__shares)) as ShareCall[];
    expect(call.title, 'the comic title is shared').toBeTruthy();
    expect(call.url, 'the link points at the published comic').toMatch(/\/c\/qa-heist-12p$/);
    expect((await qa.ops()).filter((o) => o.kind === 'patch' || o.kind === 'act' || o.kind === 'send'), 'sharing never writes').toEqual([]);
  });

  test('without Web Share the link is copied and "Link copied" shows', async ({ qa, page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __copied: string[] };
      w.__copied = [];
      Object.defineProperty(Navigator.prototype, 'share', { configurable: true, value: undefined });
      Object.defineProperty(Navigator.prototype, 'clipboard', {
        configurable: true,
        get: () => ({
          writeText: async (text: string) => {
            w.__copied.push(text);
          }
        })
      });
    });
    await qa.open({ surface: 'reader', fixture: 'heist-12p', page: 2, share: true }, { settle: 700 });
    const btn = await shareControl(page);
    await expect(btn, 'a Share control').toBeVisible();
    await btn.click();
    await expect(page.getByRole('status').filter({ hasText: /^link copied$/i }), 'the "Link copied" status').toBeVisible();
    const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatch(/\/c\/qa-heist-12p$/);
  });

  test('no share link, no Share control', async ({ qa, page }) => {
    // A comic that is not published has nothing to share: the control is absent, not a dead button.
    await qa.open({ surface: 'reader', fixture: 'heist-12p', page: 2 }, { settle: 700 });
    await expect(page.locator('[data-testid="immersive-reader"]')).toBeVisible();
    const settings = page.getByRole('button', { name: 'Reader settings' }).first();
    if (!(await settings.isVisible().catch(() => false))) {
      const vp = page.viewportSize()!;
      await page.mouse.click(vp.width / 2, vp.height / 2);
      await page.waitForTimeout(450);
    }
    await expect(page.getByRole('button', { name: /^share this comic$/i })).toHaveCount(0);
    await settings.click();
    await page.waitForTimeout(400);
    await expect(page.getByRole('button', { name: /^share$/i })).toHaveCount(0);
  });
});
