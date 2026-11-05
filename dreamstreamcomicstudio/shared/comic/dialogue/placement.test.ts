// B-RESOLVE placement.ts (agent-editor plan §3 B2): page and panel frames, the full-width edge bar, head marks with an
// honest staging fallback, between two heads, and nudges of 0.02 / 0.08 of the page.
import { describe, expect, it } from 'vitest';
import { estimateMeasure, letteringSizer } from '../lettering/layout';
import { BALLOON_W, HEAD_CLEAR, NUDGE_STEP, PANEL_PAD, cellBox, lineGeo, pageGeo, placeLine, placementFor, tailTip, type PlaceOutcome } from './placement';
import { P1_BOXES, dialogueDoc } from './__fixtures__/dialogueDoc';

const doc = dialogueDoc();
const page1 = doc.pages[0];
const geo = pageGeo(doc, page1);
/** The outline box a placement result puts the balloon's outline at (same size; same offset from its text box). */
const outlineAt = (lineId: string, out: PlaceOutcome) => {
  if (out.ok === false) throw new Error(out.reason);
  const g = lineGeo(geo, lineId)!;
  return { x: out.x + (g.box.x - g.text.x), y: out.y + (g.box.y - g.text.y), w: g.box.w, h: g.box.h };
};
const SAFE = { x: 0.03, y: 0.02, r: 0.97, b: 0.98 }; // margin 0.03 page widths on a 2:3 page
const panelRegion = (i: number) => ({
  x: Math.max(P1_BOXES[i].x + PANEL_PAD, SAFE.x),
  y: Math.max(P1_BOXES[i].y + PANEL_PAD, SAFE.y),
  r: Math.min(P1_BOXES[i].x + P1_BOXES[i].w - PANEL_PAD, SAFE.r),
  b: Math.min(P1_BOXES[i].y + P1_BOXES[i].h - PANEL_PAD, SAFE.b)
});

describe('cellBox', () => {
  it('returns the top-left corner of one of the nine cells of a frame', () => {
    const frame = { x: 0.1, y: 0.2, w: 0.6, h: 0.3 };
    expect(cellBox(frame, 'top-left')).toEqual({ x: 0.1, y: 0.2 });
    expect(cellBox(frame, 'center')).toEqual({ x: 0.3, y: 0.3 });
    expect(cellBox(frame, 'bottom-right')).toEqual({ x: 0.5, y: 0.4 });
    expect(cellBox(frame, 'right')).toEqual({ x: 0.5, y: 0.3 });
    expect(cellBox({ x: 0, y: 0, w: 0, h: 1 }, 'center')).toBeNull();
    expect(cellBox(frame, 'middle' as never)).toBeNull();
  });
});

