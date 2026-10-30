// "Earlier (images only)" (versions plan §11, §8; package H6a): the Earlier moments of an old comic derive only from
// what the doc already holds. Synthetic fixtures only (shared/comic/history/__fixtures__ and local variants).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { versionList } from '../book';
import { collectAssetPaths, type ArchivedVersion, type ComicDoc, type RenderVersion } from '../doc';
import { BOOK_NOW, historyEmptyDoc, historyV4Doc, historyV5Doc } from './__fixtures__/books';
import { randomBook } from './__fixtures__/random';
import {
  EARLIER_NOTE_NO_START,
  EARLIER_TITLE,
  EARLIER_UNDATED_KEY,
  EARLIER_UNDATED_LABEL,
  NOT_RECORDED,
  compareMoments,
  earlierFacts,
  earlierForPage,
  earlierHistory,
  earlierMoments,
  earlierNote,
  groupEarlierByDay,
  groupEarlierByOwner,
  type EarlierMoment
} from './earlier';

const V4 = 'u/user-a/p/proj-v4/img';
const V5 = 'u/user-b/p/proj-v5/img';
const GIT_WORDS = /\b(branch|merge|commit|checkout|fork|HEAD|diff|rebase|revert)\b/i;

const drawingsOf = (moments: EarlierMoment[]) => moments.filter((m) => m.kind === 'drawing');
const byPath = (moments: EarlierMoment[], path: string) => moments.find((m) => m.kind === 'drawing' && m.path === path)!;

/** Every dated image the doc holds: path → AssetRef.at, per render target, board, trash and archive. */
const heldDates = (doc: ComicDoc): Map<string, number> => {
  const out = new Map<string, number>();
  const put = (v?: { path?: string; at?: number }) => v?.path && out.set(v.path, v.at as number);
  const render = (r?: { asset?: { path: string; at: number }; history: RenderVersion[] }) => {
    if (!r) return;
    put(r.asset);
    r.history.forEach(put);
  };
  render(doc.cover.render);
  doc.pages.forEach((p) => render(p.render));
  doc.cast.forEach((c) => render(c.sheet));
  doc.places.forEach((p) => render(p.sheet));
  doc.style.options.forEach((o) => render(o.render));
  put(doc.style.board);
  (doc.trash || []).forEach((t) => render(t.page.render));
  (doc.archive || []).forEach(put);
  return out;
};

