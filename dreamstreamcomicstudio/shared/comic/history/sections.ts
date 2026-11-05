// Comic History — book sections (versions plan §3.1; package H0). Pure, dependency-free.
//
// A version is the doc split into small, content-addressable sections ("chunks"). The doc itself is never
// modified: splitSections reads it, joinSections reassembles it through today's normalizeDoc, so an old
// version always loads under new schemas (R1–R3).
//
// Future-proof BY EXCLUSION, not by allow-list (owner direction D-OWN-4):
//   - `page:<id>` is the page MINUS {n, render, balloons}, and `art:<id>` is {render, balloons}, so new page
//     and panel fields (frames, layers, continuity…) are captured automatically;
//   - `meta` holds every top-level ComicDoc key that is neither assigned to another section nor excluded;
//   - TOP_LEVEL_SECTIONS is typed Record<keyof ComicDoc, …>: a new ComicDoc key that is not listed there fails
//     the typecheck, and the contract test fails on a doc carrying an unlisted key (unassignedKeys).
//
// Volatile render fields never enter a section: a busy or failed status becomes 'ready' (asset) / 'none', and
// attempts, error, errorDetail and updatedAt are dropped (the interruptedRenderOps rule), so a stuck render or
// a retry counter never makes a "changed" section.

import {
  normalizeDoc,
  type ArchivedVersion,
  type Balloon,
  type BalloonGeometryOverride,
  type Character,
  type ComicDoc,
  type Cover,
  type GlossaryTerm,
  type LanguageEdition,
  type Page,
  type Place,
  type RenderState,
  type Source,
  type StyleBible,
  type StyleOption,
  type TextTranslation,
  type TrashedPage
} from '../doc.js';
import { stableStringify } from '../hash.js';
import { HISTORY_MANIFEST_VERSION, type Manifest } from './types.js';

// ── Assignment of every top-level key ────────────────────────────────────────

export type TopLevelSection =
  | 'meta'
  | 'source'
  | 'style'
  | 'cast'
  | 'places'
  | 'pages'
  | 'cover'
  | 'i18n'
  | 'archive'
  | 'trash'
  | 'excluded';

/**
 * Where every top-level ComicDoc key goes. Excluded keys are forward-only records (spend, conversation,
 * memory, settings, safety, publication, the image-model lock, the composer inbox) or identity/bookkeeping —
 * a restore never rewinds them. Adding a ComicDoc key without listing it here fails the typecheck.
 * (Ship 2 / K2a: `scenes` and `consistency` go to 'meta'. Nothing else is needed for them: every 'meta' key beyond
 * TYPED_META_KEYS is captured, compared (diffBooks) and restored (RestoreSet.metaExtra) generically.)
 */
export const TOP_LEVEL_SECTIONS: Readonly<Record<keyof ComicDoc, TopLevelSection>> = {
  v: 'excluded',
  id: 'excluded',
  createdAt: 'excluded',
  updatedAt: 'excluded',
  rev: 'excluded',
  brief: 'meta',
  format: 'meta',
  planStatus: 'meta',
  letterStyle: 'meta',
  book: 'meta',
  reader: 'meta',
  planInputHash: 'meta',
  source: 'source',
  style: 'style',
  cast: 'cast',
  places: 'places',
  pages: 'pages',
  cover: 'cover',
  i18n: 'i18n',
  archive: 'archive',
  trash: 'trash',
  settings: 'excluded',
  spend: 'excluded',
  gate: 'excluded',
  conversation: 'excluded',
  memory: 'excluded',
  refInbox: 'excluded',
  safety: 'excluded',
  publication: 'excluded',
  imageModel: 'excluded',
  // --- Ship 2 (K2a; pro plan §5.6): the book section. Extra meta keys (not TYPED_META_KEYS): captured, compared and
  //     restored generically through RestoreSet.metaExtra. They hold no image paths. ---
  scenes: 'meta',
  consistency: 'meta'
};

/** Top-level keys a version never holds (and a restore never touches). */
export const EXCLUDED_TOP_LEVEL_KEYS: readonly (keyof ComicDoc)[] = (Object.keys(TOP_LEVEL_SECTIONS) as (keyof ComicDoc)[]).filter(
  (k) => TOP_LEVEL_SECTIONS[k] === 'excluded'
);