describe('placeLine / placementFor', () => {
  it('page frame: the outline sits in the corner of the page safe area', () => {
    const o = outlineAt('l_leo1', placeLine(doc, 'pg_1', 'l_leo1', { frame: 'page', cell: 'top-left' }));
    expect(o.x).toBeCloseTo(SAFE.x, 3);
    expect(o.y).toBeCloseTo(SAFE.y, 3);
    const br = outlineAt('l_leo1', placeLine(doc, 'pg_1', 'l_leo1', { frame: 'page', cell: 'bottom-right' }));
    expect(br.x + br.w).toBeCloseTo(SAFE.r, 3);
    expect(br.y + br.h).toBeCloseTo(SAFE.b, 3);
  });

  it('panel frame: the outline stays inside its own panel (inset), at the cell asked', () => {
    const r = panelRegion(1);
    const tl = outlineAt('l_leo1', placeLine(doc, 'pg_1', 'l_leo1', { frame: 'panel', cell: 'top-left' }));
    expect([tl.x, tl.y].map((v) => +v.toFixed(3))).toEqual([+r.x.toFixed(3), +r.y.toFixed(3)]);
    const b = outlineAt('l_leo1', placeLine(doc, 'pg_1', 'l_leo1', { frame: 'panel', cell: 'bottom' }));
    expect(b.y + b.h).toBeCloseTo(r.b, 3);
    expect(b.x + b.w / 2).toBeCloseTo((r.x + r.r) / 2, 3);
    const out = placeLine(doc, 'pg_1', 'l_leo1', { frame: 'panel', cell: 'top-left' });
    expect(out.ok && out.where).toBe('the top left of panel 2');
  });

  it('edge: a full-width bar across the top of the frame', () => {
    const out = placeLine(doc, 'pg_1', 'l_cap', { frame: 'panel', edge: 'top' });
    if (out.ok === false) throw new Error(out.reason);
    const r = panelRegion(0);
    expect(out.w).toBeGreaterThan(0.8);
    expect(out.w).toBeLessThanOrEqual(BALLOON_W.max);
    const s = letteringSizer(doc, page1, geo.aspect, estimateMeasure)(page1.panels[0].lines[0], out.w!);
    expect(out.x + s.bounds.x).toBeCloseTo(r.x, 3);
    expect(s.bounds.w).toBeCloseTo(r.r - r.x, 2);
    expect(out.y + s.bounds.y).toBeCloseTo(r.y, 3);
    expect(out.where).toBe('a full-width bar across the top of panel 1');
    const bottom = placeLine(doc, 'pg_1', 'l_cap', { frame: 'page', edge: 'bottom' });
    if (bottom.ok === false) throw new Error(bottom.reason);
    const sb = letteringSizer(doc, page1, geo.aspect, estimateMeasure)(page1.panels[0].lines[0], bottom.w!);
    expect(bottom.y + sb.bounds.y + sb.bounds.h).toBeCloseTo(SAFE.b, 3);
  });

  it('above a head mark: the outline ends HEAD_CLEAR above the head, over it', () => {
    const o = outlineAt('l_leo1', placeLine(doc, 'pg_1', 'l_leo1', { frame: 'panel', near: 'Mira', relation: 'above' }));
    expect(o.y + o.h).toBeCloseTo(0.78 - HEAD_CLEAR, 3);
    expect(o.x).toBeLessThanOrEqual(0.14);
    expect(o.x + o.w).toBeGreaterThanOrEqual(0.14);
    expect(placementFor(doc, 'pg_1', 'l_leo1', { frame: 'panel', near: 'Mira', relation: 'above' })?.note).toBeUndefined();
    // "her" is the line's own speaker.
    const her = placeLine(doc, 'pg_1', 'l_mira1', { frame: 'panel', near: 'her', relation: 'above' });
    expect(her.ok && her.where).toBe("above Mira Patel's head");
  });

  it('no head mark: placed by the staging, and the result says so', () => {
    const r = placementFor(doc, 'pg_1', 'l_mira3', { frame: 'panel', near: 'the robot', relation: 'near' });
    expect(r).not.toBeNull();
    expect(r!.note).toBe("Placed by the staging: there's no face data for Bolt on page 1 yet.");
  });

  it('a character who is not in the panel is refused in plain words; an ambiguous name asks', () => {
    expect(placeLine(doc, 'pg_1', 'l_mira3', { frame: 'panel', near: 'Leo', relation: 'above' })).toEqual({ ok: false, reason: "Leo isn't in panel 3 (they appear in panel 2 on page 1)." });
    expect(placementFor(doc, 'pg_1', 'l_mira3', { frame: 'panel', near: 'Leo' })).toBeNull();
    // "of the page": the one panel with Leo is enough.
    expect(placeLine(doc, 'pg_1', 'l_mira3', { frame: 'page', near: 'Leo', relation: 'above' }).ok).toBe(true);
    const many = placeLine(doc, 'pg_1', 'l_leo1', { frame: 'panel', near: 'Patel' });
    expect(many).toMatchObject({ ok: false, candidates: ['c_mira', 'c_asha'] });
  });

  it('between them: centred on the midpoint of the two heads, above them', () => {
    const o = outlineAt('l_leo1', placeLine(doc, 'pg_1', 'l_leo1', { frame: 'panel', relation: 'between' }));
    expect(o.x + o.w / 2).toBeCloseTo((0.14 + 0.38) / 2, 3);
    expect(o.y + o.h).toBeCloseTo(0.76 - HEAD_CLEAR, 3);
    const named = placeLine(doc, 'pg_1', 'l_leo1', { frame: 'panel', relation: 'between', near: 'Leo', and: 'Mira' });
    expect(named.ok && named.where).toBe('between Leo and Mira Patel');
    // Three people in the panel: "between them" asks which two.
    const crowd = dialogueDoc((d) => d.pages[0].panels[1].castIds.push('c_asha'));
    const out = placeLine(crowd, 'pg_1', 'l_leo1', { frame: 'panel', relation: 'between' });
    expect(out).toMatchObject({ ok: false, candidates: ['c_mira', 'c_leo', 'c_asha'] });
    expect(out.ok === false && out.reason).toMatch(/Panel 2 has 3 characters/);
  });

  it('nudge: 0.02 of the page for "a bit", 0.08 for "a lot", from where it is drawn; never off the page', () => {
    const g = lineGeo(geo, 'l_mira1')!; // pinned: drawn where stored
    // The plan's steps: 0.02 of the page for "a bit", 0.08 for "a lot".
    expect(NUDGE_STEP).toEqual({ bit: 0.02, lot: 0.08 });
    expect(placementFor(doc, 'pg_1', 'l_mira1', { frame: 'panel', nudge: 'up', amount: 'bit' })).toEqual({ x: g.text.x, y: +(g.text.y - 0.02).toFixed(4) });
    expect(placementFor(doc, 'pg_1', 'l_mira1', { frame: 'panel', nudge: 'right', amount: 'lot' })).toEqual({ x: +(g.text.x + 0.08).toFixed(4), y: g.text.y });
    expect(placementFor(doc, 'pg_1', 'l_mira1', { frame: 'panel', nudge: 'down' })).toEqual({ x: g.text.x, y: +(g.text.y + 0.02).toFixed(4) });
    const top = placementFor(doc, 'pg_1', 'l_cap', { frame: 'panel', nudge: 'up', amount: 'lot' });
    expect(top!.note).toBe('It stopped at the page edge so its outline stays visible.');
    expect(top!.y).toBeGreaterThan(0.05 - NUDGE_STEP.lot);
  });

  it('unknown pages, lines and empty placements fail honestly', () => {
    expect(placeLine(doc, 'pg_9', 'l_leo1', { frame: 'panel', cell: 'top' })).toEqual({ ok: false, reason: 'That page is not in the comic.' });
    expect(placeLine(doc, 'pg_2', 'l_leo1', { frame: 'panel', cell: 'top' })).toEqual({ ok: false, reason: 'That line is not on this page.' });
    expect(placeLine(doc, 'pg_1', 'l_leo1', { frame: 'panel' }).ok).toBe(false);
  });
});

