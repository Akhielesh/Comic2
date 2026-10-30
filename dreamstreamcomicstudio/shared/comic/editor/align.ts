// Align and distribute (Ship 2, B9; design §4.8). Work across a mixed selection of balloons and overlays, relative to
// the selection or to the panel the first object sits in. Frames tile the page, so they get "equalize row / column"
// (frames.ts) instead. Locked objects stay where they are and still count as anchors. Pure.

import type { Box, ComicDoc, Page } from '../doc.js';
import type { DocOp } from '../ops.js';
import { buildScene, editOf, NOTHING_TO_CHANGE, refuse, sameBox, sceneObject, type EditResult, type PageScene, type SceneObject, type SceneRef } from './scene.js';
import { setBoxEdit } from './transform.js';

export type AlignMode = 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom';
export type DistributeAxis = 'h' | 'v';

const ALIGN_WORD: Record<AlignMode, string> = {
  left: 'Align left edges',
  centre: 'Align centres',
  right: 'Align right edges',
  top: 'Align top edges',
  middle: 'Align middles',
  bottom: 'Align bottom edges'
};

/** The bounds of several boxes. */
export const boundsOf = (boxes: readonly Box[]): Box => {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, w: Math.max(...boxes.map((b) => b.x + b.w)) - x, h: Math.max(...boxes.map((b) => b.y + b.h)) - y };
};

/** Boxes aligned to `to` (the selection's bounds by default). Sizes never change. */
export function alignBoxes(boxes: readonly Box[], mode: AlignMode, to: Box = boundsOf(boxes)): Box[] {
  return boxes.map((b) => {
    switch (mode) {
      case 'left':
        return { ...b, x: to.x };
      case 'right':
        return { ...b, x: to.x + to.w - b.w };
      case 'centre':
        return { ...b, x: to.x + (to.w - b.w) / 2 };
      case 'top':
        return { ...b, y: to.y };
      case 'bottom':
        return { ...b, y: to.y + to.h - b.h };
      case 'middle':
        return { ...b, y: to.y + (to.h - b.h) / 2 };
    }
  });
}

/**
 * Boxes spread so the gaps between neighbours are equal along the axis; the first and the last stay put (the order is
 * by position). Fewer than three boxes come back unchanged. Gaps may be negative when the boxes overlap.
 */
export function distributeBoxes(boxes: readonly Box[], axis: DistributeAxis): Box[] {
  if (boxes.length < 3) return boxes.map((b) => ({ ...b }));
  const key = axis === 'h' ? 'x' : 'y';
  const size = axis === 'h' ? 'w' : 'h';
  const order = boxes.map((b, i) => ({ b, i })).sort((a, b) => a.b[key] - b.b[key] || a.i - b.i);
  const first = order[0].b;
  const last = order[order.length - 1].b;
  const span = last[key] + last[size] - first[key];
  const total = order.reduce((s, o) => s + o.b[size], 0);
  const gap = (span - total) / (order.length - 1);
  const out: Box[] = boxes.map((b) => ({ ...b }));
  let at = first[key];
  for (const o of order) {
    out[o.i] = { ...o.b, [key]: at };
    at += o.b[size] + gap;
  }
  return out;
}

const alignable = (o: SceneObject | undefined): o is SceneObject => !!o && (o.kind === 'balloon' || o.kind === 'overlay');

/** Apply new boxes to scene objects (locked ones skipped) through setBoxEdit; one combined edit. */
function boxesEdit(doc: ComicDoc, page: Page, scene: PageScene, objs: SceneObject[], boxes: Box[], label: string): EditResult {
  const ops: DocOp[] = [];
  for (let i = 0; i < objs.length; i++) {
    const o = objs[i];
    if (o.locked || sameBox(o.box, boxes[i], 1e-4)) continue;
    const r = setBoxEdit(doc, page, { kind: o.kind, id: o.id }, boxes[i], scene);
    if (r.ok) ops.push(...r.ops);
  }
  return ops.length ? editOf(doc, ops, label) : refuse(NOTHING_TO_CHANGE);
}

export interface AlignOptions {
  /** 'selection' (default): to the selection's bounds; 'panel': to the frame the first object sits in. */
  relativeTo?: 'selection' | 'panel';
  scene?: PageScene;
}

/** Align a selection of balloons and overlays. Frames are refused (they tile: use Equalize row / column). */
export function alignEdit(doc: ComicDoc, page: Page, refs: readonly SceneRef[], mode: AlignMode, opts: AlignOptions = {}): EditResult {
  if (refs.some((r) => r.kind === 'frame')) return refuse('Panels tile the page. Use Equalize row or Equalize column instead.');
  const scene = opts.scene ?? buildScene(doc, page);
  const objs = refs.map((r) => sceneObject(scene, r)).filter(alignable);
  const panelBox = opts.relativeTo === 'panel' ? scene.objects.find((o) => o.kind === 'frame' && o.id === objs[0]?.panelId)?.box : undefined;
  if (opts.relativeTo === 'panel' ? objs.length < 1 || !panelBox : objs.length < 2) return refuse(opts.relativeTo === 'panel' ? 'Pick something inside a panel to align.' : 'Pick two or more things to align.');
  if (objs.every((o) => o.locked)) return refuse('Everything you picked is locked.');
  const anchorsLocked = objs.filter((o) => o.locked);
  // Locked objects never move; when there are any, they define where the others align to.
  const to = panelBox ?? boundsOf((anchorsLocked.length ? anchorsLocked : objs).map((o) => o.box));
  return boxesEdit(doc, page, scene, objs, alignBoxes(objs.map((o) => o.box), mode, to), ALIGN_WORD[mode]);
}

/** Distribute three or more balloons and overlays evenly (horizontally or vertically). */
export function distributeEdit(doc: ComicDoc, page: Page, refs: readonly SceneRef[], axis: DistributeAxis, opts: { scene?: PageScene } = {}): EditResult {
  if (refs.some((r) => r.kind === 'frame')) return refuse('Panels tile the page. Use Equalize row or Equalize column instead.');
  const scene = opts.scene ?? buildScene(doc, page);
  const objs = refs.map((r) => sceneObject(scene, r)).filter(alignable);
  if (objs.length < 3) return refuse('Pick three or more things to space evenly.');
  return boxesEdit(doc, page, scene, objs, distributeBoxes(objs.map((o) => o.box), axis), axis === 'h' ? 'Space evenly across' : 'Space evenly down');
}