const ASSIGNED = new Set<string>(Object.keys(TOP_LEVEL_SECTIONS));
/** The section of a top-level key (own entries only: 'toString' or 'constructor' are not listed keys). */
const sectionOf = (key: string): TopLevelSection | undefined =>
  ASSIGNED.has(key) ? (TOP_LEVEL_SECTIONS as Record<string, TopLevelSection>)[key] : undefined;

/** Top-level keys of `doc` that TOP_LEVEL_SECTIONS does not list (they still ride in `meta`, so nothing is lost). */
export const unassignedKeys = (doc: object): string[] => Object.keys(doc).filter((k) => !ASSIGNED.has(k));

/** The meta keys a RestoreSet carries as typed fields (history/restore.ts metaFields, history/apply.ts). */
export const TYPED_META_KEYS: readonly (keyof ComicDoc)[] = ['brief', 'format', 'planStatus', 'letterStyle', 'book', 'reader', 'planInputHash'];
const TYPED_META = new Set<string>(TYPED_META_KEYS);
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * A key of the meta section with no typed RestoreSet field: a TOP_LEVEL_SECTIONS 'meta' key beyond the typed ones
 * (K2a: `scenes`, `consistency`) or a key TOP_LEVEL_SECTIONS does not list. These travel in RestoreSet.metaExtra,
 * so whatever the meta section captures, a restore brings back. Never an excluded or other-section key.
 */
export const isExtraMetaKey = (key: string): boolean => {
  if (typeof key !== 'string' || !key || UNSAFE_KEYS.has(key) || TYPED_META.has(key)) return false;
  const section = sectionOf(key);
  return section === 'meta' || section === undefined;
};

/** The extra meta keys `doc` has a value for (see isExtraMetaKey). */
export const extraMetaKeys = (doc: object): string[] =>
  Object.keys(doc).filter((k) => isExtraMetaKey(k) && (doc as Record<string, unknown>)[k] !== undefined);

// ── Section keys ─────────────────────────────────────────────────────────────

/** Archived versions per `archive:<n>` block, counted from the OLDEST end (a new eviction touches one block). */
export const ARCHIVE_BLOCK = 32;

export const SECTION_KEYS = {
  meta: 'meta',
  source: 'source',
  style: 'style',
  cover: 'cover',
  places: 'places',
  glossary: 'glossary',
  option: (id: string) => `option:${id}`,
  char: (id: string) => `char:${id}`,
  page: (id: string) => `page:${id}`,
  art: (id: string) => `art:${id}`,
  edition: (lang: string) => `ed:${lang}`,
  editionPage: (lang: string, pageId: string) => `edp:${lang}:${pageId}`,
  archive: (n: number) => `archive:${n}`,
  trash: (pageId: string) => `trash:${pageId}`
} as const;

export type SectionKind = 'meta' | 'source' | 'style' | 'option' | 'cover' | 'char' | 'places' | 'page' | 'art' | 'ed' | 'edp' | 'glossary' | 'archive' | 'trash';

export type ParsedSectionKey =
  | { kind: 'meta' | 'source' | 'style' | 'cover' | 'places' | 'glossary' }
  | { kind: 'option' | 'char' | 'page' | 'art'; id: string }
  | { kind: 'ed'; lang: string }
  | { kind: 'edp'; lang: string; pageId: string }
  | { kind: 'archive'; n: number }
  | { kind: 'trash'; pageId: string };

/** Inverse of SECTION_KEYS (null for anything else). */
export const parseSectionKey = (key: string): ParsedSectionKey | null => {
  if (typeof key !== 'string' || !key) return null;
  if (key === 'meta' || key === 'source' || key === 'style' || key === 'cover' || key === 'places' || key === 'glossary') return { kind: key };
  const i = key.indexOf(':');
  if (i <= 0) return null;
  const head = key.slice(0, i);
  const rest = key.slice(i + 1);
  if (!rest) return null;
  switch (head) {
    case 'option':
    case 'char':
    case 'page':
    case 'art':
      return { kind: head, id: rest };
    case 'ed':
      return { kind: 'ed', lang: rest };
    case 'edp': {
      const j = rest.indexOf(':');
      return j > 0 && j < rest.length - 1 ? { kind: 'edp', lang: rest.slice(0, j), pageId: rest.slice(j + 1) } : null;
    }
    case 'archive': {
      const n = Number(rest);
      return Number.isInteger(n) && n >= 0 ? { kind: 'archive', n } : null;
    }
    case 'trash':
      return { kind: 'trash', pageId: rest };
    default:
      return null;
  }
};

