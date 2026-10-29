import { describe, expect, it } from 'vitest';
import { makeSampleDoc } from '../../components/comicstudio/board/__fixtures__/sampleDoc';
import { createEmptyDoc, normalizeDoc, trashOf, type ComicDoc, type RefOwner } from './doc';
import { applyOp, applyOps, CLIENT_PATCHABLE_OPS, type DocOp } from './ops';
import { describeOps, inverseOps, isUndoable } from './undo';
import { refsOf } from './refs';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const sampleV5 = (): ComicDoc =>
  applyOps(normalizeDoc(makeSampleDoc()), [
    { op: 'edition', lang: 'hi', patch: {} },
    { op: 'translation', lang: 'hi', lineId: 'pg_1_l2', patch: { text: 'बस एक और…', status: 'reviewed', sourceHash: 'x', at: 5, gloss: 'Just one more' } },
    { op: 'edition_balloon', lang: 'hi', lineId: 'pg_1_l2', patch: { x: 0.1, fontScale: 0.9 } },
    { op: 'edition_text', lang: 'hi', field: 'cover.title', value: { text: 'केसर चोर', status: 'edited', sourceHash: 't', at: 3 } },
    { op: 'glossary_term', id: 'g_maya', patch: { term: 'Maya', kind: 'character', refId: 'ch_maya', forms: { hi: 'माया' } } },
    { op: 'ref_add', owner: { kind: 'inbox' }, ref: { path: 'inbox1.jpg', source: 'upload', at: 3 } },
    { op: 'ref_add', owner: { kind: 'inbox' }, ref: { path: 'inbox2.jpg', source: 'upload', at: 4, label: 'face' } },
    { op: 'line_style', pageId: 'pg_1', lineIds: ['pg_1_l3'], patch: { shape: 'jagged' } },
    { op: 'letter_style', patch: { presetId: 'storybook', base: { fill: '#fafafa' } } }
  ], 1);

const ownerV4 = (): ComicDoc => {
  const doc = normalizeDoc({
    ...createEmptyDoc('lake', 'Playtime at the Lake', 5),
    letterStyle: undefined,
    brief: { title: 'Playtime at the Lake', audience: 'kids 2–6', notes: [] },
    format: { kind: 'storybook', pageCount: 1, pageAspect: '4:5', panelsPerPage: 4, readingDirection: 'ltr', lettering: 'overlay', colorMode: 'color', language: 'en' },
    cast: [{ id: 'c_baby', name: 'The Baby', tier: 'lead', look: { summary: 'Toddler in a yellow romper' }, refs: [], sheet: { status: 'ready', history: [], asset: { path: 'baby.webp', source: 'generated', at: 1 } } }],
    pages: [
      {
        id: 'pg_1', n: 1, summary: 'Lake', layout: '', balloons: [{ lineId: 'l1', x: 0, y: 0, w: 0.3 }],
        render: { status: 'ready', history: [{ path: 'p1_old.webp', source: 'generated', at: 1 }], asset: { path: 'p1.webp', source: 'generated', at: 2 } },
        panels: [1, 2, 3, 4].map((n) => ({
          id: `pn${n}`, n, size: 'medium' as const, shot: 'medium' as const, action: `Beat ${n}`, castIds: ['c_baby'],
          lines: [{ id: `l${n}`, kind: 'speech' as const, speakerId: 'c_baby', text: `Line ${n}` }]
        }))
      }
    ]
  });
  return doc;
};

// ── Wire-equality comparator (R4: null ≡ unset; trash/glossary order is presentation-only) ──

const canonical = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === null || val === undefined) continue;
      out[k] = canonical(val);
    }
    return out;
  }
  return v;
};
const comparable = (doc: ComicDoc) => {
  const c = canonical({ ...doc, updatedAt: 0 }) as ComicDoc;
  if (c.trash) c.trash = [...c.trash].sort((a, b) => a.page.id.localeCompare(b.page.id));
  if (c.i18n) c.i18n = { ...c.i18n, glossary: [...c.i18n.glossary].sort((a, b) => a.id.localeCompare(b.id)) };
  return c;
};

// ── Random op generator (seeded) ─────────────────────────────────────────────

