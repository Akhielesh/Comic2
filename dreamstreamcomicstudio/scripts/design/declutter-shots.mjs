#!/usr/bin/env node
// The refinement loop's screenshots (declutter DC-0; docs/design/clean-and-smooth.md §3.3 and §4 step 2 "Shoot").
//
// Shoots every scene of the loop at 360×740 and 1280×800, light and dark, from the OFFLINE QA harness
// (qa/comic-qa.html on synthetic fixtures: no auth, no backend, no money, no user data), and writes the review sheet
// the rubric reviewer reads against the previous wave's set:
//
//   <out>/<scene>@<view>-<theme>.png          one per scene: DECLUTTER_SCENES (tests/e2e/helpers/clutterProbe.ts,
//                                             the list the ratchet measures) plus every qa/app/scenes page (app-<id>)
//   <out>/transcript/<view>-<theme>-NN.png    the Director transcript (heist-12p), screen by screen, oldest first
//   <out>/index.json                          every shot, its URL, its numbers and its baseline entry
//   <out>/index.html                          the review sheet: each shot beside the previous wave's (--previous), the
//                                             numbers, and the rubric checks only eyes can judge (C2, C4, C5, C10)
//
//   node scripts/design/declutter-shots.mjs [--wave s2] [--out <dir>] [--previous <dir of the last wave>]
//        [--no-build | --dist <built QA folder>] [--only studio-chat,app-recipes,transcript] [--view phone|desk|narrow]
//        [--theme light|dark] [--no-app] [--no-transcript] [--frames 30] [--report <clutter-report.json>]
//
// --only takes scene ids (DECLUTTER_SCENES), `app-<id>` and `transcript`; an unknown value stops the run. --view
// defaults to the two shot sizes (phone, desk); `narrow` (320×640, light) is measured by the ratchet and shot only
// when asked for.
//
// Default <out>: <QA_ARTIFACTS>/declutter/<wave> (QA_ARTIFACTS defaults to node_modules/.cache/comic-qa): the shots
// are CI artifacts, never committed. Default <wave>: the short commit.
//
// The numbers come from the ratchet's own report (`tests/e2e/declutter.spec.ts` writes
// <QA_ARTIFACTS>/declutter/clutter-report.json): run the ratchet first, then this. The shots themselves are taken
// still (still=1, reduced motion) so two waves compare pixel for pixel; the ratchet measures live pulses with motion
// on. Nothing here fails on clutter: the ratchet does that. It exits 1 only when a scene does not open.
//
// Reuses the QA build (QA_BUILD=1 vite build, into <QA_ARTIFACTS>/declutter/dist-qa so the layout smoke's own bundle
// is untouched), `vite preview` as the server, the harness's fixture images (tests/e2e/fixtures/genImages.ts) and its
// Chromium rule (QA_CHROMIUM_PATH, then PLAYWRIGHT_BROWSERS_PATH; never downloads). Every request that is not
// same-origin is refused, exactly like the harness. Environment: QA_ARTIFACTS, QA_PORT (default 4182),
// QA_CHROMIUM_PATH / PLAYWRIGHT_BROWSERS_PATH. Node ≥ 22.18 (it imports the probe's TypeScript), or run it with
// `npx tsx scripts/design/declutter-shots.mjs` on an older Node.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ── Pure helpers (exported for scripts/design/declutter-shots.test.ts) ─────────

/** `<scene>@<view>-<theme>.png`: the ratchet's baseline key, so a shot and its numbers share one name. */
export const shotName = (key) => `${key}.png`;

/** `transcript/<view>-<theme>-NN.png`, NN from 00, oldest screen first. */
export const transcriptName = (view, theme, n) => `transcript/${view}-${theme}-${String(n).padStart(2, '0')}.png`;

/** The scroll offsets that show a scroller of `scrollHeight` screen by screen (10 % overlap), capped at `max` frames. */
export const transcriptOffsets = (scrollHeight, clientHeight, max = 30) => {
  if (!(clientHeight > 0) || !(scrollHeight > 0)) return [0];
  const step = Math.max(1, Math.floor(clientHeight * 0.9));
  const last = Math.max(0, scrollHeight - clientHeight);
  const out = [];
  for (let y = 0; y < last && out.length < max - 1; y += step) out.push(y);
  out.push(last);
  return out.slice(0, Math.max(1, max));
};

