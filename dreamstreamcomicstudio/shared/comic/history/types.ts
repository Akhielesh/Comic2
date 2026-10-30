// Comic History — the shared wire contract (versions plan §3.3; package H0).
//
// Types only (plus a few constant lists). Shared by the Node server and the Vite client, dependency-free.
// Nothing here is a ComicDoc field: history lives outside the doc (server tables, H1), and a version is
// reassembled from its book sections (sections.ts) through today's normalizeDoc.
//
// Times on the wire are epoch milliseconds. Ids are opaque strings (uuid server-side).

import type {
  ArchivedVersion,
  Balloon,
  BalloonGeometryOverride,
  BookSettings,
  Brief,
  Character,
  ComicDoc,
  Cover,
  Format,
  GlossaryTerm,
  LanguageEdition,
  Line,
  Page,
  Panel,
  Place,
  ReaderSettings,
  Source,
  StyleBible,
  StyleOption,
  TextTranslation,
  TranslationRegister,
  TrashedPage
} from '../doc.js';
import type { LetteringStyle } from '../lettering/style.js';
// Type-only (erased): describe.ts owns the moment vocabulary and imports this module's types back.
import type { PanelMoment } from './describe.js';

// ── Versions (rows) ──────────────────────────────────────────────────────────

/** Manifest format version (`Manifest.v`). */
export const HISTORY_MANIFEST_VERSION = 1;

/** Why a moment was saved (comic_versions.kind; §4.3). */
export type HistoryKind =
  | 'start'
  | 'edits'
  | 'before_ai'
  | 'ai'
  | 'named'
  | 'publish'
  | 'before_restore'
  | 'restore'
  | 'switch'
  | 'import'
  | 'legacy';
export const HISTORY_KINDS: readonly HistoryKind[] = [
  'start', 'edits', 'before_ai', 'ai', 'named', 'publish', 'before_restore', 'restore', 'switch', 'import', 'legacy'
];
/** Kinds that are pinned when written (never thinned; §4.4). */
export const PINNED_HISTORY_KINDS: readonly HistoryKind[] = ['start', 'named', 'publish', 'import', 'legacy'];

/** Who made a change (§4.2). `editor` = free software ("no AI cost"). */
export type HistoryActor = 'you' | 'ai' | 'editor' | 'system';
export type HistoryCodec = 'v5' | 'legacy';

/** What kind of change a ChangeItem records (describe.ts words each one). */
export type ChangeWhat =
  | 'dialogue'
  | 'panels'
  | 'page_text'
  | 'art'
  | 'balloons'
  | 'pages_added'
  | 'pages_removed'
  | 'pages_moved'
  | 'character'
  | 'place'
  | 'option'
  | 'style'
  | 'cover'
  | 'script'
  | 'details'
  | 'translation'
  | 'glossary'
  | 'model';

/** One recorded change (≤ HISTORY_LIMITS.changesPerRow per row; semantic: QC/variant/safety-only never appear). */
export interface ChangeItem {
  what: ChangeWhat;
  by: HistoryActor;
  /** Section key it belongs to ('page:pg_1', 'char:c_1', 'ed:te'…), when one. */
  key?: string;
  pageIds?: string[];
  /** Page numbers at capture time (display only; ids are the identity). */
  pageNs?: number[];
  lineIds?: string[];
  /** Entity id (character, place, option). */
  id?: string;
  /** Entity name at capture time (display). */
  name?: string;
  lang?: string;
  /** How many (lines, pages…) when the words need a number. */
  count?: number;
  /** Ship 2 (K2a): the panel-level moment that refines `what` (set by the recorder from the ops or the action;
   *  describe.ts words it, every other reader sees an ordinary ChangeItem). describe.ts's PanelChangeItem is this
   *  item with `moment` present. */
  moment?: PanelMoment;
  /** Panel numbers on the page, when a moment names them (display only). */
  panelNs?: number[];
}

/** Spend made by an AI run (summed from the run's new spend entries). BYOK never counts toward usage. */
export interface VersionSpend {
  usd: number;
  byok: boolean;
  estimated: boolean;
}

