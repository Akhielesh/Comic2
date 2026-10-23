// Timeline patch sanitizers (contract §5.4): bounded, server-stamped, whole-batch rejection,
// busy pages → 409, render_use allow-list (only this comic's own images, never blocked ones).
import { describe, expect, it } from 'vitest';
import { applyOps, type DocOp } from '../../../../shared/comic/ops.js';
import { emptyRender, isPageStale, pageSpecHash, type AssetRef, type ComicDoc, type RefAsset } from '../../../../shared/comic/doc.js';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities.js';
import { plannedDoc } from '../orchestrator.fakes.js';
import { sanitizePatchOps } from '../jobs.js';
import { opSanitizerFor } from './index.js';
import { TIMELINE_SANITIZERS, assetIndex, pageCapFor, type AssetIndexEntry } from './timeline.js';
import type { SanitizeCtx } from '../extensions.js';
import { StudioError } from '../types.js';

const NOW = 1_800_000_000_000;
const sctx = (over: Partial<SanitizeCtx> = {}): SanitizeCtx => ({ userId: 'user-1', caps: DEFAULT_CAPS, rating: 'PG-13', now: NOW, ...over });

const asset = (path: string, extra: Partial<AssetRef> = {}): AssetRef => ({ path, source: 'generated', at: 1, w: 800, h: 1000, ...extra });

/** Page 1 drawn with one earlier version, page 2 drawing, page 3 planned; a ref photo, an attachment, a trashed page, an archive entry. */
const fixture = (): ComicDoc => {
  const doc = plannedDoc();
  doc.format = { ...doc.format, pageAspect: '4:5' };
  const ref: RefAsset = { path: 'u/user-1/p/proj-1/ref/maya.webp', source: 'upload', at: 2, w: 600, h: 600 };
  doc.cast = doc.cast.map((c) => (c.id === 'c_maya' ? { ...c, refs: [ref], sheet: { status: 'ready', asset: asset('u/user-1/p/proj-1/img/maya-sheet.webp'), history: [] } } : c));
  const [p1, p2, p3] = doc.pages;
  doc.pages = [
    { ...p1, render: { status: 'ready', asset: asset('u/user-1/p/proj-1/img/p1-v2.webp', { at: 20 }), history: [asset('u/user-1/p/proj-1/img/p1-v1.webp', { at: 10 })], specHash: pageSpecHash(doc, p1) } },
    { ...p2, render: { status: 'rendering', history: [asset('u/user-1/p/proj-1/img/p2-v1.webp')] } },
    { ...p3, render: emptyRender() }
  ];
  doc.conversation = [{ id: 'm1', role: 'user', text: 'here', at: 1, attachments: [{ path: 'u/user-1/p/proj-1/img/attach.webp', source: 'upload', at: 3 }] }];
  doc.trash = [{ page: { ...p3, id: 'pg_gone', n: 4, render: { status: 'ready', asset: asset('u/user-1/p/proj-1/img/gone.webp'), history: [] } }, fromN: 4, deletedAt: 5 }];
  doc.archive = [{ ...asset('u/user-1/p/proj-1/img/p1-v0.webp', { at: 5 }), targetKey: 'page:pg_1', label: 'Page 1', archivedAt: 6 }];
  return doc;
};

const run = (doc: ComicDoc, op: Record<string, unknown>, ctx = sctx()) => {
  const s = opSanitizerFor(String(op.op));
  if (!s) throw new Error(`no sanitizer for ${String(op.op)}`);
  return s.sanitize(doc, op as unknown as DocOp, ctx);
};

const rejects = (fn: () => unknown, status: number, code?: string) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(StudioError);
    expect((err as StudioError).status).toBe(status);
    if (code) expect((err as StudioError).code).toBe(code);
    return err as StudioError;
  }
  throw new Error('expected a rejection');
};

describe('registry', () => {
  it('owns every timeline op (no stub left)', () => {
    const ops = ['pages_reorder', 'page_insert', 'page_duplicate', 'page_delete', 'page_restore', 'book', 'render_use', 'version_star'];
    expect(TIMELINE_SANITIZERS.map((s) => s.op)).toEqual(ops);
    for (const op of ops) expect(opSanitizerFor(op)).toBe(TIMELINE_SANITIZERS.find((s) => s.op === op));
  });

  it('page cap: DOC_LIMITS.pages, lowered (never raised) by caps.maxPages', () => {
    expect(pageCapFor(sctx())).toBe(40);
    expect(pageCapFor(sctx({ caps: { ...DEFAULT_CAPS, maxPages: 3 } }))).toBe(3);
    expect(pageCapFor(sctx({ caps: { ...DEFAULT_CAPS, maxPages: 999 } }))).toBe(40);
  });
});