/** The kind of a section key ('page', 'edp'…), or null. */
export const sectionKindOf = (key: string): SectionKind | null => parseSectionKey(key)?.kind ?? null;

// ── Volatile fields ──────────────────────────────────────────────────────────

const VOLATILE_RENDER_KEYS = ['attempts', 'error', 'errorDetail', 'updatedAt'] as const;
const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A render as a version stores it: no busy/failed status, no attempts/error/errorDetail/updatedAt. Same object when already stable. */
export const stableRender = (render: RenderState): RenderState => {
  if (!isPlainObject(render)) return render;
  const busy = render.status === 'queued' || render.status === 'rendering' || render.status === 'failed';
  const volatile = VOLATILE_RENDER_KEYS.some((k) => k in render);
  if (!busy && !volatile) return render;
  const out = { ...render } as RenderState;
  for (const k of VOLATILE_RENDER_KEYS) delete (out as unknown as Record<string, unknown>)[k];
  if (busy) out.status = render.asset?.path ? 'ready' : 'none';
  return out;
};

const stableCharacter = (c: Character): Character => {
  const sheet = stableRender(c.sheet);
  return sheet === c.sheet ? c : { ...c, sheet };
};
const stablePlace = (p: Place): Place => {
  const sheet = stableRender(p.sheet);
  return sheet === p.sheet ? p : { ...p, sheet };
};
const stableOption = (o: StyleOption): StyleOption => {
  const render = stableRender(o.render);
  return render === o.render ? o : { ...o, render };
};
const stablePage = (p: Page): Page => {
  const render = stableRender(p.render);
  return render === p.render ? p : { ...p, render };
};

/** The doc with every render stabilized (what a split → join round trip returns). Same object when nothing changed. */
export const stripVolatile = (doc: ComicDoc): ComicDoc => {
  const options = doc.style.options.map(stableOption);
  const cast = doc.cast.map(stableCharacter);
  const places = doc.places.map(stablePlace);
  const pages = doc.pages.map(stablePage);
  const coverRender = stableRender(doc.cover.render);
  const trash = doc.trash?.map((t) => {
    const page = stablePage(t.page);
    return page === t.page ? t : { ...t, page };
  });
  const same = <T>(a: T[], b: T[]) => a.every((x, i) => x === b[i]);
  if (
    same(options, doc.style.options) &&
    same(cast, doc.cast) &&
    same(places, doc.places) &&
    same(pages, doc.pages) &&
    coverRender === doc.cover.render &&
    (!trash || same(trash, doc.trash!))
  ) {
    return doc;
  }
  const out: ComicDoc = {
    ...doc,
    style: { ...doc.style, options },
    cast,
    places,
    pages,
    cover: coverRender === doc.cover.render ? doc.cover : { ...doc.cover, render: coverRender }
  };
  if (trash) out.trash = trash;
  return out;
};

// ── Bodies ───────────────────────────────────────────────────────────────────

/** `page:<id>`: the page minus {n, render, balloons} (so new page/panel fields are captured by exclusion). */
export type PageTextBody = Omit<Page, 'n' | 'render' | 'balloons'>;
/** `art:<id>`: the drawing and its lettering geometry. */
export interface PageArtBody {
  render: RenderState;
  balloons: Balloon[];
}
/** `ed:<lang>`: the edition minus its per-page lines/balloons (orphan lines — not on any page — stay here). */
export type EditionMetaBody = Omit<LanguageEdition, 'lines' | 'balloons'> & {
  lines: Record<string, TextTranslation>;
  balloons: Record<string, BalloonGeometryOverride>;
};
/** `edp:<lang>:<pageId>`: that page's line translations and balloon overrides in that language. */
export interface EditionPageBody {
  lines: Record<string, TextTranslation>;
  balloons: Record<string, BalloonGeometryOverride>;
}

/** A book split into its sections (pure data; the doc is never modified). */
export interface BookSections {
  /** Every top-level key assigned to 'meta' plus every unknown key. */
  meta: Record<string, unknown>;
  source: Source;
  style: Omit<StyleBible, 'options'>;
  options: { id: string; body: StyleOption }[];
  cover: Cover;
  cast: { id: string; body: Character }[];
  places: Place[];
  /** In page order. */
  pages: { id: string; text: PageTextBody; art: PageArtBody }[];
  editions: { lang: string; meta: EditionMetaBody; pages: { pageId: string; body: EditionPageBody }[] }[];
  glossary: GlossaryTerm[];
  /** Blocks of ARCHIVE_BLOCK, oldest first. */
  archive: ArchivedVersion[][];
  trash: { pageId: string; body: TrashedPage }[];
}

