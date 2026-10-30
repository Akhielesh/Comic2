import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { applyOps } from '../../../shared/comic/ops';
import { i18nOf, lineSourceHash, translationStatus } from '../../../shared/comic/i18n';
import { inverseOps } from '../../../shared/comic/undo';
import { estimateMeasure, planLettering } from '../../../shared/comic/lettering/layout';
import { resolveLetterStyle } from '../../../shared/comic/lettering/style';
import { resolvePlacements } from './useLetterPlans';
import {
  addLineAtOps,
  alignOps,
  balloonOp,
  clearStyleOps,
  deleteLinesOps,
  distributeOps,
  duplicateLineOps,
  easyShapeOps,
  findLineRef,
  fixSafeAreaOps,
  isLinked,
  linkOps,
  lockOps,
  moveLineToPanelOps,
  outlineFractions,
  presetOps,
  resetPositionOps,
  sharedValue,
  sizeStepOps,
  styleScopeOps,
  tailToggleOps,
  textEditOps,
  tidyOps,
  widenOps,
  zOrderOps
} from './styleOps';

const ASPECT = 2 / 3;
const H = 1000 / ASPECT;
const ctx = (mutate?: Parameters<typeof makeSampleDoc>[0]) => {
  const doc = makeSampleDoc(mutate);
  const page = doc.pages[0];
  const plans = planLettering(doc, page, ASPECT, estimateMeasure);
  const placements = resolvePlacements(doc, page, ASPECT, estimateMeasure);
  return { doc, page, plans, placements, resolved: placements.balloons };
};

