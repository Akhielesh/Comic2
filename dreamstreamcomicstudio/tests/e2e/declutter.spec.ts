// The clutter ratchet (declutter DC-0; docs/design/clean-and-smooth.md): the "clean and smooth" rubric, measured.
//
//   npx playwright test -c tests/e2e/playwright.config.ts --project=declutter                  self-test + every scene
//   npx playwright test -c tests/e2e/playwright.config.ts --project=declutter --grep @selftest  the probe self-test only
//   UPDATE_BASELINES=1     … --project=declutter   lower tests/e2e/baselines/declutter.json where a scene improved
//   UPDATE_BASELINES=reset … --project=declutter   rewrite the measured entries (first generation, or a reviewed exception)
//
// 1. Self-test (@selftest): synthetic pages seed each kind of clutter (two primaries, a depth-3 box, a clipped label,
//    pulses, duplicate actions, the C5 phrases, page overflow, phone chrome, a long transcript) and the probe
//    (helpers/clutterProbe.ts) must report each one exactly, and nothing on a clean page. The ratchet's pure rules
//    (above fails, below fails, an unlisted scene meets the targets, the updater only lowers) are proven here too.
// 2. Scenes (@declutter): every scene of the loop (DECLUTTER_SCENES, plus every qa/app/scenes page discovered at
//    runtime) at 360×740 and 1280×800, light and dark, and at 320×640 light for C6 and overflow only (the `narrow`
//    view), with the page-level Atlas skin and real motion (still=0, motion on, entrances settled first: C9 counts
//    what keeps moving). Each scene is judged against the baseline: a listed scene may neither rise nor fall, an
//    unlisted one meets the rubric targets. The numbers and the labels behind them go to
//    <QA_ARTIFACTS>/declutter/clutter-report.json (and are attached to the test) for the rubric review; each view and
//    theme replaces its own entries there, and a scene that could not be measured is written with its error only.
//
// Baselines are lowered by the slot's integration owner only (PROGRAM3 §3.9 step 3): a package that improves a scene
// writes the new numbers as a wave note.

import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { deviceByName } from './devices';
import { QaHarness, type QaQuery } from './helpers/harness';
import { markConversationScroller } from './helpers/scenes';
import {
  BASELINE_PATH,
  CLUTTER_METRICS,
  CLUTTER_TARGETS,
  DECLUTTER_SCENES,
  DECLUTTER_SUFFIXES,
  DECLUTTER_VIEWS,
  NARROW_METRICS,
  PRIMARY_TOKENS,
  PROBE_SKIP,
  clutterMode,
  judgeScene,
  measureClutter,
  mergeClutterReport,
  probeClutter,
  readClutterBaseline,
  sceneKey,
  serialiseClutterBaseline,
  storedCounts,
  updateClutterBaseline,
  vanishedKeys,
  vanishedLine,
  viewCounts,
  viewDetail,
  withFileLock,
  writeAtomic,
  type ClutterCounts,
  type ClutterMetric,
  type ClutterReportEntry,
  type ProbeArgs,
  type ProbeResult
} from './helpers/clutterProbe';

// ── 1. The probe self-test ──────────────────────────────────────────────────

const BASE_CSS = `<style>
  *{box-sizing:border-box} body{margin:0;font:16px/1.4 sans-serif} button,a{font:inherit}
  :root{--ds-accent:#3d44e8;--ds-accent-fill:var(--ds-accent)}
  .spark{background:var(--ds-spark);color:#fff;border:0;height:44px;padding:0 12px}
  .primary{background:var(--ds-accent-fill);color:#fff;border:0;height:44px;padding:0 12px;display:inline-flex;align-items:center}
  .box{border:1px solid #c9c9c9;border-radius:8px;padding:8px;margin:4px}
  .square{border:1px solid #c9c9c9;border-radius:0;padding:8px}
  .chip{width:72px;height:44px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:inline-block;text-align:left}
  @keyframes beat{50%{opacity:.5}}
  .pulse{display:inline-block;width:10px;height:10px;border-radius:5px;background:#3d44e8;animation:beat 2s infinite}
  .once{display:inline-block;width:10px;height:10px;animation:beat 200ms 1}
  .long{display:inline-block;width:10px;height:10px;animation:beat 10s 1}
  .paused{display:inline-block;width:10px;height:10px;animation:beat 2s infinite paused}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border-width:0}
</style>`;
const html = (body: string) => `<!doctype html><html><head><meta name="viewport" content="width=device-width">${BASE_CSS}</head><body>${body}</body></html>`;

