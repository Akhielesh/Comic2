// Comic History — "Earlier (images only)": what an old comic already holds (versions plan §11, §8; package H6a). Pure.
//
// A v4/v5 comic opened before History existed has no saved moments, but it already holds dated drawings: every
// render target's current image, its version stack (render.history) and its archived versions (doc.archive), the
// style board, the pages in Deleted (with the time they were deleted) and the last publish time. This module turns
// exactly that into "Earlier" moments — no server, no SQL, no AI, no pixel reads:
//   • dates come from AssetRef.at (deletedAt / publishedAt for those two moments), never from the clock;
//   • a fact the doc never recorded (how an image was made, its image model, its cost, its date) is listed in
//     `missing` and worded "not recorded" (§2 "Honest") — nothing is guessed from spend entries or neighbours;
//   • every image path is one the doc holds (a subset of collectAssetPaths); reference photos, chat uploads and the
//     inbox are left out (they are uploads, not drawings: "Only drawings were recorded", V-4);
//   • blocked or quarantined images keep their moment but carry no thumbnail (never shown, §12);
//   • ordering is deterministic: newest first, then book order, then path; undated moments last.
// v-numbers are the shared ones (shared/comic/book.ts versionList), the same the timeline and the director use, so
// "Use this version" from Earlier opens the existing MediaPreview / render_use flow unchanged.
// `now` and `tz` are passed in (Today / Yesterday labels); nothing here reads the clock.

import {
  archiveOf,
  currentVersion,
  thumbOf,
  trashOf,
  type ArchivedVersion,
  type AssetRef,
  type AssetSource,
  type ComicDoc,
  type RenderState,
  type RenderTarget,
  type RenderVersion,
  type VersionOrigin
} from '../doc.js';
import { versionList } from '../book.js';
import { normalizeTimeZone } from '../events.js';
import { HISTORY_LIMITS } from '../limits.js';
import { getImageModel } from '../models.js';
import { canServeToOwner } from '../safety.js';
import { isPanelSourceArchive, PANEL_SOURCE_ARCHIVE_WORDS } from './apply.js';
import type { HistoryActor } from './types.js';
import { dayGroupLabel, localParts } from './when.js';

// ── Copy ─────────────────────────────────────────────────────────────────────

/** The words for any fact the doc never recorded (§2 "Missing data says 'not recorded'"). */
export const NOT_RECORDED = 'not recorded';
/** The section title under "History starts here" (§8). */
export const EARLIER_TITLE = 'Earlier (images only)';
/** The day group of moments whose date was never recorded (always listed last). */
export const EARLIER_UNDATED_LABEL = 'Date not recorded';
/** Day key of that group. */
export const EARLIER_UNDATED_KEY = 'undated';
/** The note when History's start time is unknown (the one fallback string; the dated form names the day). */
export const EARLIER_NOTE_NO_START = 'Only drawings were recorded before History started.';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * "Only drawings were recorded before 29 Oct." — `startAt` is when History started for this comic (its `start` row's
 * time), shown as a local day in `tz` (UTC when missing or invalid). Without a usable start time: EARLIER_NOTE_NO_START.
 */
export const earlierNote = (startAt?: number | null, tz?: string | null): string => {
  if (!isDate(startAt)) return EARLIER_NOTE_NO_START;
  const p = localParts(startAt, zoneOf(tz));
  return `Only drawings were recorded before ${p.d} ${MONTHS[p.m - 1]}.`;
};

// ── Types ────────────────────────────────────────────────────────────────────

/** drawing = one image of a target; deleted = a page moved to Deleted; published = the last publish time. */
export type EarlierKind = 'drawing' | 'deleted' | 'published';

/**
 * What a moment belongs to. `deleted_page` = a page now in Deleted; `removed` = an archived image whose owner is
 * gone (a purged page, a removed character, place or style option); `book` = the whole comic (publishing).
 */
export type EarlierOwnerKind = 'page' | 'cover' | 'sheet' | 'place' | 'style_option' | 'style_board' | 'deleted_page' | 'removed' | 'book';

