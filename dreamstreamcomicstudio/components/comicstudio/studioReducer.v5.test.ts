// studioReducer v5 (P1-CLIENTSTATE): ops origin/label, the director undo inbox, server_ops outside a
// stream, coded errors, saved-by-software amounts, activity cost badges, and every new DocOp
// (applied through the shared applyOps, routed to the right board tab, echo-recognized).

import { describe, expect, it } from 'vitest';
import type { DocOp } from '../../shared/comic/ops';
import { applyOps } from '../../shared/comic/ops';
import type { StudioEvent } from '../../shared/comic/events';
import { normalizeDoc, type ComicDoc } from '../../shared/comic/doc';
import { initialStudioState, isEchoOf, studioReducer, tabForOps, type StudioReducerAction, type StudioState } from './studioReducer';
import { makeSampleDoc } from './board/__fixtures__/sampleDoc';
import { comparable } from './useUndo.testkit';

const T = 1_760_000_100_000;
const run = (state: StudioState, ...actions: StudioReducerAction[]) => actions.reduce(studioReducer, state);
const sample = (): ComicDoc => normalizeDoc(makeSampleDoc());
const loaded = (doc = sample()) => run(initialStudioState(), { type: 'load_success', doc, urls: {}, now: T });
const ev = (streamId: string, event: StudioEvent): StudioReducerAction => ({ type: 'stream_event', streamId, event, now: T });
const start = (streamId: string): StudioReducerAction => ({ type: 'stream_start', streamId, kind: 'message', now: T });