describe('tailTip', () => {
  it('points at the mouth, else the head (said), else the staging (said); the edge for an off-panel voice', () => {
    expect(tailTip(doc, 'pg_1', 'l_mira2', 'mouth')).toEqual({ ok: true, x: 0.15, y: 0.81, who: "Mira Patel's mouth" });
    expect(tailTip(doc, 'pg_1', 'l_leo1', 'mouth')).toEqual({ ok: true, x: 0.38, y: 0.76, who: "Leo's mouth", note: "There's no mouth mark for Leo on page 1, so the tail points at the head." });
    const staged = tailTip(doc, 'pg_1', 'l_mira3', { name: 'the robot' });
    expect(staged).toMatchObject({ ok: true, who: 'Bolt', note: "Aimed where the page staged Bolt: there's no face data for page 1 yet." });
    expect(tailTip(doc, 'pg_1', 'l_cap', 'mouth')).toEqual({ ok: false, reason: 'A caption or sound effect has no speaker for its tail to point at.' });
    const edge = tailTip(doc, 'pg_1', 'l_leo1', 'edge');
    expect(edge.ok).toBe(true);
    const b = P1_BOXES[1];
    if (edge.ok) {
      const onEdge = [edge.x === +b.x.toFixed(4), edge.x === +(b.x + b.w).toFixed(4), edge.y === +b.y.toFixed(4), edge.y === +(b.y + b.h).toFixed(4)];
      expect(onEdge.some(Boolean)).toBe(true);
    }
  });
});