const pageText = (page: Page): PageTextBody => {
  const { n: _n, render: _r, balloons: _b, ...text } = page;
  return text;
};

const editionSplit = (edition: LanguageEdition, pageLines: Map<string, string[]>): BookSections['editions'][number] => {
  const lines = edition.lines || {};
  const balloons = edition.balloons || {};
  const placed = new Set<string>();
  const pages: { pageId: string; body: EditionPageBody }[] = [];
  for (const [pageId, ids] of pageLines) {
    const body: EditionPageBody = { lines: {}, balloons: {} };
    let any = false;
    for (const id of ids) {
      if (Object.prototype.hasOwnProperty.call(lines, id)) {
        body.lines[id] = lines[id];
        any = true;
      }
      if (Object.prototype.hasOwnProperty.call(balloons, id)) {
        body.balloons[id] = balloons[id];
        any = true;
      }
      placed.add(id);
    }
    if (any) pages.push({ pageId, body });
  }
  const orphanLines: Record<string, TextTranslation> = {};
  for (const [id, t] of Object.entries(lines)) if (!placed.has(id)) orphanLines[id] = t;
  const orphanBalloons: Record<string, BalloonGeometryOverride> = {};
  for (const [id, b] of Object.entries(balloons)) if (!placed.has(id)) orphanBalloons[id] = b;
  const { lines: _l, balloons: _b, ...rest } = edition;
  return { lang: edition.lang, meta: { ...rest, lines: orphanLines, balloons: orphanBalloons }, pages };
};

/**
 * The doc as book sections (§3.1). Pure; structural sharing: unchanged pages give the same body objects
 * (H1's WeakMap hash cache keys on them). Excluded keys are left out entirely.
 */
export const splitSections = (doc: ComicDoc): BookSections => {
  const meta: Record<string, unknown> = {};
  for (const key of Object.keys(doc)) {
    const section = sectionOf(key);
    if (section === 'meta' || section === undefined) {
      const value = (doc as unknown as Record<string, unknown>)[key];
      if (value !== undefined) meta[key] = value;
    }
  }
  const { options: _options, ...style } = doc.style;
  const pageLines = new Map<string, string[]>();
  for (const p of doc.pages) pageLines.set(p.id, p.panels.flatMap((panel) => panel.lines.map((l) => l.id)));
  const i18n = doc.i18n;
  const editions = i18n ? Object.keys(i18n.editions).sort().map((lang) => editionSplit(i18n.editions[lang], pageLines)) : [];
  const archiveOldestFirst = [...(doc.archive || [])].reverse();
  const archive: ArchivedVersion[][] = [];
  for (let i = 0; i < archiveOldestFirst.length; i += ARCHIVE_BLOCK) archive.push(archiveOldestFirst.slice(i, i + ARCHIVE_BLOCK));
  return {
    meta,
    source: doc.source,
    style,
    options: doc.style.options.map((o) => ({ id: o.id, body: stableOption(o) })),
    cover: (() => {
      const render = stableRender(doc.cover.render);
      return render === doc.cover.render ? doc.cover : { ...doc.cover, render };
    })(),
    cast: doc.cast.map((c) => ({ id: c.id, body: stableCharacter(c) })),
    places: doc.places.map(stablePlace),
    pages: doc.pages.map((p) => ({ id: p.id, text: pageText(p), art: { render: stableRender(p.render), balloons: p.balloons } })),
    editions,
    glossary: i18n?.glossary || [],
    archive,
    trash: (doc.trash || []).map((t) => ({ pageId: t.page.id, body: { ...t, page: stablePage(t.page) } }))
  };
};

