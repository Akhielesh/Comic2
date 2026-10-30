// Comic History — the pure `history_restore` applier (versions plan §6.2; package H0).
//
// Called by ops.ts applyOp for the server-only `history_restore` op, so server and client apply it with the SAME
// pure function (R5: time comes in on the op; R6: anything malformed is a no-op, never a throw).
//
// MERGE mode (every restore and "Use then"), invariants property-tested in apply.test.ts:
//   I1 no lost image — a displaced current asset goes to its target's render.history (the render_use swap rule)
//      with overflow to the archive; a removed page goes to the trash; any other path that would be left
//      unreferenced is archived where it lived — a frame source or an image overlay under its page ('page:<id>').
//      (Archive cap eviction stays the existing, never-silent §5.3.1 rule.)
//   I2 no lost translation — editions merge by line id: the version wins for its own lines, other lines are kept;
//      editions and glossary terms are a union. Stale/current/missing re-derive from sourceHash for free.
//   I3 forward-only state untouched — spend, conversation, memory, settings, safety, publication, imageModel and
//      refInbox are never read or written; `gate` becomes null (a pending quote is about the old state). Image
//      metadata is forward-only too: a restored image keeps the live doc's newest safety verdict and variants.
//   I4 busy targets — a queued/rendering target keeps its current state (the server refuses before commit).
//   I5 normalized — normalizeDoc(after) deep-equals after; untouched pages keep their pageSpecHash.
//   I6 later additions kept — characters, places and options created after the version stay; pages created after
//      it go to Deleted; archive and trash are unions.
//   The source language (format.language) is never changed by a merge restore.
//
// EXACT mode (alternative switch only, after the old line's head row is written and pinned): the present sections
// are replaced as stored — no history push, no union. The trash belongs to the comic, not the line: it stays, and
// the target line's Deleted pages join it (a page live in the target is not also "deleted").

import {
  archiveOf,
  collectAssetPaths,
  mapAssetRefs,
  pickBook,
  pickReader,
  renderTargetKey,
  targetLabel,
  trashOf,
  type ArchivedVersion,
  type AssetRef,
  type Balloon,
  type Character,
  type ComicDoc,
  type Cover,
  type GlossaryTerm,
  type LanguageEdition,
  type Line,
  type Page,
  type Panel,
  type Place,
  type RefAsset,
  type RenderState,
  type RenderTarget,
  type RenderVersion,
  type StyleBible,
  type StyleOption,
  type TrashedPage,
  type VersionMeta
} from '../doc.js';
import { DOC_LIMITS, MAX_BALLOON_SNAPSHOT, MAX_RENDER_HISTORY, MAX_TRASH } from '../limits.js';
import { i18nOf, normalizeBalloonOverride, normalizeGlossaryTerm, normalizeTextTranslation } from '../i18n.js';
import { languageSpec, sameLanguage } from '../languages.js';
import { extraMetaKeys, isExtraMetaKey, stableRender } from './sections.js';
import type { EditionMerge, HistoryRestoreOp, RestorePart, RestoreSet } from './types.js';

/**
 * What the archive calls a page's frame picture (frame.src) or image overlay (layer.src) when a restore displaces it
 * (K2a, I1): "Page 3 panel picture", "Deleted page 2 overlay". Such a picture is not a drawing of the page.
 */
export const PANEL_SOURCE_ARCHIVE_WORDS = { frame: 'panel picture', layer: 'overlay' } as const;

const PANEL_SOURCE_LABEL_RE = /^(?:Page|Deleted page)(?: \d+)? (?:panel picture|overlay)$/;

/**
 * An archive entry the I1 net made for a displaced frame picture or overlay: under a page ('page:<id>'), with no
 * maker or time recorded (no origin, at 0) and a label that says which. It is not an older drawing of the page, so
 * nothing should offer it as one ("Use for this page" / "Use this version" would print an overlay — even a guide-only
 * one — as the whole page's art).
 */
export const isPanelSourceArchive = (v: Pick<ArchivedVersion, 'targetKey' | 'label'> & { origin?: unknown; at?: unknown }): boolean =>
  !!v &&
  typeof v.targetKey === 'string' &&
  v.targetKey.startsWith('page:') &&
  v.origin === undefined &&
  !(typeof v.at === 'number' && v.at > 0) &&
  typeof v.label === 'string' &&
  PANEL_SOURCE_LABEL_RE.test(v.label);

/** The ops.ts archive primitives (passed in, so this module never imports ops.ts at runtime). */
export interface RestoreKernel {
  /** Prepend entries, then evict the oldest unstarred unreferenced ones past MAX_ARCHIVE (§5.3.1). */
  pushArchive(doc: ComicDoc, entries: ArchivedVersion[]): ComicDoc;
  /** While over MAX_ARCHIVE, evict the oldest unstarred entry nothing else references (soft cap, §5.3.1). */
  evictArchive(doc: ComicDoc): ComicDoc;
  /** The lean archive entry of a version (no qc/balloons). */
  toArchived(v: RenderVersion | AssetRef, targetKey: string, label: string, archivedAt: number): ArchivedVersion;
  /** Every defined VersionMeta key of a render / version. */
  metaOf(r: Partial<VersionMeta>): VersionMeta;
}

// ── Small helpers ────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isBusy = (r?: RenderState) => !!r && (r.status === 'queued' || r.status === 'rendering');
const clampIndex = (i: unknown, len: number): number =>
  typeof i === 'number' && Number.isFinite(i) ? Math.min(len, Math.max(0, Math.floor(i))) : len;
