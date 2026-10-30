// timeline/bookModel: clip view-models, versions (v1 = oldest), the media index and the op builders.
// Every number asserted here is recorded data from the doc (ledger, version meta) — never invented.
import { formatUsd } from '../../../shared/comic/models';
import { describe, expect, it } from 'vitest';
import { applyOps, applyOp } from '../../../shared/comic/ops';
import { versionList as sharedVersionList } from '../../../shared/comic/book';
import type { ArchivedVersion, ComicDoc } from '../../../shared/comic/doc';
import { makeSampleDoc } from '../conversation/testing/fixtures';
import { A, richDoc } from './__fixtures__/richDoc';
import {
  bookClips,
  collectMedia,
  dockSummary,
  downloadName,
  filterMedia,
  ghostPlates,
  groupMedia,
  hasMedia,
  mediaCounts,
  moveOps,
  renderUseOps,
  staleImpact,
  undoPlan,
  versionCostLabel,
  versionCount,
  versionList
} from './bookModel';

describe('versionList (v1 = oldest, stable across swaps)', () => {
  it('numbers current, history and archived versions by creation time with recorded meta', () => {
    const doc = richDoc();
    const list = versionList(doc, { kind: 'page', id: 'pg_1' });
    expect(list.map((v) => [v.n, v.path, v.current, v.archived])).toEqual([
      [1, 'u/x/p/p1-v1.webp', false, true],
      [2, 'u/x/p/p1-v2.webp', false, false],
      [3, 'u/x/p/p1-v3.webp', true, false]
    ]);
    expect(list[2]).toMatchObject({ modelLabel: 'Nano Banana 2.1', costUsd: 0.06, qcScore: 0.82, origin: 'render', stale: false, mismatch: false, shape: '4:5' });
    expect(list[1]).toMatchObject({ mismatch: true, shape: '1:1' });
    const swapped = applyOp(doc, renderUseOps({ kind: 'page', id: 'pg_1' }, 'u/x/p/p1-v2.webp', { now: 99 })[0]);
    expect(versionList(swapped, { kind: 'page', id: 'pg_1' }).map((v) => [v.n, v.current])).toEqual([
      [1, false],
      [2, true],
      [3, false]
    ]);
  });

  it('is honest about staleness: after a script change the current version shows out of date', () => {
    const doc = richDoc();
    doc.pages[0].panels[0] = { ...doc.pages[0].panels[0], action: 'Something else entirely' };
    expect(versionList(doc, { kind: 'page', id: 'pg_1' }).find((v) => v.current)?.stale).toBe(true);
  });

  it('cost labels never invent a number', () => {
    expect(versionCostLabel({ costUsd: 0.06 }, formatUsd)).toBe('$0.06');
    expect(versionCostLabel({ costUsd: 0.06 }, () => '≈2% of your usage')).toBe('≈2% of your usage');
    // No formatter: never dollars (governed users never see them; the caller passes the viewer's).
    expect(versionCostLabel({ costUsd: 0.06 })).toBe('uses a little of your usage');
    expect(versionCostLabel({ costUsd: 0, origin: 'derived' })).toBe('Free — done by software');
    expect(versionCostLabel({ origin: 'adopted' })).toBe('No AI cost');
    expect(versionCostLabel({})).toBe('Not recorded');
  });

  it('staleImpact lists the drawn pages a sheet version would put out of date', () => {
    const doc = richDoc();
    expect(staleImpact(doc, { kind: 'sheet', id: 'c_maya' }, 'u/x/p/maya-v1.webp')).toEqual({ pages: [1], cover: false });
    expect(staleImpact(doc, { kind: 'page', id: 'pg_1' }, 'u/x/p/p1-v2.webp').pages).toEqual([]);
  });
});

