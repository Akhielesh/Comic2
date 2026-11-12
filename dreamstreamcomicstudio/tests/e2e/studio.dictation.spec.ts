// studio.dictation.spec.ts (voice hotfix): the Comic Studio composer's mic sits at the LEFT of its toolbar, and
// its settings, recording bar and error box used to be pinned to the mic's right edge, so all three opened 85 to
// 190 px off the left of the screen at every width. Each box must now open inside the viewport (left >= 0,
// right <= width, top >= 0, bottom <= height).
//
// Also checked here, in a real browser and fully offline (the harness aborts every other origin):
//  - the private voice model never asks our own origin for /models/onnx-community/... (the SPA answers that path
//    with index.html, which broke every load); it goes to Hugging Face, which the harness blocks, so the load
//    fails and the error says the microphone stayed off — and getUserMedia was never called;
//  - browser dictation (a fake SpeechRecognition): the words heard show in the bar, Done puts them in the box,
//    and nothing is sent.
//
// The named file matches the device projects (playwright.config.ts DEVICE_SPECS). desktop-1440 loops the widths
// 320, 390, 768 and 1280 with setViewportSize; the touch projects run once at their own size.

import { test, expect, type QaHarness } from './helpers/harness';
import type { Page } from '@playwright/test';

const WIDTHS = [320, 390, 768, 1280];

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  vw: number;
  vh: number;
}

/** The visible box matched by `selector`, with the viewport it must stay inside. */
const boxOf = (page: Page, selector: string) =>
  page.evaluate((sel) => {
    const el = Array.from(document.querySelectorAll<HTMLElement>(sel)).find((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 4 && r.height > 4;
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const vv = window.visualViewport;
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: vv?.width ?? window.innerWidth, vh: vv?.height ?? window.innerHeight };
  }, selector);

/** QA_VOICE_SHOTS=1: keep a picture of each open box (test-results/…) for a human look. */
const shot = async (page: Page, name: string) => {
  if (process.env.QA_VOICE_SHOTS) await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
};

const expectOnScreen = (b: Box | null, what: string) => {
  expect(b, `${what} is open`).not.toBeNull();
  if (!b) return;
  expect.soft(b.left, `${what}: left edge on screen`).toBeGreaterThanOrEqual(0);
  expect.soft(b.right, `${what}: right edge on screen`).toBeLessThanOrEqual(b.vw + 0.5);
  expect.soft(b.top, `${what}: top edge on screen`).toBeGreaterThanOrEqual(0);
  expect.soft(b.bottom, `${what}: bottom edge on screen`).toBeLessThanOrEqual(b.vh + 0.5);
};

/**
 * Before the page loads: count getUserMedia calls (and hand out a silent fake stream whose tracks count their
 * stops), and install a fake SpeechRecognition the test can drive (window.__voice).
 */
const installFakes = (page: Page, engine: 'whisper' | 'webspeech') =>
  page.addInitScript((eng) => {
    const voice = { gum: 0, stops: 0, rec: null as null | Record<string, any>, sent: [] as string[] };
    (window as any).__voice = voice;
    try {
      localStorage.setItem('ds.dictation.v1', JSON.stringify({ engine: eng, model: 'base' }));
    } catch {
      /* private mode */
    }
    const gum = async () => {
      voice.gum += 1;
      const ctx = new AudioContext();
      const dest = ctx.createMediaStreamDestination();
      const stream = dest.stream;
      for (const t of stream.getTracks()) {
        const stop = t.stop.bind(t);
        t.stop = () => {
          voice.stops += 1;
          stop();
        };
      }
      return stream;
    };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: gum, enumerateDevices: async () => [] } });
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = '';
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      constructor() {
        voice.rec = this as unknown as Record<string, any>;
      }
      start() {}
      stop() {
        setTimeout(() => this.onend?.(), 10);
      }
      abort() {
        setTimeout(() => this.onend?.(), 10);
      }
    }
    (window as any).SpeechRecognition = FakeRecognition;
  }, engine);

const openStudio = async (page: Page, qa: QaHarness) => {
  await qa.open({ surface: 'studio', fixture: 'lake-1p', img: 'svg' });
  await qa.toChat();
  const mic = page.getByRole('button', { name: 'Start voice dictation' }).first();
  await mic.scrollIntoViewIfNeeded().catch(() => undefined);
  await expect(mic, 'the composer mic is on the page').toBeVisible();
  return mic;
};