const asArr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const hasId = (v: unknown): v is { id: string } => isObj(v) && typeof v.id === 'string' && !!v.id;
const isPage = (v: unknown): v is Page => hasId(v) && Array.isArray((v as unknown as Page).panels) && isObj((v as unknown as Page).render);
const isRender = (v: unknown): v is RenderState => isObj(v) && Array.isArray(v.history);

/** Overflowed history versions waiting to be archived, with their target. */
interface Overflow {
  targetKey: string;
  label: string;
  versions: RenderVersion[];
}

interface Ctx {
  at: number;
  k: RestoreKernel;
  overflow: Overflow[];
}

const renderPaths = (r: RenderState | undefined): string[] =>
  r ? [r.asset?.path, ...r.history.map((v) => v.path)].filter((p): p is string => !!p) : [];

/**
 * The render_use swap rule for a restore: the version's asset becomes current (with its own meta), the current
 * asset (with its balloons) goes first into history, then the current history, then the version's history —
 * one path once, capped at MAX_RENDER_HISTORY; the rest is archived. A busy current render is kept as is (I4);
 * an identical current asset keeps the current render.
 */
const mergeRender = (cur: RenderState, ver: RenderState, ctx: Ctx, where: { key: string; label: string; balloons?: Balloon[] }): RenderState => {
  if (!isRender(ver)) return cur;
  if (isBusy(cur)) return cur;
  const v = stableRender(ver);
  if ((v.asset?.path || '') === (cur.asset?.path || '')) return cur;
  const outgoing: RenderVersion | undefined = cur.asset
    ? { ...cur.asset, ...ctx.k.metaOf(cur), ...(where.balloons ? { balloons: where.balloons.slice(0, MAX_BALLOON_SNAPSHOT) } : {}) }
    : undefined;
  const seen = new Set<string>(v.asset?.path ? [v.asset.path] : []);
  const history: RenderVersion[] = [];
  for (const h of [...(outgoing ? [outgoing] : []), ...cur.history, ...v.history]) {
    if (!h?.path || seen.has(h.path)) continue;
    seen.add(h.path);
    history.push(h);
  }
  if (history.length > MAX_RENDER_HISTORY) ctx.overflow.push({ targetKey: where.key, label: where.label, versions: history.slice(MAX_RENDER_HISTORY) });
  const out: RenderState = { ...v, status: v.asset?.path ? 'ready' : 'none', history: history.slice(0, MAX_RENDER_HISTORY) };
  if (!v.asset) delete out.asset;
  return out;
};

/** Version refs first (in its order), then current refs it did not have — a ref is never dropped by a restore. */
const unionRefs = (version: RefAsset[] | undefined, current: RefAsset[] | undefined): RefAsset[] => {
  const out: RefAsset[] = [];
  const seen = new Set<string>();
  for (const r of [...asArr<RefAsset>(version), ...asArr<RefAsset>(current)]) {
    if (!isObj(r) || typeof r.path !== 'string' || !r.path || seen.has(r.path)) continue;
    seen.add(r.path);
    out.push(r);
  }
  return out;
};

/** Balloons for restored ART (render_use semantics): the version's layout, except lines the user pinned; or the
 *  current layout when the version's references lines the page no longer has. */
const artBalloons = (page: Page, chosen: Balloon[] | undefined): Balloon[] => {
  if (!Array.isArray(chosen)) return page.balloons;
  const ids = new Set(page.panels.flatMap((p) => p.lines.map((l) => l.id)));
  if (!chosen.every((b) => isObj(b) && ids.has(b.lineId))) return page.balloons;
  const pinned = new Map(page.balloons.filter((b) => b.pinned || b.locked).map((b) => [b.lineId, b]));
  const out = chosen.map((b) => pinned.get(b.lineId) ?? b);
  for (const [lineId, b] of pinned) if (!chosen.some((c) => c.lineId === lineId)) out.push(b);
  return out;
};

/** Balloons for restored TEXT: current balloons of lines that remain, plus the version's for lines that had none. */
const textBalloons = (panels: Panel[], current: Balloon[], version: Balloon[]): Balloon[] => {
  const ids = new Set(panels.flatMap((p) => p.lines.map((l) => l.id)));
  const kept = current.filter((b) => ids.has(b.lineId));
  const have = new Set(kept.map((b) => b.lineId));
  return [...kept, ...asArr<Balloon>(version).filter((b) => isObj(b) && ids.has(b.lineId) && !have.has(b.lineId))];
};

const pageTextOf = (page: Page): Omit<Page, 'n' | 'render' | 'balloons'> => {
  const { n: _n, render: _r, balloons: _b, ...text } = page;
  return text;
};

/** `cur` takes `ver`'s text and/or art. */
const mergePage = (cur: Page, ver: Page, part: RestorePart, ctx: Ctx): Page => {
  const where = { key: renderTargetKey({ kind: 'page', id: cur.id }), label: `Page ${cur.n}`, balloons: cur.balloons };
  const withText = part !== 'art';
  const withArt = part !== 'text';
  const busy = isBusy(cur.render);
  if (withArt && busy && !withText) return cur;
  const panels = withText ? ver.panels : cur.panels;
  const render = withArt && !busy ? mergeRender(cur.render, ver.render, ctx, where) : cur.render;
  let balloons: Balloon[];
  if (withArt && !busy) balloons = withText ? asArr<Balloon>(ver.balloons) : artBalloons(cur, ver.balloons);
  else balloons = textBalloons(panels, cur.balloons, asArr<Balloon>(ver.balloons));
  const base = withText ? pageTextOf(ver) : pageTextOf(cur);
  return { ...base, id: cur.id, n: cur.n, panels, render, balloons } as Page;
};

