import { describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { languageSpec } from '../../../shared/comic/languages';
import { FONT_REGISTRY } from '../../../shared/comic/lettering/fonts';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { makeBook } from './__fixtures__/books';
import { localizedFor } from './sequence';
import { PrintError, buildPrintHtml, collectPrintSheets, decoratePrintDocument, escapeHtml, fitBox, openPrintView, printPageSize } from './printView';

const withCover = (mutate?: (d: ComicDoc) => void) =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0, w: 1000, h: 1500 } };
    mutate?.(d);
  });

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const ORIGIN = 'https://studio.test';

describe('print geometry', () => {
  it('sizes the sheet from the aspect with a 10.5in long edge', () => {
    expect(printPageSize(2 / 3)).toEqual({ widthIn: 7, heightIn: 10.5 });
    expect(printPageSize(16 / 9)).toEqual({ widthIn: 10.5, heightIn: 5.906 });
  });

  it('fits art inside a sheet without cropping', () => {
    expect(fitBox(7, 10.5, 2 / 3)).toEqual({ w: 7, h: 10.5 });
    expect(fitBox(7, 10.5, 3 / 4)).toEqual({ w: 7, h: 9.333 });
    expect(fitBox(7, 10.5, 1 / 2)).toEqual({ w: 5.25, h: 10.5 });
  });

  it('escapes HTML', () => {
    expect(escapeHtml(`<b>"Tom" & 'Jerry'</b>`)).toBe('&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;');
  });
});

describe('collectPrintSheets', () => {
  it('prints the cover first, then drawn pages; reports what it skips', () => {
    const { sheets, skipped } = collectPrintSheets(withCover(), fakeUrlFor);
    expect(sheets.map((s) => s.key)).toEqual(['cover', 'pg_1', 'pg_5']);
    expect(skipped).toEqual(['Page 2 (not drawn yet)', 'Page 3 (not drawn yet)', 'Page 4 (not drawn yet)', 'Page 6 (not drawn yet)']);
  });

  it('includes the book plates in reading order', () => {
    const { sheets } = collectPrintSheets(makeBook(), fakeUrlFor);
    expect(sheets.map((s) => `${s.kind}:${s.key}`)).toEqual(['cover:cover', 'plate:title', 'page:pg_1', 'page:pg_5', 'plate:end', 'plate:back_cover']);
  });

  it('skips images whose links are not signed yet, and never writes an unsafe URL', () => {
    const { sheets, skipped } = collectPrintSheets(withCover(), (a) => (typeof a === 'object' && a?.path === 'u/cover.png' ? undefined : fakeUrlFor(a)));
    expect(sheets[0].key).toBe('pg_1');
    expect(skipped[0]).toBe('Cover (image link not ready yet)');
    const evil = collectPrintSheets(withCover(), () => 'javascript:alert(1)');
    expect(evil.sheets).toHaveLength(0);
    expect(evil.skipped).toContain('Page 1 (image link not ready yet)');
  });
});

