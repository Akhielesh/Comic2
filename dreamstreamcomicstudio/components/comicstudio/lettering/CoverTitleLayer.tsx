// Overlay cover title (contract §13.3; decisions-final #2). Renders only when `cover.lettering ===
// 'overlay'` (a textless cover): the title and tagline are set by software over the art — free to edit
// and per-language (the doc passed in is the localized one). Painted (in-art) covers render nothing.
// `planCoverTitle` is pure and shared with the exporter, so the PNG/PDF cover matches the screen.

import React, { useMemo } from 'react';
import { DEFAULT_COVER_TITLE_BOX, type Box, type ComicDoc } from '../../../shared/comic/doc';
import type { Measure } from '../../../shared/comic/lettering/layout';
import { fontString, resolveLetteringFont } from '../../../shared/comic/lettering/fonts';
import { applyTextCase } from '../../../shared/comic/lettering/layout';
import { mergeStylePatch, sanitizeLetterStylePatch, type LetterStyle, type LetterStylePatch } from '../../../shared/comic/lettering/style';
import { scriptOf } from '../../../shared/comic/languages';
import { normalizeLetteringText, wrapBalancedLines } from '../../../shared/comic/textLayout';
import { paintOf, type SvgNode } from './svgMarkup';
import { svgNodeToReact } from './LetteringSvg';
import { useLetteringFontsReady } from './useLetteringFontsReady';

export interface CoverTitleLayerProps {
  /** The (localized) doc. */
  doc: ComicDoc;
  aspect: number;
}

type TitleStyle = Pick<LetterStyle, 'font' | 'weight' | 'italic' | 'textCase' | 'textColor' | 'textStroke' | 'shadow' | 'align' | 'lineHeight' | 'sizeScale'>;

const TITLE_DEFAULT: TitleStyle = {
  font: 'bangers',
  weight: 400,
  italic: false,
  textCase: 'upper',
  textColor: '#ffffff',
  textStroke: { color: '#111111', width: 0.14 },
  shadow: { color: '#111111', dx: 0.04, dy: 0.05 },
  align: 'center',
  lineHeight: 1.05,
  sizeScale: 1
};
const TAGLINE_DEFAULT: TitleStyle = {
  font: 'comic-neue',
  weight: 700,
  italic: false,
  textCase: 'as_typed',
  textColor: '#ffffff',
  textStroke: { color: '#111111', width: 0.16 },
  shadow: null,
  align: 'center',
  lineHeight: 1.2,
  sizeScale: 1
};

export interface CoverTextBlock {
  text: string;
  lines: string[];
  font: string;
  fontSize: number;
  lineHeight: number;
  /** Baselines (plan units, page width 1000). */
  x: number;
  ys: number[];
  anchor: 'start' | 'middle' | 'end';
  style: TitleStyle;
  lang: string;
  dir: 'ltr' | 'rtl';
}

const resolveStyle = (base: TitleStyle, patch: LetterStylePatch | undefined): TitleStyle => {
  const clean = sanitizeLetterStylePatch(patch);
  const merged = mergeStylePatch(base as LetterStylePatch, clean) as TitleStyle | undefined;
  return { ...base, ...(merged || {}) };
};

/** Fit `text` into a box (plan units): the largest size (≤ maxSize) whose balanced wrap fits. */
const fitBlock = (text: string, style: TitleStyle, lang: string, box: { x: number; y: number; w: number; h: number }, maxSize: number, measure: Measure): CoverTextBlock | null => {
  const spec = scriptOf(lang);
  const t = applyTextCase(normalizeLetteringText(text), style.textCase, lang);
  if (!t) return null;
  const rf = resolveLetteringFont(style.font, 'caption', lang, { weight: style.weight, italic: style.italic && spec.allowItalic });
  const lh = style.lineHeight * (spec.lineHeight / 1.3);
  let size = Math.max(12, maxSize * style.sizeScale);
  let lines: string[] = [t];
  for (let i = 0; i < 40; i += 1) {
    const font = fontString(rf.fontId, size, rf.weight, rf.italic);
    const m = (s: string) => measure(s, font);
    lines = wrapBalancedLines(t, lang, box.w, m);
    const widest = Math.max(0, ...lines.map(m));
    if (widest <= box.w && lines.length * size * lh <= box.h) break;
    if (size <= 12) break;
    size = Math.max(12, size * 0.92);
  }
  size = Math.round(size * 100) / 100;
  const total = lines.length * size * lh;
  const top = box.y + Math.max(0, (box.h - total) / 2);
  const anchor = style.align === 'center' ? 'middle' : style.align === 'left' ? (spec.dir === 'rtl' ? 'end' : 'start') : spec.dir === 'rtl' ? 'start' : 'end';
  const x = style.align === 'center' ? box.x + box.w / 2 : style.align === 'left' ? box.x : box.x + box.w;
  return {
    text: t,
    lines,
    font: fontString(rf.fontId, size, rf.weight, rf.italic),
    fontSize: size,
    lineHeight: lh,
    x,
    ys: lines.map((_l, i) => Math.round((top + i * size * lh + size * lh / 2 + 0.35 * size) * 100) / 100),
    anchor,
    style: { ...style, font: rf.fontId },
    lang,
    dir: spec.dir
  };
};

