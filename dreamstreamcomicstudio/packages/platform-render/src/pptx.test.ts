// @vitest-environment jsdom
//
// renderPptx and the vendored PptxGenJS (plan §12 W1.7, §9 SSRF row): `path:`, `http:`, `https:` and `file:` images
// throw `blocked` in the library itself and in the renderer, nothing is fetched or read, export is refused while
// content elements overlap, the theme comes from the deck and the BrandKit, and every XML part is well-formed (P8:
// one <a:pPr> per paragraph). The normalised-XML goldens are in golden.test.ts.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeckElement, DeckSpec, Slide } from '../../platform-core/src/contract/deck.js';
import { DECK_LIMITS } from '../../platform-core/src/contract/deck.js';
import type { SlideOverlap } from './errors.js';
import { RenderError } from './errors.js';
import { checkDeckSpec, deckOverlaps, overlapCheck } from '../../platform-core/src/models/deck/index.js';
import { DECK_OUTLINE_LIMITS, outlineToDeck, type DeckOutline, type OutlineToDeckOptions } from '../../platform-core/src/prompts/index.js';
import { contentOverlaps, renderPptx } from './pptx.js';
import { BRAND, FAMILIES, IMAGES, contractFixture, fakeTranscode, here, parseXml, renderFixture, text, zipParts } from './render.testkit.js';
import PptxGenJS from './vendor/pptxgenjs/pptxgen.es.js';

const VENDORED = here('./vendor/pptxgenjs/pptxgen.es.js');

const deckOf = (elements: DeckElement[], extra: Partial<DeckSpec> = {}): DeckSpec => ({
  v: 1,
  title: 'Test deck',
  size: '16:9',
  theme: { preset: 'light' },
  slides: [{ id: 's1', layout: 'content', elements }],
  ...extra,
});

const refusal = async (p: Promise<unknown>): Promise<RenderError> => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(RenderError);
    return err as RenderError;
  }
  throw new Error('expected a RenderError, got a file');
};

