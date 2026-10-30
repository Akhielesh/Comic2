// Book plates (title page, "The End", back cover) for exports — timeline.md §4.1. The layout is
// `plateLayout()` (timeline/plates.ts): plate units 1000 wide, text pre-wrapped and fitted, fixed
// content colours. The canvas drawing below and the print SVG mirror PlateView.tsx node for node, so a
// plate looks the same in the timeline, the reader, the print view, the PDF, the ZIP and the video.

import type { ComicDoc } from '../../../shared/comic/doc';
import { PLATE_COLORS, PLATE_FONTS, plateLayout, type PlateKind, type PlateLayout } from '../timeline/plates';
import { escapeAttr } from './html';

/** The plate's own layout for this (localized) doc. */
export const plateFor = (doc: ComicDoc, kind: PlateKind): PlateLayout => plateLayout(doc, kind);

const ART_RADIUS = 14;
const ART_PLACEHOLDER = '#e9e2d4';

export interface PlateArtImage {
  source: CanvasImageSource;
  width: number;
  height: number;
}

const roundRectPath = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
};

/**
 * Draw a plate at the current transform in plate units (callers scale by targetWidth / 1000).
 * `art` is the back cover's vignette (the cover image), drawn "slice" into its rounded frame; without
 * it the frame shows its calm placeholder colour.
 */
export function drawPlate(ctx: CanvasRenderingContext2D, layout: PlateLayout, art?: PlateArtImage | null): void {
  ctx.save();
  ctx.fillStyle = PLATE_COLORS.paper;
  ctx.fillRect(0, 0, layout.width, layout.height);
  if (layout.art) {
    const a = layout.art;
    ctx.save();
    roundRectPath(ctx, a.x, a.y, a.w, a.h, ART_RADIUS);
    ctx.fillStyle = ART_PLACEHOLDER;
    ctx.fill();
    if (art && art.width > 0 && art.height > 0) {
      ctx.clip();
      // preserveAspectRatio="xMidYMid slice": cover the frame, centred.
      const scale = Math.max(a.w / art.width, a.h / art.height);
      const w = art.width * scale;
      const h = art.height * scale;
      ctx.drawImage(art.source, a.x + (a.w - w) / 2, a.y + (a.h - h) / 2, w, h);
    }
    ctx.restore();
  }
  ctx.strokeStyle = PLATE_COLORS.accent;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (const r of layout.rules) {
    ctx.beginPath();
    ctx.moveTo(r.x1, r.y1);
    ctx.lineTo(r.x2, r.y2);
    ctx.stroke();
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const t of layout.texts) {
    ctx.font = `${t.italic ? 'italic ' : ''}${t.weight} ${t.fontSize}px ${PLATE_FONTS[t.font]}`;
    ctx.fillStyle = PLATE_COLORS[t.tone];
    if ('direction' in ctx) (ctx as CanvasRenderingContext2D & { direction: CanvasDirection }).direction = t.dir;
    t.lines.forEach((line, i) => ctx.fillText(line, t.x, t.y + i * t.lineGap));
  }
  ctx.restore();
}

/** The plate as a standalone SVG (print view). Every text and URL is escaped. */
export function plateSvgMarkup(layout: PlateLayout, artUrl?: string, idPrefix = 'plate'): string {
  const id = `${idPrefix.replace(/[^a-zA-Z0-9_-]/g, '')}-art`;
  const parts: string[] = [`<rect x="0" y="0" width="${layout.width}" height="${layout.height}" fill="${PLATE_COLORS.paper}"/>`];
  if (layout.art) {
    const a = layout.art;
    parts.push(`<clipPath id="${id}"><rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" rx="${ART_RADIUS}"/></clipPath>`);
    parts.push(`<rect x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" rx="${ART_RADIUS}" fill="${ART_PLACEHOLDER}"/>`);
    if (artUrl) {
      parts.push(
        `<image href="${escapeAttr(artUrl)}" x="${a.x}" y="${a.y}" width="${a.w}" height="${a.h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>`
      );
    }
  }
  for (const r of layout.rules) {
    parts.push(`<line x1="${r.x1}" y1="${r.y1}" x2="${r.x2}" y2="${r.y2}" stroke="${PLATE_COLORS.accent}" stroke-width="3" stroke-linecap="round"/>`);
  }
  for (const t of layout.texts) {
    const spans = t.lines.map((line, i) => `<tspan x="${t.x}" dy="${i === 0 ? 0 : t.lineGap}">${escapeAttr(line)}</tspan>`).join('');
    parts.push(
      `<text x="${t.x}" y="${t.y}" text-anchor="middle" direction="${t.dir === 'rtl' ? 'rtl' : 'ltr'}" font-family="${escapeAttr(PLATE_FONTS[t.font])}" font-size="${t.fontSize}" font-weight="${t.weight}"${t.italic ? ' font-style="italic"' : ''} fill="${PLATE_COLORS[t.tone]}">${spans}</text>`
    );
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${escapeAttr(layout.alt)}">${parts.join('')}</svg>`;
}