describe('clips and the dock summary', () => {
  it('cover first, pages by number, software pages where the book settings put them', () => {
    const doc = richDoc();
    expect(bookClips(doc).map((c) => c.key)).toEqual(['cover', 'pg_1', 'pg_2', 'pg_3']);
    doc.book = { titlePage: true, endPage: true, backCover: 'auto', firstPageRight: true, uniformTrim: true };
    const clips = bookClips(doc);
    expect(clips.map((c) => c.key)).toEqual(['cover', 'title', 'pg_1', 'pg_2', 'pg_3', 'end', 'back_cover']);
    expect(clips.filter((c) => c.plate).map((c) => c.kind)).toEqual(['title', 'end', 'back_cover']);
    expect(ghostPlates(doc)).toEqual([]);
  });

  it('per-clip money is the ledger’s, else the versions’ recorded costs; status, versions, mismatch', () => {
    const doc = richDoc();
    const [cover, p1, p2, p3] = bookClips(doc);
    expect(p1).toMatchObject({ versions: 3, spentUsd: 0.17, status: 'ready', mismatch: null, busy: false, qcScore: 0.82 });
    expect(p2).toMatchObject({ versions: 0, spentUsd: 0, drawn: false });
    expect(p3.status).toBe('failed');
    expect(cover).toMatchObject({ versions: 1, spentUsd: 0, drawn: true });
    doc.spend = { ...doc.spend, entries: [] };
    expect(bookClips(doc)[1].spentUsd).toBe(0.06);
    doc.pages[0].render = { ...doc.pages[0].render, asset: A('p1-sq', 31, { w: 1024, h: 1024 }) };
    expect(bookClips(doc)[1].mismatch).toEqual({ want: '4:5', got: '1:1' });
  });

  it('a duplicated page shows no spend of its own: each paid image is counted once across the book', () => {
    const doc = applyOp(richDoc(), { op: 'page_duplicate', id: 'pg_1', newId: 'pg_copy' });
    const byKey = new Map(bookClips(doc).map((c) => [c.key, c]));
    expect(byKey.get('pg_copy')).toMatchObject({ drawn: true, versions: 1, spentUsd: 0 });
    expect(byKey.get('pg_1')?.spentUsd).toBe(0.17); // the ledger's real charges stay on the original
    // Old docs without ledger targets fall back to recorded version costs — still once per image,
    // even when the copy is moved in front of the original.
    const legacy = applyOp({ ...doc, spend: { ...doc.spend, entries: [] } }, { op: 'pages_reorder', order: ['pg_copy', 'pg_1'] });
    const clips = bookClips(legacy).filter((c) => c.kind === 'page');
    expect(clips.reduce((n, c) => n + c.spentUsd, 0)).toBe(0.06);
  });

  it('ghost plates offer the disabled software pages (free toggles)', () => {
    expect(ghostPlates(richDoc()).map((g) => [g.kind, g.patch])).toEqual([
      ['title', { titlePage: true }],
      ['end', { endPage: true }],
      ['back_cover', { backCover: 'auto' }]
    ]);
  });

  it('summary uses real totals only', () => {
    expect(dockSummary(richDoc(), formatUsd)).toBe('Book · Cover ✓ · 1/3 pages drawn · 4 versions · $0.55 spent · $0.06 saved by software');
    expect(dockSummary(richDoc())).not.toMatch(/\$/);
    // Fail closed in readable words (no "uses a little of your usage spent").
    expect(dockSummary(richDoc())).toBe('Book · Cover ✓ · 1/3 pages drawn · 4 versions · some of your usage spent · a little of your usage saved by software');
    const fresh = makeSampleDoc({ pages: [], spend: { totalUsd: 0, byKind: {}, entries: [] } });
    expect(dockSummary(fresh)).toBe('Book · No cover yet · no pages yet');
  });
});

describe('op builders and undo', () => {
  it('moveOps builds a full order; same position is a no-op', () => {
    const doc = richDoc();
    expect(moveOps(doc, 'pg_3', 0)).toEqual([{ op: 'pages_reorder', order: ['pg_3', 'pg_1', 'pg_2'] }]);
    expect(moveOps(doc, 'pg_1', 0)).toEqual([]);
    expect(moveOps(doc, 'nope', 1)).toEqual([]);
  });

  it('undoPlan inverts a delete and a move exactly', () => {
    const doc = richDoc();
    const del = [{ op: 'page_delete' as const, id: 'pg_1', deletedAt: 1 }];
    const plan = undoPlan(doc, del);
    expect(plan.label).toBe('delete a page');
    const back = applyOps(applyOps(doc, del), plan.inverse!);
    expect(back.pages.map((p) => [p.id, p.n])).toEqual(doc.pages.map((p) => [p.id, p.n]));
    const mv = moveOps(doc, 'pg_3', 0);
    const undoMove = undoPlan(doc, mv).inverse!;
    expect(applyOps(applyOps(doc, mv), undoMove).pages.map((p) => p.id)).toEqual(['pg_1', 'pg_2', 'pg_3']);
  });
});