/** A version page that does not exist now, as a live page (stable render). */
const freshPage = (ver: Page): Page => ({ ...ver, render: stableRender(ver.render), balloons: asArr<Balloon>(ver.balloons) });

const renumber = (doc: ComicDoc, pages: Page[]): ComicDoc => {
  const out = pages.map((p, i) => (p.n === i + 1 ? p : { ...p, n: i + 1 }));
  const format = out.length >= 1 && doc.format.pageCount !== out.length ? { ...doc.format, pageCount: out.length } : doc.format;
  return { ...doc, pages: out, format };
};

/** Move pages to the trash (newest first), capped at MAX_TRASH; trash overflow archives its renders (I1). */
const trashPages = (doc: ComicDoc, entries: TrashedPage[], ctx: Ctx): ComicDoc => {
  if (!entries.length) return doc;
  const all = [...entries, ...trashOf(doc)];
  const trash = all.slice(0, MAX_TRASH);
  for (const t of all.slice(MAX_TRASH)) {
    const key = renderTargetKey({ kind: 'page', id: t.page.id });
    const label = `Deleted page ${t.fromN}`;
    const versions: RenderVersion[] = [];
    if (t.page.render.asset) versions.push({ ...t.page.render.asset, ...ctx.k.metaOf(t.page.render) });
    versions.push(...t.page.render.history);
    if (versions.length) ctx.overflow.push({ targetKey: key, label, versions });
  }
  return { ...doc, trash };
};

// ── Sections ─────────────────────────────────────────────────────────────────

const mergeCharacter = (cur: Character, ver: Character, ctx: Ctx, doc: ComicDoc): Character => {
  const target: RenderTarget = { kind: 'sheet', id: cur.id };
  const sheet = mergeRender(cur.sheet, ver.sheet, ctx, { key: renderTargetKey(target), label: targetLabel(doc, target) });
  return { ...ver, id: cur.id, refs: unionRefs(ver.refs, cur.refs), sheet };
};

const mergePlace = (cur: Place, ver: Place, ctx: Ctx, doc: ComicDoc): Place => {
  const target: RenderTarget = { kind: 'place', id: cur.id };
  const sheet = mergeRender(cur.sheet, ver.sheet, ctx, { key: renderTargetKey(target), label: targetLabel(doc, target) });
  return { ...ver, id: cur.id, refs: unionRefs(ver.refs, cur.refs), sheet };
};

const mergeOption = (cur: StyleOption, ver: StyleOption, ctx: Ctx): StyleOption => {
  const render = mergeRender(cur.render, ver.render, ctx, { key: renderTargetKey({ kind: 'style_option', id: cur.id }), label: 'Style option' });
  return { ...ver, id: cur.id, render };
};

const freshCharacter = (c: Character): Character => ({ ...c, refs: asArr<RefAsset>(c.refs), sheet: stableRender(c.sheet) });
const freshPlace = (p: Place): Place => ({ ...p, refs: asArr<RefAsset>(p.refs), sheet: stableRender(p.sheet) });
const freshOption = (o: StyleOption): StyleOption => ({ ...o, render: stableRender(o.render) });

/**
 * Whole list (version order; entities created since are kept, appended in their current order — I6) or by id
 * (replace in place, or re-insert at its old index when removed since).
 */
function mergeEntities<T extends { id: string }>(
  current: T[],
  whole: T[] | undefined,
  byId: { item: T; index?: number }[] | undefined,
  merge: (cur: T, ver: T) => T,
  fresh: (ver: T) => T,
  cap: number
): T[] {
  let list = current;
  if (whole) {
    const curById = new Map(current.map((c) => [c.id, c]));
    const ids = new Set<string>();
    const out: T[] = [];
    for (const v of whole) {
      if (!hasId(v) || ids.has(v.id)) continue;
      ids.add(v.id);
      const cur = curById.get(v.id);
      out.push(cur ? merge(cur, v) : fresh(v));
    }
    for (const c of current) if (!ids.has(c.id)) out.push(c);
    list = out;
  }
  for (const { item, index } of byId || []) {
    if (!hasId(item)) continue;
    const at = list.findIndex((c) => c.id === item.id);
    if (at >= 0) {
      list = list.map((c, i) => (i === at ? merge(c, item) : c));
    } else if (list.length < cap) {
      const next = list.slice();
      next.splice(clampIndex(index, next.length), 0, fresh(item));
      list = next;
    }
  }
  return list;
}

const mergeStyle = (cur: StyleBible, ver: Omit<StyleBible, 'options'>): StyleBible => {
  const out = { ...(ver as StyleBible), options: cur.options, refs: unionRefs(ver.refs, cur.refs) };
  if (!ver.board) delete out.board;
  return out;
};

const mergeCover = (cur: Cover, ver: Cover, part: RestorePart, ctx: Ctx): Cover => {
  const where = { key: 'cover', label: 'Cover' };
  const TEXT_KEYS = ['title', 'tagline', 'direction', 'titleStyle'] as const;
  if (part === 'text') {
    const out = { ...cur } as Record<string, unknown>;
    for (const k of TEXT_KEYS) {
      if ((ver as unknown as Record<string, unknown>)[k] !== undefined) out[k] = (ver as unknown as Record<string, unknown>)[k];
      else delete out[k];
    }
    return out as unknown as Cover;
  }
  const render = isBusy(cur.render) ? cur.render : mergeRender(cur.render, ver.render, ctx, where);
  if (part === 'art') {
    const out = { ...cur, render };
    if (isBusy(cur.render)) return cur;
    if (ver.lettering !== undefined) out.lettering = ver.lettering;
    else delete out.lettering;
    return out;
  }
  return { ...ver, render };
};

