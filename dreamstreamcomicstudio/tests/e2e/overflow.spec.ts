// The overflow probe (OV-1; docs/design/clean-and-smooth.md "The overflow ratchet"): nothing spills
// or gets cut, measured on every scene with the long strings injected.
//
//   npx playwright test -c tests/e2e/playwright.config.ts --project=overflow                  self-test + every scene
//   npx playwright test -c tests/e2e/playwright.config.ts --project=overflow --grep @selftest  the probe self-test only
//   UPDATE_BASELINES=1     … --project=overflow   lower tests/e2e/baselines/overflow.json where a scene improved
//   UPDATE_BASELINES=reset … --project=overflow   rewrite the measured entries (first generation, or a reviewed exception)
//
// 1. Self-test (@selftest): synthetic pages, each kind of escape reported exactly and nothing on a clean page; the
//    ratchet's pure rules.
// 2. Scenes (@overflow): the declutter scenes (DECLUTTER_SCENES), every qa/app/scenes page (overflow-stress with
//    stress=1) and the studio and public error states, at 320×640 light, 360×740 dark and 1280×800 light, with the
//    page-level Atlas skin. Per scene: C6 (truncatedLabels, from the clutter probe, before anything is injected) must
//    not rise above the declutter baseline for the same scene (so a label span never cuts a label that fits today);
//    then the popover triggers are opened one by one; then the long strings are injected and the text measured.
//    Judged against tests/e2e/baselines/overflow.json; an unlisted scene is held to 0.
//
// Runs in layout-smoke.yml on every PR that touches the UI (scripts/layout-smoke.mjs default projects).

import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { deviceByName } from './devices';
import { QaHarness, type QaQuery } from './helpers/harness';
import { CLUTTER_TARGETS, DECLUTTER_SCENES, measureClutter, readClutterBaseline, sceneKey, clutterMode, withFileLock, writeAtomic } from './helpers/clutterProbe';
import {
  APP_SCENE_QUERY,
  judgeOverflow,
  measureOverflow,
  measurePopovers,
  OVERFLOW_BASELINE_PATH,
  OVERFLOW_EXTRA_SCENES,
  OVERFLOW_VIEWS,
  overflowKey,
  probeTextOverflow,
  readOverflowBaseline,
  serialiseOverflowBaseline,
  storedOverflow,
  updateOverflowBaseline,
  type OverflowCounts
} from './helpers/overflowProbe';

// ── 1. The probe self-test ──────────────────────────────────────────────────

const CSS = `<style>*{box-sizing:border-box} body{margin:0;font:16px/1.4 sans-serif}
  .box{border:1px solid #999;width:160px;padding:4px} .clip{overflow:hidden} .nowrap{white-space:nowrap} .ell{text-overflow:ellipsis}
  .wrap{overflow-wrap:anywhere}</style>`;
const html = (body: string) => `<!doctype html><html><head><meta name="viewport" content="width=device-width">${CSS}</head><body><main>${body}</main></body></html>`;
const LONG = 'https://api.example-provider.dev/v1/images/generations/very-long-path-segment-0123456789abcdef';