describe('media index', () => {
  it('covers every category once per path, in book order, with what uses it', () => {
    const doc = richDoc();
    const items = collectMedia(doc);
    const roles = new Set(items.map((i) => i.role));
    for (const r of ['cover', 'page', 'sheet', 'style_option', 'style_board', 'ref', 'attachment', 'deleted_page']) expect(roles.has(r as never)).toBe(true);
    expect(items[0]).toMatchObject({ role: 'cover', owner: { label: 'Cover' }, current: true });
    expect(new Set(items.map((i) => i.path)).size).toBe(items.length);
    const orphan = items.find((i) => i.path === 'u/x/p/gone-old.webp');
    expect(orphan).toMatchObject({ archived: true, canStar: true, owner: { label: 'Deleted page 9' } });
    expect(items.find((i) => i.path === 'u/x/p/p1-v1.webp')).toMatchObject({ archived: true, versionLabel: 'v1', canStar: true });
    expect(items.find((i) => i.path === 'u/x/p/trashed.webp')).toMatchObject({ role: 'deleted_page', deletedPageId: 'pg_t', deletedFromN: 4 });
    // The same image used twice is one tile that says so.
    doc.cover.render = { ...doc.cover.render, asset: A('p1-v3', 30) };
    const shared = collectMedia(doc).find((i) => i.path === 'u/x/p/p1-v3.webp');
    expect(shared?.usedBy).toEqual(['Cover', 'Page 1']);
    expect(hasMedia(doc)).toBe(true);
    expect(hasMedia(makeSampleDoc({ pages: [], style: { ...makeSampleDoc().style, options: [] }, cast: [] }))).toBe(false);
  });

  it('filters, counts, search and grouping', () => {
    const items = collectMedia(richDoc());
    const counts = mediaCounts(items);
    expect(counts.archived).toBe(2);
    expect(counts.deleted).toBe(2); // the trashed page + an archived version of a page that is gone
    expect(filterMedia(items, 'uploads').map((i) => i.role).sort()).toEqual(['attachment', 'ref', 'ref']);
    expect(filterMedia(items, 'characters').every((i) => i.group === 'characters')).toBe(true);
    expect(filterMedia(items, 'pages').some((i) => i.role === 'deleted_page')).toBe(false);
    expect(filterMedia(items, 'all', 'maya').every((i) => /maya/i.test(i.owner.label) || i.usedBy.some((u) => /maya/i.test(u)))).toBe(true);
    const groups = groupMedia(items, 'book');
    expect(groups[0].label).toBe('Cover');
    expect(groups[1].label).toBe('Page 1');
    expect(groups[1].items.map((i) => i.versionLabel)).toEqual(['v3 · current', 'v2', 'v1']);
    const newest = groupMedia(items, 'newest');
    expect(newest).toHaveLength(1);
    expect(newest[0].items[0].at).toBeGreaterThanOrEqual(newest[0].items[1].at);
  });

  it('download names are safe file names', () => {
    const doc = richDoc();
    doc.brief = { ...doc.brief, title: '../../My "Heist" <1>' };
    expect(downloadName(doc, { owner: { key: 'k', label: 'Page 3 / v2', order: 0 }, versionN: 2 })).toBe('my-heist-1-page-3-v2-v2.webp');
    // The extension is the real file type: the downloaded MIME, else the stored path's extension.
    expect(downloadName(doc, { owner: { key: 'k', label: 'Maya ref', order: 0 } }, 'image/png')).toBe('my-heist-1-maya-ref.png');
    expect(downloadName(doc, { owner: { key: 'k', label: 'Upload', order: 0 }, path: 'u/x/p/ref/photo.JPEG' })).toBe('my-heist-1-upload.jpg');
    expect(downloadName(doc, { owner: { key: 'k', label: 'Upload', order: 0 }, path: 'u/x/p/ref/photo.exe' }, 'text/html')).toBe('my-heist-1-upload.webp');
  });
});

