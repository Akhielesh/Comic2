// Snap guides while dragging a balloon (lettering.md §6.6): within 6 screen px a balloon's outline snaps
// to panel inner edges (+ padding), the safe margin, other balloons' edges and centres, and the page
// centre. Hairline #D97757 guides show what it snapped to. Pure math is exported for tests.

import React from 'react';
import type { Box } from '../../../shared/comic/doc';

export interface SnapGuide {
  axis: 'x' | 'y';
  /** Page fraction (x: of the width, y: of the height). */
  at: number;
}

export interface SnapTargets {
  x: number[];
  y: number[];
}

/** Panel inner padding (page fractions; same as the placer's PAD). */
export const SNAP_PANEL_PAD = 0.012;

/** Every line a balloon outline may snap to on this page. */
export function snapTargets(args: { panels: Box[]; others: Box[]; safe: Box }): SnapTargets {
  const x: number[] = [0.5, args.safe.x, args.safe.x + args.safe.w];
  const y: number[] = [0.5, args.safe.y, args.safe.y + args.safe.h];
  for (const p of args.panels) {
    x.push(p.x + SNAP_PANEL_PAD, p.x + p.w - SNAP_PANEL_PAD);
    y.push(p.y + SNAP_PANEL_PAD, p.y + p.h - SNAP_PANEL_PAD);
  }
  for (const o of args.others) {
    x.push(o.x, o.x + o.w / 2, o.x + o.w);
    y.push(o.y, o.y + o.h / 2, o.y + o.h);
  }
  return { x, y };
}

/**
 * Snap an outline box: the closest (edge|centre ↔ target) pair per axis within the threshold wins.
 * Returns the correction to add to the box position and the guides to draw.
 */
export function computeSnap(box: Box, targets: SnapTargets, threshold: { x: number; y: number }): { dx: number; dy: number; guides: SnapGuide[] } {
  const axis = (start: number, size: number, lines: number[], th: number): { d: number; at?: number } => {
    let best: { d: number; at?: number } = { d: 0 };
    let bestAbs = Infinity;
    for (const edge of [start, start + size / 2, start + size]) {
      for (const t of lines) {
        const d = t - edge;
        if (Math.abs(d) <= th && Math.abs(d) < bestAbs) {
          bestAbs = Math.abs(d);
          best = { d, at: t };
        }
      }
    }
    return best;
  };
  const sx = axis(box.x, box.w, targets.x, threshold.x);
  const sy = axis(box.y, box.h, targets.y, threshold.y);
  const guides: SnapGuide[] = [];
  if (sx.at !== undefined) guides.push({ axis: 'x', at: sx.at });
  if (sy.at !== undefined) guides.push({ axis: 'y', at: sy.at });
  return { dx: sx.d, dy: sy.d, guides };
}

export const SnapGuides: React.FC<{ guides: readonly SnapGuide[] }> = ({ guides }) => {
  if (!guides.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-[7]" aria-hidden data-testid="snap-guides">
      {guides.map((g, i) =>
        g.axis === 'x' ? (
          <span key={i} className="absolute inset-y-0 w-px bg-[var(--ds-accent)]" style={{ left: `${g.at * 100}%` }} />
        ) : (
          <span key={i} className="absolute inset-x-0 h-px bg-[var(--ds-accent)]" style={{ top: `${g.at * 100}%` }} />
        )
      )}
    </div>
  );
};

export default SnapGuides;