const probe = (page: Page, over: Partial<ProbeArgs> = {}): Promise<ProbeResult> =>
  page.evaluate(probeClutter, { primaryTokens: [...PRIMARY_TOKENS], chrome: false, content: null, skip: PROBE_SKIP, ...over });

/** Every metric 0 except the ones named. */
const only = (counts: ClutterCounts) => Object.fromEntries(CLUTTER_METRICS.map((m) => [m, counts[m] ?? 0])) as Record<ClutterMetric, number>;

test.describe('clutter probe self-test @selftest', () => {
  test.use({ viewport: { width: 800, height: 600 }, reducedMotion: 'no-preference', colorScheme: 'light' });

  test('the fixture page: two primaries, a depth-3 box and a clipped label are each reported, and nothing else', async ({ page }) => {
    await page.setContent(
      html(`<main>
        <button class="primary">Approve</button>
        <a class="primary" href="#render">Render remaining 4</a>
        <button class="primary" disabled>Disabled primary</button>
        <button class="primary" aria-pressed="true">Selected segment</button>
        <span aria-hidden="true"><button class="primary">Behind the modal</button></span>
        <button>Not now</button>
        <div class="box"><div class="box"><div class="box">three deep</div></div></div>
        <div class="square"><div class="box">a square frame is not a box</div></div>
        <button class="chip">Comic options and more</button>
        <button class="chip"><span data-user-content>A very long comic title of the user's</span></button>
        <button style="width:220px;height:44px">This label fits</button>
        <div style="height:2000px"></div>
        <button class="primary">Below the fold</button>
      </main>`)
    );
    const { counts, detail } = await probe(page);
    expect(detail.primaries).toEqual(['Approve', 'Render remaining 4']);
    expect(detail.deepestBoxes).toHaveLength(3);
    expect(detail.truncated).toEqual(['Comic options and more']);
    expect(counts).toEqual(only({ primaries: 2, nestedBoxes: 2, maxBoxDepth: 3, truncatedLabels: 1 }));
  });

  test('a label cut by a box inside the control, or by a fixed height, is truncated too; one that wraps freely, or screen-reader-only text, is not', async ({ page }) => {
    await page.setContent(
      html(`<main>
        <button style="width:90px;height:44px"><span style="display:block;overflow:hidden;white-space:nowrap">Draw pages 3–5 now</span></button>
        <button style="width:90px;height:22px;overflow:hidden;line-height:20px">Render remaining four pages</button>
        <button style="width:90px;line-height:20px">Render remaining four pages</button>
        <div role="tab" style="width:60px;overflow:hidden;white-space:nowrap">Characters</div>
        <button style="width:120px;height:44px"><span class="sr-only">Format:</span> 2:3 · 12p</button>
        <button style="width:120px;height:44px"><span style="position:absolute;clip-path:inset(50%);overflow:hidden;width:1px;height:1px;white-space:nowrap">Art style:</span> Noir ink</button>
      </main>`)
    );
    const { counts, detail } = await probe(page);
    expect(detail.truncated).toEqual(['Draw pages 3–5 now', 'Render remaining four pages', 'Characters']);
    expect(counts.truncatedLabels).toBe(3);
  });

  test('live pulses, duplicate actions, the C5 phrases and page overflow', async ({ page }) => {
    await page.setContent(
      html(`<main>
        <span class="pulse" aria-hidden="true"></span><span class="pulse"></span>
        <span class="once"></span><span class="paused"></span><span class="long"></span>
        <div inert><span class="pulse"></span></div>
        <button data-action="read">Read</button><a href="#read" data-action="read">Read full screen</a>
        <button data-action="read" style="display:none">Read (hidden)</button>
        <button data-action="share">Share</button>
        <p>This uses a little of your usage. Then a little of your usage again. A Little Of Your Usage.</p>
        <p>Free · Free! Freedom, free.</p>
        <div style="width:1000px;height:10px"></div>
        <div style="height:1500px"></div>
        <span class="pulse"></span>
      </main>`)
    );
    await page.waitForTimeout(400);
    // `.long` is a finite entrance still running when the probe measures (10 s, one iteration): it is not a live pulse.
    expect(await page.evaluate(() => document.querySelector('.long')!.getAnimations()[0]?.playState)).toBe('running');
    const { counts, detail } = await probe(page);
    expect(detail.pulses).toEqual(['beat on span.pulse', 'beat on span.pulse']);
    expect(detail.duplicateActions).toEqual(['read ×2']);
    expect(counts).toEqual(only({ livePulses: 2, duplicateActions: 1, usagePhrases: 3, freeWords: 2, hOverflow: 200 }));
  });

  test('phone chrome share against the content region, and the transcript in screens', async ({ page }) => {
    await page.setContent(
      html(`<header style="position:fixed;top:0;left:0;width:100%;height:120px">Title · Quality · ⋯</header>
        <section aria-label="Conversation" style="position:fixed;top:120px;bottom:60px;left:0;right:0;display:flex;flex-direction:column">
          <div id="content" style="flex:1;min-height:0;overflow-y:auto"><div style="height:1500px">messages</div></div>
        </section>
        <nav style="position:fixed;bottom:0;left:0;width:100%;height:60px">Chat · Board</nav>`)
    );
    // 600 px: 120 header + 60 tab bar = 30 % chrome; 1500 px of messages in a 420 px scroller = 4 screens.
    expect((await probe(page, { chrome: true, content: '#content' })).counts).toEqual(only({ chromeShare: 30, transcriptScreens: 4 }));
    expect((await probe(page, { chrome: true, content: null })).counts.chromeShare, 'no content selector: the tallest scroller').toBe(30);
    expect((await probe(page, { chrome: false })).counts.chromeShare, 'off a phone scene C8 is not measured').toBe(0);
    expect((await probe(page, { chrome: true, content: '#content' })).detail.chromeContent).toBe('div');
    // Nothing scrolls (the share reader on a phone): the page's <main> is the content; 60 px of header = 10 %.
    await page.setContent(html(`<header style="height:60px">Back · Title</header><main style="height:540px">the page</main>`));
    const fit = await probe(page, { chrome: true });
    expect([fit.counts.chromeShare, fit.detail.chromeContent]).toEqual([10, 'main']);
  });

  test("CL-0's spark fill is a primary once the token exists; an undefined token matches nothing", async ({ page }) => {
    await page.setContent(html(`<main><button class="spark">Make my comic</button><button class="primary">Approve</button></main>`));
    // No --ds-spark on the page (today's tree): an unset var() leaves the button transparent, so only Approve counts.
    expect((await probe(page)).detail.primaries).toEqual(['Approve']);
    await page.addStyleTag({ content: ':root{--ds-spark:#3d44e8}' });
    expect((await probe(page)).detail.primaries).toEqual(['Make my comic', 'Approve']);
    // Tokens are resolved AT the control: inside a scope that redefines them (a scoped skin), the scope's fill is the
    // primary and the page-level colour is not.
    await page.setContent(
      html(`<main><div style="--ds-accent:#e77412;--ds-accent-fill:#e77412;--ds-spark:#e77412">
        <button style="background:#3d44e8;color:#fff;border:0;height:44px">Same blue, another scope</button>
        <button class="primary">Scoped primary</button>
      </div></main>`)
    );
    expect((await probe(page)).detail.primaries).toEqual(['Scoped primary']);
  });

  test('a clean page: one primary, one card with a divider, nothing else', async ({ page }) => {
    await page.setContent(
      html(`<main><div class="box"><p>One card</p><hr><p>A divided section</p><button class="primary">Draw 6 pages · ≈2%</button></div><button>Not now</button></main>`)
    );
    const { counts } = await probe(page);
    expect(counts).toEqual(only({ primaries: 1, maxBoxDepth: 1 }));
    expect(judgeScene('new-screen@desk-light', counts, {})).toEqual({ over: [], under: [] });
  });

  test('the ratchet: above fails, below fails until lowered, an unlisted scene meets the targets', () => {
    const listed: Record<string, ClutterCounts> = { 'studio-chat@desk-light': { primaries: 2, nestedBoxes: 3, maxBoxDepth: 2, usagePhrases: 33 } };
    const same = judgeScene('studio-chat@desk-light', { primaries: 2, nestedBoxes: 3, maxBoxDepth: 2, usagePhrases: 33 }, listed);
    expect(same).toEqual({ over: [], under: [] });
    const rose = judgeScene('studio-chat@desk-light', { primaries: 3, nestedBoxes: 3, maxBoxDepth: 2, usagePhrases: 33, livePulses: 1 }, listed);
    expect(rose.over.map((l) => l.split(':')[0])).toEqual(['studio-chat@desk-light  primaries', 'studio-chat@desk-light  livePulses']);
    expect(rose.under).toEqual([]);
    const fell = judgeScene('studio-chat@desk-light', { primaries: 1, nestedBoxes: 3, maxBoxDepth: 2, usagePhrases: 20 }, listed);
    expect(fell.over).toEqual([]);
    expect(fell.under).toHaveLength(2);
    expect(fell.under[0]).toMatch(/^studio-chat@desk-light {2}primaries: 1, baseline 2 — it fell: lower the baseline/);
    // Not listed: held to CLUTTER_TARGETS, and only to them (nested boxes and the C5 phrases have no absolute target).
    const fresh = judgeScene('library@phone-dark', { primaries: 2, maxBoxDepth: 3, truncatedLabels: 1, chromeShare: 30, livePulses: 2, nestedBoxes: 9, usagePhrases: 4 }, listed);
    expect(fresh.over.map((l) => l.split(':')[0].split('  ')[1])).toEqual(['primaries', 'maxBoxDepth', 'truncatedLabels', 'chromeShare', 'livePulses']);
    expect(judgeScene('library@phone-dark', { ...CLUTTER_TARGETS, nestedBoxes: 9 }, listed)).toEqual({ over: [], under: [] });
  });

  test('the updater only lowers (UPDATE_BASELINES=1), reset rewrites, vanished scenes are dropped; the file round-trips', () => {
    const base: Record<string, ClutterCounts> = { 'a@phone-light': { primaries: 2, freeWords: 9 }, 'b@phone-light': { maxBoxDepth: 3 }, 'c@desk-light': { primaries: 2 } };
    const measured: Record<string, ClutterCounts> = { 'a@phone-light': { primaries: 3, freeWords: 4 }, 'new@phone-light': { primaries: 5 } };
    const drop = vanishedKeys(['a@phone-light', 'new@phone-light'], base, 'phone-light');
    expect(drop).toEqual(['b@phone-light']);
    expect(vanishedLine(drop[0])).toMatch(/no longer a scene — drop its entry/);
    // Shrink: a rise is never written (primaries stays 2 and still fails), a fall is kept, nothing is added.
    expect(updateClutterBaseline(base, measured, 'shrink', drop)).toEqual({ 'a@phone-light': { primaries: 2, freeWords: 4 }, 'c@desk-light': { primaries: 2 } });
    expect(updateClutterBaseline(base, measured, 'reset', drop)).toEqual({ 'a@phone-light': { primaries: 3, freeWords: 4 }, 'new@phone-light': { primaries: 5 }, 'c@desk-light': { primaries: 2 } });
    expect(storedCounts({ primaries: 0, livePulses: 1, freeWords: 2 })).toEqual({ livePulses: 1, freeWords: 2 });
    expect(clutterMode('')).toBe('check');
    expect(clutterMode('0')).toBe('check');
    expect(clutterMode('1')).toBe('shrink');
    expect(clutterMode('reset')).toBe('reset');
    const dir = test.info().outputPath('baseline');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'declutter.json');
    fs.writeFileSync(file, serialiseClutterBaseline(base));
    expect(readClutterBaseline(file)).toEqual({ scenes: base, problems: [], exists: true });
    fs.writeFileSync(file, serialiseClutterBaseline(base).replace('"freeWords": 9', '"freeWords": 0'));
    expect(readClutterBaseline(file).problems.join('\n')).toMatch(/freeWords is 0/);
    fs.writeFileSync(file, serialiseClutterBaseline(base).replace('"scenes": {', '"scenes": {"bad key": {},'));
    expect(readClutterBaseline(file).problems.join('\n')).toMatch(/"bad key" is not <scene>@/);
    // Generated, never typed: valid JSON with the same numbers still fails when it is not byte for byte the generated
    // form (a hand edit), and when its targets are not CLUTTER_TARGETS (the targets changed, the file was not rebuilt).
    const handEdited = serialiseClutterBaseline(base).replace('"a@phone-light": {', '"a@phone-light":  {');
    expect(JSON.parse(handEdited)).toEqual(JSON.parse(serialiseClutterBaseline(base)));
    fs.writeFileSync(file, handEdited);
    expect(readClutterBaseline(file).problems.join('\n')).toMatch(/hand-edited or has stale targets/);
    const staleTargets = serialiseClutterBaseline(base).replace(/"targets": \{[^}]*\}/, '"targets": { "primaries": 2 }');
    expect(staleTargets).not.toBe(serialiseClutterBaseline(base));
    fs.writeFileSync(file, staleTargets);
    expect(readClutterBaseline(file).problems.join('\n')).toMatch(/hand-edited or has stale targets/);
    // Keys name a view × theme the loop measures, and a view's entry holds only the metrics that view ratchets.
    expect(DECLUTTER_SUFFIXES).toEqual(['phone-light', 'phone-dark', 'desk-light', 'desk-dark', 'narrow-light']);
    for (const key of ['a@narrow-dark', 'a@tablet-light', '@phone-light', 'A@phone-light']) {
      fs.writeFileSync(file, serialiseClutterBaseline({ ...base, [key]: { truncatedLabels: 1 } }));
      expect(readClutterBaseline(file).problems.join('\n'), key).toContain(`"${key}" is not <scene>@<view>-<theme>`);
    }
    fs.writeFileSync(file, serialiseClutterBaseline({ ...base, 'a@narrow-light': { truncatedLabels: 2, hOverflow: 14 } }));
    expect(readClutterBaseline(file).problems).toEqual([]);
    fs.writeFileSync(file, serialiseClutterBaseline({ ...base, 'a@narrow-light': { primaries: 2, truncatedLabels: 2 } }));
    expect(readClutterBaseline(file).problems.join('\n')).toMatch(/a@narrow-light lists primaries, which the narrow view does not measure/);
  });

  test('the 320 px view ratchets only C6 and overflow; a view and theme replaces its own report entries, failed scenes included', () => {
    const narrow = DECLUTTER_VIEWS.find((v) => v.id === 'narrow')!;
    expect([narrow.device, narrow.width, narrow.themes, narrow.shots]).toEqual(['smoke-320x640', 320, ['light'], false]);
    expect(narrow.metrics).toEqual(NARROW_METRICS);
    const raw = { primaries: 2, maxBoxDepth: 3, truncatedLabels: 1, chromeShare: 40, hOverflow: 12 };
    expect(viewCounts(raw, NARROW_METRICS)).toEqual(only({ truncatedLabels: 1, hOverflow: 12 }));
    expect(viewCounts(raw, CLUTTER_METRICS)).toEqual(only(raw));
    const detail = { controls: 9, primaries: ['Approve'], duplicateActions: ['read ×2'], deepestBoxes: ['a', 'b', 'c'], truncated: ['Mark up'], pulses: ['ping on span'], duplicateNames: { 'change the': 3 }, chromeContent: 'main' };
    expect(viewDetail(detail, NARROW_METRICS)).toEqual({ controls: 9, primaries: [], duplicateActions: [], deepestBoxes: [], truncated: ['Mark up'], pulses: [], duplicateNames: {}, chromeContent: null });
    expect(viewDetail(detail, CLUTTER_METRICS)).toEqual(detail);
    // An unlisted 320 scene is held to the C6 and overflow targets only: its two primaries were never measured.
    expect(judgeScene('new@narrow-light', viewCounts(raw, NARROW_METRICS), {}).over.map((l) => l.split(':')[0].split('  ')[1])).toEqual(['truncatedLabels', 'hOverflow']);

    const prior = {
      'a@phone-light': { url: '/a', counts: only({ primaries: 2 }) },
      'gone@phone-light': { url: '/gone', counts: only({ primaries: 1 }) },
      'a@desk-light': { url: '/a', counts: only({ primaries: 3 }) }
    };
    const merged = mergeClutterReport(prior, { 'a@phone-light': { url: '/a', error: 'QA surface crashed: boom' }, 'b@phone-light': { url: '/b', counts: only({}) } }, 'phone-light');
    // This run's phone-light entries replace every earlier one: the failed scene keeps no old numbers, the dropped
    // scene is gone; the desk entry (another test's part) stays.
    expect(Object.keys(merged)).toEqual(['a@desk-light', 'a@phone-light', 'b@phone-light']);
    expect(merged['a@phone-light']).toEqual({ url: '/a', error: 'QA surface crashed: boom' });
    expect(merged['a@desk-light']).toBe(prior['a@desk-light']);
    expect(mergeClutterReport(undefined, {}, 'desk-dark')).toEqual({});
  });

  test('the checked-in baseline is a clean generated file over known scenes', () => {
    const { scenes, problems, exists } = readClutterBaseline();
    expect(exists, `${path.relative(process.cwd(), BASELINE_PATH)} exists`).toBe(true);
    expect(problems).toEqual([]);
    const ids = new Set(DECLUTTER_SCENES.map((s) => s.id));
    for (const key of Object.keys(scenes)) {
      const id = key.split('@')[0];
      expect(ids.has(id) || id.startsWith('app-'), `${key} names a DECLUTTER_SCENES id or an app scene`).toBe(true);
    }
    expect(new Set(DECLUTTER_SCENES.map((s) => s.id)).size, 'scene ids are unique').toBe(DECLUTTER_SCENES.length);
  });
});

