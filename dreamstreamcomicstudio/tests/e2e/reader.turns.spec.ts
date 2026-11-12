// reader.turns.spec.ts (reader.md §8.9, RD-A / RD-5 engine; PROGRAM3 B15): on the 360×740 phone at 4× CPU and a
// slow link (1.6 Mbps, 150 ms), after reading page 1 for 4 s the next five page turns each land on a picture —
// the page itself or its low-resolution stand-in — within 400 ms of the turn ending, and the reader counts no
// blank turn (window.__comicReaderPerf.blankTurns). Before the stand-ins and the turn gate, a cold turn showed
// paper for seconds (one turn waited 15.8 s for its art).
//
// The harness serves fixture images itself (page.route), which CDP's network throttling never sees, so this
// spec delays each image by its size at 1.6 Mbps plus 150 ms latency before handing it to the harness.

import { test, expect } from './helpers/harness';
import { QA_IMAGE_RE } from './fixtures/genImages';

/** ≈ bytes of a fixture PNG of w × h at a photo-like compression (¼ byte per pixel). */
const bytesOf = (w: number, h: number) => Math.round(w * h * 0.25);
/** 1.6 Mbps = 200 kB/s, plus 150 ms of latency. */
const delayFor = (w: number, h: number) => 150 + Math.round((bytesOf(w, h) / 200_000) * 1000);

test.describe('page turns never land on a blank page', () => {
  test.beforeEach(({ device }) => {
    test.skip(device.name !== 'galaxy-s8-360', 'the 360×740 phone profile only');
  });

  test('five turns on a slow link each show art within 400 ms of landing; no blank turn', async ({ qa, page }) => {
    test.setTimeout(90_000);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    // Every fixture image waits for its "download", then the harness serves it (QaHarness.delayImages).
    await qa.delayImages((url) => {
      const m = QA_IMAGE_RE.exec(url.pathname);
      return delayFor(m ? Number(m[2]) : 1000, m ? Number(m[3]) : 1500);
    });
    await qa.open({ surface: 'reader', fixture: 'heist-12p', page: 1, still: false }, { settle: 4_000 });
    const reader = page.locator('[data-testid="immersive-reader"]');
    await reader.focus();

    const counter = () => page.evaluate(() => document.querySelector('[data-testid="reader-hud-counter"]')?.textContent?.trim() || '');
    const landedOnArt = () =>
      page.waitForFunction(
        () => {
          const slots = Array.from(document.querySelectorAll('[data-slot][data-visible="true"][aria-roledescription="page"]'));
          return slots.length > 0 && slots.every((s) => Array.from(s.querySelectorAll('img')).some((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0));
        },
        null,
        { timeout: 400, polling: 'raf' }
      );

    const results: string[] = [];
    for (let turn = 1; turn <= 5; turn += 1) {
      const before = await counter();
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction((prev) => (document.querySelector('[data-testid="reader-hud-counter"]')?.textContent?.trim() || '') !== prev, before, { timeout: 8_000 });
      const after = await counter();
      const ok = await landedOnArt().then(
        () => true,
        () => false
      );
      results.push(`${after}: ${ok ? 'art' : 'BLANK'}`);
      expect.soft(ok, `turn ${turn} (${after}) shows art within 400 ms of landing`).toBe(true);
      await page.waitForTimeout(900);
    }
    test.info().annotations.push({ type: 'turns', description: results.join(' · ') });
    const blank = await page.evaluate(() => (window as unknown as { __comicReaderPerf?: { blankTurns?: number } }).__comicReaderPerf?.blankTurns ?? 0);
    expect(blank, 'window.__comicReaderPerf.blankTurns').toBe(0);
  });
});
