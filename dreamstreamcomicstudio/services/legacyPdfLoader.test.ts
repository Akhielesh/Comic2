/**
 * PF-1: the classic wizard's PDF tools load on demand, once, from the same SRI-pinned cdnjs files, with a
 * timeout and a calm error (services/legacyPdfLoader.ts). jsdom never fetches a <script src>, so each test
 * plays the browser: it puts the UMD global on window and fires the tag's load (or error) event.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEGACY_PDF_EXPORT_FAILED,
  LEGACY_PDF_LOAD_TIMEOUT_MS,
  LEGACY_PDF_MESSAGES,
  LEGACY_PDF_SCRIPTS,
  LEGACY_PDF_SCRIPT_ATTR,
  LegacyPdfLoadError,
  isLegacyPdfReady,
  legacyPdfErrorMessage,
  loadHtml2Canvas,
  loadJsPdf,
  loadLegacyPdf,
  resetLegacyPdfLoaderForTests,
  type LegacyPdfLib
} from './legacyPdfLoader';

type Win = { jspdf?: { jsPDF?: unknown }; html2canvas?: unknown };
const win = () => window as unknown as Win;

const FakeJsPdf = vi.fn(function FakeJsPdf() {
  return { internal: { pageSize: { getWidth: () => 148, getHeight: () => 210 } } };
});
const fakeHtml2Canvas = vi.fn(async () => document.createElement('canvas'));

const tags = (lib?: LegacyPdfLib) =>
  [...document.querySelectorAll<HTMLScriptElement>(lib ? `script[${LEGACY_PDF_SCRIPT_ATTR}="${lib}"]` : 'script')];

/** What the browser does when a pinned file arrives and runs: the UMD global appears, then `load` fires. */
function arrive(lib: LegacyPdfLib) {
  if (lib === 'jspdf') win().jspdf = { jsPDF: FakeJsPdf };
  else win().html2canvas = fakeHtml2Canvas;
  const [tag] = tags(lib);
  expect(tag, `${lib} was injected`).toBeTruthy();
  tag.dispatchEvent(new Event('load'));
}

