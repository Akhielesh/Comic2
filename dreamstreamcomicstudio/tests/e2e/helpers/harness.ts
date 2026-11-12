// Test fixtures for the QA harness (P1-QA): `test` with a `device` and a `qa` driver.
//
//   test('…', async ({ page, device, qa }) => {
//     await qa.open({ surface: 'studio', fixture: 'heist-12p' });
//     await qa.check('studio', 'chat');                  // layout + touch assertions, allowlist-aware
//     const ops = await qa.ops();                        // window.__qaOps
//   });
//
// Looks (DS-1b): a project's `look` (devices.ts: skin=atlas, theme=dark, motion on) or the env vars
// QA_SKIN=atlas / QA_THEME=dark make every open() ask for that skin / theme unless the test names its own;
// projects without a look (and no env) open exactly the URLs they always did. The app surface
// (`surface: 'app'`, qa/app/index.tsx) adds appScenes(), legacyClasses(), duplicateIds(), eachScrollStep() and the
// motion probes (recordMotionStarts() / motionStarts(), animations(), settleAnimations()); tests/e2e/
// app-harness.selftest.spec.ts proves each of them can fail.
//
// Every page gets: fixture images served from fixtures/genImages.ts, every other origin BLOCKED (the
// harness is offline by construction), page errors collected as `console` findings, and the known
// test failures of allowlist.json applied (expected-fail / skip, with the owner package in the title).

import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import { deviceByName, type ComicDevice, type ProjectLook } from '../devices';
import { qaImageBytes, QA_IMAGE_RE } from '../fixtures/genImages';
import { expectLayoutClean, type CleanOptions, type Finding } from './layoutAsserts';
import { knownTestFailure } from './allowlist';
import { emulateHinge, pageSeesSegments, setSafeAreas, stubSegments, type HingeResult } from './safeArea';
import { installVisualViewportStub } from './keyboard';

export { expect };

export type QaQuery = Partial<{
  /** 'app' / 'pro': the app-wide surfaces (DS-1b; qa/app/index.tsx, qa/pro/index.tsx). */
  surface: 'studio' | 'board' | 'editor' | 'reader' | 'classic-reader' | 'public' | 'kit' | 'app' | 'pro';
  /** surface=kit: the component scene (qa/KitScenes.tsx). */
  kit: 'breakdown' | 'refs' | 'refs-drawer' | 'timeline' | 'art' | 'model-picker' | 'model-confirm';
  fixture: 'lake-1p' | 'heist-12p' | 'deep-40p' | 'webtoon-20p' | 'stress' | 'empty' | 'chat-14';
  tab: string;
  page: number;
  lang: string;
  theme: 'light' | 'dark';
  state: string;
  mode: 'easy' | 'pro';
  rtl: boolean;
  public: 'ok' | 'not-found' | 'error' | 'slow';
  img: 'png' | 'svg';
  /** '0': the author turned downloads off (allowDownload=false). */
  download: '0' | '1';
  /** The reader has a share link (endCard.shareUrl). */
  share: boolean;
  still: boolean;
  /** surface=app|pro: the scene id (absent: the scene index). */
  scene: string;
  /** The page-level skin: 'atlas' (html[data-ds-skin], as on the comics host) or 'none' (taken off <html>). */
  skin: 'atlas' | 'none';
}>;

/** One app scene as the harness publishes it (window.__QA_APP_SCENES__). */
export interface AppSceneEntry {
  id: string;
  title: string;
}

/** A legacy kit class found in the rendered DOM. */
export interface LegacyHit {
  token: string;
  sig: string;
  label: string;
}

/** An animation still in effect (document.getAnimations()). */
export interface RunningAnimation {
  name: string;
  target: string;
  /** -1: infinite. */
  iterations: number;
  playState: string;
}

/**
 * The look a project asks for: its device's `look` (devices.ts), else the env (QA_SKIN=atlas, QA_THEME=dark).
 * Pure, for the self-test and the spec.
 */
export const lookFor = (device: ComicDevice, env: Record<string, string | undefined> = process.env): ProjectLook => ({
  ...(env.QA_SKIN === 'atlas' ? { skin: 'atlas' as const } : {}),
  ...(env.QA_THEME === 'dark' ? { theme: 'dark' as const } : {}),
  ...(device.look || {})
});

