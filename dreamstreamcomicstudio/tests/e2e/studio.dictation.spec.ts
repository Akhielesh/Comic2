// studio.dictation.spec.ts (voice hotfix): the Comic Studio composer's mic sits at the LEFT of its toolbar, and
// its settings, recording bar and error box used to be pinned to the mic's right edge, so all three opened 85 to
// 190 px off the left of the screen at every width. Each box must now open inside the viewport (left >= 0,
// right <= width, top >= 0, bottom <= height).
//
// The boxes also keep the text box in view: the mic sits under it, so they open above the whole composer box
// rather than over the words the take is about to change (and the person may type there during a take).
//
// Also checked here, in a real browser and fully offline (the harness aborts every other origin):
//  - the private voice model never asks our own origin for /models/onnx-community/... (the SPA answers that path
//    with index.html, which broke every load); it goes to Hugging Face, which the harness blocks, so the load
//    fails and the error says the microphone stayed off — and getUserMedia was never called;
//  - browser dictation (a fake SpeechRecognition): the words heard show in the bar, text typed during the take is
//    kept, Done puts the words in at the cursor, nothing is sent, and a second take starts with an empty bar;
//  - the voice engine (the ONNX runtime, code that runs in our origin) is fetched from our own site only, in the build
//    transformers.js picks for this browser, as JavaScript and WebAssembly (never the SPA's HTML), and during the take
//    nothing goes to any host but ours and Hugging Face's: here Hugging Face is answered by this spec with a stand-in
//    config and stand-in model bytes (route.fulfill, `?hf=route`), so nothing real downloads and the load then fails
//    calmly, with the mic still off.
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

/** The composer's text box, which no voice box may cover. */
const textBoxOf = (page: Page) =>
  page.evaluate(() => {
    const el = Array.from(document.querySelectorAll<HTMLElement>('textarea[aria-label="Message the Comic Director"]')).find((e) => e.getBoundingClientRect().height > 4);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
  });