/**
 * What one run shoots. `only` (the --only values): DECLUTTER_SCENES ids, `app-<id>` (an app scene; known only once the
 * app index opens) and `transcript`; empty means everything. `app` / `transcript` false: --no-app / --no-transcript.
 * Throws on an unknown value or when nothing is left to shoot, so a typo never yields an empty sheet.
 */
export const planOnly = (only, sceneIds, { app = true, transcript = true } = {}) => {
  const ids = [...sceneIds];
  if (!only.length) return { scenes: ids, app, appIds: null, transcript };
  const unknown = only.filter((o) => !ids.includes(o) && o !== 'transcript' && !/^app-[a-z0-9][a-z0-9-]*$/.test(o));
  if (unknown.length) throw new Error(`--only: no scene ${unknown.join(', ')} (one of ${ids.join(', ')}, app-<id>, transcript)`);
  const appIds = only.filter((o) => o.startsWith('app-')).map((o) => o.slice(4));
  const plan = { scenes: ids.filter((id) => only.includes(id)), app: app && appIds.length > 0, appIds, transcript: transcript && only.includes('transcript') };
  if (!plan.scenes.length && !plan.app && !plan.transcript) throw new Error(`--only ${only.join(',')}: nothing left to shoot (--no-app / --no-transcript)`);
  return plan;
};

/** The views and themes to shoot: the shot sizes by default (`shots`), or the one --view names; --theme narrows. */
export const planViews = (views, { view = null, theme = null } = {}) => {
  const picked = views.filter((v) => (view ? v.id === view : v.shots)).map((v) => ({ view: v, themes: v.themes.filter((t) => !theme || t === theme) }));
  if (!picked.length) throw new Error(`--view is one of ${views.map((v) => v.id).join('|')}`);
  if (picked.every((p) => !p.themes.length)) throw new Error(`--theme ${theme}: the ${picked.map((p) => p.view.id).join('/')} view is measured in ${[...new Set(picked.flatMap((p) => p.view.themes))].join('|')}`);
  return picked.filter((p) => p.themes.length);
};

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The rubric checks only a reviewer's eyes can judge on these shots (clean-and-smooth.md §2). */
export const EYE_CHECKS = [
  ['C2', 'One home per action', 'Is any action (Read, Share, History, Media, Quality, Easy/Pro) reachable from two visible controls?'],
  ['C4', 'One number, one definition', 'Does a count appear twice, or with two definitions or units?'],
  ['C5', 'Say it once', 'Is a sentence, a price or "Free" repeated in one card or one view?'],
  ['C10', 'Same role, same control', 'Do header actions, card actions and chips each use one button family? Is a status drawn as a button?']
];

/**
 * One review row per shot: the shot, the previous wave's shot of the same name (when `previous` holds it), and the
 * numbers (this wave's report, the previous wave's index, the baseline entry).
 */
export const reviewRows = ({ shots, report = {}, previous = null, baseline = {}, metrics = [] }) =>
  shots.map((s) => {
    const now = report[s.key]?.counts ?? null;
    const before = previous?.shots?.find((p) => p.key === s.key) ?? null;
    const was = before?.counts ?? null;
    const changes = metrics
      .filter((m) => now && was && (now[m] ?? 0) !== (was[m] ?? 0))
      .map((m) => ({ metric: m, before: was[m] ?? 0, now: now[m] ?? 0 }));
    return { ...s, counts: now, detail: report[s.key]?.detail ?? null, reportError: now ? null : (report[s.key]?.error ?? null), baseline: baseline[s.key] ?? null, previousFile: before?.file ?? null, changes };
  });