/** Facts a moment may be missing (each worded "not recorded"): when, who, how it was made, its image model, its cost. */
export type EarlierFact = 'date' | 'by' | 'origin' | 'model' | 'cost';

export interface EarlierOwner {
  /**
   * Group key: renderTargetKey for a live target ('page:pg_3', 'cover', 'sheet:c_1', 'place:pl_1',
   * 'style_option:so_1'), 'style_board', 'trash:<pageId>' for a deleted page, 'archive:<targetKey>' for a removed
   * owner, 'book' for publishing.
   */
  key: string;
  kind: EarlierOwnerKind;
  /** Group title: "Page 3", "Cover", "MAYA sheet", "MARKET (place)", "Style option “Ink”", "Deleted page 7". */
  label: string;
  /** Book order (stable tie-break): book, cover, pages by number, sheets, places, style options, style board,
   *  deleted pages, removed owners. */
  order: number;
  /** Live and deleted pages (and removed pages, when the archive names them): the page id ("This page" filter). */
  pageId?: string;
  /** A live render target: "Use this version" goes through the existing render_use flow. */
  target?: RenderTarget;
}

export interface EarlierMoment {
  /** Unique and stable: `<kind>|<owner key>|<path or '-'>`. */
  id: string;
  kind: EarlierKind;
  /** Epoch ms from the doc (AssetRef.at, deletedAt, publishedAt); null = not recorded. */
  at: number | null;
  owner: EarlierOwner;
  /** Plain words: "AI drew page 3", "You uploaded art for the cover", "Page 7 was deleted", "Last published". */
  label: string;
  /** The image (drawing; the deleted page as it was). Always a path the doc holds. */
  path?: string;
  /** A small variant (or the image) for thumbs; absent when the image is blocked or quarantined. */
  thumbPath?: string;
  w?: number;
  h?: number;
  /** The shared v-number of this image within its owner (v1 = oldest). */
  versionN?: number;
  /** The image the live book shows for this owner now. */
  current: boolean;
  /** Kept in doc.archive (pushed out of its version stack). */
  archived: boolean;
  starred: boolean;
  /** Held back by the content check or quarantined: never shown, never usable. */
  blocked: boolean;
  /** Who made it, from its origin (else its source); null = not recorded. */
  by: HistoryActor | null;
  origin: VersionOrigin | null;
  source: AssetSource | null;
  /** Image model id / its friendly name; null = not recorded or not applicable (see `missing`). */
  model: string | null;
  modelLabel: string | null;
  /** Recorded cost (0 = free); null = not recorded or not applicable (see `missing`). */
  costUsd: number | null;
  /** Facts the doc never recorded for this moment — the UI says "not recorded" for each. */
  missing: EarlierFact[];
  /** deleted pages: the page number it had. */
  fromN?: number;
  /** published: the languages it was published in. */
  languages?: string[];
}

/** One owner's moments (newest first). */
export interface EarlierGroup {
  key: string;
  owner: EarlierOwner;
  label: string;
  /** The newest dated moment of the group (null when none is dated). */
  at: number | null;
  moments: EarlierMoment[];
}

/** One local day: its owners, newest first. */
export interface EarlierDay {
  /** 'YYYY-MM-DD' in the zone, or EARLIER_UNDATED_KEY. */
  key: string;
  /** 'Today' | 'Yesterday' | 'Mon 27 Oct' | EARLIER_UNDATED_LABEL. */
  label: string;
  at: number | null;
  groups: EarlierGroup[];
  count: number;
}

export interface EarlierOptions {
  /** Only moments strictly before this time (History's start; later ones are real History rows). Undated moments
   *  are always kept (they can only be older data). */
  before?: number | null;
}

export interface EarlierHistoryOptions extends EarlierOptions {
  /** "Now" for the Today / Yesterday labels (passed in: this module never reads the clock). */
  now: number;
  /** The viewer's IANA zone (UTC when missing or invalid). */
  tz?: string | null;
}