describe('styleScopeOps (Apply this style to…)', () => {
  it('selection → one line_style over every selected id', () => {
    const { doc, page } = ctx();
    expect(styleScopeOps(doc, page, ['pg_1_l2', 'pg_1_l4'], { fill: '#ffd84a' }, 'selection')).toEqual([
      { op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l2', 'pg_1_l4'], patch: { fill: '#ffd84a' } }
    ]);
  });

  it('kind on this page → every line of that kind on the page', () => {
    const doc = makeSampleDoc((d) => d.pages[0].panels[0].lines.push({ id: 'cap2', kind: 'caption', text: 'Later.' }));
    const ops = styleScopeOps(doc, doc.pages[0], ['pg_1_l1'], { font: 'special-elite' }, 'kind_page');
    expect(ops).toEqual([{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l1', 'cap2'], patch: { font: 'special-elite' } }]);
  });

  it('all {kind} in the comic → letter_style.kinds[kind], lifting per-line overrides of the same keys', () => {
    const { doc, page } = ctx((d) => {
      d.pages[0].panels[2].lines[1].style = { fill: '#ff0000', font: 'kalam' };
      d.pages[1].panels[2].lines[1].style = { fill: '#00ff00' };
    });
    const ops = styleScopeOps(doc, page, ['pg_1_l4'], { fill: '#d8ecff' }, 'kind_comic');
    expect(ops[0]).toEqual({ op: 'letter_style', patch: { kinds: { speech: { fill: '#d8ecff' } } } });
    expect(ops).toContainEqual({ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4'], patch: { font: 'kalam' }, mode: 'replace' });
    expect(ops).toContainEqual({ op: 'line_style', pageId: 'pg_2', lineIds: ['pg_2_l4'], patch: null });
    const after = applyOps(doc, ops);
    for (const p of after.pages) for (const pn of p.panels) for (const l of pn.lines) if (l.kind === 'speech') expect(resolveLetterStyle(after, l).fill).toBe('#d8ecff');
  });

  it('speaker → letter_style.speakers[id]; comic → letter_style.base', () => {
    const { doc, page } = ctx();
    expect(styleScopeOps(doc, page, ['pg_1_l4'], { textColor: '#2a6fdb' }, 'speaker')[0]).toEqual({ op: 'letter_style', patch: { speakers: { ch_arjun: { textColor: '#2a6fdb' } } } });
    expect(styleScopeOps(doc, page, ['pg_1_l1'], { textColor: '#2a6fdb' }, 'speaker')).toEqual([]); // captions have no speaker
    expect(styleScopeOps(doc, page, ['pg_1_l1'], { font: 'andika' }, 'comic')[0]).toEqual({ op: 'letter_style', patch: { base: { font: 'andika' } } });
  });

  it('clears overrides, switches presets (a manual pick stops auto-switching)', () => {
    const { page } = ctx((d) => (d.pages[0].panels[2].lines[1].style = { fill: '#ff0000' }));
    expect(clearStyleOps(page, ['pg_1_l4', 'pg_1_l1'])).toEqual([{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4'], patch: null }]);
    expect(presetOps('storybook')).toEqual([{ op: 'letter_style', patch: { presetId: 'storybook', keepOverrides: false, auto: null } }]);
  });
});

describe('Easy controls', () => {
  it('size −/+ steps the resolved size within 0.6–2.0', () => {
    const { doc, page } = ctx((d) => (d.pages[0].panels[2].lines[1].style = { sizeScale: 1.95 }));
    expect(sizeStepOps(doc, page, ['pg_1_l2', 'pg_1_l4'], 0.1)).toEqual([
      { op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l2'], patch: { sizeScale: 1.1 } },
      { op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4'], patch: { sizeScale: 2 } }
    ]);
  });

  it('semantic shapes change the kind (and drop shape overrides); Robot sets the electronic look', () => {
    const { doc, page } = ctx((d) => (d.pages[0].panels[2].lines[1].style = { shape: 'oval', fill: '#ffffff' }));
    const ops = easyShapeOps(doc, page, ['pg_1_l4'], 'thought');
    expect(ops[0]).toEqual({ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l4', patch: { kind: 'thought' } });
    expect(ops[1]).toEqual({ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4'], patch: { fill: '#ffffff' }, mode: 'replace' });
    const caption = easyShapeOps(doc, page, ['pg_1_l4'], 'caption');
    expect(caption[0]).toMatchObject({ op: 'line', patch: { kind: 'caption', speakerId: null } });
    expect(easyShapeOps(doc, page, ['pg_1_l4'], 'robot')).toEqual([
      { op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4'], patch: { shape: 'electronic', tail: 'lightning', borderStyle: 'solid' } }
    ]);
  });

  it('tail on for a caption also gives it a tip; tail off is a style change only', () => {
    const { doc, page, resolved } = ctx();
    const on = tailToggleOps(doc, page, ['pg_1_l1'], true, resolved, H);
    expect(on[0]).toEqual({ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l1'], patch: { tail: 'auto' } });
    expect(on[1]).toMatchObject({ op: 'balloon', lineId: 'pg_1_l1' });
    expect(typeof (on[1] as { patch: { tailX: number } }).patch.tailX).toBe('number');
    expect(tailToggleOps(doc, page, ['pg_1_l4'], false, resolved, H)).toEqual([{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4'], patch: { tail: 'none' } }]);
  });

  it('sharedValue reports mixed selections as undefined', () => {
    const { doc } = ctx();
    const lines = doc.pages[0].panels.flatMap((p) => p.lines);
    expect(sharedValue(doc, lines.filter((l) => l.kind === 'speech'), 'font')).toBe('comic-neue');
    expect(sharedValue(doc, lines, 'font')).toBeUndefined(); // the SFX letters in Bangers
  });
});

describe('balloon ops always carry a full balloon for software-placed lines', () => {
  it('stored → patch only; placed → full balloon + patch', () => {
    const { page, resolved } = ctx();
    expect(balloonOp(page, 'pg_1_l2', { z: 9 }, resolved)).toEqual({ op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l2', patch: { z: 9 } });
    const op = balloonOp(page, 'pg_1_l4', { z: 9 }, resolved) as unknown as { patch: Record<string, number> };
    expect(op.patch.z).toBe(9);
    expect(op.patch.w).toBeGreaterThan(0.1);
    expect(typeof op.patch.x).toBe('number');
    expect('lineId' in op.patch).toBe(false);
  });

  it('delete / duplicate / lock / z-order / link', () => {
    const { page, plans, resolved } = ctx();
    expect(deleteLinesOps(page, ['pg_1_l3', 'nope'])).toEqual([{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l3', patch: null }]);
    const dup = duplicateLineOps(page, 'pg_1_l2', resolved, 'ln_copy');
    expect(dup[0]).toEqual({ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p2', id: 'ln_copy', patch: { kind: 'whisper', speakerId: 'ch_maya', text: 'Just one more…' }, index: 1 });
    expect(dup[1]).toMatchObject({ op: 'balloon', lineId: 'ln_copy', patch: { x: 0.08, y: 0.52, w: 0.22, pinned: true } });
    expect(lockOps(page, ['pg_1_l2'], true, resolved)).toEqual([{ op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l2', patch: { locked: true, pinned: true } }]);
    const front = zOrderOps(page, ['pg_1_l1'], 'front', plans, resolved)[0] as { patch: { z: number } };
    expect(front.patch.z).toBeGreaterThan(Math.max(...plans.map((p) => p.z)));
    expect(linkOps(page, 'pg_1_l4', true, resolved).at(-1)).toMatchObject({ op: 'balloon', lineId: 'pg_1_l4', patch: { linkTo: 'pg_1_l3' } });
    expect(linkOps(page, 'pg_1_l3', true, resolved)).toEqual([]); // first line of its panel
  });

  it('unlink rewrites the page balloons without the link', () => {
    const { page, resolved } = ctx((d) => {
      d.pages[0].balloons.push({ lineId: 'pg_1_l4', x: 0.5, y: 0.6, w: 0.3, linkTo: 'pg_1_l3', pinned: true });
    });
    const [op] = linkOps(page, 'pg_1_l4', false, resolved) as [{ op: string; balloons: { lineId: string; linkTo?: string }[] }];
    expect(op.op).toBe('balloons');
    expect(op.balloons.find((b) => b.lineId === 'pg_1_l4')!.linkTo).toBeUndefined();
  });

  it('unlink clears the links at both ends (its own and the next balloon’s into it); isLinked sees both', () => {
    const { page, resolved } = ctx((d) => {
      d.pages[0].balloons.push({ lineId: 'pg_1_l4', x: 0.5, y: 0.6, w: 0.3, linkTo: 'pg_1_l3', pinned: true });
    });
    // l3 has no linkTo of its own, but l4 links INTO it.
    expect(isLinked(page, 'pg_1_l3')).toBe(true);
    expect(isLinked(page, 'pg_1_l4')).toBe(true);
    expect(isLinked(page, 'pg_1_l1')).toBe(false);
    const [op] = linkOps(page, 'pg_1_l3', false, resolved) as [{ op: string; balloons: { lineId: string; linkTo?: string }[] }];
    expect(op.op).toBe('balloons');
    expect(op.balloons.some((b) => b.linkTo)).toBe(false);
    expect(linkOps({ ...page, balloons: op.balloons } as typeof page, 'pg_1_l3', false, resolved)).toEqual([]);
  });
});

describe('arrange', () => {
  it('align left lines up the outlines; distribute spaces them evenly', () => {
    const { page, plans, resolved } = ctx();
    const ops = alignOps(page, plans, ['pg_1_l2', 'pg_1_l3'], 'left', H, resolved);
    const after = applyOps(makeSampleDoc(), ops);
    const re = planLettering(after, after.pages[0], ASPECT, estimateMeasure);
    const left = (id: string) => outlineFractions(re.find((p) => p.lineId === id)!, H).x;
    expect(left('pg_1_l2')).toBeCloseTo(left('pg_1_l3'), 2);
    expect(distributeOps(page, plans, ['pg_1_l2', 'pg_1_l3'], H, resolved)).toEqual([]); // needs 3
    expect(distributeOps(page, plans, ['pg_1_l1', 'pg_1_l2', 'pg_1_l3'], H, resolved)).toHaveLength(3);
  });

  it('fix safe area moves only balloons whose outline leaves it', () => {
    const { doc, page } = ctx((d) => {
      d.pages[0].balloons[0] = { lineId: 'pg_1_l1', x: 0.7904, y: 0.04, w: 0.2096, pinned: true };
    });
    const plans = planLettering(doc, page, ASPECT, estimateMeasure);
    const resolved = resolvePlacements(doc, page, ASPECT, estimateMeasure).balloons;
    const ops = fixSafeAreaOps(doc, page, plans, H, resolved);
    expect(ops.map((o) => (o as { lineId: string }).lineId)).toContain('pg_1_l1');
    const after = applyOps(doc, ops);
    const p = planLettering(after, after.pages[0], ASPECT, estimateMeasure).find((x) => x.lineId === 'pg_1_l1')!;
    expect(p.outOfSafeArea).toBe(false);
  });

  it('tidy re-places only unpinned balloons (free) and is empty when nothing moves', () => {
    const { doc, page } = ctx();
    const ops = tidyOps(doc, page, ASPECT, estimateMeasure);
    expect(ops).toHaveLength(1);
    const after = applyOps(doc, ops);
    expect(after.pages[0].balloons.find((b) => b.lineId === 'pg_1_l3')).toEqual(page.balloons.find((b) => b.lineId === 'pg_1_l3')); // pinned
    expect(tidyOps(after, after.pages[0], ASPECT, estimateMeasure)).toEqual([]);
  });

  it('reset position un-pins and lets the placer choose again', () => {
    const { doc, page } = ctx();
    const ops = resetPositionOps(doc, page, ['pg_1_l3'], ASPECT, estimateMeasure);
    expect(ops[0]).toMatchObject({ op: 'balloon', lineId: 'pg_1_l3', patch: { pinned: false } });
  });
});

describe('widen (overflow fix)', () => {
  it('always makes the balloon wider than drawn — never narrower — and keeps it on the page', () => {
    // A balloon the user already made wide (0.6) near the right edge: "Fit text" would narrow it.
    const { doc, page } = ctx((d) => {
      d.pages[0].balloons[0] = { lineId: 'pg_1_l1', x: 0.38, y: 0.05, w: 0.6, pinned: true };
    });
    const plans = planLettering(doc, page, ASPECT, estimateMeasure);
    const resolved = resolvePlacements(doc, page, ASPECT, estimateMeasure).balloons;
    const before = plans.find((p) => p.lineId === 'pg_1_l1')!;
    const ops = widenOps(doc, page, plans, ['pg_1_l1'], resolved);
    expect(ops).toHaveLength(1);
    const patch = (ops[0] as { patch: { x: number; w: number; pinned: boolean } }).patch;
    expect(patch.w).toBeGreaterThan(before.w / 1000);
    expect(patch.pinned).toBe(true);
    expect(patch.x + patch.w).toBeLessThanOrEqual(1 - 0.008 + 1e-9);
    expect(patch.x).toBeGreaterThanOrEqual(0.008);
    // Locked balloons are left alone.
    const locked = plans.map((p) => (p.lineId === 'pg_1_l1' ? { ...p, locked: true } : p));
    expect(widenOps(doc, page, locked, ['pg_1_l1'], resolved)).toEqual([]);
  });
});

describe('lines', () => {
  it('adds a line where the user clicked, in that panel, with a balloon and a tail', () => {
    const { doc, page } = ctx();
    const { ops, id, panelId } = addLineAtOps(doc, page, 'speech', { x: 0.5, y: 0.08 }, ASPECT, 'ln_new');
    expect(id).toBe('ln_new');
    expect(panelId).toBe('pg_1_p1');
    expect(ops[0]).toEqual({ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p1', id: 'ln_new', patch: { kind: 'speech', text: '' } });
    const b = (ops[1] as { patch: { x: number; w: number; tailX: number } }).patch;
    expect(b.x + b.w / 2).toBeCloseTo(0.5, 1);
    expect(typeof b.tailX).toBe('number');
  });

  it('moves a crowded line to another panel and commits inline text', () => {
    const { page } = ctx();
    // One structural move (never a delete + create); the speaker is re-picked only when the new panel lacks them.
    expect(moveLineToPanelOps(page, 'pg_1_l4', 'pg_1_p2')).toEqual([
      { op: 'line_move', pageId: 'pg_1', id: 'pg_1_l4', toPanelId: 'pg_1_p2', index: 0 },
      { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p2', id: 'pg_1_l4', patch: { speakerId: 'ch_maya' } }
    ]);
    expect(moveLineToPanelOps(page, 'pg_1_l4', 'pg_1_p3')).toEqual([]);
    expect(textEditOps(page, 'pg_1_l4', 'You owe me an explanation, Maya.')).toEqual([]);
    expect(textEditOps(page, 'pg_1_l4', 'Talk.')).toEqual([{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l4', patch: { text: 'Talk.' } }]);
  });

  it('"Move to panel N" keeps the line’s translations, their review state and the edition balloon; Undo puts it back', () => {
    const { doc, page } = ctx((d) => {
      const line = d.pages[0].panels[1].lines[0]; // pg_1_l2, Maya's whisper
      d.i18n = {
        glossary: [],
        editions: {
          te: {
            lang: 'te',
            register: 'everyday',
            lines: { pg_1_l2: { text: 'ఇంకొక్కటే…', status: 'reviewed', sourceHash: lineSourceHash(line), at: 1, gloss: 'Just one more' } },
            balloons: { pg_1_l2: { x: 0.1, y: 0.5, w: 0.22, pinned: true } }
          }
        }
      };
    });
    const ops = moveLineToPanelOps(page, 'pg_1_l2', 'pg_1_p3');
    // The line travels whole; its stored balloon is released so the placer sets it in panel 3. Nothing is deleted.
    expect(ops).toEqual([
      { op: 'line_move', pageId: 'pg_1', id: 'pg_1_l2', toPanelId: 'pg_1_p3', index: 0 },
      { op: 'balloons', pageId: 'pg_1', balloons: page.balloons.filter((b) => b.lineId !== 'pg_1_l2') }
    ]);
    const after = applyOps(doc, ops);
    const moved = findLineRef(after.pages[0], 'pg_1_l2')!;
    expect(moved.panel.id).toBe('pg_1_p3');
    expect(moved.index).toBe(0);
    expect(moved.line).toBe(findLineRef(page, 'pg_1_l2')!.line);
    // The reviewed Telugu line and the edition's own balloon survive, exactly as they were (paid, reviewed work).
    expect(i18nOf(after).editions.te.lines.pg_1_l2).toEqual({ text: 'ఇంకొక్కటే…', status: 'reviewed', sourceHash: lineSourceHash(moved.line), at: 1, gloss: 'Just one more' });
    expect(i18nOf(after).editions.te.balloons.pg_1_l2).toEqual({ x: 0.1, y: 0.5, w: 0.22, pinned: true });
    expect(translationStatus(after, 'te', moved.line)).toBe('reviewed');
    // Undo: back in panel 2 with its stored balloon.
    const undone = applyOps(after, inverseOps(doc, ops));
    expect(undone.pages[0].panels.map((p) => p.lines.map((l) => l.id))).toEqual(page.panels.map((p) => p.lines.map((l) => l.id)));
    expect(undone.pages[0].balloons).toEqual(page.balloons);
    expect(i18nOf(undone)).toEqual(i18nOf(doc));
  });
});
