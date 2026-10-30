// Comic History — what a restore brings back (versions plan §6.3; package H0). Pure.
//
// restoreOps(current, versionDoc, scope) builds the RestoreSet of ONE `history_restore` op from the live doc and a
// reassembled, normalized version doc (joinSections). The server (H3) then filters images (blocked, q/, deleted,
// forgotten) and commits it under the session lock; history/apply.ts applies it with I1–I6.
//
// Scope → what comes back:
//   book       every section, in the version's page order; editions/glossary/archive/trash are unions
//   page       text, panels, lines and balloons, and art unless part 'text'; that page's lines in every current edition
//   panel      the panel + its lines (+ their balloons); those lines' translations
//   line       text, kind, speaker (+ balloon); that line in every language
//   character  look, voice, refs, sheet (re-added at its old index if removed); its glossary forms
//   place      the place; its glossary forms
//   cover      that part of the cover; cover/brief titles in every current edition
//   script     doc.source (the pasted script)
//   style      the style bible and its options
//   language   one whole edition (the version wins for its lines; lines it did not have are kept)
//   keys       only the listed section keys (undo the last AI change, §6.4)

import type { Balloon, ComicDoc, LanguageEdition, Page, StyleBible } from '../doc.js';
import { i18nOf } from '../i18n.js';
import { parseSectionKey } from './sections.js';
import type { EditionMerge, HistoryRestoreOp, RestoreMode, RestorePart, RestoreScope, RestoreSet } from './types.js';

const styleSection = (style: StyleBible): Omit<StyleBible, 'options'> => {
  const { options: _options, ...rest } = style;
  return rest;
};

const lineIdsOfPage = (page: Page): string[] => page.panels.flatMap((p) => p.lines.map((l) => l.id));

const pick = <T>(map: Record<string, T> | undefined, ids: readonly string[]): Record<string, T> | undefined => {
  if (!map) return undefined;
  const out: Record<string, T> = {};
  for (const id of ids) if (Object.prototype.hasOwnProperty.call(map, id)) out[id] = map[id];
  return Object.keys(out).length ? out : undefined;
};

/** The version's translations of `lineIds`, for every edition the CURRENT doc has (and the version too). */
const linesInCurrentEditions = (current: ComicDoc, version: ComicDoc, lineIds: readonly string[]): Record<string, EditionMerge> | undefined => {
  const cur = i18nOf(current).editions;
  const ver = i18nOf(version).editions;
  const out: Record<string, EditionMerge> = {};
  for (const lang of Object.keys(cur)) {
    const e = ver[lang];
    if (!e) continue;
    const lines = pick(e.lines, lineIds);
    const balloons = pick(e.balloons, lineIds);
    if (lines || balloons) out[lang] = { ...(lines ? { lines } : {}), ...(balloons ? { balloons } : {}) };
  }
  return Object.keys(out).length ? out : undefined;
};

/** A whole edition as a merge payload (create when missing). */
const wholeEdition = (e: LanguageEdition): EditionMerge => ({
  lines: e.lines,
  balloons: e.balloons,
  register: e.register,
  ...(e.cover ? { cover: e.cover } : {}),
  ...(e.brief ? { brief: e.brief } : {}),
  create: true
});

const allEditions = (version: ComicDoc): Record<string, EditionMerge> => {
  const out: Record<string, EditionMerge> = {};
  for (const [lang, e] of Object.entries(i18nOf(version).editions)) out[lang] = wholeEdition(e);
  return out;
};

const glossaryFor = (version: ComicDoc, refId: string) => i18nOf(version).glossary.filter((t) => t.refId === refId);

const findPage = (doc: ComicDoc, id: string) => doc.pages.find((p) => p.id === id);

/** The meta section's fields (brief, format, plan status, lettering, book, reader, plan input fingerprint). */
const metaFields = (version: ComicDoc): RestoreSet => ({
  brief: version.brief,
  format: version.format,
  planStatus: version.planStatus,
  ...(version.letterStyle ? { letterStyle: version.letterStyle } : {}),
  ...(version.book ? { book: version.book } : {}),
  ...(version.reader ? { reader: version.reader } : {}),
  planInputHash: version.planInputHash ?? null
});

const merge = (a: RestoreSet, b: RestoreSet): RestoreSet => {
  const out: RestoreSet = { ...a };
  for (const [k, v] of Object.entries(b) as [keyof RestoreSet, unknown][]) {
    if (v === undefined) continue;
    const prev = out[k];
    if (Array.isArray(prev) && Array.isArray(v)) (out as Record<string, unknown>)[k] = [...prev, ...v];
    else if (k === 'editions' && prev && typeof prev === 'object') {
      const eds = { ...(prev as Record<string, EditionMerge>) };
      for (const [lang, m] of Object.entries(v as Record<string, EditionMerge>)) {
        const p = eds[lang] || {};
        eds[lang] = { ...p, ...m, lines: { ...(p.lines || {}), ...(m.lines || {}) }, balloons: { ...(p.balloons || {}), ...(m.balloons || {}) } };
      }
      out.editions = eds;
    } else (out as Record<string, unknown>)[k] = v;
  }
  return out;
};