/** Everything H5's "Earlier" state needs. Empty `moments` = nothing earlier ("History starts now"). */
export interface EarlierHistory {
  title: string;
  note: string;
  /** Newest first. */
  moments: EarlierMoment[];
  /** Per local day, newest day first; inside a day, per owner. */
  days: EarlierDay[];
  /** Per owner (page, cover, sheet…), the owner with the newest moment first. */
  owners: EarlierGroup[];
  /** How many images (drawing moments). */
  drawings: number;
  /** The zone the days were computed in. */
  tz: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The largest time a JS Date can hold (±8.64e15 ms); a stored time beyond it is corrupt, so it reads "not recorded"
 *  instead of making Intl throw a RangeError (which would blank the whole Earlier section). */
const MAX_TIME_MS = 8.64e15;
const isDate = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_TIME_MS;
const zoneOf = (tz?: string | null): string => normalizeTimeZone(tz) ?? 'UTC';
const clip = (s: string): string => (s.length <= HISTORY_LIMITS.labelChars ? s : `${s.slice(0, HISTORY_LIMITS.labelChars - 1).trimEnd()}…`);
/** Lower-cases a leading Capitalized word inside a sentence ("Page 3" → "page 3"); an ALL-CAPS name stays ("MAYA"). */
const lowerFirst = (s: string): string => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);
const upperFirst = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
const nameOf = (s: unknown, fallback: string): string => (typeof s === 'string' && s.trim() ? s.trim() : fallback);
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const ORIGINS: readonly VersionOrigin[] = ['render', 'edit', 'derived', 'adopted', 'upload', 'reused', 'variation'];
const SOURCES: readonly AssetSource[] = ['upload', 'generated', 'derived', 'library'];

/** Who made an image: its origin first, then its source (generated → AI). null = neither recorded. */
export const earlierActorOf = (origin: VersionOrigin | null, source: AssetSource | null): HistoryActor | null => {
  switch (origin) {
    case 'render':
    case 'edit':
    case 'variation':
      return 'ai';
    case 'derived':
    case 'reused':
      return 'editor';
    case 'adopted':
    case 'upload':
      return 'you';
    default:
      break;
  }
  switch (source) {
    case 'generated':
      return 'ai';
    case 'derived':
      return 'editor';
    case 'upload':
    case 'library':
      return 'you';
    default:
      return null;
  }
};

/** The owner as a phrase inside a sentence ("page 3", "the cover", "MAYA's sheet"). */
const phraseOf = (owner: EarlierOwner, archivedLabel?: string): string => {
  switch (owner.kind) {
    case 'page':
      return lowerFirst(owner.label);
    case 'cover':
    case 'style_board':
      return `the ${lowerFirst(owner.label)}`;
    case 'sheet': {
      const name = owner.label.replace(/ sheet$/, '');
      return `${name}${/s$/i.test(name) ? "'" : "'s"} sheet`;
    }
    case 'place':
      return `the ${owner.label.replace(/ \(place\)$/, '')} place`;
    case 'style_option':
      return `the ${lowerFirst(owner.label)}`;
    case 'deleted_page':
      return `${lowerFirst(owner.label.replace(/^Deleted /, ''))} (now in Deleted)`;
    case 'removed':
      return `${lowerFirst(archivedLabel || owner.label.replace(/ \(removed\)$/, ''))} (no longer in the book)`;
    default:
      return 'the book';
  }
};

const drawingLabel = (owner: EarlierOwner, origin: VersionOrigin | null, source: AssetSource | null, archivedLabel?: string): string => {
  const what = phraseOf(owner, archivedLabel);
  switch (origin) {
    case 'render':
      return `AI drew ${what}`;
    case 'edit':
      return `AI edited ${what}`;
    case 'variation':
      return `AI drew a variation of ${what}`;
    case 'derived':
      return `The editor fitted ${what}, no AI cost`;
    case 'reused':
      return `Reused a drawing for ${what}, no AI cost`;
    case 'adopted':
      return `You picked art for ${what}`;
    case 'upload':
      return `You uploaded art for ${what}`;
    default:
      break;
  }
  switch (source) {
    case 'generated':
      return `AI drew ${what}`;
    case 'derived':
      return `The editor made art for ${what}, no AI cost`;
    case 'upload':
      return `You uploaded art for ${what}`;
    case 'library':
      return `You picked art for ${what} from the library`;
    default:
      return upperFirst(`Art for ${what}`);
  }
};

