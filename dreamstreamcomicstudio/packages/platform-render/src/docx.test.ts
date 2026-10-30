// @vitest-environment jsdom
//
// renderDocx (plan §12 W1.7): BrandKit styles reach the file, page breaks are sections, images are data: images we
// hold (a path or a URL throws `blocked`, nothing is fetched), unsafe links lose their link, text is escaped and
// cleaned, and every limit and failure has its own RenderError code. The normalised-XML goldens are in golden.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocBlock, RichDoc } from '../../platform-core/src/contract/richdoc.js';
import { RICHDOC_LIMITS } from '../../platform-core/src/contract/richdoc.js';
import { renderDocx } from './docx.js';
import { RenderError } from './errors.js';
import { TRANSCODED_MAX_BYTES } from './images.js';
import { BRAND, FAMILIES, IMAGES, contractFixture, fakeTranscode, parseXml, renderFixture, text, zipParts } from './render.testkit.js';

const docOf = (blocks: DocBlock[], extra: Partial<RichDoc> = {}): RichDoc => ({ v: 1, title: 'Test', sections: [{ id: 's1', pageBreakBefore: false, blocks }], ...extra });

const imageDoc = (dataUri: string): RichDoc => docOf([{ type: 'image', id: 'i1', ref: { kind: 'data', dataUri }, alt: 'x' }]);

const refusal = async (p: Promise<unknown>): Promise<RenderError> => {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(RenderError);
    return err as RenderError;
  }
  throw new Error('expected a RenderError, got a file');
};

