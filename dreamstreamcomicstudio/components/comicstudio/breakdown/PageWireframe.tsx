// Page wireframe: the panel layout of one page as a calm inline SVG (softwarefirst.md §2.6).
//
// Boxes come from shared/comic/pageGeometry `panelBoxesFor` (via plan.ts summarizeBook): measured
// panel boxes when the drawn page was checked, else the row blueprint estimate — the same
// rectangles the server and the page editor use. Free, instant, no image needed.
//
// The SVG uses a page-shaped viewBox (`0 0 1 1/ratio`), so the boxes keep the page's real shape
// at any tile size. Colours are theme tokens applied through `style` (var() is not reliable in
// SVG presentation attributes).

import React from 'react';
import type { ShotType } from '../../../shared/comic/doc';
import type { PanelSummary } from '../../../shared/comic/plan';

/** One-letter shot glyphs (E/W/F/M/C/X/O/I/P). */
export const SHOT_GLYPH: Record<ShotType, string> = {
  establishing: 'E',
  wide: 'W',
  full: 'F',
  medium: 'M',
  close_up: 'C',
  extreme_close_up: 'X',
  over_shoulder: 'O',
  insert: 'I',
  pov: 'P'
};

/** "4 / 5" or "4:5" → 0.8 (falls back to 2:3). */
export const aspectNumber = (aspect: string): number => {
  const [w, h] = String(aspect || '').split(/[:/]/).map((s) => Number(s.trim()));
  return w > 0 && h > 0 ? w / h : 2 / 3;
};

export interface PageWireframeProps {
  panels: Pick<PanelSummary, 'n' | 'box' | 'shot' | 'speech' | 'captions' | 'sfx'>[];
  /** Page aspect, "4:5". */
  aspect: string;
  /** Panel numbers, shot glyphs and line dots (off for the tiniest thumbnails). */
  detail?: boolean;
  /** Highlight one panel (1-based n). */
  activePanel?: number;
  className?: string;
  /** When set the SVG is announced as an image with this label; otherwise it is decorative. */
  label?: string;
}

const MAX_DOTS = 4;

export const PageWireframe: React.FC<PageWireframeProps> = ({ panels, aspect, detail = true, activePanel, className, label }) => {
  const ratio = aspectNumber(aspect);
  const H = 1 / ratio;
  const font = Math.min(0.085, 0.06 * Math.max(1, H));
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <svg
      viewBox={`0 0 1 ${H.toFixed(4)}`}
      preserveAspectRatio="xMidYMid meet"
      className={className}
      style={{ display: 'block', width: '100%', height: '100%' }}
      focusable="false"
      {...a11y}
    >
      <rect x={0} y={0} width={1} height={H} style={{ fill: 'var(--ds-raised)' }} />
      {panels.length === 0 && (
        <text x={0.5} y={H / 2} textAnchor="middle" dominantBaseline="middle" style={{ fill: 'var(--ds-muted)', fontSize: 0.07 }}>
          No panels
        </text>
      )}
      {panels.map((p, i) => {
        const x = p.box.x;
        const y = p.box.y * H;
        const w = Math.max(0, p.box.w);
        const h = Math.max(0, p.box.h * H);
        const on = activePanel === p.n;
        const pad = Math.min(0.03, w * 0.12);
        const dots = Math.min(MAX_DOTS, p.speech);
        const caps = Math.min(MAX_DOTS, p.captions);
        const dotR = Math.min(0.018, h * 0.08);
        const showText = detail && w > 0.14 && h > 0.1;
        return (
          <g key={`${p.n}-${i}`}>
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              rx={0.008}
              vectorEffect="non-scaling-stroke"
              style={{
                fill: on ? 'rgba(217,119,87,0.14)' : 'var(--ds-surface-soft)',
                stroke: on ? '#D97757' : 'var(--ds-hairline)',
                strokeWidth: on ? 1.5 : 1
              }}
            />
            {showText && (
              <>
                <text x={x + pad} y={y + pad + font * 0.8} style={{ fill: 'var(--ds-muted)', fontSize: font, fontWeight: 600 }}>
                  {p.n}
                </text>
                <text x={x + w - pad} y={y + pad + font * 0.8} textAnchor="end" style={{ fill: 'var(--ds-muted)', fontSize: font * 0.85 }}>
                  {SHOT_GLYPH[p.shot] ?? ''}
                </text>
                {Array.from({ length: dots }, (_, k) => (
                  <circle key={`s${k}`} cx={x + pad + dotR + k * dotR * 2.6} cy={y + h - pad - dotR} r={dotR} style={{ fill: '#D97757', opacity: 0.75 }} />
                ))}
                {Array.from({ length: caps }, (_, k) => (
                  <rect
                    key={`c${k}`}
                    x={x + w - pad - (k + 1) * dotR * 3}
                    y={y + h - pad - dotR * 1.6}
                    width={dotR * 2.4}
                    height={dotR * 1.4}
                    style={{ fill: 'var(--ds-muted)', opacity: 0.6 }}
                  />
                ))}
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
};

export default PageWireframe;
