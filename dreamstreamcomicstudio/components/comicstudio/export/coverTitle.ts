// Overlay cover title for exports (decisions-final #2, i18n.md §7.2). A textless cover
// (`cover.lettering === 'overlay'`) gets its title and tagline set by software — per language and free.
// The layout is `planCoverTitle` (lettering/CoverTitleLayer.tsx), the same pure plan the board and the
// reader draw, so the PNG/PDF/print/motion cover matches the screen. A painted (in-art) cover draws
// nothing here: its title is part of the art.

import type { ComicDoc } from '../../../shared/comic/doc';
import type { Measure } from '../../../shared/comic/lettering/layout';
import { blockNodes, planCoverTitle, type CoverTextBlock } from '../lettering/CoverTitleLayer';
import { nodesToMarkup, type SvgNode } from '../lettering/svgMarkup';

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Drawing nodes for one block: shadow copy, then fill with outline. The ONE definition lives in
 * CoverTitleLayer (`blockNodes`) and the screen draws it too, so the PNG/PDF/print/motion cover can
 * never drift from the board and the reader (P2-EXPORT #4; the old copy here is gone).
 */
export const coverBlockNodes: (blk: CoverTextBlock) => SvgNode[] = blockNodes;

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
