// editionOps on the real lettering actions (bug hunt LE-3 / LE-4): in a translated edition, "Bring to
// front", "Send to back", "Lock" and "Unlink" change SHARED balloon properties (stacking, lock, the
// connector) that belong to the original. They must never write the balloon's geometry into the edition
// as a side effect (that freezes it: later moves in the original stop following), and when they cannot
// apply they must be counted as dropped so the editor says so — never a silent no-op.
import { describe, expect, it, vi } from 'vitest';
// The worktree's symlinked node_modules makes Vite deny the @fontsource `?url` asset imports; the font
// loader is a no-op in jsdom anyway (no document.fonts), so the file table is stubbed.
vi.mock('../../lettering/fontFiles', () => ({ FONT_FILES: {} }));
import type { ComicDoc } from '../../../../shared/comic/doc';
import type { DocOp } from '../../../../shared/comic/ops';
import { applyOps } from '../../../../shared/comic/ops';
import { i18nOf, lineSourceHash } from '../../../../shared/comic/i18n';
import { estimateMeasure, planLettering } from '../../../../shared/comic/lettering/layout';
import { resolvePlacements } from '../../lettering/useLetterPlans';
import { linkOps, lockOps, resetPositionOps, tailToggleOps, tidyOps, zOrderOps } from '../../lettering/styleOps';
import { SAMPLE_NOW, makeSampleDoc } from '../../board/__fixtures__/sampleDoc';
import { editionOps, editionViewDoc } from './editorModel';

const ASPECT = 2 / 3;

/** The sample doc with a reviewed Telugu translation of pg_1_l2 and a Telugu-only position for it. */
const withTelugu = (mutate?: (d: ComicDoc) => void) =>
  makeSampleDoc((d) => {
    const line = d.pages[0].panels.flatMap((p) => p.lines).find((l) => l.id === 'pg_1_l2')!;
    d.i18n = {
      glossary: [],
      editions: {
        te: {
          lang: 'te',
          register: 'everyday',
          lines: { pg_1_l2: { text: 'పదండి!', status: 'reviewed', sourceHash: lineSourceHash(line), at: SAMPLE_NOW } },
          balloons: { pg_1_l2: { x: 0.1, y: 0.5, w: 0.22, pinned: true } }
        }
      }
    };
    mutate?.(d);
  });

/** What the page editor works on in the Telugu edition: the localized view, its plans and placements. */
const setup = (mutate?: (d: ComicDoc) => void) => {
  const doc = withTelugu(mutate);
  const vDoc = editionViewDoc(doc, 'te');
  const page = vDoc.pages[0];
  const plans = planLettering(vDoc, page, ASPECT, estimateMeasure);
  const placements = resolvePlacements(vDoc, page, ASPECT, estimateMeasure);
  return { doc, vDoc, page, plans, placements };
};

const editionBalloons = (ops: readonly DocOp[]) => ops.filter((o) => o.op === 'edition_balloon');

