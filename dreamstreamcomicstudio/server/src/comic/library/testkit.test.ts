// @vitest-environment node
// The library testkit wires the admin spend guard and the call ledger that production always wires (Program 3 ST-A wave
// note 10), so runner tests run the guarded path, and LibraryDeps.spend / calls can become required in a later wave.
// Fakes only: no network, no spend.
import { describe, expect, it } from 'vitest';
import { BLANK_LUMA_STDEV, measureImage } from '../imageMeasure.js';
import { encodeLibraryImage } from './post.js';
import { manifestView, startRun, stepRun } from './runner.js';
import { KIT_IMAGE_SPLIT, TEST_MANIFEST, pngDataUrl, testLibrary } from './testkit.js';

const ADMIN = '00000000-0000-4000-8000-000000000001';

describe('pngDataUrl: the kit image is never near blank', () => {
  // The runner publishes a kit image only if the software check does not call it blank. Noise alone sat 4% above the
  // blank threshold after the WebP encode and the 64×64 downscale, so a rare draw fell under it and the runner asked
  // for another attempt: a run stayed "running" where a test expected "completed". The kit image must clear the
  // threshold by a wide margin on every draw, at every shape the tests use.
  it.each([
    [320, 320, '1:1', 6],
    [900, 1125, '4:5', 2] // the large shape takes most of a second per draw
  ] as const)(
    'a %i×%i draw measures at least three times the blank threshold after the library encode',
    async (w, h, aspect, draws) => {
      for (let i = 0; i < draws; i += 1) {
        const enc = await encodeLibraryImage(await pngDataUrl(w, h));
        const m = await measureImage(enc.full, aspect);
        expect(m.blank).toBe(false);
        expect(m.lumaStdev).toBeGreaterThanOrEqual(3 * BLANK_LUMA_STDEV);
        expect(m.aspectOk).toBe(true);
      }
    },
    30_000
  );

  it('keeps the requested mean: the two halves move by the same step in opposite directions', async () => {
    const m = await measureImage((await encodeLibraryImage(await pngDataUrl(320, 320, 150))).full, '1:1');
    expect(Math.abs(m.meanLuma - 150 / 255)).toBeLessThan(0.03);
    expect(KIT_IMAGE_SPLIT / 255).toBeGreaterThan(3 * BLANK_LUMA_STDEV); // the step alone clears the margin, before any noise
  });

  it('stays an image at the edges of the range and at one pixel wide', async () => {
    for (const [w, h, mean] of [[320, 320, 0], [320, 320, 255], [1, 8, 150], [2, 2, 10]] as const) {
      const url = await pngDataUrl(w, h, mean);
      const m = await measureImage(Buffer.from(url.split(',')[1], 'base64'));
      expect([m.w, m.h]).toEqual([w, h]);
    }
  });
});

describe('testLibrary: the pass-through spend guard', () => {
  it('wires spend and calls on the deps: the model-test key by name, no app cap, a no-op ledger', async () => {
    const { deps } = testLibrary();
    expect(deps.spend).toBeDefined();
    expect(deps.calls).toBeDefined();
    expect(deps.spend!.key()).toBe('modeltest');
    expect(deps.spend!.monthlyCapUsd()).toBe(Number.POSITIVE_INFINITY);
    expect(await deps.spend!.keyBudget('sk-or-test', 'modeltest')).toEqual({ limitUsd: 1000, remainingUsd: 1000, limitReset: 'monthly', usageMonthlyUsd: 0, budget: null, checkedAt: 0 });
    expect(deps.calls!.record({} as never)).toBeUndefined();
  });

  it('a build starts through the guard: the run records the key name and the preflight, with no warning', async () => {
    const t = testLibrary({ manifest: TEST_MANIFEST.slice(0, 1) });
    const out = await startRun(t.deps, {}, ADMIN);
    expect(out.run).not.toBeNull();
    expect(out.warning).toBeUndefined(); // a limited key with room adds no warning, so message assertions stay as they were
    const row = t.repo.runs.get(out.run!.id)!;
    expect(row.request.key).toBe('modeltest');
    expect(row.request.preflight).toEqual({ limitUsd: 1000, remainingUsd: 1000, budgetRemainingUsd: null, checkedAt: 0 });
    expect(t.images.calls).toHaveLength(0); // starting spends nothing

    const view = await manifestView(t.deps);
    expect(view.billing).toMatchObject({ key: 'modeltest', limitUsd: 1000, remainingUsd: 1000 });
  });

  it('a step under the guard draws on the OpenRouter key only, and the step goes through the ledger', async () => {
    const t = testLibrary({ manifest: TEST_MANIFEST.slice(0, 1), keys: { openrouter: { key: 'sk-or-test', byok: false }, gemini: { key: 'gm-test', byok: false } } });
    const seen: unknown[] = [];
    const images = t.deps.images;
    t.deps = { ...t.deps, images: (keys) => (seen.push(keys), images(keys)) };
    const recorded: unknown[] = [];
    t.deps.calls = { record: (c) => void recorded.push(c) };
    const out = await startRun(t.deps, {}, ADMIN);
    await stepRun(t.deps, out.run!.id, 1, ADMIN);
    expect(seen.length).toBeGreaterThan(0);
    for (const keys of seen) expect(keys).toEqual({ openrouter: { key: 'sk-or-test', byok: false } }); // the Gemini key is dropped
    expect(recorded.length).toBeGreaterThan(0);
  });

  it('no OpenRouter key: the guarded refusal names the model-test key and spends nothing', async () => {
    const t = testLibrary({ keys: { gemini: { key: 'gm-test', byok: false } } });
    await expect(startRun(t.deps, {}, ADMIN)).rejects.toMatchObject({ status: 503, code: 'NOT_AVAILABLE', message: expect.stringMatching(/model-test key \(DREAMSTREAMSTUDIO_MODELTEST\) isn't set/) });
    expect(t.images.calls).toHaveLength(0);
  });
});