/** The review sheet: plain HTML, no network, images by relative path (opens from disk or a CI artifact). */
export const renderIndexHtml = ({ wave, commit, rows, previousDir = null, outDir, metrics = [], transcripts = [], hints = {}, reportRuns = null }) => {
  const rel = (file, dir) => escapeHtml(path.relative(outDir, path.join(dir, file)).split(path.sep).join('/'));
  const cell = (r) => {
    if (!r.counts && r.reportError) return `<p class="err">No numbers: the ratchet could not measure this scene in its last run (${escapeHtml(r.reportError)}).</p>`;
    if (!r.counts) return '<p class="muted">No numbers: run the ratchet first (tests/e2e/declutter.spec.ts writes clutter-report.json).</p>';
    const items = metrics
      .filter((m) => (r.counts[m] ?? 0) > 0 || (r.baseline?.[m] ?? 0) > 0)
      .map((m) => {
        const base = r.baseline?.[m];
        const change = r.changes.find((c) => c.metric === m);
        const mark = change ? ` <b class="${change.now > change.before ? 'up' : 'down'}">${change.before} → ${change.now}</b>` : '';
        return `<li title="${escapeHtml(hints[m] ?? '')}"><code>${escapeHtml(m)}</code> ${r.counts[m] ?? 0}${base !== undefined ? ` <span class="muted">(baseline ${base})</span>` : ''}${mark}</li>`;
      });
    const d = r.detail;
    const why = d
      ? [
          d.primaries?.length ? `Primaries: ${d.primaries.map(escapeHtml).join(' · ')}` : '',
          d.truncated?.length ? `Truncated: ${d.truncated.map(escapeHtml).join(' · ')}` : '',
          d.pulses?.length ? `Pulses: ${d.pulses.map(escapeHtml).join(' · ')}` : '',
          d.deepestBoxes?.length > 2 ? `Deepest boxes: ${d.deepestBoxes.map(escapeHtml).join(' › ')}` : '',
          d.duplicateNames && Object.keys(d.duplicateNames).length ? `Same first words: ${Object.entries(d.duplicateNames).map(([k, n]) => `${escapeHtml(k)} ×${n}`).join(', ')}` : ''
        ].filter(Boolean)
      : [];
    return `<ul>${items.join('') || '<li class="muted">all zero</li>'}</ul>${why.map((w) => `<p class="why">${w}</p>`).join('')}`;
  };
  const row = (r) => `<tr id="${escapeHtml(r.key)}">
  <th scope="row"><a href="#${escapeHtml(r.key)}">${escapeHtml(r.key)}</a><p class="muted">${escapeHtml(r.note ?? '')}</p>${r.error ? `<p class="err">${escapeHtml(r.error)}</p>` : ''}</th>
  <td>${r.previousFile && previousDir ? `<img loading="lazy" src="${rel(r.previousFile, previousDir)}" alt="${escapeHtml(r.key)}, previous wave">` : '<p class="muted">—</p>'}</td>
  <td>${r.file ? `<img loading="lazy" src="${escapeHtml(r.file)}" alt="${escapeHtml(r.key)}, this wave">` : '<p class="muted">no shot</p>'}</td>
  <td>${cell(r)}</td>
</tr>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Clean and smooth · ${escapeHtml(wave)}</title>
<style>
  :root{color-scheme:light dark;font:14px/1.45 system-ui,sans-serif}
  body{margin:0 auto;max-width:1600px;padding:16px}
  table{border-collapse:collapse;width:100%} th,td{vertical-align:top;text-align:left;padding:8px;border-top:1px solid #8884}
  th{width:14rem} td img{max-width:100%;max-height:640px;border:1px solid #8884}
  ul{margin:0;padding-left:1rem} code{font-size:12px} .muted{opacity:.65} .err{color:#b42318}
  .up{color:#b42318} .down{color:#067647} .why{margin:.4rem 0 0;font-size:12px;opacity:.85}
  .checks li{margin:.2rem 0} .transcript{display:flex;gap:8px;overflow-x:auto} .transcript img{height:360px}
</style></head><body>
<h1>Clean and smooth — wave ${escapeHtml(wave)}${commit ? ` <small class="muted">(${escapeHtml(commit)})</small>` : ''}</h1>
<p>Read each shot against the previous wave's (left). The probe's numbers are on the right; the checks below need eyes.
File each finding as <b>screen · element · file:line · check · before → after</b>, to the owner of that file in the next slot.</p>
${reportRuns && Object.keys(reportRuns).length ? `<p class="muted">Numbers from clutter-report.json, measured ${Object.entries(reportRuns).map(([k, at]) => `${escapeHtml(k)} ${escapeHtml(at)}`).join(' · ')}.</p>` : ''}
<ul class="checks">${EYE_CHECKS.map(([id, name, ask]) => `<li><b>${id} ${escapeHtml(name)}.</b> ${escapeHtml(ask)}</li>`).join('')}</ul>
<table><thead><tr><th>Scene</th><th>Previous wave</th><th>This wave</th><th>Numbers</th></tr></thead><tbody>
${rows.map(row).join('\n')}
</tbody></table>
${transcripts.length ? `<h2>Director transcript, screen by screen (C7)</h2>${transcripts.map((t) => `<h3>${escapeHtml(t.key)} · ${t.files.length} screen(s)</h3><div class="transcript">${t.files.map((f) => `<img loading="lazy" src="${escapeHtml(f)}" alt="${escapeHtml(f)}">`).join('')}</div>`).join('\n')}` : ''}
</body></html>
`;
};

