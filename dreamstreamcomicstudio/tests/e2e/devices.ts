// Device projects for the Comic Studio layout & device harness (P1-QA; mobile.md §10.2).
//
// 14 device projects + `reflow-320` (WCAG 1.4.10), built from Playwright's `devices[...]` where one
// exists and custom otherwise, plus the layout-smoke viewports (visualqa.md §7, + 1280) and the app-scene
// matrix (redesign plan §11.3 M2, APP_SCENE_MATRIX). The #10 sweep
// covers widths on desktop Chromium; these add ENGINES, TOUCH, DPR and ORIENTATION.
//
// Engines: CI installs Chromium only (fast, free), so every project runs on Chromium by default and
// the iOS/iPadOS projects emulate the device (viewport, DPR, touch, UA). Set QA_WEBKIT=1 (after
// `npx playwright install --with-deps webkit`) to run the iOS/iPadOS projects on real WebKit.

import { devices as pwDevices } from '@playwright/test';

export type Engine = 'chromium' | 'webkit';
export type Os = 'android' | 'ios' | 'desktop';
export type ExpectedLayout = 'single' | 'single-rail' | 'split' | 'dual-screen';

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/**
 * How a project looks beyond its device (DS-1b, master plan §1.4): the page-level skin, the theme and motion.
 * The harness (helpers/harness.ts) asks every URL for this look unless a test names its own, and
 * playwright.config.ts emulates the matching OS preferences. Absent: the default projects' look (no page-level
 * skin, light, reduced motion).
 */
export interface ProjectLook {
  /** `skin=atlas` on every harness URL: html[data-ds-skin="atlas"], exactly as the comics host boots it. */
  skin?: 'atlas';
  /** `theme=dark` on every harness URL, and the OS colour scheme is dark (`colorScheme: 'dark'`). */
  theme?: 'dark';
  /** 'on': prefers-reduced-motion is no-preference (every other project reduces motion). */
  motion?: 'on';
}

export interface ComicDevice {
  name: string;
  /** The engine mobile.md asks for; the project uses it only when QA_WEBKIT=1 (see header). */
  engine: Engine;
  os: Os;
  viewport: { width: number; height: number };
  screen?: { width: number; height: number };
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  userAgent?: string;
  /** Phone or tablet: coarse pointer (44 px targets, no hover-only controls). */
  coarse: boolean;
  kind: 'phone' | 'tablet' | 'desktop' | 'foldable';
  /** The studio layout this device must get (data-layout on the shell root; mobile.md §3, split from 720). */
  layout: ExpectedLayout;
  /** Notch / home-indicator insets to emulate (mobile.md §10.3.4). */
  safeArea: Insets;
  /** fold5-dual: the hinge between two side-by-side segments (CDP display-feature override). */
  hinge?: { offset: number; maskLength: number };
  notes?: string;
  /** DS-1b: the look the project runs in (skin / theme / motion); absent for every device project. */
  look?: ProjectLook;
}

const NONE: Insets = { top: 0, right: 0, bottom: 0, left: 0 };
const IPHONE_PORTRAIT: Insets = { top: 59, right: 0, bottom: 34, left: 0 };
const IPHONE_LANDSCAPE: Insets = { top: 0, right: 59, bottom: 21, left: 59 };
const ANDROID_PORTRAIT: Insets = { top: 24, right: 0, bottom: 16, left: 0 };
const IPAD: Insets = { top: 24, right: 0, bottom: 20, left: 0 };

const PIXEL_8_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const FOLD5_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-F946B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const IPAD_UA =
  'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const fromPw = (name: string) => {
  const d = pwDevices[name];
  if (!d) throw new Error(`Playwright has no device descriptor "${name}"`);
  return d;
};

const se = fromPw('iPhone SE');
const i15 = fromPw('iPhone 15');
const i15l = fromPw('iPhone 15 landscape');
const s8 = fromPw('Galaxy S8');