const thrown = (fn: () => unknown): { code?: string; message: string } => {
  try {
    fn();
  } catch (err) {
    return err as { code?: string; message: string };
  }
  throw new Error('expected a throw');
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('vendored PptxGenJS: never reads a path or fetches a URL (PATCHES.md)', () => {
  const box = { x: 0, y: 0, w: 1, h: 1 };
  const SOURCES = ['https://evil.example/x.png', 'http://evil.example/x.png', 'file:///etc/passwd', '/etc/passwd', 'img/cover.png', 'path:cover.png'];

  it('addImage with a `path` (path:, http:, https:, file:, absolute or relative) throws blocked', () => {
    const slide = new PptxGenJS().addSlide() as unknown as { addImage: (o: object) => unknown };
    for (const path of SOURCES) {
      const err = thrown(() => slide.addImage({ path, ...box }));
      expect(err.code, path).toBe('blocked');
      expect(err.message, path).toMatch(/^blocked:/);
    }
  });

  it('addImage data must be a PNG, JPEG or WebP data: image (a URL or SVG in `data` is blocked)', () => {
    const slide = new PptxGenJS().addSlide() as unknown as { addImage: (o: object) => unknown };
    for (const data of ['https://evil.example/x.png', 'file:///etc/passwd', 'data:image/svg+xml;base64,PHN2Zy8+', 'image/gif;base64,R0lGOD', '']) {
      expect(thrown(() => slide.addImage({ data, ...box })).code, data).toBe('blocked');
    }
    expect(() => slide.addImage({ data: IMAGES.png, ...box })).not.toThrow();
    expect(() => slide.addImage({ data: IMAGES.jpeg.replace(/^data:/, ''), ...box })).not.toThrow();
  });

  it('media, background paths, unsafe hyperlinks and writeFile are blocked', async () => {
    const pptx = new PptxGenJS();
    const slide = pptx.addSlide() as unknown as { addMedia: (o: object) => unknown; addText: (t: unknown, o: object) => unknown; addImage: (o: object) => unknown; background: unknown };
    expect(thrown(() => slide.addMedia({ path: 'https://evil.example/a.mp4', type: 'video', ...box })).code).toBe('blocked');
    expect(thrown(() => slide.addMedia({ type: 'online', link: 'https://evil.example/v', ...box })).code).toBe('blocked');
    expect(thrown(() => (slide.background = { path: 'https://evil.example/bg.png' })).code).toBe('blocked');
    expect(thrown(() => (slide.background = { data: 'https://evil.example/bg.png' })).code).toBe('blocked');
    expect(() => (slide.background = { color: 'FFFFFF' })).not.toThrow();
    for (const url of ['javascript:alert(1)', 'http://example.com', 'file:///etc/passwd', 'data:text/html,x']) {
      expect(thrown(() => slide.addText([{ text: 'x', options: { hyperlink: { url } } }], box)).code, url).toBe('blocked');
      expect(thrown(() => slide.addImage({ data: IMAGES.png, hyperlink: { url }, ...box })).code, url).toBe('blocked');
    }
    expect(() => slide.addText([{ text: 'x', options: { hyperlink: { url: 'https://example.com' } } }], box)).not.toThrow();
    await expect((pptx as unknown as { writeFile: (o: object) => Promise<unknown> }).writeFile({ fileName: '/tmp/x.pptx' })).rejects.toMatchObject({ code: 'blocked' });
  });

  it('the vendored source holds no network or file access (AST scan) and every patch is marked', () => {
    const source = readFileSync(VENDORED, 'utf8');
    const sf = ts.createSourceFile('pptxgen.es.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const found: string[] = [];
    const BANNED_IDS = ['XMLHttpRequest', 'fetch', 'FileReader', 'Image', 'require', 'readFileSync', 'writeFile', 'createElement'];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) found.push('import()');
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text !== 'jszip') found.push(`import ${node.moduleSpecifier.text}`);
      if (ts.isStringLiteralLike(node) && /^node:/.test(node.text)) found.push(`'${node.text}'`);
      if (ts.isIdentifier(node) && BANNED_IDS.indexOf(node.text) !== -1) {
        const p = node.parent;
        const isUse = (ts.isNewExpression(p) && p.expression === node) || (ts.isCallExpression(p) && p.expression === node) || (ts.isPropertyAccessExpression(p) && p.name === node && ts.isCallExpression(p.parent));
        // `writeFile` / `writeFileToBrowser` survive only as methods that reject (P7).
        if (isUse) found.push(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    expect(found).toEqual([]);
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) expect(source, `P${n}`).toContain(`[DreamStream P${n}]`);
    expect(source.split('\n')[0]).toBe('/* PptxGenJS 4.0.1 @ 2025-06-25T23:35:35.098Z */');
  });

  it('every edit of scripts/pptxgenjs-patches.json is in the vendored file, once, and P0–P10 are all there', () => {
    const source = readFileSync(VENDORED, 'utf8');
    const { edits, upstream } = JSON.parse(readFileSync(here('../scripts/pptxgenjs-patches.json'), 'utf8')) as { edits: { patch: string; new: string }[]; upstream: { version: string } };
    for (const e of edits) expect(source.split(e.new).length - 1, e.patch).toBe(1);
    expect(Array.from(new Set(edits.map((e) => e.patch)))).toEqual(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8', 'P9', 'P10']);
    expect(upstream.version).toBe(/PptxGenJS (\d+\.\d+\.\d+)/.exec(source)![1]);
  });

  it('the licence policy records the vendored copy at the same version, with its LICENSE and PATCHES.md', () => {
    const policy = JSON.parse(readFileSync(here('../../../scripts/licence-policy.json'), 'utf8')) as {
      vendored: { records: { path: string; name: string; version: string; licence: string; scope: string }[] };
    };
    const rec = policy.vendored.records.filter((r) => r.path === 'packages/platform-render/src/vendor/pptxgenjs')[0];
    expect(rec).toMatchObject({ name: 'pptxgenjs', licence: 'MIT', scope: 'browser' });
    const banner = /PptxGenJS (\d+\.\d+\.\d+)/.exec(readFileSync(VENDORED, 'utf8'))![1];
    expect(rec.version).toBe(banner);
    expect(readFileSync(here('./vendor/pptxgenjs/LICENSE'), 'utf8')).toMatch(/^The MIT License \(MIT\)\s+Copyright \(c\) 2015-2022 Brent Ely/);
    expect(readFileSync(here('./vendor/pptxgenjs/PATCHES.md'), 'utf8')).toContain(`pptxgenjs@${banner}`);
  });
});

describe('renderPptx: images', () => {
  const imageDeck = (dataUri: string): DeckSpec => deckOf([{ kind: 'image', id: 'i', rect: [0.1, 0.1, 0.5, 0.5], layer: 'content', alt: 'x', ref: { kind: 'data', dataUri } }]);

  it('path:, http:, https: and file: image sources throw blocked; nothing is fetched', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const xhr = vi.spyOn(XMLHttpRequest.prototype, 'open');
    for (const src of ['https://evil.example/x.png', 'http://evil.example/x.png', 'file:///etc/passwd', 'path:x.png', '/etc/passwd']) {
      expect((await refusal(renderPptx(imageDeck(src)))).code, src).toBe('blocked');
      const viaHost = deckOf([{ kind: 'image', id: 'i', rect: [0.1, 0.1, 0.5, 0.5], layer: 'content', alt: 'x', ref: { kind: 'asset', id: 'a' } }]);
      expect((await refusal(renderPptx(viaHost, { resolveAsset: () => src }))).code, `resolver → ${src}`).toBe('blocked');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
  });

  it('contain keeps the whole picture inside its box; cover crops it to fill', async () => {
    const deck = deckOf([
      { kind: 'image', id: 'c', rect: [0, 0, 0.5, 1], layer: 'content', alt: 'contain', fit: 'contain', ref: { kind: 'data', dataUri: IMAGES.png } },
      { kind: 'image', id: 'v', rect: [0.5, 0, 0.5, 1], layer: 'content', alt: 'cover', fit: 'cover', ref: { kind: 'data', dataUri: IMAGES.png } },
    ]);
    const xml = text(await zipParts(await renderPptx(deck)), 'ppt/slides/slide1.xml').replace(/>\s+</g, '><');
    // 16:9 is 10 × 5.625 in; a 5 × 5.625 in box. Contain: 4:3 at 5 in wide = 3.75 in tall, centred vertically.
    const emu = (inch: number): number => Math.round(inch * 914400);
    expect(xml).toContain(`<a:off x="0" y="${emu((5.625 - 3.75) / 2)}"/><a:ext cx="${emu(5)}" cy="${emu(3.75)}"/>`);
    expect(xml).toMatch(/<a:srcRect l="\d+" r="\d+" t="0" b="0"\/>/);
    expect(xml).toContain(`<a:off x="${emu(5)}" y="0"/><a:ext cx="${emu(5)}" cy="${emu(5.625)}"/>`);
  });

  it('WebP needs a transcoder; an unknown asset id is asset-missing', async () => {
    expect((await refusal(renderPptx(imageDeck(IMAGES.webp)))).code).toBe('unsupported');
    await expect(renderPptx(imageDeck(IMAGES.webp), { transcode: fakeTranscode })).resolves.toBeInstanceOf(Uint8Array);
    const asset = deckOf([{ kind: 'image', id: 'i', rect: [0.1, 0.1, 0.5, 0.5], layer: 'content', alt: 'x', ref: { kind: 'asset', id: 'nope' } }]);
    expect((await refusal(renderPptx(asset))).code).toBe('asset-missing');
  });
});

describe('renderPptx: export is refused while content elements overlap', () => {
  const fx = renderFixture<{ deck: DeckSpec; expected: SlideOverlap[]; fixedChartRect: [number, number, number, number] }>('deck/overlap.json');

  it('the SmartArt-over-chart deck is refused with every pair named, before anything is drawn', async () => {
    const err = await refusal(renderPptx(fx.deck));
    expect(err.code).toBe('overlap');
    expect(err.message).toContain('slide 2');
    expect(err.overlaps!.map((o) => ({ ...o, area: Math.round(o.area * 1000) / 1000 }))).toEqual(fx.expected);
  });

  it('with the chart moved clear, the same deck exports', async () => {
    const fixed: DeckSpec = JSON.parse(JSON.stringify(fx.deck));
    const chart = fixed.slides[1].elements.filter((e) => e.id === 'chart')[0];
    chart.rect = fx.fixedChartRect;
    const bytes = await renderPptx(fixed);
    expect(Object.keys(await zipParts(bytes))).toContain('ppt/charts/chart' + /chart(\d+)\.xml/.exec(Object.keys(await zipParts(bytes)).join(' '))![1] + '.xml');
  });

  it('contentOverlaps: touching edges do not count, background never counts, a line through a box counts with area 0', () => {
    const slide = (elements: DeckElement[]): Slide => ({ id: 's', layout: 'content', elements });
    const shape = (id: string, rect: [number, number, number, number], layer: 'content' | 'background' = 'content'): DeckElement => ({ kind: 'shape', id, rect, layer, shape: rect[2] === 0 || rect[3] === 0 ? 'line' : 'rect' });
    expect(contentOverlaps(slide([shape('a', [0, 0, 0.5, 0.5]), shape('b', [0.5, 0, 0.5, 0.5])]))).toEqual([]);
    expect(contentOverlaps(slide([shape('a', [0, 0, 1, 1], 'background'), shape('b', [0.2, 0.2, 0.2, 0.2])]))).toEqual([]);
    expect(contentOverlaps(slide([shape('box', [0.1, 0.1, 0.4, 0.4]), shape('rule', [0, 0.3, 1, 0])]))).toEqual([{ a: 'box', b: 'rule', area: 0 }]);
    expect(contentOverlaps(slide([shape('rule', [0, 0.1, 1, 0]), shape('box', [0.1, 0.1, 0.4, 0.4])]))).toEqual([]); // along the edge
    const [pair] = contentOverlaps(slide([shape('a', [0, 0, 0.5, 0.5]), shape('b', [0.25, 0.25, 0.5, 0.5])]));
    expect(pair.a).toBe('a');
    expect(pair.area).toBeCloseTo(0.0625, 10);
  });

  it('a flat element that is not a line shape is squashed: it collides with whatever it touches, as platform-core overlapCheck says', async () => {
    const slide = (elements: DeckElement[]): Slide => ({ id: 's', layout: 'content', elements });
    const text = (id: string, rect: [number, number, number, number]): DeckElement => ({ kind: 'text', id, rect, layer: 'content', paragraphs: [{ runs: [{ text: id }] }] });
    const chart: DeckElement = { kind: 'chart', id: 'chart', rect: [0.1, 0.2, 0.8, 0.7], layer: 'content', chart: 'bar', categories: ['a'], series: [{ name: 's', values: [1] }] };
    // A zero-height text box beside a box it only touches: checkDeckSpec refuses it (only a line shape may be flat)
    // before the overlap rule runs, so renderPptx never draws it.
    const seen: string[] = [];
    const err = await refusal(renderPptx(deckOf([text('label', [0.1, 0.85, 0.8, 0]), { kind: 'shape', id: 'box', rect: [0.1, 0.85, 0.2, 0.1], layer: 'content', shape: 'rect' }]), { overlapCheck: (s) => (seen.push(s.id), []) }));
    expect(err.code).toBe('invalid');
    expect(err.message).toContain('slides[0].elements[0].rect[3]');
    expect(seen).toEqual([]);
    // The same cases platform-core's overlapCheck pins: on a chart's top edge, two stacked at one y, a flat table.
    expect(contentOverlaps(slide([chart, text('label', [0.1, 0.2, 0.8, 0])]))).toEqual([{ a: 'chart', b: 'label', area: 0 }]);
    expect(contentOverlaps(slide([text('one', [0.1, 0.5, 0.8, 0]), text('two', [0.1, 0.5, 0.8, 0])]))).toEqual([{ a: 'one', b: 'two', area: 0 }]);
    expect(contentOverlaps(slide([chart, { kind: 'table', id: 'tbl', rect: [0.9, 0.3, 0, 0.05], layer: 'content', rows: [] }]))).toEqual([{ a: 'chart', b: 'tbl', area: 0 }]);
    // A squashed box that touches nothing is no overlap; a line shape lying on the chart's edge still is none either.
    expect(contentOverlaps(slide([chart, text('far', [0.1, 0.95, 0.8, 0])]))).toEqual([]);
    expect(contentOverlaps(slide([chart, { kind: 'shape', id: 'rule', rect: [0.1, 0.2, 0.8, 0], layer: 'content', shape: 'line' }]))).toEqual([]);
  });

  it('a host can pass its own overlap rule (platform-core overlapCheck)', async () => {
    const seen: string[] = [];
    const err = await refusal(renderPptx(deckOf([]), { overlapCheck: (s) => (seen.push(s.id), [{ a: 'x', b: 'y', area: 0.5 }]) }));
    expect(seen).toEqual(['s1']);
    expect(err.overlaps).toEqual([{ slideId: 's1', slideNumber: 1, a: 'x', b: 'y', area: 0.5 }]);
  });

  it('contentOverlaps IS platform-core overlapCheck (no copy of the rule is left here)', () => {
    expect(contentOverlaps).toBe(overlapCheck);
    const source = readFileSync(here('./pptx.ts'), 'utf8');
    for (const copy of ['const crosses', 'const touches', 'const overlapOf', 'interface Box']) expect(source).not.toContain(copy);
  });

  it('checkDeckSpec runs first: the overlap rule and the drawing read only the checked copy, never the caller\'s objects', async () => {
    const deck = deckOf([{ kind: 'shape', id: 'a', rect: [0.1, 0.1, 0.2, 0.2], layer: 'content', shape: 'rect' }]);
    const slides: Slide[] = [];
    await renderPptx(deck, { overlapCheck: (s) => (slides.push(s), []) });
    expect(slides).toHaveLength(1);
    expect(slides[0]).toEqual(deck.slides[0]);
    expect(slides[0]).not.toBe(deck.slides[0]);
    // A repeated element id (checkDeckSpec's duplicate-id) is invalid; the overlap rule is never asked.
    const twice = deckOf([{ kind: 'shape', id: 'a', rect: [0.1, 0.1, 0.2, 0.2], layer: 'content', shape: 'rect' }, { kind: 'shape', id: 'a', rect: [0.5, 0.5, 0.2, 0.2], layer: 'content', shape: 'rect' }]);
    const asked: string[] = [];
    const err = await refusal(renderPptx(twice, { overlapCheck: (s) => (asked.push(s.id), []) }));
    expect(err.code).toBe('invalid');
    expect(err.message).toContain('slides[0].elements[1].id');
    expect(asked).toEqual([]);
  });

  it('every deck fixture the renderer uses is a valid DeckSpec (checkDeckSpec)', () => {
    const decks: [string, unknown][] = [
      ['render deck/dark-4x3.json', renderFixture('deck/dark-4x3.json')],
      ['render deck/overlap.json', fx.deck],
      ['contract deck/full.json', contractFixture('deck/full.json')],
    ];
    const fixed = JSON.parse(JSON.stringify(fx.deck)) as DeckSpec;
    fixed.slides[1].elements.filter((e) => e.id === 'chart')[0].rect = fx.fixedChartRect;
    decks.push(['render deck/overlap.json with the chart moved', fixed]);
    for (const [name, deck] of decks) expect(checkDeckSpec(deck).errors, name).toBeUndefined();
  });

  it('outlineToDeck (deckOutline.v1, what deck_create exports) lays out valid, overlap-free decks that render', async () => {
    const O = DECK_OUTLINE_LIMITS;
    const x = (n: number, c = 'x'): string => c.repeat(n);
    const column = (side: string): string[] => Array.from({ length: O.bullets }, (_, b) => `${side}${b} ${x(O.bullet - 2 - side.length)}`);
    // prompts.test.ts's outline, and the most a model may return: 12 content slides at every cap, alternating
    // content and two-col, with the subtitle and closing slides.
    const small: DeckOutline = {
      title: 'The Lighthouse Keeper',
      subtitle: 'An all-ages fantasy graphic novel',
      slides: [
        { layout: 'section', title: 'The story' },
        { layout: 'content', title: 'Logline', bullets: ['A girl inherits a lighthouse between worlds', 'One night a ship arrives empty'], notes: 'Keep it short.' },
        { layout: 'two-col', title: 'Cast', bullets: ['Mira, the keeper'], right: ['The empty ship', 'The harbour master'] },
      ],
      closing: 'Thank you',
    };
    const full: DeckOutline = {
      title: x(O.title, 'T'),
      subtitle: x(O.subtitle, 'S'),
      slides: Array.from({ length: O.slidesMax }, (_, i) =>
        i % 2 ? { layout: 'two-col' as const, title: x(O.title), bullets: column('L'), right: column('R'), notes: x(O.notes, 'n') } : { layout: 'content' as const, title: x(O.title), bullets: column('B'), notes: x(O.notes, 'n') }
      ),
      closing: x(O.closing, 'C'),
    };
    const cases: [string, DeckOutline, OutlineToDeckOptions | undefined][] = [
      ['prompts.test outline', small, undefined],
      ['prompts.test outline, 4:3 brand theme', small, { size: '4:3', theme: { preset: 'brand', background: '#ffffff', text: '#1a1915', accent: '#d97757' } }],
      ['12 content slides at every cap', full, undefined],
      ['12 content slides at every cap, 4:3 dark', full, { size: '4:3', theme: { preset: 'dark' } }],
    ];
    for (const [name, outline, options] of cases) {
      const r = outlineToDeck(outline, options);
      expect(r.errors, name).toBeUndefined();
      const deck = r.deck as DeckSpec;
      expect(deck.slides, name).toHaveLength(outline.slides.length + 2);
      expect(checkDeckSpec(deck).errors, name).toBeUndefined();
      expect(deckOverlaps(deck), name).toEqual([]);
      const parts = await zipParts(await renderPptx(deck, { brand: BRAND }));
      const slideParts = Object.keys(parts).filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
      expect(slideParts, name).toHaveLength(deck.slides.length);
    }
    expect(full.slides.filter((sl) => sl.layout === 'two-col')).toHaveLength(O.slidesMax / 2);
  });
});

describe('renderPptx: theme, text and structure', () => {
  it('preset brand takes the kit deck theme and fonts; a deck colour wins over the kit', async () => {
    const deck = deckOf([{ kind: 'text', id: 't', rect: [0.1, 0.1, 0.8, 0.2], layer: 'content', role: 'title', paragraphs: [{ runs: [{ text: 'Hi' }] }] }], { theme: { preset: 'brand' } });
    const parts = await zipParts(await renderPptx(deck, { brand: BRAND, fontFamily: FAMILIES }));
    const slide = text(parts, 'ppt/slides/slide1.xml');
    expect(slide).toContain('<p:bg><p:bgPr><a:solidFill><a:srgbClr val="F4F1EA"/>');
    expect(slide).toContain('<a:srgbClr val="0B1F33"/>');
    expect(slide).toContain('<a:latin typeface="Space Grotesk"');
    const theme = text(parts, 'ppt/theme/theme1.xml');
    expect(theme).toContain('<a:majorFont><a:latin typeface="Space Grotesk"/>');
    expect(theme).toContain('<a:minorFont><a:latin typeface="IBM Plex Sans"/>');
    const own = text(await zipParts(await renderPptx({ ...deck, theme: { preset: 'brand', background: '#101010' } }, { brand: BRAND })), 'ppt/slides/slide1.xml');
    expect(own).toContain('<a:srgbClr val="101010"/>');
    const dark = text(await zipParts(await renderPptx({ ...deck, theme: { preset: 'dark' } }, { brand: BRAND })), 'ppt/slides/slide1.xml');
    expect(dark).toContain('<a:srgbClr val="1A1915"/>');
  });

  it('background-layer elements are drawn under content ones, whatever their order', async () => {
    const deck = deckOf([
      { kind: 'text', id: 'front', rect: [0.1, 0.1, 0.8, 0.2], layer: 'content', paragraphs: [{ runs: [{ text: 'Front' }] }] },
      { kind: 'shape', id: 'back', rect: [0, 0, 1, 1], layer: 'background', shape: 'rect', fill: '#123456' },
    ]);
    const xml = text(await zipParts(await renderPptx(deck)), 'ppt/slides/slide1.xml');
    expect(xml.indexOf('name="shape back"')).toBeGreaterThan(-1);
    expect(xml.indexOf('name="shape back"')).toBeLessThan(xml.indexOf('name="text front"'));
  });

  it('every XML part is well-formed, with one <a:pPr> per paragraph (P8)', async () => {
    const parts = await zipParts(await renderPptx(contractFixture<DeckSpec>('deck/full.json'), { resolveAsset: () => IMAGES.png }));
    for (const name of Object.keys(parts).filter((n) => /\.(xml|rels)$/.test(n))) {
      const dom = parseXml(text(parts, name), name);
      const paras = dom.getElementsByTagName('a:p');
      for (let i = 0; i < paras.length; i++) {
        let n = 0;
        for (let c = paras[i].firstElementChild; c; c = c.nextElementSibling) if (c.tagName === 'a:pPr') n++;
        expect(n, `${name} paragraph ${i}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it('links stay only when https: or mailto: (any other refuses the deck before drawing); markup-looking text is escaped; notes are written', async () => {
    const deck = deckOf([
      {
        kind: 'text',
        id: 't',
        rect: [0.1, 0.1, 0.8, 0.5],
        layer: 'content',
        paragraphs: [{ runs: [{ text: 'ok', link: { href: 'https://example.com' } }, { text: ' <b>&' }] }],
      },
    ]);
    deck.slides[0].notes = 'Say <hello>';
    const parts = await zipParts(await renderPptx(deck));
    const rels = text(parts, 'ppt/slides/_rels/slide1.xml.rels');
    expect(rels).toContain('Target="https://example.com"');
    expect(text(parts, 'ppt/slides/slide1.xml')).toContain('&lt;b&gt;&amp;');
    expect(text(parts, 'ppt/notesSlides/notesSlide1.xml')).toContain('Say &lt;hello&gt;');
    for (const href of ['javascript:alert(1)', 'http://example.com', 'data:text/html,x']) {
      const bad = deckOf([{ kind: 'text', id: 't', rect: [0.1, 0.1, 0.8, 0.5], layer: 'content', paragraphs: [{ runs: [{ text: 'bad', link: { href } }] }] }]);
      const err = await refusal(renderPptx(bad));
      expect(err.code, href).toBe('blocked');
      expect(err.message, href).toContain('slides[0].elements[0].paragraphs[0].runs[0].link.href');
    }
  });

  it('speaker notes are one <a:p> per line, an empty line an empty <a:p/>, no line break inside a run (P10)', async () => {
    const notesBody = (xml: string): Element[] => {
      const dom = parseXml(xml, 'notesSlide');
      const shapes = Array.from(dom.getElementsByTagName('p:sp'));
      const body = shapes.filter((sp) => {
        const ph = sp.getElementsByTagName('p:ph')[0];
        return !!ph && ph.getAttribute('type') === 'body' && ph.getAttribute('idx') === '1';
      });
      expect(body).toHaveLength(1);
      const txBody = body[0].getElementsByTagName('p:txBody')[0];
      return Array.from(txBody.children).filter((c) => c.tagName === 'a:p');
    };
    const lineOf = (p: Element): string | null => (p.firstElementChild ? Array.from(p.getElementsByTagName('a:t')).map((t) => t.textContent).join('') : null);

    const deck = deckOf([{ kind: 'text', id: 't', rect: [0.1, 0.1, 0.8, 0.2], layer: 'content', paragraphs: [{ runs: [{ text: 'Page 1' }] }] }]);
    deck.slides[0].notes = 'Panel 1\nCaption: Old Delhi.\n\nPanel 2';
    deck.slides.push({ id: 's2', layout: 'content', elements: [] });
    const parts = await zipParts(await renderPptx(deck));
    const xml = text(parts, 'ppt/notesSlides/notesSlide1.xml');
    const paras = notesBody(xml);
    expect(paras).toHaveLength(4);
    expect(paras.map(lineOf)).toEqual(['Panel 1', 'Caption: Old Delhi.', null, 'Panel 2']);
    expect(paras[2].childNodes).toHaveLength(0);
    for (const t of Array.from(parseXml(xml).getElementsByTagName('a:t'))) expect(t.textContent).not.toMatch(/[\r\n]/);
    expect(xml).not.toMatch(/<a:t>[^<]*[\r\n]/);
    // A slide without notes still has a body paragraph: one empty <a:p/> (a txBody needs at least one).
    const empty = notesBody(text(parts, 'ppt/notesSlides/notesSlide2.xml'));
    expect(empty.map(lineOf)).toEqual([null]);
  });

  it('chart and table text that looks like markup is escaped; ids, numbers and characters the contract refuses never reach the file', async () => {
    const deck = deckOf([
      { kind: 'chart', id: 'cx', rect: [0, 0, 0.5, 0.5], layer: 'content', chart: 'bar', title: 'A <b>&"title"', categories: ['<i>', 'x&y'], series: [{ name: 'S&P <1>', values: [1, 2] }] },
      { kind: 'table', id: 't', rect: [0.5, 0, 0.5, 0.5], layer: 'content', header: true, rows: [{ cells: [{ runs: [{ text: '<td>&' }] }] }] },
    ]);
    const parts = await zipParts(await renderPptx(deck));
    for (const name of Object.keys(parts).filter((n) => /\.(xml|rels)$/.test(n))) parseXml(text(parts, name), name);
    const chart = text(parts, Object.keys(parts).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))[0]);
    expect(chart).toContain('A &lt;b&gt;&amp;&quot;title&quot;');
    expect(chart).toContain('&lt;i&gt;');
    expect(chart).toContain('<c:v>x&amp;y</c:v>');
    expect(text(parts, 'ppt/slides/slide1.xml')).toContain('name="chart cx"');
    expect(text(parts, 'ppt/slides/slide1.xml')).toContain('&lt;td&gt;&amp;');
    // A shape-name breakout id, a NaN value and a control character are refused by checkDeckSpec as invalid.
    const chartWith = (patch: Partial<DeckElement>): DeckSpec => deckOf([{ kind: 'chart', id: 'cx', rect: [0, 0, 0.5, 0.5], layer: 'content', chart: 'bar', categories: ['a', 'b'], series: [{ name: 's', values: [1, 2] }], ...patch } as DeckElement]);
    const cases: [string, DeckSpec, string][] = [
      ['breakout id', chartWith({ id: 'c"><x' }), 'slides[0].elements[0].id'],
      ['NaN value', chartWith({ series: [{ name: 's', values: [1, NaN] }] } as Partial<DeckElement>), 'slides[0].elements[0].series[0].values[1]'],
      ['control character', chartWith({ categories: ['a', `x${String.fromCharCode(2)}y`] } as Partial<DeckElement>), 'slides[0].elements[0].categories[1]'],
    ];
    for (const [name, bad, path] of cases) {
      const err = await refusal(renderPptx(bad));
      expect(err.code, name).toBe('invalid');
      expect(err.message, name).toContain(path);
    }
  });

  it('metadata names the deck and the kit, never the library: the presentation and every chart workbook (P9)', async () => {
    const chart: DeckElement = { kind: 'chart', id: 'c', rect: [0.1, 0.1, 0.8, 0.8], layer: 'content', chart: 'bar', categories: ['Jan', 'Feb'], series: [{ name: 'Readers', values: [3, 5] }] };
    const parts = await zipParts(await renderPptx(deckOf([chart]), { brand: BRAND }));
    const core = text(parts, 'docProps/core.xml');
    expect(core).toContain('<dc:title>Test deck</dc:title>');
    expect(core).toContain('<dc:creator>Harbor Press</dc:creator>');
    expect(core).not.toMatch(/PptxGenJS/i);
    // PowerPoint's "Edit Data" opens the chart's embedded workbook; its own properties name the kit too.
    const workbooks = Object.keys(parts).filter((n) => /^ppt\/embeddings\/.+\.xlsx$/.test(n));
    expect(workbooks).toHaveLength(1);
    const inner = await zipParts(parts[workbooks[0]]);
    const innerCore = text(inner, 'docProps/core.xml');
    expect(innerCore).toContain('<dc:creator>Harbor Press</dc:creator>');
    expect(innerCore).toContain('<cp:lastModifiedBy>Harbor Press</cp:lastModifiedBy>');
    for (const name of Object.keys(inner)) if (/\.(xml|rels)$/.test(name)) expect(text(inner, name), name).not.toMatch(/PptxGenJS/i);
    // A kit name is escaped there like everywhere else, and the workbook stays well-formed.
    const tricky = await zipParts(await renderPptx(deckOf([chart]), { brand: { ...BRAND, name: 'Ink & <Paper>' } }));
    const trickyCore = text(await zipParts(tricky[Object.keys(tricky).filter((n) => /\.xlsx$/.test(n))[0]]), 'docProps/core.xml');
    expect(trickyCore).toContain('<dc:creator>Ink &amp; &lt;Paper&gt;</dc:creator>');
    parseXml(trickyCore, 'workbook docProps/core.xml');
  });

  it('not a DeckSpec v1 is invalid; more slides or elements than the contract allows is too-large', async () => {
    expect((await refusal(renderPptx({ ...deckOf([]), v: 2 } as unknown as DeckSpec))).code).toBe('invalid');
    const many = { ...deckOf([]), slides: Array.from({ length: DECK_LIMITS.slides + 1 }, (_, i) => ({ id: `s${i}`, layout: 'content' as const, elements: [] })) };
    expect((await refusal(renderPptx(many))).code).toBe('too-large');
    const crowded = deckOf(Array.from({ length: DECK_LIMITS.elementsPerSlide + 1 }, (_, i) => ({ kind: 'shape' as const, id: `e${i}`, rect: [0, 0, 0.01, 0.01] as [number, number, number, number], layer: 'background' as const, shape: 'rect' as const })));
    expect((await refusal(renderPptx(crowded))).code).toBe('too-large');
  });
});
