import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../../components/comicstudio/board/__fixtures__/sampleDoc';
import { createEmptyDoc, normalizeDoc, type Balloon, type Box, type ComicDoc, type KeepOut, type Line, type Page, type SpeakerMark } from '../doc';
import { panelBoxesFor } from '../pageGeometry';
import { estimateMeasure, letteringSizer } from './layout';
import { OUTLINE_BLEED, OUTLINE_BLEED_XY, ROW_TOLERANCE, balloonFootprint, defaultTailTip, fitBalloonOnPage, outlineBounds, placeBalloons, placeBalloonsDetailed, safeAreaBox, settleBalloons, stagedSpeakerX, tailExitPoint, type SettleItem } from './place';

const ASPECT = 2 / 3;

const line = (id: string, kind: Line['kind'], text: string, speakerId?: string): Line => ({ id, kind, text, ...(speakerId ? { speakerId } : {}) });

/** The owner's real 8-line page shape (5 panels, captions + dialogue + sfx), synthetic text. */
const liveDoc = (): { doc: ComicDoc; page: Page } => {
  const doc = normalizeDoc(createEmptyDoc('p_live', 'Duck Morning', 1));
  doc.cast = [
    { id: 'ch_baby', name: 'Baby' } as never,
    { id: 'ch_duck', name: 'Duck' } as never
  ];
  const page = {
    id: 'pg_live',
    n: 1,
    summary: '',
    layout: 'Row 1: one wide panel (panel 1). Row 2: two equal panels side by side (panels 2–3). Row 3: two equal panels side by side (panels 4–5).',
    render: { status: 'none' as const },
    balloons: [] as Balloon[],
    panels: [
      { id: 'p1', n: 1, size: 'wide', shot: 'establishing', action: 'A farm pond at sunrise.', castIds: [], lines: [line('l1', 'caption', "Grandma's farm, early in the morning."), line('l2', 'caption', 'The ducks were already waiting.')] },
      { id: 'p2', n: 2, size: 'medium', shot: 'medium', action: 'Baby waves at the ducks.', castIds: ['ch_baby'], lines: [line('l3', 'speech', 'Hi duckies! Are you hungry today?', 'ch_baby')] },
      { id: 'p3', n: 3, size: 'medium', shot: 'medium', action: 'A duck splashes.', castIds: ['ch_duck'], lines: [line('l4', 'speech', 'Quack quack!', 'ch_duck'), line('l5', 'sfx', 'SPLASH')] },
      { id: 'p4', n: 4, size: 'medium', shot: 'close_up', action: 'Baby looks around.', castIds: ['ch_baby'], lines: [line('l6', 'thought', 'Where did the little one go?', 'ch_baby')] },
      { id: 'p5', n: 5, size: 'medium', shot: 'medium', action: 'Baby finds the duckling.', castIds: ['ch_baby', 'ch_duck'], lines: [line('l7', 'speech', 'Found you, little duck!', 'ch_baby'), line('l8', 'caption', 'The end… for now.')] }
    ]
  } as unknown as Page;
  doc.pages = [page];
  return { doc, page };
};

const outlineOf = (doc: ComicDoc, page: Page, b: Balloon): Box => {
  const sizer = letteringSizer(doc, page, ASPECT, estimateMeasure);
  const ln = page.panels.flatMap((p) => p.lines).find((l) => l.id === b.lineId)!;
  const s = sizer(ln, b.w);
  return { x: b.x + s.bounds.x, y: b.y + s.bounds.y, w: s.bounds.w, h: s.bounds.h };
};
const overlapArea = (a: Box, b: Box) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

const placeAll = (doc: ComicDoc, page: Page, extra: Partial<Parameters<typeof placeBalloons>[0]> = {}) =>
  placeBalloonsDetailed({
    page,
    boxes: panelBoxesFor(doc, page),
    aspect: ASPECT,
    rtl: doc.format.readingDirection === 'rtl',
    plansFor: letteringSizer(doc, page, ASPECT, estimateMeasure),
    safeMargin: 0.03,
    existing: page.balloons,
    ...extra
  });

