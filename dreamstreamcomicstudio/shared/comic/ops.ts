// DocOps — the only way a ComicDoc changes.
//
// The server applies an op batch, bumps `rev`, persists, and streams the same batch
// to the client (`ops` event), which applies it with the SAME pure function. Ops are
// small and intention-revealing, so the stream is cheap and the client never has to
// diff documents. `applyOps` is immutable: it returns a new doc and never mutates
// its input (React state safe).
//
// Contract §5 rules for applyOp:
//  - R5 purity: no Date.now()/Math.random()/newId() inside; timestamps and ids travel in the op.
//  - R6 tolerance: an op that references a missing entity, breaks a limit or is malformed returns
//    `doc` unchanged — it never throws (optimistic rebase stays safe). The server rejects such
//    client patches before commit.
//  - Asset replacement keeps every outgoing version: history overflow moves to doc.archive (§5.3.1).
//
// StudioAction — direct UI actions that bypass the LLM (button clicks: approve a
// spend, pick a style, render pages, edit a page, manual text edits).

import {
  MAX_ARCHIVE,
  MAX_CONVERSATION,
  MAX_RENDER_HISTORY,
  MAX_SPEND_ENTRIES,
  MAX_TRASH,
  VERSION_META_KEYS,
  archiveOf,
  bookOf,
  collectAssetPaths,
  emptyRender,
  getRender,
  letterStyleOf,
  mapAssetRefs,
  normalizeErrorDetail,
  normalizeImageModelLock,
  pickBook,
  pickReader,
  readerOf,
  renderTargetKey,
  targetLabel,
  trashOf,
  type ArchivedVersion,
  type AssetRef,
  type AssetVariant,
  type Balloon,
  type BalloonGeometryOverride,
  type BookSettings,
  type Box,
  type Brief,
  type Character,
  type CharacterLook,
  type ComicDoc,
  type Cover,
  type DocSafety,
  type EditionTextField,
  type Format,
  type Gate,
  type GlossaryTerm,
  type ImageModelLock,
  type LanguageEdition,
  type Line,
  type Msg,
  type Page,
  type Panel,
  type PanelSize,
  type Place,
  type ReaderSettings,
  type RefAsset,
  type RedrawScope,
  type RefOwner,
  type RenderState,
  type RenderTarget,
  type RenderVersion,
  type Settings,
  type Source,
  type Spend,
  type SpendEntry,
  type SpendKind,
  type SpendModelTotal,
  type StyleBible,
  type StyleOption,
  type TextTranslation,
  type TranslationRegister,
  type VersionMeta,
  // --- Ship 2 (K2a) ---
  LAYER_ID_RE,
  artModeOf,
  cutFor,
  normalizeBalloonShip2,
  normalizeConsistencySettings,
  normalizeFrameStyle,
  normalizePageContinuity,
  normalizePageLayer,
  normalizePanelCuts,
  normalizePanelDirection,
  normalizePanelFrame,
  normalizeScene,
  normalizeUnitBox,
  pageSpecHash,
  type ConsistencySettings,
  type FrameStyle,
  type LineKind,
  type PageContinuity,
  type PageLayer,
  type PanelCuts,
  type PanelFrame,
  type Scene,
  type ShotType
} from './doc.js';
import { CONSISTENCY_LIMITS, DOC_LIMITS, EDITOR_LIMITS, MAX_BALLOON_SNAPSHOT, PRO_PAGE_LIMITS } from './limits.js';
// --- Ship 2 (K2a): frames carry their lettering and overlays along (pure; space.ts never imports this module) ---
import { panelPointMap, type PointMap } from './panelize/space.js';
import {
  LETTERING_PRESETS,
  MAX_SAFE_MARGIN,
  mergeStylePatch,
  type LetteringStyle,
  type LetteringStyleOpPatch,
  type LetterStylePatch
} from './lettering/style.js';
import { capFor, refsOf, refOwnerKey } from './refs.js';
import { i18nOf, normalizeBalloonOverride, normalizeGlossaryTerm, normalizeTextTranslation } from './i18n.js';
import { languageSpec, sameLanguage } from './languages.js';
import { harmonizePanelSizes, layoutConflicts, layoutPanelCount, parseLayout } from './pageGeometry.js';
import { isPublicationMirror, type PublishRequest, type PublicationMirror, type PublicationSettingsPatch } from './publication.js';
import type { SafetyVerdict } from './safety.js';
// --- history (versions plan §3.3; H0) ---
import { applyHistoryRestore, type RestoreKernel } from './history/apply.js';
import type { HistoryRestoreOp, HistoryStudioAction } from './history/types.js';

export type AssetMetaPatch = { safety?: SafetyVerdict | null; variants?: AssetVariant[] | null };
/** Keys a ref_patch may touch. `null` clears a key (applyOp deletes it); `path`, `w` and `h` can never be cleared
 *  (a ref always keeps its object and size; applyOp ignores a null path). */
export type RefPatchKey = 'label' | 'note' | 'caption' | 'subject' | 'quality' | 'dhash' | 'path' | 'w' | 'h' | 'original' | 'crop' | 'variants';
export type RefPatch = { [K in RefPatchKey]?: K extends 'path' | 'w' | 'h' ? RefAsset[K] : RefAsset[K] | null };
/** `book` op patch: blurb/credits may be null (cleared; the undo inverse of a first blurb sends null). */
export type BookPatch = Partial<Omit<BookSettings, 'blurb' | 'credits'>> & { blurb?: string | null; credits?: string[] | null };
/** Longest doc.planInputHash the plan_input_hash op stores. */
export const PLAN_INPUT_HASH_MAX = 128;
export type DocSafetyPatch = {
  text?: DocSafety['text'] | null;
  publish?: DocSafety['publish'] | null;
  source?: DocSafety['source'] | null;
  ipNoted?: string[];
};

export type DocOp =
  | { op: 'brief'; patch: Partial<Brief> }
  | { op: 'note_add'; text: string }
  | { op: 'format'; patch: Partial<Format> }
  | { op: 'settings'; patch: Partial<Settings> }
  | { op: 'source'; patch: Partial<Source> }
  | { op: 'style'; patch: Partial<Omit<StyleBible, 'options'>> }
  /** Upsert a style option (creates it when the id is new). */
  | { op: 'style_option'; id: string; patch: Partial<StyleOption> }
  | { op: 'style_options_clear' }
  /** Upsert a character (creates it with defaults when the id is new). `index` (create only) keeps cast order on undo. */
  | { op: 'character'; id: string; patch: Partial<Character>; index?: number }
  | { op: 'character_remove'; id: string }
  | { op: 'place'; id: string; patch: Partial<Place>; index?: number }
  | { op: 'place_remove'; id: string }
  /** Replace the whole page plan. */
  | { op: 'pages'; pages: Page[] }
  | { op: 'page'; id: string; patch: Partial<Omit<Page, 'panels' | 'render' | 'balloons'>> }
  | { op: 'page_panels'; id: string; panels: Panel[] }
  | { op: 'panel'; pageId: string; id: string; patch: Partial<Omit<Panel, 'lines'>> }
  /** Upsert (patch) or delete (patch: null) one line. `index` (0-based) re-inserts a NEW line at that position
   *  (undo of a delete keeps order). */
  | { op: 'line'; pageId: string; panelId: string; id: string; patch: Partial<Line> | null; index?: number }
  /** Move one line to `toPanelId` on the same page (or re-order it within its panel), inserted at `index` (0-based;
   *  default: last). The Line object travels whole (style, noTranslate); `page.balloons` and every edition's
   *  translations and balloons stay — a move never prunes. Unknown page, line or panel: no-op. */
  | { op: 'line_move'; pageId: string; id: string; toPanelId: string; index?: number }
  | { op: 'balloons'; pageId: string; balloons: Balloon[] }
  | { op: 'balloon'; pageId: string; lineId: string; patch: Partial<Balloon> }
  /** Patch a render state. Setting a NEW `asset` snapshots the outgoing one into history (§5.3.1). */
  | { op: 'render'; target: RenderTarget; patch: Partial<RenderState> }
  | { op: 'cover'; patch: Partial<Omit<Cover, 'render'>> }
  | { op: 'plan_status'; status: ComicDoc['planStatus'] }
  /** Append a message (or replace it when the id already exists). */
  | { op: 'message'; msg: Msg }
  | { op: 'message_patch'; id: string; patch: Partial<Msg> }
  | { op: 'spend'; entry: SpendEntry }
  | { op: 'gate'; gate: Gate | null }
  | { op: 'memory'; text: string }

  // ── Lettering ──
  /** Doc-level lettering (deep merge; null clears a key). patch null = reset to DEFAULT_LETTERING. */
  | { op: 'letter_style'; patch: LetteringStyleOpPatch | null }
  /** Per-line overrides on one page. merge (default) deep-merges; replace overwrites; null clears. */
  | { op: 'line_style'; pageId: string; lineIds: string[]; patch: LetterStylePatch | null; mode?: 'merge' | 'replace' }

  // ── Book structure (all renumber n = i+1 and sync format.pageCount) ──
  | { op: 'pages_reorder'; order: string[] }
  | { op: 'page_insert'; id: string; after: number; patch?: { summary?: string; layout?: string; chapterTitle?: string } }
  | { op: 'page_duplicate'; id: string; newId: string; after?: number }
  /** purge: remove WITHOUT trashing — only valid when no path of the page's render (asset + history) would become
   *  unreferenced (undo of insert/duplicate). Otherwise purge is ignored and the page goes to trash. */
  | { op: 'page_delete'; id: string; deletedAt: number; purge?: boolean }
  | { op: 'page_restore'; id: string; n?: number }
  | { op: 'book'; patch: BookPatch }
  | { op: 'reader'; patch: Partial<ReaderSettings> }

  // ── Versions ──
  /** adopt: UI confirmation flag (ref / attachment / sheet art onto a page or cover). The server strips it
   *  after checking it; applyOp ignores it. */
  | { op: 'render_use'; target: RenderTarget; path: string; at: number; adopt?: boolean }
  | { op: 'version_star'; path: string; starred: boolean }

  // ── Assets (server-only) ──
  | { op: 'asset_meta'; path: string; patch: AssetMetaPatch }

  // ── Reference images ──
  | { op: 'ref_add'; owner: RefOwner; ref: RefAsset; index?: number }
  | { op: 'ref_patch'; owner: RefOwner; path: string; patch: RefPatch }
  | { op: 'ref_move'; owner: RefOwner; path: string; to: number }
  | { op: 'ref_remove'; owner: RefOwner; path: string }
  | { op: 'ref_transfer'; from: RefOwner; to: RefOwner; path: string; index?: number }

  // ── Translations ──
  /** Create (patch object, edition missing), patch register, or remove (null). */
  | { op: 'edition'; lang: string; patch: { register?: TranslationRegister } | null }
  | { op: 'translation'; lang: string; lineId: string; patch: Partial<TextTranslation> | null }
  /** Server-only batch upsert (one translator chunk). Never deletes. */
  | { op: 'translations'; lang: string; lines: Record<string, TextTranslation> }
  | { op: 'edition_text'; lang: string; field: EditionTextField; value: TextTranslation | null }
  | { op: 'edition_balloon'; lang: string; lineId: string; patch: BalloonGeometryOverride | null }
  | { op: 'glossary_term'; id: string; patch: Partial<GlossaryTerm> | null }

  // ── Safety & publication (server-only) ──
  | { op: 'safety'; patch: DocSafetyPatch }
  | { op: 'publication'; value: PublicationMirror | null }

  // ── Planning (server-only) ──
  /** Writer input fingerprint (jobs.planPages commits planInputHashOf(after) with the pages op): a string sets
   *  doc.planInputHash, null deletes it. Not undoable (server-only). */
  | { op: 'plan_input_hash'; hash: string | null }

  // ── Image model lock (server-only; models.md §3) ──
  /** Set or replace the lock. Committed in the SAME batch as the first comic image (origin 'first_render'),
   *  on the next image commit of a legacy doc ('migrated'), or by `change_image_model` ('user_change').
   *  A malformed lock is a no-op (R6). Never undoable; never client-patchable. */
  | { op: 'image_model'; lock: ImageModelLock }

  // --- history (versions plan §3.3; server-only) ---
  /** Bring back content from a saved version (history/apply.ts). merge: I1–I6 (nothing lost, later additions kept);
   *  exact: the alternative switch only. Never client-patchable; no inverse — its undo is the before-restore row. */
  | HistoryRestoreOp

  // --- Ship 2 (K2a; pro plan §5.3): panels as objects and consistency data. Free content edits: no spend, no new asset
  //     (I10). Each has an exact inverse in undo.ts. Client-patchable once PRO_PAGE_OPS_PATCHABLE is on (with K2b's
  //     server sanitizers); until then only the server emits them. ---
  /** Frames of one page. artMode 'panels' shows the page as its frames (null: as drawn); frameStyle replaces the page's
   *  style (missing fields = default; null = all default);
   *  frames: per panel, null removes its frame. Unless moveBalloons is false, every panel whose frame or display changed
   *  carries along its balloons (locked ones stay; pinned flags unchanged), its clipped overlays and every edition's
   *  balloon overrides (space.ts panelPointMap). */
  | { op: 'page_frames'; pageId: string; artMode?: 'panels' | null; frameStyle?: Partial<FrameStyle> | null; frames?: { panelId: string; frame: PanelFrame | null }[]; moveBalloons?: boolean }
  /** Cuts of the page's CURRENT drawing: applies only when `path` is render.asset.path; written as by 'user' (keepBy: the
   *  inverse restores the cuts it replaced exactly). null clears them. New cuts can change what a frame shows, or bring
   *  the page into (or out of) frames: unless moveBalloons is false, what sits on those panels follows, as for
   *  page_frames (I6). */
  | { op: 'page_cuts'; pageId: string; path: string; cuts: PanelCuts | null; keepBy?: boolean; moveBalloons?: boolean }
  /** Panel reading order (unlisted panels keep their order after the listed ones). Structural: re-stamps (I5). */
  | { op: 'panels_order'; pageId: string; order: string[] }
  /** Insert a panel. A listed line already on this page moves into it (the page's own Line object); a new id is a new
   *  line; a line of another page refuses the op. A panel without a frame on a page shown in frames is applied and shows
   *  the page as drawn again (I2; the undo of removing a frameless panel). Structural: re-stamps (I5). */
  | { op: 'panel_add'; pageId: string; panel: Panel; index?: number }
  /** Remove a panel. Its lines go to `linesTo` (a panel of this page), or back to their `lineHomes` (the undo of a
   *  panel_add), else they are deleted with their balloons and translations. Overlays clipped to it are unclipped (kept).
   *  Structural: re-stamps (I5). */
  | { op: 'panel_remove'; pageId: string; id: string; linesTo?: string; lineHomes?: PanelLineHome[] }
  /** Upsert (patch; null clears a key) or delete (patch null) one overlay ('ly_…'); index places a new one. */
  | { op: 'layer'; pageId: string; id: string; patch: LayerPatch | null; index?: number }
  /** Merge into the page's continuity (null clears a key); patch null removes it. */
  | { op: 'continuity'; pageId: string; patch: ContinuityPatch | null }
  /** Upsert (patch) or delete (null) one scene; index places a new one. */
  | { op: 'scene'; id: string; patch: ScenePatch | null; index?: number }
  /** Book-wide consistency settings (null clears a key). */
  | { op: 'consistency'; patch: ConsistencyPatch }
  /** "Looks fine" on a finding of the page's current check (dismissed false/null brings it back). */
  | { op: 'finding'; pageId: string; id: string; patch: { dismissed: boolean | null } };

