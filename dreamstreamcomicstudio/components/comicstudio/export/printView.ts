// Print / PDF export (lettering.md §6.3).
//
// Opens a print-ready document in a new window: one comic sheet per page (@page at the book's trim,
// zero margin) in reading order — cover, title page, pages, "The End", back cover. Each page is the
// full-resolution art plus ONE inline SVG of its lettering, drawn from the shared engine's plans
// (`planLettering` → `letteringSvgMarkup`) and measured in the opener after the exact faces loaded —
// so "Save as PDF" keeps crisp vector lettering that matches the board line for line. The print
// window gets the same self-hosted faces (`fontFaceCss`) plus the Google CSS for script faces only.
// Every author text is escaped (SVG text nodes and attributes), and only http(s)/blob/data-image URLs
// are ever written into the document.

import type { ComicDoc, Page } from '../../../shared/comic/doc';
import { estimateMeasure, planLettering, type LetterPlan, type Measure } from '../../../shared/comic/lettering/layout';
import { FONT_REGISTRY, fontsForDoc, googleFontsHref } from '../../../shared/comic/lettering/fonts';
import type { FontId } from '../../../shared/comic/lettering/style';
import { dirOf } from '../../../shared/comic/languages';
import { fontFaceCss } from '../lettering/fontLoader';
import { letteringSvgMarkup } from '../lettering/svgMarkup';
import { plateLayout, type PlateKind } from '../timeline/plates';
import { coverTitleSvgMarkup, coverTitleText } from './coverTitle';
import { exportFaces, prepareExportFonts } from './fonts';
import { escapeHtml, safeImageUrl } from './html';
import { plateSvgMarkup } from './plateDraw';
import { collectExportSlots, localizedFor, trimAspectOf, type UrlFor as SlotUrlFor } from './sequence';

export { escapeHtml } from './html';
export type UrlFor = SlotUrlFor;

export interface PrintSheet {
  key: string;
  kind: 'cover' | 'page' | 'plate';
  label: string;
  /** Art URL (cover and pages). */
  imageUrl?: string;
  page?: Page;
  plate?: PlateKind;
  /** Width / height of the art. */
  aspect: number;
}

export interface PrintResult {
  pages: number;
  /** Pages left out, with the reason. */
  skipped: string[];
  /** Images that failed to load in the print window. */
  failedImages: string[];
  /** Set when a lettering face didn't load (the print may use a fallback face). */
  notice?: string;
}

export class PrintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrintError';
  }
}

/** Long edge of a printed sheet, in inches (US comic trim is 6.625 × 10.25). */
const SHEET_LONG_EDGE_IN = 10.5;
const CSS_PX_PER_IN = 96;

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Physical sheet for an aspect ratio: the long edge is 10.5in. */
export const printPageSize = (aspect: number): { widthIn: number; heightIn: number } => {
  const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 2 / 3;
  return a <= 1 ? { widthIn: round3(SHEET_LONG_EDGE_IN * a), heightIn: SHEET_LONG_EDGE_IN } : { widthIn: SHEET_LONG_EDGE_IN, heightIn: round3(SHEET_LONG_EDGE_IN / a) };
};

/** The largest box of `aspect` that fits a sheet (inches). */
export const fitBox = (sheetW: number, sheetH: number, aspect: number): { w: number; h: number } => {
  if (!(aspect > 0)) return { w: sheetW, h: sheetH };
  return aspect >= sheetW / sheetH ? { w: round3(sheetW), h: round3(sheetW / aspect) } : { w: round3(sheetH * aspect), h: round3(sheetH) };
};

/** What will print (reading order: cover, plates, drawn pages) and what can't yet. */
export const collectPrintSheets = (doc: ComicDoc, urlFor: UrlFor): { sheets: PrintSheet[]; skipped: string[] } => {
  const { slots, skipped } = collectExportSlots(doc, urlFor);
  const sheets: PrintSheet[] = [];
  for (const s of slots) {
    if (s.plate) {
      sheets.push({ key: s.key, kind: 'plate', label: s.label, plate: s.plate, aspect: trimAspectOf(doc) });
      continue;
    }
    const url = safeImageUrl(s.url);
    if (!url) {
      skipped.push(`${s.label} (image link not ready yet)`);
      continue;
    }
    sheets.push({ key: s.key, kind: s.kind === 'cover' ? 'cover' : 'page', label: s.label, imageUrl: url, ...(s.page ? { page: s.page } : {}), aspect: s.aspect });
  }
  return { sheets, skipped };
};

