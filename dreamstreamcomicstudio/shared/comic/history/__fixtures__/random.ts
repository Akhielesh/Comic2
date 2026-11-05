// Seeded random books and edit histories for the Comic History property tests (package H0). Synthetic only.
//
// randomBook(seed) builds a normalized doc that uses every section (pages with drawn versions, balloons, cast with
// refs and crop originals, places, style options and board, cover, two editions with orphan lines, glossary,
// archive, trash) and every excluded record (spend, conversation with attachments, memory, settings, safety,
// publication, the model lock, the inbox, an open gate). evolveBook applies a random sequence of real DocOps —
// the way a book changes after a version was saved — so property tests restore one branch into another.

import { normalizeDoc, type AssetRef, type ComicDoc, type Line, type Page, type Panel, type RenderState, type RenderVersion, type TextTranslation } from '../../doc.js';
import { lineSourceHash } from '../../i18n.js';
import { applyOp, type DocOp } from '../../ops.js';
import type { RestoreScope } from '../types.js';
import { sectionSignatures } from '../sections.js';

export type Rng = () => number;

/** mulberry32: a tiny deterministic PRNG. */
export const rngOf = (seed: number): Rng => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pickOne = <T>(r: Rng, list: readonly T[]): T | undefined => (list.length ? list[Math.floor(r() * list.length)] : undefined);
const chance = (r: Rng, p: number) => r() < p;

const T0 = 1_761_000_000_000;

/** A unique-name source per doc (paths and ids never collide across sides of a test). */
export interface Namer {
  path(kind: string): string;
  id(prefix: string): string;
  at(): number;
}
export const namerOf = (tag: string): Namer => {
  let n = 0;
  return {
    path: (kind) => `u/user-r/p/${tag}/img/${kind}-${(n += 1)}.webp`,
    id: (prefix) => `${prefix}_${tag}_${(n += 1)}`,
    at: () => T0 + (n += 1) * 1000
  };
};

const asset = (nm: Namer, kind: string): AssetRef => ({ path: nm.path(kind), source: 'generated', model: 'nano-banana-2.1', at: nm.at(), w: 800, h: 1200 });
const versionOf = (nm: Namer, kind: string): RenderVersion => ({ ...asset(nm, kind), origin: 'render', costUsd: 0.04 });
const render = (r: Rng, nm: Namer, kind: string, maxHistory = 8): RenderState => {
  if (chance(r, 0.25)) return { status: 'none', history: [] };
  return {
    status: 'ready',
    asset: asset(nm, kind),
    history: Array.from({ length: int(r, 0, maxHistory) }, () => versionOf(nm, kind)),
    origin: 'render',
    model: 'nano-banana-2.1',
    updatedAt: nm.at()
  };
};

const randomLine = (r: Rng, nm: Namer, castIds: string[]): Line => {
  const kind = pickOne(r, ['speech', 'caption', 'thought', 'shout', 'sfx'] as const)!;
  const l: Line = { id: nm.id('l'), kind, text: `Words ${int(r, 1, 999)} of ${nm.id('w')}` };
  if (kind !== 'caption' && kind !== 'sfx' && castIds.length) l.speakerId = pickOne(r, castIds);
  return l;
};

const randomPage = (r: Rng, nm: Namer, castIds: string[], placeIds: string[]): Page => {
  const panels: Panel[] = Array.from({ length: int(r, 1, 3) }, (_, i) => ({
    id: nm.id('pn'),
    n: i + 1,
    size: 'medium',
    shot: pickOne(r, ['wide', 'medium', 'close_up'] as const)!,
    action: `Action ${nm.id('a')}`,
    castIds: castIds.filter(() => chance(r, 0.5)),
    ...(placeIds.length && chance(r, 0.5) ? { placeId: pickOne(r, placeIds) } : {}),
    lines: Array.from({ length: int(r, 0, 3) }, () => randomLine(r, nm, castIds))
  }));
  const lines = panels.flatMap((p) => p.lines);
  return {
    id: nm.id('pg'),
    n: 0,
    summary: `Summary ${nm.id('s')}`,
    layout: 'Row 1: two equal panels.',
    panels,
    render: render(r, nm, 'page'),
    balloons: lines.filter(() => chance(r, 0.6)).map((l) => ({ lineId: l.id, x: r(), y: r(), w: 0.25, ...(chance(r, 0.2) ? { pinned: true } : {}) }))
  };
};