describe('pages_reorder', () => {
  it('accepts a full or partial order of existing pages', () => {
    const doc = fixture();
    expect(run(doc, { op: 'pages_reorder', order: ['pg_3', 'pg_1', 'pg_2'] })).toEqual({ op: 'pages_reorder', order: ['pg_3', 'pg_1', 'pg_2'] });
    expect(run(doc, { op: 'pages_reorder', order: ['pg_2'] })).toEqual({ op: 'pages_reorder', order: ['pg_2'] });
  });
  it('rejects duplicates, unknown ids, unsafe ids, empty and oversized orders', () => {
    const doc = fixture();
    rejects(() => run(doc, { op: 'pages_reorder', order: ['pg_1', 'pg_1'] }), 400);
    rejects(() => run(doc, { op: 'pages_reorder', order: ['pg_1', 'pg_nope'] }), 400);
    rejects(() => run(doc, { op: 'pages_reorder', order: ['../etc'] }), 400);
    rejects(() => run(doc, { op: 'pages_reorder', order: [] }), 400);
    rejects(() => run(doc, { op: 'pages_reorder', order: 'pg_1' }), 400);
    rejects(() => run(doc, { op: 'pages_reorder', order: Array.from({ length: 201 }, (_, i) => `pg_${i}`) }), 400);
  });
  it('reordering a busy page is allowed (nothing is lost) and nothing goes stale', () => {
    const doc = fixture();
    const ops = sanitizePatchOps(doc, [{ op: 'pages_reorder', order: ['pg_2', 'pg_1'] }], sctx());
    const after = applyOps(doc, ops);
    expect(after.pages.map((p) => [p.id, p.n])).toEqual([
      ['pg_2', 1],
      ['pg_1', 2],
      ['pg_3', 3]
    ]);
    expect(isPageStale(after, after.pages[1])).toBe(false);
  });
});

describe('page_insert', () => {
  it('trims the patch to the page pick and keeps the chapter title within limits', () => {
    const op = run(fixture(), { op: 'page_insert', id: 'pg_new', after: 1, patch: { summary: '  A storm.  ', layout: 'Row 1', chapterTitle: 'x'.repeat(90), evil: '<script>' } });
    expect(op).toEqual({ op: 'page_insert', id: 'pg_new', after: 1, patch: { summary: 'A storm.', layout: 'Row 1', chapterTitle: 'x'.repeat(60) } });
  });
  it('rejects existing or trashed ids, out-of-range positions and unsafe ids', () => {
    const doc = fixture();
    rejects(() => run(doc, { op: 'page_insert', id: 'pg_1', after: 0 }), 400);
    rejects(() => run(doc, { op: 'page_insert', id: 'pg_gone', after: 0 }), 400);
    rejects(() => run(doc, { op: 'page_insert', id: 'pg_new', after: 4 }), 400);
    rejects(() => run(doc, { op: 'page_insert', id: 'pg_new', after: -1 }), 400);
    rejects(() => run(doc, { op: 'page_insert', id: 'pg_new', after: 1.5 }), 400);
    rejects(() => run(doc, { op: 'page_insert', id: 'a b', after: 0 }), 400);
  });
  it('409 LIMIT at the page cap', () => {
    const err = rejects(() => run(fixture(), { op: 'page_insert', id: 'pg_new', after: 0 }, sctx({ caps: { ...DEFAULT_CAPS, maxPages: 3 } })), 409, 'LIMIT');
    expect(err.userMessage).toMatch(/up to 3 pages/);
  });
});