export interface PrintHtmlOptions {
  skipped?: string[];
  /** Measure prepared after fonts loaded (default: registry estimates). */
  measure?: Measure;
  /** Origin the self-hosted font files are served from (the opener's). */
  origin?: string;
  /** Signed URL for a storage path (the back cover's art vignette). */
  urlFor?: UrlFor;
}

/** Faces the print document must declare: every resolved lettering face plus the plans' faces. */
const printFontIds = (doc: ComicDoc): FontId[] => {
  const ids = new Set<FontId>(fontsForDoc(doc));
  for (const f of exportFaces([doc]).faces) ids.add(f.id);
  return [...ids];
};

/** Lettering plans for a page sheet (overlay comics only). */
const pagePlans = (doc: ComicDoc, page: Page, aspect: number, measure: Measure): LetterPlan[] =>
  doc.format.lettering === 'overlay' ? planLettering(doc, page, aspect, measure) : [];

/** The print document (pure: string in, string out). */
export const buildPrintHtml = (doc: ComicDoc, sheets: PrintSheet[], opts: PrintHtmlOptions = {}): string => {
  const measure = opts.measure ?? estimateMeasure;
  const { widthIn, heightIn } = printPageSize(trimAspectOf(doc));
  const lang = doc.format.language || 'en';
  const dir = dirOf(lang);
  const titleText = doc.cover.title || doc.brief.title || 'Comic';
  const title = escapeHtml(titleText);
  const origin = opts.origin ?? (typeof location !== 'undefined' ? location.origin : '');
  const ids = printFontIds(doc);
  const faceCss = origin ? fontFaceCss(ids, origin) : '';
  const scriptHref = googleFontsHref(
    ids.filter((id) => FONT_REGISTRY[id]?.source === 'google-css2'),
    [400, 700, 800, 900]
  );
  const css = `
@page { size: ${widthIn}in ${heightIn}in; margin: 0; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; padding: 0; background: #e9e7e1; }
body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; color: #1a1915; }
.bar { position: sticky; top: 0; z-index: 10; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding: 10px 16px; background: rgba(250,249,245,0.96); border-bottom: 1px solid rgba(0,0,0,0.1); font-size: 13px; }
.bar strong { font-weight: 600; overflow-wrap: anywhere; }
.bar button { font: inherit; font-weight: 600; color: #fff; background: #D97757; border: 0; border-radius: 10px; min-height: 44px; padding: 7px 16px; cursor: pointer; }
.bar .muted { color: #6e6a60; overflow-wrap: anywhere; }
.sheet { position: relative; width: ${widthIn}in; height: ${heightIn}in; margin: 18px auto; overflow: hidden; background: #fff; box-shadow: 0 4px 24px rgba(0,0,0,0.18); break-after: page; page-break-after: always; }
.sheet:last-of-type { break-after: auto; page-break-after: auto; }
.frame { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.page { position: relative; flex: none; }
.page > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: fill; display: block; }
.page > svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.plate > svg { display: block; width: 100%; height: 100%; }
@media print {
  html, body { background: #fff; }
  .bar { display: none; }
  .sheet { margin: 0; box-shadow: none; zoom: 1 !important; }
}`;
  const body = sheets
    .map((s, i) => {
      const label = escapeHtml(s.label);
      if (s.kind === 'plate' && s.plate) {
        const layout = plateLayout(doc, s.plate);
        const artUrl = layout.art ? safeImageUrl(opts.urlFor?.(layout.art.path)) : undefined;
        return `<section class="sheet" data-kind="plate" data-label="${label}"><div class="frame plate">${plateSvgMarkup(layout, artUrl, `pl${i}`)}</div></section>`;
      }
      const box = fitBox(widthIn, heightIn, s.aspect);
      const url = safeImageUrl(s.imageUrl);
      const alt = s.kind === 'cover' ? `Cover of ${titleText}` : s.label;
      let lettering = '';
      if (s.kind === 'page' && s.page) {
        const plans = pagePlans(doc, s.page, s.aspect, measure);
        if (plans.length) lettering = letteringSvgMarkup(plans, { aspect: s.aspect, widthPx: box.w * CSS_PX_PER_IN, idPrefix: `pg${i}`, docLang: lang, ariaHidden: false });
      } else if (s.kind === 'cover') {
        lettering = coverTitleSvgMarkup(doc, s.aspect, measure);
      }
      const coverText = s.kind === 'cover' ? coverTitleText(doc, s.aspect, measure) : '';
      const img = url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(coverText ? `${alt}: ${coverText}` : alt)}">` : '';
      return `<section class="sheet" data-kind="${s.kind}" data-label="${label}"><div class="frame"><div class="page" data-aspect="${round3(s.aspect)}" data-key="${escapeHtml(s.key)}" style="width:${box.w}in;height:${box.h}in">${img}${lettering}</div></div></section>`;
    })
    .join('\n');
  const skipped = opts.skipped?.length ? `<span class="muted">Not included: ${escapeHtml(opts.skipped.join(', '))}</span>` : '';
  return `<!doctype html>
<html lang="${escapeHtml(lang)}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${scriptHref ? `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="${escapeHtml(scriptHref)}">\n` : ''}<style>${faceCss}
${css}</style>
</head>
<body>
<div class="bar" dir="ltr"><strong>${title}</strong><span class="muted">${sheets.length} ${sheets.length === 1 ? 'page' : 'pages'}</span><button type="button" id="cs-print">Print / Save as PDF</button><span id="cs-status" class="muted" role="status">Preparing pages…</span>${skipped}</div>
${body}
</body>
</html>`;
};

