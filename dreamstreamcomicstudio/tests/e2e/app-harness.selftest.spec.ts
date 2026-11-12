// Self-tests for the app-scene probes of the QA harness (DS-1b; tests/e2e/helpers/harness.ts): every probe the
// app smoke (layout.smoke.spec.ts `@app`) relies on must be able to FAIL. Synthetic pages seed one defect each and
// the probe has to report it (and nothing on a clean page). Runs in the `harness-selftest` project only (800×600,
// Chromium, reduced motion as every default project).

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { deviceByName, type ComicDevice } from './devices';
import { lookFor, QaHarness } from './helpers/harness';
import { scanLayout } from './helpers/layoutAsserts';

const BASE_CSS = `<style>*{box-sizing:border-box} body{margin:0;font:16px/1.4 sans-serif} button{font:inherit}</style>`;
const html = (body: string, head = '') => `<!doctype html><html><head><meta name="viewport" content="width=device-width">${BASE_CSS}${head}</head><body>${body}</body></html>`;

const PHONE: ComicDevice = deviceByName('smoke-360x740')!;
const harness = (page: Page, testInfo: TestInfo, device: ComicDevice = PHONE) => new QaHarness(page, device, testInfo);

/** A real navigation (init scripts run on it; page.setContent reuses the document and drops its listeners). */
const SITE = 'http://app-harness.selftest';
const serve = async (page: Page, body: string, head = ''): Promise<void> => {
  await page.route(`${SITE}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html(body, head) }));
  await page.goto(`${SITE}/page`);
};

test.describe('app harness probes', () => {
  test('delayImages: a fixture image waits for its delay, then the harness serves it; others are untouched (RD-A #11)', async ({ page }, testInfo) => {
    const qa = harness(page, testInfo);
    await qa.delayImages((url) => (url.pathname.includes('/qa-assets/slow-') ? 700 : 0));
    // The harness only serves fixture images on the QA origin (the project's baseURL): serve the page there too, after
    // the harness route so this handler answers the page itself.
    const origin = new URL(testInfo.project.use.baseURL || 'http://127.0.0.1:4179').origin;
    await page.route(`${origin}/delay-images`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html('<main>images</main>') }));
    await page.goto(`${origin}/delay-images`);
    const load = (src: string) =>
      page.evaluate(
        (s) =>
          new Promise<{ ms: number; width: number }>((resolve) => {
            const t0 = performance.now();
            const img = new Image();
            img.onload = () => resolve({ ms: performance.now() - t0, width: img.naturalWidth });
            img.onerror = () => resolve({ ms: performance.now() - t0, width: 0 });
            img.src = s;
          }),
        src
      );
    const slow = await load('/qa-assets/slow-120x160.png');
    const fast = await load('/qa-assets/fast-120x160.png');
    expect(slow.width, 'the delayed image is still the harness fixture').toBe(120);
    expect(slow.ms).toBeGreaterThanOrEqual(650);
    expect(fast.width).toBe(120);
    expect(fast.ms).toBeLessThan(650);
  });

  test('legacyClasses: variant, important and opacity forms of the legacy kit; the token face is not legacy', async ({ page }, testInfo) => {
    const qa = harness(page, testInfo);
    await page.setContent(html(`<main><div class="md:shadow-comic hover:border-black/50 bg-brand-yellow/40 md:!font-comic ds-font-display p-2">legacy</div></main>`));
    const hits = await qa.legacyClasses();
    expect(hits.map((h) => h.token)).toEqual(['md:shadow-comic', 'hover:border-black/50', 'bg-brand-yellow/40', 'md:!font-comic']);
    expect(hits.every((h) => h.label === 'legacy')).toBe(true);
    await page.setContent(html(`<main><div class="ds-font-display border-[var(--ds-border)] shadow-sm font-medium bg-[var(--ds-canvas)]">tokens</div></main>`));
    expect(await qa.legacyClasses()).toEqual([]);
  });

  test('animations / settleAnimations: a finite entrance settles, an infinite loop is returned', async ({ page }, testInfo) => {
    const qa = harness(page, testInfo);
    expect(await qa.prefersReducedMotion()).toBe(true);
    const css = `<style>@keyframes x{from{opacity:.2}to{opacity:1}} .loop{animation:x 1s infinite} .once{animation:x 300ms}</style>`;
    await page.setContent(html(`<main><div class="once">entrance</div></main>`, css));
    expect((await qa.animations()).map((a) => a.name)).toEqual(['x']);
    expect(await qa.settleAnimations()).toEqual([]);
    await page.setContent(html(`<main><div class="loop">spinner</div><div class="once">entrance</div></main>`, css));
    const left = await qa.settleAnimations();
    expect(left.map((a) => [a.name, a.iterations, a.target])).toEqual([['x', -1, 'div.loop']]);
  });

  test('phone-content on an app page (M2): a <main> squeezed under 45 % of a phone\'s height is reported, a full one is not', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const scan = () => scanLayout(page, { device: PHONE, checks: ['phone-content'], contentSelector: 'main, [role="main"]' });
    // Chrome eats the top 60 % of the screen and the page content starts below it.
    await page.setContent(html(`<header style="height:450px">chrome</header><main style="min-height:2000px">page</main>`));
    const hits = await scan();
    expect(hits.map((f) => f.check)).toEqual(['phone-content']);
    expect(hits[0].detail).toMatch(/290px = 39% of 740px/);
    await page.setContent(html(`<header style="height:56px">chrome</header><main style="min-height:2000px">page</main>`));
    expect(await scan()).toEqual([]);
    // Off a phone the check is not applied; without a selector it measures the studio panes (none here).
    expect(await scanLayout(page, { device: deviceByName('smoke-1280x800')!, checks: ['phone-content'], contentSelector: 'main' })).toEqual([]);
  });

  test('pageWidths: a 2000 px wide block at a 360 px viewport is horizontal overflow', async ({ page }, testInfo) => {
    const qa = harness(page, testInfo);
    await page.setViewportSize({ width: 360, height: 740 });
    await page.setContent(html(`<main><div style="width:2000px;height:20px">wide</div></main>`));
    expect((await qa.pageWidths()).scrollWidth).toBeGreaterThan(361);
    await page.setContent(html(`<main><div style="width:100%;height:20px">fits</div></main>`));
    expect((await qa.pageWidths()).scrollWidth).toBeLessThanOrEqual(361);
  });

  test('lookFor: the project look wins over the env, the env fills the rest, no look and no env is empty', () => {
    expect(lookFor({ ...PHONE, look: { theme: 'dark' } }, { QA_SKIN: 'atlas' })).toEqual({ skin: 'atlas', theme: 'dark' });
    expect(lookFor({ ...PHONE, look: { skin: 'atlas' } }, { QA_THEME: 'dark' })).toEqual({ skin: 'atlas', theme: 'dark' });
    expect(lookFor({ ...PHONE, look: { motion: 'on' } }, {})).toEqual({ motion: 'on' });
    expect(lookFor(PHONE, { QA_SKIN: 'fun', QA_THEME: 'light' })).toEqual({});
    expect(lookFor(deviceByName('smoke-360x740-atlas')!, {})).toEqual({ skin: 'atlas' });
    expect(lookFor(deviceByName('smoke-1440x900-dark')!, {})).toEqual({ theme: 'dark' });
  });

  test('recordMotionStarts: an entrance that has already ended, a transition and element.animate() are recorded; 0 s animations are not', async ({ page }, testInfo) => {
    const qa = harness(page, testInfo);
    await serve(page, `<main>calm</main>`);
    expect(await qa.motionStarts(), 'not installed: null, never an empty pass').toBeNull();
    await qa.recordMotionStarts();
    await serve(page, `<main><p>calm</p><div class="zero">token collapsed to 0ms</div></main>`, `<style>@keyframes x{from{opacity:.2}to{opacity:1}} .zero{animation:x 0s}</style>`);
    await page.waitForTimeout(100);
    expect(await qa.motionStarts()).toEqual([]);
    await serve(
      page,
      `<main><div class="enter">entrance</div><div id="fade" style="transition:opacity 150ms">fade</div><div id="wa">waapi</div></main>
       <script>
         requestAnimationFrame(() => requestAnimationFrame(() => {
           document.getElementById('fade').style.opacity = '0.5';
           document.getElementById('wa').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120 });
         }));
       </script>`,
      `<style>@keyframes enter{from{transform:translateY(8px)}to{transform:none}} .enter{animation:enter 200ms}</style>`
    );
    await page.waitForTimeout(600);
    // Everything has ended by now: getAnimations() alone would pass this page.
    expect(await qa.animations()).toEqual([]);
    const starts = await qa.motionStarts();
    expect(starts).toEqual(expect.arrayContaining(['animation enter 200ms on div.enter', 'transition opacity on div', 'animate() 120ms on div']));
    expect(starts).toHaveLength(3);
  });

  test('duplicateIds: an id carried twice is reported once', async ({ page }, testInfo) => {
    const qa = harness(page, testInfo);
    await page.setContent(html(`<main aria-labelledby="t"><h1 id="t">Title</h1><label for="t">Title</label><input id="t"><input id="u"><p id="v"></p><p id="v"></p></main>`));
    expect((await qa.duplicateIds()).sort()).toEqual(['t', 'v']);
    await page.setContent(html(`<main aria-labelledby="t"><h1 id="t">Title</h1><label for="f">Title</label><input id="f"></main>`));
    expect(await qa.duplicateIds()).toEqual([]);
  });

  test('eachScrollStep: a small target below the fold, and one cut by a step edge, are measured', async ({ page }, testInfo) => {
    const qa = harness(page, testInfo);
    const vh = page.viewportSize()!.height;
    // "Edge" straddles the first screen's bottom edge; "Deep" sits near the end of a 3000 px page.
    await page.setContent(
      html(`<main style="position:relative;height:3000px">
        <button aria-label="Top ok" style="position:absolute;left:20px;top:20px;width:48px;height:48px">t</button>
        <button aria-label="Edge" style="position:absolute;left:20px;top:${vh - 12}px;width:24px;height:24px">e</button>
        <button aria-label="Deep" style="position:absolute;left:20px;top:2900px;width:24px;height:24px">d</button>
      </main>`)
    );
    expect((await scanLayout(page, { checks: ['hit-target'] })).map((f) => f.label), 'the first screen alone sees neither').toEqual([]);
    const seen: string[] = [];
    const tops = await qa.eachScrollStep(async () => {
      for (const f of await scanLayout(page, { checks: ['hit-target'] })) if (!seen.includes(f.label)) seen.push(f.label);
    });
    expect(seen.sort()).toEqual(['Deep', 'Edge']);
    expect(tops[0]).toBe(vh - 88);
    expect(tops[tops.length - 1]).toBe(3000 - vh);
    for (let i = 1; i < tops.length; i += 1) expect(tops[i] - tops[i - 1], 'consecutive screens overlap').toBeLessThanOrEqual(vh - 88);
    expect(await page.evaluate(() => window.scrollY), 'back at the top').toBe(0);
    // A page that fits one screen is not walked.
    await page.setContent(html(`<main><button style="width:48px;height:48px">ok</button></main>`));
    expect(await qa.eachScrollStep(async () => undefined)).toEqual([]);
  });
});