const isRegistryLang = (lang: string): boolean => languageSpec(lang)?.code === lang;

const mergeEditions = (doc: ComicDoc, editions: Record<string, EditionMerge>, glossary: GlossaryTerm[] | undefined): ComicDoc => {
  const i18n = i18nOf(doc);
  let nextEditions = i18n.editions;
  if (isObj(editions)) {
    nextEditions = { ...i18n.editions };
    for (const [lang, m] of Object.entries(editions)) {
      if (!isObj(m) || !isRegistryLang(lang) || sameLanguage(lang, doc.format.language)) continue;
      const cur: LanguageEdition | undefined = nextEditions[lang];
      if (!cur && (!m.create || Object.keys(nextEditions).length >= DOC_LIMITS.editions)) continue;
      const base: LanguageEdition = cur ?? { lang, lines: {}, balloons: {}, register: 'everyday' };
      const lines = { ...base.lines };
      for (const [id, raw] of Object.entries(isObj(m.lines) ? m.lines : {})) {
        const t = normalizeTextTranslation(raw);
        if (t) lines[id] = t;
      }
      const balloons = { ...base.balloons };
      for (const [id, raw] of Object.entries(isObj(m.balloons) ? m.balloons : {})) {
        const b = normalizeBalloonOverride(raw);
        if (b) balloons[id] = b;
      }
      const next: LanguageEdition = { ...base, lang, lines, balloons };
      if (m.register === 'everyday' || m.register === 'formal' || m.register === 'code_mixed') next.register = m.register;
      for (const group of ['cover', 'brief'] as const) {
        const add = (m as Record<string, unknown>)[group];
        if (!isObj(add)) continue;
        const merged: Record<string, unknown> = { ...((base[group] as Record<string, unknown>) || {}) };
        for (const [key, raw] of Object.entries(add)) {
          const t = normalizeTextTranslation(raw);
          if (t) merged[key] = t;
        }
        if (Object.keys(merged).length) (next as unknown as Record<string, unknown>)[group] = merged;
      }
      nextEditions[lang] = next;
    }
  }
  let nextGlossary = i18n.glossary;
  if (Array.isArray(glossary)) {
    const out = i18n.glossary.slice();
    for (const raw of glossary) {
      const term = normalizeGlossaryTerm(raw);
      if (!term) continue;
      const at = out.findIndex((t) => t.id === term.id);
      if (at >= 0) out[at] = term;
      else if (out.length < DOC_LIMITS.glossaryTerms) out.push(term);
    }
    nextGlossary = out;
  }
  if (nextEditions === i18n.editions && nextGlossary === i18n.glossary) return doc;
  return { ...doc, i18n: { ...i18n, editions: nextEditions, glossary: nextGlossary } };
};

/** Put `line` into `panelId` on `page` (moving it out of any other panel of the page), at its version index. */
const placeLine = (page: Page, panelId: string, line: Line, index: number | undefined): Page | null => {
  if (!page.panels.some((p) => p.id === panelId)) return null;
  const panels = page.panels.map((p) => {
    const at = p.lines.findIndex((l) => l.id === line.id);
    if (p.id !== panelId) return at >= 0 ? { ...p, lines: p.lines.filter((l) => l.id !== line.id) } : p;
    const lines = p.lines.slice();
    if (at >= 0) lines[at] = line;
    else lines.splice(clampIndex(index, lines.length), 0, line);
    return { ...p, lines };
  });
  return { ...page, panels };
};

const withBalloons = (balloons: Balloon[], updates: Balloon[], drop: Set<string>): Balloon[] => {
  const byLine = new Map(updates.filter((b) => isObj(b) && typeof b.lineId === 'string').map((b) => [b.lineId, b]));
  const out = balloons.filter((b) => !drop.has(b.lineId)).map((b) => byLine.get(b.lineId) ?? b);
  for (const [lineId, b] of byLine) if (!out.some((x) => x.lineId === lineId)) out.push(b);
  return out;
};

/**
 * The meta section's extra keys (K2a's scenes/consistency, keys TOP_LEVEL_SECTIONS does not list): each listed key
 * takes the version's value, null (or undefined, which the wire turns into null) removes it. `replace` (exact
 * mode) also removes every current extra key the set does not list. Any other key is ignored (never an excluded,
 * forward-only or other-section key).
 */
