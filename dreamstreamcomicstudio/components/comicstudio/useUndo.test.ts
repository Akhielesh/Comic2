// useUndo: the pure stack (coalescing, redo, skip, rollback bookkeeping), op compaction, and the
// round-trip property every entry must satisfy: applying its inverse after its ops restores the
// exact previous doc (wire equality, R4), and redo re-creates the edited doc.

import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { applyOps, type DocOp } from '../../shared/comic/ops';
import { comparable, mulberry32, randomLetteringOp, sample } from './useUndo.testkit';
import {
  COALESCE_WINDOW_MS,
  EMPTY_UNDO,
  UNDO_LIMIT,
  compactOps,
  discardEntry,
  forgetPatches,
  isNoopOn,
  makeUndoEntry,
  normalizeUndoLabel,
  pushUndo,
  returnEntry,
  sameWire,
  sendableOps,
  takeRedo,
  takeUndo,
  useUndo,
  type UndoEntry
} from './useUndo';

const entry = (id: string, at: number, extra: Partial<UndoEntry> = {}): UndoEntry => ({
  id,
  label: `edit ${id}`,
  origin: 'user',
  forward: [{ op: 'plan_status', status: 'approved' }],
  inverse: [{ op: 'plan_status', status: 'draft' }],
  at,
  patchIds: [`p_${id}`],
  ...extra
});

// ── Round-trip property ──────────────────────────────────────────────────────

