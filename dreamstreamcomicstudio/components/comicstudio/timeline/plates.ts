// Deterministic book furniture (timeline.md §4.1 "PlateView, plates.ts"): the title page, "The End"
// with credits, and the auto back cover. Laid out by software, never billed.
//
// Pure layout in PLATE UNITS — the plate is 1000 wide × 1000/aspect tall — so the same numbers drive
// the React SVG (PlateView), the print view and canvas exports (scale by targetWidth / 1000). Text is
// pre-wrapped with the shared script-aware wrapper (shared/comic/textLayout.ts) and shrunk until it
// fits its box; when even the minimum size can't hold it, the last line ends in "…" — a plate never
// overflows. Colours are CONTENT colours (a printed page), not studio chrome, so they are fixed here
// and identical in light/dark themes, on screen and in exports.

import { bookOf, type Box, type ComicDoc } from '../../../shared/comic/doc';
import { scriptOf, dirOf } from '../../../shared/comic/languages';
import { graphemes, wrapLines } from '../../../shared/comic/textLayout';
import { canServeToOwner } from '../../../shared/comic/safety';
import { aspectRatioOf } from '../../../shared/comic/models';

export type PlateKind = 'title' | 'end' | 'back_cover';

export const PLATE_WIDTH = 1000;
/** Content colours of the printed plates (paper, ink, accent). */
export const PLATE_COLORS = { paper: '#f6f1e7', ink: '#221e19', muted: '#6a6157', faint: '#9a9084', accent: '#D97757' } as const;
export const PLATE_FONTS = {
  display: 'Georgia, "Iowan Old Style", "Times New Roman", serif',
  body: 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", sans-serif'
} as const;
export const MADE_WITH = 'Made with DreamStream Comic Studio';

export interface PlateText {
  id: string;
  lines: string[];
  /** Anchor x (middle) and the FIRST baseline, plate units. */
  x: number;
  y: number;
  fontSize: number;
  /** Baseline-to-baseline distance. */
  lineGap: number;
  /** The box the text was fitted into (tests, debug overlays). */
  box: Box;
  font: keyof typeof PLATE_FONTS;
  weight: 400 | 600 | 700;
  italic?: boolean;
  tone: 'ink' | 'muted' | 'faint' | 'accent';
  /** Shrunk to the minimum and still cut ("…"). */
  truncated: boolean;
  dir: 'ltr' | 'rtl';
}

