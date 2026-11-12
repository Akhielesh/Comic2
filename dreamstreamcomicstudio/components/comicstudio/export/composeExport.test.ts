// PE-COMPOSE in the exports: PNG / PDF / ZIP rasters and the print document draw a composed page from the page node
// tree (frames, overlays, effects, stickers, blends) and never draw a guide-only or opaque layer; a legacy page takes
// the old path (the byte-identical golden is compose/legacyGolden.test.tsx).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComicDoc } from '../../../shared/comic/doc';
import { estimateMeasure } from '../../../shared/comic/lettering/layout';
import { fakeUrlFor } from '../board/__fixtures__/sampleDoc';
import { fakePathUrl, framedDoc, LAYERS, layeredDoc, PHOTO_PATH, TAKE_PATH } from '../compose/__fixtures__/composeDocs';
import { makeQaDoc } from '../testing/qaFixtures';
import { makeBook } from './__fixtures__/books';
import { fakeContext, fakeLayers, fakePath, type FakeCtx } from './__fixtures__/fakeCanvas';
import { exportComicPdf } from './pdfExport';
import { buildPrintHtml, collectPrintSheets, decoratePrintDocument, openPrintView, pictureLeftOutNote } from './printView';
import { PICTURE_LOADS, renderPageToBlob, renderSlotToBlob } from './rasterize';
import { collectExportSlots } from './sequence';
import { exportLanguagesZip, exportPngZip } from './zipExport';

let made: FakeCtx[] = [];
const fetched: string[] = [];

beforeEach(() => {
  made = [];
  fetched.length = 0;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    const f = fakeContext(this.width, this.height);
    made.push(f);
    return f.ctx as never;
  } as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, cb: BlobCallback, type?: string) {
    cb(new Blob([`${this.width}x${this.height}`], { type: type || 'image/png' }));
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetched.push(String(url));
      if (/missing/.test(String(url))) return new Response('', { status: 404 });
      // A string body: the Response's blob then carries the URL, so the fake bitmap knows its size.
      return new Response(String(url), { status: 200, headers: { 'content-type': /\.svg$/.test(String(url)) ? 'image/svg+xml' : 'image/png' } });
    })
  );
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async (blob: Blob) => {
      const url = await blob.text();
      const m = /-(\d+)x(\d+)\.png$/.exec(url);
      return { width: m ? Number(m[1]) : 400, height: m ? Number(m[2]) : 400, url, close: () => undefined };
    })
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const opts = { measure: estimateMeasure, makePath: fakePath, createLayer: fakeLayers().createLayer, urlForPath: fakePathUrl };
const images = (f: FakeCtx) => f.calls.filter((c) => c.name === 'drawImage').map((c) => (c.args[0] as { url?: string }).url ?? 'layer');
const drawingUrl = (doc: ComicDoc) => fakeUrlFor(doc.pages[0].render.asset)!;

