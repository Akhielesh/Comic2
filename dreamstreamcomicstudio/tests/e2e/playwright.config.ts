// Comic Studio layout & device harness (P1-QA): ONE Playwright harness for mobile.md §10.2–§10.6 and
// visualqa.md §7.
//
//   npm run qa:build                         QA_BUILD=1 vite build --outDir dist-qa (the QA entry)
//   npx playwright test -c tests/e2e/playwright.config.ts                      full device matrix
//   npx playwright test -c tests/e2e/playwright.config.ts --project='smoke-*'  per-PR layout smoke
//   npx playwright test -c tests/e2e/playwright.config.ts --grep @app          the app scenes only (DS-1b)
//   node scripts/layout-smoke.mjs                                              build + smoke + summary
//
// Target: `vite preview` of dist-qa/ (qa/comic-qa.html), never production — the agent gate 302s
// headless browsers, the studio needs auth and a live backend, and tests must be deterministic and
// free. Fixture images are generated with sharp at global setup (fixtures/genImages.ts); the page
// itself makes no network requests (see qa/ComicQaApp.tsx).
//
// Environment:
//   QA_BASE_URL       use an already-running server (skips webServer)
//   QA_OUT_DIR        the built QA folder (default dist-qa/ when built, else <QA_ARTIFACTS>/dist-qa)
//   QA_ARTIFACTS      report/test-results/fixture cache root (default node_modules/.cache/comic-qa)
//   QA_CHROMIUM_PATH  a Chromium binary when the pinned Playwright build is not installed
//   QA_WEBKIT=1       run the iOS/iPadOS projects on WebKit (needs `playwright install webkit`)
//   QA_SCREENSHOTS=1  also compare toHaveScreenshot baselines (__screenshots__/<project>/; CI-generated)
//   QA_WORKERS        parallel workers (default 2 — the CI runner has 4 cores)
//   QA_PORT           the preview port (default 4179; pick another when several checkouts share a machine)
//   QA_SKIN=atlas     every harness URL asks for the page-level Atlas skin (helpers/harness.ts), any project
//   QA_THEME=dark     every harness URL asks for the dark theme, any project

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type PlaywrightTestConfig, type Project, type ReporterDescription } from '@playwright/test';
import { APP_SMOKE_DEVICES, COMIC_DEVICES, REFLOW_320, SMOKE_VIEWPORTS, type ComicDevice } from './devices';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '../..');
const CI = !!process.env.CI;
const PORT = Number(process.env.QA_PORT || 4179);
const ARTIFACTS = path.resolve(APP, process.env.QA_ARTIFACTS || 'node_modules/.cache/comic-qa');
// The built QA folder: QA_OUT_DIR, else dist-qa/ (`npm run qa:build`), else the cache folder that
// scripts/layout-smoke.mjs builds into (kept out of the source tree so tsc/vitest never see a bundle).
const OUT_DIR = path.resolve(
  APP,
  process.env.QA_OUT_DIR || (fs.existsSync(path.resolve(APP, 'dist-qa/qa/comic-qa.html')) ? 'dist-qa' : path.join(path.relative(APP, ARTIFACTS), 'dist-qa'))
);
const BASE_URL = process.env.QA_BASE_URL || `http://127.0.0.1:${PORT}`;
process.env.QA_ARTIFACTS_RESOLVED = ARTIFACTS;
process.env.QA_OUT_DIR_RESOLVED = OUT_DIR;

/**
 * The Chromium to launch. CI installs the build the pinned @playwright/test expects. Locally (and in
 * sandboxes with a pre-provisioned browser) an explicit QA_CHROMIUM_PATH wins, then a Chromium found
 * under PLAYWRIGHT_BROWSERS_PATH when the expected build is missing. Never downloads anything.
 */