const withMetaExtra = (doc: ComicDoc, extra: Record<string, unknown>, replace: boolean): ComicDoc => {
  const entries = Object.entries(extra).filter(([k]) => isExtraMetaKey(k));
  const drop = replace ? extraMetaKeys(doc).filter((k) => !Object.prototype.hasOwnProperty.call(extra, k)) : [];
  if (!entries.length && !drop.length) return doc;
  const out = { ...doc } as unknown as Record<string, unknown>;
  for (const k of drop) delete out[k];
  for (const [k, v] of entries) {
    if (v === null || v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as unknown as ComicDoc;
};

// ── Merge ────────────────────────────────────────────────────────────────────

const applyMerge = (before: ComicDoc, set: RestoreSet, ctx: Ctx): ComicDoc => {
  let doc = before;
  if (isObj(set.brief)) doc = { ...doc, brief: { ...(set.brief as ComicDoc['brief']), notes: asArr<string>(set.brief.notes) } };
  if (isObj(set.format)) doc = { ...doc, format: { ...(set.format as ComicDoc['format']), language: before.format.language } };
  if (isObj(set.source)) doc = { ...doc, source: { ...set.source } };
  if (set.planStatus === 'none' || set.planStatus === 'draft' || set.planStatus === 'approved') doc = { ...doc, planStatus: set.planStatus };
  if (isObj(set.letterStyle) && typeof set.letterStyle.presetId === 'string') doc = { ...doc, letterStyle: set.letterStyle };
  if (isObj(set.book)) doc = { ...doc, book: pickBook(set.book) };
  if (isObj(set.reader)) doc = { ...doc, reader: pickReader(set.reader) };
  if (set.planInputHash === null) {
    if (doc.planInputHash !== undefined) {
      doc = { ...doc };
      delete doc.planInputHash;
    }
  } else if (typeof set.planInputHash === 'string' && set.planInputHash) doc = { ...doc, planInputHash: set.planInputHash };
  if (isObj(set.metaExtra)) doc = withMetaExtra(doc, set.metaExtra, false);

  // Style bible (options are their own sections).
  if (isObj(set.style)) doc = { ...doc, style: mergeStyle(doc.style, set.style as Omit<StyleBible, 'options'>) };
  if (Array.isArray(set.options) || Array.isArray(set.optionsById)) {
    const options = mergeEntities(
      doc.style.options,
      Array.isArray(set.options) ? set.options : undefined,
      asArr<{ option: StyleOption; index?: number }>(set.optionsById).map((x) => ({ item: x?.option, index: x?.index })),
      (c, v) => mergeOption(c, v, ctx),
      freshOption,
      Number.MAX_SAFE_INTEGER
    );
    doc = { ...doc, style: { ...doc.style, options } };
  }
  if (Array.isArray(set.cast) || Array.isArray(set.castById)) {
    const at = doc;
    const cast = mergeEntities(
      doc.cast,
      Array.isArray(set.cast) ? set.cast : undefined,
      asArr<{ character: Character; index?: number }>(set.castById).map((x) => ({ item: x?.character, index: x?.index })),
      (c, v) => mergeCharacter(c, v, ctx, at),
      freshCharacter,
      DOC_LIMITS.cast
    );
    doc = { ...doc, cast };
  }
  if (Array.isArray(set.places) || Array.isArray(set.placesById)) {
    const at = doc;
    const places = mergeEntities(
      doc.places,
      Array.isArray(set.places) ? set.places : undefined,
      asArr<{ place: Place; index?: number }>(set.placesById).map((x) => ({ item: x?.place, index: x?.index })),
      (c, v) => mergePlace(c, v, ctx, at),
      freshPlace,
      DOC_LIMITS.places
    );
    doc = { ...doc, places };
  }
  if (isObj(set.cover) && isRender((set.cover as Cover).render)) {
    const part: RestorePart = set.coverPart === 'text' || set.coverPart === 'art' ? set.coverPart : 'all';
    doc = { ...doc, cover: mergeCover(doc.cover, set.cover as Cover, part, ctx) };
  }

  // Pages: whole book, then by id, removals, panels, lines.
  const trashAdds: TrashedPage[] = [];
  const takeFromTrash = (id: string): TrashedPage | undefined => {
    const t = trashOf(doc).find((x) => x.page.id === id);
    if (t) doc = { ...doc, trash: trashOf(doc).filter((x) => x !== t) };
    return t;
  };
  if (Array.isArray(set.pages)) {
    const curById = new Map(doc.pages.map((p) => [p.id, p]));
    const ids = new Set<string>();
    const out: Page[] = [];
    for (const v of set.pages) {
      if (!isPage(v) || ids.has(v.id)) continue;
      ids.add(v.id);
      const cur = curById.get(v.id);
      if (cur) {
        out.push(isBusy(cur.render) ? cur : mergePage(cur, v, 'all', ctx));
        continue;
      }
      const trashed = takeFromTrash(v.id);
      out.push(trashed ? mergePage({ ...trashed.page, n: out.length + 1 }, v, 'all', ctx) : freshPage(v));
    }
    for (const p of doc.pages) {
      if (ids.has(p.id)) continue;
      if (isBusy(p.render)) out.push(p); // never trash a page that is drawing (I4)
      else trashAdds.push({ page: p, fromN: p.n, deletedAt: ctx.at });
    }
    doc = renumber(doc, out);
  }
  for (const entry of asArr<{ page: Page; index?: number; part: RestorePart; insertOnly?: boolean }>(set.pagesById)) {
    if (!isObj(entry) || !isPage(entry.page)) continue;
    const part: RestorePart = entry.part === 'text' || entry.part === 'art' ? entry.part : 'all';
    const v = entry.page;
    const at = doc.pages.findIndex((p) => p.id === v.id);
    if (at >= 0) {
      if (entry.insertOnly) continue;
      doc = { ...doc, pages: doc.pages.map((p, i) => (i === at ? mergePage(p, v, part, ctx) : p)) };
      continue;
    }
    if (doc.pages.length >= DOC_LIMITS.pages) continue;
    const trashed = takeFromTrash(v.id);
    const page = trashed ? mergePage({ ...trashed.page, n: trashed.fromN }, v, part, ctx) : freshPage(v);
    const pages = doc.pages.slice();
    pages.splice(clampIndex(entry.index, pages.length), 0, page);
    doc = renumber(doc, pages);
  }
  for (const id of asArr<string>(set.pagesRemove)) {
    const p = doc.pages.find((x) => x.id === id);
    if (!p || isBusy(p.render)) continue;
    trashAdds.push({ page: p, fromN: p.n, deletedAt: ctx.at });
    doc = renumber(doc, doc.pages.filter((x) => x.id !== id));
  }
  for (const entry of asArr<{ pageId: string; panel: Panel; index?: number; balloons?: Balloon[] }>(set.panels)) {
    if (!isObj(entry) || !hasId(entry.panel) || !Array.isArray(entry.panel.lines)) continue;
    const page = doc.pages.find((p) => p.id === entry.pageId);
    if (!page) continue;
    const vp = entry.panel;
    const lineIds = new Set(vp.lines.map((l) => l.id));
    const before = page.panels.find((p) => p.id === vp.id);
    const dropped = new Set((before?.lines || []).map((l) => l.id).filter((id) => !lineIds.has(id)));
    let panels = page.panels.map((p) => (p.id === vp.id ? vp : lineIds.size && p.lines.some((l) => lineIds.has(l.id)) ? { ...p, lines: p.lines.filter((l) => !lineIds.has(l.id)) } : p));
    if (!before) {
      if (panels.length >= DOC_LIMITS.panelsPerPage) continue;
      panels = panels.slice();
      panels.splice(clampIndex(entry.index, panels.length), 0, vp);
    }
    panels = panels.map((p, i) => (p.n === i + 1 ? p : { ...p, n: i + 1 }));
    const balloons = withBalloons(page.balloons, asArr<Balloon>(entry.balloons).filter((b) => lineIds.has(b?.lineId)), dropped);
    doc = { ...doc, pages: doc.pages.map((p) => (p.id === page.id ? { ...p, panels, balloons } : p)) };
  }
  for (const entry of asArr<{ pageId: string; panelId: string; line: Line; index?: number; balloon?: Balloon }>(set.lines)) {
    if (!isObj(entry) || !hasId(entry.line)) continue;
    const page = doc.pages.find((p) => p.id === entry.pageId);
    const placed = page ? placeLine(page, entry.panelId, entry.line, entry.index) : null;
    if (!page || !placed) continue;
    const balloons = isObj(entry.balloon) && entry.balloon.lineId === entry.line.id ? withBalloons(placed.balloons, [entry.balloon], new Set()) : placed.balloons;
    doc = { ...doc, pages: doc.pages.map((p) => (p.id === page.id ? { ...placed, balloons } : p)) };
  }

  // Translations and glossary (I2).
  if (isObj(set.editions) || Array.isArray(set.glossary)) doc = mergeEditions(doc, (set.editions || {}) as Record<string, EditionMerge>, set.glossary);

  // Archive and trash are unions (never shrink).
  if (Array.isArray(set.archiveAdd) && set.archiveAdd.length) {
    const have = new Set(collectAssetPaths(doc));
    const add = set.archiveAdd.filter((a) => {
      if (!isObj(a) || typeof a.path !== 'string' || !a.path || typeof a.targetKey !== 'string' || have.has(a.path)) return false;
      have.add(a.path); // each path once
      return true;
    });
    if (add.length) {
      const archive = [...archiveOf(doc), ...add].sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));
      doc = ctx.k.evictArchive({ ...doc, archive });
    }
  }
  const trashing = new Set(trashAdds.map((t) => t.page.id));
  const versionTrash = asArr<TrashedPage>(set.trashAdd).filter(
    (t) =>
      isObj(t) &&
      isPage(t.page) &&
      !trashing.has(t.page.id) &&
      !doc.pages.some((p) => p.id === t.page.id) &&
      !trashOf(doc).some((x) => x.page.id === t.page.id)
  );
  const allTrash = [...trashAdds, ...versionTrash].sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  if (allTrash.length) {
    const existing = trashOf(doc);
    const merged = [...allTrash, ...existing].sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
    doc = trashPages({ ...doc, trash: [] }, merged, ctx);
  }
  // A restored format keeps the planned page count in step with the pages (like every page op does).
  if (isObj(set.format) && doc.pages.length >= 1 && doc.format.pageCount !== doc.pages.length) doc = { ...doc, format: { ...doc.format, pageCount: doc.pages.length } };
  return doc;
};