/** The set for the section keys of an undo-last-AI plan (§6.4). */
const keysSet = (current: ComicDoc, version: ComicDoc, keys: readonly string[]): RestoreSet => {
  let set: RestoreSet = {};
  const parts = new Map<string, { text: boolean; art: boolean }>();
  const vEditions = i18nOf(version).editions;
  for (const key of keys) {
    const k = parseSectionKey(key);
    if (!k) continue;
    switch (k.kind) {
      case 'meta':
        set = merge(set, metaFields(version));
        break;
      case 'source':
        set = merge(set, { source: version.source });
        break;
      case 'style':
        set = merge(set, { style: styleSection(version.style) });
        break;
      case 'cover':
        set = merge(set, { cover: version.cover, coverPart: 'all' });
        break;
      case 'places':
        set = merge(set, { places: version.places });
        break;
      case 'glossary':
        set = merge(set, { glossary: i18nOf(version).glossary });
        break;
      case 'option': {
        const index = version.style.options.findIndex((o) => o.id === k.id);
        if (index >= 0) set = merge(set, { optionsById: [{ option: version.style.options[index], index }] });
        break; // an option the AI added is kept (I6)
      }
      case 'char': {
        const index = version.cast.findIndex((c) => c.id === k.id);
        if (index >= 0) set = merge(set, { castById: [{ character: version.cast[index], index }] });
        break; // a character the AI added is kept (I6)
      }
      case 'page':
      case 'art': {
        const p = parts.get(k.id) || { text: false, art: false };
        if (k.kind === 'page') p.text = true;
        else p.art = true;
        parts.set(k.id, p);
        break;
      }
      case 'ed': {
        const e = vEditions[k.lang];
        if (!e) break;
        const placed = new Set(version.pages.flatMap(lineIdsOfPage));
        const orphan = Object.keys(e.lines).filter((id) => !placed.has(id));
        set = merge(set, {
          editions: {
            [k.lang]: {
              register: e.register,
              ...(e.cover ? { cover: e.cover } : {}),
              ...(e.brief ? { brief: e.brief } : {}),
              ...(pick(e.lines, orphan) ? { lines: pick(e.lines, orphan) } : {}),
              create: true
            }
          }
        });
        break;
      }
      case 'edp': {
        const e = vEditions[k.lang];
        const page = findPage(version, k.pageId);
        if (!e || !page) break;
        const ids = lineIdsOfPage(page);
        const lines = pick(e.lines, ids);
        const balloons = pick(e.balloons, ids);
        if (lines || balloons) set = merge(set, { editions: { [k.lang]: { ...(lines ? { lines } : {}), ...(balloons ? { balloons } : {}), create: true } } });
        break;
      }
      case 'archive':
        set = merge(set, { archiveAdd: version.archive || [] });
        break;
      case 'trash': {
        const t = (version.trash || []).find((x) => x.page.id === k.pageId);
        if (t) set = merge(set, { trashAdd: [t] });
        break;
      }
      default:
        break;
    }
  }
  for (const [id, p] of parts) {
    const index = version.pages.findIndex((x) => x.id === id);
    if (index >= 0) {
      const part: RestorePart = p.text && p.art ? 'all' : p.text ? 'text' : 'art';
      set = merge(set, { pagesById: [{ page: version.pages[index], index, part }] });
    } else if (findPage(current, id)) {
      set = merge(set, { pagesRemove: [id] }); // the AI added this page: it goes to Deleted
    }
  }
  if (set.archiveAdd) set.archiveAdd = [...new Map(set.archiveAdd.map((a) => [`${a.targetKey}\u0000${a.path}`, a])).values()];
  return set;
};

/**
 * The RestoreSet that brings `scope` back from `version` into `current` (both normalized docs). An empty set when
 * the version does not have the target (the applier no-ops; the caller says so). Pure.
 */
