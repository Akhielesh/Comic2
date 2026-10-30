// public.reader.spec.ts (mobile.md §10.4–§10.5; addendum "share links — read-only + downloadable"):
// the public reader (mocked payload, no auth, no backend) on every device: assertions 1–4 (overflow,
// 44 px targets, no hover-only controls, safe areas — the header respects --sa-top), and the
// not-found / error states fit even on the 344 px Fold cover screen. Shared-link acceptance: it opens
// straight into the reader with no studio chrome and no write control.

import { test, expect } from './helpers/harness';

test.describe('public reader', () => {
  test('opens straight into the reader: no auth wall, no studio chrome, assertions 1–4', async ({ qa, page }) => {
    await qa.open({ surface: 'public', fixture: 'heist-12p' }, { settle: 800 });
    // The comic itself rendered (not the boot card, an error or an empty shell).
    await expect(page.locator('[data-testid="public-comic-reader"] [data-testid="comic-reader"][role="region"]'), 'the public reader shows the comic (not its empty state)').toBeVisible();
    await expect(page.getByRole('alert'), 'no error state').toHaveCount(0);
    // The studio shell (its root carries data-layout; the immersive reader's root is excluded by its test id).
    expect(await page.locator('.gesture-root[data-layout]:not([data-testid="immersive-reader"]), section[aria-label="Conversation"], section[aria-label="Board"], [data-tabbar]').count(), 'no studio shell').toBe(0);
    await expect(page.getByRole('textbox', { name: /message the comic director/i }), 'no composer for readers').toHaveCount(0);
    for (const write of [/^send$/i, /delete/i, /approve/i, /^edit/i]) {
      await expect(page.getByRole('button', { name: write }), `no write control (${write})`).toHaveCount(0);
    }
    await qa.check('public', 'default');
    // Nothing reached the network: the fixture payload came from the in-page shim.
    const net = (await qa.ops()).filter((o) => o.kind === 'net');
    expect(net.length, 'the comic came through the public read endpoint').toBeGreaterThan(0);
    expect(net.every((o) => /\/api\/comic\/public\//.test(JSON.stringify(o.payload))), `only the public read endpoint was called: ${JSON.stringify(net)}`).toBe(true);
  });

  test('header respects the top safe area', async ({ qa, device, page }) => {
    test.skip(!device.safeArea.top, 'no top inset on this device');
    await qa.open({ surface: 'public', fixture: 'heist-12p' }, { settle: 800 });
    const top = await page.evaluate(() => {
      const header = document.querySelector('header, [role="banner"]');
      if (!header) return null;
      const controls = Array.from(header.querySelectorAll('button, a[href], h1, h2'));
      return controls.length ? Math.min(...controls.map((c) => c.getBoundingClientRect().top)) : header.getBoundingClientRect().top;
    });
    expect(top, 'a header exists').not.toBeNull();
    expect(top!, `header content clears the ${device.safeArea.top}px inset`).toBeGreaterThanOrEqual(device.safeArea.top - 1);
  });

  for (const state of ['not-found', 'error'] as const) {
    test(`${state} state fits`, async ({ qa, page, device }) => {
      await qa.open({ surface: 'public', fixture: 'heist-12p', public: state }, { settle: 800 });
      await expect(page.getByRole('alert').or(page.getByText(/private|no longer|could not|couldn’t|not found|try again/i)).first()).toBeVisible();
      await qa.check('public', state, { checks: ['overflow', 'offscreen', 'spill', 'collision', ...(device.coarse ? (['hit-target', 'safe-area'] as const) : [])] });
    });
  }
});
