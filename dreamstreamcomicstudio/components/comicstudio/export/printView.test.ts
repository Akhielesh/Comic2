import { describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { fakeUrlFor, makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import {
  PrintError,
  balloonSvgMarkup,
  buildPrintHtml,
  collectPrintSheets,
  decoratePrintDocument,
  escapeHtml,
  fitBox,
  openPrintView,
  printPageSize
} from './printView';

const withCover = (mutate?: (d: ComicDoc) => void) =>
  makeSampleDoc((d) => {
    d.cover.render = { status: 'ready', history: [], asset: { path: 'u/cover.png', source: 'generated', at: 0, w: 1000, h: 1500 } };
    mutate?.(d);
  });

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

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

  it('skips images whose links are not signed yet', () => {
    const { sheets, skipped } = collectPrintSheets(withCover(), (a) => (typeof a === 'object' && a?.path === 'u/cover.png' ? undefined : fakeUrlFor(a)));
    expect(sheets[0].key).toBe('pg_1');
    expect(skipped[0]).toBe('Cover (image link not ready yet)');
  });
});

describe('buildPrintHtml', () => {
  it('declares one zero-margin sheet per page at the comic’s size', () => {
    const doc = withCover();
    const html = buildPrintHtml(doc, collectPrintSheets(doc, fakeUrlFor).sheets);
    expect(html).toContain('@page { size: 7in 10.5in; margin: 0; }');
    expect(html).toContain('fonts.googleapis.com/css2?family=Bangers&family=Comic+Neue');
    const dom = parse(html);
    const sheets = Array.from(dom.querySelectorAll('.sheet'));
    expect(sheets.map((s) => s.getAttribute('data-label'))).toEqual(['Cover', 'Page 1', 'Page 5']);
    expect(dom.querySelector('.sheet img')!.getAttribute('src')).toBe('https://cdn.test/u/cover.png');
  });

  it('letters overlay pages with HTML balloons (escaped, uppercase, positioned)', () => {
    const doc = withCover((d) => (d.pages[0].panels[2].lines[1].text = 'Fish & <chips>'));
    const dom = parse(buildPrintHtml(doc, collectPrintSheets(doc, fakeUrlFor).sheets));
    const page1 = dom.querySelector('.sheet[data-label="Page 1"]')!;
    const balloons = page1.querySelectorAll('.b');
    expect(balloons).toHaveLength(5);
    const l4 = page1.querySelector<HTMLElement>('.b[data-line="pg_1_l4"]')!;
    expect(l4.textContent).toBe('FISH & <CHIPS>');
    const l2 = page1.querySelector<HTMLElement>('.b[data-line="pg_1_l2"]')!;
    expect(l2.style.left).toBe('6%');
    expect(l2.dataset.tx).toBe('0.2');
    expect(page1.querySelector('.b[data-kind="sfx"] .bt')!.getAttribute('style')).toMatch(/font-size:[\d.]+in;color:#/);
    expect(dom.querySelector('.sheet[data-label="Cover"] .b')).toBeNull();
  });

  it('adds no overlay balloons for in-art lettering', () => {
    const doc = withCover((d) => (d.format.lettering = 'in_art'));
    const dom = parse(buildPrintHtml(doc, collectPrintSheets(doc, fakeUrlFor).sheets));
    expect(dom.querySelectorAll('.b')).toHaveLength(0);
  });

  it('lists skipped pages in the (screen-only) toolbar', () => {
    const doc = withCover();
    const html = buildPrintHtml(doc, collectPrintSheets(doc, fakeUrlFor).sheets, { skipped: ['Page 2 (not drawn yet)'] });
    expect(html).toContain('Not included: Page 2 (not drawn yet)');
    expect(html).toContain('@media print');
  });
});

describe('balloon outlines', () => {
  it('draws speech as tail-under, body, tail-over', () => {
    const svg = balloonSvgMarkup('speech', 200, 60, { x: 100, y: 160 }, 1, 2);
    expect(svg.match(/<path/g)).toHaveLength(3);
    expect(svg).toContain('stroke-width="4"');
    expect(svg).not.toContain('dasharray');
  });

  it('dashes whispers, trails thoughts and skips sfx', () => {
    expect(balloonSvgMarkup('whisper', 200, 60, { x: 100, y: 160 }, 1, 2)).toContain('stroke-dasharray');
    expect(balloonSvgMarkup('thought', 200, 60, { x: 100, y: 200 }, 1, 2)).toContain('<circle');
    expect(balloonSvgMarkup('sfx', 200, 60, null, 1, 2)).toBe('');
    expect(balloonSvgMarkup('caption', 200, 60, null, 1, 2)).toContain('#fff6c8');
  });

  it('decorates a print document with an outline per non-sfx balloon', () => {
    const doc = withCover();
    const dom = parse(buildPrintHtml(doc, collectPrintSheets(doc, fakeUrlFor).sheets));
    decoratePrintDocument(dom, doc);
    const page1 = dom.querySelector('.sheet[data-label="Page 1"]')!;
    expect(page1.querySelectorAll('.b > svg')).toHaveLength(4);
    expect(page1.querySelector('.b[data-kind="sfx"] > svg')).toBeNull();
    // Idempotent: decorating again replaces, never stacks.
    decoratePrintDocument(dom, doc);
    expect(page1.querySelectorAll('.b > svg')).toHaveLength(4);
  });
});

describe('openPrintView', () => {
  const fakeWindow = () => {
    const document = window.document.implementation.createHTMLDocument('print');
    return { document, focus: vi.fn(), print: vi.fn() } as unknown as Window & { print: ReturnType<typeof vi.fn> };
  };

  it('writes the document, decorates it and prints', async () => {
    const win = fakeWindow();
    const onStatus = vi.fn();
    const result = await openPrintView(withCover(), fakeUrlFor, { win, onStatus, timeoutMs: 5 });
    expect(win.print).toHaveBeenCalled();
    expect(win.document.querySelectorAll('.sheet')).toHaveLength(3);
    expect(win.document.querySelectorAll('.b > svg').length).toBeGreaterThan(0);
    expect(result.pages).toBe(3);
    expect(result.skipped).toHaveLength(4);
    // jsdom never loads images, so the status is honest about it.
    expect(result.failedImages).toEqual(['Cover', 'Page 1', 'Page 5']);
    expect(onStatus).toHaveBeenLastCalledWith(expect.stringMatching(/didn’t load/));
  });

  it('explains a blocked pop-up', async () => {
    await expect(openPrintView(withCover(), fakeUrlFor, { win: null })).rejects.toThrow(/Allow pop-ups/);
  });

  it('refuses when nothing is drawn', async () => {
    const doc = makeSampleDoc((d) => d.pages.forEach((p) => (p.render = { status: 'none', history: [] })));
    await expect(openPrintView(doc, fakeUrlFor, { win: fakeWindow() })).rejects.toBeInstanceOf(PrintError);
  });
});