describe('editionOps: stacking, lock and link never pin a balloon in the edition (LE-3)', () => {
  it('"Bring to front" / "Send to back" on a software-placed balloon: dropped (it belongs to the original), no geometry written', () => {
    const { doc, page, plans, placements } = setup();
    expect(page.balloons.some((b) => b.lineId === 'pg_1_l4')).toBe(false); // software-placed in both languages
    for (const move of ['front', 'back'] as const) {
      const ops = zOrderOps(page, ['pg_1_l4'], move, plans, placements.balloons);
      // The op carries the whole resolved balloon (x, y, w, tail) because the line has no stored balloon…
      expect(ops[0].op === 'balloon' && ops[0].patch && 'x' in ops[0].patch).toBe(true);
      const r = editionOps(ops, 'te', doc);
      expect(r.dropped).toBe(1);
      // …and none of that geometry may land in the edition.
      expect(r.ops).toEqual([]);
    }
  });

  it('"Lock" on a software-placed balloon either locks or does nothing — here nothing, and the editor is told', () => {
    const { doc, page, placements } = setup();
    const r = editionOps(lockOps(page, ['pg_1_l4'], true, placements.balloons), 'te', doc);
    expect(editionBalloons(r.ops)).toEqual([]);
    expect(r.ops.filter((o) => o.op === 'balloon')).toEqual([]);
    expect(r.dropped).toBe(1);
    // Nothing reached the doc: the edition still has no position of its own for the line.
    expect(i18nOf(applyOps(doc, r.ops)).editions.te.balloons.pg_1_l4).toBeUndefined();
  });

  it('a stored source balloon: stacking and lock pass to the shared balloon only — Lock’s implied pin is not an edition move', () => {
    const { doc, page, plans, placements } = setup();
    expect(doc.pages[0].balloons.some((b) => b.lineId === 'pg_1_l1')).toBe(true);
    const front = editionOps(zOrderOps(page, ['pg_1_l1'], 'front', plans, placements.balloons), 'te', doc);
    expect(front.dropped).toBe(0);
    expect(front.ops).toHaveLength(1);
    expect(front.ops[0]).toMatchObject({ op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l1' });
    expect(Object.keys((front.ops[0] as Extract<DocOp, { op: 'balloon' }>).patch || {})).toEqual(['z']);
    const lock = editionOps(lockOps(page, ['pg_1_l1'], true, placements.balloons), 'te', doc);
    expect(lock).toEqual({ ops: [{ op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l1', patch: { locked: true } }], dropped: 0 });
  });

  it('a drag still writes the edition position (geometry with no shared keys is the user’s intent)', () => {
    const { doc } = setup();
    const r = editionOps([{ op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l4', patch: { x: 0.4, y: 0.6, w: 0.3, pinned: true } }], 'te', doc);
    expect(r).toEqual({ ops: [{ op: 'edition_balloon', lang: 'te', lineId: 'pg_1_l4', patch: { x: 0.4, y: 0.6, w: 0.3, pinned: true } }], dropped: 0 });
  });
});

describe('editionOps: Unlink and Tidy in an edition (LE-4)', () => {
  const linked = (d: ComicDoc) => {
    d.pages[0].balloons.push({ lineId: 'pg_1_l4', x: 0.5, y: 0.6, w: 0.2, linkTo: 'pg_1_l3' });
  };

  it('"Unlink" is counted as dropped (the connector belongs to the original) and freezes no balloon on the page', () => {
    const { doc, page, placements } = setup(linked);
    const ops = linkOps(page, 'pg_1_l4', false, placements.balloons);
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('balloons');
    const r = editionOps(ops, 'te', doc);
    expect(r.dropped).toBe(1);
    expect(editionBalloons(r.ops)).toEqual([]);
    expect(r.ops).toEqual([]);
  });

  it('Tidy in an edition re-places that language: only the balloons that move get an edition position', () => {
    const { doc, vDoc, page } = setup((d) => {
      // Crowd two stored balloons onto the same spot so Tidy has something to fix.
      d.pages[0].balloons = d.pages[0].balloons.map((b) => ({ ...b, x: 0.4, y: 0.4, pinned: false }));
    });
    const tidy = tidyOps(vDoc, page, ASPECT, estimateMeasure);
    expect(tidy).toHaveLength(1);
    const r = editionOps(tidy, 'te', doc);
    expect(r.dropped).toBe(0);
    const written = editionBalloons(r.ops);
    expect(written.length).toBeGreaterThan(0);
    // Every write is a real move against what the edition draws now; the source balloons are untouched.
    const before = new Map(page.balloons.map((b) => [b.lineId, b]));
    for (const op of written) {
      if (op.op !== 'edition_balloon' || !op.patch) continue;
      const prev = before.get(op.lineId);
      expect(!prev || prev.x !== op.patch.x || prev.y !== op.patch.y || prev.w !== op.patch.w).toBe(true);
    }
    expect(applyOps(doc, r.ops).pages[0].balloons).toEqual(doc.pages[0].balloons);
  });
});

describe('editionOps: whole-balloon ops carry the stored shared keys unchanged — they still move the balloon here', () => {
  const sourceOps = (ops: readonly DocOp[]) => ops.filter((o) => o.op === 'balloon');

  it('"Reset position" on a stored balloon that was brought to front (z: 5) re-places it in the edition, and writes nothing to the original', () => {
    const { doc, vDoc, page } = setup((d) => {
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l1' ? { ...b, z: 5, x: 0.6, y: 0.7 } : b));
    });
    const ops = resetPositionOps(vDoc, page, ['pg_1_l1'], ASPECT, estimateMeasure);
    expect(ops).toHaveLength(1);
    // The placer hands back the whole balloon, the stored z included…
    expect(ops[0].op === 'balloon' && ops[0].patch?.z).toBe(5);
    const r = editionOps(ops, 'te', doc);
    expect(r.dropped).toBe(0);
    // …which is no restack: only the edition's position is written, unpinned (it follows the placer again).
    expect(sourceOps(r.ops)).toEqual([]);
    const written = editionBalloons(r.ops);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ op: 'edition_balloon', lang: 'te', lineId: 'pg_1_l1', patch: { pinned: false } });
    const p = (written[0] as Extract<DocOp, { op: 'edition_balloon' }>).patch!;
    expect(typeof p.x === 'number' && typeof p.y === 'number' && typeof p.w === 'number').toBe(true);
    expect('z' in p).toBe(false);
    expect(applyOps(doc, r.ops).pages[0].balloons).toEqual(doc.pages[0].balloons);
  });

  it('"Reset position" on a stored balloon that carries a connector re-places it here and keeps the connector untouched', () => {
    const { doc, vDoc, page } = setup((d) => {
      d.pages[0].balloons.push({ lineId: 'pg_1_l4', x: 0.5, y: 0.6, w: 0.2, linkTo: 'pg_1_l3' });
    });
    const ops = resetPositionOps(vDoc, page, ['pg_1_l4'], ASPECT, estimateMeasure);
    expect(ops[0].op === 'balloon' && ops[0].patch?.linkTo).toBe('pg_1_l3');
    const r = editionOps(ops, 'te', doc);
    expect(r.dropped).toBe(0);
    expect(sourceOps(r.ops)).toEqual([]);
    expect(editionBalloons(r.ops)).toHaveLength(1);
    expect(editionBalloons(r.ops)[0]).toMatchObject({ lineId: 'pg_1_l4', patch: { pinned: false } });
  });

  it('"Tail on" for a stored caption with a connector and a stacking order gives it a tail tip in the edition', () => {
    const { doc, vDoc, page, placements } = setup((d) => {
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l1' ? { ...b, z: 7, linkTo: 'pg_1_l2' } : b));
    });
    const ops = tailToggleOps(vDoc, page, ['pg_1_l1'], true, placements.balloons, 1000 / ASPECT);
    const tip = ops.find((o) => o.op === 'balloon');
    expect(tip && tip.op === 'balloon' && tip.patch?.linkTo).toBe('pg_1_l2');
    const r = editionOps(ops, 'te', doc);
    expect(r.dropped).toBe(0);
    // The tail style is shared (every language draws a tail)…
    expect(r.ops.filter((o) => o.op === 'line_style')).toHaveLength(1);
    // …and the tip lands in this edition; the original's balloon is not rewritten.
    expect(sourceOps(r.ops)).toEqual([]);
    const written = editionBalloons(r.ops);
    expect(written).toHaveLength(1);
    const p = (written[0] as Extract<DocOp, { op: 'edition_balloon' }>).patch!;
    expect(typeof p.tailX).toBe('number');
    expect(typeof p.tailY).toBe('number');
    expect(i18nOf(applyOps(doc, r.ops)).editions.te.balloons.pg_1_l1).toMatchObject({ tailX: p.tailX, tailY: p.tailY });
  });

  it('"Lock" on a stored balloon that is already locked moves nothing (its implied pin alone is no edition move)', () => {
    const { doc, page, placements } = setup((d) => {
      d.pages[0].balloons = d.pages[0].balloons.map((b) => (b.lineId === 'pg_1_l1' ? { ...b, locked: true } : b));
    });
    expect(editionOps(lockOps(page, ['pg_1_l1'], true, placements.balloons), 'te', doc)).toEqual({ ops: [], dropped: 0 });
  });
});

describe('editionOps: "Link to previous" in an edition belongs to the original', () => {
  it('drops the whole batch: no connector on the original, and the previous (software-placed) balloon is not pinned here', () => {
    const { doc, page, placements } = setup();
    expect(doc.pages[0].balloons.some((b) => b.lineId === 'pg_1_l4')).toBe(false);
    const ops = linkOps(page, 'pg_1_l5', true, placements.balloons);
    // The batch pins pg_1_l4 (software-placed) and links pg_1_l5 to it.
    expect(ops.map((o) => (o.op === 'balloon' ? o.lineId : o.op))).toEqual(['pg_1_l4', 'pg_1_l5']);
    const r = editionOps(ops, 'te', doc);
    expect(r).toEqual({ ops: [], dropped: 1 });
    const after = applyOps(doc, r.ops);
    expect(i18nOf(after).editions.te.balloons.pg_1_l4).toBeUndefined();
    expect(after.pages[0].balloons.find((b) => b.lineId === 'pg_1_l5')?.linkTo).toBeUndefined();
  });

  it('linking two stored balloons is dropped too, as Unlink is (the connector is shared by every language)', () => {
    const { doc, page, placements } = setup((d) => d.pages[0].balloons.push({ lineId: 'pg_1_l4', x: 0.5, y: 0.6, w: 0.2 }));
    const link = linkOps(page, 'pg_1_l5', true, placements.balloons);
    expect(link).toEqual([{ op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l5', patch: { linkTo: 'pg_1_l4' } }]);
    expect(editionOps(link, 'te', doc)).toEqual({ ops: [], dropped: 1 });
  });
});
