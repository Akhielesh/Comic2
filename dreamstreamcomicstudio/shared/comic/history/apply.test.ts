// The history_restore applier (versions plan §6.2; H0): server == client parity over the wire, the merge-mode
// invariants I1–I6 as property tests over random books and scopes, exact mode, and per-scope fixtures.
import { describe, expect, it } from 'vitest';
import {
  collectAssetPaths,
  normalizeDoc,
  pageSpecHash,
  trashOf,
  type ComicDoc,
  type Page
} from '../doc';
import { applyOp, applyOps, type DocOp } from '../ops';
import { encodeStudioEvent } from '../events';
import { editionProgress, i18nOf } from '../i18n';
import { MAX_ARCHIVE, MAX_RENDER_HISTORY, MAX_TRASH } from '../limits';
import { historyEmptyDoc, historyV4Doc, historyV5Doc, BOOK_NOW } from './__fixtures__/books';
import { evolveBook, randomBook, randomScope } from './__fixtures__/random';
import { diffBooks } from './diff';
import { isPanelSourceArchive } from './apply';
import { exactRestoreSet, historyRestoreOp, isEmptyRestoreSet, restoreEffects, restoreOps } from './restore';
import { excludedOf, joinSections, splitSections } from './sections';
import type { RestoreScope } from './types';

const AT = BOOK_NOW + 1_000_000;

/** The version as the server reassembles it: sections joined into a frame (never the live doc object itself). */
const asVersion = (doc: ComicDoc): ComicDoc => joinSections(splitSections(doc), excludedOf(doc));

const restore = (current: ComicDoc, version: ComicDoc, scope: RestoreScope, mode: 'merge' | 'exact' = 'merge'): ComicDoc =>
  applyOps(current, [historyRestoreOp(mode === 'exact' ? exactRestoreSet(version) : restoreOps(current, version, scope), { versionId: 'ver_1', at: AT, mode })], AT);

/** The wire: what the client receives (encodeStudioEvent turns undefined into null) and the doc it mirrors. */
const overTheWire = <T>(value: T): T => JSON.parse(encodeStudioEvent({ type: 'ops', rev: 1, ops: [value as unknown as DocOp] })).ops[0] as T;
const wireDoc = (doc: ComicDoc): ComicDoc => JSON.parse(JSON.stringify(doc)) as ComicDoc;

/** Paths the archive lists more than once. */
const duplicatePaths = (archive: ComicDoc['archive']): string[] => {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const a of archive || []) (seen.has(a.path) ? dup : seen).add(a.path);
  return [...dup];
};
const uniquePaths = (archive: ComicDoc['archive']): boolean => duplicatePaths(archive).length === 0;

const FORWARD_ONLY = ['spend', 'conversation', 'memory', 'settings', 'safety', 'publication', 'imageModel', 'refInbox'] as const;

const pagesTouchedBy = (scope: RestoreScope): Set<string> | null => {
  switch (scope.kind) {
    case 'page':
    case 'panel':
    case 'line':
      return new Set([scope.pageId]);
    case 'language':
    case 'script':
    case 'cover':
      return new Set();
    default:
      return null; // book, character, place, style, keys may change any page's spec inputs
  }
};

describe('history_restore parity: server == client', () => {
  it.each<[string, RestoreScope]>([
    ['book', { kind: 'book' }],
    ['page', { kind: 'page', pageId: 'pg_2', mode: 'replace', part: 'all' }],
    ['panel', { kind: 'panel', pageId: 'pg_1', panelId: 'pg_1_p3' }],
    ['language', { kind: 'language', lang: 'te' }],
    ['character', { kind: 'character', id: 'ch_maya' }]
  ])('the %s restore applies identically to the server doc and the client mirror after the wire', (_name, scope) => {
    const version = asVersion(normalizeDoc(historyV5Doc()));
    const current = evolveBook(normalizeDoc(historyV5Doc()), 7, 40);
    const op = historyRestoreOp(restoreOps(current, version, scope), { versionId: 'v', at: AT });
    const server = applyOps(current, [op], AT);
    const client = applyOps(wireDoc(current), [overTheWire(op)], AT);
    expect(client).toEqual(wireDoc(server));
    expect(server).not.toEqual(current); // the restore did something
  });

  it('holds on random books and scopes', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const base = randomBook(seed);
      const version = asVersion(evolveBook(base, seed * 31, 12));
      const current = evolveBook(base, seed * 17, 25);
      const op = historyRestoreOp(restoreOps(current, version, randomScope(version, current, seed)), { versionId: 'v', at: AT });
      expect(applyOps(wireDoc(current), [overTheWire(op)], AT), `seed ${seed}`).toEqual(wireDoc(applyOps(current, [op], AT)));
    }
  });

  it('is pure: the same op on the same doc gives the same doc and never mutates its input', () => {
    const current = Object.freeze(normalizeDoc(historyV5Doc()));
    const op = historyRestoreOp(restoreOps(current, asVersion(historyV4Doc()), { kind: 'book' }), { versionId: 'v', at: AT });
    expect(applyOp(current, op)).toEqual(applyOp(current, op));
  });

  it('a malformed op is a no-op (R6), never a throw', () => {
    const doc = normalizeDoc(historyV5Doc());
    for (const bad of [{ op: 'history_restore' }, { op: 'history_restore', set: null, mode: 'merge' }, { op: 'history_restore', set: {}, mode: 'merge' }, { op: 'history_restore', set: { brief: {} }, mode: 'sideways' }]) {
      expect(applyOp(doc, bad as unknown as DocOp)).toBe(doc);
    }
  });
});