describe('composed pages on the canvas (PNG, PDF, ZIP)', () => {
  it('panels mode: the book aspect at the drawing’s width, paper, every frame from ONE fetched drawing, then lettering', async () => {
    const doc = framedDoc();
    const page = doc.pages[0];
    await renderPageToBlob(doc, page, drawingUrl(doc), opts);
    const f = made[0];
    const canvas = f.ctx.canvas as unknown as { width: number; height: number };
    expect(canvas.width).toBe(page.render.asset!.w);
    expect(canvas.height).toBe(Math.round(page.render.asset!.w! * 1.5));
    expect(fetched.filter((u) => u === drawingUrl(doc))).toHaveLength(1);
    expect(images(f)).toEqual([drawingUrl(doc), drawingUrl(doc), drawingUrl(doc)]);
    const names = f.calls.map((c) => c.name);
    expect(names.filter((n) => n === 'fillRect').length).toBeGreaterThanOrEqual(2); // white canvas + the paper
    expect(names.filter((n) => n === 'clip')).toHaveLength(3);
    // The lettering comes after every frame and border.
    const lastImage = names.lastIndexOf('drawImage');
    const firstText = names.indexOf('fillText');
    expect(firstText).toBeGreaterThan(lastImage);
  });

  it('page mode: the drawing whole, then every printed overlay, then the lettering; guide-only and opaque never', async () => {
    const doc = layeredDoc([LAYERS.image, LAYERS.sticker, LAYERS.shape, LAYERS.effect, LAYERS.blend, LAYERS.guide, LAYERS.opaque]);
    await renderPageToBlob(doc, doc.pages[0], drawingUrl(doc), opts);
    const f = made[0];
    expect(images(f)[0]).toBe(drawingUrl(doc));
    expect(images(f)).toContain(fakePathUrl(PHOTO_PATH));
    // The sticker is the same-origin library file; the guide-only photo is not drawn a second time.
    expect(fetched).toContain('/library/fluent-flat/1/star.svg');
    expect(images(f).filter((u) => u === fakePathUrl(PHOTO_PATH))).toHaveLength(1);
    expect(f.calls.some((c) => c.state.globalCompositeOperation === 'multiply')).toBe(true);
    const names = f.calls.map((c) => c.name);
    expect(names.indexOf('fillText')).toBeGreaterThan(names.lastIndexOf('drawImage'));
  });

  it('a picture that cannot be resolved or loaded fails the page calmly (the batch reports it and goes on)', async () => {
    const doc = layeredDoc([LAYERS.image]);
    // The link is still being signed: nothing to reload, it arrives on its own.
    await expect(renderPageToBlob(doc, doc.pages[0], drawingUrl(doc), { ...opts, urlForPath: undefined })).rejects.toThrow(
      'A picture on page 1 isn’t ready to export yet. Try again in a moment.'
    );
    await expect(renderPageToBlob(doc, doc.pages[0], drawingUrl(doc), { ...opts, urlForPath: (p) => `https://cdn.test/missing/${p}` })).rejects.toThrow(
      /A picture on this page couldn’t be loaded/
    );
  });

  it('an image overlay is asked for at the width it is drawn on the canvas; frame pictures at full size', async () => {
    const doc = framedDoc((page) => {
      page.panels[1].frame = { ...page.panels[1].frame!, src: { path: TAKE_PATH } };
      page.layers = [LAYERS.image];
    });
    const urlForPath = vi.fn((path: string, widthPx?: number) => fakePathUrl(path) + (widthPx ? `?w=${widthPx}` : ''));
    await renderPageToBlob(doc, doc.pages[0], drawingUrl(doc), { ...opts, urlForPath });
    const width = (made[0].ctx.canvas as unknown as { width: number }).width;
    // The photo's box is 0.3 of the page wide and shows 0.8 of the picture.
    expect(urlForPath).toHaveBeenCalledWith(PHOTO_PATH, Math.ceil((0.3 / 0.8) * width));
    expect(urlForPath).toHaveBeenCalledWith(TAKE_PATH);
    expect(fetched).toContain(`${fakePathUrl(PHOTO_PATH)}?w=${Math.ceil((0.3 / 0.8) * width)}`);
  });

  it(`a page's pictures load in parallel, at most ${PICTURE_LOADS} at a time`, async () => {
    const paths = Array.from({ length: 6 }, (_, i) => `qa/sticker-${i}-200x200.png`);
    const doc = layeredDoc(paths.map((path, i) => ({ ...LAYERS.image, id: `ly_p${i}`, src: { path }, rot: 0 })));
    let inFlight = 0;
    let most = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetched.push(String(url));
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return new Response(String(url), { status: 200, headers: { 'content-type': 'image/png' } });
      })
    );
    await renderPageToBlob(doc, doc.pages[0], drawingUrl(doc), opts);
    expect(paths.every((p) => fetched.includes(fakePathUrl(p)))).toBe(true);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(PICTURE_LOADS);
  });

  it('the all-languages ZIP loads a composed page’s other pictures once for every language', async () => {
    const doc = makeBook(
      (d) => {
        d.pages[0].layers = [LAYERS.image];
        d.publication = { visibility: 'unlisted', status: 'live', publishedRev: 3, publishedAt: 1, languages: ['en', 'te'] };
      },
      { plates: false }
    );
    // The ZIP draws with the default path factory (jsdom has no Path2D).
    vi.stubGlobal(
      'Path2D',
      class {
        constructor(public d: string) {}
      }
    );
    const result = await exportLanguagesZip(doc, fakeUrlFor, { download: () => undefined });
    expect(result.languages).toEqual(['en', 'te']);
    expect(result.failed).toEqual([]);
    expect(fetched.filter((u) => u.startsWith(fakeUrlFor(PHOTO_PATH)!))).toHaveLength(1);
    // Both languages drew it.
    expect(made.filter((f) => images(f).some((u) => u.startsWith(fakeUrlFor(PHOTO_PATH)!)))).toHaveLength(2);
  });

  it('the all-languages ZIP path reuses the drawing it already loaded for a composed page', async () => {
    const doc = framedDoc((page) => (page.panels[1].frame = { ...page.panels[1].frame!, src: { path: TAKE_PATH } }));
    const slot = collectExportSlots(doc, fakeUrlFor).slots.find((s) => s.page?.id === doc.pages[0].id)!;
    const image = { source: { url: 'preloaded' } as unknown as CanvasImageSource, width: 1536, height: 2304 };
    await renderSlotToBlob(doc, slot, { ...opts, image });
    expect(fetched).toEqual([fakePathUrl(TAKE_PATH)]);
    expect(images(made[0])).toEqual(['preloaded', fakePathUrl(TAKE_PATH), 'preloaded']);
  });

  it('a legacy page draws the same calls whatever urlForPath says (it never composes)', async () => {
    const doc = makeQaDoc('heist-12p');
    const page = doc.pages[1];
    await renderPageToBlob(doc, page, fakeUrlFor(page.render.asset)!, { ...opts, urlForPath: undefined });
    const a = JSON.stringify(made[0].calls);
    made = [];
    await renderPageToBlob(doc, page, fakeUrlFor(page.render.asset)!, opts);
    expect(JSON.stringify(made[0].calls)).toBe(a);
  });

  it('the PDF and the PNG ZIP hand their urlFor to the page renderer', async () => {
    const doc = framedDoc();
    const seen: ((p: string) => string | undefined)[] = [];
    const renderPage = vi.fn(async (_d: ComicDoc, _p: unknown, _u: string, raster: { urlForPath?: (p: string) => string | undefined }) => {
      if (raster.urlForPath) seen.push(raster.urlForPath);
      return new Blob(['x'], { type: 'image/png' });
    });
    const renderPlate = vi.fn(async () => new Blob(['x'], { type: 'image/png' }));
    const renderCover = vi.fn(async () => new Blob(['x'], { type: 'image/png' }));
    await exportPngZip(doc, fakeUrlFor, { renderPage, renderPlate, renderCover, download: () => undefined });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((fn) => fn(TAKE_PATH) === fakeUrlFor(TAKE_PATH))).toBe(true);
    seen.length = 0;
    await exportComicPdf(doc, fakeUrlFor, { renderPage, renderPlate, renderCover, download: () => undefined }).catch(() => undefined);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((fn) => fn(TAKE_PATH) === fakeUrlFor(TAKE_PATH))).toBe(true);
  });
});

