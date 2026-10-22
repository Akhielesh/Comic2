// Deterministic, free balloon auto-placement (contract §10.2). WAVE-0 STUB:
// placeBalloons returns the existing balloons; fitBalloonOnPage is the identity.

import type { Balloon, Box, KeepOut, Line, LineKind, Page, SpeakerMark } from '../doc.js';
import type { BubbleShape } from './style.js';

export function placeBalloons(args: {
  page: Page; boxes: Box[]; aspect: number; rtl: boolean;
  plansFor: (line: Line, w: number) => { h: number; bounds: Box };
  keepOut?: KeepOut[]; heads?: SpeakerMark[];
  suggestions?: Map<string, Balloon>; // vision rects: a hint, not law
  safeMargin: number; // letterStyle.safeMargin ?? 0.03
  existing: Balloon[]; // pinned/locked = obstacles (page-wide, not per panel)
}): Balloon[] {
  return args.existing.slice();
}

/** How far each kind's outline bleeds past its text box (fraction of the box). */
export const OUTLINE_BLEED: Record<LineKind, number> = { speech: 0.08, thought: 0.14, whisper: 0.08, shout: 0.18, caption: 0, sfx: 0 };

export function outlineBounds(b: { x: number; y: number; w: number; h: number }, kind: LineKind, shape: BubbleShape): Box {
  const bleed = shape === 'none' || shape === 'rect' ? 0 : OUTLINE_BLEED[kind] ?? 0;
  return { x: b.x - b.w * bleed, y: b.y - b.h * bleed, w: b.w * (1 + 2 * bleed), h: b.h * (1 + 2 * bleed) };
}

/** Render-time fit: keeps the OUTLINE ≥ margin (0.008) inside the page without moving stored values. */
export function fitBalloonOnPage(
  b: { x: number; y: number; w: number; tailX?: number; tailY?: number },
  _kind: LineKind,
  _hFrac: number,
  _aspect: number,
  _margin = 0.008
): { x: number; y: number; w: number; tailX?: number; tailY?: number; crowded: boolean } {
  return { ...b, crowded: false };
}