/** Where a line goes back to when a panel is removed (panel_remove.lineHomes; 0-based index in that panel). */
export interface PanelLineHome {
  lineId: string;
  panelId: string;
  index: number;
}
/** `consistency` op patch: null clears a key. */
export type ConsistencyPatch = { [K in keyof ConsistencySettings]?: ConsistencySettings[K] | null };
/** `layer` op patch: null clears a key (id comes from the op). */
export type LayerPatch = { [K in Exclude<keyof PageLayer, 'id'>]?: PageLayer[K] | null };
/** `scene` op patch: null clears a key (id comes from the op). */
export type ScenePatch = { [K in Exclude<keyof Scene, 'id'>]?: Scene[K] | null };
/** `continuity` op patch: null clears a key. */
export type ContinuityPatch = { [K in keyof PageContinuity]?: PageContinuity[K] | null };

type Quoted = { quotedUsd?: number };

// --- Ship 2 actions (pro plan §5.3; K2b) ---
/** fix: repair what is wrong; redraw: draw the panel again; draw: an empty panel; extend: a reshaped frame. */
export type FixPanelMode = 'fix' | 'redraw' | 'draw' | 'extend';
/** SPEND: one panel drawn again on the comic's locked model (one tier down) and put back into a copy of the page. */
export type FixPanelAction = { type: 'fix_panel'; pageId: string; panelId: string; mode: FixPanelMode; instruction?: string; region?: Box } & Quoted;
/** SPEND (text): directions, continuity and scenes for these pages (never story text). */
export type EnrichPagesAction = { type: 'enrich_pages'; pageIds: string[] } & Quoted;
/** Free: "Make panels editable". */
export type PanelizePageAction = { type: 'panelize_page'; pageId: string };
/** Free: "Match the script to the art" (order: the drawn panel each planned panel takes, 1-based). */
export type RebindPanelsAction = { type: 'rebind_panels'; pageId: string; order: number[] };
/** Free: a finding's software fix (off-panel voice, drop from the cast, keep the drawn state). */
export type ApplyFindingAction = { type: 'apply_finding'; pageId: string; findingId: string };
/** Free: bake frames, art and printed overlays into one raster. */
export type FlattenPageAction = { type: 'flatten_page'; pageId: string };

/** Spend actions — the ones that may be gated. A confirmed action whose fresh estimate exceeds
 *  quotedUsd × 1.15 + 0.01 is treated as UNconfirmed (re-gated), same tolerance as gateStillHolds. */
export type SpendAction =
  | ({ type: 'render_style_options'; directions?: { name: string; spec: string }[] } & Quoted)
  | ({ type: 'render_sheets'; characterIds?: string[]; force?: boolean } & Quoted)
  /** force = explicit "Redraw" of ready pages (UI button or director redraw with explicit intent).
   *  drawOverfull (plan §4.1, §5.1; decision PD-1): "Render all" (no pageIds, no force) holds back pages whose words
   *  overfill a panel — left out of the run AND its quote, with free fixes first. The ids listed here are drawn
   *  anyway ("Draw anyway"). The server keeps only this doc's page ids (planCheckGate.sanitizeDrawOverfull). */
  | ({
      type: 'render_pages';
      pageIds?: string[];
      force?: boolean;
      includeCover?: boolean;
      safe?: boolean;
      drawOverfull?: string[];
      /** Ship 2 (pro plan §5.3; B4 amendment 3): 'none' draws without consistency anchors; absent or 'auto' draws the
       *  missing anchor sheets first (ticked line items in the quote) once the run draws anchors at all. */
      anchors?: 'auto' | 'none';
      /** Ship 2 "Redraw with my layout": the page's frames become the layout guide (only while COMIC_LAYOUT_GUIDE is on). */
      followFrames?: boolean;
    } & Quoted)
  /** pasteBack (Ship 2): with a region marked, only the region is put back into the page ('region', the default) or the
   *  whole edited image is kept ('page'). */
  | ({ type: 'edit_page'; pageId: string; instruction: string; region?: Box; panelN?: number; safe?: boolean; pasteBack?: 'region' | 'page' } & Quoted)
  /** textless: one-time "textless cover + overlay title" re-render (sets cover.lettering='overlay' when it lands). */
  | ({ type: 'render_cover'; safe?: boolean; textless?: boolean } & Quoted)
  /** Translation (writer-class translator + automated linguist review, always). lineIds (≤ DOC_LIMITS.translateLineIds):
   *  only these lines — the per-line "Re-translate line" (i18n.md §10.1). */
  | ({ type: 'translate'; languages: string[]; pageIds?: string[]; lineIds?: string[]; force?: boolean; overwriteEdits?: boolean } & Quoted)
  /** Paid re-check of a drawn page (lettering.md §9): one vision call re-reads the art (QC, faces, speakers), then
   *  the balloons are re-laid around it. TEXT-priced (models.ts RELAYOUT_VISION_USD); gated, budgeted and refused
   *  for restricted accounts like every spend. The free re-layout is `relayout_balloons` (stored QC, no AI). */
  | ({ type: 'recheck_page'; pageId: string } & Quoted)
  // --- Ship 2 (pro plan §5.3): a one-panel fix (image) and a detail pass (text) ---
  | FixPanelAction
  | EnrichPagesAction;

export type StudioAction =
  | SpendAction
  | { type: 'approve_gate'; gateId: string }
  | { type: 'decline_gate'; gateId: string }
  | { type: 'pick_style'; optionId: string }
  | { type: 'plan_pages'; instructions?: string }
  | { type: 'approve_plan' }
  | { type: 'patch'; ops: DocOp[] }
  /** Compatibility action: commits `render_use`. */
  | { type: 'restore_render'; target: RenderTarget; path: string }
  /** Always free (stored QC boxes, keep-outs and heads; no AI). `useVision` is a legacy alias of the gated
   *  `recheck_page` spend (the server quotes and gates it; it never re-checks for free). */
  | { type: 'relayout_balloons'; pageId: string; useVision?: boolean }
  | { type: 'cancel' }
  | { type: 'fit_render'; target: RenderTarget; mode?: 'pad' | 'crop' | 'auto' }
  | { type: 'show_breakdown'; pageIds?: string[] }
  | { type: 'use_preset'; presetId: string; withBoard?: boolean }
  | { type: 'ref_crop'; owner: RefOwner; path: string; box?: Box; aspect?: '1:1' | '3:4' | '4:3'; reset?: boolean }
  | { type: 'publish'; request: PublishRequest; cardId?: string }
  | { type: 'update_publication'; patch: PublicationSettingsPatch; cardId?: string }
  | { type: 'unpublish'; cardId?: string }
  | { type: 'regenerate_link'; cardId?: string }
  | { type: 'decline_publish'; cardId: string }
  | { type: 'safety_recheck'; target: RenderTarget; note?: string }
  | { type: 'swap_source_language'; lang: string }
  | { type: 'accept_translation_issue'; lang: string; lineId: string; useSuggestion: boolean }
  | { type: 'library_save'; target: { kind: 'character' | 'place'; id: string } | { kind: 'style' }; name?: string } // wave 3
  | { type: 'library_use'; itemId: string } // wave 3
  | { type: 'import_classic_cast'; projectId: string; names?: string[] } // wave 3, owner's own data only
  /** models.md §3.4 item 7: the ONLY path that changes doc.imageModel after the lock. `ack: true` is the user's
   *  confirm ("consistency can be affected"); `quotedUsd` is the redraw quote shown (re-gated on drift). Non-spend:
   *  a redraw it triggers runs as a separate render_* action carrying that quote. */
  | { type: 'change_image_model'; modelId: string; redraw: RedrawScope; quotedUsd: number; ack: true }
  // --- Ship 2 (pro plan §5.3): free, non-spend ---
  | PanelizePageAction
  | RebindPanelsAction
  | ApplyFindingAction
  | FlattenPageAction
  // --- history (versions plan §3.3): free, non-spend ---
  | HistoryStudioAction;

/** The type names live in doc.ts (single source for client + server; doc.ts validates a stored card's
 *  `blockedAction` against them and cannot import this module). Re-exported here, where StudioAction is
 *  defined, so every existing import keeps working; comic.contract.test.ts checks they cover the union. */
import { NON_SPEND_ACTION_TYPES, SPEND_ACTION_TYPES } from './doc.js';
export { NON_SPEND_ACTION_TYPES, SPEND_ACTION_TYPES };

export const isSpendAction = (action: StudioAction): action is SpendAction => SPEND_ACTION_TYPES.has(action.type);

// --- Ship 2 (K2a; pro plan §5.3) ---
/** The Ship 2 client ops: free content edits on panels, overlays and consistency data (no spend, no new asset, I10). */
export const PRO_PAGE_PATCH_OPS: readonly DocOp['op'][] = [
  'page_frames', 'page_cuts', 'panels_order', 'panel_add', 'panel_remove', 'layer', 'continuity', 'scene', 'consistency', 'finding'
];
/**
 * One-line switch: the Ship 2 ops join CLIENT_PATCHABLE_OPS. On since K2b registered the server sanitizers
 * (server/src/comic/sanitize/{panels,consistency}.ts — every patchable op needs a sanitizer; extensions.test.ts checks
 * it). Off, a client batch carrying one is refused ("can't be changed directly"); clients still apply them when the
 * server streams them (KNOWN_DOC_OPS), and their inverses are computed (undo.ts) either way.
 */
export const PRO_PAGE_OPS_PATCHABLE = true;

/** Ops a client may send in `patch` — free content edits: no spend, no renders, no billing, no new assets. */
export const CLIENT_PATCHABLE_OPS: ReadonlySet<DocOp['op']> = new Set<DocOp['op']>([
  // existing 17
  'brief', 'note_add', 'format', 'settings', 'source', 'style', 'character', 'character_remove', 'place',
  'place_remove', 'page', 'panel', 'line', 'balloons', 'balloon', 'cover', 'plan_status',
  // v5
  'letter_style', 'line_style', 'line_move',
  'pages_reorder', 'page_insert', 'page_duplicate', 'page_delete', 'page_restore', 'book', 'reader',
  'render_use', 'version_star',
  'ref_add', 'ref_patch', 'ref_move', 'ref_remove', 'ref_transfer',
  'edition', 'translation', 'edition_text', 'edition_balloon', 'glossary_term',
  // --- Ship 2 (K2a) ---
  ...(PRO_PAGE_OPS_PATCHABLE ? PRO_PAGE_PATCH_OPS : [])
]);
/** Ops undo.ts inverts: every client-patchable op, and the Ship 2 ops whether or not they are patchable yet. Every
 *  inverse it returns is one of these. */
export const INVERTIBLE_OPS: ReadonlySet<DocOp['op']> = new Set<DocOp['op']>([...CLIENT_PATCHABLE_OPS, ...PRO_PAGE_PATCH_OPS]);
/** Server-only (contract test asserts none of these is patchable). */
export const SERVER_ONLY_OPS: readonly DocOp['op'][] = [
  'pages', 'page_panels', 'style_option', 'style_options_clear', 'render', 'asset_meta', 'translations',
  'message', 'message_patch', 'spend', 'gate', 'memory', 'safety', 'publication', 'plan_input_hash', 'image_model',
  // --- history ---
  'history_restore'
];

/** Every op name this build applies (patchable ∪ server-only ∪ the Ship 2 ops). A client that receives any other op name
 *  refetches the doc instead of trusting its mirror (versions plan §11: old tabs, newer server). */
export const KNOWN_DOC_OPS: ReadonlySet<string> = new Set<string>([...CLIENT_PATCHABLE_OPS, ...SERVER_ONLY_OPS, ...PRO_PAGE_PATCH_OPS]);
export const isKnownDocOp = (op: unknown): boolean =>
  !!op && typeof op === 'object' && typeof (op as { op?: unknown }).op === 'string' && KNOWN_DOC_OPS.has((op as { op: string }).op);

/** Ids the server accepts for new entities (jobs.ts SAFE_ID). */
export const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ── Helpers ──────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clampInt = (n: unknown, lo: number, hi: number, fallback: number): number =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : fallback;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const isBusy = (r?: RenderState) => !!r && (r.status === 'queued' || r.status === 'rendering');