describe('placeBalloons: the live 8-line page', () => {
  it('every outline stays inside [0.03, 0.97] (safe area) with no overlaps', () => {
    const { doc, page } = liveDoc();
    const res = placeAll(doc, page);
    expect(res.balloons.map((b) => b.lineId)).toEqual(['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8']);
    const safe = safeAreaBox(0.03, ASPECT);
    const outlines = res.balloons.map((b) => outlineOf(doc, page, b));
    for (const o of outlines) {
      expect(o.x).toBeGreaterThanOrEqual(safe.x - 1e-6);
      expect(o.y).toBeGreaterThanOrEqual(safe.y - 1e-6);
      expect(o.x + o.w).toBeLessThanOrEqual(safe.x + safe.w + 1e-6);
      expect(o.y + o.h).toBeLessThanOrEqual(safe.y + safe.h + 1e-6);
    }
    for (let i = 0; i < outlines.length; i += 1)
      for (let j = i + 1; j < outlines.length; j += 1) expect(overlapArea(outlines[i], outlines[j]), `${res.balloons[i].lineId}×${res.balloons[j].lineId}`).toBe(0);
    expect(res.crowded).toEqual([]);
  });

  it('is deterministic', () => {
    const { doc, page } = liveDoc();
    expect(placeAll(doc, page)).toEqual(placeAll(doc, page));
  });

  it('keeps reading order inside a panel and snaps captions to reading corners', () => {
    const { doc, page } = liveDoc();
    const res = placeAll(doc, page);
    const by = new Map(res.balloons.map((b) => [b.lineId, b]));
    // Opening caption in panel 1 sits in the top-left corner; the second caption reads after it.
    const boxes = panelBoxesFor(doc, page);
    expect(by.get('l1')!.x).toBeLessThan(boxes[0].x + boxes[0].w / 2);
    expect(by.get('l1')!.y).toBeLessThanOrEqual(by.get('l2')!.y + 0.02);
    expect(by.get('l4')!.y).toBeLessThanOrEqual(by.get('l5')!.y + 0.02);
    // Closing caption of the last panel goes to its end-bottom corner.
    expect(by.get('l8')!.y).toBeGreaterThan(by.get('l7')!.y);
  });

  it('rtl mirrors the caption corner', () => {
    const { doc, page } = liveDoc();
    doc.format = { ...doc.format, readingDirection: 'rtl' };
    const boxes = panelBoxesFor(doc, page);
    const res = placeAll(doc, page);
    const l1 = res.balloons.find((b) => b.lineId === 'l1')!;
    const p1 = boxes[0];
    expect(l1.x + l1.w).toBeGreaterThan(p1.x + p1.w / 2);
  });
});

