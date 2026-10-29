// @vitest-environment node
// P2-SERVER job-runner integration details (wave-2 queue): sanitizer restore paths (contract §5.4),
// chapter titles, balloon z/lock/link, the errorDetail patch, refPaths and continuity, the lazy
// reference check and render-verdict follow-ups (real safety module, fake platform classifier),
// activity cost badges. Fakes only at the network edge; $0.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyRender, pageSpecHash, type CharacterLook, type ComicDoc } from '../../../shared/comic/doc.js';
import { editionReadiness, i18nOf, lineSourceHash } from '../../../shared/comic/i18n.js';
import { DOC_LIMITS } from '../../../shared/comic/limits.js';
import { applyOps, type DocOp } from '../../../shared/comic/ops.js';
import { inverseOps } from '../../../shared/comic/undo.js';
import { canServeToOwner } from '../../../shared/comic/safety.js';
import { JOB_TIMINGS, estimateSpendAction, isOwnProjectAssetPath, mergeBalloons, runAction, sanitizeLook, sanitizePatchOps, sanitizeCtxFor, startAction } from './jobs.js';
import { fakeBilling, fakeImages, newSession, plannedDoc, testContext, TINY_PNG } from './orchestrator.fakes.js';
import { installSafetyFakes, resetSafety } from './safety/testkit.js';
import { StudioError } from './types.js';

const TIMINGS = { ...JOB_TIMINGS };
beforeEach(() => {
  JOB_TIMINGS.retryBackoffMs = 0;
  JOB_TIMINGS.saveRetryMs = 0;
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  Object.assign(JOB_TIMINGS, TIMINGS);
  resetSafety();
  vi.restoreAllMocks();
});

const ctxFor = (doc: ComicDoc = plannedDoc()) => {
  const session = newSession(doc);
  const ctx = testContext(session);
  return { session, ctx, sctx: sanitizeCtxFor(ctx) };
};