const ASSET_KEYS = ['path', 'w', 'h', 'source', 'model', 'at', 'variants', 'safety', 'libraryId', 'derivedFrom'] as const;
/** The plain AssetRef part of a version / archive entry / ref (drops version meta, ref and archive fields). */
export const assetPartOf = (a: AssetRef): AssetRef => {
  const out: Record<string, unknown> = {};
  for (const k of ASSET_KEYS) if ((a as unknown as Record<string, unknown>)[k] !== undefined) out[k] = (a as unknown as Record<string, unknown>)[k];
  return out as unknown as AssetRef;
};
/** Every defined VersionMeta key of a render / version. */
export const metaOf = (r: Partial<VersionMeta>): VersionMeta => {
  const out: Record<string, unknown> = {};
  for (const k of VERSION_META_KEYS) if (r[k] !== undefined && r[k] !== null) out[k] = r[k];
  return out as VersionMeta;
};
const withoutMeta = (r: RenderState): RenderState => {
  const out = { ...r } as Record<string, unknown>;
  for (const k of VERSION_META_KEYS) delete out[k];
  return out as unknown as RenderState;
};
const isBlockedAsset = (a?: AssetRef) => !!a?.safety && (a.safety.assessed === 'X' || !!a.safety.quarantined);

// ── Spend running totals (models.md §3.3) ────────────────────────────────────

/** Spend kinds that are one image call each. */
export const IMAGE_SPEND_KINDS: ReadonlySet<SpendKind> = new Set<SpendKind>(['style', 'sheet', 'page', 'edit', 'cover']);
/** An entry that stands for a provider image call (a $0 software reuse carrying savedUsd is not one). */
export const isImageCallEntry = (e: SpendEntry): boolean =>
  IMAGE_SPEND_KINDS.has(e.kind) && typeof e.model === 'string' && !!e.model && !(e.usd === 0 && (e.savedUsd ?? 0) > 0);

export type SpendTotals = { byModel: Record<string, SpendModelTotal>; byTarget: Record<string, number>; failed: { count: number; usd: number } };

/** Add one entry to the totals (new objects; the input is never mutated). */
export const addSpendTotals = (totals: SpendTotals, entry: SpendEntry): SpendTotals => {
  const usd = Number.isFinite(entry.usd) ? Math.max(0, entry.usd) : 0;
  const failed = entry.outcome === 'failed';
  const out: SpendTotals = { byModel: { ...totals.byModel }, byTarget: { ...totals.byTarget }, failed: { ...totals.failed } };
  if (isImageCallEntry(entry)) {
    const prev = out.byModel[entry.model!] || { usd: 0, images: 0, failed: 0 };
    out.byModel[entry.model!] = { usd: round4(prev.usd + usd), images: prev.images + (failed ? 0 : 1), failed: prev.failed + (failed ? 1 : 0) };
  }
  if (typeof entry.target === 'string' && entry.target) out.byTarget[entry.target] = round4((out.byTarget[entry.target] || 0) + usd);
  if (failed) out.failed = { count: out.failed.count + 1, usd: round4(out.failed.usd + usd) };
  return out;
};

/** Totals rebuilt from a list of entries (exact only when the list is the doc's complete history). */
export const spendTotalsFromEntries = (entries: SpendEntry[]): SpendTotals =>
  [...entries].reverse().reduce((t, e) => addSpendTotals(t, e), { byModel: {}, byTarget: {}, failed: { count: 0, usd: 0 } } as SpendTotals);

/** The stored totals of a spend (absent keys = empty), or null when the doc has none and its history is already
 *  capped (a rebuild would not be exact; modelInsights labels such docs "(recent n)"). */
const spendTotalsOf = (spend: Spend): SpendTotals | null => {
  if (spend.byModel !== undefined || spend.byTarget !== undefined || spend.failed !== undefined) {
    return { byModel: spend.byModel ?? {}, byTarget: spend.byTarget ?? {}, failed: spend.failed ?? { count: 0, usd: 0 } };
  }
  return spend.entries.length < MAX_SPEND_ENTRIES ? spendTotalsFromEntries(spend.entries) : null;
};

/** Only non-empty totals are written (legacy docs and chat-only spends gain no keys). */
const totalsPatch = (t: SpendTotals | null): Pick<Spend, 'byModel' | 'byTarget' | 'failed'> => {
  if (!t) return {};
  return {
    ...(Object.keys(t.byModel).length ? { byModel: t.byModel } : {}),
    ...(Object.keys(t.byTarget).length ? { byTarget: t.byTarget } : {}),
    ...(t.failed.count > 0 ? { failed: t.failed } : {})
  };
};

/** Lean archive entry (no qc/balloons). */
const toArchived = (v: RenderVersion | AssetRef, targetKey: string, label: string, archivedAt: number): ArchivedVersion => {
  const rv = v as RenderVersion;
  const out: ArchivedVersion = { ...assetPartOf(v), targetKey, label, archivedAt };
  if (rv.specHash !== undefined) out.specHash = rv.specHash;
  if (rv.costUsd !== undefined) out.costUsd = rv.costUsd;
  if (rv.origin !== undefined) out.origin = rv.origin;
  if (rv.aspect !== undefined) out.aspect = rv.aspect;
  if (rv.parentPath !== undefined) out.parentPath = rv.parentPath;
  if (rv.starred) out.starred = true;
  return out;
};

/** §5.3.1 step 5: while over MAX_ARCHIVE, evict the oldest unstarred entry nothing else references (soft cap). */
const evictArchive = (doc: ComicDoc): ComicDoc => {
  const archive = archiveOf(doc);
  if (archive.length <= MAX_ARCHIVE) return doc;
  const used = new Set(collectAssetPaths({ ...doc, archive: [] }));
  const next = archive.slice();
  while (next.length > MAX_ARCHIVE) {
    let victim = -1;
    for (let i = 0; i < next.length; i += 1) {
      const a = next[i];
      if (a.starred || used.has(a.path)) continue;
      if (victim < 0 || a.archivedAt < next[victim].archivedAt || (a.archivedAt === next[victim].archivedAt && i > victim)) victim = i;
    }
    if (victim < 0) break;
    next.splice(victim, 1);
  }
  return next.length === archive.length ? doc : { ...doc, archive: next };
};

const pushArchive = (doc: ComicDoc, entries: ArchivedVersion[]): ComicDoc => {
  if (!entries.length) return doc;
  return evictArchive({ ...doc, archive: [...entries, ...archiveOf(doc)] });
};

// --- history: the archive primitives the pure restore applier uses (history/apply.ts never imports this module) ---
const RESTORE_KERNEL: RestoreKernel = { pushArchive, evictArchive, toArchived, metaOf };

interface RenderPatchResult { render: RenderState; overflow: RenderVersion[] }

/**
 * errorDetail lives only beside `error` (P2-AMEND): it is dropped when the merged render has no error, when the
 * patch sets a new error without a detail, or when the patch moves the render to a non-failed status without one.
 * (Ops travel as JSON with undefined → null, so `error: undefined` arrives as `error: null` on the client.)
 */
const withErrorDetail = (render: RenderState, patch: Partial<RenderState>): RenderState => {
  if (render.errorDetail === undefined) return render;
  const own = 'errorDetail' in patch && patch.errorDetail !== undefined && patch.errorDetail !== null;
  const detail = own ? normalizeErrorDetail(patch.errorDetail) : render.errorDetail;
  const keep =
    !!detail &&
    !!render.error &&
    (own || (!('error' in patch) && (patch.status === undefined || patch.status === 'failed')));
  if (keep) return detail === render.errorDetail ? render : { ...render, errorDetail: detail };
  const out = { ...render };
  delete out.errorDetail;
  return out;
};

/** §5.3.1 — one code path for render / character.sheet / place.sheet / style_option.render patches. */
const patchRender = (prev: RenderState | undefined, patch: Partial<RenderState>, page?: Page): RenderPatchResult => {
  const result = patchRenderRaw(prev, patch, page);
  return { ...result, render: withErrorDetail(result.render, patch) };
};

const patchRenderRaw = (prev: RenderState | undefined, patch: Partial<RenderState>, page?: Page): RenderPatchResult => {
  const base = prev || emptyRender();
  const nextAsset = patch.asset;
  if (!nextAsset || !nextAsset.path || nextAsset.path === base.asset?.path) {
    return { render: { ...base, ...patch, history: patch.history || base.history }, overflow: [] };
  }
  const outgoing: RenderVersion | undefined = base.asset
    ? { ...base.asset, ...metaOf(base), ...(page ? { balloons: page.balloons.slice(0, MAX_BALLOON_SNAPSHOT) } : {}) }
    : undefined;
  let history: RenderVersion[];
  if (patch.history) history = patch.history;
  else {
    const rest = base.history.filter((v) => v.path !== outgoing?.path && v.path !== nextAsset.path);
    history = outgoing ? [outgoing, ...rest] : rest;
  }
  const overflow = patch.history ? [] : history.slice(MAX_RENDER_HISTORY);
  const render: RenderState = { ...withoutMeta(base), ...patch, history: history.slice(0, MAX_RENDER_HISTORY) };
  return { render, overflow };
};

const findPageById = (doc: ComicDoc, id: string) => doc.pages.find((p) => p.id === id);

/** Replace the render of a target (identity-preserving map). */
const setRender = (doc: ComicDoc, target: RenderTarget, render: RenderState): ComicDoc => {
  switch (target.kind) {
    case 'page':
      return { ...doc, pages: doc.pages.map((p) => (p.id === target.id ? { ...p, render } : p)) };
    case 'cover':
      return { ...doc, cover: { ...doc.cover, render } };
    case 'sheet':
      return { ...doc, cast: doc.cast.map((c) => (c.id === target.id ? { ...c, sheet: render } : c)) };
    case 'place':
      return { ...doc, places: doc.places.map((p) => (p.id === target.id ? { ...p, sheet: render } : p)) };
    case 'style_option':
      return { ...doc, style: { ...doc.style, options: doc.style.options.map((o) => (o.id === target.id ? { ...o, render } : o)) } };
    default:
      return doc;
  }
};

const archiveOverflow = (doc: ComicDoc, target: RenderTarget, overflow: RenderVersion[], at: number): ComicDoc => {
  if (!overflow.length) return doc;
  const key = renderTargetKey(target);
  const label = targetLabel(doc, target);
  return pushArchive(doc, overflow.map((v) => toArchived(v, key, label, at)));
};

const applyRenderPatch = (doc: ComicDoc, target: RenderTarget, patch: Partial<RenderState>): ComicDoc => {
  const prev = getRender(doc, target);
  if (!prev || !isObject(patch)) return doc;
  const page = target.kind === 'page' ? findPageById(doc, target.id) : undefined;
  const { render, overflow } = patchRender(prev, patch, page);
  const next = setRender(doc, target, render);
  return archiveOverflow(next, target, overflow, patch.updatedAt ?? patch.asset?.at ?? 0);
};

/** Optional Character fields a patch may clear (contract R4: null — or undefined after the server's sanitizer — means unset). */
const CLEARABLE_CHARACTER_KEYS = ['role', 'personality', 'voice', 'kind', 'count', 'likeness'] as const;

/**
 * A character with its cleared optional fields REMOVED, not stored as null/undefined. The Undo inverse of a
 * first kind / count / likeness / role sends null for the key; the server's sanitizer turns that into
 * undefined. Both mirrors drop the key, so the client's doc (and every pageSpecHash built from it) equals
 * the server's after the echo — no stale page until the next refresh.
 */
const clearedCharacter = (c: Character): Character => {
  let out = c;
  for (const key of CLEARABLE_CHARACTER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(out, key) && (out[key] === null || out[key] === undefined)) {
      if (out === c) out = { ...c };
      delete out[key];
    }
  }
  return out;
};

/**
 * A look patch merged over the current look. A null / undefined value clears that detail (the Undo inverse
 * of a first species / markings / hair… line sends null for it), so the key is removed rather than kept as
 * null. `summary` is required: a cleared summary keeps the current one.
 */
const mergedLook = (look: CharacterLook, patch: Partial<CharacterLook>): CharacterLook => {
  const merged = { ...look, ...patch } as Record<string, unknown>;
  for (const key of Object.keys(merged)) {
    if (merged[key] !== null && merged[key] !== undefined) continue;
    if (key === 'summary') merged.summary = typeof look.summary === 'string' ? look.summary : '';
    else delete merged[key];
  }
  return merged as unknown as CharacterLook;
};

const newCharacter = (id: string, patch: Partial<Character>): Character => {
  const c: Character = {
    ...patch,
    id,
    name: patch.name || 'Unnamed',
    tier: patch.tier || 'support',
    look: mergedLook({ summary: '' }, patch.look || {}),
    refs: patch.refs || [],
    sheet: patch.sheet || emptyRender()
  };
  if (!c.role) delete c.role;
  if (!c.personality) delete c.personality;
  if (!c.voice) delete c.voice;
  if (!c.kind) delete c.kind;
  if (typeof c.count !== 'number') delete c.count;
  if (!c.likeness) delete c.likeness;
  return c;
};

/** Insert at a clamped index (default: end). */
const insertAt = <T>(list: T[], item: T, index?: number): T[] => {
  const next = list.slice();
  next.splice(clampInt(index ?? next.length, 0, next.length, next.length), 0, item);
  return next;
};

const mapPage = (doc: ComicDoc, id: string, fn: (p: Page) => Page): Page[] =>
  doc.pages.map((p) => (p.id === id ? fn(p) : p));

const mapPanel = (page: Page, id: string, fn: (p: Panel) => Panel): Page => ({
  ...page,
  panels: page.panels.map((p) => (p.id === id ? fn(p) : p))
});

/** Renumber n = i+1 and sync format.pageCount (when ≥ 1 page). */
const withPages = (doc: ComicDoc, pages: Page[]): ComicDoc => {
  const renumbered = pages.map((p, i) => (p.n === i + 1 ? p : { ...p, n: i + 1 }));
  const format = renumbered.length >= 1 && doc.format.pageCount !== renumbered.length
    ? { ...doc.format, pageCount: renumbered.length }
    : doc.format;
  return { ...doc, pages: renumbered, format };
};