/**
 * A page's frame picture or overlay a restore archived under the page (apply.ts isPanelSourceArchive), split from its
 * label: "Page 3 overlay" → { what: 'overlay', page: 'Page 3' }. null for anything else (a drawing).
 */
const panelSourceOf = (v: unknown): { what: string; page: string } | null => {
  const a = v as ArchivedVersion;
  if (!a || !isPanelSourceArchive(a)) return null;
  const what = a.label.endsWith(PANEL_SOURCE_ARCHIVE_WORDS.frame) ? PANEL_SOURCE_ARCHIVE_WORDS.frame : PANEL_SOURCE_ARCHIVE_WORDS.layer;
  return { what, page: a.label.slice(0, -(what.length + 1)) };
};

/** "A panel picture from page 3", "An overlay from deleted page 2": from the entry's own label, never a maker. */
const panelSourceLabel = (p: { what: string; page: string }): string => `${/^[aeiou]/.test(p.what) ? 'An' : 'A'} ${p.what} from ${lowerFirst(p.page)}`;

interface Held {
  version: RenderVersion | ArchivedVersion | AssetRef;
  n: number;
  current: boolean;
  archived: boolean;
}

/** One drawing moment from an image the doc holds. */
const drawingMoment = (owner: EarlierOwner, held: Held): EarlierMoment | null => {
  const v = held.version as Partial<RenderVersion & ArchivedVersion>;
  if (!v || typeof v.path !== 'string' || !v.path) return null;
  // A frame picture or overlay a restore archived is not an older drawing of the page: its source 'upload' only
  // records that nothing was known, so it names no maker (by and source null, "not recorded"), no v-number, and its
  // words come from the entry's own label.
  const panel = held.archived ? panelSourceOf(v) : null;
  const origin = typeof v.origin === 'string' && ORIGINS.includes(v.origin) ? v.origin : null;
  const source = !panel && typeof v.source === 'string' && SOURCES.includes(v.source) ? v.source : null;
  const by = panel ? null : earlierActorOf(origin, source);
  const at = isDate(v.at) ? v.at : null;
  const model = typeof v.model === 'string' && v.model.trim() ? v.model : null;
  const costUsd = typeof v.costUsd === 'number' && Number.isFinite(v.costUsd) && v.costUsd >= 0 ? v.costUsd : null;
  const missing: EarlierFact[] = [];
  if (at === null) missing.push('date');
  if (by === null) missing.push('by');
  if (origin === null) missing.push('origin');
  // A model and a cost only exist for images an AI made (or whose maker is unknown); uploads, picks and the editor's
  // own work (fitted, reused, derived) have neither, so their label's "no AI cost" is never contradicted.
  const aiOrUnknown = by === 'ai' || by === null;
  if (aiOrUnknown && model === null) missing.push('model');
  if (aiOrUnknown && costUsd === null) missing.push('cost');
  const blocked = !canServeToOwner(v as AssetRef) || v.path.startsWith('q/');
  const thumb = blocked ? undefined : thumbOf(v as AssetRef);
  const m: EarlierMoment = {
    id: `drawing|${owner.key}|${v.path}`,
    kind: 'drawing',
    at,
    owner,
    label: clip(panel ? panelSourceLabel(panel) : drawingLabel(owner, origin, source, owner.kind === 'removed' ? (v as ArchivedVersion).label : undefined)),
    path: v.path,
    ...(thumb?.path ? { thumbPath: thumb.path } : {}),
    ...(isDate(v.w) ? { w: v.w } : {}),
    ...(isDate(v.h) ? { h: v.h } : {}),
    ...(panel ? {} : { versionN: held.n }),
    current: held.current,
    archived: held.archived,
    starred: !!v.starred,
    blocked,
    by,
    origin,
    source,
    model,
    modelLabel: model ? getImageModel(model)?.nickname ?? model : null,
    costUsd,
    missing
  };
  return m;
};