/** Let the loader's promise chain run (no timers involved). */
const flush = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(() => {
  resetLegacyPdfLoaderForTests();
  delete win().jspdf;
  delete win().html2canvas;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('legacy PDF loader: on demand', () => {
  it('importing the module injects nothing (nothing loads with the page)', () => {
    expect(tags()).toHaveLength(0);
  });

  it('injects the same pinned cdnjs files index.html carried: exact URL, SHA-512 SRI, anonymous CORS, no referrer', async () => {
    const libs = loadLegacyPdf();
    const injected = tags();
    expect(injected).toHaveLength(2);
    for (const lib of ['jspdf', 'html2canvas'] as const) {
      const [tag] = tags(lib);
      const pin = LEGACY_PDF_SCRIPTS[lib];
      expect(tag.getAttribute('src')).toBe(pin.src);
      expect(tag.getAttribute('integrity')).toBe(pin.integrity);
      expect(tag.getAttribute('integrity')).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
      expect(tag.getAttribute('crossorigin')).toBe('anonymous');
      expect(tag.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(tag.parentElement).toBe(document.head);
    }
    expect(LEGACY_PDF_SCRIPTS.jspdf.src).toBe('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js');
    expect(LEGACY_PDF_SCRIPTS.html2canvas.src).toBe('https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js');

    arrive('jspdf');
    arrive('html2canvas');
    const { jsPDF, html2canvas } = await libs;
    expect(jsPDF).toBe(FakeJsPdf);
    expect(html2canvas).toBe(fakeHtml2Canvas);
  });

  it('loads only what a call needs (a PNG card download never fetches jsPDF)', async () => {
    const pending = loadHtml2Canvas();
    expect(tags('html2canvas')).toHaveLength(1);
    expect(tags('jspdf')).toHaveLength(0);
    arrive('html2canvas');
    await expect(pending).resolves.toBe(fakeHtml2Canvas);
    expect(tags('jspdf')).toHaveLength(0);
  });
});

describe('legacy PDF loader: once', () => {
  it('concurrent calls share one tag per library, and later calls inject nothing', async () => {
    const a = loadLegacyPdf();
    const b = loadLegacyPdf();
    const c = loadJsPdf();
    expect(tags('jspdf')).toHaveLength(1);
    expect(tags('html2canvas')).toHaveLength(1);
    arrive('jspdf');
    arrive('html2canvas');
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    expect(ra.jsPDF).toBe(FakeJsPdf);
    expect(rb.html2canvas).toBe(fakeHtml2Canvas);
    expect(rc).toBe(FakeJsPdf);

    await loadLegacyPdf();
    await loadJsPdf();
    await loadHtml2Canvas();
    expect(tags()).toHaveLength(2);
  });

  it('uses libraries already on window (the old index.html tags) without injecting anything', async () => {
    win().jspdf = { jsPDF: FakeJsPdf };
    win().html2canvas = fakeHtml2Canvas;
    const libs = await loadLegacyPdf();
    expect(libs).toEqual({ jsPDF: FakeJsPdf, html2canvas: fakeHtml2Canvas });
    expect(tags()).toHaveLength(0);
  });
});

describe('legacy PDF loader: failures are calm and retryable', () => {
  it('a network, SRI or CSP refusal (the error event) rejects with calm copy, removes the tag, and a retry injects a fresh one', async () => {
    const pending = loadJsPdf();
    const [first] = tags('jspdf');
    first.dispatchEvent(new Event('error'));
    const error = await pending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LegacyPdfLoadError);
    expect((error as LegacyPdfLoadError).kind).toBe('network');
    expect((error as LegacyPdfLoadError).lib).toBe('jspdf');
    expect((error as Error).message).toBe(LEGACY_PDF_MESSAGES.network);
    expect(tags('jspdf')).toHaveLength(0);

    const retry = loadJsPdf();
    const [second] = tags('jspdf');
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    arrive('jspdf');
    await expect(retry).resolves.toBe(FakeJsPdf);
  });

  it('gives up after LEGACY_PDF_LOAD_TIMEOUT_MS with the timeout copy, and leaves no timer behind', async () => {
    vi.useFakeTimers();
    const pending = loadHtml2Canvas().catch((e: unknown) => e);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(LEGACY_PDF_LOAD_TIMEOUT_MS - 1);
    expect(tags('html2canvas')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    const error = (await pending) as LegacyPdfLoadError;
    expect(error).toBeInstanceOf(LegacyPdfLoadError);
    expect(error.kind).toBe('timeout');
    expect(error.message).toBe(LEGACY_PDF_MESSAGES.timeout);
    expect(tags('html2canvas')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a load clears its timer (no timer outlives the export) and never calls fetch or /api', async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const pending = loadLegacyPdf();
    expect(vi.getTimerCount()).toBe(2);
    arrive('jspdf');
    arrive('html2canvas');
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(LEGACY_PDF_LOAD_TIMEOUT_MS * 3);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('a file that loads but defines nothing is a calm "missing", not a crash later on undefined', async () => {
    const pending = loadJsPdf();
    tags('jspdf')[0].dispatchEvent(new Event('load'));
    await flush();
    const error = (await pending.catch((e: unknown) => e)) as LegacyPdfLoadError;
    expect(error).toBeInstanceOf(LegacyPdfLoadError);
    expect(error.kind).toBe('missing');
    expect(error.message).toBe(LEGACY_PDF_MESSAGES.missing);
    // The empty tag is dropped like a failed one, so a retry injects a fresh tag.
    expect(tags('jspdf')).toHaveLength(0);
  });

  it('every message is a calm sentence for a person: no stack, no "Error", no codes', () => {
    for (const message of [...Object.values(LEGACY_PDF_MESSAGES), LEGACY_PDF_EXPORT_FAILED]) {
      expect(message).toMatch(/^[A-Z][^]*\.$/);
      expect(message).not.toMatch(/error|undefined|null|failed to|exception|\bjspdf\b|html2canvas|cdnjs/i);
    }
    expect(legacyPdfErrorMessage(new LegacyPdfLoadError('timeout', 'jspdf'))).toBe(LEGACY_PDF_MESSAGES.timeout);
    expect(legacyPdfErrorMessage(new TypeError('canvas is tainted'))).toBe(LEGACY_PDF_EXPORT_FAILED);
  });
});

describe('legacy PDF loader: isLegacyPdfReady (for work nobody clicked)', () => {
  it('reports what is already on window and never injects or loads anything itself', async () => {
    expect(isLegacyPdfReady('jspdf')).toBe(false);
    expect(isLegacyPdfReady('html2canvas')).toBe(false);
    expect(tags()).toHaveLength(0);

    // A namespace without the constructor is not ready (it would throw on `new`).
    win().jspdf = {};
    expect(isLegacyPdfReady('jspdf')).toBe(false);
    delete win().jspdf;

    const pending = loadJsPdf();
    expect(isLegacyPdfReady('jspdf')).toBe(false);
    arrive('jspdf');
    await pending;
    expect(isLegacyPdfReady('jspdf')).toBe(true);
    expect(isLegacyPdfReady('html2canvas')).toBe(false);
    expect(tags()).toHaveLength(1);
  });

  it('is false after a failed load, and true for libraries an old tag already defined', async () => {
    const failed = loadHtml2Canvas().catch((e: unknown) => e);
    tags('html2canvas')[0].dispatchEvent(new Event('error'));
    await failed;
    expect(isLegacyPdfReady('html2canvas')).toBe(false);

    win().jspdf = { jsPDF: FakeJsPdf };
    win().html2canvas = fakeHtml2Canvas;
    expect(isLegacyPdfReady('jspdf')).toBe(true);
    expect(isLegacyPdfReady('html2canvas')).toBe(true);
    expect(tags()).toHaveLength(0);
  });
});