const translate = (r: Rng, l: Line, lang: string): TextTranslation => ({
  text: `${lang}:${l.text}`,
  status: pickOne(r, ['machine', 'reviewed', 'edited'] as const)!,
  sourceHash: chance(r, 0.8) ? lineSourceHash(l) : 'stale',
  at: T0
});

/** A normalized book using every section and every excluded record. */
export const randomBook = (seed: number): ComicDoc => {
  const r = rngOf(seed);
  const nm = namerOf(`b${seed}`);
  const cast = Array.from({ length: int(r, 1, 4) }, () => ({
    id: nm.id('ch'),
    name: `Name ${nm.id('n')}`,
    tier: 'lead' as const,
    look: { summary: `Look ${nm.id('lk')}` },
    refs: Array.from({ length: int(r, 0, 2) }, () => ({
      ...asset(nm, 'ref'),
      source: 'upload' as const,
      ...(chance(r, 0.4) ? { original: { path: nm.path('orig'), w: 1600, h: 1600 } } : {})
    })),
    sheet: render(r, nm, 'sheet')
  }));
  const places = Array.from({ length: int(r, 0, 2) }, () => ({ id: nm.id('pl'), name: `Place ${nm.id('pn')}`, look: 'A place', refs: [], sheet: render(r, nm, 'place') }));
  const castIds = cast.map((c) => c.id);
  const placeIds = places.map((p) => p.id);
  const pages = Array.from({ length: int(r, 1, 6) }, (_, i) => ({ ...randomPage(r, nm, castIds, placeIds), n: i + 1 }));
  const lines = pages.flatMap((p) => p.panels.flatMap((x) => x.lines));
  const editions: NonNullable<ComicDoc['i18n']>['editions'] = {};
  for (const lang of ['te', 'hi']) {
    if (!chance(r, 0.7)) continue;
    const tl: Record<string, TextTranslation> = {};
    for (const l of lines) if (chance(r, 0.6)) tl[l.id] = translate(r, l, lang);
    if (chance(r, 0.5)) tl[nm.id('orphan')] = { text: 'orphan', status: 'edited', sourceHash: 'x', at: T0 };
    const balloons: Record<string, { y: number }> = {};
    for (const l of lines) if (chance(r, 0.2)) balloons[l.id] = { y: r() };
    editions[lang] = { lang, lines: tl, balloons, register: 'everyday' };
  }
  const trash = Array.from({ length: int(r, 0, 2) }, () => {
    const page = { ...randomPage(r, nm, castIds, placeIds), n: 9 };
    return { page, fromN: 9, deletedAt: nm.at() };
  });
  const doc = {
    id: `proj_${seed}`,
    v: 1,
    createdAt: T0,
    updatedAt: T0,
    rev: int(r, 1, 300),
    brief: { title: `Book ${seed}`, notes: ['a note'] },
    format: { kind: 'comic', pageCount: pages.length, pageAspect: '2:3', panelsPerPage: 'auto', readingDirection: 'ltr', lettering: chance(r, 0.8) ? 'overlay' : 'in_art', colorMode: 'color', language: 'en' },
    source: { script: `Script ${seed}` },
    style: {
      status: 'locked',
      spec: `Style ${seed}`,
      refs: chance(r, 0.5) ? [{ ...asset(nm, 'styleref'), source: 'upload' }] : [],
      ...(chance(r, 0.6) ? { board: asset(nm, 'board') } : {}),
      options: Array.from({ length: int(r, 0, 2) }, () => ({ id: nm.id('so'), name: 'Option', spec: 'Spec', render: render(r, nm, 'option', 2) }))
    },
    cast,
    places,
    pages,
    cover: { title: `Cover ${seed}`, render: render(r, nm, 'cover') },
    planStatus: 'approved',
    settings: { quality: 'standard', confirm: 'big', bigSpendUsd: 0.5, reviewFirstRender: true, budgetUsd: 7 },
    spend: { totalUsd: 0.3, byKind: { page: 0.3 }, entries: [{ id: nm.id('sp'), at: T0, kind: 'page', label: 'Page', usd: 0.3, byok: false, estimated: false }] },
    gate: { id: 'gate_1', action: { type: 'render_pages' }, title: 'Draw', summary: 'Draw pages', estimateUsd: 0.2, imageCount: 2, model: 'm', createdAt: T0, status: 'open', reason: 'policy' },
    conversation: [{ id: 'm1', role: 'user', text: 'hi', at: T0, attachments: [{ ...asset(nm, 'attach'), source: 'upload' }] }],
    memory: `memory ${seed}`,
    letterStyle: { presetId: 'classic' },
    book: { titlePage: false, endPage: false, backCover: 'none', firstPageRight: true, uniformTrim: true },
    reader: { turn: 'paper', guidedOverview: true, paperTexture: true, ambient: true },
    archive: Array.from({ length: int(r, 0, 10) }, () => ({ ...asset(nm, 'arch'), targetKey: pages[0] ? `page:${pages[0].id}` : 'cover', label: 'Page 1', archivedAt: nm.at() })),
    trash,
    refInbox: chance(r, 0.5) ? [{ ...asset(nm, 'inbox'), source: 'upload' }] : [],
    i18n: { editions, glossary: chance(r, 0.6) ? [{ id: nm.id('g'), term: 'Term', kind: 'term', policy: 'keep', forms: { te: 'T' } }] : [] },
    safety: { ipNoted: ['X'] },
    publication: { visibility: 'unlisted', status: 'live', publishedRev: 3, publishedAt: T0, languages: ['en'] },
    planInputHash: chance(r, 0.5) ? `plan-${seed}` : undefined,
    imageModel: { modelId: 'nano-banana-2.1', lockedAt: T0, origin: 'first_render' }
  } as unknown as ComicDoc;
  return normalizeDoc(doc);
};