describe('merge-mode invariants I1–I6 (property tests over random books and scopes)', () => {
  const SEEDS = 150;

  it('I1 no lost image, I2 no lost translation, I3 forward-only untouched, I4 busy untouched, I5 normalized, I6 later additions kept', () => {
    let restored = 0;
    for (let seed = 1; seed <= SEEDS; seed += 1) {
      const base = randomBook(seed);
      const version = asVersion(evolveBook(base, seed * 101, int(seed, 4, 20)));
      const current = evolveBook(base, seed * 7, int(seed, 6, 40), { allowBusy: true });
      const scope = randomScope(version, current, seed * 13);
      const set = restoreOps(current, version, scope);
      const after = applyOps(current, [historyRestoreOp(set, { versionId: 'v', at: AT })], AT);
      const ctx = `seed ${seed} scope ${JSON.stringify(scope)}`;
      const empty = isEmptyRestoreSet(set);
      if (!empty) restored += 1;
      // Nothing to bring back (the version lacks the target): nothing changes.
      if (empty) expect({ ...after, updatedAt: 0 }, ctx).toEqual({ ...current, updatedAt: 0 });

      // I1: every image path the book had is still referenced (the archive stays below its cap here).
      expect(current.archive!.length + 120, ctx).toBeLessThan(MAX_ARCHIVE);
      const kept = new Set(collectAssetPaths(after));
      expect(collectAssetPaths(current).filter((p) => !kept.has(p)), ctx).toEqual([]);
      // …and never by archiving a path twice: an archive of unique paths stays unique.
      if (uniquePaths(current.archive)) expect(duplicatePaths(after.archive), ctx).toEqual([]);

      // I2: no translation removed; editions and glossary terms are a union; statuses still derive.
      const ea = i18nOf(after).editions;
      for (const [lang, e] of Object.entries(i18nOf(current).editions)) {
        expect(ea[lang], `${ctx} edition ${lang}`).toBeDefined();
        for (const id of Object.keys(e.lines)) expect(ea[lang].lines[id], `${ctx} ${lang}:${id}`).toBeDefined();
        expect(() => editionProgress(after, lang)).not.toThrow();
      }
      const terms = new Set(i18nOf(after).glossary.map((t) => t.id));
      for (const t of i18nOf(current).glossary) expect(terms.has(t.id), `${ctx} term ${t.id}`).toBe(true);

      // I3: forward-only state deep-equal; the gate is cleared (a pending quote is about the old state).
      for (const k of FORWARD_ONLY) expect(after[k], `${ctx} ${k}`).toEqual(current[k]);
      if (!empty) expect(after.gate, ctx).toBeNull();
      expect(after.format.language, ctx).toBe(current.format.language);

      // I4: a page that is drawing keeps its render exactly.
      for (const p of current.pages) {
        if (p.render.status !== 'rendering' && p.render.status !== 'queued') continue;
        const q = after.pages.find((x) => x.id === p.id);
        expect(q, `${ctx} busy ${p.id} still there`).toBeDefined();
        expect(q!.render, `${ctx} busy ${p.id}`).toEqual(p.render);
      }

      // I5: normalized; pages outside the scope keep their spec hash.
      expect(normalizeDoc(after), ctx).toEqual(after);
      const touched = pagesTouchedBy(scope);
      if (touched) {
        for (const p of current.pages) {
          const q = after.pages.find((x) => x.id === p.id);
          if (!q || touched.has(p.id)) continue;
          expect(pageSpecHash(after, q), `${ctx} spec ${p.id}`).toBe(pageSpecHash(current, p));
        }
      }

      // I6: characters, places and options created since stay; pages created since go to Deleted (or stay if drawing).
      for (const c of current.cast) expect(after.cast.some((x) => x.id === c.id), `${ctx} cast ${c.id}`).toBe(true);
      for (const p of current.places) expect(after.places.some((x) => x.id === p.id), `${ctx} place ${p.id}`).toBe(true);
      for (const o of current.style.options) expect(after.style.options.some((x) => x.id === o.id), `${ctx} option ${o.id}`).toBe(true);
      if (scope.kind === 'book') {
        for (const p of current.pages) {
          if (version.pages.some((v) => v.id === p.id)) continue;
          const where = after.pages.some((x) => x.id === p.id) || (after.trash || []).some((t) => t.page.id === p.id);
          expect(where, `${ctx} page ${p.id} added since`).toBe(true);
        }
      }
      // Pages and trash entries are never duplicated.
      const ids = [...after.pages.map((p) => p.id), ...(after.trash || []).map((t) => t.page.id)];
      expect(new Set(ids).size, `${ctx} duplicate page ids`).toBe(ids.length);
    }
    expect(restored).toBeGreaterThan(SEEDS / 2); // the property ran over real restores, not no-ops
  });

  function int(seed: number, lo: number, hi: number): number {
    return lo + ((seed * 2654435761) >>> 0) % (hi - lo + 1);
  }
});

