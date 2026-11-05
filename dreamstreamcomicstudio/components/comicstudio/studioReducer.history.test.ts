// studioReducer × Comic History (versions plan §6.1, §11; H0): an op this build does not know triggers a refetch; a
// `history_restore` batch applies exactly like the server (parity through the wire) and resets the undo inbox; the
// `history` event feeds an open panel and resyncs after a restore or a switch.
import { describe, expect, it } from 'vitest';
import { normalizeDoc, type ComicDoc } from '../../shared/comic/doc';
import { applyOps, type DocOp } from '../../shared/comic/ops';
import { encodeStudioEvent, type StudioEvent } from '../../shared/comic/events';
import { historyV5Doc } from '../../shared/comic/history/__fixtures__/books';
import { evolveBook } from '../../shared/comic/history/__fixtures__/random';
import { historyRestoreOp, restoreOps } from '../../shared/comic/history/restore';
import { excludedOf, joinSections, splitSections } from '../../shared/comic/history/sections';
import type { VersionRow } from '../../shared/comic/history/types';
import { initialStudioState, needsRefresh, studioReducer, type StudioState } from './studioReducer';

const NOW = 1_761_800_000_000;

const loaded = (doc: ComicDoc): StudioState => {
  let s = studioReducer(initialStudioState(), { type: 'load_success', doc, now: NOW });
  s = studioReducer(s, { type: 'stream_start', streamId: 's1', kind: 'message', now: NOW });
  return s;
};
const event = (s: StudioState, e: StudioEvent): StudioState => studioReducer(s, { type: 'stream_event', streamId: 's1', event: e, now: NOW });
/** What the client receives: the server's event through encodeStudioEvent + JSON.parse. */
const wire = (e: StudioEvent): StudioEvent => JSON.parse(encodeStudioEvent(e)) as StudioEvent;

const row = (kind: VersionRow['kind']): VersionRow => ({
  id: 'ver_1', kind, actor: 'you', label: 'x', pinned: false, rev: 4, contentAt: NOW, createdAt: NOW, codec: 'v5', changes: [], thumbs: [], stats: { pages: 1, drawn: 0, lines: 0, langs: [], models: [] }
});

describe('unknown ops', () => {
  it('an op this client does not know triggers a refetch (and the known ops still apply)', () => {
    const doc = normalizeDoc(historyV5Doc());
    const s0 = loaded(doc);
    expect(needsRefresh(s0)).toBe(false);
    const ops = [{ op: 'panel_frames', pageId: 'pg_1', frames: [] } as unknown as DocOp, { op: 'brief', patch: { title: 'Known op' } } as DocOp];
    const s1 = event(s0, wire({ type: 'ops', rev: doc.rev + 1, ops, origin: 'user' }));
    expect(s1.base!.brief.title).toBe('Known op');
    expect(s1.hardRefresh).toBe(true);
    expect(needsRefresh(s1)).toBe(true);
  });

  it('known ops alone never refetch (history_restore included)', () => {
    const doc = normalizeDoc(historyV5Doc());
    const s1 = event(loaded(doc), wire({ type: 'ops', rev: doc.rev + 1, ops: [{ op: 'brief', patch: { title: 'x' } }], origin: 'user' }));
    expect(needsRefresh(s1)).toBe(false);
  });
});

describe('history_restore on the client', () => {
  it('applies identically to the server (parity through the wire) and resets the undo inbox', () => {
    const version = joinSections(splitSections(normalizeDoc(historyV5Doc())), excludedOf(normalizeDoc(historyV5Doc())));
    const current = evolveBook(normalizeDoc(historyV5Doc()), 5, 30);
    const op = historyRestoreOp(restoreOps(current, version, { kind: 'book' }), { versionId: 'ver_1', at: NOW });
    // A director batch is waiting in the undo inbox when the restore lands.
    let s = loaded(current);
    s = event(s, wire({ type: 'ops', rev: current.rev + 1, ops: [{ op: 'brief', patch: { logline: 'director' } }], origin: 'director' }));
    expect(s.undoInbox).toHaveLength(1);
    const before = s.base!;
    s = event(s, wire({ type: 'ops', rev: current.rev + 2, ops: [op], origin: 'user', label: 'Restore the book' }));
    const server = { ...applyOps(before, [op], NOW), rev: current.rev + 2 };
    expect(JSON.parse(JSON.stringify(s.base))).toEqual(JSON.parse(JSON.stringify(server)));
    expect(s.historyRestoreRev).toBe(current.rev + 2);
    expect(s.undoInbox).toEqual([]);
    expect(needsRefresh(s)).toBe(false);
  });
});

describe('AI changes the local undo stack cannot invert', () => {
  it('a job render or a server-only director batch marks aiChangeAt; a user edit or a reversible director edit does not', () => {
    const doc = normalizeDoc(historyV5Doc());
    let s = loaded(doc);
    s = event(s, wire({ type: 'ops', rev: doc.rev + 1, ops: [{ op: 'brief', patch: { title: 'mine' } }], origin: 'user' }));
    s = event(s, wire({ type: 'ops', rev: doc.rev + 2, ops: [{ op: 'brief', patch: { tone: 'dark' } }], origin: 'director' }));
    expect(s.aiChangeAt).toBeUndefined();
    s = event(s, wire({ type: 'ops', rev: doc.rev + 3, ops: [{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { status: 'queued' } }], origin: 'job' }));
    expect(s.aiChangeAt).toBeUndefined(); // queued is not a change
    s = event(s, wire({ type: 'ops', rev: doc.rev + 4, ops: [{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { status: 'ready', asset: { path: 'x.webp', source: 'generated', at: 1 }, origin: 'render' } }], origin: 'job' }));
    expect(s.aiChangeAt).toBe(NOW);
  });
});

describe('the history event', () => {
  it('feeds an open History panel; only a restore or a switch resyncs the doc', () => {
    const doc = normalizeDoc(historyV5Doc());
    const s1 = event(loaded(doc), wire({ type: 'history', version: row('edits') }));
    expect(s1.lastHistoryVersion).toMatchObject({ id: 'ver_1', kind: 'edits' });
    expect(s1.syncDue).toBe(false);
    const s2 = event(loaded(doc), wire({ type: 'history', version: row('restore') }));
    expect(s2.syncDue).toBe(true);
    const ended = studioReducer(s2, { type: 'stream_end', streamId: 's1', now: NOW });
    expect(needsRefresh(ended)).toBe(true);
  });
});