/** One random, real edit (a DocOp) on `doc`, or null when nothing applies. */
const randomOp = (doc: ComicDoc, r: Rng, nm: Namer, allowBusy: boolean): DocOp | null => {
  const page = pickOne(r, doc.pages);
  const panel = page && pickOne(r, page.panels);
  const ln = panel && pickOne(r, panel.lines);
  const ch = pickOne(r, doc.cast);
  const lang = pickOne(r, Object.keys(doc.i18n?.editions || {}));
  const allLines = doc.pages.flatMap((p) => p.panels.flatMap((x) => x.lines));
  switch (int(r, 0, 21)) {
    case 0:
      return ln && page && panel ? { op: 'line', pageId: page.id, panelId: panel.id, id: ln.id, patch: { text: `Edited ${nm.id('e')}` } } : null;
    case 1:
      return page && panel ? { op: 'line', pageId: page.id, panelId: panel.id, id: nm.id('l'), patch: { kind: 'speech', text: 'New line' } } : null;
    case 2:
      return ln && page && panel ? { op: 'line', pageId: page.id, panelId: panel.id, id: ln.id, patch: null } : null;
    case 3:
      return { op: 'page_insert', id: nm.id('pg'), after: int(r, 0, doc.pages.length), patch: { summary: 'Inserted' } };
    case 4:
      return page ? { op: 'page_delete', id: page.id, deletedAt: nm.at() } : null;
    case 5:
      return page ? { op: 'page_duplicate', id: page.id, newId: nm.id('pg') } : null;
    case 6:
      return { op: 'pages_reorder', order: [...doc.pages.map((p) => p.id)].sort(() => r() - 0.5) };
    case 7: {
      const t = pickOne(r, doc.trash || []);
      return t ? { op: 'page_restore', id: t.page.id } : null;
    }
    case 8:
    case 9: {
      const target = pickOne(r, [
        ...(page ? [{ kind: 'page' as const, id: page.id }] : []),
        { kind: 'cover' as const },
        ...(ch ? [{ kind: 'sheet' as const, id: ch.id }] : [])
      ])!;
      return { op: 'render', target, patch: { status: 'ready', asset: asset(nm, 'redraw'), origin: 'render', updatedAt: nm.at() } };
    }
    case 10: {
      const v = page && pickOne(r, page.render.history);
      return page && v ? { op: 'render_use', target: { kind: 'page', id: page.id }, path: v.path, at: nm.at() } : null;
    }
    case 11:
      return { op: 'character', id: nm.id('ch'), patch: { name: 'New friend', tier: 'support', look: { summary: 'new' } } };
    case 12:
      return ch ? { op: 'character', id: ch.id, patch: { look: { summary: `Changed ${nm.id('lk')}` } } } : null;
    case 13:
      return ch && chance(r, 0.4) ? { op: 'character_remove', id: ch.id } : null;
    case 14:
      return { op: 'place', id: nm.id('pl'), patch: { name: 'New place', look: 'new' } };
    case 15:
      return lang && allLines.length ? { op: 'translations', lang, lines: Object.fromEntries(allLines.filter(() => chance(r, 0.4)).map((l) => [l.id, translate(r, l, lang)])) } : null;
    case 16:
      return { op: 'edition', lang: pickOne(r, ['ta', 'kn', 'te'])!, patch: chance(r, 0.15) ? null : { register: 'formal' } };
    case 17:
      return { op: 'glossary_term', id: nm.id('g'), patch: { term: 'Later term', forms: { hi: 'L' } } };
    case 18:
      return ch ? { op: 'ref_add', owner: { kind: 'character', id: ch.id }, ref: { ...asset(nm, 'ref'), source: 'upload' } } : null;
    case 19: {
      const ref = ch && pickOne(r, ch.refs);
      return ch && ref ? { op: 'ref_remove', owner: { kind: 'character', id: ch.id }, path: ref.path } : null;
    }
    case 20: {
      const all: string[] = [];
      for (const p of doc.pages) if (p.render.asset) all.push(p.render.asset.path);
      const path = pickOne(r, all);
      return path ? { op: 'asset_meta', path, patch: { safety: { assessed: 'G', at: nm.at() }, variants: [{ path: nm.path('w480'), w: 480, h: 720 }] } } : null;
    }
    case 21:
      if (allowBusy && page && chance(r, 0.5)) return { op: 'render', target: { kind: 'page', id: page.id }, patch: { status: 'rendering', updatedAt: nm.at() } };
      return { op: 'style', patch: { spec: `Style changed ${nm.id('st')}`, ...(chance(r, 0.5) ? { board: asset(nm, 'board') } : {}) } };
    default:
      return null;
  }
};