/** The excluded part of a doc (identity, forward-only records): the frame joinSections puts a version into. */
export const excludedOf = (doc: ComicDoc): Partial<ComicDoc> & { id: string } => {
  const out: Record<string, unknown> = {};
  for (const key of EXCLUDED_TOP_LEVEL_KEYS) {
    const value = (doc as unknown as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = value;
  }
  return out as Partial<ComicDoc> & { id: string };
};

/** A deterministic frame for a version read on its own (no live doc): identity fields only. */
export const versionFrame = (id: string, at: number): Partial<ComicDoc> & { id: string } => ({ id, createdAt: at, updatedAt: at, rev: 0 });

/**
 * Reassemble a doc from its sections inside `frame` (the excluded keys: identity, conversation, spend…), then
 * normalizeDoc. joinSections(splitSections(doc), excludedOf(doc)) equals stripVolatile(normalizeDoc(doc)).
 */
export const joinSections = (sections: BookSections, frame: Partial<ComicDoc> & { id: string }): ComicDoc => {
  const editions: Record<string, LanguageEdition> = {};
  for (const e of sections.editions) {
    const lines: Record<string, TextTranslation> = { ...(e.meta.lines || {}) };
    const balloons: Record<string, BalloonGeometryOverride> = { ...(e.meta.balloons || {}) };
    for (const p of e.pages) {
      Object.assign(lines, p.body.lines || {});
      Object.assign(balloons, p.body.balloons || {});
    }
    editions[e.lang] = { ...e.meta, lang: e.lang, lines, balloons } as LanguageEdition;
  }
  const raw: Record<string, unknown> = {
    ...sections.meta,
    ...frame,
    source: sections.source,
    style: { ...sections.style, options: sections.options.map((o) => o.body) },
    cover: sections.cover,
    cast: sections.cast.map((c) => c.body),
    places: sections.places,
    pages: sections.pages.map((p, i) => ({ ...p.text, n: i + 1, render: p.art.render, balloons: p.art.balloons })),
    i18n: { editions, glossary: sections.glossary },
    archive: sections.archive.flat().reverse(),
    trash: sections.trash.map((t) => t.body)
  };
  return normalizeDoc(raw as Partial<ComicDoc> & { id: string });
};

// ── Chunks and manifests ─────────────────────────────────────────────────────

export interface SectionChunk {
  key: string;
  kind: SectionKind;
  body: unknown;
}

/** Every section as a (key, kind, body) chunk, in a stable order. */
export const sectionChunks = (s: BookSections): SectionChunk[] => {
  const out: SectionChunk[] = [
    { key: SECTION_KEYS.meta, kind: 'meta', body: s.meta },
    { key: SECTION_KEYS.source, kind: 'source', body: s.source },
    { key: SECTION_KEYS.style, kind: 'style', body: s.style }
  ];
  for (const o of s.options) out.push({ key: SECTION_KEYS.option(o.id), kind: 'option', body: o.body });
  out.push({ key: SECTION_KEYS.cover, kind: 'cover', body: s.cover });
  for (const c of s.cast) out.push({ key: SECTION_KEYS.char(c.id), kind: 'char', body: c.body });
  out.push({ key: SECTION_KEYS.places, kind: 'places', body: s.places });
  for (const p of s.pages) {
    out.push({ key: SECTION_KEYS.page(p.id), kind: 'page', body: p.text });
    out.push({ key: SECTION_KEYS.art(p.id), kind: 'art', body: p.art });
  }
  for (const e of s.editions) {
    out.push({ key: SECTION_KEYS.edition(e.lang), kind: 'ed', body: e.meta });
    for (const p of e.pages) out.push({ key: SECTION_KEYS.editionPage(e.lang, p.pageId), kind: 'edp', body: p.body });
  }
  out.push({ key: SECTION_KEYS.glossary, kind: 'glossary', body: s.glossary });
  s.archive.forEach((block, n) => out.push({ key: SECTION_KEYS.archive(n), kind: 'archive', body: block }));
  for (const t of s.trash) out.push({ key: SECTION_KEYS.trash(t.pageId), kind: 'trash', body: t.body });
  return out;
};

/** The canonical serialisation of a section body (sorted keys, undefined dropped) — what H1 stores and hashes. */
export const sectionContent = (body: unknown): string => stableStringify(body);

/**
 * key → signature of every section: the canonical content itself (exact, no hash collisions). For in-memory
 * comparisons (tests, client-side "what changed"); the stored manifest uses H1's sha256 of the same content.
 */
export const sectionSignatures = (doc: ComicDoc): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const c of sectionChunks(splitSections(doc))) out[c.key] = sectionContent(c.body);
  return out;
};

