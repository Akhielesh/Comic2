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

// fx-reader: the inline reader's turn fixes, measured in a real browser. At its narrowest the toolbar keeps the page
// arrows outside its scrolling, faded lead (Next reads as enabled on an iPhone SE), and auto-hiding chrome lays the
// first page out below the toolbar; a webtoon's next page opens at its top.
test.describe('inline reader turns', () => {
  test('the page arrows stay unmasked and the first page clears an overlaying toolbar', async ({ qa, page }) => {
    await qa.open({ surface: 'public', fixture: 'heist-12p' }, { settle: 800 });
    const m = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="public-comic-reader"] [data-testid="comic-reader"]');
      const toolbar = root?.querySelector<HTMLElement>('[data-testid="reader-toolbar"]');
      const lead = root?.querySelector<HTMLElement>('[data-testid="reader-toolbar-lead"]');
      const nav = root?.querySelector<HTMLElement>('[data-testid="reader-page-nav"]');
      const next = nav?.querySelectorAll<HTMLButtonElement>('button')[1];
      const first = root?.querySelector<HTMLElement>('[data-testid="reader-page"]');
      if (!root || !toolbar || !nav || !next || !first) return null;
      const r = next.getBoundingClientRect();
      const actions = root.querySelector<HTMLElement>('[data-testid="reader-toolbar-actions"]');
      const outside = [...(actions?.querySelectorAll<HTMLElement>('button, a[href]') ?? [])]
        .filter((el) => {
          const b = el.getBoundingClientRect();
          return b.width > 0 && (b.left < -0.5 || b.right > innerWidth + 0.5);
        })
        .map((el) => el.getAttribute('aria-label') || el.textContent || el.tagName);
      const masked = (el: Element | null): boolean => {
        for (let n = el; n && n !== root; n = n.parentElement) {
          const cs = getComputedStyle(n);
          if ((cs.maskImage && cs.maskImage !== 'none') || ((cs as unknown as { webkitMaskImage?: string }).webkitMaskImage ?? 'none') !== 'none') return true;
        }
        return false;
      };
      return {
        leadScrolls: !!lead && getComputedStyle(lead).overflowX === 'auto',
        navInLead: !!lead && lead.contains(nav),
        nextMasked: masked(next),
        nextEnabled: !next.disabled,
        nextInside: r.left >= 0 && r.right <= innerWidth + 0.5 && r.width > 0,
        rowOverflow: toolbar.scrollWidth - toolbar.clientWidth,
        outside,
        overlays: getComputedStyle(toolbar).position === 'absolute',
        toolbarH: toolbar.offsetHeight,
        firstTop: first.getBoundingClientRect().top - root.getBoundingClientRect().top
      };
    });
    expect(m, 'the public reader shows its toolbar and a page').not.toBeNull();
    if (!m) return;
    if (m.leadScrolls) expect(m.navInLead, 'one row: the arrows are pinned outside the scrolling lead').toBe(false);
    expect(m.nextMasked, 'no fade mask over Next').toBe(false);
    expect(m.nextEnabled, 'Next is enabled on the cover').toBe(true);
    expect(m.nextInside, 'Next sits inside the viewport').toBe(true);
    // The pinned arrows never push the trailing controls (More, Full screen) off the row or the screen.
    expect(m.rowOverflow, 'the toolbar row fits its box').toBeLessThanOrEqual(1);
    expect(m.outside, 'every trailing control sits inside the viewport').toEqual([]);
    if (m.overlays) expect(m.firstTop, `the first page starts below the ${m.toolbarH} px toolbar`).toBeGreaterThanOrEqual(m.toolbarH - 1);
  });

  test('a webtoon’s next page opens at its top', async ({ qa, page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' }); // the turn lands at once: the scroll position is under test
    await qa.open({ surface: 'classic-reader', fixture: 'webtoon-20p', img: 'svg' }, { settle: 800 });
    const box = page.getByTestId('reader-stage-box');
    const scrolls = await box.evaluate((el) => el.scrollHeight > el.clientHeight + 4);
    test.skip(!scrolls, 'the page fits the stage here: nothing to scroll');
    await box.evaluate((el) => {
      el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2);
    });
    expect(await box.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    const counter = page.getByTestId('reader-counter');
    const before = await counter.textContent();
    await page.getByTestId('reader-page-nav').getByRole('button').nth(1).click();
    await expect(counter).not.toHaveText(before ?? '');
    await expect.poll(() => box.evaluate((el) => el.scrollTop), { message: 'the next page opens at its top' }).toBe(0);
  });
});