/** Number a set of versions the way shared/comic/book.ts versionList does: v1 = oldest (at, then path); a path once. */
const numbered = (list: { version: Held['version']; current: boolean; archived: boolean }[]): Held[] => {
  const seen = new Set<string>();
  const items = list.filter((it) => {
    const path = it.version?.path;
    if (typeof path !== 'string' || !path || seen.has(path)) return false;
    seen.add(path);
    return true;
  });
  items.sort((a, b) => (a.version.at || 0) - (b.version.at || 0) || cmpStr(a.version.path, b.version.path));
  return items.map((it, i) => ({ ...it, n: i + 1 }));
};

const renderVersionsOf = (r: RenderState | undefined): { version: RenderVersion; current: boolean; archived: boolean }[] => {
  if (!r) return [];
  const current = currentVersion(r);
  return [...(current ? [{ version: current, current: true, archived: false }] : []), ...(r.history || []).map((version) => ({ version, current: false, archived: false }))];
};

// ── Derivation ───────────────────────────────────────────────────────────────

/**
 * Every "Earlier" moment the doc already holds, newest first (then book order, then path; undated last).
 * Pure: the same doc always gives the same list, and every `path` is in collectAssetPaths(doc).
 */
export const earlierMoments = (doc: ComicDoc, opts: EarlierOptions = {}): EarlierMoment[] => {
  if (!doc || typeof doc !== 'object') return [];
  const out: EarlierMoment[] = [];
  let order = 0;
  const archive = archiveOf(doc).filter((a) => a && typeof a.path === 'string' && a.path && typeof a.targetKey === 'string');
  const owned = new Set<string>(); // archive targetKeys an owner below already took

  const addTarget = (target: RenderTarget, owner: EarlierOwner) => {
    for (const e of versionList(doc, target)) {
      const m = drawingMoment(owner, { version: e.version, n: e.n, current: e.current, archived: e.archived });
      if (m) out.push(m);
    }
  };

  // The book (publishing).
  const book: EarlierOwner = { key: 'book', kind: 'book', label: 'The book', order: order++ };
  const pub = doc.publication;
  if (pub && typeof pub === 'object') {
    out.push({
      id: 'published|book|-',
      kind: 'published',
      at: isDate(pub.publishedAt) ? pub.publishedAt : null,
      owner: book,
      label: 'Last published',
      current: false,
      archived: false,
      starred: false,
      blocked: false,
      by: 'you',
      origin: null,
      source: null,
      model: null,
      modelLabel: null,
      costUsd: null,
      missing: isDate(pub.publishedAt) ? [] : ['date'],
      ...(Array.isArray(pub.languages) ? { languages: pub.languages.filter((l) => typeof l === 'string') } : {})
    });
  }

  // Cover, pages (by number), sheets, places, style options: the shared version stacks (current + history + archive).
  if (doc.cover?.render) {
    addTarget({ kind: 'cover' }, { key: 'cover', kind: 'cover', label: 'Cover', order: order++, target: { kind: 'cover' } });
    owned.add('cover');
  }
  const pages = [...(doc.pages || [])].sort((a, b) => a.n - b.n || cmpStr(a.id, b.id));
  for (const p of pages) {
    const target: RenderTarget = { kind: 'page', id: p.id };
    addTarget(target, { key: `page:${p.id}`, kind: 'page', label: `Page ${p.n}`, order: order++, pageId: p.id, target });
    owned.add(`page:${p.id}`);
  }
  for (const c of doc.cast || []) {
    const target: RenderTarget = { kind: 'sheet', id: c.id };
    addTarget(target, { key: `sheet:${c.id}`, kind: 'sheet', label: `${nameOf(c.name, 'Character').toUpperCase()} sheet`, order: order++, target });
    owned.add(`sheet:${c.id}`);
  }
  for (const pl of doc.places || []) {
    const target: RenderTarget = { kind: 'place', id: pl.id };
    addTarget(target, { key: `place:${pl.id}`, kind: 'place', label: `${nameOf(pl.name, 'Place').toUpperCase()} (place)`, order: order++, target });
    owned.add(`place:${pl.id}`);
  }
  for (const o of doc.style?.options || []) {
    const target: RenderTarget = { kind: 'style_option', id: o.id };
    addTarget(target, { key: `style_option:${o.id}`, kind: 'style_option', label: `Style option “${nameOf(o.name, 'Style')}”`, order: order++, target });
    owned.add(`style_option:${o.id}`);
  }

  // The style board: the live one plus boards a restore archived ('style_board').
  const boardOwner: EarlierOwner = { key: 'style_board', kind: 'style_board', label: 'Style board', order: order++ };
  for (const held of numbered([
    ...(doc.style?.board ? [{ version: doc.style.board, current: true, archived: false }] : []),
    ...archive.filter((a) => a.targetKey === 'style_board').map((version) => ({ version, current: false, archived: true }))
  ])) {
    const m = drawingMoment(boardOwner, held);
    if (m) out.push(m);
  }
  owned.add('style_board');

  // Pages in Deleted: their images as they were, plus the moment they were deleted.
  const trash = [...trashOf(doc)].filter((t) => t?.page?.id).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0) || cmpStr(a.page.id, b.page.id));
  for (const t of trash) {
    const key = `page:${t.page.id}`;
    if (owned.has(key)) continue; // a live page with the same id wins (it already listed its archive)
    owned.add(key);
    const fromN = Number.isFinite(t.fromN) ? t.fromN : t.page.n;
    const owner: EarlierOwner = { key: `trash:${t.page.id}`, kind: 'deleted_page', label: `Deleted page ${fromN}`, order: order++, pageId: t.page.id };
    const held = numbered([
      ...renderVersionsOf(t.page.render),
      ...archive.filter((a) => a.targetKey === key).map((version) => ({ version, current: false, archived: true }))
    ]).map((h) => ({ ...h, current: false }));
    for (const h of held) {
      const m = drawingMoment(owner, h);
      if (m) out.push(m);
    }
    const asset = t.page.render?.asset;
    const blocked = !!asset?.path && (!canServeToOwner(asset) || asset.path.startsWith('q/'));
    const thumb = asset?.path && !blocked ? thumbOf(asset) : undefined;
    out.push({
      id: `deleted|${owner.key}|-`,
      kind: 'deleted',
      at: isDate(t.deletedAt) ? t.deletedAt : null,
      owner,
      label: clip(`Page ${fromN} was deleted`),
      ...(asset?.path ? { path: asset.path } : {}),
      ...(thumb?.path ? { thumbPath: thumb.path } : {}),
      current: false,
      archived: false,
      starred: false,
      blocked,
      // Deleting a page records no actor (the creator or the director may have done it).
      by: null,
      origin: null,
      source: null,
      model: null,
      modelLabel: null,
      costUsd: null,
      missing: isDate(t.deletedAt) ? ['by'] : ['date', 'by'],
      fromN
    });
  }

  // Archived images whose owner is gone (purged pages, removed characters, places, style options). Reference photos
  // a restore archived ('ref:…') are uploads, not drawings: left out (V-4: forgetting a photo forgets it here too).
  const removed = new Map<string, ArchivedVersion[]>();
  for (const a of archive) {
    if (owned.has(a.targetKey) || a.targetKey.startsWith('ref:')) continue;
    const list = removed.get(a.targetKey) || [];
    list.push(a);
    removed.set(a.targetKey, list);
  }
  for (const targetKey of [...removed.keys()].sort(cmpStr)) {
    const list = removed.get(targetKey)!;
    const newest = [...list].sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0) || cmpStr(a.path, b.path))[0];
    // The group is the page, not its overlay: "Page 7 overlay" names "Page 7".
    const label = panelSourceOf(newest)?.page || nameOf(newest.label, 'An earlier image');
    const pageId = /^page:(.+)$/.exec(targetKey)?.[1];
    const owner: EarlierOwner = { key: `archive:${targetKey}`, kind: 'removed', label: `${label} (removed)`, order: order++, ...(pageId ? { pageId } : {}) };
    for (const h of numbered(list.map((version) => ({ version, current: false, archived: true })))) {
      const m = drawingMoment(owner, h);
      if (m) out.push(m);
    }
  }

  const before = isDate(opts.before) ? opts.before : null;
  const kept = before === null ? out : out.filter((m) => m.at === null || m.at < before);
  return kept.sort(compareMoments);
};