/** A v4-shaped doc (like f8312c86) whose older drawings never recorded their meta. */
const v4WithGaps = (): ComicDoc => {
  const doc = historyV4Doc();
  const old = doc.pages[1].render.history[0] as Partial<RenderVersion>;
  delete old.model;
  delete old.costUsd;
  delete old.origin;
  // A drawing whose date was never recorded (an imported legacy image).
  (doc.pages[2].render.history[0] as Partial<RenderVersion>).at = 0;
  // An image the creator uploaded for a page (no model, no cost — and that is not a gap).
  doc.pages[3].render.history.push({ path: `${V4}/p4-upload.webp`, source: 'upload', at: BOOK_NOW - 6_800_000, origin: 'upload' });
  return doc;
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('earlierMoments: dates come from AssetRef.at', () => {
  it('every drawing is dated by the AssetRef.at of the image it shows (v4, v5)', () => {
    for (const doc of [historyV4Doc(), historyV5Doc()]) {
      const dates = heldDates(doc);
      const drawings = drawingsOf(earlierMoments(doc));
      expect(drawings.length).toBe(dates.size);
      for (const m of drawings) expect(m.at).toBe(dates.get(m.path!));
    }
  });

  it('an archived version keeps the time it was drawn, not the time it was archived', () => {
    const doc = historyV5Doc();
    const a = doc.archive![2];
    const m = byPath(earlierMoments(doc), a.path);
    expect(m.at).toBe(a.at);
    expect(m.at).not.toBe(a.archivedAt);
    expect(m).toMatchObject({ archived: true, current: false, owner: { key: 'page:pg_1', label: 'Page 1' } });
  });

  it('deleted and published moments use deletedAt and publishedAt', () => {
    const doc = historyV5Doc();
    const moments = earlierMoments(doc);
    expect(moments.find((m) => m.kind === 'deleted')).toMatchObject({ at: doc.trash![0].deletedAt, label: 'Page 7 was deleted', path: `${V5}/old.webp`, fromN: 7 });
    expect(moments.find((m) => m.kind === 'published')).toMatchObject({ at: doc.publication!.publishedAt, label: 'Last published', languages: ['en', 'te'], by: 'you' });
  });
});

describe('earlierMoments: missing meta says "not recorded"', () => {
  it('lists the gaps and words each one "not recorded"', () => {
    const moments = earlierMoments(v4WithGaps());
    const gap = byPath(moments, `${V4}/p2-v1.webp`);
    expect(gap).toMatchObject({ origin: null, model: null, modelLabel: null, costUsd: null, by: 'ai', label: 'AI drew page 2' });
    expect(gap.missing).toEqual(['origin', 'model', 'cost']);
    const facts = earlierFacts(gap);
    expect(facts).toEqual([`How it was made: ${NOT_RECORDED}`, `Image model: ${NOT_RECORDED}`, `Cost: ${NOT_RECORDED}`]);

    const undated = byPath(moments, `${V4}/p3-v1.webp`);
    expect(undated.at).toBeNull();
    expect(undated.missing).toContain('date');
    expect(earlierFacts(undated)).toContain(`Date: ${NOT_RECORDED}`);
  });

  it('recorded meta is stated, never "not recorded"', () => {
    const recorded = byPath(earlierMoments(v4WithGaps()), `${V4}/p1-v1.webp`);
    expect(recorded).toMatchObject({ origin: 'render', model: 'nano-banana-2.1', modelLabel: 'Nano Banana 2.1', costUsd: 0.04, missing: [] });
    const facts = earlierFacts(recorded, (usd) => `$${usd.toFixed(2)}`);
    expect(facts).toEqual(['Drawn by AI', 'Drawn with Nano Banana 2.1', '$0.04']);
    expect(facts.join(' ')).not.toContain(NOT_RECORDED);
    // Without a formatter, money is never printed in dollars (governed users see usage).
    expect(earlierFacts(recorded).join(' ')).not.toContain('$');
  });

  it('an upload has no model or cost to miss; a board with no meta says so', () => {
    const moments = earlierMoments(v4WithGaps());
    const upload = byPath(moments, `${V4}/p4-upload.webp`);
    expect(upload).toMatchObject({ by: 'you', label: 'You uploaded art for page 4', missing: [] });
    expect(earlierFacts(upload)).toEqual(['Uploaded by you', 'No AI cost']);
    const board = byPath(moments, `${V4}/board.webp`);
    expect(board).toMatchObject({ owner: { kind: 'style_board' }, by: 'ai', missing: ['origin', 'cost'], label: 'AI drew the style board' });
    expect(earlierFacts(board)).toContain(`Cost: ${NOT_RECORDED}`);
  });

  it('an image with neither origin nor source says who made it is not recorded; a deletion has no actor', () => {
    const doc = historyV4Doc();
    const bare = doc.pages[0].render.history[0] as Partial<RenderVersion>;
    delete bare.origin;
    delete bare.source;
    delete bare.model;
    delete bare.costUsd;
    const m = byPath(earlierMoments(doc), bare.path!);
    expect(m).toMatchObject({ by: null, source: null, label: 'Art for page 1' });
    expect(m.missing).toEqual(['by', 'origin', 'model', 'cost']);
    expect(earlierFacts(m)).toEqual([`How it was made: ${NOT_RECORDED}`, `Image model: ${NOT_RECORDED}`, `Cost: ${NOT_RECORDED}`]);
    const deleted = earlierMoments(historyV5Doc()).find((x) => x.kind === 'deleted')!;
    expect(deleted.missing).toEqual(['by']);
    expect(earlierFacts(deleted)).toEqual([`Deleted by: ${NOT_RECORDED}`]);
  });

  it('an image the editor made has no AI cost to miss: its label and its facts agree', () => {
    const doc = historyV4Doc();
    const bare = doc.pages[0].render.history[0] as Partial<RenderVersion>;
    delete bare.origin;
    delete bare.model;
    delete bare.costUsd;
    bare.source = 'derived';
    for (const [i, origin] of (['derived', 'reused'] as const).entries()) {
      const v = doc.pages[i + 1].render.history[0] as Partial<RenderVersion>;
      v.origin = origin;
      delete v.model;
      delete v.costUsd; // the cost was lost, but the editor's work never had one
    }
    const moments = earlierMoments(doc);
    const derived = byPath(moments, bare.path!);
    expect(derived).toMatchObject({ by: 'editor', origin: null, source: 'derived', costUsd: null, label: 'The editor made art for page 1, no AI cost' });
    expect(derived.missing).toEqual(['origin']);
    expect(earlierFacts(derived)).toEqual([`How it was made: ${NOT_RECORDED}`, 'No AI cost']);
    const fitted = byPath(moments, `${V4}/p2-v1.webp`);
    const reused = byPath(moments, `${V4}/p3-v1.webp`);
    expect(fitted).toMatchObject({ by: 'editor', label: 'The editor fitted page 2, no AI cost', missing: [] });
    expect(reused).toMatchObject({ by: 'editor', label: 'Reused a drawing for page 3, no AI cost', missing: [] });
    expect(earlierFacts(fitted)).toEqual(['Fitted by the editor, no AI cost']);
    expect(earlierFacts(reused)).toEqual(['Reused, no AI cost']);
    for (const m of [derived, fitted, reused]) {
      const facts = earlierFacts(m);
      expect(facts).not.toContain(`Cost: ${NOT_RECORDED}`);
      expect(facts.join(' · ').match(/no AI cost/gi)).toHaveLength(1); // said once, never contradicted
    }
  });

  it('a stored time no date can hold reads "not recorded" instead of breaking the Earlier section', () => {
    const doc = historyV4Doc();
    const path = doc.pages[0].render.history[0].path;
    doc.pages[0].render.history[0].at = 9e15; // beyond the JS Date range (8.64e15)
    let h: ReturnType<typeof earlierHistory> | undefined;
    expect(() => {
      h = earlierHistory(doc, { now: BOOK_NOW, tz: 'UTC' });
    }).not.toThrow();
    const m = byPath(h!.moments, path);
    expect(m.at).toBeNull();
    expect(m.missing).toContain('date');
    expect(h!.moments[h!.moments.length - 1].path).toBe(path);
    const last = h!.days[h!.days.length - 1];
    expect(last).toMatchObject({ key: EARLIER_UNDATED_KEY, label: EARLIER_UNDATED_LABEL, at: null, count: 1 });
    expect(last.groups[0].moments.map((x) => x.path)).toEqual([path]);
    // The same for the other stored times, the History start and hand-built moments.
    const v5 = historyV5Doc();
    v5.trash![0].deletedAt = 9e15;
    v5.publication!.publishedAt = 9e15;
    const moments = earlierMoments(v5);
    expect(moments.find((x) => x.kind === 'deleted')).toMatchObject({ at: null, missing: ['date', 'by'] });
    expect(moments.find((x) => x.kind === 'published')).toMatchObject({ at: null, missing: ['date'] });
    expect(earlierNote(9e15, 'UTC')).toBe(EARLIER_NOTE_NO_START);
    const corrupt: EarlierMoment = { ...m, at: 9e15 };
    expect(groupEarlierByDay([corrupt], { now: BOOK_NOW, tz: 'UTC' })).toMatchObject([{ key: EARLIER_UNDATED_KEY, label: EARLIER_UNDATED_LABEL, at: null }]);
  });
});

describe('earlierMoments: the v4-shaped fixture (like f8312c86) and an empty doc', () => {
  it('the v4 book: every drawing once, newest first, owners in book order on ties', () => {
    const moments = earlierMoments(historyV4Doc());
    expect(moments.every((m) => m.kind === 'drawing')).toBe(true);
    expect(moments.map((m) => m.path)).toEqual([
      `${V4}/cover.webp`,
      `${V4}/p5.webp`, `${V4}/p4.webp`, `${V4}/p3.webp`, `${V4}/p2.webp`, `${V4}/p1.webp`,
      `${V4}/p5-v1.webp`, `${V4}/p4-v1.webp`, `${V4}/p3-v1.webp`, `${V4}/p2-v1.webp`, `${V4}/p1-v1.webp`,
      `${V4}/c_bunny.webp`, `${V4}/c_frog.webp`, `${V4}/c_ducks.webp`, `${V4}/c_kid.webp`,
      `${V4}/board.webp`
    ]);
    expect(moments[0]).toMatchObject({ label: 'AI drew the cover', current: true, versionN: 1, owner: { key: 'cover', target: { kind: 'cover' } } });
    expect(byPath(moments, `${V4}/p3.webp`)).toMatchObject({ label: 'AI drew page 3', current: true, versionN: 2, owner: { key: 'page:pg_3', pageId: 'pg_3', label: 'Page 3' } });
    expect(byPath(moments, `${V4}/p3-v1.webp`)).toMatchObject({ current: false, archived: false, versionN: 1 });
    expect(byPath(moments, `${V4}/c_kid.webp`)).toMatchObject({ label: "AI drew THE KID's sheet", owner: { label: 'THE KID sheet', target: { kind: 'sheet', id: 'c_kid' } } });
  });

  it('the v4 book grouped per page and per day, in the viewer’s zone', () => {
    const history = earlierHistory(historyV4Doc(), { now: BOOK_NOW, tz: 'UTC' });
    expect(history.title).toBe(EARLIER_TITLE);
    expect(history.drawings).toBe(16);
    expect(history.owners.map((g) => g.label)).toEqual([
      'Cover', 'Page 5', 'Page 4', 'Page 3', 'Page 2', 'Page 1', 'BUNNY sheet', 'FROG sheet', 'DUCKLINGS sheet', 'THE KID sheet', 'Style board'
    ]);
    expect(history.owners.find((g) => g.key === 'page:pg_2')!.moments.map((m) => m.versionN)).toEqual([2, 1]);
    // 22:36–23:43 UTC on 28 Oct: "Yesterday" at 01:06 UTC on 29 Oct …
    expect(history.days.map((d) => [d.key, d.label, d.count])).toEqual([['2025-10-28', 'Yesterday', 16]]);
    expect(history.days[0].groups.map((g) => g.key)).toEqual(history.owners.map((g) => g.key));
    // … and "Today" (04:06–05:13 on 29 Oct) in Kolkata.
    const ist = earlierHistory(historyV4Doc(), { now: BOOK_NOW, tz: 'Asia/Kolkata' });
    expect(ist.days.map((d) => [d.key, d.label])).toEqual([['2025-10-29', 'Today']]);
    expect(ist.tz).toMatch(/^Asia\/(Kolkata|Calcutta)$/);
  });

  it('an empty doc has nothing earlier', () => {
    expect(earlierMoments(historyEmptyDoc())).toEqual([]);
    const h = earlierHistory(historyEmptyDoc(), { now: BOOK_NOW });
    expect(h).toMatchObject({ moments: [], days: [], owners: [], drawings: 0, tz: 'UTC' });
    // One fallback string for the whole History UI (H5 uses this note, not its own).
    expect(EARLIER_NOTE_NO_START).toBe('Only drawings were recorded before History started.');
    expect(h.note).toBe(EARLIER_NOTE_NO_START);
  });

  it('the note names History’s first day in the viewer’s zone', () => {
    expect(earlierNote(BOOK_NOW, 'UTC')).toBe('Only drawings were recorded before 29 Oct.');
    expect(earlierNote(BOOK_NOW, 'America/Los_Angeles')).toBe('Only drawings were recorded before 28 Oct.');
    expect(earlierNote(BOOK_NOW, 'Not/AZone')).toBe('Only drawings were recorded before 29 Oct.');
    expect(earlierHistory(historyV4Doc(), { now: BOOK_NOW, before: BOOK_NOW }).note).toBe('Only drawings were recorded before 29 Oct.');
  });
});

describe('earlierMoments: v5 owners, version numbers and the History start', () => {
  it('v-numbers are the shared ones (timeline and director), current + history + archive per target', () => {
    const doc = historyV5Doc();
    const moments = earlierMoments(doc);
    for (const m of drawingsOf(moments)) {
      if (!m.owner.target) continue;
      const entry = versionList(doc, m.owner.target).find((e) => e.path === m.path)!;
      expect(entry).toBeTruthy();
      expect([m.versionN, m.current, m.archived]).toEqual([entry.n, entry.current, entry.archived]);
    }
    const page1 = earlierForPage(moments, 'pg_1');
    expect(page1).toHaveLength(1 + 8 + 5);
    expect(page1.map((m) => m.versionN)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect(groupEarlierByOwner(moments).find((g) => g.key === 'page:pg_1')!.moments).toEqual(page1);
  });

  it('deleted pages, removed owners and restored boards get honest owners; reference photos stay out', () => {
    const doc = historyV5Doc();
    const arch = (path: string, targetKey: string, label: string): ArchivedVersion => ({ path, source: 'generated', model: 'nano-banana-2.1', at: BOOK_NOW - 40_000_000, targetKey, label, archivedAt: BOOK_NOW - 3_000_000, origin: 'render' });
    doc.archive = [
      ...doc.archive!,
      arch(`${V5}/gone-sheet.webp`, 'sheet:ch_gone', 'ZED sheet'),
      arch(`${V5}/old-board.webp`, 'style_board', 'Style board'),
      arch(`${V5}/old-deleted.webp`, 'page:pg_old', 'Deleted page 7'),
      { ...arch('u/user-b/p/proj-v5/ref/old-face.webp', 'ref:character:ch_maya', 'MAYA reference'), source: 'upload', origin: 'upload' }
    ];
    const moments = earlierMoments(doc);
    expect(byPath(moments, `${V5}/gone-sheet.webp`)).toMatchObject({ owner: { key: 'archive:sheet:ch_gone', kind: 'removed', label: 'ZED sheet (removed)' }, label: 'AI drew ZED sheet (no longer in the book)' });
    expect(byPath(moments, `${V5}/old-board.webp`)).toMatchObject({ owner: { key: 'style_board' }, archived: true, current: false, versionN: 1 });
    expect(byPath(moments, `${V5}/board.webp`)).toMatchObject({ owner: { key: 'style_board' }, current: true, versionN: 2 });
    const deletedPage = earlierForPage(moments, 'pg_old');
    expect(deletedPage.map((m) => [m.kind, m.path, m.archived])).toEqual([
      ['deleted', `${V5}/old.webp`, false],
      ['drawing', `${V5}/old.webp`, false],
      ['drawing', `${V5}/old-deleted.webp`, true]
    ]);
    expect(deletedPage.every((m) => m.owner.kind === 'deleted_page' && m.owner.label === 'Deleted page 7' && !m.current)).toBe(true);
    expect(deletedPage[1].label).toBe('AI drew page 7 (now in Deleted)');
    // Uploads (references, chat attachments, the inbox) are not drawings.
    const paths = moments.map((m) => m.path);
    for (const ref of ['ref/old-face.webp', 'ref/style1.webp', 'ref/maya_crop.webp', 'ref/maya_orig.webp', 'ref/inbox1.webp', 'ref/attach1.webp']) {
      expect(paths).not.toContain(`u/user-b/p/proj-v5/${ref}`);
    }
  });

  it('only moments before History’s start are earlier; undated ones stay', () => {
    const doc = v4WithGaps();
    const before = BOOK_NOW - 6_000_000 + 3; // between page 2's and page 3's current drawings
    const moments = earlierMoments(doc, { before });
    expect(moments.every((m) => m.at === null || m.at < before)).toBe(true);
    expect(moments.map((m) => m.path)).not.toContain(`${V4}/p3.webp`);
    expect(moments.map((m) => m.path)).toContain(`${V4}/p2.webp`);
    expect(moments[moments.length - 1]).toMatchObject({ path: `${V4}/p3-v1.webp`, at: null });
    const days = groupEarlierByDay(moments, { now: BOOK_NOW, tz: 'UTC' });
    expect(days[days.length - 1]).toMatchObject({ key: EARLIER_UNDATED_KEY, label: EARLIER_UNDATED_LABEL, count: 1 });
  });

  it('per day: newest day first; inside a day, the owner with the newest moment first', () => {
    const doc = historyV5Doc();
    // 06:36 on 29 Oct in Kolkata: the archived page-1 drawings (22:16 on the 28th) are "Yesterday", the rest "Today".
    const days = groupEarlierByDay(earlierMoments(doc), { now: BOOK_NOW, tz: 'Asia/Kolkata' });
    expect(days.map((d) => [d.key, d.label])).toEqual([['2025-10-29', 'Today'], ['2025-10-28', 'Yesterday']]);
    expect(days[1].groups.map((g) => g.key)).toEqual(['page:pg_1']);
    expect(days[1].groups[0].moments.map((m) => m.path)).toEqual(doc.archive!.map((a) => a.path).reverse());
    for (const d of days) {
      const ats = d.groups.map((g) => g.at!);
      expect(ats).toEqual([...ats].sort((a, b) => b - a));
      for (const g of d.groups) expect(g.moments.map((m) => m.at)).toEqual(g.moments.map((m) => m.at).sort((a, b) => b! - a!));
    }
    expect(days[0].groups.map((g) => g.key)).toContain('book');
    expect(days.reduce((n, d) => n + d.count, 0)).toBe(earlierMoments(doc).length);
  });

  it('a page in Deleted whose id is live again is listed once, as the live page', () => {
    const doc = historyV5Doc();
    const live = doc.pages[1];
    doc.trash = [
      ...doc.trash!,
      { page: { ...structuredClone(doc.trash![0].page), id: live.id }, fromN: 9, deletedAt: BOOK_NOW - 1_000 }
    ];
    const moments = earlierMoments(doc);
    expect(moments.some((m) => m.owner.key === `trash:${live.id}`)).toBe(false);
    expect(moments.filter((m) => m.kind === 'deleted').map((m) => m.owner.key)).toEqual(['trash:pg_old']);
    expect(earlierForPage(moments, live.id).every((m) => m.owner.kind === 'page' && m.owner.key === `page:${live.id}`)).toBe(true);
    expect(groupEarlierByOwner(moments).map((g) => g.label)).not.toContain('Deleted page 9');
  });

  it('an image two owners hold is one moment per owner, each with its own target ("Use this version" acts there)', () => {
    const doc = historyV5Doc();
    const p4 = doc.pages[3].render.asset!;
    doc.pages[4].render.history.push({ ...p4, origin: 'reused', at: p4.at + 1 }); // page 5 reused page 4's drawing
    const shared = earlierMoments(doc).filter((m) => m.kind === 'drawing' && m.path === p4.path);
    expect(shared.map((m) => [m.id, m.owner.key, m.owner.target, m.current])).toEqual([
      [`drawing|page:pg_5|${p4.path}`, 'page:pg_5', { kind: 'page', id: 'pg_5' }, false],
      [`drawing|page:pg_4|${p4.path}`, 'page:pg_4', { kind: 'page', id: 'pg_4' }, true]
    ]);
    expect(shared[0].label).toBe('Reused a drawing for page 5, no AI cost');
  });

  it('a drawing keeps what its AssetRef holds: star and size', () => {
    const doc = historyV4Doc();
    doc.pages[0].render.history[0].starred = true;
    const sizeless = doc.pages[1].render.history[0] as Partial<RenderVersion>;
    delete sizeless.w;
    delete sizeless.h;
    const moments = earlierMoments(doc);
    expect(byPath(moments, `${V4}/p1-v1.webp`)).toMatchObject({ starred: true, w: 928, h: 1392 });
    expect(byPath(moments, `${V4}/p1.webp`)).toMatchObject({ starred: false, w: 928, h: 1392 });
    expect(byPath(moments, `${V4}/cover.webp`)).toMatchObject({ w: 928, h: 1392 });
    const bare = byPath(moments, `${V4}/p2-v1.webp`);
    expect('w' in bare || 'h' in bare).toBe(false);
    expect(moments.filter((m) => m.starred).map((m) => m.path)).toEqual([`${V4}/p1-v1.webp`]);
  });

  it('a blocked or quarantined image keeps its moment but no thumbnail', () => {
    const doc = historyV5Doc();
    doc.pages[2].render.asset!.safety = { assessed: 'X', at: BOOK_NOW };
    doc.pages[3].render.asset!.path = `q/${V5}/p4.webp`;
    const moments = earlierMoments(doc);
    for (const path of [`${V5}/p3.webp`, `q/${V5}/p4.webp`]) {
      const m = byPath(moments, path);
      expect(m.blocked).toBe(true);
      expect(m.thumbPath).toBeUndefined();
      expect(earlierFacts(m)).toContain('Held back by the content check');
    }
    expect(byPath(moments, `${V5}/p2.webp`)).toMatchObject({ blocked: false, thumbPath: `${V5}/p2_w480.webp` });
  });
});

describe('earlierMoments: deterministic ordering', () => {
  it('the same doc gives the same moments, whatever order its arrays are stored in', () => {
    const a = historyV5Doc();
    const b = historyV5Doc();
    b.pages.reverse();
    for (const p of b.pages) p.render.history.reverse();
    b.cover.render.history.reverse();
    b.archive!.reverse();
    expect(earlierMoments(b)).toEqual(earlierMoments(a));
    expect(earlierMoments(a)).toEqual(earlierMoments(historyV5Doc()));
  });

  it('equal times fall back to book order, then the newer version, and the order is total', () => {
    const doc = historyV4Doc();
    const t = BOOK_NOW - 1_000;
    doc.cover.render.asset!.at = t;
    doc.pages[1].render.asset!.at = t;
    doc.pages[0].render.asset!.at = t;
    doc.pages[0].render.history[0].at = t;
    const moments = earlierMoments(doc);
    expect(moments.slice(0, 4).map((m) => m.path)).toEqual([`${V4}/cover.webp`, `${V4}/p1.webp`, `${V4}/p1-v1.webp`, `${V4}/p2.webp`]);
    expect([...moments].reverse().sort(compareMoments)).toEqual(moments);
    expect(new Set(moments.map((m) => m.id)).size).toBe(moments.length);
  });

  it('at the same time and owner: published, then deleted, then the drawing', () => {
    const doc = historyV5Doc();
    const t = doc.trash![0];
    t.deletedAt = t.page.render.asset!.at; // deleted the moment it was drawn
    doc.publication!.publishedAt = doc.pages[0].render.asset!.at;
    const moments = earlierMoments(doc);
    const page = earlierForPage(moments, 'pg_old');
    expect(page.slice(0, 2).map((m) => [m.kind, m.path])).toEqual([['deleted', `${V5}/old.webp`], ['drawing', `${V5}/old.webp`]]);
    const atPub = moments.filter((m) => m.at === doc.publication!.publishedAt);
    expect(atPub.map((m) => m.kind)).toEqual(['published', 'drawing']);
    // compareMoments is exported for any input: the kind decides when time, owner and version tie.
    const base = byPath(moments, `${V5}/old.webp`);
    const same = (kind: EarlierMoment['kind']): EarlierMoment => ({ ...base, kind, id: `${kind}|${base.owner.key}|-`, versionN: undefined });
    for (const input of [[same('drawing'), same('deleted'), same('published')], [same('deleted'), same('published'), same('drawing')]]) {
      expect(input.sort(compareMoments).map((m) => m.kind)).toEqual(['published', 'deleted', 'drawing']);
    }
  });

  it('grouping does not depend on the order of its input', () => {
    const moments = earlierMoments(historyV5Doc());
    const shuffled = [...moments].reverse();
    const owners = groupEarlierByOwner(moments);
    expect(groupEarlierByOwner(shuffled)).toEqual(owners);
    expect(owners.map((g) => g.at)).toEqual(owners.map((g) => g.at).sort((a, b) => b! - a!));
    for (const tz of ['UTC', 'Asia/Kolkata']) {
      expect(groupEarlierByDay(shuffled, { now: BOOK_NOW, tz })).toEqual(groupEarlierByDay(moments, { now: BOOK_NOW, tz }));
    }
  });
});

describe('earlierMoments: no image path the doc does not hold', () => {
  const docs: [string, () => ComicDoc][] = [
    ['v4', historyV4Doc],
    ['v4 with gaps', v4WithGaps],
    ['v5', historyV5Doc],
    ['empty', historyEmptyDoc],
    ...Array.from({ length: 24 }, (_, i): [string, () => ComicDoc] => [`random ${i + 1}`, () => randomBook(i + 1)])
  ];
  it.each(docs)('%s: every path and thumbnail is in collectAssetPaths', (_name, make) => {
    const doc = make();
    const held = new Set(collectAssetPaths(doc));
    const moments = earlierMoments(doc);
    if (_name !== 'empty') expect(moments.filter((m) => m.path).length).toBeGreaterThan(0); // never vacuous
    for (const m of moments) {
      if (m.path !== undefined) expect(held.has(m.path)).toBe(true);
      if (m.thumbPath !== undefined) expect(held.has(m.thumbPath)).toBe(true);
    }
  });
});

describe('earlier.ts is pure', () => {
  it('never reads the clock: the same input gives the same output at any time', () => {
    const run = () => earlierHistory(historyV5Doc(), { now: BOOK_NOW, tz: 'Asia/Kolkata', before: BOOK_NOW - 500 });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const first = run();
    vi.setSystemTime(new Date('2031-06-15T12:00:00Z'));
    const second = run();
    expect(second).toEqual(first);
    vi.useRealTimers();
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('earlier.ts read the clock');
    });
    const doc = v4WithGaps();
    const moments = earlierMoments(doc);
    expect(() => groupEarlierByDay(moments, { now: BOOK_NOW, tz: 'UTC' })).not.toThrow();
    expect(() => groupEarlierByOwner(moments)).not.toThrow();
    expect(() => moments.map((m) => earlierFacts(m))).not.toThrow();
    expect(() => earlierNote(BOOK_NOW, 'UTC')).not.toThrow();
    expect(run()).toEqual(first);
  });

  it('does not mutate the doc and has no clock or randomness in its source', () => {
    const doc = historyV5Doc();
    const before = JSON.stringify(doc);
    earlierHistory(doc, { now: BOOK_NOW, tz: 'UTC' });
    expect(JSON.stringify(doc)).toBe(before);
    const src = readFileSync(join(__dirname, 'earlier.ts'), 'utf8');
    expect(src).not.toMatch(/Date\.now|new Date\(|performance\.now|Math\.random|setTimeout|setInterval/);
  });

  it('copy is plain words: no git words in any label, group or fact', () => {
    for (const doc of [historyV4Doc(), v4WithGaps(), historyV5Doc(), randomBook(7)]) {
      const h = earlierHistory(doc, { now: BOOK_NOW, tz: 'UTC' });
      const words = [h.title, h.note, ...h.days.map((d) => d.label), ...h.owners.map((g) => g.label), ...h.moments.flatMap((m) => [m.label, ...earlierFacts(m)])];
      for (const w of words) expect(w).not.toMatch(GIT_WORDS);
    }
  });
});
