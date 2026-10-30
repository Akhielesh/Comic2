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
    for (const n of [0, 1, 2, 3, 4, 5, 6, 7, 8]) expect(source, `P${n}`).toContain(`[DreamStream P${n}]`);
    expect(source.split('\n')[0]).toBe('/* PptxGenJS 4.0.1 @ 2025-06-25T23:35:35.098Z */');
  });

  it('every edit of scripts/pptxgenjs-patches.json is in the vendored file, once, and P0–P8 are all there', () => {
    const source = readFileSync(VENDORED, 'utf8');
    const { edits, upstream } = JSON.parse(readFileSync(here('../scripts/pptxgenjs-patches.json'), 'utf8')) as { edits: { patch: string; new: string }[]; upstream: { version: string } };
    for (const e of edits) expect(source.split(e.new).length - 1, e.patch).toBe(1);
    expect(Array.from(new Set(edits.map((e) => e.patch)))).toEqual(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']);
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
    // A zero-height text box beside a box it only touches: drawn down from its top edge, across the box. Refused.
    const err = await refusal(renderPptx(deckOf([text('label', [0.1, 0.85, 0.8, 0]), { kind: 'shape', id: 'box', rect: [0.1, 0.85, 0.2, 0.1], layer: 'content', shape: 'rect' }])));
    expect(err.code).toBe('overlap');
    expect(err.overlaps).toEqual([{ slideId: 's1', slideNumber: 1, a: 'label', b: 'box', area: 0 }]);
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

  it('links stay only when https: or mailto:; markup-looking text is escaped; notes are written', async () => {
    const deck = deckOf([
      {
        kind: 'text',
        id: 't',
        rect: [0.1, 0.1, 0.8, 0.5],
        layer: 'content',
        paragraphs: [{ runs: [{ text: 'ok', link: { href: 'https://example.com' } }, { text: ' bad', link: { href: 'javascript:alert(1)' } }, { text: ' <b>&' }] }],
      },
    ]);
    deck.slides[0].notes = 'Say <hello>';
    const parts = await zipParts(await renderPptx(deck));
    const rels = text(parts, 'ppt/slides/_rels/slide1.xml.rels');
    expect(rels).toContain('Target="https://example.com"');
    expect(rels).not.toContain('javascript');
    expect(text(parts, 'ppt/slides/slide1.xml')).toContain('&lt;b&gt;&amp;');
    expect(text(parts, 'ppt/notesSlides/notesSlide1.xml')).toContain('Say &lt;hello&gt;');
  });

  it('chart and table text that looks like markup is escaped, and ids cannot break out of a shape name', async () => {
    const deck = deckOf([
      { kind: 'chart', id: 'c"><x', rect: [0, 0, 0.5, 0.5], layer: 'content', chart: 'bar', title: 'A <b>&"title"', categories: ['<i>', `x${String.fromCharCode(2)}y`], series: [{ name: 'S&P <1>', values: [1, NaN] }] },
      { kind: 'table', id: 't', rect: [0.5, 0, 0.5, 0.5], layer: 'content', header: true, rows: [{ cells: [{ runs: [{ text: '<td>&' }] }] }] },
    ]);
    const parts = await zipParts(await renderPptx(deck));
    for (const name of Object.keys(parts).filter((n) => /\.(xml|rels)$/.test(n))) parseXml(text(parts, name), name);
    const chart = text(parts, Object.keys(parts).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n))[0]);
    expect(chart).toContain('A &lt;b&gt;&amp;&quot;title&quot;');
    expect(chart).toContain('&lt;i&gt;');
    expect(chart).toContain('<c:v>xy</c:v>');
    expect(text(parts, 'ppt/slides/slide1.xml')).toContain('name="chart cx"');
    expect(text(parts, 'ppt/slides/slide1.xml')).toContain('&lt;td&gt;&amp;');
  });

  it('metadata names the deck and the kit, never the library', async () => {
    const core = text(await zipParts(await renderPptx(deckOf([]), { brand: BRAND })), 'docProps/core.xml');
    expect(core).toContain('<dc:title>Test deck</dc:title>');
    expect(core).toContain('<dc:creator>Harbor Press</dc:creator>');
    expect(core).not.toMatch(/PptxGenJS/i);
  });

  it('not a DeckSpec v1 is invalid; more slides or elements than the contract allows is too-large', async () => {
    expect((await refusal(renderPptx({ ...deckOf([]), v: 2 } as unknown as DeckSpec))).code).toBe('invalid');
    const many = { ...deckOf([]), slides: Array.from({ length: DECK_LIMITS.slides + 1 }, (_, i) => ({ id: `s${i}`, layout: 'content' as const, elements: [] })) };
    expect((await refusal(renderPptx(many))).code).toBe('too-large');
    const crowded = deckOf(Array.from({ length: DECK_LIMITS.elementsPerSlide + 1 }, (_, i) => ({ kind: 'shape' as const, id: `e${i}`, rect: [0, 0, 0.01, 0.01] as [number, number, number, number], layer: 'background' as const, shape: 'rect' as const })));
    expect((await refusal(renderPptx(crowded))).code).toBe('too-large');
  });
});
