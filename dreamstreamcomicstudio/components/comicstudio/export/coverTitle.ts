// Overlay cover title for exports (decisions-final #2, i18n.md §7.2). A textless cover
// (`cover.lettering === 'overlay'`) gets its title and tagline set by software — per language and free.
// The layout is `planCoverTitle` (lettering/CoverTitleLayer.tsx), the same pure plan the board and the
// reader draw, so the PNG/PDF/print/motion cover matches the screen. A painted (in-art) cover draws
// nothing here: its title is part of the art.

import type { ComicDoc } from '../../../shared/comic/doc';
import type { Measure } from '../../../shared/comic/lettering/layout';
import { planCoverTitle, type CoverTextBlock } from '../lettering/CoverTitleLayer';
import { nodesToMarkup, paintOf, type SvgNode } from '../lettering/svgMarkup';

const r2 = (n: number) => Math.round(n * 100) / 100;
const FONT_RE = /^(italic\s+)?(\d{3})\s+([\d.]+)px\s+(.*)$/;

/** Drawing nodes for one block (same order as CoverTitleLayer: shadow copy, then fill with outline). */
export function coverBlockNodes(blk: CoverTextBlock): SvgNode[] {
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
}

/** The cover title + tagline as drawing nodes in plan units (page width 1000); [] for a painted cover. */
export function coverTitleNodes(doc: ComicDoc, aspect: number, measure: Measure): SvgNode[] {
  if (doc.cover?.lettering !== 'overlay') return [];
  const plan = planCoverTitle(doc, aspect, measure);
  return [...(plan.title ? coverBlockNodes(plan.title) : []), ...(plan.tagline ? coverBlockNodes(plan.tagline) : [])];
}

/** Text the overlay title draws (accessible label, alt text). */
export function coverTitleText(doc: ComicDoc, aspect: number, measure: Measure): string {
  if (doc.cover?.lettering !== 'overlay') return '';
  const plan = planCoverTitle(doc, aspect, measure);
  return [plan.title?.text, plan.tagline?.text].filter(Boolean).join(' — ');
}

/** A standalone overlay <svg> for the print view (viewBox 1000 × 1000/aspect); '' for a painted cover. */
export function coverTitleSvgMarkup(doc: ComicDoc, aspect: number, measure: Measure): string {
  const nodes = coverTitleNodes(doc, aspect, measure);
  if (!nodes.length) return '';
  const H = r2(1000 / (aspect > 0 ? aspect : 2 / 3));
  return `<svg xmlns="http://www.w3.org/2000/svg" class="cover-title" viewBox="0 0 1000 ${H}" preserveAspectRatio="none" aria-hidden="true">${nodesToMarkup(nodes)}</svg>`;
}