/** A manifest of the sections, hashing each chunk body with `hashOf` (H1 passes sha256 of sectionContent). */
export const buildManifest = (s: BookSections, hashOf: (chunk: SectionChunk) => string): Manifest => {
  const chunks = sectionChunks(s);
  const h = new Map(chunks.map((c) => [c.key, hashOf(c)]));
  const get = (key: string) => h.get(key) as string;
  const editions: Manifest['editions'] = {};
  for (const e of s.editions) {
    editions[e.lang] = { _: get(SECTION_KEYS.edition(e.lang)), pages: e.pages.map((p) => [p.pageId, get(SECTION_KEYS.editionPage(e.lang, p.pageId))]) };
  }
  return {
    v: HISTORY_MANIFEST_VERSION,
    meta: get(SECTION_KEYS.meta),
    source: get(SECTION_KEYS.source),
    style: get(SECTION_KEYS.style),
    cover: get(SECTION_KEYS.cover),
    places: get(SECTION_KEYS.places),
    glossary: get(SECTION_KEYS.glossary),
    options: s.options.map((o) => [o.id, get(SECTION_KEYS.option(o.id))]),
    cast: s.cast.map((c) => [c.id, get(SECTION_KEYS.char(c.id))]),
    pages: s.pages.map((p) => [p.id, get(SECTION_KEYS.page(p.id)), get(SECTION_KEYS.art(p.id))]),
    editions,
    archive: s.archive.map((_, n) => get(SECTION_KEYS.archive(n))),
    trash: s.trash.map((t) => [t.pageId, get(SECTION_KEYS.trash(t.pageId))])
  };
};

/** Flat key → hash of a manifest (what diffManifests and planUndoLastAi compare). */
export const manifestKeyHashes = (m: Manifest): Record<string, string> => {
  const out: Record<string, string> = {
    [SECTION_KEYS.meta]: m.meta,
    [SECTION_KEYS.source]: m.source,
    [SECTION_KEYS.style]: m.style,
    [SECTION_KEYS.cover]: m.cover,
    [SECTION_KEYS.places]: m.places,
    [SECTION_KEYS.glossary]: m.glossary
  };
  for (const [id, h] of m.options || []) out[SECTION_KEYS.option(id)] = h;
  for (const [id, h] of m.cast || []) out[SECTION_KEYS.char(id)] = h;
  for (const [id, text, art] of m.pages || []) {
    out[SECTION_KEYS.page(id)] = text;
    out[SECTION_KEYS.art(id)] = art;
  }
  for (const [lang, e] of Object.entries(m.editions || {})) {
    out[SECTION_KEYS.edition(lang)] = e._;
    for (const [pageId, h] of e.pages || []) out[SECTION_KEYS.editionPage(lang, pageId)] = h;
  }
  (m.archive || []).forEach((h, n) => (out[SECTION_KEYS.archive(n)] = h));
  for (const [pageId, h] of m.trash || []) out[SECTION_KEYS.trash(pageId)] = h;
  return out;
};

/**
 * Sections from a manifest and a chunk reader (`bodyOf(hash)` returns the parsed, verified body). null when any
 * chunk is missing — the caller says "This version can't be opened. Nothing in your comic changed."
 */
export const sectionsFromManifest = (m: Manifest, bodyOf: (hash: string) => unknown): BookSections | null => {
  if (!isPlainObject(m) || m.v !== HISTORY_MANIFEST_VERSION) return null;
  let missing = false;
  const read = <T>(hash: string): T => {
    const body = typeof hash === 'string' ? bodyOf(hash) : undefined;
    if (body === undefined) missing = true;
    return body as T;
  };
  const sections: BookSections = {
    meta: read<Record<string, unknown>>(m.meta) || {},
    source: read<Source>(m.source),
    style: read<Omit<StyleBible, 'options'>>(m.style),
    options: (m.options || []).map(([id, h]) => ({ id, body: read<StyleOption>(h) })),
    cover: read<Cover>(m.cover),
    cast: (m.cast || []).map(([id, h]) => ({ id, body: read<Character>(h) })),
    places: read<Place[]>(m.places),
    pages: (m.pages || []).map(([id, text, art]) => ({ id, text: read<PageTextBody>(text), art: read<PageArtBody>(art) })),
    editions: Object.entries(m.editions || {}).map(([lang, e]) => ({
      lang,
      meta: read<EditionMetaBody>(e._),
      pages: (e.pages || []).map(([pageId, h]) => ({ pageId, body: read<EditionPageBody>(h) }))
    })),
    glossary: read<GlossaryTerm[]>(m.glossary),
    archive: (m.archive || []).map((h) => read<ArchivedVersion[]>(h)),
    trash: (m.trash || []).map(([pageId, h]) => ({ pageId, body: read<TrashedPage>(h) }))
  };
  return missing ? null : sections;
};
