// The Shapes tool's place layer (PE-SHELL; master plan §2.7 "U shapes"). LAZY: the page editor loads it only while the
// Shapes tool is armed, which needs the compose part ready (overlays must draw first), so the B9 drop engine
// (drop.ts → frames.ts → layoutText.ts) never rides in the page editor's first load (master plan §2.8).
//
// One press on the page places one rectangle overlay there through resolveDrop (kept in the panel it lands in). It is
// one free, undoable edit; overlays belong to every language (the art is shared), so it is never an edition edit.

import React from 'react';
import type { ComicDoc, Page } from '../../../shared/comic/doc';
import type { DocOp } from '../../../shared/comic/ops';
import { resolveDrop } from '../../../shared/comic/editor/drop';
import { PAGE_Z } from './kit/zLayers';

/** The shape a press at `point` (page fractions) places: the ops and their label, or the calm reason it cannot. Pure. */
export const shapeDropAt = (doc: ComicDoc, page: Page, point: { x: number; y: number }): { ok: true; ops: DocOp[]; label: string } | { ok: false; reason: string } => {
  const r = resolveDrop(doc, page, { kind: 'shape', shape: 'rect' }, { point });
  if (r.ok === false) return { ok: false, reason: (r as { reason: string }).reason };
  return { ok: true, ops: r.ops, label: r.label };
};

export interface ShapePlaceLayerProps {
  /** The stored doc and page (overlays are written to the original, never an edition). */
  doc: ComicDoc;
  page: Page;
  /** The free, undoable edit. */
  onPlace(ops: DocOp[], label: string): void;
  /** Why nothing was placed (a locked panel, the overlay cap…), for the editor's notice line. */
  onRefused(reason: string): void;
}

/** Pro, the Shapes tool: one press on the page places a rectangle there (the B9 drop of a shape). */
export const ShapePlaceLayer: React.FC<ShapePlaceLayerProps> = ({ doc, page, onPlace, onRefused }) => (
  <div
    aria-hidden
    data-testid="shape-place-layer"
    className="absolute inset-0 cursor-crosshair"
    style={{ zIndex: PAGE_Z.place }}
    onPointerDown={(e) => {
      const r = e.currentTarget.getBoundingClientRect();
      if (!(r.width > 0) || !(r.height > 0)) return;
      e.preventDefault();
      e.stopPropagation();
      const point = { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
      const res = shapeDropAt(doc, page, point);
      if (res.ok === false) onRefused((res as { reason: string }).reason);
      else onPlace((res as { ops: DocOp[] }).ops, (res as { label: string }).label);
    }}
  />
);
