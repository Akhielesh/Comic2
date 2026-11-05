// Synthetic Comic History fixtures for the History UI's tests and QA scenes (package H5). SYNTHETIC ONLY: built on
// the H0 book fixtures (shared/comic/history/__fixtures__/books.ts) — invented ids, paths and lines, no real user's
// data. Each fixture is a live book, its moments (rows newest first) and the book each moment holds.
//
//   v5       a v5 comic with a week of History: your edit, an AI revision (and the moment before it), an AI drawing
//            run on your own key, a named "Draft 2", Published, and "History starts here"
//   v5-conflict  the same, but you also changed page 3 after the AI revised it (undo-AI asks first)
//   v4       an older comic: History started today; its drawings before that are "Earlier (images only)"
//   empty    a brand-new comic: nothing saved yet
//   classic  a comic brought in from a classic project: "Classic snapshots (3)"

import { normalizeDoc, type ComicDoc, type Line } from '../../../../shared/comic/doc';
import { BOOK_NOW, historyEmptyDoc, historyV4Doc, historyV5Doc } from '../../../../shared/comic/history/__fixtures__/books';
import type { ChangeItem, VersionRow } from '../../../../shared/comic/history/types';
import type { ClassicSnapshotRow } from '../historyApi';

export const HISTORY_NOW = BOOK_NOW;
export const HISTORY_TZ = 'Asia/Kolkata';
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export type HistoryFixtureName = 'v5' | 'v5-conflict' | 'v4' | 'empty' | 'classic';
export const HISTORY_FIXTURES: readonly HistoryFixtureName[] = ['v5', 'v5-conflict', 'v4', 'empty', 'classic'];

export interface HistoryFixture {
  live: ComicDoc;
  versions: { row: VersionRow; doc: ComicDoc }[];
  classic?: ClassicSnapshotRow[];
}

const clone = (d: ComicDoc): ComicDoc => JSON.parse(JSON.stringify(d)) as ComicDoc;
const lineOf = (doc: ComicDoc, lineId: string): Line | undefined => doc.pages.flatMap((p) => p.panels.flatMap((x) => x.lines)).find((l) => l.id === lineId);
const setText = (doc: ComicDoc, lineId: string, text: string) => {
  const l = lineOf(doc, lineId);
  if (l) l.text = text;
};

/** The book the AI revised (pages 3–4 reworded, page 3 redrawn) — and, before it, page 6 did not exist yet. */
const beforeAiDoc = (): ComicDoc => {
  const d = historyV5Doc();
  setText(d, 'pg_3_l3', 'You owe me the truth, Maya (3).');
  setText(d, 'pg_4_l3', 'You owe me the truth, Maya (4).');
  const p3 = d.pages[2];
  p3.render = { ...p3.render, asset: { ...p3.render.asset!, path: p3.render.asset!.path.replace('/p3.webp', '/p3-then.webp'), at: BOOK_NOW - 3 * HOUR } };
  d.pages = d.pages.filter((p) => p.id !== 'pg_6');
  const te = d.i18n?.editions.te;
  if (te?.lines.pg_1_l1) te.lines.pg_1_l1 = { ...te.lines.pg_1_l1, text: 'పాత తెల్లవారు 1.' };
  return normalizeDoc(d);
};

/** The AI's result (the H0 v5 book as it is). */
const aiDoc = (): ComicDoc => normalizeDoc(historyV5Doc());

/** Now: the AI's result plus your edit on page 2 (and, for the conflict fixture, on page 3 too). */
const liveDoc = (conflict = false): ComicDoc => {
  const d = clone(aiDoc());
  setText(d, 'pg_2_l2', 'Just one more tin, 2…');
  if (conflict) setText(d, 'pg_3_l4', 'GRAB!!');
  d.rev = 240;
  return normalizeDoc(d);
};

const thumbsOf = (doc: ComicDoc): VersionRow['thumbs'] =>
  [
    ...(doc.cover.render.asset ? [{ key: 'cover', path: doc.cover.render.asset.path }] : []),
    ...doc.pages.filter((p) => p.render.asset).map((p) => ({ key: `page:${p.id}`, path: p.render.asset!.path }))
  ].slice(0, 8);

const statsOf = (doc: ComicDoc, spend?: VersionRow['stats']['spend']): VersionRow['stats'] => ({
  pages: doc.pages.length,
  drawn: doc.pages.filter((p) => p.render.asset).length,
  lines: doc.pages.reduce((n, p) => n + p.panels.reduce((m, x) => m + x.lines.length, 0), 0),
  langs: Object.keys(doc.i18n?.editions || {}),
  models: ['nano-banana-2.1'],
  ...(spend ? { spend } : {})
});