// ── The run ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const QA_ARTIFACTS = path.resolve(APP, process.env.QA_ARTIFACTS || 'node_modules/.cache/comic-qa');
const PORT = Number(process.env.QA_PORT || 4182);
const BASE = `http://127.0.0.1:${PORT}`;
// vite through its own entry with this Node (not npx: a killed npx wrapper leaves the preview server running).
const VITE = path.join(APP, 'node_modules', 'vite', 'bin', 'vite.js');
const env = {
  ...process.env,
  VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co',
  VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY || 'placeholder-anon-key',
  QA_ARTIFACTS_RESOLVED: QA_ARTIFACTS
};

const log = (s) => process.stdout.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...args) => spawnSync('git', args, { cwd: APP, encoding: 'utf8' }).stdout?.trim() || null;

/** The Chromium to launch (playwright.config.ts's rule): QA_CHROMIUM_PATH, else a build under PLAYWRIGHT_BROWSERS_PATH when the pinned one is missing. */
const chromiumExecutable = () => {
  if (process.env.QA_CHROMIUM_PATH) return process.env.QA_CHROMIUM_PATH;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return undefined;
  let expected;
  try {
    const browsers = JSON.parse(fs.readFileSync(path.resolve(APP, 'node_modules/playwright-core/browsers.json'), 'utf8'));
    const rev = browsers.browsers.find((b) => b.name === 'chromium')?.revision;
    expected = rev ? path.join(root, `chromium-${rev}`) : undefined;
  } catch {
    expected = undefined;
  }
  if (expected && fs.existsSync(expected)) return undefined;
  const candidates = [path.join(root, 'chromium')];
  for (const dir of fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) candidates.push(path.join(root, dir, 'chrome-linux', 'chrome'), path.join(root, dir, 'chrome-linux64', 'chrome'));
  return candidates.find((c) => fs.existsSync(c));
};

const importTs = async (rel) => {
  const file = path.join(APP, rel);
  try {
    return await import(pathToFileURL(file).href);
  } catch (e) {
    const hint = process.features?.typescript ? '' : ' (this Node cannot import TypeScript: use Node ≥ 22.18, or `npx tsx scripts/design/declutter-shots.mjs`)';
    throw new Error(`cannot load ${rel}${hint}: ${e?.message || e}`);
  }
};