export interface VersionStats {
  pages: number;
  drawn: number;
  lines: number;
  langs: string[];
  models: string[];
  spend?: VersionSpend;
}

/** A thumbnail of the book at that moment (≤ HISTORY_LIMITS.thumbsPerRow). `path` is signed by the owner routes. */
export interface VersionThumb {
  /** 'cover' | 'page:<id>'. */
  key: string;
  path: string;
}

/** One moment in the History list (GET /projects/:id/history). */
export interface VersionRow {
  id: string;
  kind: HistoryKind;
  actor: HistoryActor;
  /** Server-generated plain words (≤ 160). */
  label: string;
  /** A name the user gave (≤ 80). */
  name?: string;
  note?: string;
  pinned: boolean;
  keepUntil?: number;
  /** comic_docs.rev of the captured doc (0 for legacy). */
  rev: number;
  /** When this content last changed (the "yesterday" clock). */
  contentAt: number;
  createdAt: number;
  parentId?: string;
  undoId?: string;
  /** The line it belongs to (null/absent = "Original"). */
  alternativeId?: string | null;
  modelId?: string;
  publishedRev?: number;
  codec: HistoryCodec;
  changes: ChangeItem[];
  thumbs: VersionThumb[];
  stats: VersionStats;
  /** Classic snapshots (codec legacy) and imports: where it came from. */
  legacy?: { snapshotId?: string; reason?: string; projectId?: string };
}

/** Book manifest (§3.1). Page order is the array order, so a reorder changes only the manifest. */
export interface Manifest {
  v: typeof HISTORY_MANIFEST_VERSION;
  meta: string;
  source: string;
  style: string;
  cover: string;
  places: string;
  glossary: string;
  options: [id: string, hash: string][];
  cast: [id: string, hash: string][];
  pages: [id: string, textHash: string, artHash: string][];
  editions: Record<string, { _: string; pages: [pageId: string, hash: string][] }>;
  /** Blocks of ARCHIVE_BLOCK archived versions counted from the OLDEST end. */
  archive: string[];
  trash: [pageId: string, hash: string][];
}

/** A "What changed" group of the moment detail ("Page 3 — Dialogue: 2 lines · Art: redrawn"). */
export interface ChangeGroup {
  key: string;
  title: string;
  lines: string[];
  pageId?: string;
  lang?: string;
}

/** GET /projects/:id/history/:vid. */
export interface VersionDetail {
  row: VersionRow;
  manifest: Manifest;
  groups: ChangeGroup[];
}

/** A compare side: a version id, 'now', 'published' (the latest publish row) or 'alt:<id>' (that line's head). */
export type CompareRef = string;

export interface CompareSide {
  ref: CompareRef;
  kind: 'version' | 'now' | 'published' | 'alt';
  row?: VersionRow;
}

/** GET /projects/:id/history/compare?a=&b=. Only the changed pages/entities travel (docs are partial books). */
export interface CompareResult {
  a: CompareSide;
  b: CompareSide;
  diff: BookDiff;
  docs: { a: ComicDoc; b: ComicDoc };
  /** Signed display URLs (owner-only, private). */
  urls: Record<string, string>;
}

/** "Versions you're trying" (H7). A comic with no rows has one line, "Original". */
export interface AlternativeRow {
  id: string;
  name: string;
  fromVersionId?: string;
  headVersionId?: string;
  active: boolean;
  createdAt: number;
  updatedAt: number;
}

// ── Compare (diff.ts) ────────────────────────────────────────────────────────

export interface WordDiffPart {
  op: 'same' | 'add' | 'del';
  text: string;
}

export interface LineDiff {
  lineId: string;
  status: 'added' | 'removed' | 'changed';
  kind?: [from: string | undefined, to: string | undefined];
  speaker?: [from: string | undefined, to: string | undefined];
  words?: WordDiffPart[];
}

export interface PanelDiff {
  panelId: string;
  status: 'added' | 'removed' | 'changed';
  /** Drawn fields that differ (action, shot, mood, castIds, size, angle, placeId). */
  fields: string[];
  lines: LineDiff[];
}