describe('page_duplicate / page_delete (busy page → 409)', () => {
  it('refuses to duplicate or delete a page that is drawing', () => {
    const doc = fixture();
    expect(rejects(() => run(doc, { op: 'page_duplicate', id: 'pg_2', newId: 'pg_copy' }), 409, 'CONFLICT').userMessage).toMatch(/still drawing/);
    expect(rejects(() => run(doc, { op: 'page_delete', id: 'pg_2', deletedAt: 1 }), 409, 'CONFLICT').userMessage).toMatch(/still drawing/);
  });
  it('the whole batch is rejected when one op is busy', () => {
    rejects(
      () =>
        sanitizePatchOps(
          fixture(),
          [
            { op: 'pages_reorder', order: ['pg_3'] },
            { op: 'page_delete', id: 'pg_2', deletedAt: 1 }
          ],
          sctx()
        ),
      409
    );
  });
  it('duplicate: newId must be new, safe and ≤ 52 chars; the cap applies', () => {
    const doc = fixture();
    expect(run(doc, { op: 'page_duplicate', id: 'pg_1', newId: 'pg_copy', after: 3 })).toEqual({ op: 'page_duplicate', id: 'pg_1', newId: 'pg_copy', after: 3 });
    rejects(() => run(doc, { op: 'page_duplicate', id: 'pg_1', newId: 'p'.repeat(53) }), 400);
    rejects(() => run(doc, { op: 'page_duplicate', id: 'pg_1', newId: 'pg_3' }), 400);
    rejects(() => run(doc, { op: 'page_duplicate', id: 'pg_1', newId: 'pg_copy' }, sctx({ caps: { ...DEFAULT_CAPS, maxPages: 3 } })), 409, 'LIMIT');
  });
  it('delete: the server stamps deletedAt (client value ignored); purge passes only as true', () => {
    const doc = fixture();
    expect(run(doc, { op: 'page_delete', id: 'pg_1', deletedAt: 1 })).toEqual({ op: 'page_delete', id: 'pg_1', deletedAt: NOW });
    expect(run(doc, { op: 'page_delete', id: 'pg_3', deletedAt: 1, purge: 'yes' })).toEqual({ op: 'page_delete', id: 'pg_3', deletedAt: NOW });
    expect(run(doc, { op: 'page_delete', id: 'pg_3', deletedAt: 1, purge: true })).toEqual({ op: 'page_delete', id: 'pg_3', deletedAt: NOW, purge: true });
    rejects(() => run(doc, { op: 'page_delete', id: 'pg_nope', deletedAt: 1 }), 400);
  });
});

describe('page_restore', () => {
  it('restores from the trash at an optional position; anything else is refused', () => {
    const doc = fixture();
    expect(run(doc, { op: 'page_restore', id: 'pg_gone' })).toEqual({ op: 'page_restore', id: 'pg_gone' });
    expect(run(doc, { op: 'page_restore', id: 'pg_gone', n: 2 })).toEqual({ op: 'page_restore', id: 'pg_gone', n: 2 });
    rejects(() => run(doc, { op: 'page_restore', id: 'pg_1' }), 400);
    rejects(() => run(doc, { op: 'page_restore', id: 'pg_gone', n: 0 }), 400);
    rejects(() => run(doc, { op: 'page_restore', id: 'pg_gone' }, sctx({ caps: { ...DEFAULT_CAPS, maxPages: 3 } })), 409, 'LIMIT');
  });
});

describe('book', () => {
  it('keeps only valid keys with bounded text', () => {
    const op = run(fixture(), { op: 'book', patch: { titlePage: true, backCover: 'auto', blurb: '  Big day.  ', credits: ['Story: Maya', '  ', 'Art: AI'], unknown: 1 } });
    expect(op).toEqual({ op: 'book', patch: { titlePage: true, backCover: 'auto', blurb: 'Big day.', credits: ['Story: Maya', 'Art: AI'] } });
    expect(run(fixture(), { op: 'book', patch: { blurb: null } })).toEqual({ op: 'book', patch: { blurb: null } });
  });
  it('rejects bad enums, oversize text and empty patches', () => {
    const doc = fixture();
    rejects(() => run(doc, { op: 'book', patch: { backCover: 'art' } }), 400);
    rejects(() => run(doc, { op: 'book', patch: { titlePage: 'yes' } }), 400);
    rejects(() => run(doc, { op: 'book', patch: { blurb: 'x'.repeat(601) } }), 400);
    rejects(() => run(doc, { op: 'book', patch: { credits: Array.from({ length: 9 }, () => 'c') } }), 400);
    rejects(() => run(doc, { op: 'book', patch: { credits: ['x'.repeat(121)] } }), 400);
    rejects(() => run(doc, { op: 'book', patch: {} }), 400);
  });
});