const KIND_ORDER: Record<EarlierKind, number> = { published: 0, deleted: 1, drawing: 2 };

/** Newest first; undated last; then book order, kind, version (newest first) and id. Total and deterministic. */
export const compareMoments = (a: EarlierMoment, b: EarlierMoment): number => {
  if (a.at !== b.at) {
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return b.at - a.at;
  }
  return (
    a.owner.order - b.owner.order ||
    KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
    (b.versionN ?? 0) - (a.versionN ?? 0) ||
    cmpStr(a.id, b.id)
  );
};

// ── Grouping ─────────────────────────────────────────────────────────────────

const newestAt = (moments: EarlierMoment[]): number | null => {
  let best: number | null = null;
  for (const m of moments) if (isDate(m.at) && (best === null || m.at > best)) best = m.at;
  return best;
};

const compareGroups = (a: EarlierGroup, b: EarlierGroup): number => {
  if (a.at !== b.at) {
    if (a.at === null) return 1;
    if (b.at === null) return -1;
    return b.at - a.at;
  }
  return a.owner.order - b.owner.order || cmpStr(a.key, b.key);
};

const groupsOf = (moments: readonly EarlierMoment[]): EarlierGroup[] => {
  const byKey = new Map<string, EarlierMoment[]>();
  const owners = new Map<string, EarlierOwner>();
  for (const m of moments) {
    const list = byKey.get(m.owner.key) || [];
    list.push(m);
    byKey.set(m.owner.key, list);
    if (!owners.has(m.owner.key)) owners.set(m.owner.key, m.owner);
  }
  const groups: EarlierGroup[] = [];
  for (const [key, list] of byKey) {
    const sorted = [...list].sort(compareMoments);
    const owner = owners.get(key)!;
    groups.push({ key, owner, label: owner.label, at: newestAt(sorted), moments: sorted });
  }
  return groups.sort(compareGroups);
};