/** One `<w:style>` element of styles.xml by id. */
const styleXml = (styles: string, id: string): string => {
  const m = new RegExp(`<w:style [^>]*w:styleId="${id}"[^>]*>[\\s\\S]*?</w:style>`).exec(styles);
  if (!m) throw new Error(`no style ${id}`);
  return m[0];
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('renderDocx: BrandKit styles', () => {
  const doc = docOf([
    { type: 'heading', id: 'h1', level: 1, runs: [{ text: 'One' }] },
    { type: 'heading', id: 'h2', level: 2, runs: [{ text: 'Two' }] },
    { type: 'heading', id: 'h3', level: 3, runs: [{ text: 'Three' }] },
    { type: 'paragraph', id: 'p', runs: [{ text: 'Body ' }, { text: 'link', link: { href: 'https://example.com' } }] },
  ]);

  it('headings take the kit heading font, colour and sizes; body, links and quotes take theirs', async () => {
    const styles = text(await zipParts(await renderDocx(doc, { brand: BRAND, fontFamily: FAMILIES })), 'word/styles.xml');
    const sizes: { [id: string]: number } = { Heading1: 28, Heading2: 20, Heading3: 15 };
    for (const id of Object.keys(sizes)) {
      const xml = styleXml(styles, id);
      expect(xml).toContain('w:ascii="Space Grotesk"');
      expect(xml).toContain('w:hAnsi="Space Grotesk"');
      expect(xml).toContain('<w:color w:val="0B1F33"/>');
      expect(xml).toContain(`<w:sz w:val="${sizes[id] * 2}"/>`);
      expect(xml).toContain('<w:b/>');
    }
    const defaults = /<w:docDefaults>[\s\S]*?<\/w:docDefaults>/.exec(styles)![0];
    expect(defaults).toContain('w:ascii="IBM Plex Sans"');
    expect(defaults).toContain('<w:color w:val="222222"/>');
    expect(defaults).toContain('<w:sz w:val="21"/>');
    expect(defaults).toContain('w:line="300"'); // 1.25 × 240
    expect(styleXml(styles, 'Hyperlink')).toContain('<w:color w:val="0B5CAD"/>');
    expect(styleXml(styles, 'Quote')).toContain('w:color="0B5CAD"');
    expect(styleXml(styles, 'Caption')).toContain('<w:color w:val="5C6470"/>');
  });

  it('without a kit the DreamStream defaults apply, and a registry id without a resolver still names its family', async () => {
    const styles = text(await zipParts(await renderDocx(doc)), 'word/styles.xml');
    expect(styleXml(styles, 'Heading1')).toContain('w:ascii="Inter"');
    expect(styleXml(styles, 'Heading1')).toContain('<w:color w:val="1A1915"/>');
    const noResolver = text(await zipParts(await renderDocx(doc, { brand: BRAND })), 'word/styles.xml');
    expect(styleXml(noResolver, 'Heading1')).toContain('w:ascii="Space Grotesk"');
  });

  it('a font name that is not a plain name never reaches the XML', async () => {
    const evil = { ...BRAND, docStyles: { ...BRAND.docStyles, headingFont: 'X" w:hAnsi="Evil', headingColor: 'red;' } };
    const styles = text(await zipParts(await renderDocx(doc, { brand: evil })), 'word/styles.xml');
    expect(styles).not.toContain('Evil');
    expect(styleXml(styles, 'Heading1')).toContain('w:ascii="Calibri"');
    expect(styleXml(styles, 'Heading1')).toContain('<w:color w:val="222222"/>'); // falls back to the body colour
    parseXml(styles, 'styles.xml');
  });
});

describe('renderDocx: structure', () => {
  it('page breaks are sections: next-page and continuous breaks, never a page break inside a paragraph', async () => {
    const parts = await zipParts(await renderDocx(renderFixture<RichDoc>('richdoc/script.json'), { resolveAsset: () => IMAGES.png }));
    const xml = text(parts, 'word/document.xml');
    expect(xml.match(/<w:sectPr>/g)!.length).toBe(4);
    expect(xml.match(/<w:type w:val="nextPage"\/>/g)!.length).toBe(2);
    expect(xml.match(/<w:type w:val="continuous"\/>/g)!.length).toBe(1);
    expect(xml).not.toContain('w:pageBreakBefore');
    expect(xml).not.toContain('w:type="page"');
    // The divider that ends the first section keeps its own border (the break did not restyle it).
    expect(xml).toMatch(/<w:pBdr><w:bottom w:val="single"[^>]*\/><\/w:pBdr><w:sectPr>/);
  });

  it('comic script blocks get their own styles, labels and panel numbers', async () => {
    const xml = text(await zipParts(await renderDocx(renderFixture<RichDoc>('richdoc/script.json'), { resolveAsset: () => IMAGES.png })), 'word/document.xml');
    for (const id of ['ScriptScene', 'ScriptPanel', 'ScriptDialogue', 'ScriptSfx']) expect(xml).toContain(`<w:pStyle w:val="${id}"/>`);
    expect(xml).toContain('>Panel 1<');
    expect(xml).toContain('>Panel 2<');
    expect(xml).toContain('>MARA<');
    expect(xml).toContain('>SFX<');
    // A line break inside a run is a break, not a new paragraph.
    expect(xml).toMatch(/>Last stop\.<\/w:t><\/w:r><w:r><w:br\/><w:t xml:space="preserve">Everyone off\.</);
  });

  it('every XML part is well-formed and markup-looking text is escaped', async () => {
    const parts = await zipParts(await renderDocx(renderFixture<RichDoc>('richdoc/script.json'), { resolveAsset: () => IMAGES.png }));
    for (const name of Object.keys(parts)) if (/\.(xml|rels)$/.test(name)) parseXml(text(parts, name), name);
    const xml = text(parts, 'word/document.xml');
    expect(xml).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp;');
    expect(xml).not.toContain('<script');
  });

  it('control and bidi-override characters are removed from text', async () => {
    const xml = text(await zipParts(await renderDocx(docOf([{ type: 'paragraph', id: 'p', runs: [{ text: `a${String.fromCharCode(1)}b${String.fromCharCode(0x202e)}c` }] }]))), 'word/document.xml');
    expect(xml).toContain('>abc<');
  });

  it('a link is kept only when it is https: or mailto:; the text always stays', async () => {
    const doc = docOf([
      {
        type: 'paragraph',
        id: 'p',
        runs: [
          { text: 'good', link: { href: 'https://example.com/a' } },
          { text: 'mail', link: { href: 'mailto:a@example.com' } },
          { text: 'js', link: { href: 'javascript:alert(1)' } },
          { text: 'data', link: { href: 'data:text/html,<b>x</b>' } },
          { text: 'http', link: { href: 'http://example.com' } },
          { text: 'file', link: { href: 'file:///etc/passwd' } },
        ],
      },
    ]);
    const parts = await zipParts(await renderDocx(doc));
    const rels = text(parts, 'word/_rels/document.xml.rels');
    const targets = (rels.match(/TargetMode="External"/g) || []).length;
    expect(targets).toBe(2);
    expect(rels).toContain('Target="https://example.com/a"');
    expect(rels).toContain('Target="mailto:a@example.com"');
    const allTargets = (rels.match(/Target="[^"]*"/g) || []).join(' ');
    expect(allTargets).not.toMatch(/javascript|data:|http:\/\/|file:/);
    const xml = text(parts, 'word/document.xml');
    for (const t of ['>js<', '>data<', '>http<', '>file<']) expect(xml).toContain(t);
  });
});

describe('renderDocx: images are data: images we hold, never a path or a URL', () => {
  const sources = ['https://evil.example/x.png', 'http://evil.example/x.png', 'file:///etc/passwd', '/etc/passwd', 'img/cover.png', 'path:cover.png', '//evil.example/x.png'];

  it('a path or URL as the image source throws blocked, and nothing is fetched', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const xhr = vi.spyOn(XMLHttpRequest.prototype, 'open');
    for (const src of sources) {
      expect((await refusal(renderDocx(imageDoc(src)))).code, src).toBe('blocked');
      const viaHost = await refusal(renderDocx(docOf([{ type: 'image', id: 'i', ref: { kind: 'asset', id: 'a1' }, alt: 'x' }]), { resolveAsset: () => src }));
      expect(viaHost.code, `resolver → ${src}`).toBe('blocked');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhr).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('SVG and other non-photo data: images are blocked; a forged header is invalid', async () => {
    expect((await refusal(renderDocx(imageDoc('data:image/svg+xml;base64,PHN2Zy8+')))).code).toBe('blocked');
    expect((await refusal(renderDocx(imageDoc('data:text/html;base64,PGI+')))).code).toBe('blocked');
    expect((await refusal(renderDocx(imageDoc(IMAGES.jpeg.replace('image/jpeg', 'image/png'))))).code).toBe('invalid');
  });

  it('PNG and JPEG embed with their aspect ratio; width is a fraction of the text column', async () => {
    const doc = docOf([
      { type: 'image', id: 'a', ref: { kind: 'data', dataUri: IMAGES.png }, alt: 'png', width: 0.5 },
      { type: 'image', id: 'b', ref: { kind: 'data', dataUri: IMAGES.jpeg }, alt: 'jpeg', width: 1 },
    ]);
    const parts = await zipParts(await renderDocx(doc));
    expect(Object.keys(parts).filter((n) => n.lastIndexOf('word/media/', 0) === 0).map((n) => n.split('.').pop()).sort()).toEqual(['jpg', 'png']);
    const xml = text(parts, 'word/document.xml');
    // Letter: 6.5 in of text = 624 px; half of it is 312 px wide, and 4 × 3 px keeps 4:3 (9525 EMU per px).
    expect(xml).toContain(`<wp:extent cx="${312 * 9525}" cy="${234 * 9525}"/>`);
    expect(xml).toContain(`<wp:extent cx="${624 * 9525}" cy="${468 * 9525}"/>`);
    expect(xml).toContain('descr="png"');
  });

  it('a host asset id goes through the resolver; an unknown one is asset-missing', async () => {
    const doc = docOf([{ type: 'image', id: 'i', ref: { kind: 'asset', id: 'user-1/a.png' }, alt: 'x' }]);
    const seen: string[] = [];
    await renderDocx(doc, { resolveAsset: (id) => (seen.push(id), IMAGES.png) });
    expect(seen).toEqual(['user-1/a.png']);
    expect((await refusal(renderDocx(doc))).code).toBe('asset-missing');
    expect((await refusal(renderDocx(doc, { resolveAsset: () => null }))).code).toBe('asset-missing');
  });

  it('WebP needs a transcoder (unsupported without one); its output must really be PNG or JPEG', async () => {
    const doc = imageDoc(IMAGES.webp);
    expect((await refusal(renderDocx(doc))).code).toBe('unsupported');
    const parts = await zipParts(await renderDocx(doc, { transcode: fakeTranscode }));
    expect(Object.keys(parts).some((n) => /^word\/media\/.+\.png$/.test(n))).toBe(true);
    const liar = async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' as const });
    expect((await refusal(renderDocx(doc, { transcode: liar }))).code).toBe('unsupported');
    const huge = new Uint8Array(TRANSCODED_MAX_BYTES + 1);
    huge.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect((await refusal(renderDocx(doc, { transcode: async () => ({ bytes: huge, mime: 'image/png' as const }) }))).code).toBe('too-large');
  });

  it('a data: image over 5 MB is too-large', async () => {
    const big = new Uint8Array(5000001);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect((await refusal(renderDocx(imageDoc(`data:image/png;base64,${Buffer.from(big).toString('base64')}`)))).code).toBe('too-large');
  });
});

describe('renderDocx: input checks', () => {
  it('not a RichDoc v1 is invalid; past the contract caps is too-large', async () => {
    expect((await refusal(renderDocx({ ...docOf([]), v: 2 } as unknown as RichDoc))).code).toBe('invalid');
    expect((await refusal(renderDocx(null as unknown as RichDoc))).code).toBe('invalid');
    const many = { v: 1, title: 'x', sections: Array.from({ length: RICHDOC_LIMITS.sections + 1 }, (_, i) => ({ id: `s${i}`, pageBreakBefore: false, blocks: [] })) } as RichDoc;
    expect((await refusal(renderDocx(many))).code).toBe('too-large');
  });

  it('the contract fixtures render with their metadata', async () => {
    const parts = await zipParts(await renderDocx(contractFixture<RichDoc>('richdoc/full.json'), { resolveAsset: () => IMAGES.png }));
    const core = text(parts, 'docProps/core.xml');
    expect(core).toContain('<dc:title>The Lighthouse Keeper — pitch and script</dc:title>');
    expect(core).toContain('<dc:creator>Sample Creator</dc:creator>');
    expect(core).toContain('<cp:keywords>comic, pitch</cp:keywords>');
    const minimal = text(await zipParts(await renderDocx(contractFixture<RichDoc>('richdoc/minimal.json'))), 'docProps/core.xml');
    expect(minimal).toContain('<dc:creator>DreamStream</dc:creator>');
  });
});
