import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateMeasure } from '../../../shared/comic/lettering/layout';
import { languageSpec } from '../../../shared/comic/languages';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { fakeContext, fakePath, type FakeCtx } from './__fixtures__/fakeCanvas';
import { makeBook } from './__fixtures__/books';
import {
  MAX_EXPORT_EDGE,
  fontFor,
  letterCover,
  letterPage,
  pageAspectFor,
  rasterSize,
  rasterizeImage,
  renderPlateToBlob,
  renderSlotToBlob
} from './rasterize';
import { collectExportSlots, localizedFor } from './sequence';
import { fakeUrlFor } from '../board/__fixtures__/sampleDoc';

describe('rasterSize', () => {
  it('keeps the art’s resolution by default and scales to a long edge on request', () => {
    expect(rasterSize(1000, 1500)).toEqual({ width: 1000, height: 1500 });
    expect(rasterSize(1000, 1500, 3000)).toEqual({ width: 2000, height: 3000 });
    expect(rasterSize(1500, 1000, 750)).toEqual({ width: 750, height: 500 });
  });

  it('never exceeds the canvas limit', () => {
    const s = rasterSize(6000, 9000);
    expect(Math.max(s.width, s.height)).toBe(MAX_EXPORT_EDGE);
  });
});

describe('fontFor', () => {
  it('uses the self-hosted lettering faces, script faces for other languages', () => {
    expect(fontFor('speech', 20)).toMatch(/^700 20px "DSL Comic Neue"/);
    expect(fontFor('whisper', 20)).toMatch(/^italic 700 20px "DSL Comic Neue"/);
    expect(fontFor('sfx', 40)).toMatch(/"DSL Bangers"/);
    const te = languageSpec('te')!;
    expect(fontFor('speech', 20, 'te')).not.toMatch(/Comic Neue/);
    expect(fontFor('speech', 20, 'te')).not.toMatch(/^italic/);
    expect(fontFor('whisper', 20, 'hi')).not.toMatch(/^italic/); // no italics outside Latin
    expect(te.fonts.dialogue).toBeTruthy();
  });
});

describe('pageAspectFor', () => {
  it('plans at the recorded art size unless the file really has another shape', () => {
    const doc = makeSampleDoc();
    const page = doc.pages[0]; // recorded 1000×1500
    expect(pageAspectFor(doc, page, 1000, 1501)).toBeCloseTo(2 / 3, 6);
    expect(pageAspectFor(doc, page, 1000, 1000)).toBe(1);
  });
});

describe('lettering on a canvas', () => {
  it('letters every line of an overlay page from the engine plans', async () => {
    const doc = makeSampleDoc();
    const f = fakeContext(1000, 1500);
    await letterPage(f.ctx, doc, doc.pages[0], 1000, 1500, { measure: estimateMeasure, makePath: fakePath });
    const texts = f.calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0])).join(' ');
    expect(texts).toContain('OLD DELHI.');
    expect(texts).toContain('GRAB');
    expect(texts).toMatch(/EXPLANATION/);
  });

  it('letters nothing for in-art comics', async () => {
    const doc = makeSampleDoc((d) => (d.format.lettering = 'in_art'));
    const f = fakeContext();
    await letterPage(f.ctx, doc, doc.pages[0], 1000, 1500, { measure: estimateMeasure });
    expect(f.draws()).toHaveLength(0);
  });

  it('sets the overlay cover title in the edition’s language; a painted cover gets nothing', async () => {
    const f = fakeContext(1000, 1500);
    await letterCover(f.ctx, makeBook(undefined, { overlayCover: true }), 1000, 1500, { measure: estimateMeasure });
    expect(f.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]).join(' ')).toContain('SAFFRON');
    const te = fakeContext(1000, 1500);
    await letterCover(te.ctx, localizedFor(makeBook(undefined, { overlayCover: true }), 'te'), 1000, 1500, { measure: estimateMeasure });
    expect(te.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]).join(' ')).toMatch(/\p{Script=Telugu}/u);
    const painted = fakeContext();
    await letterCover(painted.ctx, makeBook(), 1000, 1500, { measure: estimateMeasure });
    expect(painted.draws()).toHaveLength(0);
  });
});

describe('canvas renders', () => {
  let made: FakeCtx[];
  beforeEach(() => {
    made = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      const f = fakeContext(this.width, this.height);
      made.push(f);
      return f.ctx as never;
    } as never);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
      cb(new Blob([`${this.width}x${this.height}`], { type: type || 'image/png' }));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('draws a plate (paper, rule, texts) at the requested width and encodes it', async () => {
    const doc = makeBook();
    const blob = await renderPlateToBlob(doc, 'end', { plateWidth: 1200, mime: 'image/jpeg' });
    expect(blob.type).toBe('image/jpeg');
    expect(blob.size).toBe('1200x1800'.length);
    const f = made[0];
    expect((f.ctx.canvas as unknown as { width: number; height: number }).height).toBe(1800);
    const texts = f.calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]);
    expect(texts).toContain('The End');
    expect(texts).toContain('Made with DreamStream Comic Studio');
    expect(texts.join(' ')).toContain('Story by');
    expect(f.calls.some((c) => c.name === 'stroke')).toBe(true); // the accent rule
  });

  it('a back cover whose vignette cannot load keeps its placeholder instead of failing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    const blob = await renderPlateToBlob(makeBook(), 'back_cover', { artUrl: 'https://cdn.test/u/proj/cover.png' });
    expect(blob.size).toBeGreaterThan(0);
    expect(made[0].calls.some((c) => c.name === 'drawImage')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('renders a slot from an image already loaded (the art is fetched once for every language)', async () => {
    const doc = makeBook();
    const { slots } = collectExportSlots(doc, fakeUrlFor);
    const page = slots.find((s) => s.key === 'pg_1')!;
    const image = { source: { tag: 'art' } as unknown as CanvasImageSource, width: 1000, height: 1500 };
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    for (const lang of ['en', 'te']) await renderSlotToBlob(localizedFor(doc, lang), page, { image, measure: estimateMeasure, makePath: fakePath });
    vi.unstubAllGlobals();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(made).toHaveLength(2);
    expect(made.every((f) => f.calls[1]?.name === 'drawImage' || f.calls.some((c) => c.name === 'drawImage' && c.args[0] === image.source))).toBe(true);
    const te = made[1].calls.filter((c) => c.name === 'fillText').map((c) => c.args[0]).join(' ');
    expect(te).toMatch(/\p{Script=Telugu}/u);
    expect(made[1].calls.filter((c) => c.name === 'fillText').every((c) => c.state.direction === 'ltr')).toBe(true);
  });

  it('rasterizeImage reports a cancelled export', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(rasterizeImage({ source: {} as CanvasImageSource, width: 10, height: 10 }, { signal: controller.signal })).rejects.toThrow('Export cancelled.');
  });
});
