// Print / PDF export.
//
// Opens a print-ready document in a new window: one comic page per sheet (@page sized to
// the comic's aspect, zero margin), the cover first, each page = the full-resolution art
// plus its balloons as real HTML text over SVG outlines — so a "Save as PDF" keeps the
// lettering as crisp vector type and the art at full resolution. Balloon geometry is the
// board's (balloonGeometry), measured in the print window after fonts and images load.

import type { AssetRef, ComicDoc, LineKind, Page } from '../../../shared/comic/doc';
import {
  LETTERING,
  aspectNumber,
  balloonPaddingPx,
  balloonShape,
  dashArray,
  estimateBalloonHeight,
  hashSeed,
  letteringText,
  pageAspectOf,
  resolveBalloons,
  sfxFontPx,
  sfxStyle,
  strokePx,
  tailTipOf,
  type Pt,
  type TextInset
} from '../board/balloonGeometry';

export type UrlFor = (asset?: AssetRef | string | null) => string | undefined;

export interface PrintSheet {
  key: string;
  kind: 'cover' | 'page';
  label: string;
  imageUrl: string;
  page?: Page;
  /** Width / height of the art. */
  aspect: number;
}

export interface PrintResult {
  pages: number;
  /** Pages left out, with the reason. */
  skipped: string[];
  /** Images that failed to load in the print window. */
  failedImages: string[];
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
const FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Bangers&family=Comic+Neue:ital,wght@0,400;0,700;1,700&display=swap';

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export const escapeHtml = (value: string): string =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

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

/** What will print (cover first, then drawn pages in order) and what can't yet. */
export const collectPrintSheets = (doc: ComicDoc, urlFor: UrlFor): { sheets: PrintSheet[]; skipped: string[] } => {
  const sheets: PrintSheet[] = [];
  const skipped: string[] = [];
  const cover = doc.cover.render.asset;
  if (cover?.path) {
    const url = urlFor(cover);
    if (url) sheets.push({ key: 'cover', kind: 'cover', label: 'Cover', imageUrl: url, aspect: cover.w && cover.h ? cover.w / cover.h : aspectNumber(doc.format.pageAspect) });
    else skipped.push('Cover (image link not ready yet)');
  }
  [...doc.pages]
    .sort((a, b) => a.n - b.n)
    .forEach((page) => {
      const label = `Page ${page.n}`;
      if (!page.render.asset?.path) {
        skipped.push(`${label} (not drawn yet)`);
        return;
      }
      const url = urlFor(page.render.asset);
      if (!url) {
        skipped.push(`${label} (image link not ready yet)`);
        return;
      }
      sheets.push({ key: page.id, kind: 'page', label, imageUrl: url, page, aspect: pageAspectOf(doc, page) });
    });
  return { sheets, skipped };
};

const KIND_SCALE: Record<LineKind, number> = { speech: 1, thought: 1, whisper: 0.94, shout: 1.08, caption: 0.95, sfx: 2.4 };

const balloonsHtml = (doc: ComicDoc, page: Page, pageWidthIn: number): string => {
  if (doc.format.lettering !== 'overlay') return '';
  const pageWpx = pageWidthIn * CSS_PX_PER_IN;
  return resolveBalloons(doc, page)
    .map(({ line, balloon: b }) => {
      const text = escapeHtml(letteringText(line.text, doc.format.language));
      const attrs = [
        `data-kind="${line.kind}"`,
        `data-line="${escapeHtml(line.id)}"`,
        `data-x="${b.x}"`,
        `data-y="${b.y}"`,
        `data-w="${b.w}"`,
        typeof b.tailX === 'number' ? `data-tx="${b.tailX}"` : '',
        typeof b.tailY === 'number' ? `data-ty="${b.tailY}"` : ''
      ]
        .filter(Boolean)
        .join(' ');
      let style = '';
      if (line.kind === 'sfx') {
        const s = sfxStyle(line.id);
        const fontIn = sfxFontPx(letteringText(line.text, doc.format.language), b.w * pageWpx, pageWpx) / CSS_PX_PER_IN;
        style = ` style="font-size:${round3(fontIn)}in;color:${s.color};transform:rotate(${s.rotate}deg);-webkit-text-stroke:${round3(Math.max(0.01, fontIn * 0.06))}in #111;text-shadow:${round3(fontIn * 0.05)}in ${round3(fontIn * 0.05)}in 0 #111"`;
      }
      return `<div class="b" ${attrs} style="left:${b.x * 100}%;top:${b.y * 100}%;width:${b.w * 100}%"><div class="bt k-${line.kind}"${style}>${text}</div></div>`;
    })
    .join('');
};

/** The print document (pure: string in, string out). */
export const buildPrintHtml = (doc: ComicDoc, sheets: PrintSheet[], opts: { skipped?: string[] } = {}): string => {
  const sheetAspect = sheets.find((s) => s.kind === 'page')?.aspect || aspectNumber(doc.format.pageAspect);
  const { widthIn, heightIn } = printPageSize(sheetAspect);
  const title = escapeHtml(doc.brief.title || 'Comic');
  const scaled = (k: LineKind) => `calc(var(--pw) * ${LETTERING.fontScale * KIND_SCALE[k]})`;
  const css = `
@page { size: ${widthIn}in ${heightIn}in; margin: 0; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html, body { margin: 0; padding: 0; background: #e9e7e1; }
body { font-family: Inter, system-ui, -apple-system, sans-serif; color: #1a1915; }
.bar { position: sticky; top: 0; z-index: 10; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding: 10px 16px; background: rgba(250,249,245,0.96); border-bottom: 1px solid rgba(0,0,0,0.1); font-size: 13px; }
.bar strong { font-weight: 600; }
.bar button { font: inherit; font-weight: 600; color: #fff; background: #D97757; border: 0; border-radius: 10px; padding: 7px 14px; cursor: pointer; }
.bar .muted { color: #6e6a60; }
.sheet { position: relative; width: ${widthIn}in; height: ${heightIn}in; margin: 18px auto; overflow: hidden; background: #fff; box-shadow: 0 4px 24px rgba(0,0,0,0.18); break-after: page; page-break-after: always; }
.sheet:last-of-type { break-after: auto; page-break-after: auto; }
.frame { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.page { position: relative; flex: none; }
.page > img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; }
.b { position: absolute; }
.b > svg { position: absolute; left: 0; top: 0; overflow: visible; }
.bt { position: relative; text-align: center; color: #111; font-family: 'Comic Neue', 'Comic Sans MS', cursive; font-weight: 700; font-size: ${scaled('speech')}; line-height: ${LETTERING.lineHeight}; padding: calc(var(--pw) * ${LETTERING.padY}) calc(var(--pw) * ${LETTERING.padX}); text-wrap: balance; overflow-wrap: break-word; }
.bt.k-whisper { font-size: ${scaled('whisper')}; font-style: italic; }
.bt.k-shout { font-size: ${scaled('shout')}; }
.bt.k-caption { font-size: ${scaled('caption')}; }
.bt.k-sfx { font-family: 'Bangers', Impact, sans-serif; font-weight: 400; line-height: 1; padding: 0; letter-spacing: 0.02em; paint-order: stroke fill; }
@media print {
  html, body { background: #fff; }
  .bar { display: none; }
  .sheet { margin: 0; box-shadow: none; }
}`;
  const body = sheets
    .map((s) => {
      const box = fitBox(widthIn, heightIn, s.aspect);
      const alt = s.kind === 'cover' ? `Cover of ${doc.brief.title}` : s.label;
      const lettering = s.page ? balloonsHtml(doc, s.page, box.w) : '';
      return `<section class="sheet" data-kind="${s.kind}" data-label="${escapeHtml(s.label)}"><div class="frame"><div class="page" data-aspect="${round3(s.aspect)}" style="width:${box.w}in;height:${box.h}in;--pw:${box.w}in"><img src="${escapeHtml(s.imageUrl)}" alt="${escapeHtml(alt)}">${lettering}</div></div></section>`;
    })
    .join('\n');
  const skipped = opts.skipped?.length ? `<span class="muted">Not included: ${escapeHtml(opts.skipped.join(', '))}</span>` : '';
  return `<!doctype html>
<html lang="${escapeHtml(doc.format.language || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS_HREF}">
<style>${css}</style>
</head>
<body>
<div class="bar"><strong>${title}</strong><span class="muted">${sheets.length} ${sheets.length === 1 ? 'page' : 'pages'}</span><button type="button" id="cs-print">Print / Save as PDF</button><span id="cs-status" class="muted">Preparing pages…</span>${skipped}</div>
${body}
</body>
</html>`;
};

/** One balloon's SVG outline (balloon-local CSS px) — same drawing order as the board. */
export const balloonSvgMarkup = (kind: LineKind, w: number, h: number, tip: Pt | null, seed: number, stroke: number, inset?: TextInset): string => {
  if (kind === 'sfx') return '';
  const shape = balloonShape(kind, w, h, { tip, seed, inset });
  const dash = shape.dashed ? ` stroke-dasharray="${dashArray(stroke)}"` : '';
  const parts: string[] = [];
  if (shape.tail) parts.push(`<path d="${shape.tail}" fill="${shape.fill}" stroke="${shape.stroke}" stroke-width="${stroke * 2}" stroke-linejoin="round"${dash}/>`);
  shape.bubbles.forEach((c) => parts.push(`<circle cx="${c.cx}" cy="${c.cy}" r="${c.r}" fill="${shape.fill}" stroke="${shape.stroke}" stroke-width="${stroke}"/>`));
  if (shape.body) parts.push(`<path d="${shape.body}" fill="${shape.fill}" stroke="${shape.stroke}" stroke-width="${stroke}" stroke-linejoin="round"${dash}/>`);
  if (shape.tail) parts.push(`<path d="${shape.tail}" fill="${shape.fill}" stroke="none"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${round3(w)}" height="${round3(h)}" aria-hidden="true">${parts.join('')}</svg>`;
};

const num = (v: string | null | undefined): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Size each page box to its image's real aspect, then measure every balloon and draw its
 * outline. Runs inside the print window after images and fonts are ready.
 */
export const decoratePrintDocument = (root: Document, doc: ComicDoc): void => {
  root.querySelectorAll<HTMLElement>('.sheet').forEach((sheet) => {
    const pageEl = sheet.querySelector<HTMLElement>('.page');
    if (!pageEl) return;
    const img = pageEl.querySelector('img');
    const sheetRect = sheet.getBoundingClientRect();
    if (img && img.naturalWidth > 0 && img.naturalHeight > 0 && sheetRect.width > 0 && sheetRect.height > 0) {
      const box = fitBox(sheetRect.width, sheetRect.height, img.naturalWidth / img.naturalHeight);
      pageEl.style.width = `${box.w}px`;
      pageEl.style.height = `${box.h}px`;
      pageEl.style.setProperty('--pw', `${box.w}px`);
    }
    const rect = pageEl.getBoundingClientRect();
    const aspect = num(pageEl.dataset.aspect) || aspectNumber(doc.format.pageAspect);
    const pageW = rect.width || parseFloat(pageEl.style.width) * CSS_PX_PER_IN || 672;
    const pageH = rect.height || pageW / aspect;
    const stroke = strokePx(pageW);
    pageEl.querySelectorAll<HTMLElement>('.b').forEach((el) => {
      el.querySelector('svg')?.remove();
      const kind = (el.dataset.kind || 'speech') as LineKind;
      if (kind === 'sfx') return;
      const x = num(el.dataset.x) ?? 0;
      const y = num(el.dataset.y) ?? 0;
      const w = num(el.dataset.w) ?? 0.2;
      const body = el.querySelector<HTMLElement>('.bt');
      const text = body?.textContent || '';
      const hPx = body?.offsetHeight || estimateBalloonHeight(text, w, aspect) * pageH;
      const balloon = { lineId: el.dataset.line || '', x, y, w, tailX: num(el.dataset.tx), tailY: num(el.dataset.ty) };
      const tip = tailTipOf(balloon, kind, pageH ? hPx / pageH : 0);
      const local = tip ? { x: (tip.tailX - x) * pageW, y: (tip.tailY - y) * pageH } : null;
      el.insertAdjacentHTML('afterbegin', balloonSvgMarkup(kind, w * pageW, hPx, local, hashSeed(balloon.lineId), stroke, balloonPaddingPx(pageW)));
    });
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

const fontsReady = async (root: Document, timeoutMs: number) => {
  const fonts = (root as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return;
  try {
    await Promise.race([
      Promise.all([fonts.load(`700 24px "Comic Neue"`), fonts.load(`24px "Bangers"`)]).then(() => fonts.ready),
      new Promise((resolve) => setTimeout(resolve, timeoutMs))
    ]);
  } catch {
    /* fall back to whatever loaded */
  }
};

export interface OpenPrintOptions {
  /** Window to render into (tests); by default a new tab is opened. Must be opened in the click handler. */
  win?: Window | null;
  onStatus?: (status: string) => void;
  /** Per-image load timeout. */
  timeoutMs?: number;
}

/**
 * Open the print view and start printing. Call it directly from a click handler (the
 * window is opened synchronously, before any await, so pop-up blockers allow it).
 */
export async function openPrintView(doc: ComicDoc, urlFor: UrlFor, opts: OpenPrintOptions = {}): Promise<PrintResult> {
  const { sheets, skipped } = collectPrintSheets(doc, urlFor);
  if (!sheets.length) {
    throw new PrintError(skipped.length ? `Nothing printable yet — ${skipped[0].toLowerCase()}.` : 'Nothing to print yet — draw at least one page first.');
  }
  const win = opts.win !== undefined ? opts.win : typeof window !== 'undefined' ? window.open('', '_blank') : null;
  if (!win) throw new PrintError('Your browser blocked the print window. Allow pop-ups for this site, then try again.');
  const status = (text: string) => {
    const el = win.document.getElementById('cs-status');
    if (el) el.textContent = text;
    opts.onStatus?.(text);
  };
  try {
    win.document.open();
    win.document.write(buildPrintHtml(doc, sheets, { skipped }));
    win.document.close();
  } catch {
    throw new PrintError('Couldn’t prepare the print window. Try again, or allow pop-ups for this site.');
  }
  status(`Loading ${sheets.length} ${sheets.length === 1 ? 'page' : 'pages'}…`);
  const failedImages = await waitForImages(win.document, opts.timeoutMs ?? 45_000);
  await fontsReady(win.document, 6000);
  decoratePrintDocument(win.document, doc);
  win.document.getElementById('cs-print')?.addEventListener('click', () => win.print());
  status(
    failedImages.length
      ? `Some images didn’t load (${failedImages.join(', ')}) — their links may have expired. Close this tab and print again.`
      : 'Ready. In the print dialog choose “Save as PDF” to keep a PDF.'
  );
  try {
    win.focus();
    win.print();
  } catch {
    /* the user can still use the Print button in the window */
  }
  return { pages: sheets.length, skipped, failedImages };
}
