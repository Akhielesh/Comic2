// Tiny panel-grid glyph of a page layout (contract §13.3; owner P1-LIBRARY).
// Wave 0 (P0-C) stub: a plain SVG of the estimated panel boxes (shared pageGeometry), no numbers.

import React from 'react';
import type { AspectRatio, Page, Panel } from '../../../../shared/comic/doc';
import { estimatePanelBoxes } from '../../../../shared/comic/pageGeometry';
import { aspectRatioOf } from '../../../../shared/comic/models';

export interface LayoutGlyphProps {
  page?: Page;
  layout?: string;
  panels?: number;
  aspect: AspectRatio;
  /** Width in px (default 28). */
  size?: number;
}

const placeholderPanels = (n: number): Panel[] =>
  Array.from({ length: Math.max(0, Math.min(12, Math.floor(n))) }, (_, i) => ({
    id: `glyph_${i + 1}`,
    n: i + 1,
    size: 'medium',
    shot: 'medium',
    action: '',
    castIds: [],
    lines: []
  }));

export const LayoutGlyph: React.FC<LayoutGlyphProps> = ({ page, layout, panels, aspect, size = 28 }) => {
  const ratio = aspectRatioOf(aspect) || 2 / 3;
  const W = 100;
  const H = Math.round((W / ratio) * 100) / 100;
  const source = page ?? { panels: placeholderPanels(panels ?? 1), layout: layout ?? '' };
  const boxes = estimatePanelBoxes(source);
  const gap = 2.5;
  return (
    <svg
      width={size}
      height={Math.round(size / ratio)}
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden
      focusable="false"
      className="shrink-0 text-[var(--ds-muted)]"
    >
      <rect x={0.75} y={0.75} width={W - 1.5} height={H - 1.5} rx={3} fill="none" stroke="currentColor" strokeWidth={1.5} opacity={0.5} />
      {boxes.map((b, i) => (
        <rect
          key={i}
          x={b.x * W + gap}
          y={b.y * H + gap}
          width={Math.max(0, b.w * W - gap * 2)}
          height={Math.max(0, b.h * H - gap * 2)}
          rx={1.5}
          fill="currentColor"
          opacity={0.18}
        />
      ))}
    </svg>
  );
};

export default LayoutGlyph;