const num = (v: string | null | undefined): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * After the images load: a page whose art turns out to have another shape than recorded (an old
 * asset without a size) gets its box refitted and its lettering re-planned at the real aspect, so
 * the balloons never drift off the art. Idempotent.
 */
export const decoratePrintDocument = (root: Document, doc: ComicDoc, measure: Measure = estimateMeasure): void => {
  const pages = new Map(doc.pages.map((p) => [p.id, p]));
  root.querySelectorAll<HTMLElement>('.sheet').forEach((sheet, i) => {
    const pageEl = sheet.querySelector<HTMLElement>('.page');
    const img = pageEl?.querySelector('img');
    if (!pageEl || !img || !(img.naturalWidth > 0 && img.naturalHeight > 0)) return;
    const real = img.naturalWidth / img.naturalHeight;
    const planned = num(pageEl.dataset.aspect) ?? real;
    if (Math.abs(Math.log(real / planned)) <= 0.01) return;
    const rect = sheet.getBoundingClientRect();
    // The page box's own width (the lettering's outline floor scales with it), not the sheet's.
    let boxWidthPx = 0;
    if (rect.width > 0 && rect.height > 0) {
      const box = fitBox(rect.width, rect.height, real);
      pageEl.style.width = `${box.w}px`;
      pageEl.style.height = `${box.h}px`;
      boxWidthPx = box.w;
    }
    pageEl.dataset.aspect = String(round3(real));
    pageEl.querySelector(':scope > svg')?.remove();
    const page = pages.get(pageEl.dataset.key || '');
    const kind = sheet.dataset.kind;
    let markup = '';
    if (kind === 'page' && page) {
      const plans = pagePlans(doc, page, real, measure);
      if (plans.length) markup = letteringSvgMarkup(plans, { aspect: real, widthPx: boxWidthPx || 672, idPrefix: `pgd${i}`, docLang: doc.format.language, ariaHidden: false });
    } else if (kind === 'cover') markup = coverTitleSvgMarkup(doc, real, measure);
    if (markup) pageEl.insertAdjacentHTML('beforeend', markup);
  });
};

const waitForImages = (root: Document, timeoutMs: number): Promise<string[]> => {
  const imgs = Array.from(root.querySelectorAll('img'));
  const label = (img: HTMLImageElement) => img.closest<HTMLElement>('.sheet')?.dataset.label || img.alt || 'image';
  return Promise.all(
    imgs.map(
      (img) =>
        new Promise<string | null>((resolve) => {
          if (img.complete && img.naturalWidth > 0) return resolve(null);
          let settled = false;
          const done = (failed: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(failed ? label(img) : null);
          };
          const timer = setTimeout(() => done(!(img.naturalWidth > 0)), timeoutMs);
          img.addEventListener('load', () => done(false), { once: true });
          img.addEventListener('error', () => done(true), { once: true });
        })
    )
  ).then((r) => r.filter((x): x is string => !!x));
};