const row = (id: string, partial: Partial<VersionRow> & Pick<VersionRow, 'kind' | 'actor' | 'label' | 'contentAt'>, doc: ComicDoc): VersionRow => ({
  id,
  pinned: false,
  rev: doc.rev,
  createdAt: partial.contentAt,
  codec: 'v5',
  changes: [],
  thumbs: thumbsOf(doc),
  stats: statsOf(doc),
  ...partial
});

const pages = (what: ChangeItem['what'], by: ChangeItem['by'], ns: number[], extra: Partial<ChangeItem> = {}): ChangeItem[] =>
  ns.map((n) => ({ what, by, key: `${what === 'art' ? 'art' : 'page'}:pg_${n}`, pageIds: [`pg_${n}`], pageNs: [n], ...extra }));

const v5Fixture = (conflict: boolean): HistoryFixture => {
  const live = liveDoc(conflict);
  const ai = aiDoc();
  const before = beforeAiDoc();
  const N = HISTORY_NOW;
  const versions = [
    { row: row('ver_edit', { kind: 'edits', actor: 'you', label: 'You edited dialogue on page 2', contentAt: N - 10 * MIN, changes: pages('dialogue', 'you', [2], { count: 1, lineIds: ['pg_2_l2'] }) }, live), doc: live },
    {
      row: row(
        'ver_ai',
        {
          kind: 'ai',
          actor: 'ai',
          label: 'AI revised pages 3–4',
          contentAt: N - 2 * HOUR,
          parentId: 'ver_before',
          changes: [...pages('dialogue', 'ai', [3, 4], { count: 1 }), ...pages('art', 'ai', [3]), ...pages('pages_added', 'ai', [6])],
          stats: statsOf(ai, { usd: 0.07, byok: false, estimated: false })
        },
        ai
      ),
      doc: ai
    },
    { row: row('ver_before', { kind: 'before_ai', actor: 'system', label: 'Before the AI revised pages 3–4', contentAt: N - 2 * HOUR - MIN }, before), doc: before },
    {
      row: row('ver_draw', { kind: 'ai', actor: 'ai', label: 'AI drew pages 1–5', contentAt: N - DAY - HOUR, changes: pages('art', 'ai', [1, 2, 3, 4, 5]), stats: statsOf(before, { usd: 0.27, byok: true, estimated: false }) }, before),
      doc: before
    },
    { row: row('ver_draft2', { kind: 'named', actor: 'you', label: 'Draft 2', name: 'Draft 2', note: 'Before the chase gets longer', pinned: true, contentAt: N - DAY - 3 * HOUR }, before), doc: before },
    { row: row('ver_pub', { kind: 'publish', actor: 'you', label: 'Published', pinned: true, publishedRev: 200, contentAt: N - 3 * DAY }, before), doc: before },
    { row: row('ver_start', { kind: 'start', actor: 'system', label: 'History starts here', pinned: true, contentAt: N - 5 * DAY }, before), doc: before }
  ];
  return { live, versions };
};

const v4Fixture = (): HistoryFixture => {
  const live = normalizeDoc(historyV4Doc());
  return { live, versions: [{ row: row('ver_start', { kind: 'start', actor: 'system', label: 'History starts here', pinned: true, contentAt: HISTORY_NOW - 30 * MIN }, live), doc: live }] };
};

const emptyFixture = (): HistoryFixture => ({ live: normalizeDoc(historyEmptyDoc()), versions: [] });

const classicFixture = (): HistoryFixture => {
  const live = normalizeDoc(historyV4Doc());
  const N = HISTORY_NOW;
  return {
    live,
    versions: [
      { row: row('ver_import', { kind: 'import', actor: 'system', label: 'Brought into the new studio', pinned: true, contentAt: N - 2 * HOUR, legacy: { projectId: 'classic_1' } }, live), doc: live },
      { row: row('ver_start', { kind: 'start', actor: 'system', label: 'History starts here', pinned: true, contentAt: N - 2 * HOUR - MIN }, live), doc: live }
    ],
    classic: [
      { id: 'snap_3', name: 'Auto - Before Restore', reason: 'auto', createdAt: N - 3 * DAY, projectId: 'classic_1', pages: 4 },
      { id: 'snap_2', name: 'After the pond scene', createdAt: N - 9 * DAY, projectId: 'classic_1', pages: 3 },
      { id: 'snap_1', name: 'First draft', createdAt: N - 30 * DAY, projectId: 'classic_1', pages: 2 }
    ]
  };
};

/** A fresh copy of a named fixture (each call builds new objects). */
export const historyFixture = (name: HistoryFixtureName): HistoryFixture => {
  switch (name) {
    case 'v5':
      return v5Fixture(false);
    case 'v5-conflict':
      return v5Fixture(true);
    case 'v4':
      return v4Fixture();
    case 'classic':
      return classicFixture();
    default:
      return emptyFixture();
  }
};