describe('I1 on panelized pages: frame sources and image overlays (K2a)', () => {
  const v5 = () => normalizeDoc(historyV5Doc());
  const TAKE = 'u/user-b/p/proj-v5/img/p2-frame-take.webp';
  const STICKER = 'u/user-b/p/proj-v5/refs/sticker.webp';
  const GUIDE = 'u/user-b/p/proj-v5/refs/guide.webp';
  const bx = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
  const int = (seed: number, lo: number, hi: number): number => lo + (((seed * 2654435761) >>> 0) % (hi - lo + 1));

  /** The page shown in frames: its first frame shows another picture, plus a sticker and a guide-only overlay. */
  const panelize = (doc: ComicDoc, pageId: string, paths = { take: TAKE, sticker: STICKER, guide: GUIDE }): ComicDoc => {
    const page = doc.pages.find((p) => p.id === pageId)!;
    const n = page.panels.length;
    const h = 0.96 / n;
    return applyOps(doc, [
      {
        op: 'page_frames',
        pageId,
        artMode: 'panels',
        frames: page.panels.map((pn, i) => ({ panelId: pn.id, frame: { box: bx(0.02, 0.02 + i * h, 0.96, h - 0.02), ...(i === 0 ? { src: { path: paths.take } } : {}) } })),
        moveBalloons: false
      },
      { op: 'layer', pageId, id: 'ly_sticker', patch: { kind: 'image', box: bx(0.1, 0.1, 0.2, 0.2), src: { path: paths.sticker } } },
      { op: 'layer', pageId, id: 'ly_guide', patch: { kind: 'image', box: bx(0.5, 0.1, 0.2, 0.2), src: { path: paths.guide }, print: false } }
    ], AT - 5);
  };

  it('a restore that displaces a frame source or an overlay archives it under its page (page, page-text and book scopes)', () => {
    const version = asVersion(v5()); // before the page was put in frames: no frame source, no overlay
    const current = panelize(v5(), 'pg_2');
    const page = current.pages.find((p) => p.id === 'pg_2')!;
    expect(page.panels[0].frame?.src?.path).toBe(TAKE);
    expect(page.layers!.map((l) => l.src?.path)).toEqual([STICKER, GUIDE]);
    for (const p of [TAKE, STICKER, GUIDE]) expect(collectAssetPaths(current), p).toContain(p);

    for (const scope of [
      { kind: 'page', pageId: 'pg_2', mode: 'replace', part: 'all' },
      { kind: 'page', pageId: 'pg_2', mode: 'replace', part: 'text' },
      { kind: 'book' }
    ] as RestoreScope[]) {
      const after = restore(current, version, scope);
      const ctx = JSON.stringify(scope);
      const back = after.pages.find((p) => p.id === 'pg_2')!;
      expect(back.layers, ctx).toBeUndefined(); // the version's page had none
      expect(back.panels[0].frame?.src, ctx).toBeUndefined();
      // I1: nothing the book held is lost — the displaced pictures went to the archive, once each, under their page.
      const kept = new Set(collectAssetPaths(after));
      expect(collectAssetPaths(current).filter((p) => !kept.has(p)), ctx).toEqual([]);
      // The label says what the picture was (never just "Page 2": it is not a drawing of the page).
      for (const [path, label] of [[TAKE, 'Page 2 panel picture'], [STICKER, 'Page 2 overlay'], [GUIDE, 'Page 2 overlay']]) {
        const entries = after.archive!.filter((a) => a.path === path);
        expect(entries, `${ctx} ${path}`).toEqual([expect.objectContaining({ path, targetKey: 'page:pg_2', label, archivedAt: AT, source: 'upload', at: 0 })]);
        expect(entries[0].origin, `${ctx} ${path}`).toBeUndefined();
        expect(isPanelSourceArchive(entries[0]), `${ctx} ${path}`).toBe(true);
      }
      expect(duplicatePaths(after.archive), ctx).toEqual([]);
      expect(normalizeDoc(after), ctx).toEqual(after);
    }
  });

  it('a picture a render also holds keeps that richer home; a trashed page\'s sources archive as its Deleted page', () => {
    // The frame shows an older drawing of the page itself: when it is displaced it stays in that page's versions.
    const older = v5().pages.find((p) => p.id === 'pg_2')!.render.history[0];
    expect(older?.path).toBeTruthy();
    const version = asVersion(v5());
    const current = panelize(v5(), 'pg_2', { take: older.path, sticker: STICKER, guide: GUIDE });
    const after = restore(current, version, { kind: 'page', pageId: 'pg_2', mode: 'replace', part: 'all' });
    expect(collectAssetPaths(after)).toContain(older.path);
    expect(after.archive!.filter((a) => a.path === older.path)).toEqual([]); // still in the page's own versions
    expect(after.archive!.filter((a) => a.path === STICKER)).toHaveLength(1);

    // Deleted since, with its overlays; the whole book comes back from before: the page returns without them.
    const deleted = applyOps(panelize(v5(), 'pg_2'), [{ op: 'page_delete', id: 'pg_2', deletedAt: AT - 2 }], AT - 2);
    const fromN = trashOf(deleted).find((t) => t.page.id === 'pg_2')!.fromN;
    const reinserted = restore(deleted, version, { kind: 'book' });
    expect(reinserted.pages.map((p) => p.id)).toContain('pg_2');
    const kept = new Set(collectAssetPaths(reinserted));
    expect(collectAssetPaths(deleted).filter((p) => !kept.has(p))).toEqual([]);
    for (const [path, what] of [[TAKE, 'panel picture'], [STICKER, 'overlay'], [GUIDE, 'overlay']]) {
      const entries = reinserted.archive!.filter((a) => a.path === path);
      expect(entries, path).toEqual([expect.objectContaining({ targetKey: 'page:pg_2', label: `Deleted page ${fromN} ${what}` })]);
      expect(isPanelSourceArchive(entries[0]), path).toBe(true);
    }
  });

  it('isPanelSourceArchive: only an undated, maker-less page entry labelled as a panel picture or overlay', () => {
    const entry = { path: 'x/a.webp', w: 1, h: 1, source: 'upload' as const, at: 0, targetKey: 'page:pg_2', label: 'Page 2 overlay', archivedAt: AT };
    expect(isPanelSourceArchive(entry)).toBe(true);
    expect(isPanelSourceArchive({ ...entry, label: 'Page 2 panel picture' })).toBe(true);
    expect(isPanelSourceArchive({ ...entry, label: 'Deleted page 4 overlay' })).toBe(true);
    // A real older drawing of the page (its own label, a maker or a date) is never one.
    expect(isPanelSourceArchive({ ...entry, label: 'Page 2' })).toBe(false);
    expect(isPanelSourceArchive({ ...entry, origin: 'render' })).toBe(false);
    expect(isPanelSourceArchive({ ...entry, at: AT })).toBe(false);
    expect(isPanelSourceArchive({ ...entry, targetKey: 'cover', label: 'Cover overlay' })).toBe(false);
    expect(isPanelSourceArchive({ ...entry, targetKey: 'style_option:so_1', label: 'Style option “Neon overlay”' })).toBe(false);
    // Every archive entry of the v5 fixture (real drawings) reads as a drawing.
    for (const a of v5().archive || []) expect(isPanelSourceArchive(a), a.path).toBe(false);
  });

  it('holds on random books whose pages carry frame sources and overlays (property)', () => {
    let displaced = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const base = randomBook(seed);
      const version = asVersion(evolveBook(base, seed * 101, int(seed, 4, 20)));
      let current = evolveBook(base, seed * 7, int(seed, 6, 30));
      // Put one to three live pages in frames, each with its own pictures (fresh paths only this doc holds).
      const pages = current.pages.filter((p) => p.panels.length > 0);
      for (let i = 0; i < Math.min(pages.length, 1 + (seed % 3)); i += 1) {
        const id = pages[(seed + i * 2) % pages.length].id;
        if (current.pages.find((p) => p.id === id)!.layers?.length) continue;
        current = panelize(current, id, { take: `x/${seed}/${id}/take.webp`, sticker: `x/${seed}/${id}/sticker.webp`, guide: `x/${seed}/${id}/guide.webp` });
      }
      const scope = randomScope(version, current, seed * 13);
      const after = applyOps(current, [historyRestoreOp(restoreOps(current, version, scope), { versionId: 'v', at: AT })], AT);
      const ctx = `seed ${seed} scope ${JSON.stringify(scope)}`;
      const kept = new Set(collectAssetPaths(after));
      expect(collectAssetPaths(current).filter((p) => !kept.has(p)), ctx).toEqual([]);
      if (uniquePaths(current.archive)) expect(duplicatePaths(after.archive), ctx).toEqual([]);
      displaced += (after.archive || []).filter((a) => a.path.startsWith(`x/${seed}/`)).length;
    }
    expect(displaced).toBeGreaterThan(0); // the property really exercised the new homes
  });
});

