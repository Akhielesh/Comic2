// @vitest-environment node
// Library analysis + refine (assets.md §4.3–§4.4): software gates override the model; the refine
// strategy is chosen by rules; texture tiles come out seamless. Fake LLMs only.
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { ImageMeasure } from '../imageMeasure.js';
import { measureImage } from '../imageMeasure.js';
import { LIBRARY_MANIFEST, NO_TEXT, type LibraryManifestEntry } from './manifest.js';
import { SEAM_THRESHOLD, analyzeLibraryAsset, checkVisionReport, mergeLibraryScore, titleSimilarity } from './analyze.js';
import { editInstruction, guardRewrite, planRefine, rewritePrompt } from './refine.js';
import { encodeLibraryImage, makeSeamless } from './post.js';
import { fakeLibraryLlm, pngDataUrl, visionJson } from './testkit.js';

const entry = (id: string): LibraryManifestEntry => LIBRARY_MANIFEST.find((e) => e.id === id)!;
const measure = (over: Partial<ImageMeasure> = {}): ImageMeasure => ({
  w: 800,
  h: 1000,
  bytes: 1000,
  aspectWanted: '4:5',
  aspectActual: 0.8,
  aspectError: 0,
  aspectOk: true,
  meanLuma: 0.5,
  lumaStdev: 0.2,
  blank: false,
  palette: ['#111111'],
  ...over
});
const report = (v: Parameters<typeof visionJson>[0] = {}) => checkVisionReport(visionJson(v)).value!;

describe('mergeLibraryScore: software gates override the model', () => {
  const preview = entry('style.noir-ink');

  it('a clean, strong image passes', () => {
    const m = mergeLibraryScore(preview, measure(), report({ score: 0.9 }));
    expect(m.passed).toBe(true);
    expect(m.codes).toEqual([]);
    expect(m.score).toBeCloseTo(0.9, 3);
  });

  it('stray lettering on a text-free asset caps at 0.6', () => {
    const m = mergeLibraryScore(preview, measure(), report({ score: 0.95, textFound: ['BAKERY'] }));
    expect(m.codes).toContain('text');
    expect(m.score).toBe(0.6);
    expect(m.passed).toBe(false);
    // Two stray glyphs are below the 3-letter floor (SFX-like specks are tolerated).
    expect(mergeLibraryScore(preview, measure(), report({ score: 0.95, textFound: ['Z'] })).codes).not.toContain('text');
    expect(mergeLibraryScore(preview, measure(), report({ score: 0.95, watermarkOrSignature: true })).codes).toContain('text');
  });

  it('wrong shape caps at 0.5; blank is 0', () => {
    expect(mergeLibraryScore(preview, measure({ aspectOk: false, w: 1024, h: 1024 }), report()).score).toBe(0.5);
    expect(mergeLibraryScore(preview, measure({ blank: true }), report()).score).toBe(0);
  });

  it('a cover needs its title spelled right', () => {
    const cover = entry('cover.kids-storybook');
    expect(mergeLibraryScore(cover, measure(), report({ textFound: ['THE LITTLE LAKE'] })).passed).toBe(true);
    const bad = mergeLibraryScore(cover, measure(), report({ textFound: ['THE LITTEL LAEK'] }));
    expect(bad.codes).toContain('title');
    expect(bad.score).toBeLessThanOrEqual(0.6);
    expect(titleSimilarity(['THE LITTLE LAKE'], ['the', 'little lake'])).toBe(1);
  });

  it('genre pages must have the asked panel count; themes must match their luminance', () => {
    const page = entry('genre.noir');
    const wrong = mergeLibraryScore(page, measure({ aspectWanted: '2:3' }), report({ panelCount: 4 }));
    expect(wrong.codes).toContain('panels');
    expect(wrong.score).toBeLessThanOrEqual(0.65);
    expect(mergeLibraryScore(page, measure(), report({ panelCount: 6 })).codes).not.toContain('panels');

    const dark = entry('empty.studio-hero.dark');
    expect(mergeLibraryScore(dark, measure({ meanLuma: 0.8 }), report()).codes).toContain('theme');
    expect(mergeLibraryScore(dark, measure({ meanLuma: 0.2 }), report()).codes).not.toContain('theme');
    const light = entry('empty.cast');
    expect(mergeLibraryScore(light, measure({ meanLuma: 0.3 }), report()).codes).toContain('theme');
  });

  it('no usable analysis ⇒ score 0, an honest issue, never passed', () => {
    const m = mergeLibraryScore(preview, measure(), undefined);
    expect(m.passed).toBe(false);
    expect(m.codes).toEqual(['analysis']);
  });

  it('analyzeLibraryAsset falls back (no throw) on garbage JSON and sends the image + brief', async () => {
    const llm = fakeLibraryLlm(['garbage']);
    const out = await analyzeLibraryAsset(llm, { entry: preview, prompt: preview.prompt, dataUrl: 'data:image/webp;base64,AAAA' });
    expect(out.fellBack).toBe(true);
    expect(out.report).toBeUndefined();
    const user = llm.calls[0].messages[1].content as Array<{ type: string }>;
    expect(user[0].type).toBe('image_url');
    expect(llm.calls[0].role).toBe('vision');
  });
});