// ── Exact ────────────────────────────────────────────────────────────────────

const applyExact = (before: ComicDoc, set: RestoreSet, ctx: Ctx): ComicDoc => {
  let doc: ComicDoc = { ...before };
  if (isObj(set.brief)) doc.brief = { ...(set.brief as ComicDoc['brief']), notes: asArr<string>(set.brief.notes) };
  if (isObj(set.format)) doc.format = { ...(set.format as ComicDoc['format']) };
  if (isObj(set.source)) doc.source = { ...set.source };
  if (set.planStatus === 'none' || set.planStatus === 'draft' || set.planStatus === 'approved') doc.planStatus = set.planStatus;
  if (isObj(set.letterStyle)) doc.letterStyle = set.letterStyle;
  if (isObj(set.book)) doc.book = pickBook(set.book);
  if (isObj(set.reader)) doc.reader = pickReader(set.reader);
  if (typeof set.planInputHash === 'string' && set.planInputHash) doc.planInputHash = set.planInputHash;
  else if (set.planInputHash === null) delete doc.planInputHash;
  if (isObj(set.metaExtra)) doc = withMetaExtra(doc, set.metaExtra, true);
  if (isObj(set.style)) doc.style = { ...(set.style as StyleBible), options: doc.style.options };
  if (Array.isArray(set.options)) doc.style = { ...doc.style, options: set.options.filter(hasId).map(freshOption) };
  if (Array.isArray(set.cast)) doc.cast = set.cast.filter(hasId).map(freshCharacter);
  if (Array.isArray(set.places)) doc.places = set.places.filter(hasId).map(freshPlace);
  if (isObj(set.cover) && isRender((set.cover as Cover).render)) doc.cover = { ...(set.cover as Cover), render: stableRender((set.cover as Cover).render) };
  if (Array.isArray(set.pages)) doc = renumber(doc, set.pages.filter(isPage).map(freshPage));
  if (isObj(set.editions) || Array.isArray(set.glossary)) {
    const i18n = i18nOf(doc);
    const editions: Record<string, LanguageEdition> = isObj(set.editions) ? {} : i18n.editions;
    if (isObj(set.editions)) {
      for (const [lang, m] of Object.entries(set.editions)) {
        if (!isObj(m) || !isRegistryLang(lang) || sameLanguage(lang, doc.format.language)) continue;
        const e: LanguageEdition = { lang, lines: {}, balloons: {}, register: m.register === 'formal' || m.register === 'code_mixed' ? m.register : 'everyday' };
        for (const [id, raw] of Object.entries(isObj(m.lines) ? m.lines : {})) {
          const t = normalizeTextTranslation(raw);
          if (t) e.lines[id] = t;
        }
        for (const [id, raw] of Object.entries(isObj(m.balloons) ? m.balloons : {})) {
          const b = normalizeBalloonOverride(raw);
          if (b) e.balloons[id] = b;
        }
        if (isObj(m.cover)) e.cover = m.cover;
        if (isObj(m.brief)) e.brief = m.brief;
        editions[lang] = e;
      }
    }
    const glossary = Array.isArray(set.glossary) ? set.glossary.map(normalizeGlossaryTerm).filter((t): t is GlossaryTerm => !!t) : i18n.glossary;
    doc.i18n = { ...i18n, editions, glossary };
  }
  if (Array.isArray(set.archive)) doc.archive = set.archive.filter((a) => isObj(a) && typeof a.path === 'string' && typeof a.targetKey === 'string');
  // The trash belongs to the comic, not the line: the target line's Deleted pages join the comic's (by page id; the
  // comic's own entry wins), so a switch there and back gives every deleted page back. A page that is live in this
  // line is not also "deleted". Newest first, capped at MAX_TRASH (overflow archived — I1).
  const live = new Set(doc.pages.map((p) => p.id));
  const inTrash = new Set(trashOf(doc).map((t) => t.page.id));
  const adds = asArr<TrashedPage>(set.trashAdd).filter((t) => {
    if (!isObj(t) || !isPage(t.page) || inTrash.has(t.page.id)) return false;
    inTrash.add(t.page.id);
    return true;
  });
  if (adds.length) {
    const all = [...trashOf(doc), ...adds].filter((t) => !live.has(t.page.id)).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
    if (all.length) doc = trashPages({ ...doc, trash: [] }, all, ctx);
    else if (doc.trash) doc.trash = [];
  } else if (trashOf(doc).some((t) => live.has(t.page.id))) doc.trash = trashOf(doc).filter((t) => !live.has(t.page.id));
  return doc;
};