describe('placeBalloons: obstacles, faces and tails', () => {
  it('never moves pinned or locked balloons, and treats them as page-wide obstacles', () => {
    const { doc, page } = liveDoc();
    const boxes = panelBoxesFor(doc, page);
    const p5 = boxes[4];
    // A stored balloon of panel 2's line sitting inside panel 5's box.
    const intruder: Balloon = { lineId: 'l3', x: p5.x + 0.02, y: p5.y + 0.02, w: p5.w - 0.04, pinned: true };
    const locked: Balloon = { lineId: 'l4', x: 0.6, y: 0.4, w: 0.2, locked: true, z: 3 };
    page.balloons = [intruder, locked];
    const res = placeAll(doc, page);
    expect(res.balloons.find((b) => b.lineId === 'l3')).toBe(intruder);
    expect(res.balloons.find((b) => b.lineId === 'l4')).toBe(locked);
    const intruderOutline = outlineOf(doc, page, intruder);
    for (const id of ['l7', 'l8']) {
      const o = outlineOf(doc, page, res.balloons.find((b) => b.lineId === id)!);
      expect(overlapArea(o, intruderOutline), id).toBe(0);
    }
    expect(res.placed).not.toContain('l3');
  });

  it('avoids faces when there is room, and aims the tail at the speaker’s mouth', () => {
    const { doc, page } = liveDoc();
    const boxes = panelBoxesFor(doc, page);
    const p2 = boxes[1];
    const face: Box = { x: p2.x + p2.w * 0.2, y: p2.y + p2.h * 0.05, w: p2.w * 0.5, h: p2.h * 0.4 };
    const keepOut: KeepOut[] = [{ panel: 2, box: face, kind: 'face' }];
    const mouth = { x: face.x + face.w / 2, y: face.y + face.h * 0.75 };
    const heads: SpeakerMark[] = [{ panel: 2, characterId: 'ch_baby', head: { x: face.x + face.w / 2, y: face.y + face.h / 2 }, mouth }];
    const res = placeAll(doc, page, { keepOut, heads });
    const b = res.balloons.find((x) => x.lineId === 'l3')!;
    expect(overlapArea(outlineOf(doc, page, b), face)).toBe(0);
    expect(Math.hypot(b.tailX! - mouth.x, (b.tailY! - mouth.y) / ASPECT)).toBeLessThan(0.05);
  });

  it('a tail never cuts through the speaker’s own face or across another character’s face', () => {
    const { doc, page } = liveDoc();
    const boxes = panelBoxesFor(doc, page);
    const p5 = boxes[4];
    const at = (fx: number, fy: number, fw: number, fh: number): Box => ({ x: p5.x + p5.w * fx, y: p5.y + p5.h * fy, w: p5.w * fw, h: p5.h * fh });
    const scenarios: { babyFace: Box; duckFace?: Box }[] = [
      { babyFace: at(0.1, 0.45, 0.3, 0.4) },
      { babyFace: at(0.1, 0.5, 0.25, 0.35), duckFace: at(0.4, 0.45, 0.25, 0.3) },
      { babyFace: at(0.55, 0.5, 0.3, 0.35), duckFace: at(0.15, 0.4, 0.3, 0.3) }
    ];
    for (const { babyFace, duckFace } of scenarios) {
      const keepOut: KeepOut[] = [{ panel: 5, box: babyFace, kind: 'face' }, ...(duckFace ? [{ panel: 5, box: duckFace, kind: 'face' as const }] : [])];
      const head = { x: babyFace.x + babyFace.w / 2, y: babyFace.y + babyFace.h / 2 };
      const mouth = { x: head.x, y: babyFace.y + babyFace.h * 0.8 };
      const res = placeAll(doc, page, { keepOut, heads: [{ panel: 5, characterId: 'ch_baby', head, mouth }] });
      const b = res.balloons.find((x) => x.lineId === 'l7')!;
      const text: Box = { x: b.x, y: b.y, w: b.w, h: letteringSizer(doc, page, ASPECT, estimateMeasure)(page.panels[4].lines[0], b.w).h };
      const tip = { x: b.tailX!, y: b.tailY! };
      const root = tailExitPoint(text, tip);
      const core = { x: babyFace.x + babyFace.w * 0.25, y: babyFace.y + babyFace.h * 0.25, w: babyFace.w * 0.5, h: babyFace.h * 0.5 };
      const hits = (f: Box) => {
        for (let i = 1; i < 12; i += 1) {
          const t = i / 12;
          const p = { x: root.x + (tip.x - root.x) * t, y: root.y + (tip.y - root.y) * t };
          if (p.x > f.x && p.x < f.x + f.w && p.y > f.y && p.y < f.y + f.h) return true;
        }
        return false;
      };
      expect(hits(core)).toBe(false);
      if (duckFace) expect(hits(duckFace)).toBe(false);
      // Still points at the speaker: the tip is on or next to their face.
      expect(tip.x).toBeGreaterThan(babyFace.x - 0.03);
      expect(tip.x).toBeLessThan(babyFace.x + babyFace.w + 0.03);
    }
  });

  it('a crowded panel never overlaps silently: either ≤ 8% overlap or the line is flagged', () => {
    const { doc, page } = liveDoc();
    const long = 'This is a very long line of dialogue that goes on and on and on, far longer than any balloon should ever be, honestly too long.';
    page.panels[3].lines = [line('c1', 'speech', long, 'ch_baby'), line('c2', 'speech', long, 'ch_baby'), line('c3', 'speech', long, 'ch_baby')];
    const res = placeAll(doc, page);
    const outlines = ['c1', 'c2', 'c3'].map((id) => outlineOf(doc, page, res.balloons.find((b) => b.lineId === id)!));
    let worst = 0;
    for (let i = 0; i < 3; i += 1)
      for (let j = i + 1; j < 3; j += 1) worst = Math.max(worst, overlapArea(outlines[i], outlines[j]) / Math.min(outlines[i].w * outlines[i].h, outlines[j].w * outlines[j].h));
    if (worst > 0.08) expect(res.crowded.length).toBeGreaterThan(0);
    // Never off the page.
    const safe = safeAreaBox(0.03, ASPECT);
    for (const o of outlines) {
      expect(o.y).toBeGreaterThanOrEqual(safe.y - 1e-6);
      expect(o.y + o.h).toBeLessThanOrEqual(safe.y + safe.h + 1e-6);
    }
  });

  it('keep:"all" only places missing lines; re-placed lines carry z/linkTo', () => {
    const doc = normalizeDoc(makeSampleDoc());
    const page = doc.pages[0];
    const all = placeAll(doc, page, { keep: 'all' });
    for (const b of page.balloons) expect(all.balloons.find((x) => x.lineId === b.lineId)).toBe(b);
    expect(all.placed).toEqual(['pg_1_l4']);
    const withZ = { ...page, balloons: page.balloons.map((b) => (b.lineId === 'pg_1_l2' ? { ...b, z: 7, linkTo: 'pg_1_l1' } : b)) };
    const relaid = placeAll(doc, withZ);
    const l2 = relaid.balloons.find((b) => b.lineId === 'pg_1_l2')!;
    expect(l2).toMatchObject({ z: 7, linkTo: 'pg_1_l1' });
    expect(l2.pinned).toBeUndefined();
    // only: re-place just one line.
    const only = placeAll(doc, page, { only: ['pg_1_l1'] });
    expect(only.placed).toEqual(['pg_1_l1', 'pg_1_l4']);
  });

  it('staging mirrors the page prompt (left→right page order)', () => {
    const doc = normalizeDoc(makeSampleDoc());
    const page = doc.pages[0];
    expect(stagedSpeakerX(page, 2, 'ch_maya')).toBeCloseTo(0.2);
    expect(stagedSpeakerX(page, 2, 'ch_vendor')).toBeCloseTo(0.8);
    expect(stagedSpeakerX(page, 1, 'ch_maya')).toBe(0.5);
  });

  it('falls back to estimates when plansFor gives nothing usable', () => {
    const doc = normalizeDoc(makeSampleDoc());
    const res = placeBalloons({ page: doc.pages[0], boxes: [], aspect: ASPECT, rtl: false, plansFor: () => ({ h: 0, bounds: { x: 0, y: 0, w: 0, h: 0 } }), safeMargin: 0.03, existing: [] });
    expect(res).toHaveLength(5);
    for (const b of res) for (const v of [b.x, b.y, b.w]) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('fitBalloonOnPage (render-time, visualqa §6)', () => {
  const m = 0.008;
  it('caption hanging off the bottom is lifted', () => {
    expect(fitBalloonOnPage({ x: 0.7, y: 0.92, w: 0.3 }, 'caption', 0.15, 0.8).y).toBeLessThanOrEqual(0.85 - m + 1e-9);
  });
  it('thought at x=0 clears its outline bleed', () => {
    expect(fitBalloonOnPage({ x: 0, y: 0.1, w: 0.3 }, 'thought', 0.1, ASPECT).x).toBeGreaterThanOrEqual(0.3 * 0.08);
  });
  it('shout at the right edge keeps its outline on the page', () => {
    const r = fitBalloonOnPage({ x: 0.66, y: 0.3, w: 0.34 }, 'shout', 0.08, ASPECT);
    expect(r.x + r.w + 0.12 * r.w).toBeLessThanOrEqual(1);
  });
  it('a too-wide thought shrinks and is flagged', () => {
    const r = fitBalloonOnPage({ x: 0.02, y: 0.3, w: 0.95 }, 'thought', 0.1, ASPECT);
    expect(r.w).toBeLessThan(0.95);
    expect(r.crowded).toBe(true);
  });
  it('tail tips are clamped to the page; in-bounds balloons are untouched', () => {
    const r = fitBalloonOnPage({ x: 0.3, y: 0.3, w: 0.2, tailX: 1.4, tailY: -0.2 }, 'speech', 0.08, ASPECT);
    expect(r).toEqual({ x: 0.3, y: 0.3, w: 0.2, tailX: 1, tailY: 0, crowded: false });
  });
  it('outline bleed tables are consistent (uniform ≥ per-axis)', () => {
    for (const k of Object.keys(OUTLINE_BLEED) as (keyof typeof OUTLINE_BLEED)[]) {
      expect(OUTLINE_BLEED[k]).toBeGreaterThanOrEqual(Math.max(OUTLINE_BLEED_XY[k].x, OUTLINE_BLEED_XY[k].y));
    }
    expect(outlineBounds({ x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, 'caption', 'rect')).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.1 });
    const cloud = outlineBounds({ x: 0.1, y: 0.1, w: 0.2, h: 0.1 }, 'thought', 'cloud');
    expect(cloud.x).toBeLessThan(0.1);
    expect(cloud.y).toBeLessThan(0.1);
  });
});

// ── Footprints (tails), spill and the render-time settle ─────────────────────

const LONG = 'Mama said the ducklings would wait for us by the willow tree, but the frog keeps singing louder and louder and I think he wants us to follow him across the lily pads!';

/** One wide panel on top, two small ones below (the right one is tiny). */
const crowdedDoc = (): { doc: ComicDoc; page: Page } => {
  const doc = normalizeDoc(createEmptyDoc('p_crowd', 'Crowd', 1));
  doc.cast = [{ id: 'ch_a', name: 'Ann' } as never, { id: 'ch_b', name: 'Bo' } as never];
  const page = {
    id: 'pg_crowd',
    n: 1,
    summary: '',
    layout: 'Row 1: one wide panel (panel 1). Row 2: two equal panels side by side (panels 2–3).',
    render: { status: 'none' as const },
    balloons: [] as Balloon[],
    panels: [
      { id: 'p1', n: 1, size: 'wide', shot: 'medium', action: 'A.', castIds: ['ch_a'], lines: [line('c1', 'speech', 'Hi!', 'ch_a')] },
      { id: 'p2', n: 2, size: 'medium', shot: 'medium', action: 'B.', castIds: ['ch_a', 'ch_b'], lines: [line('c2', 'speech', LONG, 'ch_a'), line('c3', 'thought', LONG, 'ch_b'), line('c4', 'shout', LONG, 'ch_a')] },
      { id: 'p3', n: 3, size: 'medium', shot: 'medium', action: 'C.', castIds: ['ch_b'], lines: [line('c5', 'speech', 'Ok.', 'ch_b')] }
    ]
  } as unknown as Page;
  doc.pages = [page];
  return { doc, page };
};

const footprintOf = (doc: ComicDoc, page: Page, b: Balloon): Box => {
  const o = outlineOf(doc, page, b);
  return balloonFootprint(o, typeof b.tailX === 'number' && typeof b.tailY === 'number' ? { x: b.tailX, y: b.tailY } : null);
};
const overlapFrac = (a: Box, b: Box) => overlapArea(a, b) / Math.min(a.w * a.h, b.w * b.h);

describe('placeBalloons: footprints include tails, full panels spill', () => {
  it('nothing is placed under a stored balloon’s tail (heist-12p page 9)', () => {
    const { doc, page } = liveDoc();
    // l3 (panel 2) is pinned with a long tail reaching down into panel 4's area; l6 (panel 4) must avoid it.
    page.balloons = [{ lineId: 'l3', x: 0.05, y: 0.36, w: 0.3, tailX: 0.2, tailY: 0.7, pinned: true }];
    const res = placeAll(doc, page);
    const pinned = footprintOf(doc, page, res.balloons.find((b) => b.lineId === 'l3')!);
    for (const b of res.balloons) {
      if (b.lineId === 'l3') continue;
      expect(overlapFrac(footprintOf(doc, page, b), pinned), `${b.lineId} vs the pinned tail`).toBe(0);
    }
  });

  it('a placed balloon’s own tail never reaches across a neighbour', () => {
    const { doc, page } = liveDoc();
    const res = placeAll(doc, page);
    const feet = res.balloons.map((b) => ({ id: b.lineId, f: footprintOf(doc, page, b) }));
    for (let i = 0; i < feet.length; i += 1) for (let j = i + 1; j < feet.length; j += 1) expect(overlapFrac(feet[i].f, feet[j].f), `${feet[i].id} × ${feet[j].id}`).toBe(0);
  });

  it('a full panel spills to free page space instead of stacking, and says so', () => {
    const { doc, page } = crowdedDoc();
    const res = placeAll(doc, page);
    expect(res.balloons.map((b) => b.lineId)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5']);
    const feet = res.balloons.map((b) => ({ id: b.lineId, f: footprintOf(doc, page, b) }));
    for (let i = 0; i < feet.length; i += 1) for (let j = i + 1; j < feet.length; j += 1) expect(overlapFrac(feet[i].f, feet[j].f), `${feet[i].id} × ${feet[j].id}`).toBe(0);
    const safe = safeAreaBox(0.03, ASPECT);
    for (const { id, f } of feet) {
      expect(f.x, `${id} left`).toBeGreaterThanOrEqual(-1e-6);
      expect(f.y, `${id} top`).toBeGreaterThanOrEqual(-1e-6);
      expect(f.x + f.w, `${id} right`).toBeLessThanOrEqual(1 + 1e-6);
      expect(f.y + f.h, `${id} bottom`).toBeLessThanOrEqual(1 + 1e-6);
      const o = outlineOf(doc, page, res.balloons.find((b) => b.lineId === id)!);
      expect(o.x + 1e-3).toBeGreaterThanOrEqual(safe.x); // stored to 4 decimals
      expect(o.x + o.w - 1e-3).toBeLessThanOrEqual(safe.x + safe.w);
    }
    // Three 170-character lines cannot share a half-width panel: at least one left it, flagged crowded.
    const boxes = panelBoxesFor(doc, page);
    const p2 = boxes[1];
    const left = res.balloons.filter((b) => ['c2', 'c3', 'c4'].includes(b.lineId) && overlapFrac(outlineOf(doc, page, b), p2) < 0.999);
    expect(left.length).toBeGreaterThan(0);
    for (const b of left) expect(res.crowded).toContain(b.lineId);
    // The lines with room are not crowded.
    expect(res.crowded).not.toContain('c1');
    expect(res.crowded).not.toContain('c5');
  });

  it('defaultTailTip mirrors the renderer’s default (below the box, 42 % across)', () => {
    expect(defaultTailTip({ x: 0.1, y: 0.2, w: 0.3 }, 0.1)).toEqual({ x: 0.226, y: 0.34 });
    expect(defaultTailTip({ x: 0.9, y: 0.95, w: 0.3 }, 0.1).y).toBe(1);
  });

  it('balloonFootprint is the outline when there is no tail, else the union with the tip', () => {
    const o: Box = { x: 0.1, y: 0.1, w: 0.2, h: 0.1 };
    expect(balloonFootprint(o, null)).toEqual(o);
    const f = balloonFootprint(o, { x: 0.05, y: 0.3 });
    expect(f.x).toBeCloseTo(0.05, 9);
    expect(f.y).toBeCloseTo(0.1, 9);
    expect(f.w).toBeCloseTo(0.25, 9);
    expect(f.h).toBeCloseTo(0.2, 9);
    expect(balloonFootprint(o, { x: 0.2, y: 0.15 })).toEqual(o);
  });
});

describe('settleBalloons (render-time collision pass)', () => {
  const W = 1000;
  const H = 1500;
  const item = (id: string, outline: Box, extra: Partial<SettleItem> = {}): SettleItem => ({ id, outline, movable: true, ...extra });
  const settle = (items: SettleItem[]) => settleBalloons(items, { w: W, h: H }, { margin: { x: 8, y: 12 }, gap: 10 });

  it('does nothing when nothing overlaps', () => {
    const r = settle([item('a', { x: 100, y: 100, w: 200, h: 100 }), item('b', { x: 400, y: 100, w: 200, h: 100 })]);
    expect(r.moves.size).toBe(0);
    expect(r.unresolved).toEqual([]);
  });

  it('slides an unpinned balloon off a pinned one, flush below it with the gap, and never moves the pinned one', () => {
    const r = settle([item('pin', { x: 300, y: 450, w: 400, h: 150 }, { movable: false }), item('free', { x: 320, y: 470, w: 400, h: 120 })]);
    expect(r.moves.has('pin')).toBe(false);
    const mv = r.moves.get('free')!;
    expect(mv).toBeDefined();
    expect(mv.dx).toBe(0);
    expect(470 + mv.dy).toBeCloseTo(450 + 150 + 10, 3);
    expect(r.unresolved).toEqual([]);
  });

  it('the later balloon in reading order yields to the earlier one when both may move', () => {
    const r = settle([item('first', { x: 300, y: 450, w: 400, h: 150 }), item('second', { x: 320, y: 470, w: 400, h: 120 })]);
    expect(r.moves.has('first')).toBe(false);
    expect(r.moves.has('second')).toBe(true);
  });

  it('keeps a fixed tail tip when a spot exists, else moves the tail with the balloon', () => {
    // The tip sits just below the blocker: a position below keeps the aim.
    const keep = settle([item('pin', { x: 300, y: 450, w: 400, h: 150 }, { movable: false }), item('free', { x: 320, y: 470, w: 400, h: 120 }, { tip: { x: 500, y: 650 } })]);
    expect(keep.moves.get('free')!.tipMoved).toBe(false);
    // The tip sits INSIDE the blocker: no position keeps the union clear, so the tail follows.
    const follow = settle([item('pin', { x: 300, y: 450, w: 400, h: 150 }, { movable: false }), item('free', { x: 320, y: 470, w: 400, h: 120 }, { tip: { x: 500, y: 500 } })]);
    const mv = follow.moves.get('free')!;
    expect(mv.tipMoved).toBe(true);
    expect(follow.unresolved).toEqual([]);
  });

  it('linked balloons may touch; a full page reports the balloon it could not clear', () => {
    const linked = settle([item('a', { x: 100, y: 100, w: 300, h: 100 }, { group: 'g', movable: false }), item('b', { x: 150, y: 150, w: 300, h: 100 }, { group: 'g' })]);
    expect(linked.moves.size).toBe(0);
    const wall = settle([item('wall', { x: 8, y: 12, w: W - 16, h: H - 24 }, { movable: false }), item('x', { x: 100, y: 100, w: 200, h: 100 })]);
    expect(wall.unresolved).toEqual(['x']);
  });

  it('prefers to stay inside the balloon’s own panel', () => {
    const region: Box = { x: 0, y: 700, w: W, h: 800 };
    const r = settle([item('pin', { x: 300, y: 700, w: 400, h: 150 }, { movable: false }), item('free', { x: 320, y: 720, w: 400, h: 120 }, { region })]);
    const mv = r.moves.get('free')!;
    expect(720 + mv.dy).toBeGreaterThanOrEqual(700); // not above the panel, although that is as close
  });

  it('is deterministic and keeps outlines inside the page margins', () => {
    const items = [item('pin', { x: 300, y: 1300, w: 400, h: 150 }, { movable: false }), item('free', { x: 320, y: 1320, w: 400, h: 120 })];
    const a = settle(items);
    const b = settle(items);
    expect(a).toEqual(b);
    const mv = a.moves.get('free')!;
    expect(1320 + mv.dy + 120).toBeLessThanOrEqual(H - 12 + 1e-6);
    expect(320 + mv.dx).toBeGreaterThanOrEqual(8 - 1e-6);
  });

  it('never moves a balloon into a panel the reader finishes before its own while its tier has room (reading order)', () => {
    // Top tier = panel 1 (empty, closest); bottom tier = panel 2, whose left half is taken by a pin.
    const panel1: Box = { x: 20, y: 20, w: 960, h: 700 };
    const panel2: Box = { x: 20, y: 760, w: 960, h: 720 };
    const r = settle([
      item('pin', { x: 30, y: 770, w: 470, h: 300 }, { movable: false }),
      item('late', { x: 40, y: 780, w: 300, h: 120 }, { region: panel2, before: [panel1], text: { x: 40, y: 780, w: 300, h: 120 } })
    ]);
    const mv = r.moves.get('late')!;
    const cy = 780 + mv.dy + 60;
    expect(cy, 'text centre stays in its own tier').toBeGreaterThanOrEqual(panel2.y);
    expect(r.reordered).toEqual([]);
  });

  it('keeps a moved line after the previous line of its panel; only a page with no room at all reads it early, and says so', () => {
    const panel: Box = { x: 20, y: 20, w: 960, h: 1460 };
    // The previous line sits mid-panel; the blocked line must land below or after it, not above.
    const r = settle([
      item('prev', { x: 100, y: 600, w: 300, h: 120 }, { movable: false, region: panel }),
      item('pin', { x: 500, y: 600, w: 300, h: 300 }, { movable: false }),
      item('next', { x: 520, y: 620, w: 280, h: 100 }, { region: panel, after: 'prev', text: { x: 520, y: 620, w: 280, h: 100 } })
    ]);
    const mv = r.moves.get('next')!;
    expect(620 + mv.dy, 'not above the previous line').toBeGreaterThanOrEqual(600 - 0.02 * H);
    // A page whose only free room is above: the balloon still never overlaps, and is reported as read early.
    const full = settle([
      item('prev', { x: 8, y: 700, w: W - 16, h: 120 }, { movable: false, region: panel }),
      item('wall', { x: 8, y: 830, w: W - 16, h: H - 830 - 12 }, { movable: false }),
      item('next', { x: 100, y: 840, w: 280, h: 100 }, { region: { x: 20, y: 700, w: 960, h: 780 }, after: 'prev', text: { x: 100, y: 840, w: 280, h: 100 } })
    ]);
    expect(full.unresolved).toEqual([]);
    expect(full.reordered).toEqual(['next']);
  });
});

describe('placeBalloons: reading order when a panel is full', () => {
  it('a line whose panel is full spills beside it or later — never into a panel read before it', () => {
    const { doc, page } = liveDoc();
    // Panel 3 (middle tier, right) is covered by three pinned captions; panels 1 and 2 before it are empty
    // and closest — the old spill took them. Its two lines must go beside it or to a later tier.
    // Panel 5 (below it) is covered too, so the nearest free room is panel 2 beside it — read first.
    const boxes = panelBoxesFor(doc, page);
    const p3 = boxes[2];
    const p5 = boxes[4];
    const long = 'A pinned caption that the owner placed over this panel, long enough to cover a third of it from edge to edge, and then some more words, and then some more words again, so that nothing else fits there at all.';
    page.panels[0].lines = [1, 2, 3, 4, 5, 6].map((i) => line(`x${i}`, 'caption', long));
    page.panels[1].lines = [];
    page.panels[4].lines = [];
    page.balloons = [0, 1, 2, 3, 4, 5].map((i) => {
      const box = i < 3 ? p3 : p5;
      return { lineId: `x${i + 1}`, x: box.x + 0.005, y: box.y + 0.005 + ((i % 3) * box.h) / 3, w: box.w - 0.01, pinned: true };
    });
    const res = placeAll(doc, page);
    const sizer = letteringSizer(doc, page, ASPECT, estimateMeasure);
    for (const id of ['l4', 'l5']) {
      const b = res.balloons.find((q) => q.lineId === id)!;
      const s = sizer(page.panels[2].lines.find((l) => l.id === id)!, b.w);
      const cx = b.x + b.w / 2;
      const cy = b.y + s.h / 2;
      for (const r of [0, 1]) {
        const e = boxes[r];
        expect(cx >= e.x && cx <= e.x + e.w && cy >= e.y && cy <= e.y + e.h, `${id} drawn in panel ${r + 1}, read before panel 3`).toBe(false);
      }
      expect(cy, `${id} not above panel 3's tier`).toBeGreaterThanOrEqual(p3.y - 1e-6);
      expect(res.crowded).toContain(id);
    }
    // And still nothing overlaps.
    const outlines = res.balloons.map((b) => outlineOf(doc, page, b));
    for (let i = 0; i < outlines.length; i += 1)
      for (let j = i + 1; j < outlines.length; j += 1) expect(overlapArea(outlines[i], outlines[j]), `${res.balloons[i].lineId}×${res.balloons[j].lineId}`).toBe(0);
  });
});

// ── Reading order against BOTH neighbours: the previous line and the next line the owner fixed ─────────

const round = (n: number) => Math.round(n * 10000) / 10000;

/** A text box at `p` (top-left) is read before one at `q`: above its row, or on its row nearer the reading start. */
const readsBeforePt = (p: { x: number; y: number }, q: { x: number; y: number }, rtl: boolean): boolean =>
  p.y < q.y - ROW_TOLERANCE || (Math.abs(p.y - q.y) < ROW_TOLERANCE && (rtl ? p.x > q.x : p.x < q.x));

/** One full-page panel: a pinned sound effect, a caption with no balloon, then a caption the owner stored (not pinned). */
const orderDoc = (rtl: boolean, a: Omit<Balloon, 'lineId'>, c: (aBottom: number) => Omit<Balloon, 'lineId'>): { doc: ComicDoc; page: Page; a: Balloon; c: Balloon } => {
  const doc = normalizeDoc(createEmptyDoc('p_order', 'Order', 1));
  if (rtl) doc.format = { ...doc.format, readingDirection: 'rtl' };
  const page = {
    id: 'pg_order',
    n: 1,
    summary: '',
    layout: 'Row 1: one wide panel (panel 1).',
    render: { status: 'none' as const },
    balloons: [] as Balloon[],
    panels: [
      {
        id: 'p1',
        n: 1,
        size: 'splash',
        shot: 'wide',
        action: 'A pond at dawn.',
        castIds: [],
        lines: [
          line('a', 'sfx', 'SPLOOSH'),
          line('b', 'caption', 'Then the ducks arrived, all seven of them.'),
          line('c', 'caption', 'And then it rained.')
        ]
      }
    ]
  } as unknown as Page;
  doc.pages = [page];
  const stored: Balloon = { lineId: 'a', ...a, pinned: true };
  const bottom = outlineOf(doc, page, stored);
  const later: Balloon = { lineId: 'c', ...c(bottom.y + bottom.h) };
  page.balloons = [stored, later];
  return { doc, page, a: stored, c: later };
};

describe('placeBalloons: a placed line is read before the next line the owner fixed in its panel', () => {
  for (const rtl of [false, true]) {
    const dir = rtl ? 'rtl' : 'ltr';
    it(`${dir}: tucks a line between the previous line and a later stored one instead of after the later one`, () => {
      // A caption after a sound effect is drawn to the panel's end corner (bottom right; rtl bottom left) —
      // below the stored caption c, so the reader would meet c before b. There is plenty of room between a and c.
      const { doc, page, a, c } = orderDoc(rtl, { x: rtl ? 0.64 : 0.06, y: 0.06, w: 0.3 }, () => ({ x: rtl ? 0.64 : 0.06, y: 0.55, w: 0.3 }));
      const res = placeAll(doc, page, { keep: 'all' });
      const b = res.balloons.find((q) => q.lineId === 'b')!;
      expect(res.placed).toEqual(['b']);
      expect(readsBeforePt(b, a, rtl), 'b is read after a').toBe(false);
      expect(readsBeforePt(b, c, rtl), 'b is read before c').toBe(true);
      expect(res.crowded).toEqual([]);
      // Clear of both stored balloons.
      for (const s of [a, c]) expect(overlapArea(outlineOf(doc, page, b), outlineOf(doc, page, s)), `b × ${s.lineId}`).toBe(0);
    });

    it(`${dir}: with no room between them, sits beside the later stored line on its row, on the reading-start side`, () => {
      // a spans the panel and ends just above c: nothing fits between them, so the only spot read in order is
      // on c's row before it (left of it; rtl right of it) — not after it on its row, not below it.
      const { doc, page, a, c } = orderDoc(rtl, { x: 0.05, y: 0.06, w: 0.9 }, (aBottom) => ({ x: rtl ? 0.08 : 0.57, y: round(aBottom + 0.015), w: 0.35 }));
      const res = placeAll(doc, page, { keep: 'all' });
      const b = res.balloons.find((q) => q.lineId === 'b')!;
      expect(readsBeforePt(b, a, rtl), 'b is read after a').toBe(false);
      expect(readsBeforePt(b, c, rtl), 'b is read before c').toBe(true);
      expect(Math.abs(b.y - c.y), 'on c’s row').toBeLessThan(ROW_TOLERANCE);
      expect(res.crowded).toEqual([]);
      for (const s of [a, c]) expect(overlapArea(outlineOf(doc, page, b), outlineOf(doc, page, s)), `b × ${s.lineId}`).toBe(0);
    });
  }

  it('tucks in at a word-splitting width only when no whole-word spot is in turn, says so, and never with wholeWords', () => {
    // Sample page 1, panel 3: l3 pinned with a long tail, l5 stored below it. Right of l3's tail is the only
    // spot read in turn, and it is too narrow for "EXPLANATION," at full size.
    const doc = makeSampleDoc();
    const page = doc.pages[0];
    const l4 = page.panels[2].lines[1];
    const sizer = letteringSizer(doc, page, ASPECT, estimateMeasure);
    const minW = sizer(l4, 0.2).minW!;
    expect(minW).toBeGreaterThan(0);
    const res = placeAll(doc, page, { keep: 'all' });
    const b = res.balloons.find((q) => q.lineId === 'pg_1_l4')!;
    const l5 = page.balloons.find((q) => q.lineId === 'pg_1_l5')!;
    expect(readsBeforePt(b, l5, false), 'in turn').toBe(true);
    expect(b.w).toBeLessThan(minW);
    expect(res.split).toEqual(['pg_1_l4']);
    // Whole words only (the planner's retry): never narrower than the longest word, even out of turn.
    const whole = placeBalloonsDetailed({
      page,
      boxes: panelBoxesFor(doc, page),
      aspect: ASPECT,
      rtl: false,
      plansFor: sizer,
      safeMargin: 0.03,
      existing: page.balloons,
      keep: 'all',
      wholeWords: ['pg_1_l4']
    });
    const w = whole.balloons.find((q) => q.lineId === 'pg_1_l4')!;
    expect(w.w).toBeGreaterThanOrEqual(minW - 1e-4);
    expect(whole.split).toEqual([]);
    expect(whole.crowded).toContain('pg_1_l4');
    for (const s of page.balloons) expect(overlapArea(outlineOf(doc, page, w), outlineOf(doc, page, s)), `l4 × ${s.lineId}`).toBe(0);
  });

  it('a panel with no room in order still places the line clear of everything, and flags it', () => {
    // a fills the panel's top, c sits right under it at the far end of its row and a pinned wall covers the
    // rest of c's row: the only free room is below c (read after it). The line goes there, never over a
    // balloon, and is reported crowded so the editor can say so.
    const { doc, page, c } = orderDoc(false, { x: 0.05, y: 0.06, w: 0.9 }, (aBottom) => ({ x: 0.57, y: round(aBottom + 0.015), w: 0.35 }));
    const wall: Balloon = { lineId: 'w', x: 0.05, y: c.y, w: 0.5, pinned: true };
    page.panels[0].lines.push(line('w', 'caption', 'A wall of text the owner pinned across the start of this row, long enough to fill it.'));
    page.balloons = [...page.balloons, wall];
    const res = placeAll(doc, page, { keep: 'all' });
    const b = res.balloons.find((q) => q.lineId === 'b')!;
    for (const s of page.balloons) expect(overlapArea(outlineOf(doc, page, b), outlineOf(doc, page, s)), `b × ${s.lineId}`).toBe(0);
    expect(readsBeforePt(b, c, false)).toBe(false);
    expect(res.crowded).toContain('b');
  });
});