// A page's frame picture or overlay that a restore displaced is archived under the page ('page:<id>') with no maker
// or date and a label that says what it was (shared/comic/history apply.ts pathHomes, isPanelSourceArchive). It is
// not a drawing of the page (timeline owner note 4b).
const withPanelSources = (doc: ComicDoc): ComicDoc => {
  const plain = (name: string, targetKey: string, label: string, archivedAt: number): ArchivedVersion => ({ path: `u/x/p/${name}.webp`, source: 'upload', at: 0, targetKey, label, archivedAt });
  doc.archive = [
    plain('ov-p1', 'page:pg_1', 'Page 1 overlay', 26),
    plain('pic-p2', 'page:pg_2', 'Page 2 panel picture', 27),
    plain('ov-t', 'page:pg_t', 'Deleted page 4 overlay', 28),
    plain('ov-gone', 'page:pg_gone', 'Page 7 overlay', 29),
    // A look-alike that IS a drawing of page 2 (its label is just the page's): still one of its versions.
    plain('p2-old', 'page:pg_2', 'Page 2', 30),
    ...(doc.archive || [])
  ];
  return doc;
};

describe('a panel picture or overlay a restore archived is not a version of the page (note 4b)', () => {
  it('versionList leaves it out and keeps the shared v-numbers (the director’s) for the drawings', () => {
    const doc = withPanelSources(richDoc());
    const page1 = { kind: 'page', id: 'pg_1' } as const;
    const shared = new Map(sharedVersionList(doc, page1).map((v) => [v.path, v.n]));
    expect(shared.has('u/x/p/ov-p1.webp')).toBe(true); // the shared list still counts it (book.ts wave note)
    const list = versionList(doc, page1);
    expect(list.map((v) => v.path)).toEqual(['u/x/p/p1-v1.webp', 'u/x/p/p1-v2.webp', 'u/x/p/p1-v3.webp']);
    for (const v of list) expect(v.n, v.path).toBe(shared.get(v.path));
    expect(versionCount(doc, page1)).toBe(3);
    // Page 2: the panel picture is gone from its versions; the look-alike drawing stays.
    expect(versionList(doc, { kind: 'page', id: 'pg_2' }).map((v) => v.path)).toEqual(['u/x/p/p2-old.webp']);
    expect(bookClips(doc).find((c) => c.target?.kind === 'page' && c.target.id === 'pg_1')?.versions).toBe(3);
  });

  it('the media index lists it under its page by its own label, never as a version of the drawing', () => {
    const items = collectMedia(withPanelSources(richDoc()));
    const at = (name: string) => items.find((i) => i.path === `u/x/p/${name}.webp`);
    expect(at('ov-p1')).toMatchObject({ role: 'page', group: 'pages', owner: { key: 'page:pg_1', label: 'Page 1' }, versionLabel: 'Page 1 overlay · date not recorded', panelSource: 'overlay', current: false, archived: true, canStar: true });
    expect(at('ov-p1')).not.toHaveProperty('versionN');
    expect(at('pic-p2')).toMatchObject({ owner: { key: 'page:pg_2', label: 'Page 2' }, versionLabel: 'Page 2 panel picture · date not recorded', panelSource: 'panel picture' });
    // A deleted page's: under that deleted page, never its Restore.
    expect(at('ov-t')).toMatchObject({ role: 'deleted_page', owner: { key: 'trash:pg_t', label: 'Deleted page 4' }, versionLabel: 'Deleted page 4 overlay · date not recorded', panelSource: 'overlay' });
    expect(at('ov-t')).not.toHaveProperty('deletedPageId');
    // A purged page's: under that page's own name.
    expect(at('ov-gone')).toMatchObject({ role: 'deleted_page', owner: { key: 'archive:page:pg_gone', label: 'Page 7' }, versionLabel: 'Page 7 overlay · date not recorded', panelSource: 'overlay' });
    // The drawings keep their shared numbers; the look-alike drawing is a version as before.
    const page1 = groupMedia(items, 'book').find((g) => g.label === 'Page 1')!;
    expect(page1.items.map((i) => i.versionLabel)).toEqual(['v4 · current', 'v3', 'v2', 'Page 1 overlay · date not recorded']);
    expect(at('p2-old')).toMatchObject({ role: 'page', versionLabel: 'v1', archived: true });
    expect(at('p2-old')).not.toHaveProperty('panelSource');
    // One item per path; nothing else in the bin changed.
    expect(new Set(items.map((i) => i.path)).size).toBe(items.length);
    expect(items.filter((i) => i.panelSource).map((i) => i.path).sort()).toEqual(['u/x/p/ov-gone.webp', 'u/x/p/ov-p1.webp', 'u/x/p/ov-t.webp', 'u/x/p/pic-p2.webp']);
  });
});