describe('planRefine: rule-chosen strategy', () => {
  const preview = entry('style.retro-pop');
  const ctx = { attempt: 1, maxAttempts: 3, basePrompt: preview.prompt, rev: 1 };

  it('aspect only → re-request (free fix through parameters)', () => {
    const m = mergeLibraryScore(preview, measure({ aspectOk: false }), report());
    expect(planRefine(preview, m, ctx)).toEqual({ strategy: 'rerequest' });
  });

  it('text only → an edit pass with the exact deterministic instruction', () => {
    const m = mergeLibraryScore(preview, measure(), report({ textFound: ['BAKERY'] }));
    const plan = planRefine(preview, m, ctx);
    expect(plan).toEqual({ strategy: 'edit', fromRev: 1, instruction: 'Remove all lettering, signage text, signatures and watermarks; change nothing else.' });
    const cover = entry('cover.superhero');
    expect(editInstruction(cover, { codes: ['title'], notes: [] })).toBe(
      "Re-letter the title exactly as 'HARBOR LIGHT'; remove any other lettering, signatures and watermarks; change nothing else."
    );
  });

  it('weak brief → deterministic corrections first, then one LLM rewrite on the last attempt', async () => {
    const m = mergeLibraryScore(entry('genre.noir'), measure(), report({ briefMatch: 0.4, panelCount: 5 }));
    const first = planRefine(entry('genre.noir'), m, { ...ctx, basePrompt: entry('genre.noir').prompt });
    expect(first.strategy).toBe('regenerate');
    const prompt = (first as { prompt: string }).prompt;
    expect(prompt).toMatch(/Corrections:\n- /);
    expect(prompt).toContain('Exactly 6 panels as listed; do not merge or add panels.');
    expect(prompt).toContain('Must clearly show: a woman detective in a trench coat');
    expect(prompt.startsWith(entry('genre.noir').subject!)).toBe(true);

    const second = planRefine(entry('genre.noir'), m, { ...ctx, attempt: 2, basePrompt: entry('genre.noir').prompt });
    expect(second.strategy).toBe('rewrite');
    const llm = fakeLibraryLlm([], 'A trench-coated detective walks into a jazz bar, six panels.');
    const rw = await rewritePrompt(llm, { entry: entry('genre.noir'), prompt: (second as { prompt: string }).prompt, issues: [], styleSpec: 'SPEC' });
    expect(llm.calls).toHaveLength(1);
    expect(rw.rewritten).toBe(true);
    expect(rw.prompt).toContain(NO_TEXT); // guarded back in
    expect(rw.prompt).toContain('Style: SPEC');
  });

  it('stops when attempts are used up, on a second blank, or when the check itself failed', () => {
    const m = mergeLibraryScore(preview, measure(), report({ score: 0.3 }));
    expect(planRefine(preview, m, { ...ctx, attempt: 3 }).strategy).toBe('stop');
    const blank = mergeLibraryScore(preview, measure({ blank: true }), report());
    expect(planRefine(preview, blank, { ...ctx, blankBefore: true }).strategy).toBe('stop');
    expect(planRefine(preview, mergeLibraryScore(preview, measure(), undefined), ctx).strategy).toBe('stop');
  });

  it('guardRewrite keeps the title of a cover', () => {
    const cover = entry('cover.kids-storybook');
    expect(guardRewrite(cover, cover.prompt, 'A picture-book cover with a toddler and ducklings at a lake at sunset.')).toContain("'THE LITTLE LAKE'");
  });

  it('the IP lint holds for model-written text: a rewrite or a vision note naming a studio never reaches a prompt', () => {
    const preview = entry('style.watercolor-storybook');
    const named = 'A girl and her terrier on a canal bridge at dusk, painted like a Ghibli film, warm washes and soft pencil lines.';
    expect(guardRewrite(preview, preview.prompt, named)).toBe(preview.prompt);
    const merged = mergeLibraryScore(preview, measure(), { ...visionJson({ score: 0.5, briefMatch: 0.5 }), issues: ['Looks like a Disney still', 'The dog is missing'] });
    const plan = planRefine(preview, merged, { attempt: 1, maxAttempts: 3, basePrompt: preview.prompt, rev: 1 });
    expect(plan.strategy).toBe('regenerate');
    const prompt = (plan as { prompt: string }).prompt;
    expect(prompt).toContain('Fix: The dog is missing.');
    expect(/disney/i.test(prompt)).toBe(false);
  });
});

describe('post-processing ($0 sharp)', () => {
  it('encodes WebP with 640/320 thumbnails, never upscaling', async () => {
    const enc = await encodeLibraryImage(await pngDataUrl(900, 1125));
    expect(enc.w).toBe(900);
    expect((await sharp(enc.full).metadata()).format).toBe('webp');
    expect((await sharp(enc.thumbs[640]).metadata()).width).toBe(640);
    expect((await sharp(enc.thumbs[320]).metadata()).width).toBe(320);
  });

  it('texture seeds become seamless tiles (edge delta under the threshold)', async () => {
    const gradient = await sharp({
      create: { width: 600, height: 600, channels: 3, background: { r: 0, g: 0, b: 0 } }
    })
      .composite([{ input: Buffer.from('<svg width="600" height="600"><defs><linearGradient id="g"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect width="600" height="600" fill="url(#g)"/></svg>') }])
      .png()
      .toBuffer();
    const before = await measureImage(gradient, '1:1', { texture: true });
    expect(before.edgeSeamDelta!).toBeGreaterThan(SEAM_THRESHOLD);
    const tile = await makeSeamless(gradient, 256);
    const after = await measureImage(tile, '1:1', { texture: true });
    expect(after.w).toBe(256);
    expect(after.edgeSeamDelta!).toBeLessThan(SEAM_THRESHOLD);
  });
});