const lineIdsOf = (doc: ComicDoc): Set<string> =>
  new Set(doc.pages.flatMap((p) => p.panels.flatMap((panel) => panel.lines.map((l) => l.id))));

const mapEditions = (doc: ComicDoc, fn: (e: LanguageEdition) => LanguageEdition): ComicDoc => {
  const i18n = i18nOf(doc);
  const keys = Object.keys(i18n.editions);
  if (!keys.length) return doc;
  const editions: Record<string, LanguageEdition> = {};
  for (const k of keys) editions[k] = fn(i18n.editions[k]);
  return { ...doc, i18n: { ...i18n, editions } };
};

const setEdition = (doc: ComicDoc, lang: string, edition: LanguageEdition | null): ComicDoc => {
  const i18n = i18nOf(doc);
  const editions = { ...i18n.editions };
  if (edition) editions[lang] = edition;
  else delete editions[lang];
  return { ...doc, i18n: { ...i18n, editions } };
};

const pruneLineFromEditions = (doc: ComicDoc, lineId: string): ComicDoc => {
  const i18n = i18nOf(doc);
  if (!Object.values(i18n.editions).some((e) => lineId in e.lines || lineId in e.balloons)) return doc;
  return mapEditions(doc, (e) => {
    if (!(lineId in e.lines) && !(lineId in e.balloons)) return e;
    const lines = { ...e.lines };
    const balloons = { ...e.balloons };
    delete lines[lineId];
    delete balloons[lineId];
    return { ...e, lines, balloons };
  });
};

const lineWithStyle = (l: Line, style: LetterStylePatch | undefined): Line => {
  const next = { ...l };
  if (style) next.style = style;
  else delete next.style;
  return next;
};

/** Set one owner's ref list. */
const setRefs = (doc: ComicDoc, owner: RefOwner, refs: RefAsset[]): ComicDoc => {
  switch (owner.kind) {
    case 'character':
      return { ...doc, cast: doc.cast.map((c) => (c.id === owner.id ? { ...c, refs } : c)) };
    case 'place':
      return { ...doc, places: doc.places.map((p) => (p.id === owner.id ? { ...p, refs } : p)) };
    case 'style':
      return { ...doc, style: { ...doc.style, refs } };
    case 'inbox':
      return { ...doc, refInbox: refs };
    default:
      return doc;
  }
};

const isValidOwner = (o: unknown): o is RefOwner =>
  isObject(o) && (o.kind === 'style' || o.kind === 'inbox' || ((o.kind === 'character' || o.kind === 'place') && typeof o.id === 'string'));

/** First AssetRef anywhere in the doc with this path (for adoption). */
const findAssetByPath = (doc: ComicDoc, path: string): AssetRef | undefined => {
  let found: AssetRef | undefined;
  const look = (a?: AssetRef) => {
    if (!found && a?.path === path) found = a;
  };
  const lookRender = (r?: RenderState) => {
    if (!r) return;
    look(r.asset);
    r.history.forEach(look);
  };
  doc.pages.forEach((p) => lookRender(p.render));
  lookRender(doc.cover.render);
  doc.cast.forEach((c) => {
    lookRender(c.sheet);
    c.refs.forEach(look);
  });
  doc.places.forEach((p) => {
    lookRender(p.sheet);
    p.refs.forEach(look);
  });
  doc.style.options.forEach((o) => lookRender(o.render));
  look(doc.style.board);
  doc.style.refs.forEach(look);
  archiveOf(doc).forEach(look);
  trashOf(doc).forEach((t) => lookRender(t.page.render));
  (doc.refInbox || []).forEach(look);
  doc.conversation.forEach((m) => m.attachments?.forEach(look));
  return found;
};

const LIFTED_META: readonly (keyof VersionMeta)[] = VERSION_META_KEYS;

/** render_use balloons: the chosen version's layout, except lines the user pinned in the outgoing layout. */
const restoredBalloons = (page: Page, chosen?: Balloon[]): Balloon[] | undefined => {
  if (!chosen) return undefined;
  const ids = new Set(page.panels.flatMap((p) => p.lines.map((l) => l.id)));
  if (!chosen.every((b) => ids.has(b.lineId))) return undefined;
  const pinned = new Map(page.balloons.filter((b) => b.pinned || b.locked).map((b) => [b.lineId, b]));
  const out = chosen.map((b) => pinned.get(b.lineId) ?? b);
  for (const [lineId, b] of pinned) if (!chosen.some((c) => c.lineId === lineId)) out.push(b);
  return out;
};

const applyRenderUse = (doc: ComicDoc, op: Extract<DocOp, { op: 'render_use' }>): ComicDoc => {
  const r = getRender(doc, op.target);
  if (!r || isBusy(r) || typeof op.path !== 'string' || !op.path || op.path === r.asset?.path) return doc;
  const key = renderTargetKey(op.target);
  const page = op.target.kind === 'page' ? findPageById(doc, op.target.id) : undefined;
  const archive = archiveOf(doc);
  const histIdx = r.history.findIndex((v) => v.path === op.path);
  const archIdx = histIdx >= 0 ? -1 : archive.findIndex((a) => a.path === op.path && a.targetKey === key);
  let chosenAsset: AssetRef;
  let chosenMeta: VersionMeta;
  let chosenBalloons: Balloon[] | undefined;
  if (histIdx >= 0) {
    const v = r.history[histIdx];
    chosenAsset = assetPartOf(v);
    chosenMeta = metaOf(v);
    chosenBalloons = v.balloons;
  } else if (archIdx >= 0) {
    const a = archive[archIdx];
    chosenAsset = assetPartOf(a);
    chosenMeta = metaOf(a);
  } else {
    if (!collectAssetPaths(doc).includes(op.path)) return doc;
    const found = findAssetByPath(doc, op.path);
    if (!found) return doc;
    chosenAsset = assetPartOf(found);
    chosenMeta = { origin: 'adopted' };
  }
  if (isBlockedAsset(chosenAsset)) return doc;
  const outgoing: RenderVersion | undefined = r.asset
    ? { ...r.asset, ...metaOf(r), ...(page ? { balloons: page.balloons.slice(0, MAX_BALLOON_SNAPSHOT) } : {}) }
    : undefined;
  const rest = r.history.filter((v) => v.path !== op.path && v.path !== outgoing?.path);
  const history = outgoing ? [outgoing, ...rest] : rest;
  const lifted: Record<string, unknown> = {};
  for (const k of LIFTED_META) if (chosenMeta[k] !== undefined) lifted[k] = chosenMeta[k];
  const render: RenderState = {
    ...withoutMeta(r),
    ...(lifted as VersionMeta),
    status: 'ready',
    asset: chosenAsset,
    history: history.slice(0, MAX_RENDER_HISTORY),
    updatedAt: op.at
  };
  delete render.error;
  delete render.errorDetail;
  let next = setRender(doc, op.target, render);
  if (page) {
    const balloons = restoredBalloons(page, chosenBalloons);
    if (balloons) next = { ...next, pages: next.pages.map((p) => (p.id === page.id ? { ...p, balloons } : p)) };
  }
  if (archIdx >= 0) next = { ...next, archive: archiveOf(next).filter((_, i) => i !== archIdx) };
  return archiveOverflow(next, op.target, history.slice(MAX_RENDER_HISTORY), op.at);
};

const deepCopy = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

const applyPageDuplicate = (doc: ComicDoc, op: Extract<DocOp, { op: 'page_duplicate' }>): ComicDoc => {
  const src = findPageById(doc, op.id);
  if (!src || typeof op.newId !== 'string' || !op.newId || findPageById(doc, op.newId) || isBusy(src.render)) return doc;
  if (doc.pages.length >= DOC_LIMITS.pages) return doc;
  const lineMap = new Map<string, string>();
  const panels: Panel[] = src.panels.map((panel, i) => ({
    ...deepCopy(panel),
    id: `${op.newId}_p${i}`,
    lines: panel.lines.map((l, j) => {
      const id = `${op.newId}_l${i}_${j}`;
      lineMap.set(l.id, id);
      return { ...deepCopy(l), id };
    })
  }));
  const balloons = src.balloons
    .filter((b) => lineMap.has(b.lineId))
    .map((b) => {
      const nb: Balloon = { ...b, lineId: lineMap.get(b.lineId)! };
      if (b.linkTo !== undefined) {
        if (lineMap.has(b.linkTo)) nb.linkTo = lineMap.get(b.linkTo);
        else delete nb.linkTo;
      }
      return nb;
    });
  const copy: Page = remapPanelIds(
    {
      ...deepCopy(src),
      id: op.newId,
      n: 0,
      panels,
      balloons,
      render: { ...src.render, history: [] }
    },
    new Map(src.panels.map((p, i) => [p.id, panels[i].id]))
  );
  const idx = clampInt(op.after ?? src.n, 0, doc.pages.length, src.n);
  const pages = doc.pages.slice();
  pages.splice(idx, 0, copy);
  let next = withPages(doc, pages);
  next = mapEditions(next, (e) => {
    let lines = e.lines;
    let eb = e.balloons;
    for (const [from, to] of lineMap) {
      if (e.lines[from]) lines = { ...lines, [to]: { ...e.lines[from] } };
      if (e.balloons[from]) eb = { ...eb, [to]: { ...e.balloons[from] } };
    }
    return lines === e.lines && eb === e.balloons ? e : { ...e, lines, balloons: eb };
  });
  return next;
};

const renderPaths = (r: RenderState): string[] => [r.asset?.path, ...r.history.map((v) => v.path)].filter((p): p is string => !!p);

const applyPageDelete = (doc: ComicDoc, op: Extract<DocOp, { op: 'page_delete' }>): ComicDoc => {
  const page = findPageById(doc, op.id);
  if (!page || isBusy(page.render)) return doc;
  const remaining = doc.pages.filter((p) => p.id !== op.id);
  if (op.purge) {
    const paths = renderPaths(page.render);
    const still = paths.length ? new Set(collectAssetPaths({ ...doc, pages: remaining })) : new Set<string>();
    if (paths.every((p) => still.has(p))) return withPages(doc, remaining);
  }
  const deletedAt = typeof op.deletedAt === 'number' && Number.isFinite(op.deletedAt) ? op.deletedAt : 0;
  let trash = [{ page, fromN: page.n, deletedAt }, ...trashOf(doc)];
  const overflow = trash.slice(MAX_TRASH);
  trash = trash.slice(0, MAX_TRASH);
  let next: ComicDoc = { ...withPages(doc, remaining), trash };
  const archived: ArchivedVersion[] = [];
  for (const t of overflow) {
    const key = renderTargetKey({ kind: 'page', id: t.page.id });
    const label = `Deleted page ${t.fromN}`;
    if (t.page.render.asset) archived.push(toArchived({ ...t.page.render.asset, ...metaOf(t.page.render) }, key, label, deletedAt));
    for (const v of t.page.render.history) archived.push(toArchived(v, key, label, deletedAt));
  }
  next = archived.length ? pushArchive(next, archived) : next;
  return next;
};

const applyLetterStyle = (doc: ComicDoc, patch: LetteringStyleOpPatch | null): ComicDoc => {
  if (patch === null) return { ...doc, letterStyle: { presetId: 'classic' } };
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return doc;
  const cur = letterStyleOf(doc);
  const next: LetteringStyle = { ...cur };
  if (patch.presetId !== undefined && patch.presetId !== null) {
    if (!LETTERING_PRESETS[patch.presetId]) return doc;
    if (patch.presetId !== cur.presetId) {
      next.presetId = patch.presetId;
      if (!patch.keepOverrides) {
        delete next.base;
        delete next.kinds;
      }
      next.auto = patch.auto ?? false; // a manual pick stops auto
    } else if (patch.auto !== undefined) {
      if (patch.auto === null) delete next.auto;
      else next.auto = patch.auto;
    }
  } else if (patch.auto !== undefined) {
    if (patch.auto === null) delete next.auto;
    else next.auto = patch.auto;
  }
  if ('base' in patch && patch.base !== undefined) {
    const base = patch.base === null ? undefined : mergeStylePatch(next.base, patch.base);
    if (base) next.base = base;
    else delete next.base;
  }
  const mergeMap = <K extends string>(cur0: Partial<Record<K, LetterStylePatch>> | undefined, p: Partial<Record<K, LetterStylePatch | null>>) => {
    const out: Partial<Record<K, LetterStylePatch>> = { ...(cur0 || {}) };
    for (const k of Object.keys(p) as K[]) {
      const v = p[k];
      if (v === undefined) continue;
      const merged = v === null ? undefined : mergeStylePatch(out[k], v);
      if (merged) out[k] = merged;
      else delete out[k];
    }
    return Object.keys(out).length ? out : undefined;
  };
  if (isObject(patch.kinds)) {
    const kinds = mergeMap(next.kinds, patch.kinds);
    if (kinds) next.kinds = kinds;
    else delete next.kinds;
  }
  if (isObject(patch.speakers)) {
    const speakers = mergeMap(next.speakers, patch.speakers);
    if (speakers) next.speakers = speakers as Record<string, LetterStylePatch>;
    else delete next.speakers;
  }
  if (patch.safeMargin === null) delete next.safeMargin;
  else if (typeof patch.safeMargin === 'number' && Number.isFinite(patch.safeMargin)) {
    next.safeMargin = Math.min(MAX_SAFE_MARGIN, Math.max(0, patch.safeMargin));
  }
  return { ...doc, letterStyle: next };
};

const applyLineStyle = (doc: ComicDoc, op: Extract<DocOp, { op: 'line_style' }>): ComicDoc => {
  const page = findPageById(doc, op.pageId);
  if (!page || !Array.isArray(op.lineIds)) return doc;
  const ids = new Set(op.lineIds);
  let changed = false;
  const panels = page.panels.map((panel) => {
    if (!panel.lines.some((l) => ids.has(l.id))) return panel;
    return {
      ...panel,
      lines: panel.lines.map((l) => {
        if (!ids.has(l.id)) return l;
        changed = true;
        if (op.patch === null) return lineWithStyle(l, undefined);
        if (op.mode === 'replace') return lineWithStyle(l, isObject(op.patch) && Object.keys(op.patch).length ? { ...op.patch } : undefined);
        return lineWithStyle(l, mergeStylePatch(l.style, op.patch));
      })
    };
  });
  if (!changed) return doc;
  return { ...doc, pages: mapPage(doc, op.pageId, (p) => ({ ...p, panels })) };
};