// ── 2. The scenes ───────────────────────────────────────────────────────────

const MODE = clutterMode();
const reportDir = () => path.join(process.env.QA_ARTIFACTS_RESOLVED || path.resolve('node_modules/.cache/comic-qa'), 'declutter');

/**
 * Write this test's scenes into clutter-report.json (one test per view × theme writes it, possibly in parallel):
 * this run's entries of `suffix` replace every earlier one (mergeClutterReport), so no stale number survives.
 */
const writeReport = (entries: Record<string, ClutterReportEntry>, suffix: string) => {
  const file = path.join(reportDir(), 'clutter-report.json');
  withFileLock(file, () => {
    let prior: { scenes?: Record<string, ClutterReportEntry>; runs?: Record<string, string> } = {};
    try {
      prior = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      prior = {};
    }
    const now = new Date().toISOString();
    const runs = Object.fromEntries(Object.entries({ ...(prior.runs || {}), [suffix]: now }).filter(([k]) => DECLUTTER_SUFFIXES.includes(k)).sort(([a], [b]) => a.localeCompare(b)));
    const note = 'declutter probe (docs/design/clean-and-smooth.md): counts per scene@view-theme and the labels behind them; "runs" says when each view × theme was last measured, and an entry with "error" was not measured in that run';
    writeAtomic(file, `${JSON.stringify({ note, generatedAt: now, runs, scenes: mergeClutterReport(prior.scenes, entries, suffix) }, null, 1)}\n`);
  });
  return file;
};