const buildQa = (dist) => {
  const t0 = Date.now();
  log(`▶ QA build (QA_BUILD=1 vite build → ${path.relative(APP, dist)})`);
  const res = spawnSync(process.execPath, [VITE, 'build', '--outDir', dist, '--emptyOutDir'], { cwd: APP, stdio: 'inherit', env: { ...env, QA_BUILD: '1' } });
  log(`  build: exit ${res.status ?? res.signal} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (res.status !== 0) process.exit(res.status ?? 1);
};

const startServer = async (dist) => {
  const child = spawn(process.execPath, [VITE, 'preview', '--outDir', dist, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: APP, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += String(d);
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite preview exited (${child.exitCode}): ${stderr.slice(0, 400)}`);
    try {
      const res = await fetch(`${BASE}/qa/comic-qa.html`);
      if (res.ok) return child;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  child.kill();
  throw new Error(`vite preview did not answer on ${BASE} within 60 s: ${stderr.slice(0, 400)}`);
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

/** Open a harness URL and wait for it to be ready (helpers/harness.ts's open(), without its device emulation). */
const openScene = async (page, url) => {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('html[data-qa-ready]', { state: 'attached', timeout: 45_000 });
  const crash = await page.evaluate(() => document.querySelector('[data-qa-crash]')?.getAttribute('data-qa-crash') ?? null);
  if (crash) throw new Error(`QA surface crashed: ${crash}`);
  await page.evaluate(() => document.fonts?.ready.then(() => undefined));
  await sleep(400);
};

/** The conversation's scroll container (helpers/scenes.ts markConversationScroller), marked for this run. */
const markTranscript = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('section[aria-label="Conversation"]');
    if (!root) return null;
    const el = [root, ...Array.from(root.querySelectorAll('*'))].find((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 4);
    if (!el) return null;
    el.setAttribute('data-qa-scroller', 'conversation');
    return { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });

const main = async () => {
  const probe = await importTs('tests/e2e/helpers/clutterProbe.ts');
  const { DECLUTTER_SCENES, DECLUTTER_VIEWS, CLUTTER_METRICS, declutterUrl, sceneKey, readClutterBaseline, clutterHint } = probe;

  const commit = git('rev-parse', '--short', 'HEAD');
  const wave = opt('--wave', commit || new Date().toISOString().slice(0, 10));
  const OUT = path.resolve(APP, opt('--out', path.join(QA_ARTIFACTS, 'declutter', wave)));
  const previousDir = opt('--previous', null) ? path.resolve(APP, opt('--previous')) : null;
  const reportFile = path.resolve(APP, opt('--report', path.join(QA_ARTIFACTS, 'declutter', 'clutter-report.json')));
  const maxFrames = Math.max(1, Number(opt('--frames', 30)) || 30);
  const only = opt('--only', '').split(',').map((o) => o.trim()).filter(Boolean);
  const plan = planOnly(only, DECLUTTER_SCENES.map((s) => s.id), { app: !has('--no-app'), transcript: !has('--no-transcript') });
  const views = planViews(DECLUTTER_VIEWS, { view: opt('--view', null), theme: opt('--theme', null) });
  const scenes = DECLUTTER_SCENES.filter((s) => plan.scenes.includes(s.id));

  let dist = opt('--dist', null) ? path.resolve(APP, opt('--dist')) : path.join(QA_ARTIFACTS, 'declutter', 'dist-qa');
  if (!opt('--dist', null) && !has('--no-build')) buildQa(dist);
  if (!fs.existsSync(path.join(dist, 'qa', 'comic-qa.html'))) throw new Error(`${path.join(dist, 'qa', 'comic-qa.html')} is missing: build it (drop --no-build / --dist).`);

  const { qaImageBytes, QA_IMAGE_RE } = await importTs('tests/e2e/fixtures/genImages.ts');
  const pw = await import('playwright').catch(() => import('@playwright/test'));
  const executablePath = chromiumExecutable();
  fs.mkdirSync(path.join(OUT, 'transcript'), { recursive: true });

  const server = await startServer(dist);
  let browser = null;
  const shots = [];
  const transcripts = [];
  const problems = [];
  try {
    // Inside the try: a browser that fails to launch must not leave the preview server running.
    browser = await pw.chromium.launch(executablePath ? { executablePath } : {});
    for (const { view, themes } of views) {
      for (const theme of themes) {
        const context = await browser.newContext({
          baseURL: BASE,
          viewport: { width: view.width, height: view.height },
          deviceScaleFactor: 1,
          isMobile: view.phone,
          hasTouch: view.phone,
          colorScheme: theme,
          reducedMotion: 'reduce',
          serviceWorkers: 'block',
          locale: 'en-US',
          timezoneId: 'UTC'
        });
        await context.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
          if (url.origin === BASE) {
            if (QA_IMAGE_RE.test(url.pathname)) {
              const bytes = qaImageBytes(url.pathname);
              if (!bytes) return route.fulfill({ status: 404, body: 'not a fixture image' });
              return route.fulfill({ status: 200, contentType: 'image/png', body: await bytes, headers: { 'Cache-Control': 'max-age=3600' } });
            }
            return route.continue();
          }
          return route.abort('blockedbyclient');
        });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 300)));

        const shoot = async (key, q, note, board) => {
          const url = declutterUrl(q, theme, { still: '1' });
          const entry = { key, url, note, view: view.id, theme, file: null, error: null };
          try {
            await openScene(page, url);
            if (board && view.phone) {
              const nav = page.locator('[data-nav="board"]').first();
              if (await nav.isVisible().catch(() => false)) {
                await nav.click();
                await sleep(350);
              }
            }
            await page.screenshot({ path: path.join(OUT, shotName(key)), animations: 'disabled', caret: 'hide' });
            entry.file = shotName(key);
            log(`  ✓ ${entry.file}`);
          } catch (e) {
            entry.error = String(e?.message || e).slice(0, 300);
            problems.push(`${key}: ${entry.error}`);
            log(`  × ${key}: ${entry.error}`);
          }
          if (errors.length) entry.pageErrors = errors.splice(0);
          shots.push(entry);
        };

        for (const scene of scenes) await shoot(sceneKey(scene.id, view.id, theme), scene.q, scene.note, scene.phoneBoard);

        if (plan.app) {
          try {
            await openScene(page, declutterUrl({ surface: 'app' }, theme, { still: '1' }));
            const appScenes = await page.evaluate(() => window.__QA_APP_SCENES__ || []);
            for (const { id, title } of appScenes) {
              if (plan.appIds && !plan.appIds.includes(id)) continue;
              await shoot(sceneKey(`app-${id}`, view.id, theme), { surface: 'app', scene: id }, title || 'app scene', false);
            }
            const missing = (plan.appIds ?? []).filter((id) => !appScenes.some((a) => a.id === id));
            if (missing.length) problems.push(`--only: no app scene ${missing.map((id) => `app-${id}`).join(', ')} (${view.id}-${theme}; the index has ${appScenes.map((a) => `app-${a.id}`).join(', ') || 'none'})`);
          } catch (e) {
            problems.push(`app scene index (${view.id}-${theme}): ${e?.message || e}`);
          }
        }

        // The Director transcript of heist-12p, screen by screen, oldest first (C7: past is small).
        if (plan.transcript) {
          const key = `transcript@${view.id}-${theme}`;
          try {
            await openScene(page, declutterUrl({ surface: 'studio', fixture: 'heist-12p', tab: 'pages' }, theme, { still: '1' }));
            const box = await markTranscript(page);
            if (!box) throw new Error('no scrolling conversation found');
            const files = [];
            for (const [n, y] of transcriptOffsets(box.scrollHeight, box.clientHeight, maxFrames).entries()) {
              await page.evaluate((top) => {
                const el = document.querySelector('[data-qa-scroller="conversation"]');
                if (el) el.scrollTop = top;
              }, y);
              await sleep(120);
              const file = transcriptName(view.id, theme, n);
              await page.screenshot({ path: path.join(OUT, file), animations: 'disabled', caret: 'hide' });
              files.push(file);
            }
            transcripts.push({ key, files, scrollHeight: box.scrollHeight, clientHeight: box.clientHeight });
            log(`  ✓ ${key}: ${files.length} screen(s)`);
          } catch (e) {
            problems.push(`${key}: ${e?.message || e}`);
            log(`  × ${key}: ${e?.message || e}`);
          }
        }
        await context.close();
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
    server.kill();
  }

  const reportJson = readJson(reportFile);
  const report = reportJson?.scenes ?? {};
  const previous = previousDir ? readJson(path.join(previousDir, 'index.json')) : null;
  if (previousDir && !previous) log(`! --previous ${previousDir} has no index.json: the sheet shows this wave alone`);
  const { scenes: baseline } = readClutterBaseline();
  const rows = reviewRows({ shots, report, previous, baseline, metrics: CLUTTER_METRICS });
  const hints = Object.fromEntries(CLUTTER_METRICS.map((m) => [m, clutterHint(m)]));
  const manifest = {
    generatedAt: new Date().toISOString(),
    wave,
    commit,
    out: OUT,
    report: fs.existsSync(reportFile) ? reportFile : null,
    previous: previousDir,
    shots: rows.map(({ detail, ...r }) => r),
    transcripts
  };
  fs.writeFileSync(path.join(OUT, 'index.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  fs.writeFileSync(path.join(OUT, 'index.html'), renderIndexHtml({ wave, commit, rows, previousDir, outDir: OUT, metrics: CLUTTER_METRICS, transcripts, hints, reportRuns: reportJson?.runs ?? null }));
  log(`\n${shots.filter((s) => s.file).length} shot(s), ${transcripts.reduce((n, t) => n + t.files.length, 0)} transcript screen(s) in ${OUT}`);
  log(`  review sheet: ${path.join(OUT, 'index.html')}`);
  if (!manifest.report) log(`! no ratchet report at ${reportFile}: run tests/e2e/declutter.spec.ts first for the numbers`);
  if (problems.length) {
    log(`\n${problems.length} problem(s):`);
    for (const p of problems) log(`  - ${p}`);
    process.exit(1);
  }
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e?.stack || e);
    process.exit(1);
  });
}