const expectClearOfText = async (page: Page, b: Box | null, what: string) => {
  const t = await textBoxOf(page);
  expect(t, 'the text box is on the page').not.toBeNull();
  if (!b || !t) return;
  const overlap = b.left < t.right - 0.5 && b.right > t.left + 0.5 && b.top < t.bottom - 0.5 && b.bottom > t.top + 0.5;
  expect.soft(overlap, `${what}: never over the text box (box ${Math.round(b.top)}–${Math.round(b.bottom)}, text ${Math.round(t.top)}–${Math.round(t.bottom)})`).toBe(false);
  // It stays in the composer's own column: in a side pane (tablet portrait, an unfolded Fold) the next pane would
  // paint over anything that spills into it, Done included.
  const c = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-composer-box]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right };
  });
  expect(c, 'the composer box is on the page').not.toBeNull();
  if (!c) return;
  expect.soft(b.left, `${what}: inside the composer's column (left)`).toBeGreaterThanOrEqual(c.left - 8.5);
  expect.soft(b.right, `${what}: inside the composer's column (right)`).toBeLessThanOrEqual(c.right + 8.5);
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
      const settings = await boxOf(page, '[role="group"][aria-label="Dictation settings"]');
      expectOnScreen(settings, `${w}px settings`);
      await expectClearOfText(page, settings, `${w}px settings`);
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
      const bar = await boxOf(page, '[data-voice-bar]');
      expectOnScreen(bar, `${w}px recording bar`);
      await expectClearOfText(page, bar, `${w}px recording bar`);
      await shot(page, `bar-${w}`);
      await expect(page.locator('[data-voice-bar]').first()).toContainText('make it rain');
      await expect(page.locator('[data-voice-bar]').first(), 'where the voice goes is said at every width').toContainText('online');
      // Nothing in the bar is pushed out of it (a narrow pane on a wide screen once hid Done past its right edge).
      const spill = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll<HTMLElement>('[data-voice-bar]')).find((e) => e.getBoundingClientRect().width > 4);
        return el ? el.scrollWidth - el.clientWidth : -1;
      });
      expect.soft(spill, `${w}px: the bar's content fits its width`).toBeLessThanOrEqual(1);
      expect.soft(spill, `${w}px: the bar was found`).toBeGreaterThanOrEqual(0);
      const box = page.getByRole('textbox', { name: /message the comic director/i }).first();
      await expect(box, 'the box is untouched while listening').toHaveValue('');
      // The person can still type in the box during the take (the bar never covers it); that text is kept.
      await box.fill('Page two:');
      await expect(page.locator('[data-voice-bar]'), 'typing does not end the take').toHaveCount(1);

      // Done: the words land at the cursor after the typed text, and nothing is sent.
      await page.getByRole('button', { name: 'Finish and insert text' }).first().click();
      await expect(box).toHaveValue('Page two: make it rain');
      await expect(page.locator('[data-voice-bar]')).toHaveCount(0);
      const sends = (await qa.ops()).filter((op) => op.kind === 'send');
      expect.soft(sends, `${w}px: nothing was sent`).toEqual([]);

      // A second take in the same composer starts with an empty bar, never the last take's words.
      await mic.click();
      await qa.settle(150);
      await expect(page.locator('[data-voice-bar]').first()).toContainText('Speak now…');
      await expect(page.locator('[data-voice-bar]').first()).not.toContainText('make it rain');
      await page.getByRole('button', { name: 'Discard recording' }).first().click();
      await expect(page.locator('[data-voice-bar]')).toHaveCount(0);
      await expect(box, 'Discard leaves the box as it was').toHaveValue('Page two: make it rain');
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
      const err = await boxOf(page, '[data-voice-error]');
      expectOnScreen(err, `${w}px error`);
      await expectClearOfText(page, err, `${w}px error`);
      const alert = page.locator('[data-voice-error]').first();
      await expect(alert).toContainText("To talk, allow the microphone for this site in your browser's settings, then try again.");
      // A tap cannot unblock a blocked site, so the action only says what it does.
      await expect(alert.getByRole('button', { name: 'Try again' })).toBeVisible();
      await expect(alert.getByRole('button', { name: 'Allow microphone' })).toHaveCount(0);
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
    const err = await boxOf(page, '[data-voice-error]');
    expectOnScreen(err, `${w}px download error`);
    await expectClearOfText(page, err, `${w}px download error`);
    expect(ownModelFiles, 'no request to our own /models/onnx-community/').toEqual([]);
    // The QA page answers every cross-origin fetch with a 503 itself and records it (qa/ComicQaApp.tsx).
    const asked = (await qa.ops()).filter((op) => op.kind === 'net' && /^https:\/\/huggingface\.co\//.test(String((op.payload as { blocked?: string })?.blocked)));
    expect(asked.length, 'the weights are asked of Hugging Face (refused here)').toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).__voice.gum), 'getUserMedia was never called').toBe(0);
  });

  test('the voice engine comes from our own site only, and nothing but Hugging Face (answered here) is asked', async ({ page, qa, device }) => {
    await installFakes(page, 'whisper');
    if (device.name === 'desktop-1440') await page.setViewportSize({ width: 1280, height: 900 });
    await qa.open({ surface: 'studio', fixture: 'lake-1p', img: 'svg', hf: 'route' });
    await qa.toChat();
    const mic = page.getByRole('button', { name: 'Start voice dictation' }).first();
    await expect(mic, 'the composer mic is on the page').toBeVisible();
    const own = new URL(page.url());

    // Hugging Face, answered here: a stand-in config, a few bytes for each model file, 404 for the rest (the
    // tokenizer). No real weights download; the engine is still asked for, because the model's sessions are made.
    const hfAsked: string[] = [];
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-expose-headers': '*' };
    const STAND_IN_CONFIG = {
      model_type: 'whisper',
      architectures: ['WhisperForConditionalGeneration'],
      is_encoder_decoder: true,
      d_model: 64,
      encoder_layers: 1,
      decoder_layers: 1,
      encoder_attention_heads: 1,
      decoder_attention_heads: 1,
      num_mel_bins: 80,
      vocab_size: 100,
      max_source_positions: 1500,
      max_target_positions: 448
    };
    await page.route(/^https:\/\/([a-z0-9-]+\.)*(huggingface\.co|hf\.co)\//i, async (route) => {
      const req = route.request();
      hfAsked.push(req.url());
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const file = new URL(req.url()).pathname;
      if (file.endsWith('/config.json')) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(STAND_IN_CONFIG) });
      if (file.endsWith('.onnx')) return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/octet-stream' }, body: Buffer.alloc(64) });
      return route.fulfill({ status: 404, headers: cors, body: 'not here' });
    });

    // Every request the page makes from the tap on (fetches, module imports, the .wasm), and what the QA page refused.
    const seen: string[] = [];
    page.on('request', (r) => seen.push(r.url()));
    await qa.clearOps();
    const isEngine = (u: string, ext: 'mjs' | 'wasm') => /\/ort-wasm-[^/]*$/.test(new URL(u).pathname) && u.endsWith(`.${ext}`);
    const mjsResponse = page.waitForResponse((r) => isEngine(r.url(), 'mjs'), { timeout: 60_000 });
    const wasmResponse = page.waitForResponse((r) => isEngine(r.url(), 'wasm'), { timeout: 60_000 });
    await mic.click();

    // The engine is asked for (from wherever this build points it), then: never jsDelivr or any other CDN.
    const engineSeen = () => seen.some((u) => /\/ort-wasm-[^/]*\.(?:mjs|wasm)$/.test(new URL(u).pathname));
    await expect.poll(engineSeen, { timeout: 60_000, message: 'the page asks for the voice engine' }).toBe(true);
    const refusedNow = (await qa.ops()).filter((op) => op.kind === 'net' && (op.payload as { blocked?: string })?.blocked).map((op) => String((op.payload as { blocked: string }).blocked));
    expect([...seen.filter((u) => /jsdelivr/i.test(u)), ...refusedNow.filter((u) => /jsdelivr/i.test(u))], 'the engine is never fetched from cdn.jsdelivr.net').toEqual([]);

    // transformers.js's own choice for this browser (its isSafari test), which must be what loads.
    const apple = await page.evaluate(() => {
      const ua = navigator.userAgent;
      return (navigator.vendor || '').includes('Apple') && !/CriOS|FxiOS|EdgiOS|OPiOS|mercury|brave/i.test(ua) && !ua.includes('Chrome') && !ua.includes('Android');
    });
    const stem = apple ? 'ort-wasm-simd-threaded' : 'ort-wasm-simd-threaded.asyncify';

    const mjs = await mjsResponse;
    const mjsUrl = new URL(mjs.url());
    expect(mjsUrl.origin, 'the engine is asked of our own origin').toBe(own.origin);
    expect(mjsUrl.pathname).toMatch(new RegExp(`^/ort/[0-9][^/]*/${stem.replace(/\./g, '\\.')}\\.mjs$`));
    expect(mjs.status()).toBe(200);
    expect(mjs.headers()['content-type'], 'served as JavaScript').toMatch(/^text\/javascript\b/);
    const code = await mjs.text();
    expect(code.trimStart().slice(0, 1), 'JavaScript, never the SPA page').not.toBe('<');
    expect(code).toMatch(/export default/);

    const wasm = await wasmResponse;
    const wasmUrl = new URL(wasm.url());
    expect(wasmUrl.origin).toBe(own.origin);
    expect(wasmUrl.pathname).toBe(mjsUrl.pathname.replace(/\.mjs$/, '.wasm'));
    expect(wasm.status()).toBe(200);
    expect(wasm.headers()['content-type']).toBe('application/wasm');
    // The page's own copy is too large for the inspector to keep; ask for the same URL again from the test.
    const again = await page.request.get(wasm.url());
    expect(again.headers()['content-type']).toBe('application/wasm');
    expect([...(await again.body()).subarray(0, 4)], 'a WebAssembly binary').toEqual([0, 0x61, 0x73, 0x6d]);

    // The stand-in model cannot load: the calm error, and the microphone never opened.
    const alert = page.locator('[data-voice-error="model-download"]').first();
    await expect(alert).toBeVisible({ timeout: 30_000 });
    expect(await page.evaluate(() => (window as any).__voice.gum), 'getUserMedia was never called').toBe(0);

    // No host but ours and Hugging Face's, from the network's view and the QA page's (what it refused).
    const isAllowed = (host: string) => host === own.hostname || ['huggingface.co', 'hf.co'].some((h) => host === h || host.endsWith(`.${h}`));
    const hosts = [...new Set(seen.map((u) => new URL(u)).filter((u) => /^https?:$/.test(u.protocol)).map((u) => u.hostname))];
    expect(hosts.filter((h) => !isAllowed(h)), 'no request to any other host').toEqual([]);
    expect(seen.filter((u) => /jsdelivr/i.test(u)), 'nothing from cdn.jsdelivr.net').toEqual([]);
    const refused = (await qa.ops())
      .filter((op) => op.kind === 'net' && (op.payload as { blocked?: string })?.blocked)
      .map((op) => String((op.payload as { blocked: string }).blocked));
    expect(refused, 'the page tried no other host either (jsDelivr included)').toEqual([]);
    expect(hfAsked.some((u) => u.endsWith('/config.json')), 'the weights are asked of Hugging Face').toBe(true);
    expect(hfAsked.some((u) => u.endsWith('.onnx')), 'the model files too (stand-ins)').toBe(true);
    expect(seen.some((u) => new URL(u).pathname.startsWith('/models/')), 'never our own /models/').toBe(false);
  });
});
