// styleOps — the Pro inspector's ops (PE-INSPECT; agent-editor plan §4 Wave 1 C-INSPECT and Wave 2 C-STYLES): the kind
// row, align to the page / panel / selection, horizontal distribute, Copy / Paste style, named styles (save, rename,
// duplicate, delete folds the patch back with no visual change) and the Layers restack through zOrderEdit.

import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../board/__fixtures__/sampleDoc';
import { applyOp, type DocOp } from '../../../shared/comic/ops';
import { inverseOps } from '../../../shared/comic/undo';
import { estimateMeasure, planLettering } from '../../../shared/comic/lettering/layout';
import { resolveLetterStyle, type LetterStyle } from '../../../shared/comic/lettering/style';
import { safeAreaBox } from '../../../shared/comic/lettering/place';
import { sceneObject } from '../../../shared/comic/editor/scene';
import type { ComicDoc, Line } from '../../../shared/comic/doc';
import { resolvePlacements } from './useLetterPlans';
import { duplicateLineOps, findLineRef, kindOps, KIND_ROW, moveLineToPanelOps } from './styleOps';
import {
  alignToEdit,
  cleanStyleName,
  copyStyleOf,
  deleteNamedStyleOps,
  distributeToEdit,
  duplicateNamedStyleOps,
  foldedStyleOf,
  namedStylesOf,
  pasteStyleOps,
  redefineNamedStyleOps,
  renameNamedStyleOps,
  restackEdit,
  saveNamedStyleOps,
  sceneFor,
  uniqueStyleName,
  useNamedStyleOps
} from './proStyleOps';
import { stripProFields } from '../editor/inspector/proGate';

const ASPECT = 2 / 3;

const ctx = (mutate?: Parameters<typeof makeSampleDoc>[0]) => {
  const doc = makeSampleDoc(mutate);
  const page = doc.pages[0];
  const plans = planLettering(doc, page, ASPECT, estimateMeasure);
  const placements = resolvePlacements(doc, page, ASPECT, estimateMeasure);
  return { doc, page, plans, placements };
};

const outline = (doc: ComicDoc, id: string) => {
  const page = doc.pages[0];
  return sceneObject(sceneFor(doc, page, planLettering(doc, page, ASPECT, estimateMeasure)), { kind: 'balloon', id })!.box;
};

/** applyOp plus `letter_style {named}` (PE-LETTER's mergeNamedStyles in ops.ts: an S2b integration wave note). */
const applyNamed = (doc: ComicDoc, ops: DocOp[]): ComicDoc =>
  ops.reduce((d, op) => {
    const named = op.op === 'letter_style' ? (op.patch as { named?: Record<string, unknown> } | null)?.named : undefined;
    if (!named) return applyOp(d, op);
    const next = { ...(d.letterStyle?.named || {}) } as Record<string, unknown>;
    for (const [id, v] of Object.entries(named)) {
      if (v === null) delete next[id];
      else next[id] = v;
    }
    const ls = { ...(d.letterStyle ?? { presetId: 'classic' as const }) } as Record<string, unknown>;
    if (Object.keys(next).length) ls.named = next;
    else delete ls.named;
    return { ...d, letterStyle: ls as unknown as ComicDoc['letterStyle'] };
  }, doc);

/** The PE-LETTER cascade (…doc.kinds → named[styleId] → doc.speakers → line.style): the named patch applied right after
 *  the kind's, the one slot the base cascade lets a test reach. */
const looks = (doc: ComicDoc, line: Line): LetterStyle => {
  const named = line.styleId ? doc.letterStyle?.named?.[line.styleId] : undefined;
  if (!named) return resolveLetterStyle(doc, line);
  const ls = doc.letterStyle!;
  const kinds = { ...(ls.kinds || {}), [line.kind]: { ...(ls.kinds?.[line.kind] || {}), ...named.patch } };
  return resolveLetterStyle({ ...doc, letterStyle: { ...ls, kinds } }, line);
};
const allLooks = (doc: ComicDoc) => doc.pages.flatMap((p) => p.panels.flatMap((panel) => panel.lines.map((l) => [l.id, looks(doc, l)] as const)));