describe('render_use allow-list', () => {
  it('own history and own archive versions; server stamps `at`', () => {
    const doc = fixture();
    expect(run(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'u/user-1/p/proj-1/img/p1-v1.webp', at: 1 })).toEqual({
      op: 'render_use',
      target: { kind: 'page', id: 'pg_1' },
      path: 'u/user-1/p/proj-1/img/p1-v1.webp',
      at: NOW
    });
    expect(run(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'u/user-1/p/proj-1/img/p1-v0.webp', at: 1 })).toMatchObject({ at: NOW });
  });
  it('another page’s art (or a deleted page’s) is fine without adopt; a photo/attachment/sheet needs adopt:true (stripped)', () => {
    const doc = fixture();
    expect(run(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_3' }, path: 'u/user-1/p/proj-1/img/p1-v2.webp', at: 1 })).toMatchObject({ path: 'u/user-1/p/proj-1/img/p1-v2.webp' });
    expect(run(doc, { op: 'render_use', target: { kind: 'cover' }, path: 'u/user-1/p/proj-1/img/gone.webp', at: 1 })).toMatchObject({ target: { kind: 'cover' } });
    for (const path of ['u/user-1/p/proj-1/ref/maya.webp', 'u/user-1/p/proj-1/img/attach.webp', 'u/user-1/p/proj-1/img/maya-sheet.webp']) {
      rejects(() => run(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_3' }, path, at: 1 }), 400);
      const ok = run(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_3' }, path, at: 1, adopt: true });
      expect(ok).toEqual({ op: 'render_use', target: { kind: 'page', id: 'pg_3' }, path, at: NOW });
      expect('adopt' in ok).toBe(false);
    }
  });
  // S6: only images the server made for THIS comic (its img/ref lanes, or the platform library) can
  // become page or cover art. Legacy-imported refs live in client-writable lanes (<uid>/file,
  // u/<uid>/tmp/…) or another project's lane, so adopting them is refused — even for docs imported
  // before the import re-encode existed.
  it('adopt refuses refs that are not server-made for this comic (legacy, tmp, another project), on pages and the cover', () => {
    const doc = fixture();
    const foreign = ['4dd985b1-0000-4000-8000-000000000000/x.png', 'user-1/x.png', 'u/user-1/tmp/a.png', 'u/user-1/p/old-proj/img/x.webp', 'u/user-1/p/old-proj/ref/x.webp', 'u/someone-else/p/proj-1/ref/x.webp'];
    doc.cast = doc.cast.map((c) => (c.id === 'c_maya' ? { ...c, refs: [...(c.refs || []), ...foreign.map((path) => ({ path, source: 'upload' as const, at: 2 }))] } : c));
    doc.style = { ...doc.style, refs: [{ path: 'u/user-1/tmp/style.png', source: 'upload', at: 2 }] };
    for (const path of [...foreign, 'u/user-1/tmp/style.png']) {
      expect(assetIndex(doc).has(path)).toBe(true);
      const err = rejects(() => run(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_3' }, path, at: 1, adopt: true }), 400, 'BAD_REQUEST');
      expect(err.message).toMatch(/upload it again/i);
      rejects(() => run(doc, { op: 'render_use', target: { kind: 'cover' }, path, at: 1, adopt: true }), 400, 'BAD_REQUEST');
    }
    // This comic's own lanes and the platform library still adopt.
    doc.style = { ...doc.style, refs: [{ path: 'library/v1/hero/2.webp', source: 'upload', at: 2 }] };
    for (const path of ['u/user-1/p/proj-1/ref/maya.webp', 'u/user-1/p/proj-1/img/attach.webp', 'library/v1/hero/2.webp']) {
      expect(run(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_3' }, path, at: 1, adopt: true })).toMatchObject({ path });
    }
  });
  it('a foreign path that already sits in the doc as other art still cannot move onto a page; own versions are untouched', () => {
    const doc = fixture();
    // e.g. a beta-era doc whose deleted page held an adopted legacy image.
    doc.trash = [{ ...doc.trash![0], page: { ...doc.trash![0].page, render: { status: 'ready', asset: asset('u/user-1/tmp/old.png', { source: 'upload' }), history: [] } } }];
    rejects(() => run(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_3' }, path: 'u/user-1/tmp/old.png', at: 1 }), 400, 'BAD_REQUEST');
    rejects(() => run(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_3' }, path: 'u/user-1/tmp/old.png', at: 1, adopt: true }), 400, 'BAD_REQUEST');
    // Switching between a page's own versions is never affected by the provenance rule.
    expect(run(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'u/user-1/p/proj-1/img/p1-v1.webp', at: 1 })).toMatchObject({ at: NOW });
  });
  it('rejects foreign paths, size variants, unknown targets and malformed targets', () => {
    const doc = fixture();
    doc.pages[0].render.asset = { ...doc.pages[0].render.asset!, variants: [{ path: 'u/user-1/p/proj-1/img/p1-v2_w480.webp', w: 480, h: 600 }] };
    for (const path of ['u/someone-else/p/x/img/a.webp', 'u/user-1/p/proj-1/img/p1-v2_w480.webp', '', 42]) {
      rejects(() => run(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_3' }, path, at: 1, adopt: true }), 400);
    }
    rejects(() => run(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_nope' }, path: 'u/user-1/p/proj-1/img/p1-v1.webp', at: 1 }), 400);
    rejects(() => run(doc, { op: 'render_use', target: { kind: 'board' }, path: 'u/user-1/p/proj-1/img/p1-v1.webp', at: 1 }), 400);
    rejects(() => run(doc, { op: 'render_use', target: { kind: 'page', id: '../x' }, path: 'u/user-1/p/proj-1/img/p1-v1.webp', at: 1 }), 400);
  });
  it('busy target → 409; blocked or quarantined image → 409 CONTENT_POLICY', () => {
    const doc = fixture();
    rejects(() => run(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_2' }, path: 'u/user-1/p/proj-1/img/p2-v1.webp', at: 1 }), 409, 'CONFLICT');
    doc.pages[0].render.history[0] = { ...doc.pages[0].render.history[0], safety: { assessed: 'X', at: 1 } as never };
    rejects(() => run(doc, { op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'u/user-1/p/proj-1/img/p1-v1.webp', at: 1 }), 409, 'CONTENT_POLICY');
  });
  it('honest staleness after restore: an old version drawn for an older script shows out of date', () => {
    const doc = fixture();
    const oldHash = pageSpecHash(doc, doc.pages[0]);
    // v1 was drawn for the old script; the script changed and v2 was drawn for the new one.
    doc.pages[0].panels[0] = { ...doc.pages[0].panels[0], action: 'A brand-new beat' };
    doc.pages[0].render = {
      ...doc.pages[0].render,
      specHash: pageSpecHash(doc, doc.pages[0]),
      history: [{ ...asset('u/user-1/p/proj-1/img/p1-v1.webp', { at: 10 }), specHash: oldHash, qc: { score: 0.7, issues: [], checkedAt: 1 } }]
    };
    expect(isPageStale(doc, doc.pages[0])).toBe(false);
    const ops = sanitizePatchOps(doc, [{ op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'u/user-1/p/proj-1/img/p1-v1.webp', at: 1 }], sctx());
    const after = applyOps(doc, ops);
    expect(after.pages[0].render.asset?.path).toBe('u/user-1/p/proj-1/img/p1-v1.webp');
    expect(after.pages[0].render.qc?.score).toBe(0.7);
    expect(isPageStale(after, after.pages[0])).toBe(true);
  });
});

describe('version_star', () => {
  it('stars history and archive versions only', () => {
    const doc = fixture();
    expect(run(doc, { op: 'version_star', path: 'u/user-1/p/proj-1/img/p1-v1.webp', starred: true })).toEqual({ op: 'version_star', path: 'u/user-1/p/proj-1/img/p1-v1.webp', starred: true });
    expect(run(doc, { op: 'version_star', path: 'u/user-1/p/proj-1/img/p1-v0.webp', starred: false })).toMatchObject({ starred: false });
    rejects(() => run(doc, { op: 'version_star', path: 'u/user-1/p/proj-1/img/p1-v2.webp', starred: true }), 400); // current
    rejects(() => run(doc, { op: 'version_star', path: 'u/user-1/p/proj-1/ref/maya.webp', starred: true }), 400);
    rejects(() => run(doc, { op: 'version_star', path: 'u/user-1/p/proj-1/img/p1-v1.webp', starred: 'yes' }), 400);
  });
});

describe('assetIndex', () => {
  it('maps every primary path to its roles', () => {
    const idx = assetIndex(fixture());
    const roles = (p: string) => [...(idx.get(p) as AssetIndexEntry).roles];
    expect(roles('u/user-1/p/proj-1/img/p1-v2.webp')).toEqual(['art']);
    expect(roles('u/user-1/p/proj-1/ref/maya.webp')).toEqual(['ref']);
    expect(roles('u/user-1/p/proj-1/img/attach.webp')).toEqual(['attachment']);
    expect(roles('u/user-1/p/proj-1/img/gone.webp')).toEqual(['art']);
    expect(idx.get('u/user-1/p/proj-1/img/p1-v0.webp')?.versioned).toBe(true);
    expect(idx.get('u/user-1/p/proj-1/img/gone.webp')?.versioned).toBe(false);
  });
});