export interface PlateArt {
  path: string;
  /** Where the art sits on the plate (plate units). */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlateRule { x1: number; y1: number; x2: number; y2: number }

export interface PlateLayout {
  kind: PlateKind;
  width: number;
  height: number;
  aspect: number;
  texts: PlateText[];
  rules: PlateRule[];
  art?: PlateArt;
  /** Short description for screen readers and alt text. */
  alt: string;
}

const clean = (s: unknown): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

/** Width estimate in em: script-aware grapheme advance (no DOM, same on server/print/canvas). */
const emWidth = (text: string, lang: string, weight: number): number => {
  const spec = scriptOf(lang);
  const per = (weight >= 600 ? 0.56 : 0.5) * spec.widthFactor;
  return graphemes(text, lang).reduce((n, g) => n + (g === ' ' ? 0.28 : /[　-鿿가-힯＀-￯]/.test(g) ? 1 : per), 0);
};

interface FitSpec {
  id: string;
  text: string;
  box: Box; // plate units
  maxSize: number;
  minSize: number;
  lineHeight: number;
  font: PlateText['font'];
  weight: PlateText['weight'];
  italic?: boolean;
  tone: PlateText['tone'];
  lang: string;
  /** Vertical placement inside the box. */
  valign?: 'top' | 'middle';
}

/** Wrap + shrink-to-fit; ellipsize at the minimum size. Never exceeds the box. */
export function fitPlateText(spec: FitSpec): PlateText | null {
  const text = clean(spec.text);
  if (!text) return null;
  const { box, lang } = spec;
  const lh = Math.max(spec.lineHeight, scriptOf(lang).lineHeight * 0.92);
  let size = spec.maxSize;
  let lines: string[] = [];
  let truncated = false;
  for (;;) {
    const s = size;
    lines = wrapLines(text, lang, box.w, (str) => emWidth(str, lang, spec.weight) * s);
    const height = lines.length * s * lh;
    if (height <= box.h + 0.001) break;
    if (size <= spec.minSize) {
      const fit = Math.max(1, Math.floor(box.h / (s * lh)));
      if (lines.length > fit) {
        lines = lines.slice(0, fit);
        let last = lines[fit - 1];
        const g = graphemes(last, lang);
        while (g.length && emWidth(`${g.join('')}…`, lang, spec.weight) * s > box.w) g.pop();
        last = g.join('').trimEnd();
        lines[fit - 1] = `${last}…`;
        truncated = true;
      }
      break;
    }
    size = Math.max(spec.minSize, size * 0.92);
  }
  const blockH = lines.length * size * lh;
  const top = spec.valign === 'top' ? box.y : box.y + Math.max(0, (box.h - blockH) / 2);
  return {
    id: spec.id,
    lines,
    x: box.x + box.w / 2,
    // First baseline: half the leading above the cap height (≈ 0.8 em below the line top).
    y: top + size * ((lh - 1) / 2 + 0.8),
    fontSize: Math.round(size * 10) / 10,
    lineGap: Math.round(size * lh * 10) / 10,
    box,
    font: spec.font,
    weight: spec.weight,
    ...(spec.italic ? { italic: true } : {}),
    tone: spec.tone,
    truncated,
    dir: dirOf(lang)
  };
}

const titleOf = (doc: ComicDoc): string => clean(doc.cover.title) || clean(doc.brief.title) || 'Untitled comic';

/** The plate for a book slot. Pure: same doc ⇒ same layout. */
export function plateLayout(doc: ComicDoc, kind: PlateKind): PlateLayout {
  const aspect = aspectRatioOf(doc.format.pageAspect) || 2 / 3;
  const W = PLATE_WIDTH;
  const H = Math.round(W / aspect);
  const lang = doc.format.language || 'en';
  const book = bookOf(doc);
  const box = (x: number, y: number, w: number, h: number): Box => ({ x: x * W, y: y * H, w: w * W, h: h * H });
  const texts: (PlateText | null)[] = [];
  const rules: PlateRule[] = [];
  let art: PlateArt | undefined;
  const title = titleOf(doc);

  if (kind === 'title') {
    texts.push(fitPlateText({ id: 'title', text: title, box: box(0.1, 0.3, 0.8, 0.24), maxSize: 92, minSize: 40, lineHeight: 1.12, font: 'display', weight: 700, tone: 'ink', lang }));
    rules.push({ x1: W * 0.44, y1: H * 0.57, x2: W * 0.56, y2: H * 0.57 });
    const sub = clean(doc.cover.tagline) || clean(doc.brief.logline);
    texts.push(fitPlateText({ id: 'subtitle', text: sub, box: box(0.14, 0.6, 0.72, 0.18), maxSize: 34, minSize: 22, lineHeight: 1.35, font: 'display', weight: 400, italic: true, tone: 'muted', lang, valign: 'top' }));
    return { kind, width: W, height: H, aspect, texts: texts.filter((t): t is PlateText => !!t), rules, alt: `Title page: ${title}` };
  }

  if (kind === 'end') {
    texts.push(fitPlateText({ id: 'end', text: 'The End', box: box(0.1, 0.26, 0.8, 0.16), maxSize: 96, minSize: 48, lineHeight: 1.1, font: 'display', weight: 700, tone: 'ink', lang: 'en' }));
    rules.push({ x1: W * 0.44, y1: H * 0.46, x2: W * 0.56, y2: H * 0.46 });
    const credits = (book.credits || []).map(clean).filter(Boolean);
    const per = credits.length ? Math.min(0.07, 0.34 / credits.length) : 0;
    credits.forEach((c, i) =>
      texts.push(fitPlateText({ id: `credit-${i}`, text: c, box: box(0.12, 0.5 + i * per, 0.76, per), maxSize: 30, minSize: 18, lineHeight: 1.3, font: 'body', weight: 400, tone: 'muted', lang }))
    );
    texts.push(fitPlateText({ id: 'made-with', text: MADE_WITH, box: box(0.1, 0.9, 0.8, 0.05), maxSize: 20, minSize: 14, lineHeight: 1.2, font: 'body', weight: 400, tone: 'faint', lang: 'en' }));
    return { kind, width: W, height: H, aspect, texts: texts.filter((t): t is PlateText => !!t), rules, alt: `The End${credits.length ? `. ${credits.join('. ')}` : ''}` };
  }

  // Back cover: a framed vignette of the cover art (when drawn and allowed), the title, the blurb.
  const cover = doc.cover.render;
  let textTop = 0.14;
  if (cover.status === 'ready' && cover.asset?.path && canServeToOwner(cover.asset)) {
    const ratio = cover.asset.w && cover.asset.h ? cover.asset.w / cover.asset.h : aspect;
    let w = W * 0.4;
    let h = w / ratio;
    if (h > H * 0.36) {
      h = H * 0.36;
      w = h * ratio;
    }
    art = { path: cover.asset.path, x: (W - w) / 2, y: H * 0.08, w, h };
    textTop = (H * 0.08 + h) / H + 0.04;
  }
  texts.push(fitPlateText({ id: 'title', text: title, box: box(0.12, textTop, 0.76, 0.09), maxSize: 52, minSize: 28, lineHeight: 1.12, font: 'display', weight: 700, tone: 'ink', lang }));
  const blurb = clean(book.blurb) || clean(doc.brief.logline);
  const blurbTop = textTop + 0.11;
  texts.push(fitPlateText({ id: 'blurb', text: blurb, box: box(0.12, blurbTop, 0.76, Math.max(0.12, 0.86 - blurbTop)), maxSize: 32, minSize: 20, lineHeight: 1.45, font: 'body', weight: 400, tone: 'muted', lang, valign: 'top' }));
  texts.push(fitPlateText({ id: 'made-with', text: MADE_WITH, box: box(0.1, 0.9, 0.8, 0.05), maxSize: 20, minSize: 14, lineHeight: 1.2, font: 'body', weight: 400, tone: 'faint', lang: 'en' }));
  return {
    kind,
    width: W,
    height: H,
    aspect,
    texts: texts.filter((t): t is PlateText => !!t),
    rules,
    ...(art ? { art } : {}),
    alt: `Back cover: ${title}${blurb ? `. ${blurb}` : ''}`
  };
}

export const PLATE_LABEL: Record<PlateKind, string> = { title: 'Title page', end: 'The End', back_cover: 'Back cover' };