describe('kindOps (the kind row, keys 1–6)', () => {
  it('writes line {kind} for each selected line that is not that kind, in the row order Speech … SFX', () => {
    expect(KIND_ROW).toEqual(['speech', 'thought', 'whisper', 'shout', 'caption', 'sfx']);
    const { page } = ctx();
    expect(kindOps(page, ['pg_1_l4'], 'shout')).toEqual([{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l4', patch: { kind: 'shout' } }]);
    expect(kindOps(page, ['pg_1_l3', 'pg_1_l4'], 'shout')).toHaveLength(1);
    expect(kindOps(page, ['pg_1_l3'], 'shout')).toEqual([]);
  });

  it('follows the script editor’s speaker rule: a caption drops its speaker, a spoken line gets its panel’s first', () => {
    const { page } = ctx();
    expect(kindOps(page, ['pg_1_l2'], 'caption')[0]).toMatchObject({ patch: { kind: 'caption', speakerId: null } });
    expect(kindOps(page, ['pg_1_l5'], 'speech')[0]).toMatchObject({ patch: { kind: 'speech', speakerId: 'ch_maya' } });
  });
});

describe('align and distribute (editor/align.ts)', () => {
  it('to the page: every outline lines up with the page’s lettering safe area', () => {
    const { doc, page, plans } = ctx();
    const r = alignToEdit(doc, page, plans, ['pg_1_l3', 'pg_1_l5'], 'left', 'page', ASPECT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.label).toBe('Align to the page’s left edge');
    expect(r.ops.every((o) => o.op === 'balloon')).toBe(true);
    const after = applyNamed(doc, r.ops);
    const safe = safeAreaBox(0.03, ASPECT);
    for (const id of ['pg_1_l3', 'pg_1_l5']) expect(outline(after, id).x).toBeCloseTo(safe.x, 2);
    expect(inverseOps(doc, r.ops).length).toBeGreaterThan(0);
  });

  it('to the panel: one balloon lines up with its panel’s frame', () => {
    const { doc, page, plans } = ctx();
    const frame = sceneObject(sceneFor(doc, page, plans), { kind: 'frame', id: 'pg_1_p3' })!.box;
    const r = alignToEdit(doc, page, plans, ['pg_1_l3'], 'right', 'panel', ASPECT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const box = outline(applyNamed(doc, r.ops), 'pg_1_l3');
    expect(box.x + box.w).toBeCloseTo(frame.x + frame.w, 2);
  });

  it('to the selection needs two balloons, and a locked one refuses honestly', () => {
    const { doc, page, plans } = ctx();
    const one = alignToEdit(doc, page, plans, ['pg_1_l3'], 'left', 'selection', ASPECT);
    expect(one.ok).toBe(false);
    const locked = ctx((d) => {
      d.pages[0].balloons = d.pages[0].balloons.map((b) => ({ ...b, locked: true, pinned: true }));
    });
    const r = alignToEdit(locked.doc, locked.page, locked.plans, ['pg_1_l3'], 'left', 'page', ASPECT);
    expect(r).toEqual({ ok: false, reason: 'Everything you picked is locked.' });
  });

  it('horizontal distribute: the gaps between three outlines come out equal, the first and last stay', () => {
    const { doc, page, plans } = ctx();
    const ids = ['pg_1_l1', 'pg_1_l3', 'pg_1_l5'];
    const before = ids.map((id) => outline(doc, id));
    const r = distributeToEdit(doc, page, plans, ids, 'h');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.label).toBe('Space evenly across');
    const after = applyNamed(doc, r.ops);
    const boxes = ids.map((id) => outline(after, id)).sort((a, b) => a.x - b.x);
    const gaps = [boxes[1].x - (boxes[0].x + boxes[0].w), boxes[2].x - (boxes[1].x + boxes[1].w)];
    expect(gaps[0]).toBeCloseTo(gaps[1], 2);
    const xs = before.map((b) => b.x).sort((a, b) => a - b);
    expect(boxes[0].x).toBeCloseTo(xs[0], 2);
    expect(distributeToEdit(doc, page, plans, ids.slice(0, 2), 'h').ok).toBe(false);
  });
});

describe('Copy style / Paste style', () => {
  const styled = () =>
    ctx((d) => {
      const l3 = d.pages[0].panels[2].lines[0];
      l3.style = { fill: '#ffd84a', borderWidth: 2, glow: { color: '#ffffff', size: 0.2 } };
      d.letterStyle = { presetId: 'classic', speakers: { ch_vendor: { textColor: '#6a4c93' } } };
    });

  it('copies the look a line adds over its kind (its speaker’s patch under its own style)', () => {
    const { doc, page } = styled();
    const clip = copyStyleOf(doc, page, 'pg_1_l3', false)!;
    expect(clip.from).toBe('pg_1_l3');
    expect(clip.patch).toEqual({ textColor: '#6a4c93', fill: '#ffd84a', borderWidth: 2, glow: { color: '#ffffff', size: 0.2 } });
    expect(copyStyleOf(doc, page, 'nope', false)).toBeUndefined();
  });

  it('pastes it onto the selection in one line_style replace, without the Pro fields while they are not writable', () => {
    const { doc, page } = styled();
    const clip = copyStyleOf(doc, page, 'pg_1_l3', false)!;
    const ops = pasteStyleOps(doc, page, ['pg_1_l3', 'pg_1_l4', 'pg_1_l5'], clip, { linkable: false, clean: stripProFields });
    expect(ops).toEqual([{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4', 'pg_1_l5'], patch: { textColor: '#6a4c93', fill: '#ffd84a', borderWidth: 2 }, mode: 'replace' }]);
    const after = applyNamed(doc, ops);
    const l4 = findLineRef(after.pages[0], 'pg_1_l4')!.line;
    expect(resolveLetterStyle(after, l4).fill).toBe('#ffd84a');
    expect(resolveLetterStyle(after, l4).textColor).toBe('#6a4c93');
  });

  it('a copied plain line clears the targets’ own styles; the saved-style link pastes only when linkable', () => {
    const { doc, page } = ctx((d) => {
      d.pages[0].panels[2].lines[1].style = { fill: '#ffffff' };
      d.pages[0].panels[2].lines[0].styleId = 'st_v';
      d.letterStyle = { presetId: 'classic', named: { st_v: { name: 'Villain', patch: { textColor: '#e63946' } } } };
    });
    const plain = copyStyleOf(doc, page, 'pg_1_l1', true)!;
    expect(pasteStyleOps(doc, page, ['pg_1_l4'], plain, { linkable: false })).toEqual([{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4'], patch: null }]);
    const linked = copyStyleOf(doc, page, 'pg_1_l3', true)!;
    expect(linked.styleId).toBe('st_v');
    expect(pasteStyleOps(doc, page, ['pg_1_l5'], linked, { linkable: true })).toEqual([{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l5', patch: { styleId: 'st_v' } }]);
    // Not linkable (Pro fields off): the saved style's look travels folded into the copy instead.
    const folded = copyStyleOf(doc, page, 'pg_1_l3', false)!;
    expect(folded.styleId).toBeUndefined();
    expect(folded.patch).toEqual({ textColor: '#e63946' });
  });
});

describe('named styles (C-STYLES)', () => {
  const withStyles = () =>
    ctx((d) => {
      const [l3, l4] = d.pages[0].panels[2].lines;
      l3.styleId = 'st_v';
      l4.styleId = 'st_v';
      l4.style = { textColor: '#111111' };
      d.letterStyle = {
        presetId: 'classic',
        speakers: { ch_arjun: { borderWidth: 1 } },
        named: { st_v: { name: 'Villain', patch: { textColor: '#e63946', borderWidth: 2.5, fill: '#fff6c8' } } }
      };
    });

  it('save: the line’s look becomes a saved style it links to, with no visual change', () => {
    const { doc, page } = ctx((d) => {
      d.pages[0].panels[2].lines[0].style = { fill: '#ffd84a', padding: 1.5 };
    });
    const ops = saveNamedStyleOps(doc, page, 'pg_1_l3', '  Villain  ', 'st_1');
    expect(ops).toEqual([
      { op: 'letter_style', patch: { named: { st_1: { name: 'Villain', patch: { fill: '#ffd84a', padding: 1.5 } } } } },
      { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l3', patch: { styleId: 'st_1' } },
      { op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l3'], patch: null }
    ]);
    const after = applyNamed(doc, ops);
    expect(namedStylesOf(after)).toEqual([{ id: 'st_1', name: 'Villain', patch: { fill: '#ffd84a', padding: 1.5 }, uses: 1 }]);
    expect(allLooks(after)).toEqual(allLooks(doc));
  });

  it('save keeps a key the speaker’s patch also sets on the line, so the cascade still draws it the same', () => {
    const { doc, page } = ctx((d) => {
      d.pages[0].panels[2].lines[1].style = { fill: '#ffd84a', borderWidth: 3 };
      d.letterStyle = { presetId: 'classic', speakers: { ch_arjun: { borderWidth: 1 } } };
    });
    const ops = saveNamedStyleOps(doc, page, 'pg_1_l4', 'Cop', 'st_c');
    expect(ops[2]).toEqual({ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4'], patch: { borderWidth: 3 }, mode: 'replace' });
    expect(allLooks(applyNamed(doc, ops))).toEqual(allLooks(doc));
  });

  it('rename and duplicate keep names unique and short', () => {
    const { doc } = withStyles();
    expect(renameNamedStyleOps(doc, 'st_v', 'Big villain')).toEqual([{ op: 'letter_style', patch: { named: { st_v: { name: 'Big villain', patch: doc.letterStyle!.named!.st_v.patch } } } }]);
    expect(renameNamedStyleOps(doc, 'st_v', 'Villain')).toEqual([]);
    const dup = duplicateNamedStyleOps(doc, 'st_v', 'st_w');
    expect(dup).toEqual([{ op: 'letter_style', patch: { named: { st_w: { name: 'Villain copy', patch: { textColor: '#e63946', borderWidth: 2.5, fill: '#fff6c8' } } } } }]);
    expect(uniqueStyleName(applyNamed(doc, dup), 'Villain copy')).toBe('Villain copy 2');
    expect(cleanStyleName(`  ${'x'.repeat(60)}  `)).toHaveLength(40);
  });

  it('delete folds the style back into its lines: same look, unlinked, style gone — one undo entry', () => {
    const { doc } = withStyles();
    const before = allLooks(doc);
    const ops = deleteNamedStyleOps(doc, 'st_v');
    expect(ops).toEqual([
      // l3 had no own style: the whole saved look folds in.
      { op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l3'], patch: { textColor: '#e63946', borderWidth: 2.5, fill: '#fff6c8' }, mode: 'replace' },
      { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l3', patch: { styleId: null } },
      // l4: its own colour and its speaker's border already decide those keys; only the fill folds in.
      { op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l4'], patch: { textColor: '#111111', fill: '#fff6c8' }, mode: 'replace' },
      { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l4', patch: { styleId: null } },
      { op: 'letter_style', patch: { named: { st_v: null } } }
    ]);
    const after = applyNamed(doc, ops);
    expect(namedStylesOf(after)).toEqual([]);
    expect(allLooks(after)).toEqual(before);
    expect(foldedStyleOf(doc, findLineRef(doc.pages[0], 'pg_1_l1')!.line, 'st_v')).toBeUndefined();
  });

  it('use links the selection; update-from-balloon restyles every line using the style (linked)', () => {
    const { doc, page } = withStyles();
    expect(useNamedStyleOps(doc, page, ['pg_1_l4', 'pg_1_l5'], 'st_v')).toEqual([{ op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l5', patch: { styleId: 'st_v' } }]);
    expect(useNamedStyleOps(doc, page, ['pg_1_l5'], 'st_missing')).toEqual([]);
    const ops = redefineNamedStyleOps(doc, page, 'pg_1_l4');
    const after = applyNamed(doc, ops);
    const l3 = findLineRef(after.pages[0], 'pg_1_l3')!.line;
    expect(looks(after, l3).textColor).toBe('#111111');
    expect(findLineRef(after.pages[0], 'pg_1_l4')!.line.style).toBeUndefined();
  });

  it('saving stops at the cap (PRO_LETTER_LIMITS.namedStyles)', () => {
    const { doc, page } = ctx((d) => {
      d.letterStyle = { presetId: 'classic', named: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`st_${i}`, { name: `S${i}`, patch: {} }])) };
    });
    expect(saveNamedStyleOps(doc, page, 'pg_1_l3', 'One more', 'st_x')).toEqual([]);
    expect(duplicateNamedStyleOps(doc, 'st_0', 'st_y')).toEqual([]);
  });
});

describe('Duplicate while Pro fields are not writable (collisions C-9)', () => {
  it('keepLink false drops the saved-style link and clean filters the copied style; omitted, the copy is whole', () => {
    const { page, placements } = ctx((d) => {
      const line = d.pages[0].panels[2].lines[1];
      line.styleId = 'st_v';
      line.style = { fill: '#ffd84a', glow: { color: '#ffffff', size: 0.2 } };
    });
    const whole = duplicateLineOps(page, 'pg_1_l4', placements.balloons, 'ln_copy');
    expect(whole[0]).toMatchObject({ op: 'line', id: 'ln_copy', patch: { styleId: 'st_v', style: { fill: '#ffd84a', glow: { color: '#ffffff', size: 0.2 } } } });
    const clean = duplicateLineOps(page, 'pg_1_l4', placements.balloons, 'ln_copy', { keepLink: false, clean: stripProFields });
    expect(clean[0].op === 'line' && clean[0].patch).toMatchObject({ kind: 'speech', style: { fill: '#ffd84a' } });
    expect(clean[0].op === 'line' && 'styleId' in clean[0].patch).toBe(false);
    // Nothing left to copy: no style key at all.
    const bare = duplicateLineOps(page, 'pg_1_l4', placements.balloons, 'ln_copy', { keepLink: false, clean: () => undefined });
    expect(bare[0].op === 'line' && 'style' in bare[0].patch).toBe(false);
    // The balloon beside it is the same either way.
    expect(clean.slice(1)).toEqual(whole.slice(1));
  });
});

describe('Layers restack (zOrderEdit within the lettering band) and moves (line_move)', () => {
  it('a balloon dragged onto one drawn in front of it lands just in front of it: one balloon {z} op', () => {
    const { doc, page, plans, placements } = ctx();
    const r = restackEdit(doc, page, plans, 'pg_1_l3', 'pg_1_l5', placements.balloons);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.ops).toEqual([{ op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l3', patch: { z: 1 } }]);
    expect(r.label).toMatch(/^Bring forward: /);
    const next = applyNamed(doc, r.ops);
    const order = sceneFor(next, next.pages[0], plans).objects.filter((o) => o.kind === 'balloon').map((o) => o.id);
    expect(order.indexOf('pg_1_l3')).toBeGreaterThan(order.indexOf('pg_1_l5'));
    expect(r.undo).toEqual(inverseOps(doc, r.ops));
  });

  it('dragged onto one behind it, it lands just behind it; a software-placed line is stored whole', () => {
    const { doc, page, plans, placements } = ctx();
    const back = restackEdit(doc, page, plans, 'pg_1_l5', 'pg_1_l1', placements.balloons);
    expect(back.ok && back.ops).toEqual([{ op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l5', patch: { z: -1 } }]);
    const loose = restackEdit(doc, page, plans, 'pg_1_l4', 'pg_1_l5', placements.balloons);
    expect(loose.ok).toBe(true);
    if (!loose.ok) return;
    const b = placements.balloons.get('pg_1_l4')!;
    expect(loose.ops[0]).toMatchObject({ op: 'balloon', lineId: 'pg_1_l4', patch: { x: b.x, y: b.y, w: b.w, z: 1 } });
  });

  it('a drag to another panel is a line_move to that place (its translations travel with it)', () => {
    const { page } = ctx();
    expect(moveLineToPanelOps(page, 'pg_1_l4', 'pg_1_p1', 1)[0]).toEqual({ op: 'line_move', pageId: 'pg_1', id: 'pg_1_l4', toPanelId: 'pg_1_p1', index: 1 });
    expect(moveLineToPanelOps(page, 'pg_1_l4', 'pg_1_p1', 99)[0]).toMatchObject({ index: 1 });
  });
});