/** Per owner (page, cover, sheet, deleted page…): the owner with the newest moment first; inside, newest first. */
export const groupEarlierByOwner = (moments: readonly EarlierMoment[]): EarlierGroup[] => groupsOf(moments);

/** Per local day in `tz` (UTC when missing or invalid), newest day first, the undated group last; inside a day, per
 *  owner (newest first). `now` only names the days (Today / Yesterday). */
export const groupEarlierByDay = (moments: readonly EarlierMoment[], opts: { now: number; tz?: string | null }): EarlierDay[] => {
  const zone = zoneOf(opts.tz);
  const byDay = new Map<string, EarlierMoment[]>();
  for (const m of moments) {
    let key = EARLIER_UNDATED_KEY;
    // A time no Date can hold (only in hand-built moments: earlierMoments already reads it as null) is undated.
    if (isDate(m.at)) {
      const p = localParts(m.at, zone);
      key = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
    }
    const list = byDay.get(key) || [];
    list.push(m);
    byDay.set(key, list);
  }
  const days: EarlierDay[] = [];
  for (const [key, list] of byDay) {
    const at = newestAt(list);
    days.push({
      key,
      label: key === EARLIER_UNDATED_KEY || at === null ? EARLIER_UNDATED_LABEL : dayGroupLabel(at, opts.now, zone),
      at,
      groups: groupsOf(list),
      count: list.length
    });
  }
  return days.sort((a, b) => {
    if (a.key === EARLIER_UNDATED_KEY) return b.key === EARLIER_UNDATED_KEY ? 0 : 1;
    if (b.key === EARLIER_UNDATED_KEY) return -1;
    return cmpStr(b.key, a.key);
  });
};

