// The page node tree as React SVG (master plan §2.12 PE-COMPOSE): one <svg viewBox="0 0 1000 H"
// preserveAspectRatio="none"> — the lettering's coordinate space — holding what composeSvgNodes describes: the paper,
// the frames (each <image> of the page's ONE drawing URL clipped to its frame, then its border) and the overlays as
// g[data-layer-id] (clip, opacity and mix-blend-mode on that group; rotation and flip inside it). The print document
// draws the same tree as markup (nodesToMarkup), the exports draw it on a canvas (composeCanvas.ts).
//
// Pure rendering: no measuring, no timers. A picture that fails to load is reported once by URL (onImageError), so the
// page view can fall back exactly as it does for the plain <img>.

import React, { useId, useMemo } from 'react';
import type { SvgNode } from '../lettering/svgMarkup';
import { composeSvgNodes, type ComposeScene } from './pageNodes';

/** SVG attribute name → React prop name (aria-*, data-*, role pass through). */
const reactName = (name: string): string => {
  if (name === 'class') return 'className';
  if (/^(aria-|data-)/.test(name) || name === 'role') return name;
  return name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
};

const styleObject = (css: string): React.CSSProperties => {
  const out: Record<string, string> = {};
  for (const decl of css.split(';')) {
    const i = decl.indexOf(':');
    if (i <= 0) continue;
    out[decl.slice(0, i).trim().replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] = decl.slice(i + 1).trim();
  }
  return out as React.CSSProperties;
};

const toReact = (node: SvgNode, key: React.Key, onImageError?: (url: string) => void): React.ReactElement => {
  const props: Record<string, unknown> = { key };
  for (const [k, v] of Object.entries(node.attrs)) {
    if (v === undefined) continue;
    if (k === 'style') props.style = styleObject(String(v));
    else props[reactName(k)] = v;
  }
  if (node.tag === 'image' && onImageError) {
    const url = String(node.attrs.href ?? '');
    props.onError = () => onImageError(url);
  }
  const children: React.ReactNode[] = [];
  if (node.text !== undefined) children.push(node.text);
  (node.children || []).forEach((c, i) => children.push(toReact(c, i, onImageError)));
  return React.createElement(node.tag, props, ...children);
};

export interface ComposeLayerProps {
  scene: ComposeScene;
  className?: string;
  style?: React.CSSProperties;
  /** Announced as an image with this label (panels mode: the page itself); otherwise decorative (aria-hidden). */
  label?: string;
  /** A picture failed to load (its URL). */
  onImageError?: (url: string) => void;
  testId?: string;
}

/** The composed page (or, in page mode, the overlays over the drawing) as one SVG. */
export const ComposeLayer: React.FC<ComposeLayerProps> = ({ scene, className, style, label, onImageError, testId = 'compose-layer' }) => {
  const rawId = useId();
  const idPrefix = `cp${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const nodes = useMemo(() => composeSvgNodes(scene, idPrefix), [scene, idPrefix]);
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <svg
      data-testid={testId}
      data-compose={scene.mode}
      viewBox={`0 0 1000 ${scene.H}`}
      preserveAspectRatio="none"
      className={className ?? 'pointer-events-none absolute inset-0 h-full w-full select-none'}
      style={style}
      focusable="false"
      {...a11y}
    >
      {nodes.map((n, i) => toReact(n, i, onImageError))}
    </svg>
  );
};

export default ComposeLayer;
