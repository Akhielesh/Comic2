// The one lettering renderer for the board (contract §13.3; lettering.md §6.2): draws LetterPlans from
// the shared engine as one <svg viewBox="0 0 1000 H" preserveAspectRatio="none"> over the art, in z
// order. Geometry is computed, not measured — no ResizeObserver per balloon, no small-page scaling hack:
// a thumbnail and a full-screen page are the same drawing at different sizes. SVG text stays crisp at any
// zoom and each balloon is announced as "Speech — Maya: …" (role img) unless `ariaHidden` (the reader
// supplies its own ordered transcript). Used by BalloonLayer (board, editor, reader), preset chips and
// font previews. The drawing itself lives in svgMarkup.ts, shared with the print renderer.

import React, { useId, useMemo } from 'react';
import type { LetterPlan } from '../../../shared/comic/lettering/index';
import { letteringNodes, type LetteringDrawOptions, type SvgNode } from './svgMarkup';

export interface LetteringSvgProps {
  plans: LetterPlan[];
  /** Page aspect (w/h); the SVG viewBox is 1000 × 1000/aspect. */
  aspect: number;
  ariaHidden?: boolean;
  visibleLineIds?: ReadonlySet<string>;
  selectedLineIds?: ReadonlySet<string>;
  /** Rendered width in CSS px: keeps outlines ≥ 1.25 px on small pages. */
  widthPx?: number;
  /** The doc's lettering language; plans in another language carry `data-fallback-lang`. */
  docLang?: string;
  /** Show the subtle "not translated yet" marker on fallback-language lines. */
  markFallbackLang?: boolean;
  labelFor?: LetteringDrawOptions['labelFor'];
  className?: string;
  style?: React.CSSProperties;
}

/** SVG attribute name → React prop name (aria-*, data-*, role, lang, dir pass through). */
const reactName = (name: string): string => {
  if (name === 'class') return 'className';
  if (/^(aria-|data-)/.test(name) || name === 'role' || name === 'lang' || name === 'dir') return name;
  return name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
};

const styleObject = (css: string): React.CSSProperties => {
  const out: Record<string, string> = {};
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i <= 0) continue;
    const key = decl.slice(0, i).trim().replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    out[key] = decl.slice(i + 1).trim();
  }
  return out as React.CSSProperties;
};

/** Render one drawing node as a React SVG element (shared by every lettering preview). */
export const svgNodeToReact = (node: SvgNode, key: React.Key): React.ReactElement => {
  const props: Record<string, unknown> = { key };
  for (const [k, v] of Object.entries(node.attrs)) {
    if (v === undefined) continue;
    if (k === 'style') props.style = styleObject(String(v));
    else props[reactName(k)] = v;
  }
  const children: React.ReactNode[] = [];
  if (node.text !== undefined) children.push(node.text);
  (node.children || []).forEach((c, i) => children.push(svgNodeToReact(c, i)));
  return React.createElement(node.tag, props, ...children);
};

export const LetteringSvg: React.FC<LetteringSvgProps> = ({
  plans,
  aspect,
  ariaHidden,
  visibleLineIds,
  selectedLineIds,
  widthPx,
  docLang,
  markFallbackLang,
  labelFor,
  className,
  style
}) => {
  const rawId = useId();
  const idPrefix = `ls${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const asp = Number.isFinite(aspect) && aspect > 0 ? aspect : 2 / 3;
  const H = Math.round((1000 / asp) * 100) / 100;
  const nodes = useMemo(
    () => letteringNodes(plans, { aspect: asp, widthPx, visibleLineIds, selectedLineIds, docLang, markFallbackLang, idPrefix, labelFor }),
    [plans, asp, widthPx, visibleLineIds, selectedLineIds, docLang, markFallbackLang, idPrefix, labelFor]
  );
  if (!plans.length) return null;
  return (
    <svg
      data-testid="lettering-svg"
      viewBox={`0 0 1000 ${H}`}
      preserveAspectRatio="none"
      className={className ?? 'pointer-events-none absolute inset-0 h-full w-full select-none'}
      style={style}
      focusable="false"
      {...(ariaHidden ? { 'aria-hidden': true } : { role: 'group', 'aria-label': 'Lettering' })}
    >
      {nodes.map((n, i) => svgNodeToReact(n, i))}
    </svg>
  );
};

export default LetteringSvg;
