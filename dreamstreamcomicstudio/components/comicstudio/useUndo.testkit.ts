// Test-only helpers for undo round-trip properties (imported by useUndo.test.ts and
// useStudio.undo.test.tsx; never by app code).

import { normalizeDoc, type ComicDoc } from '../../shared/comic/doc';
import type { DocOp } from '../../shared/comic/ops';
import { makeSampleDoc } from './board/__fixtures__/sampleDoc';

const canonical = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === null || val === undefined) continue;
      out[k] = canonical(val);
    }
    return out;
  }
  return v;
};
/** Wire equality (R4): null ≡ unset; updatedAt is a timestamp, not content. */
export const comparable = (doc: ComicDoc) => canonical({ ...doc, updatedAt: 0 });

export const sample = (): ComicDoc => normalizeDoc(makeSampleDoc());

export const mulberry32 = (seed: number) => {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const pick = <T,>(r: () => number, list: readonly T[]): T => list[Math.floor(r() * list.length) % list.length];
const SHAPES = ['oval', 'cloud', 'jagged', 'burst', 'rect'] as const;
const COLORS = ['#e63946', '#1d3557', '#ffffff', '#000000cc', 'none'] as const;
const PRESETS = ['classic', 'manga', 'storybook', 'noir', 'webtoon'] as const;

/** A random director-style LETTERING op on the current doc (balloons, line styles, presets, text). */
export function randomLetteringOp(doc: ComicDoc, r: () => number): DocOp {
  const page = pick(r, doc.pages.filter((p) => p.panels.some((pn) => pn.lines.length)));
  const lines = page.panels.flatMap((pn) => pn.lines.map((l) => ({ panelId: pn.id, line: l })));
  const hit = pick(r, lines);
  const k = Math.floor(r() * 8);
  switch (k) {
    case 0:
      return { op: 'balloon', pageId: page.id, lineId: hit.line.id, patch: { x: Math.round(r() * 80) / 100, y: Math.round(r() * 80) / 100, w: 0.2 + Math.round(r() * 20) / 100 } };
    case 1:
      return {
        op: 'line_style',
        pageId: page.id,
        lineIds: lines.filter(() => r() < 0.5).map((l) => l.line.id).concat(hit.line.id),
        patch: r() < 0.5 ? { fill: pick(r, COLORS) } : { shape: pick(r, SHAPES), textColor: pick(r, COLORS) }
      };
    case 2:
      return { op: 'line_style', pageId: page.id, lineIds: [hit.line.id], mode: 'replace', patch: r() < 0.3 ? null : { sizeScale: 1 + Math.round(r() * 10) / 10 } };
    case 3:
      return r() < 0.5
        ? { op: 'letter_style', patch: { presetId: pick(r, PRESETS), keepOverrides: r() < 0.5 } }
        : { op: 'letter_style', patch: { base: { textColor: pick(r, COLORS) }, safeMargin: Math.round(r() * 10) / 100 } };
    case 4:
      return { op: 'line', pageId: page.id, panelId: hit.panelId, id: hit.line.id, patch: { text: `Edited ${Math.floor(r() * 1000)}` } };
    case 5:
      return { op: 'balloons', pageId: page.id, balloons: page.balloons.map((b) => ({ ...b, x: Math.round(r() * 70) / 100 })) };
    case 6:
      return { op: 'line', pageId: page.id, panelId: hit.panelId, id: hit.line.id, patch: { style: { shape: pick(r, SHAPES) } } };
    default:
      return { op: 'balloon', pageId: page.id, lineId: hit.line.id, patch: { tailX: Math.round(r() * 100) / 100, tailY: Math.round(r() * 100) / 100, pinned: true } };
  }
}