export interface PageDiff {
  pageId: string;
  status: 'added' | 'removed' | 'changed' | 'moved';
  /** Page number in a / in b (absent when the page is not on that side). */
  fromN?: number;
  toN?: number;
  text: boolean;
  art: boolean;
  panels: PanelDiff[];
}

export interface EntityDiff {
  id: string;
  status: 'added' | 'removed' | 'changed';
  name: string;
  /** Its sheet (drawing) differs. */
  art?: boolean;
}

export interface EditionDiff {
  lang: string;
  status: 'added' | 'removed' | 'changed';
  /** Line ids whose translation differs. */
  lineIds: string[];
  /** Register, cover or title texts differ. */
  meta: boolean;
}

/** What differs between two books (a → b), after the semantic filter (QC, variants and safety are hidden). */
export interface BookDiff {
  pages: PageDiff[];
  cast: EntityDiff[];
  places: EntityDiff[];
  options: EntityDiff[];
  style: boolean;
  script: boolean;
  cover: { text: boolean; art: boolean };
  /** Changed meta fields (brief, format, book, reader, letterStyle, planStatus). */
  meta: string[];
  editions: EditionDiff[];
  glossary: boolean;
  /** Image model of the drawn art on each side ("Drawn with X (then) · Y (now)"). */
  model?: { a?: string; b?: string };
  /** True when nothing differs. */
  same: boolean;
}

/** Keys added/removed/changed between two manifests (no body loads). */
export interface ManifestDiff {
  added: string[];
  removed: string[];
  changed: string[];
  /** Page ids present on both sides at a different position. */
  moved: string[];
  same: boolean;
}

// ── Restore (restore.ts / apply.ts; §6) ──────────────────────────────────────

export type RestorePart = 'all' | 'text' | 'art';
export type RestoreMode = 'merge' | 'exact';

/** What a "Use then" / restore brings back (§6.3). */
export type RestoreScope =
  | { kind: 'book' }
  /** replace: the page takes the version's content (re-inserted at its old index when deleted since).
   *  insert: the version's page is inserted only when no page with its id exists. */
  | { kind: 'page'; pageId: string; mode: 'replace' | 'insert'; part: RestorePart }
  | { kind: 'panel'; pageId: string; panelId: string }
  | { kind: 'line'; pageId: string; lineId: string }
  | { kind: 'character'; id: string }
  | { kind: 'place'; id: string }
  | { kind: 'cover'; part: RestorePart }
  | { kind: 'script' }
  | { kind: 'style' }
  | { kind: 'language'; lang: string }
  /** Only these section keys (undo the last AI change, §6.4). */
  | { kind: 'keys'; keys: string[] };
export type RestoreScopeKind = RestoreScope['kind'];
export const RESTORE_SCOPE_KINDS: readonly RestoreScopeKind[] = [
  'book', 'page', 'panel', 'line', 'character', 'place', 'cover', 'script', 'style', 'language', 'keys'
];

/** One language's restore payload: the version wins for its own lines; other lines are kept (I2). */
export interface EditionMerge {
  lines?: Record<string, TextTranslation>;
  balloons?: Record<string, BalloonGeometryOverride>;
  register?: TranslationRegister;
  cover?: LanguageEdition['cover'];
  brief?: LanguageEdition['brief'];
  /** Create the edition when it does not exist now (book / language scopes). */
  create?: boolean;
}

/**
 * The content a `history_restore` op brings back. Whole-section fields replace that section (merge mode keeps
 * later additions, unions and pushes displaced art into history); partial fields address one entity.
 * The applier never touches settings, spend, conversation, memory, safety, publication, imageModel or refInbox,
 * and sets `gate: null`.
 */