const applyLine = (doc: ComicDoc, op: Extract<DocOp, { op: 'line' }>): ComicDoc => {
  const page = findPageById(doc, op.pageId);
  if (!page || !page.panels.some((p) => p.id === op.panelId)) return doc;
  const next: ComicDoc = {
    ...doc,
    pages: mapPage(doc, op.pageId, (p) => {
      const withLines = mapPanel(p, op.panelId, (panel) => {
        if (op.patch === null) return { ...panel, lines: panel.lines.filter((l) => l.id !== op.id) };
        const patch = op.patch as Partial<Line>;
        const exists = panel.lines.some((l) => l.id === op.id);
        if (exists) {
          return {
            ...panel,
            lines: panel.lines.map((l) => {
              if (l.id !== op.id) return l;
              const merged = { ...l, ...patch, id: l.id } as Line;
              if ('style' in patch) return lineWithStyle(merged, mergeStylePatch(l.style, patch.style));
              return merged;
            })
          };
        }
        const created = { id: op.id, kind: 'speech', text: '', ...patch } as Line;
        created.id = op.id;
        if (!created.style) delete created.style;
        const lines = panel.lines.slice();
        lines.splice(clampInt(op.index ?? lines.length, 0, lines.length, lines.length), 0, created);
        return { ...panel, lines };
      });
      return op.patch === null ? { ...withLines, balloons: withLines.balloons.filter((b) => b.lineId !== op.id) } : withLines;
    })
  };
  return op.patch === null ? pruneLineFromEditions(next, op.id) : next;
};

/** Move a line between panels of one page (or re-order it): the same Line object, balloons and editions untouched. */
const applyLineMove = (doc: ComicDoc, op: Extract<DocOp, { op: 'line_move' }>): ComicDoc => {
  const page = findPageById(doc, op.pageId);
  if (!page) return doc;
  const from = page.panels.find((panel) => panel.lines.some((l) => l.id === op.id));
  const to = page.panels.find((panel) => panel.id === op.toPanelId);
  if (!from || !to) return doc;
  const line = from.lines.find((l) => l.id === op.id) as Line;
  const panels = page.panels.map((panel) => {
    if (panel.id !== from.id && panel.id !== to.id) return panel;
    const lines = panel.id === from.id ? panel.lines.filter((l) => l.id !== op.id) : panel.lines.slice();
    if (panel.id === to.id) lines.splice(clampInt(op.index ?? lines.length, 0, lines.length, lines.length), 0, line);
    return { ...panel, lines };
  });
  const same = (a: readonly Line[], b: readonly Line[]) => a.length === b.length && a.every((l, i) => l === b[i]);
  if (panels.every((panel, i) => same(panel.lines, page.panels[i].lines))) return doc;
  return { ...doc, pages: mapPage(doc, op.pageId, (p) => ({ ...p, panels })) };
};

const applyRefOp = (doc: ComicDoc, op: Extract<DocOp, { op: 'ref_add' | 'ref_patch' | 'ref_move' | 'ref_remove' | 'ref_transfer' }>): ComicDoc => {
  switch (op.op) {
    case 'ref_add': {
      if (!isValidOwner(op.owner) || !isObject(op.ref) || typeof op.ref.path !== 'string' || !op.ref.path) return doc;
      const refs = refsOf(doc, op.owner);
      if (!refs || refs.some((r) => r.path === op.ref.path) || refs.length >= capFor(op.owner)) return doc;
      const next = refs.slice();
      next.splice(clampInt(op.index ?? next.length, 0, next.length, next.length), 0, { ...op.ref, source: op.ref.source || 'upload' });
      return setRefs(doc, op.owner, next);
    }
    case 'ref_patch': {
      if (!isValidOwner(op.owner) || !isObject(op.patch)) return doc;
      const refs = refsOf(doc, op.owner);
      const idx = refs ? refs.findIndex((r) => r.path === op.path) : -1;
      if (!refs || idx < 0) return doc;
      const newPath = op.patch.path;
      if (typeof newPath === 'string' && newPath && newPath !== op.path && refs.some((r) => r.path === newPath)) return doc;
      const merged = { ...refs[idx] } as Record<string, unknown>;
      for (const [k, v] of Object.entries(op.patch)) {
        if (k === 'path' && (typeof v !== 'string' || !v)) continue;
        if (v === null || v === undefined) delete merged[k];
        else merged[k] = v;
      }
      const next = refs.slice();
      next[idx] = merged as unknown as RefAsset;
      return setRefs(doc, op.owner, next);
    }
    case 'ref_move': {
      if (!isValidOwner(op.owner)) return doc;
      const refs = refsOf(doc, op.owner);
      const idx = refs ? refs.findIndex((r) => r.path === op.path) : -1;
      if (!refs || idx < 0) return doc;
      const next = refs.slice();
      const [ref] = next.splice(idx, 1);
      next.splice(clampInt(op.to, 0, Math.max(0, refs.length - 1), idx), 0, ref);
      return setRefs(doc, op.owner, next);
    }
    case 'ref_remove': {
      if (!isValidOwner(op.owner)) return doc;
      const refs = refsOf(doc, op.owner);
      if (!refs || !refs.some((r) => r.path === op.path)) return doc;
      return setRefs(doc, op.owner, refs.filter((r) => r.path !== op.path));
    }
    case 'ref_transfer': {
      if (!isValidOwner(op.from) || !isValidOwner(op.to) || refOwnerKey(op.from) === refOwnerKey(op.to)) return doc;
      const from = refsOf(doc, op.from);
      const to = refsOf(doc, op.to);
      const ref = from?.find((r) => r.path === op.path);
      if (!from || !to || !ref || to.length >= capFor(op.to) || to.some((r) => r.path === op.path)) return doc;
      const nextTo = to.slice();
      nextTo.splice(clampInt(op.index ?? nextTo.length, 0, nextTo.length, nextTo.length), 0, ref);
      return setRefs(setRefs(doc, op.from, from.filter((r) => r.path !== op.path)), op.to, nextTo);
    }
    default:
      return doc;
  }
};

const isRegistryLang = (lang: unknown): lang is string => typeof lang === 'string' && languageSpec(lang)?.code === lang;
const REGISTERS: readonly TranslationRegister[] = ['everyday', 'formal', 'code_mixed'];
const EDITION_FIELDS: Record<EditionTextField, ['cover' | 'brief', 'title' | 'tagline' | 'logline']> = {
  'cover.title': ['cover', 'title'],
  'cover.tagline': ['cover', 'tagline'],
  'brief.title': ['brief', 'title'],
  'brief.logline': ['brief', 'logline']
};

const applyI18nOp = (
  doc: ComicDoc,
  op: Extract<DocOp, { op: 'edition' | 'translation' | 'translations' | 'edition_text' | 'edition_balloon' | 'glossary_term' }>
): ComicDoc => {
  const i18n = i18nOf(doc);
  switch (op.op) {
    case 'edition': {
      if (!isRegistryLang(op.lang) || sameLanguage(op.lang, doc.format.language)) return doc;
      const cur = i18n.editions[op.lang];
      if (op.patch === null) return cur ? setEdition(doc, op.lang, null) : doc;
      if (!isObject(op.patch)) return doc;
      const register = REGISTERS.includes(op.patch.register as TranslationRegister) ? op.patch.register : undefined;
      if (!cur) {
        if (Object.keys(i18n.editions).length >= DOC_LIMITS.editions) return doc;
        return setEdition(doc, op.lang, { lang: op.lang, lines: {}, balloons: {}, register: register ?? 'everyday' });
      }
      return register && register !== cur.register ? setEdition(doc, op.lang, { ...cur, register }) : doc;
    }
    case 'translation': {
      const e = i18n.editions[op.lang];
      if (!e || !lineIdsOf(doc).has(op.lineId)) return doc;
      if (op.patch === null) {
        if (!(op.lineId in e.lines)) return doc;
        const lines = { ...e.lines };
        delete lines[op.lineId];
        return setEdition(doc, op.lang, { ...e, lines });
      }
      if (!isObject(op.patch)) return doc;
      const prev = e.lines[op.lineId];
      const merged: Record<string, unknown> = { ...(prev || {}) };
      for (const [k, v] of Object.entries(op.patch)) {
        if (v === null || v === undefined) delete merged[k];
        else merged[k] = v;
      }
      if (!prev && !(typeof merged.text === 'string' && typeof merged.status === 'string' && typeof merged.sourceHash === 'string' && typeof merged.at === 'number')) return doc;
      const t = normalizeTextTranslation(merged);
      if (!t) return doc;
      return setEdition(doc, op.lang, { ...e, lines: { ...e.lines, [op.lineId]: t } });
    }
    case 'translations': {
      const e = i18n.editions[op.lang];
      if (!e || !isObject(op.lines)) return doc;
      const ids = lineIdsOf(doc);
      const lines = { ...e.lines };
      let changed = false;
      for (const [id, raw] of Object.entries(op.lines)) {
        if (!ids.has(id)) continue;
        const t = normalizeTextTranslation(raw);
        if (!t) continue;
        lines[id] = t;
        changed = true;
      }
      return changed ? setEdition(doc, op.lang, { ...e, lines }) : doc;
    }
    case 'edition_text': {
      const e = i18n.editions[op.lang];
      const field = EDITION_FIELDS[op.field];
      if (!e || !field) return doc;
      const [group, key] = field;
      const cur = { ...((e[group] as Record<string, TextTranslation> | undefined) || {}) };
      if (op.value === null) {
        if (!(key in cur)) return doc;
        delete cur[key];
      } else {
        const t = normalizeTextTranslation(op.value);
        if (!t) return doc;
        cur[key] = t;
      }
      const next = { ...e } as LanguageEdition;
      if (Object.keys(cur).length) (next as unknown as Record<string, unknown>)[group] = cur;
      else delete next[group];
      return setEdition(doc, op.lang, next);
    }
    case 'edition_balloon': {
      const e = i18n.editions[op.lang];
      if (!e || !lineIdsOf(doc).has(op.lineId)) return doc;
      const balloons = { ...e.balloons };
      if (op.patch === null) {
        if (!(op.lineId in balloons)) return doc;
        delete balloons[op.lineId];
      } else {
        if (!isObject(op.patch)) return doc;
        const merged: Record<string, unknown> = { ...(balloons[op.lineId] || {}) };
        for (const [k, v] of Object.entries(op.patch)) {
          if (v === null || v === undefined) delete merged[k];
          else merged[k] = v;
        }
        const b = normalizeBalloonOverride(merged);
        if (b) balloons[op.lineId] = b;
        else delete balloons[op.lineId];
      }
      return setEdition(doc, op.lang, { ...e, balloons });
    }
    case 'glossary_term': {
      if (typeof op.id !== 'string' || !op.id) return doc;
      const idx = i18n.glossary.findIndex((t) => t.id === op.id);
      if (op.patch === null) {
        if (idx < 0) return doc;
        return { ...doc, i18n: { ...i18n, glossary: i18n.glossary.filter((t) => t.id !== op.id) } };
      }
      if (!isObject(op.patch)) return doc;
      const prev = idx >= 0 ? i18n.glossary[idx] : undefined;
      if (!prev && (typeof op.patch.term !== 'string' || !op.patch.term || i18n.glossary.length >= DOC_LIMITS.glossaryTerms)) return doc;
      const merged: Record<string, unknown> = { ...(prev || { kind: 'term', policy: 'transliterate', forms: {} }) };
      for (const [k, v] of Object.entries(op.patch)) {
        if (k === 'id') continue;
        if (k === 'forms' && isObject(v)) {
          const forms: Record<string, string> = { ...((merged.forms as Record<string, string>) || {}) };
          for (const [lang, form] of Object.entries(v)) {
            if (form === null || form === undefined) delete forms[lang];
            else if (typeof form === 'string') forms[lang] = form;
          }
          merged.forms = forms;
        } else if (v === null || v === undefined) delete merged[k];
        else merged[k] = v;
      }
      merged.id = op.id;
      const term = normalizeGlossaryTerm(merged);
      if (!term) return doc;
      const glossary = i18n.glossary.slice();
      if (idx >= 0) glossary[idx] = term;
      else glossary.push(term);
      return { ...doc, i18n: { ...i18n, glossary } };
    }
    default:
      return doc;
  }
};

const setStarred = <T extends { path: string; starred?: boolean }>(v: T, path: string, starred: boolean): T => {
  if (v.path !== path) return v;
  const next = { ...v };
  if (starred) next.starred = true;
  else delete next.starred;
  return next;
};

const applyVersionStar = (doc: ComicDoc, op: Extract<DocOp, { op: 'version_star' }>): ComicDoc => {
  if (typeof op.path !== 'string' || !op.path) return doc;
  let found = false;
  const render = (r: RenderState): RenderState => {
    if (!r.history.some((v) => v.path === op.path)) return r;
    found = true;
    return { ...r, history: r.history.map((v) => setStarred(v, op.path, !!op.starred)) };
  };
  const pages = doc.pages.map((p) => {
    const r = render(p.render);
    return r === p.render ? p : { ...p, render: r };
  });
  const coverRender = render(doc.cover.render);
  const cast = doc.cast.map((c) => {
    const r = render(c.sheet);
    return r === c.sheet ? c : { ...c, sheet: r };
  });
  const places = doc.places.map((p) => {
    const r = render(p.sheet);
    return r === p.sheet ? p : { ...p, sheet: r };
  });
  const options = doc.style.options.map((o) => {
    const r = render(o.render);
    return r === o.render ? o : { ...o, render: r };
  });
  const archive = archiveOf(doc);
  const archHit = archive.some((a) => a.path === op.path);
  if (!found && !archHit) return doc;
  const next: ComicDoc = {
    ...doc,
    pages,
    cover: coverRender === doc.cover.render ? doc.cover : { ...doc.cover, render: coverRender },
    cast,
    places,
    style: { ...doc.style, options }
  };
  if (archHit) next.archive = archive.map((a) => setStarred(a, op.path, !!op.starred));
  return next;
};