test.describe('overflow probe self-test @selftest', () => {
  test.use({ viewport: { width: 400, height: 600 } });
  const probe = (page: Page) => page.evaluate(probeTextOverflow, { error: LONG, id: LONG, inject: false });

  test('a long word leaving its box, and one cut by a clip without an ellipsis, are each reported; wrap and ellipsis are clean', async ({ page }) => {
    await page.setContent(
      html(`<div class="box" data-probe-text>${LONG}</div>
        <div class="box clip" data-probe-text>${LONG}</div>
        <div class="box wrap" data-probe-text>${LONG}</div>
        <div class="box clip nowrap ell" data-probe-text>${LONG}</div>`)
    );
    const r = await probe(page);
    expect(r.escapes.map((e) => e.issue.split(' ')[0])).toEqual(['escapes-x', 'cut-x']);
    expect(r.counts.textEscapes).toBe(2);
  });

  test('page overflow is the px the document is wider than the viewport', async ({ page }) => {
    await page.setContent(html(`<div style="width:520px;height:10px"></div>`));
    expect((await probe(page)).counts.hOverflow).toBe(120);
  });

  test('injection: the long error lands in alerts and message slots, the id in labels, and alerts are stacked', async ({ page }) => {
    await page.setContent(
      html(`<div role="alert" class="box">Short error</div>
        <p data-slot="message">Fine</p>
        <span data-slot="badge" class="box clip nowrap" style="display:inline-block">Tag</span>`)
    );
    const r = await page.evaluate(probeTextOverflow, { error: LONG, id: 'id-'.repeat(30), inject: true });
    expect(r.injected).toBe(5); // alert, message, badge, and the alert twice more
    expect(await page.locator('[role="alert"]').count()).toBe(3);
    expect(r.escapes.some((e) => e.kind === 'label' && e.issue.startsWith('cut-x'))).toBe(true);
  });

  test('a popover that opens past the right edge is counted; one inside the screen, or an in-flow disclosure that grows, is not', async ({ page }) => {
    await page.setContent(
      html(`<button aria-haspopup="menu" aria-expanded="false" onclick="document.getElementById('m1').hidden=false">More</button>
        <div id="m1" role="menu" hidden style="position:fixed;left:300px;top:40px;width:200px;height:60px;background:#eee">x</div>
        <button aria-haspopup="menu" aria-expanded="false" onclick="document.getElementById('m2').hidden=false">Fine</button>
        <div id="m2" role="menu" hidden style="position:fixed;left:10px;top:140px;width:200px;height:60px;background:#eee">y</div>
        <button aria-haspopup="menu" onclick="document.body.dataset.pressed='1'">Delete page</button>
        <button aria-expanded="false" aria-controls="d1" onclick="document.getElementById('d1').style.height='900px'">Show more</button>
        <p id="d1" style="height:20px;margin:0">an in-flow disclosure that grows past the fold</p>`)
    );
    const r = await measurePopovers(page);
    expect(r.tried).toEqual(['More', 'Fine', 'Show more']);
    expect(r.count).toBe(1);
    expect(r.escapes[0]).toMatch(/^More → div\[role=menu\]/);
    expect(await page.evaluate(() => document.body.dataset.pressed)).toBeUndefined();
  });

  test('the ratchet: unlisted scenes are held to 0, listed ones neither rise nor fall; the updater only lowers', () => {
    expect(judgeOverflow('new@narrow-light', { textEscapes: 1 }, {}).over).toEqual(['new@narrow-light  textEscapes: 1, not in the baseline: a new scene is held to 0']);
    const listed = { 'a@desk-light': { textEscapes: 3 } };
    expect(judgeOverflow('a@desk-light', { textEscapes: 3 }, listed)).toEqual({ over: [], under: [] });
    expect(judgeOverflow('a@desk-light', { textEscapes: 4 }, listed).over).toHaveLength(1);
    expect(judgeOverflow('a@desk-light', { textEscapes: 2 }, listed).under).toHaveLength(1);
    // A listed pixel width may differ by 2 px between machines (the CI runner read 140 and 100 where the baseline says
    // 139 and 99); counts and zeros stay exact.
    const px = { 's@narrow-light': { textEscapes: 3, hOverflow: 139 }, 's@phone-dark': { textEscapes: 3, hOverflow: 99 } };
    expect(judgeOverflow('s@narrow-light', { textEscapes: 3, hOverflow: 140 }, px)).toEqual({ over: [], under: [] });
    expect(judgeOverflow('s@phone-dark', { textEscapes: 3, hOverflow: 100 }, px)).toEqual({ over: [], under: [] });
    expect(judgeOverflow('s@narrow-light', { textEscapes: 3, hOverflow: 137 }, px)).toEqual({ over: [], under: [] });
    expect(judgeOverflow('s@narrow-light', { textEscapes: 3, hOverflow: 142 }, px).over).toEqual(['s@narrow-light  hOverflow: 142, baseline 139']);
    expect(judgeOverflow('s@narrow-light', { textEscapes: 3, hOverflow: 136 }, px).under).toHaveLength(1);
    expect(judgeOverflow('s@narrow-light', { textEscapes: 4, hOverflow: 139 }, px).over).toEqual(['s@narrow-light  textEscapes: 4, baseline 3']);
    expect(judgeOverflow('new@narrow-light', { hOverflow: 1 }, {}).over).toHaveLength(1);
    expect(judgeOverflow('a@desk-light', { textEscapes: 3, hOverflow: 1 }, listed).over).toEqual(['a@desk-light  hOverflow: 1, baseline 0']);
    expect(updateOverflowBaseline(listed, { 'a@desk-light': { textEscapes: 5 }, 'b@desk-light': { hOverflow: 2 } }, 'shrink')).toEqual(listed);
    expect(updateOverflowBaseline(listed, { 'a@desk-light': { textEscapes: 1 } }, 'shrink')).toEqual({ 'a@desk-light': { textEscapes: 1 } });
    expect(updateOverflowBaseline(listed, { 'a@desk-light': {}, 'b@desk-light': { hOverflow: 2 } }, 'reset')).toEqual({ 'b@desk-light': { hOverflow: 2 } });
    expect(storedOverflow({ textEscapes: 0, hOverflow: 3 })).toEqual({ hOverflow: 3 });
  });

  test('the checked-in baseline is a clean generated file over measured views', () => {
    const { problems, exists } = readOverflowBaseline();
    expect(exists, `${path.relative(process.cwd(), OVERFLOW_BASELINE_PATH)} exists`).toBe(true);
    expect(problems).toEqual([]);
  });
});

