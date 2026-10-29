#!/usr/bin/env node
// Atlas skin — visual proof for the owner (docs/design/atlas-skin.md, Phase D0 item 9).
//
// Captures the Comic Studio surfaces with the Atlas skin on, light and dark, at 1440×900 and
// 360×740, from the OFFLINE QA harness (qa/comic-qa.html on synthetic fixtures: no auth, no backend,
// no money, no user data) into node_modules/.cache/comic-qa/atlas-skin/:
//
//   studio   the studio shell (conversation + board at 1440; the conversation on a phone)
//   board    the board pane on the pages tab (what the phone shows behind its board tab)
//   editor   the page editor, page 2
//   reader   the immersive reader, page 2
//   public   the public /c/<slug> reader
//
//   node scripts/design/atlas-skin-shots.mjs [--no-build] [--out <dir>] [--only studio,editor] [--theme light|dark]
//
// Reuses the QA build (QA_BUILD=1 vite build, into <artifacts>/atlas-skin/dist-qa so the layout
// smoke's own bundle is untouched), `vite preview` as the server, the harness's fixture image
// generator (tests/e2e/fixtures/genImages.ts) and its Chromium resolution (QA_CHROMIUM_PATH, then
// PLAYWRIGHT_BROWSERS_PATH; never downloads). Everything that is not same-origin is blocked, exactly
// like the harness. The page is opened with `skin=atlas` (html[data-ds-skin], the comics-host boot
// path), so the shots show the whole page under the skin, fonts included; the studio and reader
// roots carry the attribute regardless (the apex case).
//
// Environment: QA_ARTIFACTS (default node_modules/.cache/comic-qa), QA_PORT (default 4181),
// QA_CHROMIUM_PATH / PLAYWRIGHT_BROWSERS_PATH. Node ≥ 22.18 (type stripping) — or run it with
// `npx tsx scripts/design/atlas-skin-shots.mjs` on an older Node.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const opt = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const QA_ARTIFACTS = path.resolve(APP, process.env.QA_ARTIFACTS || 'node_modules/.cache/comic-qa');
const OUT = path.resolve(APP, opt('--out', path.join(QA_ARTIFACTS, 'atlas-skin')));
const DIST = path.join(QA_ARTIFACTS, 'atlas-skin', 'dist-qa');
const PORT = Number(process.env.QA_PORT || 4181);
const BASE = `http://127.0.0.1:${PORT}`;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const env = {
  ...process.env,
  VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co',
  VITE_SUPABASE_ANON_KEY: process.env.VITE_SUPABASE_ANON_KEY || 'placeholder-anon-key',
  // genImages.ts caches its PNGs under here (shared with the layout smoke: same bytes everywhere).
  QA_ARTIFACTS_RESOLVED: QA_ARTIFACTS
};
process.env.QA_ARTIFACTS_RESOLVED = QA_ARTIFACTS;

// `root`: the scene mounts one of the three skinned roots (studio shell, immersive reader, public
// reader), so the attribute must be there even without the page-level skin. The board pane is a
// pane inside the studio root; on its own it is skinned by html[data-ds-skin] only.
export const SCENES = [
  { id: 'studio', root: true, q: { surface: 'studio', fixture: 'heist-12p' } },
  { id: 'board', root: false, q: { surface: 'board', fixture: 'heist-12p', tab: 'pages' } },
  { id: 'editor', root: true, q: { surface: 'editor', fixture: 'heist-12p', page: 2 } },
  { id: 'reader', root: true, q: { surface: 'reader', fixture: 'heist-12p', page: 2 } },
  { id: 'public', root: true, q: { surface: 'public', fixture: 'heist-12p' } }
];
export const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 360, height: 740 }
];
export const THEMES = ['light', 'dark'];

/** `<scene>-<theme>-<w>x<h>.png` */
export const shotName = (scene, theme, vp) => `${scene}-${theme}-${vp.width}x${vp.height}.png`;

/** The harness URL for a scene: the skin on, still (no idle motion), the theme as a class on <html>. */
export const sceneUrl = (scene, theme) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(scene.q)) params.set(k, String(v));
  params.set('theme', theme);
  params.set('skin', 'atlas');
  params.set('still', '1');
  return `/qa/comic-qa.html?${params.toString()}`;
};

