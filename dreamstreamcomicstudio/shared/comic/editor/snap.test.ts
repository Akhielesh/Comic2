import { describe, expect, it } from 'vitest';
import type { Page, PageLayer } from '../doc.js';
import { baseDoc, drawnPage, panel, withPages } from './__fixtures__/editorDoc.js';
import { buildScene } from './scene.js';
import { snapBox, snapTargets, snapThreshold, SNAP_PX } from './snap.js';

const shape = (id: string, box: PageLayer['box']): PageLayer => ({ id, kind: 'shape', box, shape: { type: 'rect' } });

const sceneWith = (layers: PageLayer[]) => {
  const page: Page = { ...drawnPage('pg_a', 1, 'four-grid', [panel('p1', 1), panel('p2', 2), panel('p3', 3), panel('p4', 4)]), layers };
  const doc = withPages(baseDoc(), [page]);
  return { page, scene: buildScene(doc, page) };
};
const TH = { x: 0.01, y: 0.01 };

describe('snap', () => {
  it('turns 6 screen pixels into page fractions', () => {
    expect(SNAP_PX).toBe(6);
    expect(snapThreshold(600, 900)).toEqual({ x: 0.01, y: 6 / 900 });
  });

  it('finds a frame edge', () => {
    const { page, scene } = sceneWith([shape('ly_m', { x: 0.515, y: 0.2, w: 0.1, h: 0.08 })]);
    const t = snapTargets(scene, page, { kind: 'overlay', id: 'ly_m' });
    // p2 starts at x 0.51.
    const r = snapBox({ x: 0.515, y: 0.2, w: 0.1, h: 0.08 }, t, TH);
    expect(r.dx).toBeCloseTo(-0.005, 6);
    expect(r.guides).toContainEqual({ axis: 'x', at: 0.51, kind: 'frame' });
  });

  it('finds a centre (the page centre, between the rows)', () => {
    const { page, scene } = sceneWith([shape('ly_m', { x: 0.3, y: 0.454, w: 0.1, h: 0.1 })]);
    const r = snapBox({ x: 0.3, y: 0.454, w: 0.1, h: 0.1 }, snapTargets(scene, page, { kind: 'overlay', id: 'ly_m' }), TH);
    expect(r.dy).toBeCloseTo(-0.004, 6);
    expect(r.guides.find((g) => g.axis === 'y')!.at).toBe(0.5);
  });

  it('finds equal spacing: the same gap as between the two others', () => {
    const a = shape('ly_a', { x: 0.1, y: 0.6, w: 0.1, h: 0.1 });
    const b = shape('ly_b', { x: 0.32, y: 0.6, w: 0.1, h: 0.1 });
    const { page, scene } = sceneWith([a, b, shape('ly_c', { x: 0.546, y: 0.605, w: 0.1, h: 0.1 })]);
    const r = snapBox({ x: 0.546, y: 0.605, w: 0.1, h: 0.1 }, snapTargets(scene, page, { kind: 'overlay', id: 'ly_c' }), TH);
    // B ends at 0.42; the gap A→B is 0.12, so C starts at 0.54.
    expect(r.dx).toBeCloseTo(-0.006, 6);
    expect(r.spacing).toHaveLength(1);
    expect(r.spacing[0].axis).toBe('x');
    expect(r.spacing[0].gap).toBeCloseTo(0.12, 6);
    expect(r.spacing[0].spans.map((s) => [+s.from.toFixed(3), +s.to.toFixed(3)])).toEqual([
      [0.2, 0.32],
      [0.42, 0.54]
    ]);
    // And the top edge snaps to the others' (an object edge).
    expect(r.dy).toBeCloseTo(-0.005, 6);
    expect(r.guides).toContainEqual({ axis: 'y', at: 0.6, kind: 'object' });
  });

  it('centres a box between two neighbours with equal gaps', () => {
    const { page, scene } = sceneWith([shape('ly_a', { x: 0.1, y: 0.6, w: 0.1, h: 0.1 }), shape('ly_b', { x: 0.6, y: 0.6, w: 0.1, h: 0.1 }), shape('ly_c', { x: 0.354, y: 0.63, w: 0.1, h: 0.04 })]);
    const r = snapBox({ x: 0.354, y: 0.63, w: 0.1, h: 0.04 }, snapTargets(scene, page, { kind: 'overlay', id: 'ly_c' }), TH);
    expect(r.dx).toBeCloseTo(-0.004, 6);
    expect(r.spacing[0].gap).toBeCloseTo(0.15, 6);
  });

  it('nothing within the threshold: no correction, no guides', () => {
    const { page, scene } = sceneWith([shape('ly_m', { x: 0.13, y: 0.13, w: 0.07, h: 0.07 })]);
    expect(snapBox({ x: 0.13, y: 0.13, w: 0.07, h: 0.07 }, snapTargets(scene, page, { kind: 'overlay', id: 'ly_m' }), { x: 0.002, y: 0.002 })).toEqual({ dx: 0, dy: 0, guides: [], spacing: [] });
  });
});