describe('makeUndoEntry round trip (inverseOps)', () => {
  it('500 random lettering batches: inverse restores the exact previous doc and redo re-applies', () => {
    const r = mulberry32(20261022);
    let doc = sample();
    for (let i = 0; i < 500; i += 1) {
      const batch = Array.from({ length: 1 + Math.floor(r() * 4) }, () => randomLetteringOp(doc, r));
      const before = doc;
      const after = applyOps(before, batch, 100 + i);
      const e = makeUndoEntry(before, batch, { origin: 'director', at: i });
      if (!e) {
        expect(comparable(after)).toEqual(comparable(before));
      } else {
        const restored = applyOps(after, e.inverse, 0);
        expect(comparable(restored)).toEqual(comparable(before));
        expect(comparable(applyOps(restored, e.forward, 0))).toEqual(comparable(after));
        // Only ops the server accepts in a client patch are ever re-sent.
        expect(e.inverse.every((op) => op.op !== 'translations')).toBe(true);
      }
      doc = after;
    }
  });

  it('a director batch mixing server-only ops undoes only its patchable subset', () => {
    const before = sample();
    const batch: DocOp[] = [
      { op: 'message', msg: { id: 'm1', role: 'assistant', text: 'Made the shouts red.', at: 1 } },
      { op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l3'], patch: { fill: '#e63946', shape: 'jagged' } },
      { op: 'spend', entry: { id: 's1', at: 1, kind: 'chat', label: 'Director', usd: 0.001, byok: false, estimated: false } }
    ];
    const after = applyOps(before, batch, 2);
    const e = makeUndoEntry(before, batch, { origin: 'director', label: 'Make the shouting bubbles red', at: 1 })!;
    expect(e.forward.map((o) => o.op)).toEqual(['line_style']);
    expect(e.label).toBe('make the shouting bubbles red');
    const restored = applyOps(after, e.inverse, 0);
    // Lettering is back exactly; the message and the spend stay (they are history, not edits).
    expect(comparable({ ...restored, conversation: before.conversation, spend: before.spend })).toEqual(comparable(before));
    expect(restored.conversation).toHaveLength(before.conversation.length + 1);
  });

  it('returns null when nothing undoable changed', () => {
    const doc = sample();
    expect(makeUndoEntry(doc, [{ op: 'message', msg: { id: 'm', role: 'assistant', text: 'hi', at: 1 } }], { origin: 'director', at: 1 })).toBeNull();
    expect(makeUndoEntry(doc, [], { origin: 'user', at: 1 })).toBeNull();
  });
});

// ── Stack ────────────────────────────────────────────────────────────────────

describe('pushUndo / takeUndo / takeRedo', () => {
  it('coalesces same-key edits within 600 ms into one entry that undoes all of them', () => {
    const before = sample();
    let doc = before;
    let stacks = EMPTY_UNDO;
    // A drag: 5 moves of the same balloon, 100 ms apart.
    for (let i = 0; i < 5; i += 1) {
      const ops: DocOp[] = [{ op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l2', patch: { x: 0.1 + i * 0.1, y: 0.2 } }];
      stacks = pushUndo(stacks, makeUndoEntry(doc, ops, { origin: 'user', coalesce: 'balloon:pg_1:pg_1_l2', at: 1000 + i * 100, label: 'Move balloon' })!);
      doc = applyOps(doc, ops, 0);
    }
    expect(stacks.undo).toHaveLength(1);
    const top = stacks.undo[0];
    expect(top.label).toBe('move balloon');
    // Compacted: one forward op and one inverse op however long the drag was.
    expect(top.forward).toHaveLength(1);
    expect(top.inverse).toHaveLength(1);
    expect(comparable(applyOps(doc, top.inverse, 0))).toEqual(comparable(before));
  });

  it('does not coalesce across the window or across keys', () => {
    let s = pushUndo(EMPTY_UNDO, entry('a', 1000, { coalesce: 'k' }));
    s = pushUndo(s, entry('b', 1000 + COALESCE_WINDOW_MS + 1, { coalesce: 'k' }));
    expect(s.undo.map((e) => e.id)).toEqual(['a', 'b']);
    s = pushUndo(s, entry('c', s.undo[1].at + 10, { coalesce: 'other' }));
    expect(s.undo.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('merges every director batch of one reply (same group), whatever the timing', () => {
    let s = pushUndo(EMPTY_UNDO, entry('a', 1000, { origin: 'director', group: 'reply:s1', label: 'restyle 2 balloons', patchIds: [] }));
    s = pushUndo(s, entry('b', 9000, { origin: 'director', group: 'reply:s1', label: 'reorder pages', patchIds: [], rev: 14 }));
    expect(s.undo).toHaveLength(1);
    expect(s.undo[0]).toMatchObject({ id: 'a', label: 'restyle 2 balloons, reorder pages', rev: 14 });
    s = pushUndo(s, entry('c', 9500, { origin: 'director', group: 'reply:s2', patchIds: [] }));
    expect(s.undo.map((e) => e.id)).toEqual(['a', 'c']);
  });

  it('caps the stack at 100 entries (oldest dropped) and a new edit clears redo', () => {
    let s = EMPTY_UNDO;
    for (let i = 0; i < UNDO_LIMIT + 5; i += 1) s = pushUndo(s, entry(`e${i}`, i * 1000));
    expect(s.undo).toHaveLength(UNDO_LIMIT);
    expect(s.undo[0].id).toBe('e5');
    const t = takeUndo(s);
    expect(t.entry?.id).toBe(`e${UNDO_LIMIT + 4}`);
    expect(t.stacks.redo).toHaveLength(1);
    expect(pushUndo(t.stacks, entry('new', 1e9)).redo).toHaveLength(0);
  });

  it('undo moves to redo and redo moves back', () => {
    let s = pushUndo(pushUndo(EMPTY_UNDO, entry('a', 1)), entry('b', 2000));
    const u = takeUndo(s);
    expect(u.entry?.id).toBe('b');
    s = u.stacks;
    expect(s.undo.map((e) => e.id)).toEqual(['a']);
    expect(s.redo.map((e) => e.id)).toEqual(['b']);
    const r = takeRedo(s);
    expect(r.entry?.id).toBe('b');
    expect(r.stacks.undo.map((e) => e.id)).toEqual(['a', 'b']);
    expect(r.stacks.redo).toHaveLength(0);
    expect(takeRedo(r.stacks).entry).toBeNull();
  });

  it('skips (drops) entries that are no longer usable', () => {
    const s = pushUndo(pushUndo(EMPTY_UNDO, entry('a', 1)), entry('b', 2000));
    const u = takeUndo(s, (e) => e.id !== 'b');
    expect(u.entry?.id).toBe('a');
    expect(u.skipped).toBe(1);
    expect(u.stacks.undo).toHaveLength(0);
    expect(u.stacks.redo.map((e) => e.id)).toEqual(['a']);
  });

  it('returnEntry, discardEntry and forgetPatches keep the bookkeeping honest', () => {
    const s = pushUndo(pushUndo(EMPTY_UNDO, entry('a', 1)), entry('b', 2000));
    const u = takeUndo(s);
    // The undo failed to save: back where it was.
    expect(returnEntry(u.stacks, u.entry!, 'undo').undo.map((e) => e.id)).toEqual(['a', 'b']);
    expect(returnEntry(u.stacks, u.entry!, 'undo').redo).toHaveLength(0);
    expect(discardEntry(u.stacks, 'b').redo).toHaveLength(0);
    // A rejected save removes its entry; director entries (no patch ids) are never forgotten.
    const withDirector = pushUndo(s, entry('d', 3000, { origin: 'director', patchIds: [] }));
    expect(forgetPatches(withDirector, ['p_a', 'p_d']).undo.map((e) => e.id)).toEqual(['b', 'd']);
    expect(forgetPatches(withDirector, [])).toBe(withDirector);
  });
});

// ── Op helpers ───────────────────────────────────────────────────────────────

describe('op helpers', () => {
  it('compactOps merges only adjacent ops on the same target, exactly', () => {
    const doc = sample();
    const ops: DocOp[] = [
      { op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l1', patch: { x: 0.2 } },
      { op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l1', patch: { y: 0.3 } },
      { op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l2', patch: { x: 0.4 } },
      { op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l1', patch: { x: 0.5 } },
      { op: 'page', id: 'pg_2', patch: { summary: 'a' } },
      { op: 'page', id: 'pg_2', patch: { layout: 'b' } },
      { op: 'balloons', pageId: 'pg_1', balloons: [] },
      { op: 'balloons', pageId: 'pg_1', balloons: doc.pages[0].balloons },
      { op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l1', patch: { locked: true } },
      { op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l1', patch: { locked: false } }
    ];
    const compact = compactOps(ops);
    expect(compact.map((o) => o.op)).toEqual(['balloon', 'balloon', 'balloon', 'page', 'balloons', 'balloon', 'balloon']);
    expect(comparable(applyOps(doc, compact, 0))).toEqual(comparable(applyOps(doc, ops, 0)));
  });

  it('sendableOps turns server-only translations into per-line translation ops and drops other server ops', () => {
    const t = { text: 'नमस्ते', status: 'edited' as const, sourceHash: 'h', at: 1 };
    expect(
      sendableOps([
        { op: 'translations', lang: 'hi', lines: { pg_1_l1: t, pg_1_l2: t } },
        { op: 'render', target: { kind: 'cover' }, patch: { status: 'queued' } },
        { op: 'edition', lang: 'hi', patch: { register: 'everyday' } }
      ])
    ).toEqual([
      { op: 'translation', lang: 'hi', lineId: 'pg_1_l1', patch: t },
      { op: 'translation', lang: 'hi', lineId: 'pg_1_l2', patch: t },
      { op: 'edition', lang: 'hi', patch: { register: 'everyday' } }
    ]);
  });

  it('isNoopOn / sameWire treat null as unset and missing targets as no-ops', () => {
    const doc = sample();
    expect(isNoopOn(doc, [{ op: 'page_restore', id: 'nope' }])).toBe(true);
    expect(isNoopOn(doc, [{ op: 'line', pageId: 'gone', panelId: 'x', id: 'y', patch: { text: 'z' } }])).toBe(true);
    expect(isNoopOn(doc, [{ op: 'page', id: 'pg_1', patch: { chapterTitle: null as unknown as string } }])).toBe(true);
    expect(isNoopOn(doc, [{ op: 'page', id: 'pg_1', patch: { summary: 'new' } }])).toBe(false);
    expect(sameWire({ a: 1, b: null }, { a: 1 })).toBe(true);
    expect(sameWire([1, 2], [1, 2, 3])).toBe(false);
  });

  it('normalizeUndoLabel strips an Undo prefix and lowercases a capitalised word', () => {
    expect(normalizeUndoLabel('Undo: Move balloon')).toBe('move balloon');
    expect(normalizeUndoLabel('Bubble opacity')).toBe('bubble opacity');
    expect(normalizeUndoLabel('SFX colour')).toBe('SFX colour');
    expect(normalizeUndoLabel('  ')).toBeUndefined();
  });
});

// ── Hook ─────────────────────────────────────────────────────────────────────

describe('useUndo', () => {
  it('exposes labels, takes entries synchronously and clears on project switch', () => {
    const { result, rerender } = renderHook(({ id }) => useUndo(id), { initialProps: { id: 'p1' } });
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.record(entry('a', 1)));
    expect(result.current.canUndo).toBe(true);
    expect(result.current.undoLabel).toBe('edit a');
    let taken: UndoEntry | null = null;
    act(() => {
      taken = result.current.takeUndo();
    });
    expect(taken!.id).toBe('a');
    expect(result.current.canRedo).toBe(true);
    expect(result.current.redoLabel).toBe('edit a');
    act(() => result.current.record(null));
    rerender({ id: 'p2' });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(result.current.stacks()).toBe(EMPTY_UNDO);
  });
});