export const restoreOps = (current: ComicDoc, version: ComicDoc, scope: RestoreScope): RestoreSet => {
  if (!scope || typeof scope !== 'object') return {};
  switch (scope.kind) {
    case 'book':
      return {
        ...metaFields(version),
        source: version.source,
        style: styleSection(version.style),
        options: version.style.options,
        cover: version.cover,
        coverPart: 'all',
        pages: version.pages,
        cast: version.cast,
        places: version.places,
        editions: allEditions(version),
        glossary: i18nOf(version).glossary,
        archiveAdd: version.archive || [],
        trashAdd: version.trash || []
      };
    case 'page': {
      const index = version.pages.findIndex((p) => p.id === scope.pageId);
      if (index < 0) return {};
      const page = version.pages[index];
      const part: RestorePart = scope.part === 'text' || scope.part === 'art' ? scope.part : 'all';
      const editions = part === 'art' ? undefined : linesInCurrentEditions(current, version, lineIdsOfPage(page));
      return { pagesById: [{ page, index, part, ...(scope.mode === 'insert' ? { insertOnly: true } : {}) }], ...(editions ? { editions } : {}) };
    }
    case 'panel': {
      const page = findPage(version, scope.pageId);
      const index = page ? page.panels.findIndex((p) => p.id === scope.panelId) : -1;
      if (!page || index < 0) return {};
      const panel = page.panels[index];
      const ids = panel.lines.map((l) => l.id);
      const balloons = page.balloons.filter((b: Balloon) => ids.includes(b.lineId));
      const editions = linesInCurrentEditions(current, version, ids);
      return { panels: [{ pageId: page.id, panel, index, balloons }], ...(editions ? { editions } : {}) };
    }
    case 'line': {
      const page = findPage(version, scope.pageId);
      if (!page) return {};
      for (const panel of page.panels) {
        const index = panel.lines.findIndex((l) => l.id === scope.lineId);
        if (index < 0) continue;
        const balloon = page.balloons.find((b) => b.lineId === scope.lineId);
        const editions = linesInCurrentEditions(current, version, [scope.lineId]);
        return { lines: [{ pageId: page.id, panelId: panel.id, line: panel.lines[index], index, ...(balloon ? { balloon } : {}) }], ...(editions ? { editions } : {}) };
      }
      return {};
    }
    case 'character': {
      const index = version.cast.findIndex((c) => c.id === scope.id);
      if (index < 0) return {};
      const glossary = glossaryFor(version, scope.id);
      return { castById: [{ character: version.cast[index], index }], ...(glossary.length ? { glossary } : {}) };
    }
    case 'place': {
      const index = version.places.findIndex((p) => p.id === scope.id);
      if (index < 0) return {};
      const glossary = glossaryFor(version, scope.id);
      return { placesById: [{ place: version.places[index], index }], ...(glossary.length ? { glossary } : {}) };
    }
    case 'cover': {
      const part: RestorePart = scope.part === 'text' || scope.part === 'art' ? scope.part : 'all';
      const out: RestoreSet = { cover: version.cover, coverPart: part };
      if (part !== 'art') {
        const cur = i18nOf(current).editions;
        const editions: Record<string, EditionMerge> = {};
        for (const [lang, e] of Object.entries(i18nOf(version).editions)) {
          if (!cur[lang] || (!e.cover && !e.brief)) continue;
          editions[lang] = { ...(e.cover ? { cover: e.cover } : {}), ...(e.brief ? { brief: e.brief } : {}) };
        }
        if (Object.keys(editions).length) out.editions = editions;
      }
      return out;
    }
    case 'script':
      return { source: version.source };
    case 'style':
      return { style: styleSection(version.style), options: version.style.options };
    case 'language': {
      const e = i18nOf(version).editions[scope.lang];
      return e ? { editions: { [scope.lang]: wholeEdition(e) } } : {};
    }
    case 'keys':
      return Array.isArray(scope.keys) ? keysSet(current, version, scope.keys.filter((k) => typeof k === 'string')) : {};
    default:
      return {};
  }
};

/** True when a set would change nothing (no field present). */
export const isEmptyRestoreSet = (set: RestoreSet): boolean => !set || Object.values(set).every((v) => v === undefined);

/** The `history_restore` op for a set (the server stamps `at`). */
export const historyRestoreOp = (set: RestoreSet, opts: { versionId: string; at: number; mode?: RestoreMode }): HistoryRestoreOp => ({
  op: 'history_restore',
  set,
  mode: opts.mode ?? 'merge',
  versionId: opts.versionId,
  at: opts.at
});

/**
 * The exact-mode set of a whole book (alternative switch): every section as stored, no unions — except the trash,
 * which belongs to the comic: the line's Deleted pages join the comic's (so a switch there and back loses none).
 */
export const exactRestoreSet = (version: ComicDoc): RestoreSet => ({
  ...metaFields(version),
  source: version.source,
  style: styleSection(version.style),
  options: version.style.options,
  cover: version.cover,
  pages: version.pages,
  cast: version.cast,
  places: version.places,
  editions: allEditions(version),
  glossary: i18nOf(version).glossary,
  archive: version.archive || [],
  trashAdd: version.trash || []
});

export interface RestoreEffects {
  /** Pages created since the version that a whole-book restore sends to Deleted. */
  pagesToDeleted: string[];
  /** Characters / places / options created since that stay ("Kept"). */
  keptCast: string[];
  keptPlaces: string[];
  keptOptions: string[];
  /** Editions the version does not have that stay. */
  keptEditions: string[];
}

/** What a whole-book restore keeps and moves (the restore sheet's list). Pure. */
export const restoreEffects = (current: ComicDoc, version: ComicDoc): RestoreEffects => {
  const has = <T extends { id: string }>(list: T[], id: string) => list.some((x) => x.id === id);
  const vEditions = i18nOf(version).editions;
  return {
    pagesToDeleted: current.pages.filter((p) => !has(version.pages, p.id)).map((p) => p.id),
    keptCast: current.cast.filter((c) => !has(version.cast, c.id)).map((c) => c.id),
    keptPlaces: current.places.filter((p) => !has(version.places, p.id)).map((p) => p.id),
    keptOptions: current.style.options.filter((o) => !has(version.style.options, o.id)).map((o) => o.id),
    keptEditions: Object.keys(i18nOf(current).editions).filter((lang) => !vEditions[lang])
  };
};