const chromiumExecutable = (): string | undefined => {
  if (process.env.QA_CHROMIUM_PATH) return process.env.QA_CHROMIUM_PATH;
  if (CI) return undefined;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return undefined;
  let expected: string | undefined;
  try {
    const browsers = JSON.parse(fs.readFileSync(path.resolve(APP, 'node_modules/playwright-core/browsers.json'), 'utf8')) as { browsers: { name: string; revision: string }[] };
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
const CHROMIUM = chromiumExecutable();

const projectFor = (d: ComicDevice, extra: Partial<Project> = {}): Project => {
  const webkit = d.engine === 'webkit' && process.env.QA_WEBKIT === '1';
  return {
    name: d.name,
    metadata: { device: d.name, engine: webkit ? 'webkit' : 'chromium', emulates: d.engine, ...(d.look ? { look: d.look } : {}) },
    use: {
      browserName: webkit ? 'webkit' : 'chromium',
      viewport: d.viewport,
      ...(d.screen ? { screen: d.screen } : {}),
      deviceScaleFactor: d.deviceScaleFactor,
      isMobile: d.isMobile,
      hasTouch: d.hasTouch,
      ...(d.userAgent ? { userAgent: d.userAgent } : {}),
      // DS-1b looks: the OS preferences a dark or motion-on project emulates (the skin is a URL param, harness.ts).
      ...(d.look?.theme === 'dark' ? { colorScheme: 'dark' as const } : {}),
      ...(d.look?.motion === 'on' ? { reducedMotion: 'no-preference' as const } : {}),
      ...(!webkit && CHROMIUM ? { launchOptions: { executablePath: CHROMIUM } } : {})
    },
    ...extra
  };
};

const DEVICE_SPECS = /(studio|editor|reader|public|shared|kit|a11y|pwa|perf)\.[a-z.]*spec\.ts$/;
/** The layout smoke, the component scenes (qa/KitScenes.tsx) and the model picker scenes. */
const SMOKE_SPECS = /(layout\.smoke|kit\.scenes|models\.picker)\.spec\.ts$/;

const config: PlaywrightTestConfig = {
  testDir: HERE,
  testMatch: /.*\.spec\.ts$/,
  outputDir: path.join(ARTIFACTS, 'test-results'),
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: Number(process.env.QA_WORKERS || 2),
  timeout: 90_000,
  expect: { timeout: 10_000, toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide' } },
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(ARTIFACTS, 'report'), open: 'never' }],
    ['json', { outputFile: path.join(ARTIFACTS, 'results.json') }],
    ...(CI ? ([['github']] satisfies ReporterDescription[]) : [])
  ],
  globalSetup: path.join(HERE, 'fixtures/genImages.ts'),
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Sheets and pages animate; measuring mid-animation gives false collisions. Specs that test motion opt out.
    reducedMotion: 'reduce',
    colorScheme: 'light',
    serviceWorkers: 'block',
    locale: 'en-US',
    timezoneId: 'UTC'
  },
  projects: [
    // mobile.md §10.2: 14 device projects + WCAG reflow.
    ...COMIC_DEVICES.map((d) => projectFor(d, { testMatch: DEVICE_SPECS })),
    projectFor(REFLOW_320, { testMatch: /(studio\.layout|public\.reader|kit\.scenes|models\.picker|a11y)\.spec\.ts$/ }),
    // visualqa.md §7: the per-PR layout smoke (4 viewports, light) + the component scenes (qa/KitScenes.tsx).
    // (+ the model picker scenes, M1-PICKER-UI: tests/e2e/models.picker.spec.ts.)
    ...SMOKE_VIEWPORTS.map((d) => projectFor(d, { testMatch: SMOKE_SPECS })),
    // DS-1b (master plan §1.4): the page-level Atlas skin (smoke-360x740-atlas) and the OS dark scheme
    // (smoke-1440x900-dark) run the whole smoke over the app scenes AND the studio, kit and model-picker scenes;
    // the 320 px reflow width (smoke-320x640) and motion on run the app scenes (`@app`) only.
    ...APP_SMOKE_DEVICES.map((d) => projectFor(d, d.look?.skin || d.look?.theme ? { testMatch: SMOKE_SPECS } : { testMatch: /layout\.smoke\.spec\.ts$/, grep: /@app\b/ })),
    // Detector + allowlist self-tests (synthetic pages; proves every assertion can actually fail), and the app
    // harness's own probes (tests/e2e/app-harness.selftest.spec.ts).
    { name: 'harness-selftest', testMatch: /(harness|app-harness)\.selftest\.spec\.ts$/, use: { browserName: 'chromium', viewport: { width: 800, height: 600 }, ...(CHROMIUM ? { launchOptions: { executablePath: CHROMIUM } } : {}) } },
    // The clutter ratchet (declutter DC-0; docs/design/clean-and-smooth.md): the probe self-test and every scene at
    // 320, 360 and 1280 px. The spec sets its own viewports, themes and motion.
    { name: 'declutter', testMatch: /declutter\.spec\.ts$/, use: { browserName: 'chromium', ...(CHROMIUM ? { launchOptions: { executablePath: CHROMIUM } } : {}) } },
    // The overflow ratchet (OV-1): the probe self-test and every scene with the long strings injected
    // at 320 light, 360 dark and 1280 light. In layout-smoke's default projects, so it gates every UI pull request.
    { name: 'overflow', testMatch: /(^|\/)overflow\.spec\.ts$/, use: { browserName: 'chromium', ...(CHROMIUM ? { launchOptions: { executablePath: CHROMIUM } } : {}) } }
  ],
  webServer: process.env.QA_BASE_URL
    ? undefined
    : {
        command: `npx vite preview --outDir "${OUT_DIR}" --port ${PORT} --strictPort --host 127.0.0.1`,
        cwd: APP,
        url: `${BASE_URL}/qa/comic-qa.html`,
        reuseExistingServer: !CI,
        timeout: 60_000,
        stdout: 'ignore',
        stderr: 'pipe'
      }
};

export default defineConfig(config);
