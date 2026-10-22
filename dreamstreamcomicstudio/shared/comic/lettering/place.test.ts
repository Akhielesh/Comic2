import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../../components/comicstudio/board/__fixtures__/sampleDoc';
import { createEmptyDoc, normalizeDoc, type Balloon, type Box, type ComicDoc, type KeepOut, type Line, type Page, type SpeakerMark } from '../doc';
import { panelBoxesFor } from '../pageGeometry';
import { estimateMeasure, letteringSizer } from './layout';
import { OUTLINE_BLEED, OUTLINE_BLEED_XY, fitBalloonOnPage, outlineBounds, placeBalloons, placeBalloonsDetailed, safeAreaBox, stagedSpeakerX, tailExitPoint } from './place';

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