/** Every v5 client-patchable op, valid against the board sample doc. */
const V5_OPS: DocOp[] = [
  { op: 'letter_style', patch: { presetId: 'manga' } },
  { op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l3'], patch: { shape: 'jagged' } },
  { op: 'pages_reorder', order: ['pg_2', 'pg_1'] },
  { op: 'page_insert', id: 'pg_new', after: 1, patch: { summary: 'A new beat' } },
  { op: 'page_duplicate', id: 'pg_2', newId: 'pg_dup', after: 2 },
  { op: 'page_delete', id: 'pg_6', deletedAt: T },
  { op: 'page_restore', id: 'pg_6' },
  { op: 'book', patch: { titlePage: true } },
  { op: 'reader', patch: { ambient: false } },
  { op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'u/proj/pages/p1.png.old', at: T },
  { op: 'version_star', path: 'u/proj/pages/p1.png', starred: true },
  { op: 'ref_add', owner: { kind: 'character', id: 'ch_arjun' }, ref: { path: 'u/proj/refs/arjun.jpg', source: 'upload', at: T } },
  { op: 'ref_patch', owner: { kind: 'character', id: 'ch_arjun' }, path: 'u/proj/refs/arjun.jpg', patch: { label: 'face' } },
  { op: 'ref_move', owner: { kind: 'character', id: 'ch_maya' }, path: 'u/proj/refs/maya.jpg', to: 0 },
  { op: 'ref_transfer', from: { kind: 'character', id: 'ch_arjun' }, to: { kind: 'style' }, path: 'u/proj/refs/arjun.jpg' },
  { op: 'ref_remove', owner: { kind: 'style' }, path: 'u/proj/refs/arjun.jpg' },
  { op: 'edition', lang: 'hi', patch: {} },
  { op: 'translation', lang: 'hi', lineId: 'pg_1_l2', patch: { text: 'बस एक और…', status: 'edited', sourceHash: 'x', at: T } },
  { op: 'edition_text', lang: 'hi', field: 'cover.title', value: { text: 'केसर चोर', status: 'edited', sourceHash: 't', at: T } },
  { op: 'edition_balloon', lang: 'hi', lineId: 'pg_1_l2', patch: { x: 0.1 } },
  { op: 'glossary_term', id: 'g_maya', patch: { term: 'Maya', kind: 'character', forms: { hi: 'माया' } } }
];

describe('ops origin and label', () => {
  it('queues a director batch with the exact base it applied to; user/job batches are not queued', () => {
    const s0 = run(loaded(), start('s1'));
    const base = s0.base!;
    const ops: DocOp[] = [{ op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l3'], patch: { fill: '#e63946' } }];
    const s1 = run(s0, ev('s1', { type: 'ops', rev: base.rev + 1, ops, origin: 'director', label: 'Red shouts' }));
    expect(s1.undoInbox).toHaveLength(1);
    expect(s1.undoInbox[0].before).toBe(base);
    expect(s1.undoInbox[0]).toMatchObject({ rev: base.rev + 1, ops, label: 'Red shouts' });
    expect(s1.lastOps).toMatchObject({ origin: 'director', label: 'Red shouts', echo: false });

    const s2 = run(s1, ev('s1', { type: 'ops', rev: base.rev + 2, ops: [{ op: 'plan_status', status: 'approved' }], origin: 'job' }));
    const s3 = run(s2, ev('s1', { type: 'ops', rev: base.rev + 3, ops: [{ op: 'plan_status', status: 'draft' }], origin: 'user' }));
    expect(s3.undoInbox).toHaveLength(1);
    // Our own edit coming back never moves the board.
    expect(s3.lastOps?.echo).toBe(true);

    const drained = run(s3, { type: 'undo_inbox_drain', upToRev: base.rev + 1 });
    expect(drained.undoInbox).toHaveLength(0);
    expect(run(drained, { type: 'undo_inbox_drain', upToRev: 99 })).toBe(drained);
  });

  it('a duplicate or out-of-order director batch is not queued twice; load_start clears the inbox', () => {
    const s0 = run(loaded(), start('s1'), start('s2'));
    const rev = s0.base!.rev + 1;
    const e: StudioEvent = { type: 'ops', rev, ops: [{ op: 'plan_status', status: 'approved' }], origin: 'director' };
    const s1 = run(s0, ev('s1', e), ev('s2', e));
    expect(s1.undoInbox).toHaveLength(1);
    const gap = run(s1, ev('s1', { ...e, rev: rev + 5 }));
    expect(gap.undoInbox).toHaveLength(1);
    expect(run(s1, { type: 'load_start' }).undoInbox).toHaveLength(0);
  });

  it('applying the director batch then the queued inverse restores the exact previous doc', async () => {
    const { makeUndoEntry } = await import('./useUndo');
    const s0 = run(loaded(), start('s1'));
    const before = s0.base!;
    const ops: DocOp[] = [
      { op: 'letter_style', patch: { presetId: 'noir', keepOverrides: false } },
      { op: 'balloon', pageId: 'pg_1', lineId: 'pg_1_l3', patch: { x: 0.3, y: 0.1 } },
      { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l3', patch: { text: 'THIEF!!', style: { shape: 'burst' } } }
    ];
    const s1 = run(s0, ev('s1', { type: 'ops', rev: before.rev + 1, ops, origin: 'director' }));
    const batch = s1.undoInbox[0];
    const entry = makeUndoEntry(batch.before, batch.ops, { origin: 'director', at: 1 })!;
    expect(comparable(applyOps(s1.base!, entry.inverse, 0))).toEqual(comparable({ ...before, rev: s1.base!.rev }));
  });
});

describe('server_ops (outside a stream)', () => {
  it('applies with the revision guard; a gap schedules a refetch', () => {
    const s0 = loaded();
    const rev = s0.base!.rev;
    const ref = { path: 'u/proj/ref/new.webp', source: 'upload' as const, at: T };
    const s1 = run(s0, { type: 'server_ops', rev: rev + 1, ops: [{ op: 'ref_add', owner: { kind: 'inbox' }, ref }], origin: 'user', now: T });
    expect(s1.base!.rev).toBe(rev + 1);
    expect(s1.doc!.refInbox?.map((r) => r.path)).toContain(ref.path);
    // Duplicate (a stream delivered it too): ignored.
    expect(run(s1, { type: 'server_ops', rev: rev + 1, ops: [{ op: 'plan_status', status: 'approved' }], now: T })).toBe(s1);
    const gap = run(s1, { type: 'server_ops', rev: rev + 3, ops: [{ op: 'plan_status', status: 'approved' }], now: T });
    expect(gap.behindRev).toBe(rev + 3);
    expect(gap.base!.rev).toBe(rev + 1);
  });
});

describe('every new op', () => {
  it('applies through the shared applyOps exactly as the server does', () => {
    let state = run(loaded(), start('s1'));
    let expected = state.base!;
    V5_OPS.forEach((op, i) => {
      state = run(state, ev('s1', { type: 'ops', rev: state.base!.rev + 1, ops: [op] }));
      expected = { ...applyOps(expected, [op], T), rev: expected.rev + 1 };
      expect(comparable(state.base!), `after ${op.op} (#${i})`).toEqual(comparable(expected));
    });
    // Sanity: the ops really changed the doc.
    expect(state.base!.i18n?.editions.hi?.lines.pg_1_l2?.text).toBe('बस एक और…');
    expect(state.base!.pages.some((p) => p.id === 'pg_dup')).toBe(true);
  });

  it('routes each new op to its board tab (or none)', () => {
    const tab = (op: DocOp) => tabForOps([op]);
    const byOp = Object.fromEntries(V5_OPS.map((op) => [op.op, tab(op)]));
    expect(byOp).toMatchObject({
      letter_style: 'pages',
      line_style: 'pages',
      pages_reorder: 'pages',
      page_insert: 'pages',
      page_duplicate: 'pages',
      page_delete: 'pages',
      page_restore: 'pages',
      book: 'pages',
      reader: null,
      render_use: 'pages',
      version_star: null,
      ref_add: 'cast',
      ref_patch: 'cast',
      ref_move: 'cast',
      ref_transfer: 'style',
      ref_remove: 'style',
      edition: 'languages',
      translation: 'languages',
      edition_text: 'languages',
      edition_balloon: 'languages',
      glossary_term: 'languages'
    });
    expect(tab({ op: 'ref_add', owner: { kind: 'inbox' }, ref: { path: 'x', source: 'upload', at: 1 } })).toBeNull();
    expect(tab({ op: 'render_use', target: { kind: 'sheet', id: 'ch_maya' }, path: 'x', at: 1 })).toBe('cast');
    expect(tab({ op: 'asset_meta', path: 'x', patch: {} })).toBeNull();
    expect(tab({ op: 'publication', value: null })).toBeNull();
    expect(tab({ op: 'translations', lang: 'hi', lines: {} })).toBe('languages');
  });

  it('recognizes the echo of new-op patches by their identifying fields', () => {
    const mine = [{ id: 'p1', ops: [{ op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'a.png', at: 1 } as DocOp] }];
    expect(isEchoOf([{ op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'a.png', at: 999 }], mine)).toBe(true);
    expect(isEchoOf([{ op: 'render_use', target: { kind: 'page', id: 'pg_2' }, path: 'a.png', at: 1 }], mine)).toBe(false);
    const refs = [{ id: 'p2', ops: [{ op: 'ref_remove', owner: { kind: 'character', id: 'c1' }, path: 'r.png' } as DocOp] }];
    expect(isEchoOf([{ op: 'ref_remove', owner: { kind: 'character', id: 'c2' }, path: 'r.png' }], refs)).toBe(false);
    const styles = [{ id: 'p3', ops: [{ op: 'line_style', pageId: 'pg_1', lineIds: ['a', 'b'], patch: { fill: '#fff' } } as DocOp] }];
    expect(isEchoOf([{ op: 'line_style', pageId: 'pg_1', lineIds: ['a', 'b'], patch: { fill: '#ffffff' } }], styles)).toBe(true);
  });
});

describe('errors, savings and activity', () => {
  it('keeps the server code of a stream error and clears it with the error', () => {
    const s = run(loaded(), start('s1'), ev('s1', { type: 'error', message: "Let's take a short break.", code: 'COOLDOWN' }));
    expect(s.error).toBe("Let's take a short break.");
    expect(s.errorCode).toBe('COOLDOWN');
    expect(run(s, { type: 'set_error', message: null }).errorCode).toBeNull();
    const t = run(loaded(), start('s2'), { type: 'stream_end', streamId: 's2', error: 'Lots of requests at once.', code: 'RATE_LIMIT', now: T });
    expect(t.errorCode).toBe('RATE_LIMIT');
    const u = run(loaded(), { type: 'patch_local', patch: { id: 'p', ops: [] }, now: T }, { type: 'patch_settled', ids: ['p'], error: "Couldn't save.", code: 'CONTENT_POLICY', now: T });
    expect(u.errorCode).toBe('CONTENT_POLICY');
  });

  it('records what the software saved in the last turn', () => {
    const s = run(loaded(), start('s1'), ev('s1', { type: 'done', rev: 12, spentUsd: 0, savedUsd: 0.13 }));
    expect(s.lastSavedUsd).toBe(0.13);
    expect(run(s, ev('s1', { type: 'done', rev: 12, spentUsd: 0.05 })).lastSavedUsd).toBeNull();
  });

  it('keeps the activity cost badge', () => {
    const s = run(
      loaded(),
      start('s1'),
      ev('s1', { type: 'activity', id: 'a1', label: 'Lettering page 1', phase: 'start', cost: 'free' }),
      ev('s1', { type: 'activity', id: 'a2', label: 'Drawing page 2', phase: 'start', cost: 'image' })
    );
    expect(s.activity.map((a) => a.cost)).toEqual(['free', 'image']);
  });
});