describe('composed pages in the print document', () => {
  const sheetOf = (html: string, pageId: string) => {
    const root = new DOMParser().parseFromString(html, 'text/html');
    return root.querySelector<HTMLElement>(`.page[data-key="${pageId}"]`)!;
  };

  it('panels mode replaces the <img> with the composed SVG: N frames on ONE drawing URL, then the lettering', () => {
    const doc = framedDoc();
    const { sheets } = collectPrintSheets(doc, fakeUrlFor);
    const html = buildPrintHtml(doc, sheets, { measure: estimateMeasure, origin: 'https://studio.test', urlFor: fakeUrlFor });
    const el = sheetOf(html, doc.pages[0].id);
    expect(el.querySelector(':scope > img')).toBeNull();
    const svg = el.querySelector(':scope > svg[data-compose="panels"]')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect([...svg.querySelectorAll('image')].map((i) => i.getAttribute('href'))).toEqual([drawingUrl(doc), drawingUrl(doc), drawingUrl(doc)]);
    expect(el.lastElementChild!.hasAttribute('data-compose')).toBe(false); // the lettering stays on top
    // Other pages print exactly as before.
    expect(sheetOf(html, doc.pages[1].id).querySelector('svg[data-compose]')).toBeNull();
  });

  it('page mode adds the overlays over the <img>: stickers from the opener’s origin, no guide-only or opaque layer', () => {
    const doc = layeredDoc([LAYERS.image, LAYERS.sticker, LAYERS.guide, LAYERS.opaque]);
    const { sheets } = collectPrintSheets(doc, fakeUrlFor);
    const html = buildPrintHtml(doc, sheets, { measure: estimateMeasure, origin: 'https://studio.test', urlFor: fakeUrlFor });
    const el = sheetOf(html, doc.pages[0].id);
    expect(el.querySelector(':scope > img')).not.toBeNull();
    const svg = el.querySelector(':scope > svg[data-compose="page"]')!;
    expect([...svg.querySelectorAll('g[data-layer-id]')].map((g) => g.getAttribute('data-layer-id'))).toEqual(['ly_photo', 'ly_star']);
    expect([...svg.querySelectorAll('image')].map((i) => i.getAttribute('href'))).toEqual([fakeUrlFor(PHOTO_PATH), 'https://studio.test/library/fluent-flat/1/star.svg']);
    expect(html).not.toContain('ly_guide');
    expect(html).not.toContain('ly_future');
  });

  it('a picture with no link yet prints left out, and the bar lists it (not a silent blank frame)', () => {
    const doc = framedDoc((page) => (page.panels[1].frame = { ...page.panels[1].frame!, src: { path: TAKE_PATH } }));
    const urlFor = (a?: Parameters<typeof fakeUrlFor>[0]) => (a === TAKE_PATH ? undefined : fakeUrlFor(a));
    const { sheets } = collectPrintSheets(doc, urlFor);
    const html = buildPrintHtml(doc, sheets, { measure: estimateMeasure, origin: 'https://studio.test', urlFor, skipped: ['Page 9 (image link not ready yet)'] });
    const root = new DOMParser().parseFromString(html, 'text/html');
    expect(root.querySelector('.bar')!.textContent).toContain(`Not included: Page 9 (image link not ready yet), ${pictureLeftOutNote('Page 1')}`);
    expect(sheetOf(html, doc.pages[0].id).querySelector('g[data-panel-id="pg_1_p2"]')!.getAttribute('data-empty')).toBe('blank');
    // Every picture resolved: nothing listed.
    const all = buildPrintHtml(doc, collectPrintSheets(doc, fakeUrlFor).sheets, { measure: estimateMeasure, origin: 'https://studio.test', urlFor: fakeUrlFor });
    expect(all).not.toContain('Not included');
  });

  describe('openPrintView with composed pages', () => {
    const fakeWindow = () => {
      const document = window.document.implementation.createHTMLDocument('print');
      return { document, focus: vi.fn(), print: vi.fn(), innerWidth: 390 } as unknown as Window;
    };
    /** An Image that loads every URL but the ones matching `fails`. */
    const imageThatFails = (fails: RegExp) =>
      class {
        naturalWidth = 0;
        private on: Record<string, () => void> = {};
        addEventListener(type: string, cb: () => void) {
          this.on[type] = cb;
        }
        set src(url: string) {
          setTimeout(() => {
            if (fails.test(url)) this.on.error?.();
            else {
              this.naturalWidth = 100;
              this.on.load?.();
            }
          }, 0);
        }
      };
    const framed = () => framedDoc((page) => (page.panels[1].frame = { ...page.panels[1].frame!, src: { path: TAKE_PATH } }));

    it('waits for the pictures a composed page draws: a frame picture that fails names its sheet in failedImages', async () => {
      vi.stubGlobal('Image', imageThatFails(/heist-take/));
      const result = await openPrintView(framed(), fakeUrlFor, { win: fakeWindow(), timeoutMs: 20, measure: estimateMeasure });
      expect(result.failedImages).toContain('Page 1');
    });

    it('every composed picture loaded: the framed sheet is not reported', async () => {
      vi.stubGlobal('Image', imageThatFails(/^$/));
      const result = await openPrintView(framed(), fakeUrlFor, { win: fakeWindow(), timeoutMs: 20, measure: estimateMeasure });
      expect(result.failedImages).not.toContain('Page 1');
    });

    it('a picture with no link yet: listed in PrintResult.skipped and the status says to try again in a moment', async () => {
      vi.stubGlobal('Image', imageThatFails(/^$/));
      const urlFor = (a?: Parameters<typeof fakeUrlFor>[0]) => (a === TAKE_PATH ? undefined : fakeUrlFor(a));
      const onStatus = vi.fn();
      const win = fakeWindow();
      const result = await openPrintView(framed(), urlFor, { win, timeoutMs: 20, measure: estimateMeasure, onStatus });
      expect(result.skipped).toContain(pictureLeftOutNote('Page 1'));
      expect(win.document.querySelector('.bar')!.textContent!.match(/a picture wasn’t ready/g)).toHaveLength(1);
      expect(onStatus).toHaveBeenLastCalledWith(expect.stringContaining('Try again in a moment.'));
    });
  });

  it('re-planning the lettering for art of another shape keeps the composed overlays', () => {
    const doc = layeredDoc([LAYERS.shape]);
    const { sheets } = collectPrintSheets(doc, fakeUrlFor);
    const root = document.implementation.createHTMLDocument('print');
    root.documentElement.innerHTML = buildPrintHtml(doc, sheets, { measure: estimateMeasure, origin: 'https://studio.test', urlFor: fakeUrlFor });
    const el = root.querySelector<HTMLElement>(`.page[data-key="${doc.pages[0].id}"]`)!;
    const img = el.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 1000 });
    Object.defineProperty(img, 'naturalHeight', { value: 1000 });
    decoratePrintDocument(root, doc, estimateMeasure);
    expect(el.querySelector(':scope > svg[data-compose]')).not.toBeNull();
    expect(el.dataset.aspect).toBe('1');
    expect(el.querySelectorAll(':scope > svg:not([data-compose])').length).toBe(1);
  });
});