export interface OpenOptions {
  /** Emulate the device's notch/home-indicator insets (default true on coarse devices). */
  safeArea?: boolean;
  /** Install the iOS visualViewport stand-in (keyboard spec). */
  keyboardStub?: boolean;
  /** Emulate the fold on hinge devices (default true). */
  hinge?: boolean;
  /** Extra time after ready (ms). */
  settle?: number;
}

const DESKTOP: ComicDevice = deviceByName('desktop-1440')!;

export class QaHarness {
  readonly pageErrors: string[] = [];
  hingeResult: HingeResult = { mode: 'none', band: null };
  safeAreaOn = false;
  /** The fixture of the last open() (allowlist entries can be scoped to it). */
  fixture = 'heist-12p';
  /** The project's look (skin / theme / motion) — the defaults of every open(). */
  readonly look: ProjectLook;
  private routed = false;
  private motionRecorder = false;

  constructor(
    readonly page: Page,
    readonly device: ComicDevice,
    readonly testInfo: TestInfo
  ) {
    this.look = lookFor(device);
    page.on('pageerror', (e) => this.pageErrors.push(String(e.message || e).slice(0, 300)));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      // Expected noise: blocked/answered network in the offline harness, React dev hints.
      if (/QA harness|Failed to load resource|net::ERR_|status of 50[0-9]|status of 404|Download the React DevTools/i.test(t)) return;
      this.pageErrors.push(t.slice(0, 300));
    });
  }

  private async route(): Promise<void> {
    if (this.routed) return;
    this.routed = true;
    const base = new URL(this.testInfo.project.use.baseURL || 'http://127.0.0.1:4179');
    await this.page.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.protocol === 'data:' || url.protocol === 'blob:') return route.continue();
      if (url.origin === base.origin) {
        if (QA_IMAGE_RE.test(url.pathname)) {
          const bytes = qaImageBytes(url.pathname);
          if (!bytes) return route.fulfill({ status: 404, body: 'not a fixture image' });
          return route.fulfill({ status: 200, contentType: 'image/png', body: await bytes, headers: { 'Cache-Control': 'max-age=3600' } });
        }
        return route.continue();
      }
      // Offline by construction: fonts, CDNs, Supabase, analytics — nothing leaves the machine.
      return route.abort('blockedbyclient');
    });
  }

  /**
   * Hold every fixture image (`/qa-assets/<seed>-<w>x<h>.png`) for `delay(url)` ms, then hand it to the harness's own
   * route, which serves it. CDP network throttling never sees the harness's fulfilled images, so a spec that needs a
   * slow link delays them here (RD-A #11; reader.turns.spec.ts). The harness route is registered first and this
   * handler after it: Playwright runs the newest handler first, and route.fallback() passes the request on.
   */
  async delayImages(delay: (url: URL) => number): Promise<void> {
    await this.route();
    await this.page.route(/\/qa-assets\/.*\.png$/, async (route) => {
      const ms = Math.max(0, delay(new URL(route.request().url())));
      if (ms > 0) await new Promise((r) => setTimeout(r, ms));
      await route.fallback();
    });
  }

  /** Open the QA entry with these query parameters and wait until it is ready. */
  async open(q: QaQuery = {}, opts: OpenOptions = {}): Promise<void> {
    await this.route();
    if (opts.keyboardStub) await installVisualViewportStub(this.page);
    if (opts.hinge !== false && this.device.hinge && this.hingeResult.mode === 'none') this.hingeResult = await emulateHinge(this.page, this.device);
    const params = new URLSearchParams();
    // The project's look first, then the test's own query: a test that names a theme or skin keeps it.
    const look: QaQuery = { ...(this.look.theme ? { theme: this.look.theme } : {}), ...(this.look.skin ? { skin: this.look.skin } : {}) };
    const merged: QaQuery = { still: true, ...look, ...q };
    this.fixture = merged.fixture || 'heist-12p';
    for (const [k, v] of Object.entries(merged)) {
      if (v === undefined || v === null || v === false) continue;
      params.set(k, v === true ? '1' : String(v));
    }
    const url = `/qa/comic-qa.html?${params.toString()}`;
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this.page.waitForSelector('html[data-qa-ready]', { state: 'attached', timeout: 45_000 });
    // The CDP display-feature override is accepted by builds that do not yet expose it to pages
    // (no viewport-segment media queries, no window.viewport.segments): fall back to the shim, once.
    if (this.device.hinge && opts.hinge !== false && this.hingeResult.mode === 'cdp' && this.hingeResult.band && !(await pageSeesSegments(this.page))) {
      await stubSegments(this.page, this.device, this.hingeResult.band);
      this.hingeResult = { mode: 'stub', band: this.hingeResult.band };
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      await this.page.waitForSelector('html[data-qa-ready]', { state: 'attached', timeout: 45_000 });
    }
    if (this.device.hinge && !this.testInfo.annotations.some((a) => a.type === 'hinge')) this.testInfo.annotations.push({ type: 'hinge', description: this.hingeResult.mode });
    const crash = await this.page.evaluate(() => document.querySelector('[data-qa-crash]')?.getAttribute('data-qa-crash') ?? null);
    if (crash) throw new Error(`QA surface crashed: ${crash}`);
    this.safeAreaOn = opts.safeArea ?? this.device.coarse;
    if (this.safeAreaOn) await setSafeAreas(this.page, this.device.safeArea);
    await this.settle(opts.settle ?? 400);
  }

  async settle(ms = 300): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  /** The themes this project measures: the one its look pins, else both. */
  get themes(): Array<'light' | 'dark'> {
    return this.look.theme ? [this.look.theme] : ['light', 'dark'];
  }

  /** surface=app: the scenes the harness discovered (window.__QA_APP_SCENES__) and the scene files it refused. */
  async appScenes(): Promise<{ scenes: AppSceneEntry[]; problems: Array<{ file: string; reason: string }> }> {
    return this.page.evaluate(() => ({ scenes: window.__QA_APP_SCENES__ || [], problems: window.__QA_APP_SCENE_PROBLEMS__ || [] }));
  }

  /**
   * The page's widths. On an `isMobile` project Chromium widens the layout viewport to fit content that overflows
   * it (up to 4× the device width), so `innerWidth` grows WITH the overflow and the scanner's `overflow` check
   * (scrollWidth vs innerWidth) cannot see it there; compare `scrollWidth` with the project's viewport instead.
   */
  async pageWidths(): Promise<{ scrollWidth: number; innerWidth: number; clientWidth: number; visualWidth: number; scale: number }> {
    return this.page.evaluate(() => ({
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      innerWidth: window.innerWidth,
      clientWidth: document.documentElement.clientWidth,
      visualWidth: Math.round(window.visualViewport?.width ?? window.innerWidth),
      scale: Number((window.visualViewport?.scale ?? 1).toFixed(3))
    }));
  }

  /**
   * Record every motion START in each document from the next navigation on (an init script, so it sees the first
   * frame): CSS animations that run for longer than 0 s (`animationstart`), CSS transitions (`transitionrun`) and
   * `Element.animate()` calls with a duration. Under reduced motion the smoke expects none, so an entrance that
   * ignores the preference fails even when it has ended by the time the page is measured. Call before open().
   */
  async recordMotionStarts(): Promise<void> {
    if (this.motionRecorder) return;
    this.motionRecorder = true;
    await this.page.addInitScript(() => {
      const w = window as unknown as { __qaMotionStarts?: string[] };
      const log: string[] = [];
      w.__qaMotionStarts = log;
      const push = (entry: string) => {
        if (log.length < 50) log.push(entry);
      };
      const label = (t: EventTarget | null, pseudo = '') => {
        if (!(t instanceof Element)) return '';
        const cls = (t.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 4).join('.');
        return `${t.tagName.toLowerCase()}${cls ? '.' + cls : ''}${pseudo}`.slice(0, 120);
      };
      const ms = (v: string) => (v.trim().endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000) || 0;
      // The computed duration of the named animation (a 0 s animation, e.g. a motion token collapsed to 0ms, moves nothing).
      const animationMs = (el: Element, name: string, pseudo: string) => {
        const cs = getComputedStyle(el, pseudo || null);
        const names = cs.animationName.split(',').map((n) => n.trim());
        const durations = cs.animationDuration.split(',');
        const i = names.indexOf(name);
        return i < 0 ? NaN : ms(durations[i % durations.length] || '0s');
      };
      document.addEventListener(
        'animationstart',
        (e) => {
          const a = e as AnimationEvent;
          const d = a.target instanceof Element ? animationMs(a.target, a.animationName, a.pseudoElement) : NaN;
          if (d === 0) return;
          push(`animation ${a.animationName}${Number.isFinite(d) ? ` ${Math.round(d)}ms` : ''} on ${label(a.target, a.pseudoElement)}`);
        },
        true
      );
      document.addEventListener('transitionrun', (e) => push(`transition ${(e as TransitionEvent).propertyName} on ${label(e.target, (e as TransitionEvent).pseudoElement)}`), true);
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (this: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes | null, options?: number | KeyframeAnimationOptions) {
        const d = typeof options === 'number' ? options : Number(options?.duration ?? 0) || 0;
        if (d > 0) push(`animate() ${Math.round(d)}ms on ${label(this)}`);
        return animate.call(this, keyframes, options);
      };
    });
  }

  /** The motion recordMotionStarts() saw in the current document; null when the recorder is not installed. */
  async motionStarts(): Promise<string[] | null> {
    return this.page.evaluate(() => (window as unknown as { __qaMotionStarts?: string[] }).__qaMotionStarts?.slice() ?? null);
  }

  /** Ids that more than one element carries: a `<label for>` or `aria-labelledby` then names the first one only. */
  async duplicateIds(): Promise<string[]> {
    return this.page.evaluate(() => {
      const seen = new Set<string>();
      const dup = new Set<string>();
      for (const el of Array.from(document.querySelectorAll('[id]'))) {
        if (!el.id) continue;
        if (seen.has(el.id)) dup.add(el.id);
        else seen.add(el.id);
      }
      return [...dup];
    });
  }

  /**
   * Walk a page that scrolls the document: scroll down in viewport-tall steps that overlap by `overlap` px and call
   * `at(top)` at each step past the first screen (the caller has measured that one), then scroll back to the top.
   * The detector measures only what is fully on screen, so a control cut by one step's edge lies fully inside the
   * next step (the default overlap is a 44 px target twice over). Returns the scroll tops visited (none when the
   * page fits one screen; a page that scrolls an inner box instead of the document is not walked).
   */
  async eachScrollStep(at: (top: number) => Promise<unknown>, overlap = 88): Promise<number[]> {
    const visited: number[] = [];
    const { height, vh } = await this.page.evaluate(() => ({ height: (document.scrollingElement || document.documentElement).scrollHeight, vh: window.innerHeight }));
    let bottom = vh;
    while (bottom < height - 1) {
      const want = Math.max(0, Math.min(bottom - overlap, height - vh));
      const top = await this.page.evaluate((y) => {
        window.scrollTo({ top: y, left: 0, behavior: 'instant' as ScrollBehavior });
        return Math.round(window.scrollY);
      }, want);
      if (top + vh <= bottom) break; // the document would not scroll any further
      visited.push(top);
      await this.settle(100);
      await at(top);
      bottom = top + vh;
    }
    if (visited.length) await this.page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior }));
    return visited;
  }

  /** Does the page prefer reduced motion (the project's emulation, as the page sees it)? */
  async prefersReducedMotion(): Promise<boolean> {
    return this.page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  /** Every animation still in effect (CSS animations and transitions, Web Animations). */
  async animations(): Promise<RunningAnimation[]> {
    return this.page.evaluate(() =>
      document.getAnimations().map((a) => {
        const effect = a.effect as KeyframeEffect | null;
        const el = effect?.target ?? null;
        const timing = effect?.getComputedTiming();
        const cls = el ? (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 4).join('.') : '';
        const name = (a as CSSAnimation).animationName || (a as CSSTransition).transitionProperty || a.id || a.constructor.name;
        return {
          name,
          target: el ? `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''}`.slice(0, 120) : '',
          iterations: timing?.iterations === Infinity ? -1 : Number(timing?.iterations ?? 0),
          playState: a.playState
        };
      })
    );
  }

  /**
   * Let the finite animations (entrances) finish, up to `ms`, and return the ones still in effect: infinite loops
   * such as a busy spinner, or anything that outlasted `ms`. The motion-on smoke uses it; under reduced motion the
   * smoke does NOT wait (it checks recordMotionStarts() and animations() as the page opened).
   */
  async settleAnimations(ms = 1500): Promise<RunningAnimation[]> {
    const deadline = Date.now() + ms;
    for (;;) {
      await this.page.evaluate(
        (budget) =>
          Promise.race([
            Promise.all(
              document
                .getAnimations()
                .filter((a) => a.effect?.getComputedTiming().endTime !== Infinity)
                .map((a) => a.finished.catch(() => undefined))
            ),
            new Promise((r) => setTimeout(r, budget))
          ]).then(() => undefined),
        Math.max(0, Math.min(250, deadline - Date.now()))
      );
      const left = await this.animations();
      if (left.length === 0 || Date.now() >= deadline) return left;
      if (left.every((a) => a.iterations === -1)) return left;
      await this.page.waitForTimeout(50);
    }
  }

  /**
   * The legacy kit in the rendered DOM (master plan §1.4; the class-level twin of DS-0's legacyKit guard):
   * border-black (any side), shadow-comic(-hover), font-comic, Tailwind's font-display (Bangers) and any utility
   * on a brand colour, with any variant prefix or opacity. `ds-font-display` (the token face) is not legacy.
   */
  async legacyClasses(): Promise<LegacyHit[]> {
    return this.page.evaluate(() => {
      const LEGACY = /^(?:border-(?:[xytrbl]-)?black|shadow-comic(?:-[a-z]+)?|font-comic|font-display|[a-z]+(?:-[a-z]+)*-brand-(?:yellow|blue|red|black))$/;
      const out: Array<{ token: string; sig: string; label: string }> = [];
      for (const el of Array.from(document.querySelectorAll('[class]'))) {
        const classes = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
        for (const cls of classes) {
          const bare = cls.replace(/^.*:/, '').replace(/^!/, '').replace(/\/(?:\d+|\[[^\]]+\])$/, '');
          if (!LEGACY.test(bare)) continue;
          const label = ((el as HTMLElement).innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
          out.push({ token: cls, sig: `${el.tagName.toLowerCase()}.${classes.slice(0, 6).join('.')}`.slice(0, 160), label });
          if (out.length >= 40) return out;
        }
      }
      return out;
    });
  }

  /** Phones: switch the single-pane shell to the Board view (no-op on split layouts). */
  async toBoard(): Promise<void> {
    const nav = this.page.locator('[data-nav="board"]').first();
    if (await nav.isVisible().catch(() => false)) {
      await nav.click();
      await this.settle(350);
    }
  }

  async toChat(): Promise<void> {
    const nav = this.page.locator('[data-nav="chat"]').first();
    if (await nav.isVisible().catch(() => false)) {
      await nav.click();
      await this.settle(300);
    }
  }

  /** The studio root's data-layout. */
  async layout(): Promise<string | null> {
    return this.page.evaluate(() => document.querySelector('.gesture-root[data-layout]:not([data-testid="immersive-reader"])')?.getAttribute('data-layout') ?? null);
  }

  async ops(): Promise<Array<{ kind: string; payload?: unknown; at: number }>> {
    return this.page.evaluate(() => window.__qaOps || []);
  }

  async clearOps(): Promise<void> {
    await this.page.evaluate(() => {
      window.__qaOps = [];
    });
  }

  /** Scroll an element (selector) to top / mid / bottom. */
  async scroll(selector: string, where: 'top' | 'mid' | 'bottom'): Promise<void> {
    await this.page.evaluate(
      ([sel, w]) => {
        const el = document.querySelector(sel);
        if (!el) return;
        el.scrollTop = w === 'bottom' ? el.scrollHeight : w === 'mid' ? el.scrollHeight / 2 - el.clientHeight / 2 : 0;
      },
      [selector, where] as const
    );
    await this.settle(300);
  }

  /** Layout + touch assertions at this step, triaged against the allowlist (soft). */
  async check(surface: string, scene: string, opts: CleanOptions = {}): Promise<Finding[]> {
    return expectLayoutClean(this.page, this.testInfo, { surface, scene, fixture: this.fixture }, {
      device: this.device,
      safeArea: this.safeAreaOn ? this.device.safeArea : null,
      hinge: this.hingeResult.band,
      pageErrors: this.pageErrors,
      ...opts
    });
  }
}

export const test = base.extend<{ device: ComicDevice; qa: QaHarness; knownIssues: void }>({
  device: async ({}, use, testInfo) => {
    await use(deviceByName(testInfo.project.name) || DESKTOP);
  },
  qa: async ({ page, device }, use, testInfo) => {
    await use(new QaHarness(page, device, testInfo));
  },
  knownIssues: [
    async ({}, use, testInfo) => {
      const title = `${testInfo.file.split(/[\\/]/).pop()} › ${testInfo.titlePath.slice(1).join(' › ')}`;
      const k = knownTestFailure(title, testInfo.project.name);
      if (k) {
        testInfo.annotations.push({ type: `known:${k.owner}`, description: `${k.id}: ${k.reason} (remove by ${k.removeBy || 'wave3'})` });
        if (k.mode === 'skip') testInfo.skip(true, `known (${k.owner}): ${k.reason}`);
        else testInfo.fail(true, `known (${k.owner}): ${k.reason}`);
      }
      await use();
    },
    { auto: true }
  ]
});