/** `doc` after `steps` random real edits (each through applyOp, like the session commits them). */
export const evolveBook = (doc: ComicDoc, seed: number, steps: number, opts: { allowBusy?: boolean } = {}): ComicDoc => {
  const r = rngOf(seed);
  const nm = namerOf(`e${seed}`);
  let cur = doc;
  for (let i = 0; i < steps; i += 1) {
    const op = randomOp(cur, r, nm, !!opts.allowBusy);
    if (op) cur = applyOp(cur, op);
  }
  return normalizeDoc(cur);
};

/** A random restore scope over the two books (targets may be missing on either side: the applier no-ops). */
export const randomScope = (version: ComicDoc, current: ComicDoc, seed: number): RestoreScope => {
  const r = rngOf(seed);
  const page = pickOne(r, [...version.pages, ...current.pages]);
  const panel = page && pickOne(r, page.panels);
  const ln = panel && pickOne(r, panel.lines);
  const ch = pickOne(r, [...version.cast, ...current.cast]);
  const pl = pickOne(r, [...version.places, ...current.places]);
  const part = pickOne(r, ['all', 'text', 'art'] as const)!;
  switch (int(r, 0, 10)) {
    case 0:
      return { kind: 'book' };
    case 1:
      return page ? { kind: 'page', pageId: page.id, mode: chance(r, 0.8) ? 'replace' : 'insert', part } : { kind: 'book' };
    case 2:
      return page && panel ? { kind: 'panel', pageId: page.id, panelId: panel.id } : { kind: 'script' };
    case 3:
      return page && ln ? { kind: 'line', pageId: page.id, lineId: ln.id } : { kind: 'style' };
    case 4:
      return ch ? { kind: 'character', id: ch.id } : { kind: 'book' };
    case 5:
      return pl ? { kind: 'place', id: pl.id } : { kind: 'cover', part };
    case 6:
      return { kind: 'cover', part };
    case 7:
      return { kind: 'script' };
    case 8:
      return { kind: 'style' };
    case 9:
      return { kind: 'language', lang: pickOne(r, ['te', 'hi', 'ta'])! };
    default: {
      const keys = [...new Set([...Object.keys(sectionSignatures(version)), ...Object.keys(sectionSignatures(current))])];
      return { kind: 'keys', keys: keys.filter(() => chance(r, 0.3)) };
    }
  }
};