// ── Finish: forward-only image metadata, then no lost image (I1) ─────────────

/** path → the live doc's newest server-only image metadata (safety verdict, size variants). */
const liveMetaIndex = (doc: ComicDoc): Map<string, Pick<AssetRef, 'safety' | 'variants'>> => {
  const out = new Map<string, Pick<AssetRef, 'safety' | 'variants'>>();
  mapAssetRefs(doc, (a) => {
    if (a?.path && (a.safety !== undefined || a.variants !== undefined)) {
      const prev = out.get(a.path) || {};
      out.set(a.path, { safety: prev.safety ?? a.safety, variants: prev.variants ?? a.variants });
    }
    return a;
  });
  return out;
};

const freshenAssetMeta = (before: ComicDoc, next: ComicDoc): ComicDoc => {
  const live = liveMetaIndex(before);
  if (!live.size) return next;
  const out = mapAssetRefs(next, (a) => {
    const m = a?.path ? live.get(a.path) : undefined;
    if (!m) return a;
    const safetySame = m.safety === undefined || a.safety === m.safety;
    const variantsSame = m.variants === undefined || a.variants === m.variants;
    if (safetySame && variantsSame) return a;
    const out = { ...a };
    if (m.safety !== undefined) out.safety = m.safety;
    if (m.variants !== undefined) out.variants = m.variants;
    return out;
  });
  if (out === next) return next;
  // The conversation and the composer inbox are never restored and never touched (I3).
  const kept: ComicDoc = { ...out, conversation: next.conversation };
  if (next.refInbox !== undefined) kept.refInbox = next.refInbox;
  return kept;
};

