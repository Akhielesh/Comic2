// Tiny panel-grid glyph of a page layout (contract §13.3, assets.md §6; owner P1-LIBRARY).
// Draws the page's estimated panel boxes (shared pageGeometry, the same boxes the editor and the
// breakdown card use) as soft tiles on a paper frame, with panel numbers once the glyph is big
// enough to read them. Pure SVG in currentColor, so it sits right in light and dark themes at $0.

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

/** Numbers appear from this width up (smaller glyphs stay calm). */
export const LAYOUT_GLYPH_NUMBERS_FROM = 44;

const placeholderPanels = (n: number): Panel[] =>
  Array.from({ length: Math.max(0, Math.min(12, Math.floor(Number.isFinite(n) ? n : 1))) }, (_, i) => ({
    id: `glyph_${i + 1}`,
    n: i + 1,
    size: 'medium',
    shot: 'medium',
    action: '',
    castIds: [],
    lines: []
  }));

const fin = (n: number, d = 0) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : d);

export const LayoutGlyph: React.FC<LayoutGlyphProps> = ({ page, layout, panels, aspect, size = 28 }) => {
  const ratio = aspectRatioOf(aspect) || 2 / 3;
  const W = 100;
  const H = fin(W / ratio, 150);
  const source = page ?? { panels: placeholderPanels(panels ?? 1), layout: layout ?? '' };
  const boxes = estimatePanelBoxes(source);
  const width = Math.max(8, Math.round(Number.isFinite(size) ? size : 28));
  const gap = width < 24 ? 3.5 : 2.5;
  const numbers = width >= LAYOUT_GLYPH_NUMBERS_FROM && boxes.length > 0 && boxes.length <= 12;
  const label = Math.max(8, Math.min(22, (W / Math.sqrt(Math.max(1, boxes.length))) * 0.32));
  return (
    <svg
      width={width}
      height={Math.round(width / ratio)}
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden
      focusable="false"
      className="shrink-0 text-[var(--ds-muted)]"
    >
      <rect x={0.75} y={0.75} width={W - 1.5} height={fin(H - 1.5)} rx={4} fill="currentColor" fillOpacity={0.05} stroke="currentColor" strokeWidth={1.5} strokeOpacity={0.45} />
      {boxes.map((b, i) => {
        const x = fin(b.x * W + gap);
        const y = fin(b.y * H + gap);
        const w = Math.max(0, fin(b.w * W - gap * 2));
        const h = Math.max(0, fin(b.h * H - gap * 2));
        return (
          <g key={i}>
            <rect x={x} y={y} width={w} height={h} rx={1.8} fill="currentColor" fillOpacity={i === 0 ? 0.26 : 0.16} />
            {numbers && w > label && h > label && (
              <text
                x={fin(x + w / 2)}
                y={fin(y + h / 2)}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={fin(label)}
                fontWeight={600}
                fill="currentColor"
                fillOpacity={0.7}
                fontFamily="system-ui, -apple-system, sans-serif"
              >
                {i + 1}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};

export default LayoutGlyph;