const mulberry32 = (seed: number) => {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const LANGS = ['hi', 'te', 'es', 'ja'];

function randomOp(doc: ComicDoc, r: () => number, step: number): DocOp {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(r() * list.length)];
  const chance = (p: number) => r() < p;
  const uid = (p: string) => `${p}_${step}_${Math.floor(r() * 1e6)}`;
  const pages = doc.pages;
  const page = pages.length ? pick(pages) : undefined;
  const panel = page?.panels.length ? pick(page.panels) : undefined;
  const line = panel?.lines.length ? pick(panel.lines) : undefined;
  const allLines = pages.flatMap((p) => p.panels.flatMap((pn) => pn.lines));
  const anyLine = allLines.length ? pick(allLines) : undefined;
  const char = doc.cast.length ? pick(doc.cast) : undefined;
  const owners: RefOwner[] = [{ kind: 'style' }, { kind: 'inbox' }, ...doc.cast.map((c) => ({ kind: 'character' as const, id: c.id })), ...doc.places.map((p) => ({ kind: 'place' as const, id: p.id }))];
  const owner = pick(owners);
  const ownerRefs = refsOf(doc, owner) || [];
  const ref = ownerRefs.length ? pick(ownerRefs) : undefined;
  const editions = Object.keys(doc.i18n?.editions || {});
  const lang = chance(0.7) && editions.length ? pick(editions) : pick(LANGS);
  const historyPaths = pages.flatMap((p) => p.render.history.map((v) => v.path));
  const kinds = [
    'brief', 'note_add', 'format', 'settings', 'source', 'style', 'cover', 'plan_status', 'character', 'character_remove', 'place',
    'place_remove', 'page', 'panel', 'line', 'line_del', 'line_move', 'line_style', 'letter_style', 'balloon', 'balloons', 'pages_reorder',
    'page_insert', 'page_duplicate', 'page_delete', 'page_restore', 'book', 'reader', 'version_star', 'ref_add', 'ref_patch',
    'ref_move', 'ref_remove', 'ref_transfer', 'edition', 'translation', 'edition_text', 'edition_balloon', 'glossary_term'
  ] as const;
  switch (pick(kinds)) {
    case 'brief':
      return { op: 'brief', patch: chance(0.5) ? { logline: `L${step}` } : { title: `T${step}`, tone: chance(0.5) ? 'warm' : undefined } };
    case 'note_add':
      return { op: 'note_add', text: `note ${step % 3}` };
    case 'format':
      return { op: 'format', patch: chance(0.5) ? { pageAspect: pick(['2:3', '4:5', '1:1'] as const) } : { lettering: pick(['overlay', 'in_art'] as const) } };
    case 'settings':
      return { op: 'settings', patch: chance(0.5) ? { rating: pick(['G', 'PG', 'PG-13'] as const) } : { bigSpendUsd: Math.round(r() * 100) / 100 } };
    case 'source':
      return { op: 'source', patch: { script: `S${step}` } };
    case 'style':
      return { op: 'style', patch: { name: `Style ${step}`, ...(chance(0.5) ? { spec: `spec ${step}` } : {}) } };
    case 'cover':
      return { op: 'cover', patch: chance(0.5) ? { title: `C${step}` } : { lettering: 'overlay', tagline: `tag ${step}` } };
    case 'plan_status':
      return { op: 'plan_status', status: pick(['none', 'draft', 'approved'] as const) };
    case 'character':
      return chance(0.4) || !char
        ? { op: 'character', id: uid('ch'), patch: { name: `New ${step}`, kind: 'animal', count: 3, look: { summary: 'ducklings' } } }
        : { op: 'character', id: char.id, patch: { name: `Renamed ${step}`, look: { hair: `hair ${step}` } as never, ...(chance(0.3) ? { voice: 'squeaky' } : {}) } };
    case 'character_remove':
      return { op: 'character_remove', id: char?.id || 'ghost' };
    case 'place':
      return chance(0.5) || !doc.places.length
        ? { op: 'place', id: uid('pl'), patch: { name: `Lake ${step}`, look: 'reeds' } }
        : { op: 'place', id: doc.places[0].id, patch: { look: `look ${step}` } };
    case 'place_remove':
      return { op: 'place_remove', id: doc.places.length ? pick(doc.places).id : 'ghost' };
    case 'page':
      return { op: 'page', id: page?.id || 'ghost', patch: chance(0.5) ? { summary: `sum ${step}` } : { chapterTitle: `Ch ${step}` } };
    case 'panel':
      return { op: 'panel', pageId: page?.id || 'ghost', id: panel?.id || 'ghost', patch: chance(0.5) ? { action: `act ${step}` } : { castIds: char ? [char.id] : [] } };
    case 'line':
      if (!line || chance(0.4)) {
        return { op: 'line', pageId: page?.id || 'ghost', panelId: panel?.id || 'ghost', id: uid('ln'), patch: { kind: 'caption', text: `new ${step}`, ...(chance(0.5) ? { style: { italic: true } } : {}) }, index: Math.floor(r() * 3) };
      }
      return { op: 'line', pageId: page!.id, panelId: panel!.id, id: line.id, patch: chance(0.5) ? { text: `edit ${step}` } : { style: { fill: '#ffeeaa' }, kind: 'shout' } };
    case 'line_del':
      return { op: 'line', pageId: page?.id || 'ghost', panelId: panel?.id || 'ghost', id: line?.id || 'ghost', patch: null };
    case 'line_move': {
      const to = page?.panels.length ? pick(page.panels) : undefined;
      return { op: 'line_move', pageId: page?.id || 'ghost', id: line?.id || 'ghost', toPanelId: to?.id || 'ghost', ...(chance(0.7) ? { index: Math.floor(r() * 4) } : {}) };
    }
    case 'line_style': {
      const ids = page ? page.panels.flatMap((p) => p.lines.map((l) => l.id)).filter(() => chance(0.5)) : [];
      const mode = pick(['merge', 'replace', undefined] as const);
      return { op: 'line_style', pageId: page?.id || 'ghost', lineIds: ids, patch: chance(0.2) ? null : { shape: pick(['oval', 'cloud', 'rect'] as const), sizeScale: 1.2 }, ...(mode ? { mode } : {}) };
    }
    case 'letter_style':
      return pick<DocOp>([
        { op: 'letter_style', patch: { presetId: pick(['classic', 'manga', 'noir', 'storybook'] as const) } },
        { op: 'letter_style', patch: { presetId: 'webtoon', keepOverrides: true } },
        { op: 'letter_style', patch: { base: { textColor: '#222222' }, kinds: { sfx: { font: 'ultra' } }, safeMargin: 0.05 } },
        { op: 'letter_style', patch: { base: null, auto: true } },
        { op: 'letter_style', patch: { speakers: { ch_maya: { shape: 'electronic' } } } },
        { op: 'letter_style', patch: null }
      ]);
    case 'balloon':
      return { op: 'balloon', pageId: page?.id || 'ghost', lineId: anyLine?.id || 'ghost', patch: { x: Math.round(r() * 100) / 100, y: 0.2, w: 0.3, ...(chance(0.3) ? { locked: true } : {}) } };
    case 'balloons':
      return { op: 'balloons', pageId: page?.id || 'ghost', balloons: line ? [{ lineId: line.id, x: 0.1, y: 0.1, w: 0.2 }] : [] };
    case 'pages_reorder': {
      const ids = pages.map((p) => p.id).sort(() => r() - 0.5).slice(0, Math.max(1, Math.floor(r() * pages.length)));
      return { op: 'pages_reorder', order: ids };
    }
    case 'page_insert':
      return { op: 'page_insert', id: uid('pg'), after: Math.floor(r() * (pages.length + 1)), ...(chance(0.5) ? { patch: { summary: 'inserted', chapterTitle: 'New chapter' } } : {}) };
    case 'page_duplicate':
      return { op: 'page_duplicate', id: page?.id || 'ghost', newId: uid('dup'), ...(chance(0.5) ? { after: 0 } : {}) };
    case 'page_delete':
      return { op: 'page_delete', id: page?.id || 'ghost', deletedAt: 1000 + step };
    case 'page_restore': {
      const t = trashOf(doc);
      return { op: 'page_restore', id: t.length ? pick(t).page.id : 'ghost', ...(chance(0.5) ? { n: 1 } : {}) };
    }
    case 'book':
      return { op: 'book', patch: chance(0.5) ? { titlePage: chance(0.5), blurb: `blurb ${step}` } : { credits: ['Me'], backCover: 'auto' } };
    case 'reader':
      return { op: 'reader', patch: chance(0.5) ? { turn: pick(['paper', 'slide', 'fade'] as const) } : { dedication: `For ${step}`, ambient: false } };
    case 'version_star':
      return { op: 'version_star', path: historyPaths.length ? pick(historyPaths) : 'ghost', starred: chance(0.7) };
    case 'ref_add':
      return { op: 'ref_add', owner, ref: { path: uid('ref') + '.jpg', source: 'upload', at: step, ...(chance(0.5) ? { label: 'front' } : {}) }, ...(chance(0.5) ? { index: 0 } : {}) };
    case 'ref_patch':
      return { op: 'ref_patch', owner, path: ref?.path || 'ghost', patch: chance(0.5) ? { label: 'side', note: `n${step}` } : { path: uid('crop') + '.jpg' } };
    case 'ref_move': {
      const busy = owners.find((o) => (refsOf(doc, o) || []).length >= 2);
      if (!busy) return { op: 'ref_add', owner, ref: { path: uid('ref') + '.jpg', source: 'upload', at: step } };
      const list = refsOf(doc, busy)!;
      const from = Math.floor(r() * list.length);
      return { op: 'ref_move', owner: busy, path: list[from].path, to: (from + 1 + Math.floor(r() * (list.length - 1))) % list.length };
    }
    case 'ref_remove':
      return { op: 'ref_remove', owner, path: ref?.path || 'ghost' };
    case 'ref_transfer': {
      const to = pick(owners);
      return { op: 'ref_transfer', from: owner, to, path: ref?.path || 'ghost', ...(chance(0.5) ? { index: 0 } : {}) };
    }
    case 'edition':
      return { op: 'edition', lang, patch: chance(0.3) ? null : chance(0.5) ? {} : { register: pick(['formal', 'everyday', 'code_mixed'] as const) } };
    case 'translation':
      return chance(0.3)
        ? { op: 'translation', lang, lineId: anyLine?.id || 'ghost', patch: null }
        : { op: 'translation', lang, lineId: anyLine?.id || 'ghost', patch: chance(0.5) ? { text: `t${step}`, status: 'machine', sourceHash: 'h', at: step } : { status: 'reviewed', issue: { severity: 'minor', note: 'n' } } };
    case 'edition_text':
      return { op: 'edition_text', lang, field: pick(['cover.title', 'cover.tagline', 'brief.title', 'brief.logline'] as const), value: chance(0.3) ? null : { text: `x${step}`, status: 'edited', sourceHash: 's', at: step } };
    case 'edition_balloon':
      return { op: 'edition_balloon', lang, lineId: anyLine?.id || 'ghost', patch: chance(0.3) ? null : { y: Math.round(r() * 100) / 100, ...(chance(0.5) ? { fontScale: 0.8 } : {}) } };
    case 'glossary_term':
      return chance(0.3)
        ? { op: 'glossary_term', id: pick(['g_maya', 'g_new']), patch: null }
        : { op: 'glossary_term', id: pick(['g_maya', 'g_new']), patch: { term: 'Term', forms: { te: `f${step}` }, ...(chance(0.5) ? { note: 'n' } : {}) } };
    default:
      return { op: 'note_add', text: 'x' };
  }
}