/** Where every path of a doc lives: an AssetRef for it (variants and crop originals as their own refs) + its home. */
const pathHomes = (doc: ComicDoc): Map<string, { asset: AssetRef; key: string; label: string }> => {
  const out = new Map<string, { asset: AssetRef; key: string; label: string }>();
  const add = (a: AssetRef | undefined, key: string, label: string) => {
    if (!a?.path) return;
    if (!out.has(a.path)) out.set(a.path, { asset: a, key, label });
    for (const v of a.variants || []) if (v?.path && !out.has(v.path)) out.set(v.path, { asset: { path: v.path, w: v.w, h: v.h, source: 'derived', at: a.at }, key, label });
    const original = (a as RefAsset).original;
    if (original?.path && !out.has(original.path)) out.set(original.path, { asset: { path: original.path, w: original.w, h: original.h, source: a.source, at: a.at }, key, label });
  };
  const render = (r: RenderState | undefined, target: RenderTarget) => {
    if (!r) return;
    const key = renderTargetKey(target);
    const label = targetLabel(doc, target);
    add(r.asset, key, label);
    r.history.forEach((v) => add(v, key, label));
  };
  doc.style.options.forEach((o) => render(o.render, { kind: 'style_option', id: o.id }));
  add(doc.style.board, 'style_board', 'Style board');
  doc.style.refs.forEach((r) => add(r, 'ref:style', 'Style reference'));
  doc.cast.forEach((c) => {
    render(c.sheet, { kind: 'sheet', id: c.id });
    c.refs.forEach((r) => add(r, `ref:character:${c.id}`, `${c.name || 'Character'} reference`));
  });
  doc.places.forEach((p) => {
    render(p.sheet, { kind: 'place', id: p.id });
    p.refs.forEach((r) => add(r, `ref:place:${p.id}`, `${p.name || 'Place'} reference`));
  });
  doc.pages.forEach((p) => render(p.render, { kind: 'page', id: p.id }));
  render(doc.cover.render, { kind: 'cover' });
  trashOf(doc).forEach((t) => {
    const key = renderTargetKey({ kind: 'page', id: t.page.id });
    add(t.page.render.asset, key, `Deleted page ${t.fromN}`);
    t.page.render.history.forEach((v) => add(v, key, `Deleted page ${t.fromN}`));
  });
  // Ship 2 (K2a): a frame's own picture (frame.src) and an image overlay (layer.src) live on their page ('page:<id>'),
  // so I1 archives one a restore displaces. Listed last: a path a render also holds keeps that richer home. Plain
  // paths carry no maker or time (at 0 = date not recorded), and the label says what the picture was — "Page 3 panel
  // picture", "Page 3 overlay" — never just "Page 3", so it is not taken for a drawing of the page
  // (isPanelSourceArchive). A path a frame and an overlay share keeps the frame's (first) home.
  const sources = (page: Page, label: string) => {
    const key = renderTargetKey({ kind: 'page', id: page.id });
    const plain = (path: unknown, what: string) => {
      if (typeof path === 'string' && path) add({ path, source: 'upload', at: 0 }, key, `${label} ${what}`);
    };
    for (const panel of page?.panels || []) plain(panel?.frame?.src?.path, PANEL_SOURCE_ARCHIVE_WORDS.frame);
    for (const layer of page?.layers || []) plain(layer?.src?.path, PANEL_SOURCE_ARCHIVE_WORDS.layer);
  };
  doc.pages.forEach((p) => sources(p, targetLabel(doc, { kind: 'page', id: p.id })));
  trashOf(doc).forEach((t) => sources(t.page, `Deleted page ${t.fromN}`));
  return out;
};

/**
 * The archive entries for overflowed versions (render history past MAX_RENDER_HISTORY, trash past MAX_TRASH): only
 * paths the merged doc no longer references anywhere (a version's history often still lists paths the live doc has
 * already archived — archiving them again would pile up duplicates on every restore/undo and, at MAX_ARCHIVE,
 * evict real, unique old versions), each path once.
 */
const overflowEntries = (merged: ComicDoc, ctx: Ctx): ArchivedVersion[] => {
  if (!ctx.overflow.length) return [];
  const have = new Set(collectAssetPaths(merged));
  const out: ArchivedVersion[] = [];
  for (const o of ctx.overflow) {
    for (const v of o.versions) {
      if (!v?.path || have.has(v.path)) continue;
      have.add(v.path);
      out.push(ctx.k.toArchived(v, o.targetKey, o.label, ctx.at));
    }
  }
  return out;
};

const finishMerge = (before: ComicDoc, merged: ComicDoc, ctx: Ctx): ComicDoc => {
  let next = merged;
  const archived = overflowEntries(merged, ctx);
  if (archived.length) next = ctx.k.pushArchive(next, archived);
  next = freshenAssetMeta(before, next);
  // Anything still unreferenced is archived where it lived (never a render target it did not belong to).
  const after = new Set(collectAssetPaths(next));
  const lost = collectAssetPaths(before).filter((p) => !after.has(p));
  if (lost.length) {
    const homes = pathHomes(before);
    const entries: ArchivedVersion[] = [];
    for (const path of lost) {
      const home = homes.get(path);
      if (home) entries.push(ctx.k.toArchived(home.asset, home.key, home.label, ctx.at));
    }
    if (entries.length) next = ctx.k.pushArchive(next, entries);
  }
  return next;
};

// ── Entry point ──────────────────────────────────────────────────────────────

/** Apply a `history_restore` op (pure; R5/R6). Called only by ops.ts applyOp. */
export const applyHistoryRestore = (doc: ComicDoc, op: HistoryRestoreOp, k: RestoreKernel): ComicDoc => {
  if (!isObj(op) || !isObj(op.set) || (op.mode !== 'merge' && op.mode !== 'exact')) return doc;
  if (!Object.keys(op.set).length) return doc;
  const at = typeof op.at === 'number' && Number.isFinite(op.at) ? op.at : 0;
  const ctx: Ctx = { at, k, overflow: [] };
  if (op.mode === 'exact') {
    let next = applyExact(doc, op.set, ctx);
    const archived = overflowEntries(next, ctx);
    if (archived.length) next = k.pushArchive(next, archived);
    return { ...freshenAssetMeta(doc, next), gate: null };
  }
  const merged = applyMerge(doc, op.set, ctx);
  return { ...finishMerge(doc, merged, ctx), gate: null };
};
