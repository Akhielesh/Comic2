// Page wireframe: the panel layout of one page as a calm inline SVG (softwarefirst.md §2.6).
//
// Boxes come from plan.ts summarizeBook (PanelSummary.box): for a page about to be drawn (undrawn, failed or out
// of date) its blueprint — the plan as it will be drawn, the boxes the "Render all" hold-back is decided on — and
// for a drawn, current page the measured panels it was drawn with. The same rectangles the server and the page
// editor use. Free, instant, no image needed.
//
// Fit dots (plan §4.1, §6): every panel that carries a fit state shows one dot in its top-right corner — green when
// its words fit (roomy or fits), amber when tight, red when overfull. Hue never stands alone: the three states also
// differ in SHAPE (a filled dot, a ring, a diamond), the tile's spoken name and the detail row say it in words
// ("panel 3 tight", "panel 6 too full"), and an overfull panel gets a red outline. The marks use the readable
// status tones (--ds-*-text): the bare amber of Atlas light (#f59e0b) is under 2:1 on its #f4f4f4 panels, the
// text tones are over 3:1 on every skin (WCAG 1.4.11). Same numbers as the render gate (PanelSummary.fitState is
// the page check's verdict).
//
// The SVG uses a page-shaped viewBox (`0 0 1 1/ratio`), so the boxes keep the page's real shape at any tile size.
// Colours are theme tokens applied through `style` (var() is not reliable in SVG presentation attributes).

import React from 'react';
import type { ShotType } from '../../../shared/comic/doc';
import type { PanelSummary } from '../../../shared/comic/plan';
import type { FitState } from '../../../shared/comic/density';

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

/** The three dot states a fit maps to: roomy and fits are both "fits" (green). */
export type FitDot = 'fits' | 'tight' | 'overfull';

/** roomy/fits → fits (green) · tight → tight (amber) · overfull → overfull (red). */
export const fitDotOf = (state: FitState | undefined): FitDot | undefined =>
  state === 'overfull' ? 'overfull' : state === 'tight' ? 'tight' : state === 'roomy' || state === 'fits' ? 'fits' : undefined;

/**
 * Theme token per dot state: the readable status tones (--ds-success-text / --ds-warning-text / --ds-danger-text),
 * at least 3:1 against the panel and tile surfaces in every skin and theme — a 6 px ring in bare amber is not.
 */
export const FIT_DOT_COLOR: Record<FitDot, string> = {
  fits: 'var(--ds-success-text)',
  tight: 'var(--ds-warning-text)',
  overfull: 'var(--ds-danger-text)'
};

export interface PageWireframeProps {
  panels: (Pick<PanelSummary, 'n' | 'box' | 'shot' | 'speech' | 'captions' | 'sfx'> & Partial<Pick<PanelSummary, 'fitState'>>)[];
  /** Page aspect, "4:5". */
  aspect: string;
  /** Panel numbers, shot glyphs and line dots (off for the tiniest thumbnails). Fit dots show either way. */
  detail?: boolean;
  /** Highlight one panel (1-based n). */
  activePanel?: number;
  /** Show the fit dot of every panel that carries a fit state (default true). */
  fit?: boolean;
  className?: string;
  /** When set the SVG is announced as an image with this label; otherwise it is decorative. */
  label?: string;
}

const MAX_DOTS = 4;

/** One fit dot centred on (cx, cy) with radius r: a filled dot, a ring or a diamond. */
const FitMark: React.FC<{ dot: FitDot; cx: number; cy: number; r: number; n: number }> = ({ dot, cx, cy, r, n }) => {
  const color = FIT_DOT_COLOR[dot];
  return (
    <g data-fit-dot={dot} data-panel={n}>
      {dot === 'fits' ? (
        <circle cx={cx} cy={cy} r={r} style={{ fill: color, stroke: 'var(--ds-surface)', strokeWidth: r * 0.35 }} />
      ) : dot === 'tight' ? (
        <circle cx={cx} cy={cy} r={r * 0.8} style={{ fill: 'var(--ds-surface)', stroke: color, strokeWidth: r * 0.55 }} />
      ) : (
        <rect
          x={cx - r * 0.95}
          y={cy - r * 0.95}
          width={r * 1.9}
          height={r * 1.9}
          transform={`rotate(45 ${cx} ${cy})`}
          style={{ fill: color, stroke: 'var(--ds-surface)', strokeWidth: r * 0.3 }}
        />
      )}
    </g>
  );
};

export const PageWireframe: React.FC<PageWireframeProps> = ({ panels, aspect, detail = true, activePanel, fit = true, className, label }) => {
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
        const fitDot = fit ? fitDotOf(p.fitState) : undefined;
        const over = fitDot === 'overfull';
        // The fit dot sits in the top-right corner; it stays legible on a 96 px tile (≥ ~3 px radius) and never
        // grows past a small fraction of its own panel.
        const fitR = Math.max(0.016, Math.min(0.032, w * 0.11, h * 0.11));
        const fitPad = Math.min(0.026, w * 0.1, h * 0.1) + fitR;
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
                fill: on ? 'var(--ds-accent-soft)' : 'var(--ds-surface-soft)',
                stroke: on ? 'var(--ds-accent)' : over ? FIT_DOT_COLOR.overfull : 'var(--ds-hairline)',
                strokeWidth: on || over ? 1.5 : 1
              }}
            />
            {showText && (
              <>
                <text x={x + pad} y={y + pad + font * 0.8} style={{ fill: 'var(--ds-muted)', fontSize: font, fontWeight: 600 }}>
                  {p.n}
                </text>
                <text
                  x={x + w - pad - (fitDot ? fitR * 2 + pad * 0.6 : 0)}
                  y={y + pad + font * 0.8}
                  textAnchor="end"
                  style={{ fill: 'var(--ds-muted)', fontSize: font * 0.85 }}
                >
                  {SHOT_GLYPH[p.shot] ?? ''}
                </text>
                {Array.from({ length: dots }, (_, k) => (
                  <circle key={`s${k}`} cx={x + pad + dotR + k * dotR * 2.6} cy={y + h - pad - dotR} r={dotR} style={{ fill: 'var(--ds-accent)', opacity: 0.75 }} />
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
            {fitDot && w > 0 && h > 0 && <FitMark dot={fitDot} cx={x + w - fitPad} cy={y + fitPad} r={fitR} n={p.n} />}
          </g>
        );
      })}
    </svg>
  );
};

export default PageWireframe;