describe('inverseOps (contract §6)', () => {
  it('property: 500 random patchable sequences on two fixtures undo exactly (wire equality)', () => {
    const fixtures = [sampleV5(), ownerV4()];
    let checked = 0;
    let effective = 0;
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 250; seed += 1) {
      for (const fixture of fixtures) {
        const r = mulberry32(seed * 7919 + fixtures.indexOf(fixture));
        const before = fixture;
        const ops: DocOp[] = [];
        let cur = before;
        const n = 1 + Math.floor(r() * 10);
        for (let i = 0; i < n; i += 1) {
          const op = randomOp(cur, r, i);
          expect(CLIENT_PATCHABLE_OPS.has(op.op)).toBe(true);
          ops.push(op);
          const next = applyOps(cur, [op], 2);
          if (JSON.stringify(comparable(next)) !== JSON.stringify(comparable(cur))) {
            effective += 1;
            kinds.add(op.op);
          }
          cur = next;
        }
        const inv = inverseOps(before, ops);
        const undone = applyOps(cur, inv, 3);
        const want = comparable(before);
        const got = comparable(undone);
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          // Surface the failing sequence for debugging.
          expect({ seed, ops, inv, got }).toEqual({ seed, ops, inv, got: want });
        }
        checked += 1;
      }
    }
    expect(checked).toBe(500);
    // The generator must mostly produce ops that really change the doc, across every patchable op kind
    // except render_use (whose inverse restores the asset but not the exact history order; tested below).
    expect(effective).toBeGreaterThan(1200);
    expect([...CLIENT_PATCHABLE_OPS].filter((k) => k !== 'render_use' && !kinds.has(k))).toEqual([]);
  });

  it('ignores non-patchable ops and reports undoability', () => {
    const doc = sampleV5();
    const ops: DocOp[] = [
      { op: 'message', msg: { id: 'm', role: 'assistant', text: 'hi', at: 1 } },
      { op: 'brief', patch: { logline: 'x' } }
    ];
    expect(inverseOps(doc, ops)).toEqual([{ op: 'brief', patch: { logline: 'A pickpocket steals saffron to pay for her brother’s surgery.' } }]);
    expect(isUndoable(doc, ops)).toBe(false);
    expect(isUndoable(doc, [ops[1]])).toBe(true);
  });

  it('render_use undoes back to the previous current asset; without one it is not undoable', () => {
    const doc = sampleV5();
    const op: DocOp = { op: 'render_use', target: { kind: 'page', id: 'pg_1' }, path: 'u/proj/pages/p1.png.old', at: 9 };
    const after = applyOps(doc, [op]);
    const undone = applyOps(after, inverseOps(doc, [op]));
    expect(undone.pages[0].render.asset?.path).toBe('u/proj/pages/p1.png');
    const adopt: DocOp = { op: 'render_use', target: { kind: 'page', id: 'pg_2' }, path: 'u/proj/pages/p1.png', at: 9 };
    expect(isUndoable(doc, [adopt])).toBe(false);
  });

  it('line_move: across panels and within one, undo is exact; balloons and editions are never touched', () => {
    const before = sampleV5();
    const page = before.pages[0];
    const order = (d: ComicDoc) => d.pages[0].panels.map((p) => p.lines.map((l) => l.id));
    const move: DocOp = { op: 'line_move', pageId: 'pg_1', id: 'pg_1_l2', toPanelId: 'pg_1_p3', index: 1 };
    const after = applyOp(before, move);
    expect(order(after)).toEqual([['pg_1_l1'], [], ['pg_1_l3', 'pg_1_l2', 'pg_1_l4', 'pg_1_l5']]);
    expect(after.pages[0].panels[2].lines[1]).toBe(page.panels[1].lines[0]); // the same Line object
    expect(after.pages[0].balloons).toBe(page.balloons);
    expect(after.i18n).toBe(before.i18n); // the hi translation and edition balloon of pg_1_l2 stay
    expect(inverseOps(before, [move])).toEqual([{ op: 'line_move', pageId: 'pg_1', id: 'pg_1_l2', toPanelId: 'pg_1_p2', index: 0 }]);
    expect(comparable(applyOps(after, inverseOps(before, [move])))).toEqual(comparable(before));
    expect(isUndoable(before, [move])).toBe(true);
    // Within one panel: no index = last; moving to where it already sits is a no-op (nothing to undo).
    const reorder: DocOp = { op: 'line_move', pageId: 'pg_1', id: 'pg_1_l3', toPanelId: 'pg_1_p3' };
    const reordered = applyOp(before, reorder);
    expect(order(reordered)[2]).toEqual(['pg_1_l4', 'pg_1_l5', 'pg_1_l3']);
    expect(comparable(applyOps(reordered, inverseOps(before, [reorder])))).toEqual(comparable(before));
    expect(applyOp(before, { op: 'line_move', pageId: 'pg_1', id: 'pg_1_l3', toPanelId: 'pg_1_p3', index: 0 })).toBe(before);
    // Unknown page, line or panel: no-op (R6), so no inverse.
    for (const ghost of [{ pageId: 'ghost', id: 'pg_1_l3', toPanelId: 'pg_1_p3' }, { pageId: 'pg_1', id: 'ghost', toPanelId: 'pg_1_p3' }, { pageId: 'pg_1', id: 'pg_1_l3', toPanelId: 'ghost' }]) {
      expect(applyOp(before, { op: 'line_move', ...ghost })).toBe(before);
      expect(inverseOps(before, [{ op: 'line_move', ...ghost }])).toEqual([]);
    }
    expect(describeOps([move])).toBe('move a line to another panel');
    expect(describeOps([move, reorder])).toBe('move 2 lines to other panels');
  });

  it('describeOps labels', () => {
    expect(describeOps([{ op: 'line_style', pageId: 'p', lineIds: ['a', 'b', 'c'], patch: { italic: true } }])).toBe('restyle 3 balloons');
    expect(describeOps([{ op: 'page_delete', id: 'p', deletedAt: 1 }])).toBe('delete a page');
    expect(describeOps([{ op: 'balloon', pageId: 'p', lineId: 'a', patch: {} }, { op: 'balloon', pageId: 'p', lineId: 'b', patch: {} }])).toBe('move 2 balloons');
    expect(describeOps([{ op: 'pages_reorder', order: [] }, { op: 'book', patch: {} }])).toBe('reorder pages and 1 more change');
    expect(describeOps([{ op: 'message', msg: { id: 'm', role: 'user', text: '', at: 1 } }])).toBe('change');
  });
});