export interface RestoreSet {
  // whole sections
  brief?: Brief;
  /** Merge mode never changes `format.language` (the source language): the current one is kept. */
  format?: Format;
  source?: Source;
  style?: Omit<StyleBible, 'options'>;
  cover?: Cover;
  /** Which part of `cover` comes back (default 'all'). text = titles/direction; art = render + lettering. */
  coverPart?: RestorePart;
  planStatus?: ComicDoc['planStatus'];
  letterStyle?: LetteringStyle;
  book?: BookSettings;
  reader?: ReaderSettings;
  /** null removes it. */
  planInputHash?: string | null;
  /**
   * Every other key of the meta section (sections.ts isExtraMetaKey: TOP_LEVEL_SECTIONS 'meta' keys beyond the
   * typed ones — K2a's scenes and consistency — and keys TOP_LEVEL_SECTIONS does not list). key → the version's
   * value; null removes the key. Merge mode applies the listed keys; exact mode replaces the whole set (a current
   * extra key that is not listed is removed). The applier ignores any key that is not an extra meta key.
   */
  metaExtra?: Record<string, unknown>;
  /** The version's pages in its order: pages added since go to Deleted (I6). */
  pages?: Page[];
  /** Characters/places/options created since are kept (I6). */
  cast?: Character[];
  places?: Place[];
  options?: StyleOption[];
  // partial and union fields
  pagesById?: { page: Page; index?: number; part: RestorePart; insertOnly?: boolean }[];
  /** Pages to move to Deleted (undo the last AI change of a page the AI added). */
  pagesRemove?: string[];
  panels?: { pageId: string; panel: Panel; index?: number; balloons?: Balloon[] }[];
  lines?: { pageId: string; panelId: string; line: Line; index?: number; balloon?: Balloon }[];
  castById?: { character: Character; index?: number }[];
  placesById?: { place: Place; index?: number }[];
  optionsById?: { option: StyleOption; index?: number }[];
  /** lang → line merge (I2). */
  editions?: Record<string, EditionMerge>;
  /** Union by id; the version wins for its own terms. */
  glossary?: GlossaryTerm[];
  /** Archived versions the version had (union; never shrinks). */
  archiveAdd?: ArchivedVersion[];
  /** Deleted pages the version had (union; never shrinks). */
  trashAdd?: TrashedPage[];
  /** EXACT mode only: the archive as stored. */
  archive?: ArchivedVersion[];
}

/** The `history_restore` DocOp (server-only; applied by the same pure applyOps on server and client). */
export interface HistoryRestoreOp {
  op: 'history_restore';
  set: RestoreSet;
  mode: RestoreMode;
  /** The version restored from (display; the undo is the before_restore row). */
  versionId: string;
  at: number;
}

// ── Actions and cards (§3.3) ─────────────────────────────────────────────────

export type UndoAiDecision = 'mine' | 'earlier';

/** Non-spend StudioActions (NON_SPEND_ACTION_TYPES). Every history path is free. */
export type HistoryStudioAction =
  | { type: 'history_save'; name?: string; note?: string }
  | { type: 'history_restore'; versionId: string; scope: RestoreScope; baseRev?: number }
  | { type: 'history_undo_ai'; decisions?: Record<string, UndoAiDecision> }
  | { type: 'history_forget_photo'; path: string }
  | {
      type: 'history_alternative';
      mode: 'create' | 'switch' | 'rename' | 'remove';
      /** The line (switch / rename / remove). */
      id?: string;
      name?: string;
      /** create: start the new line from this moment (default: now). */
      fromVersionId?: string;
      baseRev?: number;
    };
export type HistoryActionType = HistoryStudioAction['type'];
export const HISTORY_ACTION_TYPES: readonly HistoryActionType[] = [
  'history_save', 'history_restore', 'history_undo_ai', 'history_forget_photo', 'history_alternative'
];

export type HistoryCardView = 'list' | 'moment' | 'compare' | 'confirm' | 'undo_ai';
/** The `history` conversation card: ids only, rendered by fetching from the owner API. */
export interface HistoryCard {
  type: 'history';
  id: string;
  view: HistoryCardView;
  versionId?: string;
  a?: CompareRef;
  b?: CompareRef;
  pageId?: string;
  scope?: RestoreScope;
}

// ── "When" (when.ts; director "this morning", "yesterday") ───────────────────

export type DayPart = 'morning' | 'afternoon' | 'evening' | 'night';
export interface HistoryWhen {
  /** 'today' | 'yesterday' | an ISO date 'YYYY-MM-DD' (local to the tz). */
  day: string;
  part?: DayPart;
  /** 'HH:MM' local. */
  at?: string;
}