const applyAssetMeta = (doc: ComicDoc, op: Extract<DocOp, { op: 'asset_meta' }>): ComicDoc => {
  if (typeof op.path !== 'string' || !op.path || !isObject(op.patch)) return doc;
  const patch = op.patch;
  return mapAssetRefs(doc, (a) => {
    if (a.path !== op.path) return a;
    const next = { ...a };
    if ('safety' in patch && patch.safety !== undefined) {
      if (patch.safety === null) delete next.safety;
      else next.safety = patch.safety;
    }
    if ('variants' in patch && patch.variants !== undefined) {
      if (patch.variants === null) delete next.variants;
      else next.variants = patch.variants;
    }
    return next;
  });
};

// ── Ship 2: panels as objects (K2a; pro plan §5.3) ──────────────────────────
//
// Pure and deterministic (R5), tolerant (R6: a missing page/panel, a malformed payload or a broken cap returns the SAME
// doc). Payloads go through the doc.ts normalizers, so what an op writes is already normal and a reload never changes it.

const hasOwn = (o: unknown, k: string): boolean => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const setPage = (doc: ComicDoc, page: Page): ComicDoc => ({ ...doc, pages: doc.pages.map((p) => (p.id === page.id ? page : p)) });
const renumberPanels = (panels: Panel[]): Panel[] => panels.map((p, i) => (p.n === i + 1 ? p : { ...p, n: i + 1 }));

const PANEL_SIZES: readonly PanelSize[] = ['small', 'medium', 'large', 'wide', 'tall', 'splash'];
const SHOT_TYPES: readonly ShotType[] = ['establishing', 'wide', 'full', 'medium', 'close_up', 'extreme_close_up', 'over_shoulder', 'insert', 'pov'];
const LINE_KINDS: readonly LineKind[] = ['speech', 'thought', 'caption', 'sfx', 'whisper', 'shout'];

/** Page keys only their own ops change (page_frames, layer, continuity): the generic `page` op leaves them alone. */
const PAGE_OBJECT_KEYS = ['artMode', 'frameStyle', 'layers', 'continuity'] as const;

/** Extra picture sources a page's frames show besides its own drawing (EDITOR_LIMITS.sourcesPerPage). */
const extraSourceCount = (page: Page): number =>
  new Set(page.panels.map((p) => p.frame?.src?.path).filter((path): path is string => !!path && path !== page.render.asset?.path)).size;

/**
 * I5: a structural edit (panels_order, panel_add, panel_remove) of a page shown in frames re-stamps its drawing's
 * specHash — only when the page was fresh before (a stale page stays honestly stale), so an op followed by its inverse
 * restores the original hash. A page shown as drawn is never re-stamped: there the drawing really no longer matches.
 */
const restampIfFresh = (before: ComicDoc, after: ComicDoc, pageId: string): ComicDoc => {
  const pb = findPageById(before, pageId);
  const pa = findPageById(after, pageId);
  if (!pb || !pa || after === before) return after;
  const r = pb.render;
  if (r.status !== 'ready' || !r.specHash || r.specHash !== pageSpecHash(before, pb)) return after;
  if (artModeOf(pb) !== 'panels' && artModeOf(pa) !== 'panels') return after;
  const want = pageSpecHash(after, pa);
  return pa.render.specHash === want ? after : setPage(after, { ...pa, render: { ...pa.render, specHash: want } });
};

const moveX = (m: PointMap, x: number, w: number): number => clamp01(round4(m.x(x + w / 2) - w / 2));
const moveY = (m: PointMap, y: number): number => clamp01(round4(m.y(y)));
const movePt = (m: PointMap['x'], v: number): number => clamp01(round4(m(v)));

/** The cut of the drawing a frame shows (undefined for a frame with its own source): new cuts change what it shows. */
const rasterCutBox = (page: Page, panel: Panel): Box | undefined => (panel.frame?.src?.path ? undefined : cutFor(page, panel)?.box);

/**
 * I6: what sits on a panel follows it when its frame, the cut it shows, or the page's display changes from `beforeDoc`
 * to `afterDoc`: its balloons (anchored by their top-centre; width unchanged; locked ones stay; pinned flags
 * untouched), the overlays clipped to it (their boxes), and every edition's balloon overrides of its lines.
 */