describe('exact mode (alternative switch)', () => {
  it('replaces the sections as stored: no history push, no union; I1 holds over doc ∪ the pinned head', () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const base = randomBook(seed);
      const other = asVersion(evolveBook(base, seed * 3, 20));
      const current = evolveBook(base, seed * 5, 20);
      const head = asVersion(current); // the old line's head row, written and pinned first
      const after = restore(current, other, { kind: 'book' }, 'exact');
      const ctx = `seed ${seed}`;
      // As stored (semantically: only the newest safety verdicts/variants ride along).
      expect(diffBooks(other, after).same, ctx).toBe(true);
      // No history push: each page keeps exactly the version's older versions.
      for (const p of after.pages) expect(p.render.history.map((h) => h.path), `${ctx} ${p.id}`).toEqual(other.pages.find((x) => x.id === p.id)!.render.history.map((h) => h.path));
      // The trash belongs to the comic, not the line: the comic's Deleted pages plus the line's, minus pages live in
      // this line; forward-only records are untouched.
      const live = new Set(after.pages.map((p) => p.id));
      const expected = [...new Set([...(current.trash || []), ...(other.trash || [])].map((t) => t.page.id))].filter((id) => !live.has(id));
      expect((after.trash || []).map((t) => t.page.id).sort(), ctx).toEqual(expected.sort());
      for (const t of current.trash || []) if (!live.has(t.page.id)) expect(after.trash, ctx).toContainEqual(t);
      const ids = [...after.pages.map((p) => p.id), ...(after.trash || []).map((t) => t.page.id)];
      expect(new Set(ids).size, `${ctx} duplicate page ids`).toBe(ids.length);
      for (const k of FORWARD_ONLY) expect(after[k], `${ctx} ${k}`).toEqual(current[k]);
      // I1 over doc ∪ head.
      const kept = new Set([...collectAssetPaths(after), ...collectAssetPaths(head)]);
      expect(collectAssetPaths(current).filter((p) => !kept.has(p)), ctx).toEqual([]);
      expect(normalizeDoc(after), ctx).toEqual(after);
    }
  });

  it('a switch there and back gives the same book', () => {
    const a = normalizeDoc(historyV5Doc());
    const b = asVersion(evolveBook(a, 99, 30));
    const headA = asVersion(a);
    const back = restore(restore(a, b, { kind: 'book' }, 'exact'), headA, { kind: 'book' }, 'exact');
    expect(diffBooks(headA, back).same).toBe(true);
    expect((back.trash || []).map((t) => t.page.id)).toEqual((headA.trash || []).map((t) => t.page.id));
    const paths = new Set(collectAssetPaths(back));
    expect(collectAssetPaths(headA).filter((p) => !paths.has(p))).toEqual([]);
  });

  it('the line\'s Deleted pages join the comic\'s, newest first, capped at MAX_TRASH with the overflow archived', () => {
    const base = normalizeDoc(historyV5Doc());
    const template = base.trash![0];
    const trashed = (id: string, deletedAt: number) => ({
      ...template,
      page: { ...template.page, id, render: { ...template.page.render, asset: { ...template.page.render.asset!, path: `x/${id}.webp` }, history: [] } },
      deletedAt
    });
    const current = { ...base, trash: Array.from({ length: MAX_TRASH }, (_, i) => trashed(`pg_t${i}`, AT - 1000 - i)) };
    const other = asVersion({ ...base, trash: [trashed('pg_b1', AT - 10), trashed('pg_b2', AT - 20)] });
    const after = restore(current, other, { kind: 'book' }, 'exact');
    expect(after.trash).toHaveLength(MAX_TRASH);
    expect(after.trash!.slice(0, 2).map((t) => t.page.id)).toEqual(['pg_b1', 'pg_b2']);
    // The two oldest of the comic's Deleted pages no longer fit: their drawings go to the archive, each once.
    for (const id of [`pg_t${MAX_TRASH - 2}`, `pg_t${MAX_TRASH - 1}`]) {
      expect(after.trash!.some((t) => t.page.id === id)).toBe(false);
      expect(after.archive!.filter((a) => a.path === `x/${id}.webp`)).toHaveLength(1);
    }
    expect(duplicatePaths(after.archive)).toEqual([]);
    expect(normalizeDoc(after)).toEqual(after);
  });

  it('a switch there and back keeps a page this line redrew and deleted while the other line still has it live', () => {
    // Line A: page 3 redrawn, then deleted. Line B (made before that): page 3 is live there.
    const b = asVersion(normalizeDoc(historyV5Doc()));
    const a = applyOps(
      normalizeDoc(historyV5Doc()),
      [
        { op: 'render', target: { kind: 'page', id: 'pg_3' }, patch: { status: 'ready', asset: { path: 'x/p3-A.webp', source: 'generated', at: AT - 50 } } },
        { op: 'page_delete', id: 'pg_3', deletedAt: AT - 20 }
      ],
      AT - 20
    );
    const headA = asVersion(a);
    expect((headA.trash || []).map((t) => t.page.id)).toEqual(['pg_3', 'pg_old']);
    const onB = restore(a, b, { kind: 'book' }, 'exact');
    expect(onB.pages.some((p) => p.id === 'pg_3')).toBe(true);
    expect((onB.trash || []).map((t) => t.page.id)).toEqual(['pg_old']); // live in B, so not also "deleted"
    const back = restore(onB, headA, { kind: 'book' }, 'exact');
    expect((back.trash || []).map((t) => t.page.id)).toEqual(['pg_3', 'pg_old']);
    expect(back.trash![0]).toEqual(headA.trash![0]);
    expect(collectAssetPaths(back)).toContain('x/p3-A.webp');
    const paths = new Set(collectAssetPaths(back));
    expect(collectAssetPaths(headA).filter((p) => !paths.has(p))).toEqual([]);
    expect(diffBooks(headA, back).same).toBe(true);
  });
});