describe('patch sanitizer (P2-SERVER)', () => {
  it('Undo of character_remove re-creates the character with its photos from THIS project only (rebuilt, unchecked)', () => {
    const doc = plannedDoc();
    const own = 'u/user-1/p/proj-1/ref/face-1.webp';
    doc.cast[0] = { ...doc.cast[0], refs: [{ path: own, source: 'upload', at: 1, safety: { assessed: 'G', at: 1 } }] };
    const removed = applyOps(doc, [{ op: 'character_remove', id: 'c_maya' }]);
    const { sctx } = ctxFor(removed);
    const inverse = {
      op: 'character',
      id: 'c_maya',
      patch: { ...doc.cast[0], refs: [{ ...doc.cast[0].refs[0], safety: { assessed: 'G', at: 1 }, hash: 'forged' }], sheet: { status: 'ready', history: [], asset: { path: 'u/user-1/p/proj-1/img/sheet-1.webp', source: 'generated', at: 1 } } }
    };
    const [op] = sanitizePatchOps(removed, [inverse], sctx) as Extract<DocOp, { op: 'character' }>[];
    expect(op.patch.name).toBe('Maya');
    // The photo comes back WITHOUT the client's verdict or hash: the job runner checks it before its first use.
    expect(op.patch.refs).toEqual([{ path: own, source: 'upload', at: expect.any(Number) }]);
    expect(op.patch.sheet).toMatchObject({ status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/sheet-1.webp' } });
    // P2-GATE L4: the client's "generated" can't be proven for a path the doc no longer holds — the sheet
    // comes back as an UPLOAD with no verdict, so the lazy check reads it before its first use.
    expect(op.patch.sheet?.asset).toEqual({ path: 'u/user-1/p/proj-1/img/sheet-1.webp', source: 'upload', at: expect.any(Number) });
    // Another user's, another project's, a size variant and a quarantine path are refused.
    for (const path of ['u/someone/p/proj-1/ref/x.webp', 'u/user-1/p/other/ref/x.webp', 'u/user-1/p/proj-1/img/gen-1_w480.webp', 'q/user-1/proj-1/q-1.webp', 'pub/AAAAAAAAAAAAAAAAAAAAAA/p1.webp']) {
      expect(() => sanitizePatchOps(removed, [{ op: 'character', id: 'c_new', patch: { name: 'X', refs: [{ path }] } }], sctx)).toThrow(/Invalid character: refs/);
      expect(isOwnProjectAssetPath(path, 'user-1', 'proj-1')).toBe(false);
    }
  });

  it('a path the doc still knows as blocked never comes back as an unchecked photo', () => {
    const doc = plannedDoc();
    const bad = 'u/user-1/p/proj-1/img/bad-take.webp';
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/ok.webp', source: 'generated', at: 1 }, history: [{ path: bad, source: 'generated', at: 1, safety: { assessed: 'X', at: 1 } }] };
    const { sctx } = ctxFor(doc);
    expect(() => sanitizePatchOps(doc, [{ op: 'character', id: 'c_new', patch: { name: 'X', refs: [{ path: bad }] } }], sctx)).toThrow(/Invalid character: refs/);
    // The same shape with a clean own-project path is accepted (rebuilt, unchecked).
    const [op] = sanitizePatchOps(doc, [{ op: 'character', id: 'c_new', patch: { name: 'X', refs: [{ path: 'u/user-1/p/proj-1/ref/fresh.webp' }] } }], sctx) as Extract<DocOp, { op: 'character' }>[];
    expect(op.patch.refs).toEqual([{ path: 'u/user-1/p/proj-1/ref/fresh.webp', source: 'upload', at: expect.any(Number) }]);
  });

  it('a restored photo is always an upload (checked before first use); one the client knew as blocked stays out', () => {
    const doc = plannedDoc();
    const ok = 'u/user-1/p/proj-1/img/legacy-up.webp';
    const bad = 'u/user-1/p/proj-1/ref/was-blocked.webp';
    const sheetBad = 'u/user-1/p/proj-1/img/sheet-x.webp';
    const { sctx } = ctxFor(doc);
    const [op] = sanitizePatchOps(
      doc,
      [
        {
          op: 'character',
          id: 'c_back',
          patch: {
            name: 'Back',
            // "generated" can't be proven for a path the doc no longer holds: it comes back as an upload.
            refs: [{ path: ok, source: 'generated', label: 'face' }, { path: bad, source: 'upload', safety: { assessed: 'X', at: 1, quarantined: true } }],
            sheet: { status: 'ready', history: [], asset: { path: sheetBad, source: 'generated', at: 1, safety: { assessed: 'X', at: 1 } } }
          }
        }
      ],
      sctx
    ) as Extract<DocOp, { op: 'character' }>[];
    expect(op.patch.refs).toEqual([{ path: ok, source: 'upload', at: expect.any(Number), label: 'face' }]);
    expect(op.patch.sheet).toMatchObject({ status: 'none', history: [] });
    expect(op.patch.sheet?.asset).toBeUndefined();
    // An unknown label word is dropped, not stored.
    const [odd] = sanitizePatchOps(doc, [{ op: 'place', id: 'pl_back', patch: { name: 'Lake', refs: [{ path: ok, label: 'zzz_made_up' }] } }], sctx) as Extract<DocOp, { op: 'place' }>[];
    expect(odd.patch.refs).toEqual([{ path: ok, source: 'upload', at: expect.any(Number) }]);
  });

  it('a whole balloons array never stores a link cycle (links are checked against the new array)', () => {
    const doc = plannedDoc();
    doc.pages[1].panels[2].lines = [{ id: 'ln_2_3', kind: 'speech', speakerId: 'c_arjun', text: 'Second' }];
    const { sctx } = ctxFor(doc);
    const [op] = sanitizePatchOps(
      doc,
      [
        {
          op: 'balloons',
          pageId: 'pg_2',
          balloons: [
            { lineId: 'ln_2_2', x: 0.1, y: 0.1, w: 0.2, linkTo: 'ln_2_3' },
            { lineId: 'ln_2_3', x: 0.5, y: 0.5, w: 0.2, linkTo: 'ln_2_2' }
          ]
        }
      ],
      sctx
    ) as Extract<DocOp, { op: 'balloons' }>[];
    expect(op.balloons[0].linkTo).toBe('ln_2_3');
    expect(op.balloons[1].linkTo).toBeUndefined();
  });

  it('a live character never gets its sheet rewritten by a patch; kind and count are accepted', () => {
    const { session, sctx } = ctxFor();
    const [op] = sanitizePatchOps(session.doc, [{ op: 'character', id: 'c_maya', patch: { kind: 'animal', count: 3, sheet: { status: 'ready', history: [] } } }], sctx) as Extract<DocOp, { op: 'character' }>[];
    expect(op.patch).toEqual({ kind: 'animal', count: 3 });
  });

  it('chapter titles set and clear; balloons keep z / lock / link (no self-link, no cycle)', () => {
    const doc = plannedDoc();
    doc.pages[1].panels[2].lines = [{ id: 'ln_2_3', kind: 'speech', speakerId: 'c_arjun', text: 'Second' }];
    doc.pages[1].balloons = [{ lineId: 'ln_2_2', x: 0.1, y: 0.1, w: 0.3, linkTo: 'ln_2_3' }];
    const { sctx } = ctxFor(doc);
    expect(sanitizePatchOps(doc, [{ op: 'page', id: 'pg_1', patch: { chapterTitle: '  Chapter One  ' } }], sctx)).toEqual([{ op: 'page', id: 'pg_1', patch: { chapterTitle: 'Chapter One' } }]);
    expect(sanitizePatchOps(doc, [{ op: 'page', id: 'pg_1', patch: { chapterTitle: '' } }], sctx)).toEqual([{ op: 'page', id: 'pg_1', patch: { chapterTitle: null } }]);
    const [b] = sanitizePatchOps(doc, [{ op: 'balloon', pageId: 'pg_2', lineId: 'ln_2_3', patch: { z: 250, locked: true } }], sctx) as Extract<DocOp, { op: 'balloon' }>[];
    expect(b.patch).toEqual({ z: 100, locked: true });
    expect(() => sanitizePatchOps(doc, [{ op: 'balloon', pageId: 'pg_2', lineId: 'ln_2_3', patch: { linkTo: 'ln_2_3' } }], sctx)).toThrow(/linkTo/);
    // ln_2_2 → ln_2_3 exists, so ln_2_3 → ln_2_2 would close a cycle.
    expect(() => sanitizePatchOps(doc, [{ op: 'balloon', pageId: 'pg_2', lineId: 'ln_2_3', patch: { linkTo: 'ln_2_2' } }], sctx)).toThrow(/linkTo/);
    const [full] = sanitizePatchOps(doc, [{ op: 'balloons', pageId: 'pg_2', balloons: [{ lineId: 'ln_2_3', x: 0.5, y: 0.5, w: 0.2, z: 3, locked: true, linkTo: 'nope' }] }], sctx) as Extract<DocOp, { op: 'balloons' }>[];
    expect(full.balloons[0]).toEqual({ lineId: 'ln_2_3', x: 0.5, y: 0.5, w: 0.2, pinned: true, z: 3, locked: true });
  });

  it('an all-translation batch (Undo of a removed edition) may exceed 200 ops; anything else may not', () => {
    const { session, sctx } = ctxFor();
    const tooMany = Array.from({ length: 201 }, (): unknown => ({ op: 'note_add', text: 'x' }));
    expect(() => sanitizePatchOps(session.doc, tooMany, sctx)).toThrow(/Too many changes/);
    const translations = Array.from({ length: 2001 }, (): unknown => ({ op: 'translation', lang: 'hi', lineId: 'ln_1_2', patch: { text: 'x' } }));
    expect(() => sanitizePatchOps(session.doc, translations, sctx)).toThrow(/Too many changes/);
  });

  it('Undo of a removed edition is accepted as one batch: the edition is re-created first, then its lines, titles and balloons — 300 lines included', () => {
    const { session, sctx } = ctxFor();
    const base = session.doc;
    const linesFor = (n: number, k: number) => Array.from({ length: 34 }, (_, i) => ({ id: `ln_${n}_${k}_${i}`, kind: 'speech' as const, speakerId: 'c_maya', text: `Line ${n}.${k}.${i}` }));
    const big: ComicDoc = {
      ...base,
      cover: { ...base.cover, title: 'Spice Run', tagline: 'Fast.' },
      pages: base.pages.map((p) => ({ ...p, panels: p.panels.map((pn) => ({ ...pn, lines: linesFor(p.n, pn.n) })) }))
    };
    const all = big.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines));
    expect(all.length).toBeGreaterThanOrEqual(300);
    const te = Object.fromEntries(all.map((l) => [l.id, { text: `తెలుగు ${l.id}`, status: 'reviewed' as const, sourceHash: lineSourceHash(l), at: 1, gloss: 'g' }]));
    const before = applyOps(big, [
      { op: 'edition', lang: 'te', patch: { register: 'formal' } },
      { op: 'translations', lang: 'te', lines: te },
      { op: 'edition_text', lang: 'te', field: 'cover.title', value: { text: 'మసాలా పరుగు', status: 'edited', sourceHash: 'h', at: 1 } },
      { op: 'edition_balloon', lang: 'te', lineId: all[0].id, patch: { x: 0.2, y: 0.3, w: 0.25, pinned: true } }
    ]);
    const remove: DocOp[] = [{ op: 'edition', lang: 'te', patch: null }];
    const after = applyOps(before, remove);
    expect(i18nOf(after).editions.te).toBeUndefined();
    const inverse = inverseOps(before, remove);
    expect(inverse[0]).toEqual({ op: 'edition', lang: 'te', patch: { register: 'formal' } });
    expect(inverse.length).toBeGreaterThan(300);
    const restored = applyOps(after, sanitizePatchOps(after, inverse, sctx));
    const e = i18nOf(restored).editions.te;
    expect(e.register).toBe('formal');
    expect(Object.keys(e.lines)).toHaveLength(all.length);
    expect(e.lines[all[5].id]).toMatchObject({ text: `తెలుగు ${all[5].id}`, gloss: 'g', sourceHash: lineSourceHash(all[5]) });
    expect(e.cover?.title).toMatchObject({ text: 'మసాలా పరుగు' });
    expect(e.balloons[all[0].id]).toEqual({ x: 0.2, y: 0.3, w: 0.25, pinned: true });
    // The allowance is for that undo alone: the same batch padded with any other op is an ordinary (≤ 200) edit.
    expect(() => sanitizePatchOps(after, [...inverse, { op: 'note_add', text: 'x' }], sctx)).toThrow(/Too many changes/);
    // And a translation for an edition nobody re-creates in the batch is still refused.
    expect(() => sanitizePatchOps(after, [inverse[1]], sctx)).toThrow(/no Telugu translation yet/);
  });

  it('Undo of a removed edition never lifts its publish block: an unreviewed AI draft comes back "waiting for review"', () => {
    const { session, sctx } = ctxFor();
    const base: ComicDoc = { ...session.doc, format: { ...session.doc.format, lettering: 'overlay' } };
    const all = base.pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines));
    expect(all.length).toBeGreaterThan(1);
    const machine = all[1];
    const te = Object.fromEntries(
      all.map((l) => [l.id, { text: `తెలుగు ${l.id}`, status: l.id === machine.id ? ('machine' as const) : ('reviewed' as const), sourceHash: lineSourceHash(l), at: 1 }])
    );
    const before = applyOps(base, [
      { op: 'edition', lang: 'te', patch: {} },
      { op: 'translations', lang: 'te', lines: te }
    ]);
    expect(editionReadiness(before, 'te')).toMatchObject({ publishable: false, issues: [expect.objectContaining({ code: 'unreviewed', count: 1 })] });
    const remove: DocOp[] = [{ op: 'edition', lang: 'te', patch: null }];
    const after = applyOps(before, remove);
    const restored = applyOps(after, sanitizePatchOps(after, inverseOps(before, remove), sctx));
    expect(i18nOf(restored).editions.te.lines[machine.id]).toMatchObject({ text: `తెలుగు ${machine.id}`, status: 'machine' });
    expect(i18nOf(restored).editions.te.lines[all[0].id]).toMatchObject({ status: 'edited' }); // never re-minted 'reviewed'
    expect(editionReadiness(restored, 'te')).toMatchObject({ publishable: false, issues: [expect.objectContaining({ code: 'unreviewed', count: 1 })] });
  });

  it('a line create keeps its position and its style through the sanitizer (⌘D and Undo of a delete land where the client put them)', () => {
    const { session, sctx } = ctxFor();
    const doc = applyOps(session.doc, [{ op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2b', patch: { kind: 'speech', speakerId: 'c_maya', text: 'Second', style: { textCase: 'upper' } } }]);
    const order = (d: ComicDoc) => d.pages[0].panels[1].lines.map((l) => l.id);
    const styleOf = (d: ComicDoc, id: string) => d.pages[0].panels[1].lines.find((l) => l.id === id)?.style;
    // ⌘D: the copy sits right after its original, with the same style (lettering.md §7.5).
    const copy: DocOp = { op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_copy', patch: { kind: 'speech', speakerId: 'c_maya', text: 'Line on page 1', style: { textCase: 'upper' } }, index: 1 };
    const clean = sanitizePatchOps(doc, [copy], sctx);
    expect(clean).toEqual([copy]);
    expect(order(applyOps(doc, clean))).toEqual(['ln_1_2', 'ln_copy', 'ln_1_2b']);
    expect(styleOf(applyOps(doc, clean), 'ln_copy')).toEqual({ textCase: 'upper' });
    // Undo of a delete puts the line back where it was.
    const del: DocOp = { op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2', patch: null };
    const deleted = applyOps(doc, [del]);
    const undone = applyOps(deleted, sanitizePatchOps(deleted, inverseOps(doc, [del]), sctx));
    expect(order(undone)).toEqual(['ln_1_2', 'ln_1_2b']);
    expect(undone.pages[0].panels[1].lines).toEqual(doc.pages[0].panels[1].lines);
    // Bounds (contract §5.4 `line`): index an integer ≥ 0, style ≤ 2 KB; null clears a style on an update.
    expect(() => sanitizePatchOps(doc, [{ ...copy, index: -1 }], sctx)).toThrow(/index/);
    expect(() => sanitizePatchOps(doc, [{ ...copy, index: 1.5 }], sctx)).toThrow(/index/);
    const huge: unknown = { ...copy, patch: { kind: 'speech', text: 'x', style: { fontFamily: 'x'.repeat(2100) } } };
    expect(() => sanitizePatchOps(doc, [huge], sctx)).toThrow(/too large/);
    const cleared = sanitizePatchOps(doc, [{ op: 'line', pageId: 'pg_1', panelId: 'pn_1_2', id: 'ln_1_2b', patch: { style: null } as never }], sctx);
    expect(styleOf(applyOps(doc, cleared), 'ln_1_2b')).toBeUndefined();
  });

  it('line_move ("Move to panel N") settles exactly as the client showed it and never prunes a translation; Undo goes through the same door', () => {
    const { session, sctx } = ctxFor();
    const line = session.doc.pages[0].panels[1].lines[0];
    const doc = applyOps(session.doc, [
      { op: 'edition', lang: 'te', patch: {} },
      { op: 'translations', lang: 'te', lines: { ln_1_2: { text: 'పేజీ 1', status: 'reviewed', sourceHash: lineSourceHash(line), at: 1 } } }
    ]);
    const move: DocOp = { op: 'line_move', pageId: 'pg_1', id: 'ln_1_2', toPanelId: 'pn_1_3', index: 0 };
    const clean = sanitizePatchOps(doc, [move], sctx);
    expect(clean).toEqual([move]);
    const after = applyOps(doc, clean);
    expect(after.pages[0].panels.map((p) => p.lines.map((l) => l.id))).toEqual([[], [], ['ln_1_2']]);
    expect(i18nOf(after).editions.te.lines.ln_1_2).toEqual(i18nOf(doc).editions.te.lines.ln_1_2);
    expect(sanitizePatchOps(after, inverseOps(doc, clean), sctx)).toEqual([{ op: 'line_move', pageId: 'pg_1', id: 'ln_1_2', toPanelId: 'pn_1_2', index: 0 }]);
    // No index = last. A bad index, an unknown line or panel, or a full panel rejects the batch.
    expect(sanitizePatchOps(doc, [{ op: 'line_move', pageId: 'pg_1', id: 'ln_1_2', toPanelId: 'pn_1_3' }], sctx)).toEqual([{ op: 'line_move', pageId: 'pg_1', id: 'ln_1_2', toPanelId: 'pn_1_3' }]);
    expect(() => sanitizePatchOps(doc, [{ ...move, index: -1 }], sctx)).toThrow(/index/);
    expect(() => sanitizePatchOps(doc, [{ ...move, id: 'ghost' }], sctx)).toThrow(/no longer on the page/);
    expect(() => sanitizePatchOps(doc, [{ ...move, toPanelId: 'ghost' }], sctx)).toThrow(/panel/);
    const full = applyOps(doc, Array.from({ length: DOC_LIMITS.linesPerPanel }, (_, i): DocOp => ({ op: 'line', pageId: 'pg_1', panelId: 'pn_1_3', id: `ln_full_${i}`, patch: { kind: 'caption', text: `c${i}` } })));
    expect(() => sanitizePatchOps(full, [move], sctx)).toThrow(/already has/);
  });
});

describe('cast details and non-human look lines (P2-WIRING-SERVER)', () => {
  type CharOp = Extract<DocOp, { op: 'character' }>;
  const charPatch = (doc: ComicDoc, id: string, patch: unknown) => {
    const { sctx } = ctxFor(doc);
    const [op] = sanitizePatchOps(doc, [{ op: 'character', id, patch }], sctx) as CharOp[];
    return op;
  };

  it('kind, count and likeness from the board are kept and persist', () => {
    const doc = plannedDoc();
    const op = charPatch(doc, 'c_maya', { kind: 'animal', count: 3, likeness: 'sheet_only', look: { species: 'mallard duckling', markings: 'white blaze on the chest' } });
    expect(op.patch).toEqual({ kind: 'animal', count: 3, likeness: 'sheet_only', look: { species: 'mallard duckling', markings: 'white blaze on the chest' } });
    const next = applyOps(doc, [op]);
    const maya = next.cast.find((c) => c.id === 'c_maya')!;
    expect(maya).toMatchObject({ kind: 'animal', count: 3, likeness: 'sheet_only' });
    expect(maya.look).toMatchObject({ summary: doc.cast[0].look.summary, species: 'mallard duckling', markings: 'white blaze on the chest' });
    // Back to a single being and the default likeness; a new character keeps its details too.
    expect(charPatch(next, 'c_maya', { count: 1, likeness: 'auto', kind: 'person' }).patch).toEqual({ count: 1, likeness: 'auto', kind: 'person' });
    for (const likeness of ['auto', 'sheet_only', 'sheet_and_photo']) expect(charPatch(doc, 'c_duck', { name: 'Duck', likeness }).patch).toEqual({ name: 'Duck', likeness });
    for (const kind of ['person', 'animal', 'creature', 'robot', 'toy', 'vehicle', 'object']) expect(charPatch(doc, 'c_maya', { kind }).patch).toEqual({ kind });
    const created = applyOps(doc, [charPatch(doc, 'c_ducks', { name: 'Ducklings', tier: 'extra', kind: 'animal', count: 12, likeness: 'sheet_and_photo' })]);
    expect(created.cast.find((c) => c.id === 'c_ducks')).toMatchObject({ name: 'Ducklings', kind: 'animal', count: 12, likeness: 'sheet_and_photo' });
  });

  it('an unknown kind, count or likeness is dropped (never stored) and the rest of the edit still applies', () => {
    const doc = plannedDoc();
    const bad: unknown[][] = [
      ['kind', 'dragon'], ['kind', 'Animal'], ['kind', 42], ['kind', ''],
      ['count', 0], ['count', 13], ['count', 2.5], ['count', -1], ['count', '3'], ['count', Number.NaN], ['count', Number.POSITIVE_INFINITY],
      ['likeness', 'always'], ['likeness', 'SHEET_ONLY'], ['likeness', true], ['likeness', { x: 1 }]
    ];
    for (const [key, value] of bad) {
      const op = charPatch(doc, 'c_maya', { role: 'Pickpocket', [key as string]: value });
      // toStrictEqual: the key is absent, not present-as-undefined (which would clear the stored value).
      expect(op.patch, `${key}=${String(value)}`).toStrictEqual({ role: 'Pickpocket' });
    }
    const created = applyOps(doc, [charPatch(doc, 'c_frog', { name: 'Frog', kind: 'dragon', count: 99, likeness: 'always' })]);
    const frog = created.cast.find((c) => c.id === 'c_frog')!;
    expect(frog.name).toBe('Frog');
    expect('kind' in frog || 'count' in frog || 'likeness' in frog).toBe(false);
  });

  it('species and markings: one trimmed line ≤ 120, control characters stripped, Telugu and Hindi intact', () => {
    const look = sanitizeLook({
      species: '  mallard\tduckling\n\u0000\u001b ',
      markings: `${'w'.repeat(200)}`,
      summary: 'Small duck.\nAlways near the lake.\u0007',
      bogus: 'x'
    })!;
    expect(look).toEqual({ species: 'mallard duckling', markings: 'w'.repeat(120), summary: 'Small duck.\nAlways near the lake.' });
    expect(sanitizeLook({ species: 'బాతు పిల్ల', markings: 'క్ష‍త్రియ రంగు' })).toEqual({ species: 'బాతు పిల్ల', markings: 'క్ష‍త్రియ రంగు' });
    expect(sanitizeLook({ species: 'हंस का बच्चा' })).toEqual({ species: 'हंस का बच्चा' });
    // A clip never splits an emoji, and lone surrogates (rejected by Postgres jsonb) never get stored.
    expect(sanitizeLook({ markings: `${'a'.repeat(119)}🦆` })).toEqual({ markings: 'a'.repeat(119) });
    expect(sanitizeLook({ species: '\uD83Dduck\uDE00' })).toEqual({ species: 'duck' });
    // Non-strings are dropped; '' clears a field; no control character survives anywhere.
    expect(sanitizeLook({ species: 42, markings: { a: 1 }, hair: '' })).toEqual({ hair: '' });
    const all = sanitizeLook(Object.fromEntries(['summary', 'age', 'hair', 'species', 'markings'].map((k) => [k, `x\u0000\u0008\u000b\u000c\u001f\u007f\u0085\u009fy`])))!;
    for (const v of Object.values(all)) expect(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(v)).toBe(false);
    expect(all.species).toBe('x y');
    expect(sanitizeLook('nope')).toBeUndefined();
  });

  it('a board patch saves kind / count / likeness / species / markings on the live doc (survives a reload)', async () => {
    const { session, ctx } = ctxFor();
    // The board sends a partial look (just the fields the user touched); the op merges it into the stored look.
    const look = { species: '  mallard duckling ', markings: 'green\nhead' } as unknown as CharacterLook;
    await runAction(ctx, { type: 'patch', ops: [{ op: 'character', id: 'c_maya', patch: { kind: 'animal', count: 3, likeness: 'sheet_only', look } }] }, { confirmed: false });
    const maya = session.doc.cast.find((c) => c.id === 'c_maya')!;
    expect(maya).toMatchObject({ kind: 'animal', count: 3, likeness: 'sheet_only' });
    expect(maya.look).toMatchObject({ species: 'mallard duckling', markings: 'green head' });
    const reloaded = JSON.parse(JSON.stringify(session.doc)) as ComicDoc;
    expect(reloaded.cast.find((c) => c.id === 'c_maya')).toMatchObject({ kind: 'animal', count: 3, likeness: 'sheet_only', look: { species: 'mallard duckling', markings: 'green head' } });
  });

  it('Undo of the board pickers and the look lines restores the character exactly (null = was not set, contract R4)', async () => {
    const { session, ctx } = ctxFor();
    const before = JSON.parse(JSON.stringify(session.doc)) as ComicDoc;
    const hashes = before.pages.map((p) => pageSpecHash(before, p));
    const edit: DocOp[] = [
      { op: 'character', id: 'c_maya', patch: { kind: 'animal', count: 3, likeness: 'sheet_only', look: { species: 'mallard duckling', markings: 'white blaze', eyes: 'amber' } as unknown as CharacterLook } }
    ];
    // The client computes the inverse against what it sees (useStudio → shared undo): absent keys → null.
    const inverse = inverseOps(session.doc, edit);
    const inverseLook = (inverse[0] as Extract<DocOp, { op: 'character' }>).patch.look as unknown as Record<string, unknown>;
    expect(inverse[0]).toMatchObject({ op: 'character', patch: { kind: null, count: null, likeness: null } });
    expect(inverseLook).toMatchObject({ summary: 'Young courier with a red scarf', hair: 'black bob', species: null, markings: null, eyes: null });
    await runAction(ctx, { type: 'patch', ops: edit }, { confirmed: false });
    expect(session.doc.cast[0]).toMatchObject({ kind: 'animal', count: 3, likeness: 'sheet_only', look: { species: 'mallard duckling', markings: 'white blaze', eyes: 'amber' } });
    expect(pageSpecHash(session.doc, session.doc.pages[0])).not.toBe(hashes[0]); // a group of 3 + new look: page 1 is stale
    // Undo (the inverse goes over the wire as JSON, like the real client's patch).
    await runAction(ctx, { type: 'patch', ops: JSON.parse(JSON.stringify(inverse)) }, { confirmed: false });
    const maya = JSON.parse(JSON.stringify(session.doc.cast[0]));
    expect(maya).toEqual(before.cast[0]);
    expect(['kind', 'count', 'likeness'].some((k) => k in maya) || 'species' in maya.look || 'eyes' in maya.look).toBe(false);
    // The page spec hash is the one before the edit: Undo never leaves a page looking stale (or re-billed).
    expect(session.doc.pages.map((p) => pageSpecHash(session.doc, p))).toEqual(hashes);
    // null never invents a value: a new character created with nulls has no kind / count / likeness; null summary is ignored.
    const created = applyOps(before, [charPatch(before, 'c_fox', { name: 'Fox', kind: null, count: null, likeness: null, look: { summary: null, species: null } })]);
    const fox = JSON.parse(JSON.stringify(created.cast.find((c) => c.id === 'c_fox')));
    expect(fox).toMatchObject({ name: 'Fox', look: { summary: '' } });
    expect(['kind', 'count', 'likeness'].some((k) => k in fox) || 'species' in fox.look).toBe(false);
    expect(charPatch(before, 'c_maya', { look: { summary: null } }).patch).toStrictEqual({ look: {} });
  });

  it('Undo of a FIRST edit of any optional field round-trips (null clears it, contract R4) instead of failing the whole Undo', async () => {
    const { session, ctx, sctx } = ctxFor();
    const first: DocOp[] = [
      { op: 'brief', patch: { setting: 'Old Delhi', audience: 'teens', themes: ['loyalty'] } },
      { op: 'style', patch: { linework: 'brush ink', avoid: ['gore'] } },
      { op: 'page', id: 'pg_1', patch: { turnHook: 'A shadow at the door.' } },
      { op: 'panel', pageId: 'pg_1', id: 'pn_1_1', patch: { angle: 'low angle', mood: 'tense' } },
      { op: 'cover', patch: { tagline: 'Deliver or die trying', direction: 'Maya mid-leap' } },
      { op: 'source', patch: { script: 'PAGE 1. Maya runs.' } },
      { op: 'character', id: 'c_arjun', patch: { role: 'Spice vendor', personality: 'Grumpy', voice: 'Short sentences' } }
    ];
    for (const op of first) {
      const before = JSON.parse(JSON.stringify(session.doc)) as ComicDoc;
      const inverse = JSON.parse(JSON.stringify(inverseOps(session.doc, [op]))) as DocOp[];
      expect(JSON.stringify(inverse), op.op).toContain('null'); // the field was absent before
      await runAction(ctx, { type: 'patch', ops: [op] }, { confirmed: false });
      expect(JSON.stringify(session.doc), op.op).not.toBe(JSON.stringify(before));
      await runAction(ctx, { type: 'patch', ops: inverse }, { confirmed: false });
      const after = JSON.parse(JSON.stringify(session.doc)) as ComicDoc;
      for (const key of ['brief', 'style', 'pages', 'cast'] as const) expect(after[key], `${op.op} ${key}`).toEqual(before[key]);
      expect({ ...after.cover, render: null }, op.op).toEqual({ ...before.cover, render: null });
      expect(after.source.script, op.op).toEqual(before.source.script);
      expect(after.pages.map((p) => pageSpecHash(after, p)), op.op).toEqual(before.pages.map((p) => pageSpecHash(before, p)));
    }
    // Required fields never clear: null is still refused there.
    for (const bad of [
      { op: 'brief', patch: { title: null } },
      { op: 'page', id: 'pg_1', patch: { summary: null } },
      { op: 'panel', pageId: 'pg_1', id: 'pn_1_1', patch: { action: null } },
      { op: 'character', id: 'c_maya', patch: { name: null } },
      { op: 'character', id: 'c_maya', patch: { tier: null } },
      { op: 'style', patch: { status: null } }
    ])
      expect(() => sanitizePatchOps(session.doc, [bad], sctx), bad.op).toThrow(/Invalid/);
  });

  it('prototype keys in a patch are ignored, never stored or called', () => {
    const { session, sctx } = ctxFor();
    const raw = JSON.parse('{"title":"T","constructor":"x","__proto__":{"polluted":1},"toString":"y","hasOwnProperty":"z"}');
    expect(sanitizePatchOps(session.doc, [{ op: 'brief', patch: raw }], sctx)).toEqual([{ op: 'brief', patch: { title: 'T' } }]);
    const look = JSON.parse('{"summary":"S","constructor":"x","__proto__":{"species":"evil"}}');
    expect(charPatch(session.doc, 'c_maya', { look }).patch).toEqual({ look: { summary: 'S' } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('mergeBalloons (lettering.md §9)', () => {
  it('pinned and locked stay put; a re-laid balloon keeps its z and its link to a line still on the page', () => {
    const page = plannedDoc().pages[1];
    page.panels[2].lines = [{ id: 'ln_2_3', kind: 'speech', speakerId: 'c_arjun', text: 'Second' }];
    page.balloons = [
      { lineId: 'ln_2_2', x: 0.1, y: 0.1, w: 0.3, z: 5, linkTo: 'ln_2_3' },
      { lineId: 'ln_2_3', x: 0.6, y: 0.6, w: 0.2, locked: true, pinned: true }
    ];
    const out = mergeBalloons(page, [
      { lineId: 'ln_2_2', x: 0.2, y: 0.2, w: 0.25 },
      { lineId: 'ln_2_3', x: 0.0, y: 0.0, w: 0.2 }
    ], true);
    expect(out).toEqual([
      { lineId: 'ln_2_3', x: 0.6, y: 0.6, w: 0.2, locked: true, pinned: true },
      { lineId: 'ln_2_2', x: 0.2, y: 0.2, w: 0.25, z: 5, linkTo: 'ln_2_3' }
    ]);
    expect(mergeBalloons(page, [], false)).toEqual([]);
  });
});

describe('render runs (P2-SERVER)', () => {
  it('a failed draw sends status, error and the sanitized errorDetail in ONE patch', async () => {
    const doc = plannedDoc();
    doc.cast = doc.cast.map((c) => ({ ...c, sheet: { status: 'ready', history: [], asset: { path: `u/user-1/p/proj-1/img/${c.id}.webp`, source: 'generated', at: 1 } } }));
    doc.planStatus = 'approved';
    const session = newSession(doc);
    const images = fakeImages(() =>
      Object.assign(new StudioError('PROVIDER_ERROR', 'The image service had a problem.', { status: 502 }), { imageFailure: { route: 'openrouter', status: 500, providerName: 'Google' } })
    );
    const ctx = testContext(session, { images });
    const started = await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], quotedUsd: estimateSpendAction(doc, { type: 'render_pages', pageIds: ['pg_1'] }, false).usd }, { confirmed: true, origin: 'user' });
    await started.done;
    const failedPatch = ctx.events
      .flatMap((e) => (e.type === 'ops' ? e.ops : []))
      .find((op) => op.op === 'render' && op.patch.status === 'failed') as Extract<DocOp, { op: 'render' }>;
    expect(failedPatch.patch).toMatchObject({ status: 'failed', error: 'The image service had a problem.', errorDetail: { code: '500', provider: 'OpenRouter' } });
    expect(failedPatch.patch.errorDetail!.text).toMatch(/^OpenRouter · 500 · upstream Google · \d\d:\d\d UTC$/);
    expect(session.doc.pages[0].render.errorDetail).toMatchObject({ code: '500' });
    // The live status line carries the Image badge.
    expect(ctx.events.some((e) => e.type === 'activity' && e.cost === 'image' && e.phase === 'start')).toBe(true);
  });

  it('a sheet drawn without photos records refPaths: [] ; page 2 records page 1 as its continuity (by path)', async () => {
    const doc = plannedDoc();
    doc.planStatus = 'approved';
    const session = newSession(doc);
    const ctx = testContext(session);
    const sheet = await startAction(ctx, { type: 'render_sheets', characterIds: ['c_maya'], quotedUsd: estimateSpendAction(doc, { type: 'render_sheets', characterIds: ['c_maya'] }, false).usd }, { confirmed: true, origin: 'user' });
    await sheet.done;
    expect(session.doc.cast[0].sheet.refPaths).toEqual([]);
    const pages = await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1', 'pg_2'], quotedUsd: 99 }, { confirmed: true, origin: 'user' });
    await pages.done;
    await ctx.settled();
    const [p1, p2] = session.doc.pages;
    expect(p1.render.status).toBe('ready');
    expect(p2.render.continuityPath).toBe(p1.render.asset!.path);
    expect(p1.render.continuityPath).toBeUndefined();
  });
});

describe('the real safety module in a render run (fake platform classifier)', () => {
  it('an unchecked uploaded photo is checked before its first use; a blocked one is left out, said honestly', async () => {
    const safety = installSafetyFakes();
    const blockedX = { rating: 'X', categories: ['nudity'], notes: [], photo: true, minorLikely: false, subject: 'person', view: 'none', caption: '', multipleSubjects: false };
    safety.llm.script.vision = [blockedX];
    const doc = plannedDoc();
    const refPath = 'u/user-1/p/proj-1/ref/unchecked.webp';
    doc.cast[0] = { ...doc.cast[0], refs: [{ path: refPath, source: 'upload', at: 1 }] };
    const session = newSession(doc);
    const ctx = testContext(session);
    ctx.assetsFake.files.set(refPath, TINY_PNG);
    const run = await startAction(ctx, { type: 'render_sheets', characterIds: ['c_maya'], quotedUsd: 1 }, { confirmed: true, origin: 'user' });
    await run.done;
    await ctx.settled();
    // Checked once, verdict stored on the ref (blocked → never attached).
    expect(session.doc.cast[0].refs[0].safety?.assessed).toBe('X');
    expect(ctx.imagesFake.calls[0].references.some((r) => r.label.includes('AUTHOR REFERENCE'))).toBe(false);
    expect(session.doc.cast[0].sheet.refPaths).toEqual([]);
    const done = [...session.doc.conversation].reverse().find((m) => m.role === 'assistant')!;
    expect(done.cards?.some((c) => c.type === 'notice' && /reference photos? didn't pass the content check/.test(c.text))).toBe(true);
  });

  // P2-GATE L4: a model sheet restored by Undo (character / place removal) is a reference like a photo —
  // provenance unproven, no verdict — so it gets the same lazy check before it is attached to a drawing.
  it('a sheet restored by Undo is checked before its first use as a page reference; a blocked one is left out', async () => {
    const safety = installSafetyFakes();
    const blockedX = { rating: 'X', categories: ['nudity'], notes: [], photo: true, minorLikely: false, subject: 'person', view: 'none', caption: '', multipleSubjects: false };
    safety.llm.script.vision = [blockedX];
    const sheetPath = 'u/user-1/p/proj-1/img/attachment-7.webp';
    const placeSheet = 'u/user-1/p/proj-1/img/market-sheet.webp';
    const doc = plannedDoc();
    doc.planStatus = 'approved';
    doc.places[0] = { ...doc.places[0], sheet: { status: 'ready', history: [], asset: { path: placeSheet, source: 'generated', at: 1 } } };
    const session = newSession(doc);
    const ctx = testContext(session);
    // Undo of Maya's removal: the inverse claims a clean, GENERATED sheet for an own-project path the doc
    // no longer holds (here: an old chat attachment in img/).
    const removed = applyOps(session.doc, [{ op: 'character_remove', id: 'c_maya' }]);
    const back = sanitizePatchOps(
      removed,
      [{ op: 'character', id: 'c_maya', patch: { ...doc.cast[0], sheet: { status: 'ready', history: [], asset: { path: sheetPath, source: 'generated', at: 1, safety: { assessed: 'G', at: 1 } } } } }],
      sanitizeCtxFor(ctx)
    ) as Extract<DocOp, { op: 'character' }>[];
    expect(back[0].patch.sheet?.asset).toMatchObject({ path: sheetPath, source: 'upload' });
    expect(back[0].patch.sheet?.asset?.safety).toBeUndefined();
    // The restored sheet as the doc now holds it (the live session keeps Maya cast on page 1).
    session.commit([{ op: 'character', id: 'c_maya', patch: { sheet: back[0].patch.sheet } }], { origin: 'job' });
    expect(session.doc.cast[0].sheet.asset).toMatchObject({ path: sheetPath, source: 'upload' });
    ctx.assetsFake.files.set(sheetPath, TINY_PNG);
    ctx.assetsFake.files.set(placeSheet, TINY_PNG);

    const run = await startAction(ctx, { type: 'render_pages', pageIds: ['pg_1'], quotedUsd: 99 }, { confirmed: true, origin: 'user' });
    await run.done;
    await ctx.settled();
    // Checked once, the verdict stored on the sheet; blocked → never attached to the drawing.
    expect(session.doc.cast[0].sheet.asset?.safety?.assessed).toBe('X');
    expect(canServeToOwner(session.doc.cast[0].sheet.asset)).toBe(false);
    const call = ctx.imagesFake.calls[0];
    expect(call).toBeDefined();
    expect(call.references.some((r) => r.label.startsWith('CHARACTER SHEET'))).toBe(false);
    // The runner's own (generated) place sheet is not re-checked: it is attached as before, no verdict added.
    expect(call.references.some((r) => r.label.startsWith('LOCATION'))).toBe(true);
    expect(session.doc.places[0].sheet.asset?.safety).toBeUndefined();
    const done = [...session.doc.conversation].reverse().find((m) => m.role === 'assistant')!;
    expect(done.cards?.some((c) => c.type === 'notice' && /reference photos? didn't pass the content check/.test(c.text))).toBe(true);
  });

  it('a blocked render: the verdict follow-ups ("redraw safer") ride the run summary, the image is never published', async () => {
    const safety = installSafetyFakes();
    safety.llm.script.vision = [{ rating: 'X', categories: ['graphic_gore'], notes: ['too much'], photo: false, minorLikely: false, subject: 'other', view: 'none', caption: '', multipleSubjects: false }];
    const doc = plannedDoc();
    const session = newSession(doc);
    const ctx = testContext(session);
    const run = await startAction(ctx, { type: 'render_sheets', characterIds: ['c_arjun'], quotedUsd: 1 }, { confirmed: true, origin: 'user' });
    await run.done;
    await ctx.settled();
    const sheet = session.doc.cast[1].sheet;
    expect(ctx.assetsFake.quarantined.length).toBe(1);
    const summary = [...session.doc.conversation].reverse().find((m) => m.role === 'assistant')!;
    expect(summary.text).toMatch(/didn't fit the content rules/);
    expect(summary.cards?.some((c) => c.type === 'notice' && /didn't fit the content rules/.test(c.text))).toBe(true);
    // The verdict's chips, priced: a redraw (with its quote) and a free second look.
    const redraw = (summary.nextSteps || []).find((s) => s.label === 'Redraw the sheet');
    expect(redraw).toMatchObject({ action: { type: 'render_sheets', characterIds: ['c_arjun'], force: true, quotedUsd: expect.any(Number) } });
    expect(redraw!.usd).toBeGreaterThan(0);
    expect((summary.nextSteps || []).some((s) => s.action?.type === 'safety_recheck')).toBe(true);
    const signed = ctx.assetsFake.signed.flat();
    expect(signed).not.toContain(ctx.assetsFake.quarantined[0].path);
    // A first take has no earlier version to fall back to: it stays, withheld (never served to anyone).
    expect(canServeToOwner(sheet.asset)).toBe(false);
    expect(sheet.asset?.safety).toMatchObject({ assessed: 'X', quarantined: true });
  });
});

describe('recheck_page honesty (P2-SERVER review)', () => {
  const drawnDoc = (lettering: 'overlay' | 'in_art' = 'overlay') => {
    const doc = plannedDoc();
    doc.format = { ...doc.format, lettering };
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/p1.webp', source: 'generated', at: 1 }, qc: { score: 0.9, issues: [], checkedAt: 1 } };
    return doc;
  };

  it('usage said no: the message says so (no "try later"), nothing was spent, balloons re-laid for free', async () => {
    const session = newSession(drawnDoc());
    const ctx = testContext(session, { billing: fakeBilling(0) });
    const quotedUsd = estimateSpendAction(session.doc, { type: 'recheck_page', pageId: 'pg_1' }, false).usd;
    const out = await startAction(ctx, { type: 'recheck_page', pageId: 'pg_1', quotedUsd }, { confirmed: true, origin: 'user' });
    expect(out.outcome.message).toMatch(/^You've used this month's included generation allowance\. Page 1's balloons were re-laid from the stored layout instead — nothing was spent\.$/);
    expect(session.doc.spend.entries).toHaveLength(0);
    expect(ctx.llmFake.calls).toHaveLength(0);
  });

  it('an in_art comic: the quote and the outcome never promise balloons; the cost is read from its own ledger entry', async () => {
    const session = newSession(drawnDoc('in_art'));
    const ctx = testContext(session);
    const gated = await startAction(ctx, { type: 'recheck_page', pageId: 'pg_1' }, { confirmed: false, origin: 'user', forceGate: 'policy' });
    expect(gated.outcome.status).toBe('gated');
    expect(session.doc.gate!.summary).toMatch(/its page check is renewed/);
    expect(session.doc.gate!.summary).not.toMatch(/balloon/);
    const ran = await startAction(ctx, { type: 'approve_gate', gateId: session.doc.gate!.id }, { confirmed: true, origin: 'user' });
    await ran.done;
    const qcEntries = session.doc.spend.entries.filter((e) => e.kind === 'qc');
    expect(qcEntries).toHaveLength(1);
    const last = [...session.doc.conversation].reverse().find((m) => m.role === 'assistant')!;
    expect(last.text).toMatch(/^Re-checked page 1 \(/);
    expect(last.text).not.toMatch(/balloon/);
  });
});

describe('relayout is free (activity badge)', () => {
  it('relayout_balloons says Free on the status line and makes no AI call', async () => {
    const doc = plannedDoc();
    doc.pages[0].render = { ...emptyRender(), status: 'ready', asset: { path: 'u/user-1/p/proj-1/img/p1.webp', source: 'generated', at: 1 } };
    const { session, ctx } = ctxFor(doc);
    const out = await startAction(ctx, { type: 'relayout_balloons', pageId: 'pg_1' }, { confirmed: false, origin: 'user' });
    expect(out.outcome.message).toMatch(/free — no AI call/);
    expect(ctx.events.some((e) => e.type === 'activity' && e.cost === 'free')).toBe(true);
    expect(ctx.llmFake.calls).toHaveLength(0);
    expect(session.doc.pages[0].balloons.map((b) => b.lineId)).toEqual(['ln_1_2']);
  });
});