/** Wait (bounded) until the print window has the faces the lettering draws with. */
const fontsReady = async (root: Document, doc: ComicDoc, timeoutMs: number) => {
  const fonts = (root as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts?.load) return;
  const loads = exportFaces([doc]).faces.flatMap((f) => {
    const family = FONT_REGISTRY[f.id]?.family;
    return family ? f.weights.map((w) => fonts.load(`${f.italic ? 'italic ' : ''}${w} 24px "${family}"`, f.sample || undefined).catch(() => [])) : [];
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([Promise.all(loads).then(() => fonts.ready), new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
  } catch {
    /* fall back to whatever loaded */
  } finally {
    if (timer) clearTimeout(timer);
  }
};

export interface OpenPrintOptions {
  /** Window to render into (tests); by default a new tab is opened. Must be opened in the click handler. */
  win?: Window | null;
  onStatus?: (status: string) => void;
  /** Per-image load timeout. */
  timeoutMs?: number;
  /** Print this edition of `doc` (localized here). Default: the doc as given. */
  lang?: string;
  /** Measure to plan with (default: prepared here after loading the faces). */
  measure?: Measure;
}

/** On a phone the on-screen preview zooms each sheet to the window width (print is unaffected). */
const fitSheetsToScreen = (win: Window) => {
  try {
    const avail = Math.max(200, (win.innerWidth || 0) - 16);
    win.document.querySelectorAll<HTMLElement>('.sheet').forEach((sheet) => {
      const w = sheet.offsetWidth;
      if (w > 0 && avail < w) sheet.style.setProperty('zoom', String(Math.round((avail / w) * 1000) / 1000));
    });
  } catch {
    /* a full-size preview still prints correctly */
  }
};

const PREPARING = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Preparing…</title></head><body style="font-family:system-ui,sans-serif;padding:24px;color:#1a1915;background:#faf9f5">Preparing your pages…</body></html>`;

/**
 * Open the print view and start printing. Call it directly from a click handler: the window opens
 * synchronously, before any await, so pop-up blockers allow it; fonts load while it shows "Preparing".
 */
export async function openPrintView(doc: ComicDoc, urlFor: UrlFor, opts: OpenPrintOptions = {}): Promise<PrintResult> {
  const book = localizedFor(doc, opts.lang);
  const { sheets, skipped } = collectPrintSheets(book, urlFor);
  if (!sheets.some((s) => s.kind !== 'plate')) {
    const firstPage = skipped.find((s) => s.startsWith('Page'));
    throw new PrintError(firstPage ? `Nothing printable yet — ${firstPage.toLowerCase()}.` : 'Nothing to print yet — draw at least one page first.');
  }
  const win = opts.win !== undefined ? opts.win : typeof window !== 'undefined' ? window.open('', '_blank') : null;
  if (!win) throw new PrintError('Your browser blocked the print window. Allow pop-ups for this site, then try again.');
  try {
    win.document.open();
    win.document.write(PREPARING);
    win.document.close();
  } catch {
    /* the real document below reports the failure */
  }
  const fonts = opts.measure ? null : await prepareExportFonts([book]);
  const measure = opts.measure ?? fonts!.measure;
  const status = (text: string) => {
    const el = win.document.getElementById('cs-status');
    if (el) el.textContent = text;
    opts.onStatus?.(text);
  };
  try {
    win.document.open();
    win.document.write(buildPrintHtml(book, sheets, { skipped, measure, urlFor }));
    win.document.close();
  } catch {
    throw new PrintError('Couldn’t prepare the print window. Try again, or allow pop-ups for this site.');
  }
  const artCount = sheets.filter((s) => s.kind !== 'plate').length;
  status(`Loading ${artCount} ${artCount === 1 ? 'image' : 'images'}…`);
  const failedImages = await waitForImages(win.document, opts.timeoutMs ?? 45_000);
  await fontsReady(win.document, book, 6000);
  decoratePrintDocument(win.document, book, measure);
  fitSheetsToScreen(win);
  win.document.getElementById('cs-print')?.addEventListener('click', () => win.print());
  const notes: string[] = [];
  if (failedImages.length) notes.push(`Some images didn’t load (${failedImages.join(', ')}) — their links may have expired. Close this tab and print again.`);
  if (fonts?.notice) notes.push(fonts.notice);
  status(notes.length ? notes.join(' ') : 'Ready. In the print dialog choose “Save as PDF” to keep a PDF.');
  try {
    win.focus();
    win.print();
  } catch {
    /* the user can still use the Print button in the window */
  }
  return { pages: sheets.length, skipped, failedImages, ...(fonts?.notice ? { notice: fonts.notice } : {}) };
}