describe('buildPrintHtml', () => {
  it('declares one zero-margin sheet per page at the book’s trim, with the self-hosted faces', () => {
    const doc = withCover();
    const html = buildPrintHtml(doc, collectPrintSheets(doc, fakeUrlFor).sheets, { origin: ORIGIN });
    expect(html).toContain('@page { size: 7in 10.5in; margin: 0; }');
    expect(html).toContain(`font-family:"${FONT_REGISTRY['comic-neue'].family}"`);
    expect(html).toMatch(/src:url\("https:\/\/studio\.test\//);
    expect(html).not.toContain('fonts.googleapis.com'); // Latin only: no Google CSS
    const dom = parse(html);
    expect(dom.documentElement.getAttribute('lang')).toBe('en');
    expect(dom.documentElement.getAttribute('dir')).toBe('ltr');
    const sheets = Array.from(dom.querySelectorAll('.sheet'));
    expect(sheets.map((s) => s.getAttribute('data-label'))).toEqual(['Cover', 'Page 1', 'Page 5']);
    expect(dom.querySelector('.sheet img')!.getAttribute('src')).toBe('https://cdn.test/u/cover.png');
  });

  it('letters overlay pages with one vector SVG from the engine plans (escaped)', () => {
    const doc = withCover((d) => (d.pages[0].panels[2].lines[1].text = 'Fish & <chips> </text><script>alert(1)</script>'));
    const html = buildPrintHtml(doc, collectPrintSheets(doc, fakeUrlFor).sheets, { origin: ORIGIN });
    expect(html).not.toContain('<script>');
    const dom = parse(html);
    const page1 = dom.querySelector('.sheet[data-label="Page 1"]')!;
    const svg = page1.querySelector('.page > svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 1000 1500');
    expect(svg.querySelectorAll('[data-testid="balloon"]')).toHaveLength(5);
    expect(page1.querySelector('[data-line-id="pg_1_l4"]')!.textContent).toContain('FISH & <CHIPS>');
    expect(dom.querySelectorAll('script')).toHaveLength(0);
    expect(dom.querySelector('.sheet[data-label="Cover"] svg')).toBeNull(); // painted cover: nothing over it
  });

  it('adds no overlay lettering for in-art comics', () => {
    const doc = withCover((d) => (d.format.lettering = 'in_art'));
    const dom = parse(buildPrintHtml(doc, collectPrintSheets(doc, fakeUrlFor).sheets, { origin: ORIGIN }));
    expect(dom.querySelectorAll('[data-testid="balloon"]')).toHaveLength(0);
  });

  it('prints an edition: html lang, its lettering, the script face from Google CSS, the overlay cover title', () => {
    const te = localizedFor(makeBook(undefined, { overlayCover: true }), 'te');
    const html = buildPrintHtml(te, collectPrintSheets(te, fakeUrlFor).sheets, { origin: ORIGIN, urlFor: fakeUrlFor });
    const dom = parse(html);
    expect(dom.documentElement.getAttribute('lang')).toBe('te');
    const family = FONT_REGISTRY[languageSpec('te')!.fonts.dialogue].family;
    expect(html).toContain(`fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}`);
    expect(dom.querySelector('.sheet[data-label="Page 1"] svg')!.textContent).toContain('పాత దిల్లీ');
    const coverSvg = dom.querySelector('.sheet[data-label="Cover"] svg.cover-title')!;
    expect(coverSvg.textContent).toContain('కుంకుమపువ్వు దొంగ');
    // Plates are drawn as SVG with their texts; the back cover shows the cover art.
    expect(dom.querySelector('.sheet[data-label="The End"] svg')!.textContent).toContain('The End');
    expect(dom.querySelector('.sheet[data-label="Back cover"] image')!.getAttribute('href')).toBe('https://cdn.test/u/proj/cover.png');
  });

  it('lists skipped pages in the (screen-only) toolbar', () => {
    const doc = withCover();
    const html = buildPrintHtml(doc, collectPrintSheets(doc, fakeUrlFor).sheets, { skipped: ['Page 2 (not drawn yet)'], origin: ORIGIN });
    expect(html).toContain('Not included: Page 2 (not drawn yet)');
    expect(html).toContain('@media print');
  });
});

describe('decoratePrintDocument', () => {
  it('re-plans the lettering when the art turns out to have another shape (idempotent)', () => {
    const doc = withCover((d) => {
      d.pages[0].render.asset = { ...d.pages[0].render.asset!, w: undefined, h: undefined };
      d.format.pageAspect = '2:3';
    });
    const dom = parse(buildPrintHtml(doc, collectPrintSheets(doc, fakeUrlFor).sheets, { origin: ORIGIN }));
    const img = dom.querySelector<HTMLImageElement>('.sheet[data-label="Page 1"] img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 1000 });
    Object.defineProperty(img, 'naturalHeight', { value: 1000 });
    decoratePrintDocument(dom, doc);
    const svgs = dom.querySelectorAll('.sheet[data-label="Page 1"] .page > svg');
    expect(svgs).toHaveLength(1);
    expect(svgs[0].getAttribute('viewBox')).toBe('0 0 1000 1000');
    decoratePrintDocument(dom, doc);
    expect(dom.querySelectorAll('.sheet[data-label="Page 1"] .page > svg')).toHaveLength(1);
  });
});

describe('openPrintView', () => {
  const fakeWindow = () => {
    const document = window.document.implementation.createHTMLDocument('print');
    return { document, focus: vi.fn(), print: vi.fn(), innerWidth: 390 } as unknown as Window & { print: ReturnType<typeof vi.fn> };
  };

  it('writes the document and prints, honest about images that did not load', async () => {
    const win = fakeWindow();
    const onStatus = vi.fn();
    const result = await openPrintView(withCover(), fakeUrlFor, { win, onStatus, timeoutMs: 5 });
    expect(win.print).toHaveBeenCalled();
    expect(win.document.querySelectorAll('.sheet')).toHaveLength(3);
    expect(win.document.querySelectorAll('[data-testid="balloon"]').length).toBeGreaterThan(0);
    expect(result.pages).toBe(3);
    expect(result.skipped).toHaveLength(4);
    // jsdom never loads images, so the status is honest about it.
    expect(result.failedImages).toEqual(['Cover', 'Page 1', 'Page 5']);
    expect(onStatus).toHaveBeenLastCalledWith(expect.stringMatching(/didn’t load/));
  });

  it('prints a chosen edition', async () => {
    const win = fakeWindow();
    await openPrintView(makeBook(), fakeUrlFor, { win, timeoutMs: 5, lang: 'te' });
    expect(win.document.documentElement.getAttribute('lang')).toBe('te');
  });

  it('explains a blocked pop-up', async () => {
    await expect(openPrintView(withCover(), fakeUrlFor, { win: null })).rejects.toThrow(/Allow pop-ups/);
  });

  it('refuses when nothing is drawn', async () => {
    const doc = makeSampleDoc((d) => d.pages.forEach((p) => (p.render = { status: 'none', history: [] })));
    await expect(openPrintView(doc, fakeUrlFor, { win: fakeWindow() })).rejects.toBeInstanceOf(PrintError);
  });
});