const followFrames = (beforeDoc: ComicDoc, afterDoc: ComicDoc, pageId: string): ComicDoc => {
  const before = findPageById(beforeDoc, pageId);
  const after = findPageById(afterDoc, pageId);
  if (!before || !after) return afterDoc;
  const modeChanged = artModeOf(before) !== artModeOf(after);
  const maps = new Map<string, PointMap>();
  for (const panel of after.panels) {
    const prev = before.panels.find((p) => p.id === panel.id);
    if (!prev) continue;
    if (!modeChanged && sameJson(prev.frame, panel.frame) && sameJson(rasterCutBox(before, prev), rasterCutBox(after, panel))) continue;
    const m = panelPointMap(beforeDoc, before, afterDoc, after, panel.id);
    if (m) maps.set(panel.id, m);
  }
  if (!maps.size) return afterDoc;
  const panelOfLine = new Map<string, string>();
  for (const p of after.panels) for (const l of p.lines) panelOfLine.set(l.id, p.id);
  const mapFor = (lineId: string): PointMap | undefined => {
    const id = panelOfLine.get(lineId);
    return id ? maps.get(id) : undefined;
  };
  const base = new Map(after.balloons.map((b) => [b.lineId, b]));
  const balloons = after.balloons.map((b) => {
    const m = mapFor(b.lineId);
    if (!m || b.locked || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return b;
    const w = Number.isFinite(b.w) ? b.w : 0;
    const next: Balloon = { ...b, x: moveX(m, b.x, w), y: moveY(m, b.y) };
    if (typeof b.tailX === 'number' && Number.isFinite(b.tailX)) next.tailX = movePt(m.x, b.tailX);
    if (typeof b.tailY === 'number' && Number.isFinite(b.tailY)) next.tailY = movePt(m.y, b.tailY);
    return next;
  });
  const layers = after.layers?.map((l) => {
    const m = l.clip ? maps.get(l.clip) : undefined;
    if (!m) return l;
    const x0 = m.x(l.box.x);
    const x1 = m.x(l.box.x + l.box.w);
    const y0 = m.y(l.box.y);
    const y1 = m.y(l.box.y + l.box.h);
    const box = normalizeUnitBox({ x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }, PRO_PAGE_LIMITS.boxMin);
    return box && !sameJson(box, l.box) ? { ...l, box } : l;
  });
  let next = setPage(afterDoc, { ...after, balloons, ...(layers ? { layers } : {}) });
  const editions = i18nOf(next).editions;
  const touched = Object.values(editions).some((e) => Object.keys(e.balloons).some((id) => !!mapFor(id)));
  if (touched) {
    next = mapEditions(next, (e) => {
      let out = e.balloons;
      for (const [lineId, ov] of Object.entries(e.balloons)) {
        const m = mapFor(lineId);
        if (!m || base.get(lineId)?.locked) continue;
        const w = typeof ov.w === 'number' ? ov.w : base.get(lineId)?.w ?? 0;
        const moved: BalloonGeometryOverride = { ...ov };
        if (typeof ov.x === 'number') moved.x = moveX(m, ov.x, w);
        if (typeof ov.y === 'number') moved.y = moveY(m, ov.y);
        if (typeof ov.tailX === 'number') moved.tailX = movePt(m.x, ov.tailX);
        if (typeof ov.tailY === 'number') moved.tailY = movePt(m.y, ov.tailY);
        if (out === e.balloons) out = { ...e.balloons };
        out[lineId] = moved;
      }
      return out === e.balloons ? e : { ...e, balloons: out };
    });
  }
  return next;
};

const applyPageFrames = (doc: ComicDoc, op: Extract<DocOp, { op: 'page_frames' }>): ComicDoc => {
  const page = findPageById(doc, op.pageId);
  if (!page) return doc;
  let next: Page = page;
  // A key present with undefined clears like null (the wire turns undefined into null: client and server agree).
  if (hasOwn(op, 'artMode')) {
    if (op.artMode === 'panels') {
      if (next.artMode !== 'panels') next = { ...next, artMode: 'panels' };
    } else if (next.artMode !== undefined) {
      next = { ...next };
      delete next.artMode;
    }
  }
  if (hasOwn(op, 'frameStyle')) {
    if (op.frameStyle === null || op.frameStyle === undefined) {
      if (next.frameStyle !== undefined) {
        next = { ...next };
        delete next.frameStyle;
      }
    } else {
      const style = normalizeFrameStyle(op.frameStyle);
      if (!style) return doc;
      if (!sameJson(style, next.frameStyle)) next = { ...next, frameStyle: style };
    }
  }
  if (op.frames !== undefined) {
    if (!Array.isArray(op.frames)) return doc;
    const wanted = new Map<string, PanelFrame | null>();
    for (const f of op.frames) {
      if (!isObject(f) || typeof f.panelId !== 'string') continue;
      if (f.frame === null || f.frame === undefined) wanted.set(f.panelId, null);
      else {
        const frame = normalizePanelFrame(f.frame);
        if (frame) wanted.set(f.panelId, frame);
      }
    }
    let changed = false;
    const panels = next.panels.map((p) => {
      if (!wanted.has(p.id)) return p;
      const frame = wanted.get(p.id);
      if (frame === null) {
        if (p.frame === undefined) return p;
        changed = true;
        const out = { ...p };
        delete out.frame;
        return out;
      }
      if (sameJson(frame, p.frame)) return p;
      changed = true;
      return { ...p, frame: frame! };
    });
    if (changed) next = { ...next, panels };
  }
  if (next === page || extraSourceCount(next) > EDITOR_LIMITS.sourcesPerPage) return doc;
  const out = setPage(doc, next);
  return op.moveBalloons === false ? out : followFrames(doc, out, page.id);
};

const applyPageCuts = (doc: ComicDoc, op: Extract<DocOp, { op: 'page_cuts' }>): ComicDoc => {
  const page = findPageById(doc, op.pageId);
  // Path-guarded: cuts never land on another drawing (a redraw raced the edit).
  if (!page || typeof op.path !== 'string' || !op.path || page.render.asset?.path !== op.path) return doc;
  let out: ComicDoc;
  if (op.cuts === null || op.cuts === undefined) {
    if (page.render.cuts === undefined) return doc;
    const render = { ...page.render };
    delete render.cuts;
    out = setPage(doc, { ...page, render });
  } else {
    const cuts = normalizePanelCuts(op.cuts);
    if (!cuts) return doc;
    const value: PanelCuts = { ...cuts, by: op.keepBy === true ? cuts.by : 'user' };
    if (sameJson(value, page.render.cuts)) return doc;
    out = setPage(doc, { ...page, render: { ...page.render, cuts: value } });
  }
  // New cuts can change what a frame shows or how the page is shown (I2): its lettering follows, as for page_frames (I6).
  return op.moveBalloons === false ? out : followFrames(doc, out, page.id);
};

const applyPanelsOrder = (doc: ComicDoc, op: Extract<DocOp, { op: 'panels_order' }>): ComicDoc => {
  const page = findPageById(doc, op.pageId);
  if (!page || !Array.isArray(op.order)) return doc;
  const byId = new Map(page.panels.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const ordered: Panel[] = [];
  for (const id of op.order) {
    const p = typeof id === 'string' ? byId.get(id) : undefined;
    if (p && !seen.has(id)) {
      seen.add(id);
      ordered.push(p);
    }
  }
  for (const p of page.panels) if (!seen.has(p.id)) ordered.push(p);
  if (ordered.every((p, i) => p === page.panels[i])) return doc;
  return restampIfFresh(doc, setPage(doc, { ...page, panels: renumberPanels(ordered) }), page.id);
};

const applyPanelAdd = (doc: ComicDoc, op: Extract<DocOp, { op: 'panel_add' }>): ComicDoc => {
  const page = findPageById(doc, op.pageId);
  const raw = op.panel as unknown;
  if (!page || !isObject(raw) || typeof raw.id !== 'string' || !SAFE_ID_RE.test(raw.id)) return doc;
  if (page.panels.some((p) => p.id === raw.id) || page.panels.length >= DOC_LIMITS.panelsPerPage) return doc;
  const rawLines = Array.isArray(raw.lines) ? raw.lines : [];
  if (rawLines.length > DOC_LIMITS.linesPerPanel) return doc;
  const onPage = new Map<string, Line>();
  for (const panel of page.panels) for (const l of panel.lines) onPage.set(l.id, l);
  const everywhere = lineIdsOf(doc);
  const lines: Line[] = [];
  const moved = new Set<string>();
  for (const l of rawLines) {
    if (!isObject(l) || typeof l.id !== 'string' || !SAFE_ID_RE.test(l.id) || lines.some((x) => x.id === l.id)) return doc;
    const own = onPage.get(l.id);
    if (own) {
      lines.push(own);
      moved.add(l.id);
      continue;
    }
    if (everywhere.has(l.id)) return doc; // a line of another page
    const created: Line = {
      id: l.id,
      kind: LINE_KINDS.includes(l.kind as LineKind) ? (l.kind as LineKind) : 'speech',
      text: typeof l.text === 'string' ? l.text : ''
    };
    if (typeof l.speakerId === 'string' && l.speakerId) created.speakerId = l.speakerId;
    // The line's own overlay style and language travel with it (the undo of a removal re-creates it exactly).
    if (isObject(l.style)) created.style = l.style as LetterStylePatch;
    if (typeof l.lang === 'string' && l.lang) created.lang = l.lang;
    if (l.noTranslate === true) created.noTranslate = true;
    lines.push(created);
  }
  const panel: Panel = {
    id: raw.id,
    n: 0,
    size: PANEL_SIZES.includes(raw.size as PanelSize) ? (raw.size as PanelSize) : 'medium',
    shot: SHOT_TYPES.includes(raw.shot as ShotType) ? (raw.shot as ShotType) : 'medium',
    action: typeof raw.action === 'string' ? raw.action : '',
    castIds: Array.isArray(raw.castIds) ? raw.castIds.filter((c): c is string => typeof c === 'string' && !!c) : [],
    lines
  };
  if (typeof raw.angle === 'string' && raw.angle) panel.angle = raw.angle;
  if (typeof raw.placeId === 'string' && raw.placeId) panel.placeId = raw.placeId;
  if (typeof raw.mood === 'string' && raw.mood) panel.mood = raw.mood;
  // A panel without a frame is allowed on any page: on a page shown in frames it drops the display back to "as drawn"
  // (I2, artModeOf). It is how undo brings back a removed frameless panel (I5/I7); the editor gives a panel it adds in
  // panels mode a frame.
  const frame = raw.frame === undefined ? undefined : normalizePanelFrame(raw.frame);
  if (frame) panel.frame = frame;
  const direction = raw.direction === undefined ? undefined : normalizePanelDirection(raw.direction);
  if (direction) panel.direction = direction;
  const panels = page.panels.map((p) => (moved.size && p.lines.some((l) => moved.has(l.id)) ? { ...p, lines: p.lines.filter((l) => !moved.has(l.id)) } : p));
  panels.splice(clampInt(op.index ?? panels.length, 0, panels.length, panels.length), 0, panel);
  const nextPage: Page = { ...page, panels: renumberPanels(panels) };
  if (extraSourceCount(nextPage) > EDITOR_LIMITS.sourcesPerPage) return doc;
  return restampIfFresh(doc, setPage(doc, nextPage), page.id);
};

const applyPanelRemove = (doc: ComicDoc, op: Extract<DocOp, { op: 'panel_remove' }>): ComicDoc => {
  const page = findPageById(doc, op.pageId);
  const removed = page?.panels.find((p) => p.id === op.id);
  if (!page || !removed) return doc;
  const hasTarget = op.linesTo !== undefined && op.linesTo !== null;
  const target = hasTarget ? page.panels.find((p) => p.id === op.linesTo && p.id !== op.id) : undefined;
  if (hasTarget && !target) return doc;
  const homes = op.lineHomes === undefined || op.lineHomes === null ? [] : op.lineHomes;
  if (!Array.isArray(homes)) return doc;
  const homed = new Set<string>();
  for (const h of homes) {
    const ok =
      isObject(h) &&
      typeof h.lineId === 'string' &&
      typeof h.panelId === 'string' &&
      h.panelId !== op.id &&
      !homed.has(h.lineId) &&
      removed.lines.some((l) => l.id === h.lineId) &&
      page.panels.some((p) => p.id === h.panelId);
    if (!ok) return doc;
    homed.add(h.lineId);
  }
  let panels = page.panels.filter((p) => p.id !== op.id);
  for (const h of homes) {
    const line = removed.lines.find((l) => l.id === h.lineId)!;
    panels = panels.map((p) => (p.id === h.panelId ? { ...p, lines: insertAt(p.lines, line, h.index) } : p));
  }
  const rest = removed.lines.filter((l) => !homed.has(l.id));
  if (target && rest.length) panels = panels.map((p) => (p.id === target.id ? { ...p, lines: [...p.lines, ...rest] } : p));
  if (panels.some((p) => p.lines.length > DOC_LIMITS.linesPerPanel)) return doc;
  const deleted = target ? new Set<string>() : new Set(rest.map((l) => l.id));
  const nextPage: Page = { ...page, panels: renumberPanels(panels) };
  if (deleted.size) nextPage.balloons = page.balloons.filter((b) => !deleted.has(b.lineId));
  if (page.layers?.some((l) => l.clip === op.id)) {
    nextPage.layers = page.layers.map((l) => {
      if (l.clip !== op.id) return l;
      const out = { ...l };
      delete out.clip;
      return out;
    });
  }
  let next = setPage(doc, nextPage);
  for (const id of deleted) next = pruneLineFromEditions(next, id);
  return restampIfFresh(doc, next, page.id);
};

const applyLayer = (doc: ComicDoc, op: Extract<DocOp, { op: 'layer' }>): ComicDoc => {
  const page = findPageById(doc, op.pageId);
  if (!page || typeof op.id !== 'string' || !LAYER_ID_RE.test(op.id)) return doc;
  const layers = page.layers ?? [];
  const idx = layers.findIndex((l) => l.id === op.id);
  if (op.patch === null || op.patch === undefined) {
    if (idx < 0) return doc;
    const rest = layers.filter((_, i) => i !== idx);
    const nextPage: Page = { ...page };
    if (rest.length) nextPage.layers = rest;
    else delete nextPage.layers;
    return setPage(doc, nextPage);
  }
  if (!isObject(op.patch)) return doc;
  if (idx < 0 && layers.length >= EDITOR_LIMITS.layersPerPage) return doc;
  const merged: Record<string, unknown> = { ...(idx >= 0 ? layers[idx] : {}) };
  for (const [k, v] of Object.entries(op.patch)) {
    if (k === 'id') continue;
    if (v === null || v === undefined) delete merged[k];
    else merged[k] = v;
  }
  merged.id = op.id;
  const layer = normalizePageLayer(merged);
  if (!layer || (idx >= 0 && sameJson(layer, layers[idx]))) return doc;
  const next = layers.slice();
  if (idx >= 0) next[idx] = layer;
  else next.splice(clampInt(op.index ?? next.length, 0, next.length, next.length), 0, layer);
  return setPage(doc, { ...page, layers: next });
};

/** Shallow merge where null/undefined clears a key; the result through `normalize` (undefined = nothing left). */
const mergedThrough = <T>(prev: object | undefined, patch: Record<string, unknown>, normalize: (raw: unknown) => T | undefined, skip: readonly string[] = []): T | undefined => {
  const merged: Record<string, unknown> = { ...((prev || {}) as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (skip.includes(k)) continue;
    if (v === null || v === undefined) delete merged[k];
    else merged[k] = v;
  }
  return normalize(merged);
};

const applyContinuity = (doc: ComicDoc, op: Extract<DocOp, { op: 'continuity' }>): ComicDoc => {
  const page = findPageById(doc, op.pageId);
  if (!page) return doc;
  let value: PageContinuity | undefined;
  if (op.patch === null || op.patch === undefined) value = undefined;
  else if (!isObject(op.patch)) return doc;
  else value = mergedThrough(page.continuity, op.patch, normalizePageContinuity);
  if (sameJson(value, page.continuity)) return doc;
  const nextPage: Page = { ...page };
  if (value) nextPage.continuity = value;
  else delete nextPage.continuity;
  return setPage(doc, nextPage);
};

const applyScene = (doc: ComicDoc, op: Extract<DocOp, { op: 'scene' }>): ComicDoc => {
  if (typeof op.id !== 'string' || !SAFE_ID_RE.test(op.id)) return doc;
  const scenes = doc.scenes ?? [];
  const idx = scenes.findIndex((s) => s.id === op.id);
  let next: Scene[];
  if (op.patch === null || op.patch === undefined) {
    if (idx < 0) return doc;
    next = scenes.filter((_, i) => i !== idx);
  } else {
    if (!isObject(op.patch)) return doc;
    if (idx < 0 && scenes.length >= CONSISTENCY_LIMITS.scenes) return doc;
    const scene = mergedThrough({ ...(idx >= 0 ? scenes[idx] : {}), id: op.id }, op.patch, normalizeScene, ['id']);
    if (!scene || (idx >= 0 && sameJson(scene, scenes[idx]))) return doc;
    next = scenes.slice();
    if (idx >= 0) next[idx] = scene;
    else next.splice(clampInt(op.index ?? next.length, 0, next.length, next.length), 0, scene);
  }
  const out: ComicDoc = { ...doc };
  if (next.length) out.scenes = next;
  else delete out.scenes;
  return out;
};

const applyConsistency = (doc: ComicDoc, op: Extract<DocOp, { op: 'consistency' }>): ComicDoc => {
  if (!isObject(op.patch)) return doc;
  const value: ConsistencySettings | undefined = mergedThrough(doc.consistency, op.patch, normalizeConsistencySettings);
  if (sameJson(value, doc.consistency)) return doc;
  const out: ComicDoc = { ...doc };
  if (value) out.consistency = value;
  else delete out.consistency;
  return out;
};

const applyFinding = (doc: ComicDoc, op: Extract<DocOp, { op: 'finding' }>): ComicDoc => {
  const page = findPageById(doc, op.pageId);
  const qc = page?.render.qc;
  const findings = qc?.findings;
  if (!page || !qc || !Array.isArray(findings) || !isObject(op.patch)) return doc;
  const idx = findings.findIndex((f) => f.id === op.id);
  if (idx < 0) return doc;
  const dismissed = op.patch.dismissed === true;
  if (!!findings[idx].dismissed === dismissed) return doc;
  const finding = { ...findings[idx] };
  if (dismissed) finding.dismissed = true;
  else delete finding.dismissed;
  const next = findings.slice();
  next[idx] = finding;
  return setPage(doc, { ...page, render: { ...page.render, qc: { ...qc, findings: next } } });
};

/** A `panel` patch merged: a frame moves only through page_frames (so its lettering follows); direction is normalized
 *  (null clears it). Other keys merge exactly as before. */
const mergePanelPatch = (panel: Panel, patch: Partial<Omit<Panel, 'lines'>>): Panel => {
  const merged = { ...panel, ...patch } as Panel;
  if (!isObject(patch) || (!('frame' in patch) && !('direction' in patch))) return merged;
  if ('frame' in patch) {
    if (panel.frame === undefined) delete merged.frame;
    else merged.frame = panel.frame;
  }
  if ('direction' in patch) {
    const direction = normalizePanelDirection(patch.direction);
    if (direction) merged.direction = direction;
    else delete merged.direction;
  }
  return merged;
};

/** A `page` patch without the keys their own ops own (frames, overlays, continuity). Same object when it has none. */
const pagePatchOf = (patch: Partial<Omit<Page, 'panels' | 'render' | 'balloons'>>): Partial<Omit<Page, 'panels' | 'render' | 'balloons'>> => {
  if (!isObject(patch) || !PAGE_OBJECT_KEYS.some((k) => k in patch)) return patch;
  const out = { ...patch };
  for (const k of PAGE_OBJECT_KEYS) delete out[k];
  return out;
};

/** page_duplicate: the copy's panel ids are new, so what names a panel (overlay clips, cuts, parts) follows them. */
const remapPanelIds = (page: Page, ids: Map<string, string>): Page => {
  let out = page;
  if (page.layers?.some((l) => l.clip && ids.has(l.clip))) {
    out = { ...out, layers: page.layers.map((l) => (l.clip && ids.has(l.clip) ? { ...l, clip: ids.get(l.clip)! } : l)) };
  }
  const cuts = page.render.cuts;
  const parts = page.render.parts;
  if (cuts?.cuts.some((c) => c.panelId && ids.has(c.panelId)) || (parts?.panels && Object.keys(parts.panels).some((k) => ids.has(k)))) {
    const render: RenderState = { ...out.render };
    if (cuts) render.cuts = { ...cuts, cuts: cuts.cuts.map((c) => (c.panelId && ids.has(c.panelId) ? { ...c, panelId: ids.get(c.panelId)! } : c)) };
    if (parts?.panels) render.parts = { ...parts, panels: Object.fromEntries(Object.entries(parts.panels).map(([k, v]) => [ids.get(k) ?? k, v])) };
    out = { ...out, render };
  }
  return out;
};

// ── Pure application ─────────────────────────────────────────────────────────

export const applyOp = (doc: ComicDoc, op: DocOp): ComicDoc => {
  if (!op || typeof op !== 'object') return doc;
  switch (op.op) {
    case 'brief':
      return { ...doc, brief: { ...doc.brief, ...op.patch, notes: op.patch.notes || doc.brief.notes } };
    case 'note_add': {
      const text = op.text.trim();
      if (!text || doc.brief.notes.includes(text)) return doc;
      return { ...doc, brief: { ...doc.brief, notes: [...doc.brief.notes, text].slice(-40) } };
    }
    case 'format':
      return { ...doc, format: { ...doc.format, ...op.patch } };
    case 'settings':
      return { ...doc, settings: { ...doc.settings, ...op.patch } };
    case 'source':
      return { ...doc, source: { ...doc.source, ...op.patch } };
    case 'style':
      return { ...doc, style: { ...doc.style, ...op.patch, options: doc.style.options } };
    case 'style_option': {
      const existing = doc.style.options.find((o) => o.id === op.id);
      if (!existing) {
        const option: StyleOption = { id: op.id, name: op.patch.name || 'Style', spec: op.patch.spec || '', render: op.patch.render || emptyRender() };
        return { ...doc, style: { ...doc.style, options: [...doc.style.options, option] } };
      }
      const { render: renderPatch, ...rest } = op.patch;
      const next: ComicDoc = {
        ...doc,
        style: { ...doc.style, options: doc.style.options.map((o) => (o.id === op.id ? { ...o, ...rest, render: o.render } : o)) }
      };
      return renderPatch ? applyRenderPatch(next, { kind: 'style_option', id: op.id }, renderPatch) : next;
    }
    case 'style_options_clear':
      return { ...doc, style: { ...doc.style, options: [] } };
    case 'character': {
      const exists = doc.cast.some((c) => c.id === op.id);
      if (!exists) return { ...doc, cast: insertAt(doc.cast, newCharacter(op.id, op.patch), op.index) };
      const { sheet: sheetPatch, ...rest } = op.patch;
      const next: ComicDoc = {
        ...doc,
        cast: doc.cast.map((c) =>
          c.id === op.id ? clearedCharacter({ ...c, ...rest, look: op.patch.look ? mergedLook(c.look, op.patch.look) : c.look, sheet: c.sheet }) : c
        )
      };
      return sheetPatch ? applyRenderPatch(next, { kind: 'sheet', id: op.id }, sheetPatch) : next;
    }
    case 'character_remove':
      return {
        ...doc,
        cast: doc.cast.filter((c) => c.id !== op.id),
        pages: doc.pages.map((p) => ({
          ...p,
          panels: p.panels.map((panel) => ({ ...panel, castIds: panel.castIds.filter((id) => id !== op.id) }))
        }))
      };
    case 'place': {
      const exists = doc.places.some((p) => p.id === op.id);
      if (!exists) {
        const place: Place = {
          ...op.patch,
          id: op.id,
          name: op.patch.name || 'Place',
          look: op.patch.look || '',
          refs: op.patch.refs || [],
          sheet: op.patch.sheet || emptyRender()
        };
        return { ...doc, places: insertAt(doc.places, place, op.index) };
      }
      const { sheet: sheetPatch, ...rest } = op.patch;
      const next: ComicDoc = { ...doc, places: doc.places.map((p) => (p.id === op.id ? { ...p, ...rest, sheet: p.sheet } : p)) };
      return sheetPatch ? applyRenderPatch(next, { kind: 'place', id: op.id }, sheetPatch) : next;
    }
    case 'place_remove':
      return {
        ...doc,
        places: doc.places.filter((p) => p.id !== op.id),
        pages: doc.pages.map((p) => ({
          ...p,
          panels: p.panels.map((panel) => (panel.placeId === op.id ? { ...panel, placeId: undefined } : panel))
        }))
      };
    case 'pages':
      return {
        ...doc,
        pages: op.pages
          .slice()
          .sort((a, b) => a.n - b.n)
          .map((p, i) => ({ ...p, n: i + 1 }))
      };
    case 'page': {
      const patch = pagePatchOf(op.patch); // Ship 2: frames, overlays and continuity have their own ops
      return { ...doc, pages: mapPage(doc, op.id, (p) => ({ ...p, ...patch })) };
    }
    case 'page_panels':
      return {
        ...doc,
        pages: mapPage(doc, op.id, (p) => ({ ...p, panels: op.panels.map((panel, i) => ({ ...panel, n: i + 1 })) }))
      };
    case 'panel':
      return {
        ...doc,
        pages: mapPage(doc, op.pageId, (p) => mapPanel(p, op.id, (panel) => mergePanelPatch(panel, op.patch)))
      };
    case 'line':
      return applyLine(doc, op);
    case 'line_move':
      return applyLineMove(doc, op);
    case 'balloons':
      return { ...doc, pages: mapPage(doc, op.pageId, (p) => ({ ...p, balloons: op.balloons })) };
    case 'balloon':
      return {
        ...doc,
        pages: mapPage(doc, op.pageId, (p) => {
          const exists = p.balloons.some((b) => b.lineId === op.lineId);
          const lock = op.patch.locked === true ? { pinned: true } : {};
          // Ship 2: rot / minH are clamped, and null clears them (only when the patch carries one).
          const ship2 = isObject(op.patch) && ('rot' in op.patch || 'minH' in op.patch);
          const merged = (b: Balloon): Balloon => (ship2 ? normalizeBalloonShip2(b) : b);
          const balloons = exists
            ? p.balloons.map((b) => (b.lineId === op.lineId ? merged({ ...b, ...op.patch, ...lock }) : b))
            : [...p.balloons, merged({ lineId: op.lineId, x: 0.1, y: 0.1, w: 0.28, ...op.patch, ...lock })];
          return { ...p, balloons };
        })
      };
    case 'render':
      return applyRenderPatch(doc, op.target, op.patch);
    case 'cover':
      return { ...doc, cover: { ...doc.cover, ...op.patch, render: doc.cover.render } };
    case 'plan_status':
      return { ...doc, planStatus: op.status };
    case 'message': {
      const exists = doc.conversation.some((m) => m.id === op.msg.id);
      const conversation = exists
        ? doc.conversation.map((m) => (m.id === op.msg.id ? op.msg : m))
        : [...doc.conversation, op.msg];
      return { ...doc, conversation: conversation.slice(-MAX_CONVERSATION) };
    }
    case 'message_patch':
      return {
        ...doc,
        conversation: doc.conversation.map((m) => (m.id === op.id ? { ...m, ...op.patch } : m))
      };
    case 'spend': {
      const usd = Number.isFinite(op.entry.usd) ? Math.max(0, op.entry.usd) : 0;
      const byKind = { ...doc.spend.byKind, [op.entry.kind]: round4((doc.spend.byKind[op.entry.kind] || 0) + usd) };
      const saved = Number.isFinite(op.entry.savedUsd) && (op.entry.savedUsd as number) > 0 ? (op.entry.savedUsd as number) : 0;
      const entry: SpendEntry = { ...op.entry, usd };
      const prior = spendTotalsOf(doc.spend);
      return {
        ...doc,
        spend: {
          ...doc.spend,
          totalUsd: round4(doc.spend.totalUsd + usd),
          byKind,
          entries: [entry, ...doc.spend.entries].slice(0, MAX_SPEND_ENTRIES),
          ...(saved ? { savedUsd: round4((doc.spend.savedUsd ?? 0) + saved) } : {}),
          ...totalsPatch(prior ? addSpendTotals(prior, entry) : null)
        }
      };
    }
    case 'gate':
      return { ...doc, gate: op.gate };
    case 'memory':
      return { ...doc, memory: op.text };

    // ── v5 ──
    case 'letter_style':
      return applyLetterStyle(doc, op.patch);
    case 'line_style':
      return applyLineStyle(doc, op);
    case 'pages_reorder': {
      if (!Array.isArray(op.order)) return doc;
      const byId = new Map(doc.pages.map((p) => [p.id, p]));
      const seen = new Set<string>();
      const ordered: Page[] = [];
      for (const id of op.order) {
        const p = byId.get(id);
        if (p && !seen.has(id)) {
          seen.add(id);
          ordered.push(p);
        }
      }
      for (const p of doc.pages) if (!seen.has(p.id)) ordered.push(p);
      return withPages(doc, ordered);
    }
    case 'page_insert': {
      if (typeof op.id !== 'string' || !op.id || findPageById(doc, op.id) || doc.pages.length >= DOC_LIMITS.pages) return doc;
      const patch = isObject(op.patch) ? op.patch : {};
      const page: Page = {
        id: op.id,
        n: 0,
        summary: typeof patch.summary === 'string' ? patch.summary : '',
        layout: typeof patch.layout === 'string' ? patch.layout : '',
        panels: [],
        render: emptyRender(),
        balloons: []
      };
      if (typeof patch.chapterTitle === 'string' && patch.chapterTitle.trim()) {
        page.chapterTitle = patch.chapterTitle.trim().slice(0, DOC_LIMITS.chapterTitleChars);
      }
      const pages = doc.pages.slice();
      pages.splice(clampInt(op.after, 0, pages.length, pages.length), 0, page);
      return withPages(doc, pages);
    }
    case 'page_duplicate':
      return applyPageDuplicate(doc, op);
    case 'page_delete':
      return applyPageDelete(doc, op);
    case 'page_restore': {
      const trash = trashOf(doc);
      const idx = trash.findIndex((t) => t.page.id === op.id);
      if (idx < 0 || doc.pages.length >= DOC_LIMITS.pages || findPageById(doc, op.id)) return doc;
      const entry = trash[idx];
      const pages = doc.pages.slice();
      const at = clampInt(op.n ?? entry.fromN, 1, pages.length + 1, pages.length + 1);
      pages.splice(at - 1, 0, entry.page);
      return { ...withPages(doc, pages), trash: trash.filter((_, i) => i !== idx) };
    }
    case 'book':
      return isObject(op.patch) ? { ...doc, book: pickBook({ ...bookOf(doc), ...op.patch }) } : doc;
    case 'reader':
      return isObject(op.patch) ? { ...doc, reader: pickReader({ ...readerOf(doc), ...op.patch }) } : doc;
    case 'render_use':
      return applyRenderUse(doc, op);
    case 'version_star':
      return applyVersionStar(doc, op);
    case 'asset_meta':
      return applyAssetMeta(doc, op);
    case 'ref_add':
    case 'ref_patch':
    case 'ref_move':
    case 'ref_remove':
    case 'ref_transfer':
      return applyRefOp(doc, op);
    case 'edition':
    case 'translation':
    case 'translations':
    case 'edition_text':
    case 'edition_balloon':
    case 'glossary_term':
      return applyI18nOp(doc, op);
    case 'safety': {
      if (!isObject(op.patch)) return doc;
      const safety: Record<string, unknown> = { ...(doc.safety || {}) };
      for (const [k, v] of Object.entries(op.patch)) {
        if (v === undefined) continue;
        if (v === null) delete safety[k];
        else safety[k] = v;
      }
      return { ...doc, safety: safety as DocSafety };
    }
    case 'publication': {
      if (op.value === null) {
        if (doc.publication === undefined) return doc;
        const next = { ...doc };
        delete next.publication;
        return next;
      }
      return isPublicationMirror(op.value) ? { ...doc, publication: op.value } : doc;
    }
    case 'image_model': {
      const lock = normalizeImageModelLock(op.lock);
      return lock ? { ...doc, imageModel: lock } : doc;
    }
    // --- history ---
    case 'history_restore':
      return applyHistoryRestore(doc, op, RESTORE_KERNEL);
    // --- Ship 2 (K2a) ---
    case 'page_frames':
      return applyPageFrames(doc, op);
    case 'page_cuts':
      return applyPageCuts(doc, op);
    case 'panels_order':
      return applyPanelsOrder(doc, op);
    case 'panel_add':
      return applyPanelAdd(doc, op);
    case 'panel_remove':
      return applyPanelRemove(doc, op);
    case 'layer':
      return applyLayer(doc, op);
    case 'continuity':
      return applyContinuity(doc, op);
    case 'scene':
      return applyScene(doc, op);
    case 'consistency':
      return applyConsistency(doc, op);
    case 'finding':
      return applyFinding(doc, op);
    case 'plan_input_hash': {
      if (op.hash === null) {
        if (doc.planInputHash === undefined) return doc;
        const next = { ...doc };
        delete next.planInputHash;
        return next;
      }
      if (typeof op.hash !== 'string' || !op.hash || op.hash.length > PLAN_INPUT_HASH_MAX || op.hash === doc.planInputHash) return doc;
      return { ...doc, planInputHash: op.hash };
    }
    default:
      return doc;
  }
};

export const applyOps = (doc: ComicDoc, ops: DocOp[], now = Date.now()): ComicDoc => {
  if (!ops.length) return doc;
  const next = ops.reduce(applyOp, doc);
  return { ...next, updatedAt: now };
};

/** Clamp a balloon patch's geometry to the page (0..1). Shared by client builders and the server sanitizer. */
export const clampBalloonPatch = (patch: Partial<Balloon>): Partial<Balloon> => {
  const out: Partial<Balloon> = { ...patch };
  for (const k of ['x', 'y', 'w', 'tailX', 'tailY'] as const) {
    const v = out[k];
    if (typeof v === 'number') out[k] = Number.isFinite(v) ? clamp01(v) : undefined;
  }
  if (typeof out.z === 'number') out.z = clampInt(out.z, -100, 100, 0);
  // --- Ship 2 (K2a): rotation ±EDITOR_LIMITS.balloonRot, minimum height in (0, EDITOR_LIMITS.minHMax] ---
  if (typeof out.rot === 'number') out.rot = Number.isFinite(out.rot) ? Math.min(EDITOR_LIMITS.balloonRot, Math.max(-EDITOR_LIMITS.balloonRot, out.rot)) : undefined;
  if (typeof out.minH === 'number') out.minH = Number.isFinite(out.minH) && out.minH > 0 ? Math.min(EDITOR_LIMITS.minHMax, out.minH) : undefined;
  return out;
};

// ── The free "Use the layout that fits" fix (plan §4.1; decision PD-1) ──────
//
// A re-chosen blueprint is applied the way the writer's validator applies it (server writer.ts fitPage): the panel
// sizes are harmonized to the blueprint first. A layout alone is not enough: the page prompt (effectiveLayout)
// rejects a blueprint whose panel sizes contradict it (a "wide" panel in a shared row) and draws a layout synthesized
// from the sizes instead — the old, overfull one. The size rules are shared/comic/pageGeometry.ts harmonizePanelSizes
// and layoutConflicts: one implementation with the prompt and the writer (jobs.ship1.test.ts pins the parity over
// every candidate blueprint).

const cleanLayout = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');

/**
 * The ops that put a page on `layout` so it is DRAWN on that blueprint: the page's layout plus a size patch for every
 * panel whose size contradicted it. One implementation for the server's held-back notice chip, the next-step chip and
 * the breakdown card's "Use the layout that fits" (summarizeBook planFit.layoutFix). Pure; [] when the blueprint
 * cannot be drawn as given (it does not parse, has another panel count, or is not a vertical stack on a webtoon).
 * The caller still checks the fitted page (pagePlanCheck) before offering it: the fix is a fix only when it fits.
 */
export const layoutFixOps = (doc: Pick<ComicDoc, 'format'>, page: Pick<Page, 'id' | 'panels'>, layout: string): DocOp[] => {
  const text = cleanLayout(layout);
  const parsed = text ? parseLayout(text) : null;
  if (!parsed || layoutPanelCount(parsed) !== page.panels.length) return [];
  if (doc.format.kind === 'webtoon' && parsed.mode !== 'stack') return [];
  const harmonized = harmonizePanelSizes(page.panels, parsed, doc.format.readingDirection === 'rtl');
  if (layoutConflicts(parsed, harmonized)) return [];
  const resized: DocOp[] = page.panels.flatMap((p, i): DocOp[] =>
    harmonized[i].size !== p.size ? [{ op: 'panel', pageId: page.id, id: p.id, patch: { size: harmonized[i].size } }] : []
  );
  return [{ op: 'page', id: page.id, patch: { layout: text } }, ...resized];
};
