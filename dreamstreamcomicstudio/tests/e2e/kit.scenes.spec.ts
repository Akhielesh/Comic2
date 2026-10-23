// kit.scenes.spec.ts (P1-QA): feature components measured on their own, at every smoke viewport,
// the 320 px reflow width and the device projects (qa/KitScenes.tsx, `surface=kit`).
//   breakdown    BreakdownCard — Easy plan, Pro status (busy page + low-QC flag + failed page + stale
//                cover), Pro cost, the compact gate subset                         (P1-BOOKMODEL)
//   refs         RefStrip in a cast card, RefsCard                                 (P1-REFS)
//   refs-drawer  RefsDrawer with real PNGs through the picker: uploading, rejected, near duplicate and
//                over-the-cap rows at once                                          (P1-REFS)
//   timeline     BookTimeline expanded + compact, VersionsCard                     (P1-TIMELINE)
//   art          every style preset thumbnail and empty state, light AND dark      (P1-LIBRARY)
// Each step runs the full layout scanner (+ touch checks on coarse devices, + axe on each scene's first
// view); known failures are allowlisted per owner in allowlist.json. The kit page is a plain scrolling column, not a
// fold-aware layout, so the hinge check is off here (the studio specs cover dual-screen layouts).

import { test, expect } from './helpers/harness';
import { renderQaImage } from './fixtures/genImages';

const frames = (page: import('@playwright/test').Page, ids: string[]) =>
  page.evaluate((list) => list.map((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    const body = el?.querySelector(':scope > :not(h2)');
    const r = body?.getBoundingClientRect();
    return { id, present: !!el, height: r ? Math.round(r.height) : 0 };
  }), ids);

const KIT = { hinge: null };
// axe-core (serious/critical, colour contrast included) on the first view of every scene: these are the
// NEW components the studio specs only reach after a few clicks.
const KIT_AXE = { hinge: null, axe: true };

test.describe('component scenes', () => {
  test('breakdown card: plan, status, cost and the gate subset', async ({ qa, page }) => {
    await qa.open({ surface: 'kit', kit: 'breakdown', fixture: 'heist-12p' }, { settle: 600 });
    const got = await frames(page, ['kit-breakdown-plan', 'kit-breakdown-status', 'kit-breakdown-cost', 'kit-breakdown-gate']);
    for (const f of got) expect.soft(f.height, `${f.id} renders a card`).toBeGreaterThan(40);
    await qa.check('kit', 'breakdown', KIT_AXE);
    await qa.scroll('#qa-main', 'bottom');
    await qa.check('kit', 'breakdown-bottom', KIT);
  });

  test('refs: the strip in a cast card and the chat card', async ({ qa, page }) => {
    await qa.open({ surface: 'kit', kit: 'refs', fixture: 'heist-12p' }, { settle: 600 });
    const got = await frames(page, ['kit-refstrip', 'kit-refscard']);
    for (const f of got) expect.soft(f.height, `${f.id} renders`).toBeGreaterThan(30);
    await qa.check('kit', 'refs', KIT_AXE);
  });

  test('refs drawer: grid, then uploading / rejected / near-duplicate / over-cap rows together', async ({ qa, page }) => {
    await qa.open({ surface: 'kit', kit: 'refs-drawer', fixture: 'heist-12p' }, { settle: 700 });
    const drawer = page.getByRole('dialog').first();
    await expect(drawer, 'the drawer opens').toBeVisible();
    await qa.check('kit', 'refs-drawer', KIT_AXE);
    // Five real PNGs (distinct bytes): three fit under Maya's cap (9 of 12), two are over it.
    const names = ['bad-beach.png', 'dup-maya-side.png', 'slow-maya-front.png', 'extra-4.png', 'extra-5.png'];
    const files = await Promise.all(names.map(async (name, i) => ({ name, mimeType: 'image/png', buffer: await renderQaImage(`upload-${i}`, 900, 700) })));
    await page.locator('[data-testid="refs-picker"]').setInputFiles(files);
    const rows = page.locator('ul[aria-label="Uploads"] li[data-state]');
    await expect.poll(async () => (await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-state')))).sort().join(','), { timeout: 15_000, message: 'queue rows reach their states' }).toMatch(/near_duplicate|done/);
    await qa.settle(500);
    const states = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-state')));
    test.info().annotations.push({ type: 'queue', description: states.join(', ') });
    expect.soft(states, 'a rejected row').toContain('rejected');
    expect.soft(states.filter((s) => s === 'over_cap').length, 'two rows over the cap').toBe(2);
    expect.soft(states.some((s) => s === 'uploading' || s === 'checking'), 'a row still uploading').toBe(true);
    await qa.check('kit', 'refs-drawer-queue', KIT_AXE);
    // No rejected image is ever drawn as an <img>.
    const rejectedImgs = await page.locator('li[data-state="rejected"] img').count();
    expect(rejectedImgs, 'a rejected upload never becomes an <img>').toBe(0);
  });

  test('book timeline: dock, compact strip and the versions card', async ({ qa, page }) => {
    await qa.open({ surface: 'kit', kit: 'timeline', fixture: 'heist-12p' }, { settle: 600 });
    const got = await frames(page, ['kit-timeline', 'kit-timeline-compact', 'kit-versions']);
    for (const f of got) expect.soft(f.present, `${f.id} is mounted`).toBe(true);
    await qa.check('kit', 'timeline', KIT_AXE);
    await qa.scroll('#qa-main', 'bottom');
    await qa.check('kit', 'timeline-bottom', KIT);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`procedural art (${theme})`, async ({ qa, page }) => {
      await qa.open({ surface: 'kit', kit: 'art', fixture: 'heist-12p', theme }, { settle: 600 });
      const thumbs = await page.locator('[data-preset]').evaluateAll((els) =>
        els.map((li) => {
          const svg = li.querySelector('svg');
          const r = svg?.getBoundingClientRect();
          return { id: li.getAttribute('data-preset'), w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0 };
        })
      );
      expect(thumbs.length, 'every style preset has a thumbnail').toBeGreaterThan(5);
      for (const t of thumbs) expect.soft(t.w > 40 && t.h > 40, `preset ${t.id} draws (${t.w}x${t.h})`).toBe(true);
      const empties = await page.locator('[data-empty] svg').count();
      expect.soft(empties, 'every empty state draws').toBeGreaterThanOrEqual(6);
      await qa.check('kit', `art-${theme}`, KIT_AXE);
      await qa.scroll('#qa-main', 'bottom');
      await qa.check('kit', `art-${theme}-bottom`, KIT);
    });
  }
});