/** The 14 device projects of mobile.md §10.2 (order = report order). */
export const COMIC_DEVICES: ComicDevice[] = [
  {
    name: 'galaxy-s8-360',
    engine: 'chromium',
    os: 'android',
    viewport: { width: 360, height: 740 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: s8.userAgent,
    coarse: true,
    kind: 'phone',
    layout: 'single',
    safeArea: ANDROID_PORTRAIT,
    notes: 'smallest common Android'
  },
  {
    name: 'iphone-se',
    engine: 'webkit',
    os: 'ios',
    // iPhone SE 2nd/3rd gen (Playwright's 'iPhone SE' descriptor is the 320×568 first generation).
    viewport: { width: 375, height: 667 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: se.userAgent,
    coarse: true,
    kind: 'phone',
    layout: 'single',
    safeArea: { top: 20, right: 0, bottom: 0, left: 0 }
  },
  {
    name: 'iphone-15',
    engine: 'webkit',
    os: 'ios',
    viewport: i15.viewport,
    screen: { width: 393, height: 852 },
    deviceScaleFactor: i15.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    userAgent: i15.userAgent,
    coarse: true,
    kind: 'phone',
    layout: 'single',
    safeArea: IPHONE_PORTRAIT
  },
  {
    name: 'iphone-15-landscape',
    engine: 'webkit',
    os: 'ios',
    viewport: i15l.viewport,
    screen: { width: 852, height: 393 },
    deviceScaleFactor: i15l.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
    userAgent: i15l.userAgent,
    coarse: true,
    kind: 'phone',
    layout: 'single-rail',
    safeArea: IPHONE_LANDSCAPE
  },
  {
    name: 'pixel-8',
    engine: 'chromium',
    os: 'android',
    viewport: { width: 412, height: 915 },
    screen: { width: 412, height: 915 },
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent: PIXEL_8_UA,
    coarse: true,
    kind: 'phone',
    layout: 'single',
    safeArea: ANDROID_PORTRAIT
  },
  {
    name: 'fold5-folded',
    engine: 'chromium',
    os: 'android',
    viewport: { width: 344, height: 882 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: FOLD5_UA,
    coarse: true,
    kind: 'phone',
    layout: 'single',
    safeArea: ANDROID_PORTRAIT,
    notes: 'Galaxy Z Fold5 cover screen'
  },
  {
    name: 'fold5-unfolded',
    engine: 'chromium',
    os: 'android',
    viewport: { width: 882, height: 1104 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: FOLD5_UA,
    coarse: true,
    kind: 'foldable',
    layout: 'split',
    safeArea: ANDROID_PORTRAIT
  },
  {
    name: 'fold5-dual',
    engine: 'chromium',
    os: 'android',
    viewport: { width: 882, height: 1104 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: FOLD5_UA,
    coarse: true,
    kind: 'foldable',
    layout: 'dual-screen',
    safeArea: ANDROID_PORTRAIT,
    hinge: { offset: 441, maskLength: 0 },
    notes: 'CDP Emulation.setDisplayFeaturesOverride (vertical fold at 441); stubbed window.viewport.segments when unsupported'
  },
  {
    name: 'ipad-mini-portrait',
    engine: 'webkit',
    os: 'ios',
    viewport: { width: 744, height: 1133 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: IPAD_UA,
    coarse: true,
    kind: 'tablet',
    layout: 'split',
    safeArea: IPAD
  },
  {
    name: 'ipad-air-portrait',
    engine: 'webkit',
    os: 'ios',
    viewport: { width: 820, height: 1180 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: IPAD_UA,
    coarse: true,
    kind: 'tablet',
    layout: 'split',
    safeArea: IPAD
  },
  {
    name: 'ipad-air-landscape',
    engine: 'webkit',
    os: 'ios',
    viewport: { width: 1180, height: 820 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: IPAD_UA,
    coarse: true,
    kind: 'tablet',
    layout: 'split',
    safeArea: IPAD
  },
  {
    name: 'ipad-pro-13-portrait',
    engine: 'webkit',
    os: 'ios',
    viewport: { width: 1032, height: 1376 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: IPAD_UA,
    coarse: true,
    kind: 'tablet',
    layout: 'split',
    safeArea: IPAD
  },
  {
    name: 'ipad-pro-13-landscape',
    engine: 'webkit',
    os: 'ios',
    viewport: { width: 1376, height: 1032 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: IPAD_UA,
    coarse: true,
    kind: 'tablet',
    layout: 'split',
    safeArea: IPAD
  },
  {
    name: 'desktop-1440',
    engine: 'chromium',
    os: 'desktop',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    coarse: false,
    kind: 'desktop',
    layout: 'split',
    safeArea: NONE,
    notes: 'regression guard (the desktop look stays unchanged)'
  }
];

/** WCAG 1.4.10 reflow: 320 CSS px wide, touch. */
export const REFLOW_320: ComicDevice = {
  name: 'reflow-320',
  engine: 'chromium',
  os: 'android',
  viewport: { width: 320, height: 640 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  userAgent: s8.userAgent,
  coarse: true,
  kind: 'phone',
  layout: 'single',
  safeArea: NONE,
  notes: 'WCAG reflow; assertion 1 (no horizontal overflow) must pass'
};

/** visualqa.md §7 layout-smoke matrix (light theme; Chromium; phones get touch), plus 1280×800 (DS-1b, master plan §1.4). */
export const SMOKE_VIEWPORTS: ComicDevice[] = [
  [360, 740],
  [768, 1024],
  [1024, 768],
  [1280, 800],
  [1440, 900]
].map(([w, h]) => {
  const phone = w < 768;
  return {
    name: `smoke-${w}x${h}`,
    engine: 'chromium' as const,
    os: phone ? ('android' as const) : ('desktop' as const),
    viewport: { width: w, height: h },
    deviceScaleFactor: 1,
    isMobile: phone,
    hasTouch: phone,
    coarse: phone,
    kind: phone ? ('phone' as const) : w < 1200 ? ('tablet' as const) : ('desktop' as const),
    layout: w < 720 ? ('single' as const) : ('split' as const),
    safeArea: NONE
  };
});

const smoke = (name: string): ComicDevice => {
  const d = SMOKE_VIEWPORTS.find((v) => v.name === name);
  if (!d) throw new Error(`no smoke viewport ${name}`);
  return d;
};

const comicDevice = (name: string): ComicDevice => {
  const d = COMIC_DEVICES.find((v) => v.name === name);
  if (!d) throw new Error(`no device ${name}`);
  return d;
};

/**
 * DS-1b (master plan §1.3, §1.4): the smoke under other looks. The smoke viewports above run the app scenes in
 * light and dark; these add the page-level Atlas skin on a phone and the OS dark scheme on a desktop (both run the
 * whole smoke: app, studio, kit and model-picker scenes), and the WCAG reflow width and motion on
 * (prefers-reduced-motion: no-preference, for the entrances), which run the app scenes (`@app`) only
 * (playwright.config.ts). Redesign plan §11.3 M2 adds the rest of the app-scene matrix (`@app` only): the
 * iPhone SE 320×568, the Fold5 book posture (two segments with the hinge) and a phone in landscape, 852×393.
 */
export const APP_SMOKE_DEVICES: ComicDevice[] = [
  { ...REFLOW_320, name: 'smoke-320x640', notes: 'the app scenes at the WCAG reflow width (light and dark)' },
  { ...REFLOW_320, name: 'smoke-320x568', viewport: { width: 320, height: 568 }, notes: 'iPhone SE (1st gen): the shortest phone (M2)' },
  { ...comicDevice('fold5-dual'), name: 'smoke-fold5-dual', notes: 'Fold5 book posture: two 441 px segments with the hinge (M2)' },
  {
    ...comicDevice('iphone-15-landscape'),
    name: 'smoke-852x393',
    viewport: { width: 852, height: 393 },
    screen: { width: 852, height: 393 },
    safeArea: NONE,
    notes: 'a phone in landscape at its full screen, 852×393 (M2): the 393 px height is the squeeze'
  },
  { ...smoke('smoke-360x740'), name: 'smoke-360x740-atlas', look: { skin: 'atlas' }, notes: 'html[data-ds-skin="atlas"], light and dark' },
  { ...smoke('smoke-1440x900'), name: 'smoke-1440x900-dark', look: { theme: 'dark' }, notes: 'colorScheme dark: prefers-color-scheme and the .dark theme' },
  { ...smoke('smoke-1280x800'), name: 'motion-on', look: { motion: 'on' }, notes: 'prefers-reduced-motion: no-preference; entrances run, then the page is measured' }
];

export const ALL_DEVICES: ComicDevice[] = [...COMIC_DEVICES, REFLOW_320, ...SMOKE_VIEWPORTS, ...APP_SMOKE_DEVICES];

/**
 * The app-scene smoke matrix (redesign plan §11.3 M2): every `qa/app/scenes` page at these nine sizes, each in
 * light and dark (one test per theme) under reduced motion (the projects' default). `reflow-320` is the
 * 320×640 WCAG reflow width, run as smoke-320x640. Run it alone with
 * `npx playwright test -c tests/e2e/playwright.config.ts --grep @app` plus these `--project`s.
 */
export const APP_SCENE_MATRIX: readonly string[] = [
  'smoke-320x640',
  'smoke-320x568',
  'smoke-360x740',
  'smoke-768x1024',
  'smoke-1024x768',
  'smoke-1280x800',
  'smoke-1440x900',
  'smoke-fold5-dual',
  'smoke-852x393'
];

export const deviceByName = (name: string): ComicDevice | undefined => ALL_DEVICES.find((d) => d.name === name);

export const isPhone = (d: ComicDevice) => d.kind === 'phone';
export const isTablet = (d: ComicDevice) => d.kind === 'tablet' || d.kind === 'foldable';
