// Vector bubble library (contract §10.2). WAVE-0 STUB: every shape is a rectangle; P1-LETTER-ENGINE
// replaces it with the real squircle/cloud/burst/… geometry. Paths use only M L C Q A Z so they are
// valid for SVG <path d> AND new Path2D(d).

import type { Box } from '../doc.js';
import type { BubbleShape, TailStyle } from './style.js';

export interface Circle { cx: number; cy: number; r: number }
export interface BubbleGeometry { body?: string; inner?: string; extras?: string[]; tail?: string; bubbles: Circle[]; bounds: Box }

const f = (n: number) => String(Math.round(n * 100) / 100);

export function bubbleGeometry(
  shape: BubbleShape,
  w: number,
  h: number,
  opts: { inset: { x: number; y: number }; seed: number; tip?: { x: number; y: number } | null; tail: TailStyle; tailWidth: number; stroke: number; rtl?: boolean }
): BubbleGeometry {
  const bounds: Box = { x: 0, y: 0, w, h };
  if (shape === 'none') return { bubbles: [], bounds };
  const body = `M0 0 L${f(w)} 0 L${f(w)} ${f(h)} L0 ${f(h)} Z`;
  let tail: string | undefined;
  if (opts.tip && opts.tail !== 'none' && opts.tail !== 'bubbles') {
    const root = Math.max(2, Math.min(w, h) * 0.12 * (opts.tailWidth || 1));
    const cx = Math.min(w - root, Math.max(root, w / 2));
    tail = `M${f(cx - root)} ${f(h)} L${f(opts.tip.x)} ${f(opts.tip.y)} L${f(cx + root)} ${f(h)} Z`;
  }
  return { body, tail, bubbles: [], bounds };
}

/** Straight connector between two linked balloons (stub). */
export function linkNeck(
  a: { cx: number; cy: number; w: number; h: number },
  b: { cx: number; cy: number; w: number; h: number },
  stroke: number
): string {
  const half = Math.max(1, stroke) * 2;
  return `M${f(a.cx - half)} ${f(a.cy)} L${f(b.cx - half)} ${f(b.cy)} L${f(b.cx + half)} ${f(b.cy)} L${f(a.cx + half)} ${f(a.cy)} Z`;
}

/** Deterministic 32-bit seed from a string (moved from balloonGeometry.ts; same output). */
export function hashSeed(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