for (const view of DECLUTTER_VIEWS) {
  for (const theme of view.themes) {
    test.describe(`declutter scenes @declutter (${view.id}, ${theme})`, () => {
      const device = deviceByName(view.device)!;
      test.use({
        viewport: device.viewport,
        isMobile: device.isMobile,
        hasTouch: device.hasTouch,
        deviceScaleFactor: 1,
        colorScheme: theme,
        // C9 counts what keeps moving, so motion is ON and still=0; entrances are let finish before measuring.
        reducedMotion: 'no-preference'
      });

      test(`${view.id} ${theme}: every scene against tests/e2e/baselines/declutter.json`, async ({ page }, testInfo) => {
        const qa = new QaHarness(page, device, testInfo);
        const suffix = `${view.id}-${theme}`;
        const { scenes: baseline, problems } = readClutterBaseline();
        if (MODE === 'check') expect(problems, 'tests/e2e/baselines/declutter.json is clean').toEqual([]);
        test.setTimeout(90_000 + 12_000 * (DECLUTTER_SCENES.length + 6));

        const look = { theme, skin: 'atlas', img: 'svg', still: false } as const;
        const measured: Record<string, ClutterCounts> = {};
        const attempted: string[] = [];
        const report: Record<string, ClutterReportEntry> = {};
        const sceneUrl = () => page.url().replace(/^https?:\/\/[^/]+/, '');

        const measureScene = async (key: string, q: QaQuery, opts: { board?: boolean; chrome?: boolean; content?: string }) => {
          attempted.push(key);
          await test.step(key, async () => {
            try {
              await qa.open({ ...q, ...look });
              if (opts.board && view.phone) await qa.toBoard();
              // Labels are measured in their real face (C6), after the entrances finished (C9 counts what keeps moving).
              await page.evaluate(() => document.fonts?.ready.then(() => undefined));
              await qa.settleAnimations(1500);
              await qa.settle(200);
              await markConversationScroller(page);
              const probed = await measureClutter(page, { chrome: view.phone && !!opts.chrome, content: opts.content ?? null });
              // A view ratchets only its own metrics (the 320 px view: C6 and overflow); the rest count as 0.
              const counts = viewCounts(probed.counts, view.metrics);
              const detail = viewDetail(probed.detail, view.metrics);
              const verdict = judgeScene(key, counts, baseline);
              measured[key] = counts;
              report[key] = { url: sceneUrl(), counts, detail, ...verdict };
              const why = `${JSON.stringify(storedCounts(counts))} — ${JSON.stringify(detail)}`;
              // A reset rewrites the entry from this very measurement, so only check and shrink runs judge a rise.
              if (MODE !== 'reset') expect.soft(verdict.over, `${key}: clutter above the baseline or the rubric target (${why})`).toEqual([]);
              if (MODE === 'check') expect.soft(verdict.under, `${key}: clutter below the baseline — lower it so the gain is kept`).toEqual([]);
            } catch (e) {
              const errors = qa.pageErrors.splice(0);
              const error = `${e instanceof Error ? e.message : String(e)}${errors.length ? ` (page errors: ${errors.join(' | ')})` : ''}`;
              // No numbers for a scene this run could not measure: the review sheet says so instead of showing old ones.
              report[key] = { url: sceneUrl(), error: error.slice(0, 600) };
              expect.soft(error, `${key} opens and is measured`).toBe('');
            }
          });
        };

        for (const scene of DECLUTTER_SCENES) {
          await measureScene(sceneKey(scene.id, view.id, theme), scene.q as QaQuery, { board: scene.phoneBoard, chrome: scene.chrome, content: scene.content });
        }

        // The app scenes (qa/app/scenes), discovered at runtime like the DS-1b smoke: a new one is held to the targets.
        let discovered = false;
        try {
          await qa.open({ surface: 'app', ...look });
          const { scenes } = await qa.appScenes();
          discovered = scenes.length > 0;
          for (const { id } of scenes) await measureScene(sceneKey(`app-${id}`, view.id, theme), { surface: 'app', scene: id }, {});
        } catch (e) {
          expect.soft(String(e), 'the app scene index opens').toBe('');
        }
        // An index that did not open is not proof that its scenes are gone: keep their entries.
        if (!discovered) for (const k of Object.keys(baseline)) if (k.startsWith('app-') && k.endsWith(`@${suffix}`)) attempted.push(k);

        const drop = vanishedKeys(attempted, baseline, suffix);
        if (MODE === 'check') expect.soft(drop.map(vanishedLine), 'every baseline entry is still a scene').toEqual([]);

        const file = writeReport(report, suffix);
        await testInfo.attach(`clutter-report-${suffix}.json`, { body: JSON.stringify(report, null, 1), contentType: 'application/json' });
        testInfo.annotations.push({ type: 'clutter-report', description: file });

        if (MODE !== 'check') {
          withFileLock(BASELINE_PATH, () => {
            const { scenes: now } = readClutterBaseline();
            writeAtomic(BASELINE_PATH, serialiseClutterBaseline(updateClutterBaseline(now, measured, MODE, drop)));
          });
          testInfo.annotations.push({ type: 'baseline', description: `${MODE}: ${Object.keys(measured).length} scene(s) of ${suffix} written to ${BASELINE_PATH}` });
        }
      });
    });
  }
}