/** The Chromium to launch (playwright.config.ts's rule): QA_CHROMIUM_PATH, else a build under PLAYWRIGHT_BROWSERS_PATH when the pinned one is missing. */
export const chromiumExecutable = () => {
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

const log = (s) => process.stdout.write(`${s}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const buildQa = () => {
  const t0 = Date.now();
  log(`▶ QA build (QA_BUILD=1 vite build → ${path.relative(APP, DIST)})`);
  const res = spawnSync(npx, ['vite', 'build', '--outDir', DIST, '--emptyOutDir'], { cwd: APP, stdio: 'inherit', env: { ...env, QA_BUILD: '1' } });
  log(`  build: exit ${res.status ?? res.signal} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  if (res.status !== 0) process.exit(res.status ?? 1);
};

const startServer = async () => {
  const child = spawn(npx, ['vite', 'preview', '--outDir', DIST, '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: APP, env, stdio: ['ignore', 'ignore', 'pipe'] });
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

/** The harness's fixture images (sharp-rendered, disk-cached), imported from its TypeScript module. */
const loadFixtures = async () => {
  const file = path.join(APP, 'tests/e2e/fixtures/genImages.ts');
  try {
    return await import(pathToFileURL(file).href);
  } catch (e) {
    const hint = process.features?.typescript ? '' : ' (this Node cannot import TypeScript: use Node ≥ 22.18, or `npx tsx scripts/design/atlas-skin-shots.mjs`)';
    throw new Error(`cannot load ${path.relative(APP, file)}${hint}: ${e?.message || e}`);
  }
};

const main = async () => {
  const only = opt('--only', '').split(',').filter(Boolean);
  const themes = THEMES.filter((t) => !opt('--theme') || opt('--theme') === t);
  const scenes = SCENES.filter((s) => !only.length || only.includes(s.id));
  if (!scenes.length) throw new Error(`--only matched no scene (${SCENES.map((s) => s.id).join(', ')})`);

  if (!has('--no-build')) buildQa();
  else if (!fs.existsSync(path.join(DIST, 'qa', 'comic-qa.html'))) throw new Error(`--no-build: ${path.join(DIST, 'qa', 'comic-qa.html')} is missing; run without --no-build first.`);

  const { qaImageBytes, QA_IMAGE_RE } = await loadFixtures();
  const pw = await import('playwright').catch(() => import('@playwright/test'));
  const executablePath = chromiumExecutable();
  fs.mkdirSync(OUT, { recursive: true });

  const server = await startServer();
  const browser = await pw.chromium.launch(executablePath ? { executablePath } : {});
  const shots = [];
  const problems = [];
  try {
    for (const theme of themes) {
      for (const vp of VIEWPORTS) {
        const phone = vp.width < 768;
        const context = await browser.newContext({
          baseURL: BASE,
          viewport: vp,
          deviceScaleFactor: 1,
          isMobile: phone,
          hasTouch: phone,
          colorScheme: theme,
          reducedMotion: 'reduce',
          serviceWorkers: 'block',
          locale: 'en-US',
          timezoneId: 'UTC'
        });
        // Offline by construction (helpers/harness.ts): fixture images from genImages, same-origin
        // continues, every other origin is refused.
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
        for (const scene of scenes) {
          const page = await context.newPage();
          const errors = [];
          page.on('pageerror', (e) => errors.push(String(e.message || e).slice(0, 300)));
          page.on('console', (m) => {
            if (m.type() !== 'error') return;
            const t = m.text();
            if (/QA harness|Failed to load resource|net::ERR_|status of 50[0-9]|status of 404|Download the React DevTools/i.test(t)) return;
            errors.push(t.slice(0, 300));
          });
          const name = shotName(scene.id, theme, vp);
          const url = sceneUrl(scene, theme);
          try {
            await page.goto(url, { waitUntil: 'domcontentloaded' });
            await page.waitForSelector('html[data-qa-ready]', { state: 'attached', timeout: 45_000 });
            const crash = await page.evaluate(() => document.querySelector('[data-qa-crash]')?.getAttribute('data-qa-crash') ?? null);
            if (crash) throw new Error(`QA surface crashed: ${crash}`);
            await page.evaluate(() => document.fonts?.ready);
            await sleep(500);
            const facts = await page.evaluate(() => {
              const root = document.querySelector('[data-ds-skin]:not(html)');
              const cs = getComputedStyle(root ?? document.body);
              return {
                htmlSkin: document.documentElement.getAttribute('data-ds-skin'),
                rootSkin: root?.getAttribute('data-ds-skin') ?? null,
                dark: document.documentElement.classList.contains('dark'),
                fontFamily: cs.fontFamily,
                plexLoaded: !!document.fonts?.check('14px "IBM Plex Sans"'),
                grotesk: !!document.fonts?.check('600 16px "Space Grotesk"'),
                canvas: cs.getPropertyValue('--ds-canvas').trim(),
                ink: cs.getPropertyValue('--ds-ink').trim(),
                accent: cs.getPropertyValue('--ds-accent').trim()
              };
            });
            await page.screenshot({ path: path.join(OUT, name), fullPage: false, animations: 'disabled', caret: 'hide' });
            shots.push({ file: name, scene: scene.id, theme, viewport: `${vp.width}x${vp.height}`, url, ...facts, errors });
            if (facts.htmlSkin !== 'atlas' || (scene.root && facts.rootSkin !== 'atlas')) problems.push(`${name}: skin attribute missing (html=${facts.htmlSkin}, root=${facts.rootSkin})`);
            if (!facts.plexLoaded) problems.push(`${name}: IBM Plex Sans did not load (fontFamily=${facts.fontFamily})`);
            if (errors.length) problems.push(`${name}: ${errors.length} page error(s): ${errors[0]}`);
            log(`  ✓ ${name}  (${facts.accent} on ${facts.canvas}, ${facts.plexLoaded ? 'Plex' : 'NO Plex'})`);
          } catch (e) {
            problems.push(`${name}: ${e?.message || e}`);
            log(`  × ${name}: ${e?.message || e}`);
          } finally {
            await page.close();
          }
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: APP, encoding: 'utf8' }).stdout?.trim() || null,
    skin: 'atlas',
    out: OUT,
    shots
  };
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(manifest, null, 2));
  log(`\n${shots.length} screenshot(s) in ${OUT}:`);
  for (const s of shots) log(`  ${s.file}`);
  log(`  index.json`);
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
