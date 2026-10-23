// Test fixtures for the QA harness (P1-QA): `test` with a `device` and a `qa` driver.
//
//   test('…', async ({ page, device, qa }) => {
//     await qa.open({ surface: 'studio', fixture: 'heist-12p' });
//     await qa.check('studio', 'chat');                  // layout + touch assertions, allowlist-aware
//     const ops = await qa.ops();                        // window.__qaOps
//   });
//
// Every page gets: fixture images served from fixtures/genImages.ts, every other origin BLOCKED (the
// harness is offline by construction), page errors collected as `console` findings, and the known
// test failures of allowlist.json applied (expected-fail / skip, with the owner package in the title).

import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import { deviceByName, type ComicDevice } from '../devices';
import { qaImageBytes, QA_IMAGE_RE } from '../fixtures/genImages';
import { expectLayoutClean, type CleanOptions, type Finding } from './layoutAsserts';
import { knownTestFailure } from './allowlist';
import { emulateHinge, setSafeAreas, type HingeResult } from './safeArea';
import { installVisualViewportStub } from './keyboard';

export { expect };

export type QaQuery = Partial<{
  surface: 'studio' | 'board' | 'editor' | 'reader' | 'classic-reader' | 'public';
  fixture: 'lake-1p' | 'heist-12p' | 'deep-40p' | 'webtoon-20p' | 'stress' | 'empty';
  tab: string;
  page: number;
  lang: string;
  theme: 'light' | 'dark';
  state: string;
  mode: 'easy' | 'pro';
  rtl: boolean;
  public: 'ok' | 'not-found' | 'error' | 'slow';
  img: 'png' | 'svg';
  still: boolean;
}>;

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
  private routed = false;

  constructor(
    readonly page: Page,
    readonly device: ComicDevice,
    readonly testInfo: TestInfo
  ) {
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

  /** Open the QA entry with these query parameters and wait until it is ready. */
  async open(q: QaQuery = {}, opts: OpenOptions = {}): Promise<void> {
    await this.route();
    if (opts.keyboardStub) await installVisualViewportStub(this.page);
    if (opts.hinge !== false && this.device.hinge) this.hingeResult = await emulateHinge(this.page, this.device);
    const params = new URLSearchParams();
    const merged: QaQuery = { still: true, ...q };
    for (const [k, v] of Object.entries(merged)) {
      if (v === undefined || v === null || v === false) continue;
      params.set(k, v === true ? '1' : String(v));
    }
    await this.page.goto(`/qa/comic-qa.html?${params.toString()}`, { waitUntil: 'domcontentloaded' });
    await this.page.waitForSelector('html[data-qa-ready]', { state: 'attached', timeout: 45_000 });
    const crash = await this.page.locator('[data-qa-crash]').first().getAttribute('data-qa-crash').catch(() => null);
    if (crash) throw new Error(`QA surface crashed: ${crash}`);
    this.safeAreaOn = opts.safeArea ?? this.device.coarse;
    if (this.safeAreaOn) await setSafeAreas(this.page, this.device.safeArea);
    await this.settle(opts.settle ?? 400);
  }

  async settle(ms = 300): Promise<void> {
    await this.page.waitForTimeout(ms);
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
    return this.page.locator('.gesture-root[data-layout]').first().getAttribute('data-layout').catch(() => null);
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
    return expectLayoutClean(this.page, this.testInfo, { surface, scene }, {
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