/** One page's moments ("See this page's history"): the live page, or a deleted or removed page with that id. */
export const earlierForPage = (moments: readonly EarlierMoment[], pageId: string): EarlierMoment[] =>
  moments.filter((m) => !!pageId && m.owner.pageId === pageId);

/** Everything H5's "Earlier" state needs, from the live doc (pure: `now` and `tz` are passed in). */
export const earlierHistory = (doc: ComicDoc, opts: EarlierHistoryOptions): EarlierHistory => {
  const moments = earlierMoments(doc, opts);
  return {
    title: EARLIER_TITLE,
    note: earlierNote(opts.before, opts.tz),
    moments,
    days: groupEarlierByDay(moments, opts),
    owners: groupEarlierByOwner(moments),
    drawings: moments.filter((m) => m.kind === 'drawing').length,
    tz: zoneOf(opts.tz)
  };
};

// ── Facts (plain words) ──────────────────────────────────────────────────────

/** How a pure helper prints money when the UI passes no formatter: never dollars (governed users see usage). The UI
 *  passes the viewer's formatter (useCostFormat / formatCostForUser). */
const usageWords = (usd: number): string => (Number.isFinite(usd) && usd > 0 ? 'uses a little of your usage' : 'Free');

/** Origins whose "how" line already says it cost no AI (so "No AI cost" is not repeated). */
const HOW_SAYS_NO_AI_COST: ReadonlySet<VersionOrigin> = new Set<VersionOrigin>(['derived', 'reused']);

const HOW: Record<VersionOrigin, string> = {
  render: 'Drawn by AI',
  edit: 'Edited by AI',
  variation: 'A variation drawn by AI',
  derived: 'Fitted by the editor, no AI cost',
  reused: 'Reused, no AI cost',
  adopted: 'Picked from your media',
  upload: 'Uploaded by you'
};

/**
 * The detail lines of a moment, each fact the doc never recorded worded "… not recorded":
 * "Drawn by AI" · "Drawn with Nano Banana 2.1" · cost (through `money`) · "Archived". Pure.
 */
export const earlierFacts = (m: EarlierMoment, money: (usd: number) => string = usageWords): string[] => {
  const lines: string[] = [];
  const missing = new Set(m.missing);
  if (m.kind === 'drawing') {
    if (m.origin) lines.push(HOW[m.origin]);
    else lines.push(`How it was made: ${NOT_RECORDED}`);
    if (m.modelLabel) lines.push(`Drawn with ${m.modelLabel}`);
    else if (missing.has('model')) lines.push(`Image model: ${NOT_RECORDED}`);
    if (m.costUsd !== null) lines.push(m.costUsd > 0 ? money(m.costUsd) : 'Free');
    else if (missing.has('cost')) lines.push(`Cost: ${NOT_RECORDED}`);
    else if ((m.by === 'you' || m.by === 'editor') && !(m.origin && HOW_SAYS_NO_AI_COST.has(m.origin))) lines.push('No AI cost');
    if (m.current) lines.push('In the book now');
    else if (m.archived) lines.push('Archived');
    if (m.owner.kind === 'deleted_page') lines.push('Its page is in Deleted');
  } else if (m.kind === 'deleted') {
    if (missing.has('by')) lines.push(`Deleted by: ${NOT_RECORDED}`);
  } else if (m.kind === 'published' && m.languages?.length) {
    lines.push(`Languages: ${m.languages.join(', ')}`);
  }
  if (m.blocked) lines.push('Held back by the content check');
  if (missing.has('date')) lines.push(`Date: ${NOT_RECORDED}`);
  return lines;
};