describe('per-scope restores on the fixtures', () => {
  const v5 = () => normalizeDoc(historyV5Doc());
  const NEW = 'u/user-b/p/proj-v5/img/p1-new.webp';

  it('page restore pushes the current art into history, overflowing the oldest version into the archive', () => {
    const version = asVersion(v5());
    // Since then page 1 was redrawn: the version's art went into history, whose oldest version went to the archive.
    const current = applyOps(v5(), [{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { status: 'ready', asset: { path: NEW, source: 'generated', at: AT - 10 }, origin: 'render' } }], AT - 10);
    expect(current.pages[0].render.history).toHaveLength(MAX_RENDER_HISTORY);
    const archived = current.archive!.length;
    const after = restore(current, version, { kind: 'page', pageId: 'pg_1', mode: 'replace', part: 'art' });
    const r = after.pages[0].render;
    expect(r.asset!.path).toBe(version.pages[0].render.asset!.path); // the version's drawing is current again
    expect(r.history[0].path).toBe(NEW); // the newer drawing stays in that page's versions
    expect(r.history).toHaveLength(MAX_RENDER_HISTORY);
    // The overflowed oldest version (p1-v1) is already in the archive since the redraw: it is not archived again.
    expect(after.archive!.filter((a) => a.path.endsWith('/p1-v1.webp'))).toHaveLength(1);
    expect(after.archive!.length).toBe(archived);
    for (const p of collectAssetPaths(current)) expect(collectAssetPaths(after)).toContain(p);

    // Nine redraws since: the page's versions are all later drawings. Restoring the version's art overflows the
    // oldest later drawing, which nothing else references: it goes to the archive once, labelled for its page.
    let busy = v5();
    for (let n = 1; n <= 9; n += 1) {
      busy = applyOps(busy, [{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { status: 'ready', asset: { path: `x/p1-r${n}.webp`, source: 'generated', at: AT - 100 + n }, origin: 'render' } }], AT - 100 + n);
    }
    expect(busy.pages[0].render.history.map((h) => h.path)).toContain('x/p1-r1.webp');
    const again = restore(busy, version, { kind: 'page', pageId: 'pg_1', mode: 'replace', part: 'art' });
    expect(again.pages[0].render.asset!.path).toBe(version.pages[0].render.asset!.path);
    expect(again.pages[0].render.history[0].path).toBe('x/p1-r9.webp');
    expect(again.archive!.length).toBe(busy.archive!.length + 1);
    expect(again.archive!.filter((a) => a.path === 'x/p1-r1.webp')).toEqual([expect.objectContaining({ targetKey: 'page:pg_1', label: 'Page 1', archivedAt: AT })]);
    expect(duplicatePaths(again.archive)).toEqual([]);
    for (const p of collectAssetPaths(busy)) expect(collectAssetPaths(again)).toContain(p);
  });

  it('restore → Undo → restore never archives a path twice (the archive stays put after the first cycle)', () => {
    const redraw = (doc: ComicDoc, n: number) =>
      applyOps(doc, [{ op: 'render', target: { kind: 'page', id: 'pg_1' }, patch: { status: 'ready', asset: { path: `x/p1-later${n}.webp`, source: 'generated', at: AT - 100 + n }, origin: 'render' } }], AT - 100 + n);
    const version = asVersion(v5());
    const current = redraw(redraw(v5(), 1), 2); // two redraws since: the version's older drawings went to the archive
    expect(duplicatePaths(current.archive)).toEqual([]);
    for (const scope of [{ kind: 'page', pageId: 'pg_1', mode: 'replace', part: 'art' }, { kind: 'book' }] as RestoreScope[]) {
      let doc = current;
      const lengths: number[] = [];
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const beforeRow = asVersion(doc); // the awaited before_restore row
        doc = restore(doc, version, scope);
        expect(duplicatePaths(doc.archive), `${scope.kind} restore ${cycle}`).toEqual([]);
        doc = restore(doc, beforeRow, scope); // Undo: the before row, same scope
        expect(duplicatePaths(doc.archive), `${scope.kind} undo ${cycle}`).toEqual([]);
        for (const p of collectAssetPaths(current)) expect(collectAssetPaths(doc), `${scope.kind} ${cycle} ${p}`).toContain(p);
        lengths.push(doc.archive!.length);
      }
      expect(lengths[1], scope.kind).toBe(lengths[0]);
      expect(lengths[2], scope.kind).toBe(lengths[0]);
    }
  });

  it('a whole-book restore adds each archived path once, even when the version listed it twice', () => {
    const extra = { path: 'x/old-board.webp', source: 'generated' as const, at: 1, targetKey: 'page:pg_1', label: 'Page 1', archivedAt: BOOK_NOW - 1 };
    const stored = v5();
    const version = asVersion({ ...stored, archive: [extra, { ...extra, targetKey: 'cover', label: 'Cover' }, ...(stored.archive || [])] });
    const after = restore(v5(), version, { kind: 'book' });
    expect(after.archive!.filter((a) => a.path === extra.path)).toHaveLength(1);
    expect(duplicatePaths(after.archive)).toEqual([]);
  });

  it('a page deleted since is re-inserted at its old index, with its later drawings kept', () => {
    const version = asVersion(v5());
    const current = applyOps(
      v5(),
      [
        { op: 'render', target: { kind: 'page', id: 'pg_3' }, patch: { status: 'ready', asset: { path: 'x/p3-later.webp', source: 'generated', at: AT - 50 } } },
        { op: 'page_delete', id: 'pg_3', deletedAt: AT - 20 }
      ],
      AT - 20
    );
    expect(current.pages.map((p) => p.id)).toEqual(['pg_1', 'pg_2', 'pg_4', 'pg_5', 'pg_6']);
    const after = restore(current, version, { kind: 'page', pageId: 'pg_3', mode: 'replace', part: 'all' });
    expect(after.pages.map((p) => p.id)).toEqual(['pg_1', 'pg_2', 'pg_3', 'pg_4', 'pg_5', 'pg_6']);
    expect(after.pages[2].n).toBe(3);
    expect(after.format.pageCount).toBe(6);
    expect((after.trash || []).some((t) => t.page.id === 'pg_3')).toBe(false);
    expect(after.pages[2].render.history.map((h) => h.path)).toContain('x/p3-later.webp');
  });

  it('whole book: pages added since go to Deleted; editions and characters added since are kept', () => {
    const version = asVersion(v5());
    const current = applyOps(
      v5(),
      [
        { op: 'page_insert', id: 'pg_new', after: 2, patch: { summary: 'A new page' } },
        { op: 'character', id: 'ch_new', patch: { name: 'Dhruv', tier: 'support', look: { summary: 'new friend' } } },
        { op: 'edition', lang: 'ta', patch: { register: 'everyday' } },
        { op: 'translation', lang: 'ta', lineId: 'pg_1_l2', patch: { text: 'இன்னும் ஒன்று', status: 'edited', sourceHash: 'h', at: AT - 5 } },
        { op: 'line', pageId: 'pg_2', panelId: 'pg_2_p2', id: 'pg_2_l2', patch: { text: 'Changed my mind.' } }
      ],
      AT - 5
    );
    const effects = restoreEffects(current, version);
    expect(effects).toMatchObject({ pagesToDeleted: ['pg_new'], keptCast: ['ch_new'], keptEditions: ['ta'] });
    const after = restore(current, version, { kind: 'book' });
    expect(after.pages.map((p) => p.id)).toEqual(version.pages.map((p) => p.id));
    expect(after.trash![0]).toMatchObject({ page: { id: 'pg_new', summary: 'A new page' }, fromN: 3, deletedAt: AT });
    expect(after.cast.map((c) => c.id)).toEqual(['ch_maya', 'ch_arjun', 'ch_cat', 'ch_new']);
    expect(i18nOf(after).editions.ta.lines.pg_1_l2.text).toBe('இன்னும் ஒன்று');
    expect(after.pages[1].panels[1].lines[0].text).toBe(version.pages[1].panels[1].lines[0].text);
    expect(diffBooks(version, after).pages).toEqual([]);
  });

  it('text restore keeps the art (stale honestly); art restore keeps the text', () => {
    const version = asVersion(v5());
    const verdict = { assessed: 'PG' as const, at: AT - 2, by: 'check' as const };
    const variants = [{ path: 'x/p2_w480.webp', w: 480, h: 720 }];
    const current = applyOps(
      v5(),
      [
        { op: 'panel', pageId: 'pg_2', id: 'pg_2_p2', patch: { action: 'Maya drops the tin' } },
        { op: 'render', target: { kind: 'page', id: 'pg_2' }, patch: { status: 'ready', asset: { path: 'x/p2-new.webp', source: 'generated', at: AT - 3 } } },
        // Since the version: a newer safety verdict and new size variants for the drawing the version had.
        { op: 'asset_meta', path: version.pages[1].render.asset!.path, patch: { safety: verdict, variants } }
      ],
      AT - 2
    );
    expect(version.pages[1].render.asset!.safety).not.toEqual(verdict); // the stored version still has the old verdict
    const text = restore(current, version, { kind: 'page', pageId: 'pg_2', mode: 'replace', part: 'text' });
    expect(text.pages[1].panels[1].action).toBe(version.pages[1].panels[1].action);
    expect(text.pages[1].render.asset!.path).toBe('x/p2-new.webp');
    const art = restore(current, version, { kind: 'page', pageId: 'pg_2', mode: 'replace', part: 'art' });
    expect(art.pages[1].panels[1].action).toBe('Maya drops the tin');
    expect(art.pages[1].render.asset!.path).toBe(version.pages[1].render.asset!.path);
    // A restored image keeps the live doc's newest verdict and variants (I3: forward-only image metadata).
    expect(art.pages[1].render.asset!.safety).toEqual(verdict);
    expect(art.pages[1].render.asset!.variants).toEqual(variants);
  });

  it('line and panel restores bring back that text and its translations only', () => {
    const version = asVersion(v5());
    const current = applyOps(
      v5(),
      [
        { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p3', id: 'pg_1_l3', patch: { text: 'Fine, keep it.' } },
        { op: 'translation', lang: 'te', lineId: 'pg_1_l3', patch: { text: 'సరే', status: 'edited' } },
        { op: 'line', pageId: 'pg_1', panelId: 'pg_1_p2', id: 'pg_1_l2', patch: { text: 'Not this one.' } }
      ],
      AT - 2
    );
    const after = restore(current, version, { kind: 'line', pageId: 'pg_1', lineId: 'pg_1_l3' });
    expect(after.pages[0].panels[2].lines[0].text).toBe(version.pages[0].panels[2].lines[0].text);
    expect(i18nOf(after).editions.te.lines.pg_1_l3.text).toBe(i18nOf(version).editions.te.lines.pg_1_l3.text);
    expect(after.pages[0].panels[1].lines[0].text).toBe('Not this one.'); // untouched
    const panel = restore(current, version, { kind: 'panel', pageId: 'pg_1', panelId: 'pg_1_p2' });
    expect(panel.pages[0].panels[1].lines[0].text).toBe(version.pages[0].panels[1].lines[0].text);
    expect(panel.pages[0].panels[2].lines[0].text).toBe('Fine, keep it.');
  });

  it('character restore swaps the sheet into its history and re-adds a removed character at its old index', () => {
    const version = asVersion(v5());
    const current = applyOps(v5(), [{ op: 'character_remove', id: 'ch_arjun' }], AT - 1);
    const after = restore(current, version, { kind: 'character', id: 'ch_arjun' });
    expect(after.cast.map((c) => c.id)).toEqual(['ch_maya', 'ch_arjun', 'ch_cat']);
  });

  it('language restore brings the edition back (version wins for its lines, later lines kept)', () => {
    const version = asVersion(v5());
    const current = applyOps(
      v5(),
      [
        { op: 'translation', lang: 'te', lineId: 'pg_1_l1', patch: { text: 'AI re-translation', status: 'machine' } },
        { op: 'translation', lang: 'te', lineId: 'pg_3_l1', patch: { text: 'later line', status: 'edited', sourceHash: 'h', at: 1 } }
      ],
      AT - 1
    );
    const after = restore(current, version, { kind: 'language', lang: 'te' });
    const te = i18nOf(after).editions.te.lines;
    expect(te.pg_1_l1.text).toBe(i18nOf(version).editions.te.lines.pg_1_l1.text);
    expect(te.pg_3_l1.text).toBe('later line');
  });

  it('cover, script and style restores touch only their section', () => {
    const version = asVersion(v5());
    const current = applyOps(
      v5(),
      [
        { op: 'cover', patch: { title: 'New title' } },
        { op: 'source', patch: { script: 'Rewritten' } },
        { op: 'style', patch: { spec: 'Neon noir' } }
      ],
      AT - 1
    );
    expect(restore(current, version, { kind: 'cover', part: 'text' }).cover.title).toBe('The Saffron Thief');
    expect(restore(current, version, { kind: 'script' }).source.script).toBe(version.source.script);
    const styled = restore(current, version, { kind: 'style' });
    expect(styled.style.spec).toBe(version.style.spec);
    expect(styled.source.script).toBe('Rewritten');
  });

  it('a details-only restore keeps the planned page count in step with the pages', () => {
    const version = asVersion(v5());
    const current = applyOps(v5(), [{ op: 'page_insert', id: 'pg_extra', after: 6 }, { op: 'brief', patch: { tone: 'grim' } }], AT - 1);
    expect(current.format.pageCount).toBe(7);
    const after = restore(current, version, { kind: 'keys', keys: ['meta'] });
    expect(after.brief.tone).toBe(version.brief.tone);
    expect(after.pages).toHaveLength(7);
    expect(after.format.pageCount).toBe(7);
  });

  it('every meta key beyond the typed ones comes back (K2a scenes/consistency travel the same way): book, meta key, switch', () => {
    // Keys TOP_LEVEL_SECTIONS does not list ride in the meta section; once K2a lists scenes/consistency as 'meta'
    // they take exactly this path (isExtraMetaKey), with no change to restore.ts or apply.ts.
    const extra = (doc: ComicDoc, values: Record<string, unknown>): ComicDoc => {
      const out = { ...doc } as unknown as Record<string, unknown>;
      for (const [k, v] of Object.entries(values)) {
        if (v === undefined) delete out[k];
        else out[k] = v;
      }
      return out as unknown as ComicDoc;
    };
    const get = (doc: ComicDoc, k: string) => (doc as unknown as Record<string, unknown>)[k];
    const then = asVersion(extra(v5(), { scenesFromTheFuture: [{ id: 'sc_1', name: 'Market' }], tidbitsThen: { a: 1 } }));
    const now = extra(v5(), { scenesFromTheFuture: [{ id: 'sc_1', name: 'Rooftops' }, { id: 'sc_2', name: 'Chase' }], keysAddedSince: { b: 2 } });
    expect(diffBooks(then, now).meta).toEqual(['keysAddedSince', 'scenesFromTheFuture', 'tidbitsThen']);
    const check = (after: ComicDoc, ctx: string) => {
      expect(get(after, 'scenesFromTheFuture'), ctx).toEqual([{ id: 'sc_1', name: 'Market' }]);
      expect(get(after, 'tidbitsThen'), ctx).toEqual({ a: 1 });
      expect('keysAddedSince' in after, ctx).toBe(false);
      expect(diffBooks(then, after).meta, ctx).toEqual([]);
      expect(normalizeDoc(after), ctx).toEqual(after);
    };
    check(restore(now, then, { kind: 'book' }), 'book');
    check(restore(now, then, { kind: 'keys', keys: ['meta'] }), 'meta key (undo the last AI change)');
    check(restore(now, then, { kind: 'book' }, 'exact'), 'switch');
    // Server == client over the wire (the wire turns undefined into null; both remove the key).
    const op = historyRestoreOp({ metaExtra: { scenesFromTheFuture: null, keysAddedSince: undefined, tidbitsThen: { a: 1 } } }, { versionId: 'v', at: AT });
    expect(applyOps(wireDoc(now), [overTheWire(op)], AT)).toEqual(wireDoc(applyOps(now, [op], AT)));
    // metaExtra never reaches forward-only, identity or other-section keys.
    // (JSON.parse makes "__proto__" an own key, as a crafted wire payload would.)
    const metaExtra = { ...JSON.parse('{"__proto__": {"polluted": true}}'), spend: { totalUsd: 0, byKind: {}, entries: [] }, conversation: [], pages: [], settings: null, imageModel: null, rev: 0, brief: null };
    expect(Object.keys(metaExtra)).toContain('__proto__');
    const kept = applyOps(now, [historyRestoreOp({ metaExtra }, { versionId: 'v', at: AT })], AT);
    for (const k of [...FORWARD_ONLY, 'pages', 'brief', 'rev'] as const) expect(kept[k], k).toEqual(now[k]);
    expect(Object.getPrototypeOf(kept)).toBe(Object.prototype);
    expect((kept as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('works on the v4 and empty fixtures', () => {
    const v4 = asVersion(historyV4Doc());
    const current = applyOps(normalizeDoc(historyV4Doc()), [{ op: 'page_delete', id: 'pg_2', deletedAt: AT - 1 }], AT - 1);
    const after = restore(current, v4, { kind: 'book' });
    expect(after.pages.map((p: Page) => p.id)).toEqual(['pg_1', 'pg_2', 'pg_3', 'pg_4', 'pg_5']);
    expect(normalizeDoc(after)).toEqual(after);
    const empty = normalizeDoc(historyEmptyDoc());
    const grown = applyOps(empty, [{ op: 'page_insert', id: 'pg_a', after: 0 }], AT - 1);
    const reset = restore(grown, asVersion(empty), { kind: 'book' });
    expect(reset.pages).toEqual([]);
    expect(reset.trash![0].page.id).toBe('pg_a');
  });
});