test.describe('Comic Studio dictation: every voice box opens on screen', () => {
  test.beforeEach(({ device }) => {
    test.skip(device.os !== 'desktop' && device.viewport.width > device.viewport.height, 'landscape phones are covered by the widths loop');
  });

  const widthsFor = (name: string, own: number) => (name === 'desktop-1440' ? WIDTHS : [own]);

  test('settings, recording bar and words heard (browser dictation), Done fills the box and sends nothing', async ({ page, qa, device }) => {
    await installFakes(page, 'webspeech');
    for (const w of widthsFor(device.name, device.viewport.width)) {
      if (device.name === 'desktop-1440') await page.setViewportSize({ width: w, height: w <= 430 ? 740 : 900 });
      const mic = await openStudio(page, qa);

      // Settings.
      await page.getByRole('button', { name: 'Dictation settings' }).first().click();
      await qa.settle(200);
      expectOnScreen(await boxOf(page, '[role="group"][aria-label="Dictation settings"]'), `${w}px settings`);
      await shot(page, `settings-${w}`);
      await page.keyboard.press('Escape'); // closes the settings with focus still on the caret
      await qa.settle(150);
      await expect(page.locator('[role="group"][aria-label="Dictation settings"]')).toHaveCount(0);

      // Recording bar, with the words heard so far.
      await mic.click();
      await qa.settle(200);
      await page.evaluate(() => {
        const rec = (window as any).__voice.rec;
        rec.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript: 'make it rain' }], { isFinal: true })] });
      });
      await qa.settle(150);
      expectOnScreen(await boxOf(page, '[data-voice-bar]'), `${w}px recording bar`);
      await shot(page, `bar-${w}`);
      await expect(page.locator('[data-voice-bar]').first()).toContainText('make it rain');
      const box = page.getByRole('textbox', { name: /message the comic director/i }).first();
      await expect(box, 'the box is untouched while listening').toHaveValue('');

      // Done: the words land in the box, and nothing is sent.
      await page.getByRole('button', { name: 'Finish and insert text' }).first().click();
      await expect(box).toHaveValue('make it rain');
      await expect(page.locator('[data-voice-bar]')).toHaveCount(0);
      const sends = (await qa.ops()).filter((op) => op.kind === 'send');
      expect.soft(sends, `${w}px: nothing was sent`).toEqual([]);
    }
  });

  test('a blocked microphone (browser dictation): the error is on screen, calm, with its action', async ({ page, qa, device }) => {
    await installFakes(page, 'webspeech');
    for (const w of widthsFor(device.name, device.viewport.width)) {
      if (device.name === 'desktop-1440') await page.setViewportSize({ width: w, height: w <= 430 ? 740 : 900 });
      const mic = await openStudio(page, qa);
      await mic.click();
      await qa.settle(150);
      await page.evaluate(() => {
        const rec = (window as any).__voice.rec;
        rec.onerror?.({ error: 'not-allowed' });
        rec.onend?.();
      });
      await qa.settle(200);
      expectOnScreen(await boxOf(page, '[data-voice-error]'), `${w}px error`);
      const alert = page.locator('[data-voice-error]').first();
      await expect(alert).toContainText("To talk, allow the microphone for this site in your browser's settings.");
      await expect(alert.getByRole('button', { name: 'Allow microphone' })).toBeVisible();
      await expect(alert).not.toContainText('not-allowed'); // the code waits behind Show details
      await alert.getByRole('button', { name: 'Show details' }).click();
      await expect(alert).toContainText('mic-blocked');
      expectOnScreen(await boxOf(page, '[data-voice-error]'), `${w}px error with details`);
      await shot(page, `error-${w}`);
    }
  });

  test('the private voice model never asks our origin for model files, and a failed download never opens the mic', async ({ page, qa, device }) => {
    await installFakes(page, 'whisper');
    const ownModelFiles: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.startsWith('/models/onnx-community/')) ownModelFiles.push(r.url());
    });
    const w = device.name === 'desktop-1440' ? 320 : device.viewport.width;
    if (device.name === 'desktop-1440') await page.setViewportSize({ width: w, height: 740 });
    const mic = await openStudio(page, qa);
    await mic.click();
    const alert = page.locator('[data-voice-error="model-download"]').first();
    await expect(alert).toBeVisible({ timeout: 30_000 });
    await expect(alert).toContainText("The voice model didn't download, so your microphone stayed off.");
    expectOnScreen(await boxOf(page, '[data-voice-error]'), `${w}px download error`);
    expect(ownModelFiles, 'no request to our own /models/onnx-community/').toEqual([]);
    // The QA page answers every cross-origin fetch with a 503 itself and records it (qa/ComicQaApp.tsx).
    const asked = (await qa.ops()).filter((op) => op.kind === 'net' && /^https:\/\/huggingface\.co\//.test(String((op.payload as { blocked?: string })?.blocked)));
    expect(asked.length, 'the weights are asked of Hugging Face (refused here)').toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).__voice.gum), 'getUserMedia was never called').toBe(0);
  });
});