// ── 2. The scenes ───────────────────────────────────────────────────────────

const MODE = clutterMode();
const reportDir = () => path.join(process.env.QA_ARTIFACTS_RESOLVED || path.resolve('node_modules/.cache/comic-qa'), 'overflow');

for (const view of OVERFLOW_VIEWS) {
  test.describe(`overflow scenes @overflow (${view.id}, ${view.theme})`, () => {
    const device = deviceByName(view.device)!;
    test.use({ viewport: device.viewport, isMobile: device.isMobile, hasTouch: device.hasTouch, deviceScaleFactor: 1, colorScheme: view.theme, reducedMotion: 'reduce' });

    test(`${view.id} ${view.theme}: every scene against tests/e2e/baselines/overflow.json`, async ({ page }, testInfo) => {
      const qa = new QaHarness(page, device, testInfo);
      const { scenes: baseline, problems } = readOverflowBaseline();
      if (MODE === 'check') expect(problems, 'tests/e2e/baselines/overflow.json is clean').toEqual([]);
      const { scenes: clutter } = readClutterBaseline();
      test.setTimeout(120_000 + 15_000 * (DECLUTTER_SCENES.length + OVERFLOW_EXTRA_SCENES.length + 12));
      const look = { theme: view.theme, skin: 'atlas', img: 'svg', still: true } as const;
      const measured: Record<string, OverflowCounts> = {};
      const report: Record<string, unknown> = {};
      const attempted: string[] = [];

      const measureScene = async (key: string, q: QaQuery & Record<string, unknown>, c6Key: string | null, board = false) => {
        attempted.push(key);
        await test.step(key, async () => {
          try {
            await qa.open({ ...look, ...q } as QaQuery);
            // Phones: the board tab scenes as the declutter loop shows them (the Board view of the one-pane studio).
            if (board) await qa.toBoard();
            await page.evaluate(() => document.fonts?.ready.then(() => undefined));
            await qa.settle(200);
            // C6 before anything is injected: a label span must never cut a label that fits today.
            let truncated: string[] = [];
            if (c6Key) {
              const c6 = await measureClutter(page, { chrome: false, content: null });
              truncated = c6.detail.truncated;
              const limit = clutter[c6Key]?.truncatedLabels ?? CLUTTER_TARGETS.truncatedLabels ?? 0;
              expect.soft(c6.counts.truncatedLabels, `${key}: truncated labels above the declutter baseline ${c6Key} (${limit}): ${JSON.stringify(truncated)}`).toBeLessThanOrEqual(limit);
            }
            const pop = await measurePopovers(page);
            const text = await measureOverflow(page);
            const counts: OverflowCounts = { ...text.counts, popoverEscapes: pop.count };
            const verdict = judgeOverflow(key, counts, baseline);
            measured[key] = counts;
            report[key] = { url: page.url().replace(/^https?:\/\/[^/]+/, ''), counts: storedOverflow(counts), escapes: text.escapes, popovers: pop.escapes, tried: pop.tried, truncated, ...verdict };
            if (MODE !== 'reset') expect.soft(verdict.over, `${key}: overflow above the baseline (${JSON.stringify(text.escapes.slice(0, 6))} ${JSON.stringify(pop.escapes)})`).toEqual([]);
            if (MODE === 'check') expect.soft(verdict.under, `${key}: below the baseline — lower it so the gain is kept`).toEqual([]);
          } catch (e) {
            const errors = qa.pageErrors.splice(0);
            report[key] = { error: `${e instanceof Error ? e.message : String(e)}${errors.length ? ` (page errors: ${errors.join(' | ')})` : ''}`.slice(0, 600) };
            expect.soft((report[key] as { error: string }).error, `${key} opens and is measured`).toBe('');
          }
        });
      };

      for (const scene of DECLUTTER_SCENES) {
        await measureScene(overflowKey(scene.id, view.id, view.theme), scene.q as QaQuery & Record<string, unknown>, sceneKey(scene.id, view.id, view.theme), !!scene.phoneBoard && view.id !== 'desk');
      }
      for (const scene of OVERFLOW_EXTRA_SCENES) await measureScene(overflowKey(scene.id, view.id, view.theme), scene.q as QaQuery & Record<string, unknown>, null);
      try {
        await qa.open({ surface: 'app', ...look });
        const { scenes } = await qa.appScenes();
        for (const { id } of scenes) {
          const extra = APP_SCENE_QUERY[id];
          // The C6 comparison holds where the URL is the declutter loop's own (no extra query).
          await measureScene(overflowKey(`app-${id}`, view.id, view.theme), { surface: 'app', scene: id, ...(extra ?? {}) }, extra ? null : sceneKey(`app-${id}`, view.id, view.theme));
        }
      } catch (e) {
        expect.soft(String(e), 'the app scene index opens').toBe('');
      }

      const suffix = `${view.id}-${view.theme}`;
      const vanished = Object.keys(baseline).filter((k) => k.endsWith(`@${suffix}`) && !attempted.includes(k));
      if (MODE === 'check') expect.soft(vanished, 'every baseline entry is still a scene').toEqual([]);

      fs.mkdirSync(reportDir(), { recursive: true });
      const file = path.join(reportDir(), `overflow-report-${suffix}.json`);
      fs.writeFileSync(file, `${JSON.stringify(report, null, 1)}\n`);
      await testInfo.attach(`overflow-report-${suffix}.json`, { path: file, contentType: 'application/json' });

      if (MODE !== 'check') {
        withFileLock(OVERFLOW_BASELINE_PATH, () => {
          const { scenes: now } = readOverflowBaseline();
          writeAtomic(OVERFLOW_BASELINE_PATH, serialiseOverflowBaseline(updateOverflowBaseline(now, measured, MODE, vanished)));
        });
      }
    });
  });
}