/** Title + tagline blocks for an overlay cover (pure; plan units, page width 1000). */
export function planCoverTitle(doc: ComicDoc, aspect: number, measure: Measure): { title: CoverTextBlock | null; tagline: CoverTextBlock | null } {
  const cover = doc.cover;
  if (!cover || cover.lettering !== 'overlay') return { title: null, tagline: null };
  const H = 1000 / (aspect > 0 ? aspect : 2 / 3);
  const lang = doc.format?.language || 'en';
  const raw: Box = cover.titleStyle?.box ?? DEFAULT_COVER_TITLE_BOX;
  const b = { x: raw.x * 1000, y: raw.y * H, w: raw.w * 1000, h: raw.h * H };
  const title = fitBlock(cover.title || doc.brief?.title || '', resolveStyle(TITLE_DEFAULT, cover.titleStyle?.title), lang, b, Math.min(b.h * 0.8, 150), measure);
  const tagY = typeof cover.titleStyle?.taglineY === 'number' ? cover.titleStyle.taglineY * H : b.y + b.h + 0.01 * H;
  const tagline = cover.tagline
    ? fitBlock(cover.tagline, resolveStyle(TAGLINE_DEFAULT, cover.titleStyle?.tagline), lang, { x: b.x, y: tagY, w: b.w, h: 0.08 * H }, Math.min(46, (title?.fontSize ?? 60) * 0.42), measure)
    : null;
  return { title, tagline };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const FONT_RE = /^(italic\s+)?(\d{3})\s+([\d.]+)px\s+(.*)$/;

/**
 * Drawing nodes for one title/tagline block, in plan units: a shadow copy, then the fill with its outline
 * (stroke colour, opacity and width; `paint-order: stroke`). The ONE implementation the screen draws and the
 * exports reuse (export/coverTitle.ts can call this instead of keeping a copy), so a translucent outline or a
 * shadow offset reads the same on the board, in the reader and in the PNG/PDF.
 */
export const blockNodes = (blk: CoverTextBlock): SvgNode[] => {
  const fill = paintOf(blk.style.textColor) ?? { color: '#ffffff', opacity: 1 };
  const stroke = blk.style.textStroke ? paintOf(blk.style.textStroke.color) : null;
  const shadow = blk.style.shadow ? paintOf(blk.style.shadow.color) : null;
  const m = FONT_RE.exec(blk.font);
  const base: SvgNode['attrs'] = {
    'font-family': m?.[4] ?? 'sans-serif',
    'font-size': blk.fontSize,
    'font-weight': m ? Number(m[2]) : 400,
    'font-style': m?.[1] ? 'italic' : undefined,
    'text-anchor': blk.anchor,
    direction: blk.dir === 'rtl' ? 'rtl' : undefined
  };
  const texts = (attrs: SvgNode['attrs']): SvgNode[] => blk.lines.map((line, i) => ({ tag: 'text', attrs: { ...base, ...attrs, x: blk.x, y: blk.ys[i] }, text: line }));
  const out: SvgNode[] = [];
  if (shadow && blk.style.shadow) {
    out.push({
      tag: 'g',
      attrs: { transform: `translate(${r2(blk.style.shadow.dx * blk.fontSize)} ${r2(blk.style.shadow.dy * blk.fontSize)})`, opacity: shadow.opacity < 1 ? shadow.opacity : undefined },
      children: texts({ fill: shadow.color })
    });
  }
  out.push({
    tag: 'g',
    attrs: { 'fill-opacity': fill.opacity < 1 ? fill.opacity : undefined, lang: blk.lang },
    children: texts({
      fill: fill.color,
      ...(stroke && blk.style.textStroke
        ? { stroke: stroke.color, 'stroke-opacity': stroke.opacity < 1 ? stroke.opacity : undefined, 'stroke-width': r2(blk.style.textStroke.width * blk.fontSize), 'stroke-linejoin': 'round', 'paint-order': 'stroke' }
        : {})
    })
  });
  return out;
};

export const CoverTitleLayer: React.FC<CoverTitleLayerProps> = ({ doc, aspect }) => {
  const overlay = doc.cover?.lettering === 'overlay';
  // The faces actually drawn: a Telugu or Hindi cover letters in the language's script face, so load
  // that one (a Latin-only face would leave the title in a system fallback).
  const lang = doc.format?.language || 'en';
  const fonts = useMemo(() => {
    const t = doc.cover?.titleStyle;
    const ids = [t?.title?.font ?? TITLE_DEFAULT.font, t?.tagline?.font ?? TAGLINE_DEFAULT.font].map((id) => resolveLetteringFont(id, 'caption', lang).fontId);
    return [...new Set(ids)];
  }, [doc.cover?.titleStyle, lang]);
  const sample = `${doc.cover?.title || doc.brief?.title || ''} ${doc.cover?.tagline || ''}`.slice(0, 160);
  const { measure } = useLetteringFontsReady(overlay ? fonts : [], { weights: [400, 700], sample });
  const asp = Number.isFinite(aspect) && aspect > 0 ? aspect : 2 / 3;
  const plan = useMemo(() => (overlay ? planCoverTitle(doc, asp, measure) : { title: null, tagline: null }), [overlay, doc, asp, measure]);
  if (!overlay || (!plan.title && !plan.tagline)) return null;
  const H = Math.round((1000 / asp) * 100) / 100;
  const label = [plan.title?.text, plan.tagline?.text].filter(Boolean).join(' — ');
  const nodes = [...(plan.title ? blockNodes(plan.title) : []), ...(plan.tagline ? blockNodes(plan.tagline) : [])];
  return (
    <svg
      data-testid="cover-title"
      viewBox={`0 0 1000 ${H}`}
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 z-[2] h-full w-full select-none"
      role="img"
      aria-label={label}
      focusable="false"
    >
      {nodes.map((n, i) => svgNodeToReact(n, i))}
    </svg>
  );
};

export default CoverTitleLayer;
