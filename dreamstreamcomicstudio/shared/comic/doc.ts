// ComicDoc — the single source of truth for a Comic Studio (v4/v5) project.
//
// The conversational studio is built around ONE structured document that the
// server-side Comic Director keeps up to date as the user talks ("sticking the
// idea"). Every image the studio renders is COMPILED from this document — the
// chat transcript is never the source of truth. The client mirrors the doc and
// applies the same DocOps the server emits (shared/comic/ops.ts), so both sides
// stay in lockstep without re-sending the whole document.
//
// Rules for this file (contract §0):
//  - Dependency-free (shared by the Node server and the Vite client).
//  - Every field added later must be OPTIONAL or defaulted in normalizeDoc(), so
//    stored documents keep loading (R1). Every new top-level field is assigned
//    explicitly in normalizeDoc with its OLD-doc default (R3).
//  - pageSpecHash output for existing docs never changes (R2).
//  - Images are referenced by storage path (AssetRef.path), never inlined as base64.
//  - New optional top-level fields are read only through accessors (R9).

import type { LetteringStyle, LetterStylePatch } from './lettering/style.js';
import type { AssessedRating, ContentRating, SafetyCategory, SafetyStatus, SafetyVerdict } from './safety.js';
import type { PublishRequest, PublicationMirror } from './publication.js';
import type { StudioMode } from './capabilities.js';
import { DEFAULT_LETTERING, sanitizeLetteringStyle, sanitizeLetterStylePatch } from './lettering/style.js';
import { normalizeI18n } from './i18n.js';
import { isPublicationMirror } from './publication.js';
import { hashString, stableStringify } from './hash.js';
import { CONSISTENCY_LIMITS, DOC_LIMITS, EDITOR_LIMITS, PRO_PAGE_LIMITS } from './limits.js';
import { normalizeOutageOption, type OutageOption } from './modelHealth.js';
// --- history (versions plan §3.3; H0): type-only, so doc.ts stays the dependency root ---
import type { HistoryCard } from './history/types.js';
export { hashString, stableStringify } from './hash.js';
export { MAX_RENDER_HISTORY, MAX_SPEND_ENTRIES, MAX_CONVERSATION, MAX_ARCHIVE, MAX_TRASH } from './limits.js';

export const COMIC_DOC_VERSION = 1;

/** Page/frame aspect ratios the studio understands (superset; each model supports a subset). */
export type AspectRatio =
  | '1:1' | '2:3' | '3:2' | '3:4' | '4:3' | '4:5' | '5:4'
  | '9:16' | '16:9' | '21:9' | '1:4' | '4:1' | '1:8' | '8:1';

export type Resolution = '512' | '1K' | '2K' | '4K';

export type ComicKind = 'comic' | 'manga' | 'webtoon' | 'strip' | 'storybook';
export type QualityTier = 'draft' | 'standard' | 'pro';
/** overlay = clean art + vector balloons we letter (editable, exact text). in_art = the model letters the page. */
export type LetteringMode = 'overlay' | 'in_art';
/** always = confirm every spend; big = confirm above settings.bigSpendUsd; never = only the budget cap stops it. */
export type ConfirmPolicy = 'always' | 'big' | 'never';
export type ColorMode = 'color' | 'bw' | 'limited';

// ── Assets, references, versions ─────────────────────────────────────────────

export type AssetSource = 'upload' | 'generated' | 'derived' | 'library';
export interface AssetVariant { path: string; w: number; h: number }

/** A stored image (Supabase storage path). */
export interface AssetRef {
  path: string;
  w?: number;
  h?: number;
  source: AssetSource;
  /** Image model that produced it (generated only). */
  model?: string;
  at: number;
  /** SERVER-ONLY. WebP downscales made at save time: widths 480 and 1080, only those narrower than the
   *  original, ascending. Keys are `path`, so the GC (`$.**.path`) protects them. Never set by a client. */
  variants?: AssetVariant[];
  /** SERVER-ONLY. Content-safety verdict for THIS image; travels with versions, copies, archive and trash. */
  safety?: SafetyVerdict;
  /** source 'library': platform library id ("style.noir-ink") or a My-library item id. */
  libraryId?: string;
  /** source 'derived': path of the image it was made from (informational; NOT GC-protecting). */
  derivedFrom?: string;
}

export type RefLabel =
  | 'face' | 'front' | 'three_quarter' | 'side' | 'back' | 'full_body' | 'outfit' | 'expression' | 'pose' | 'detail'
  | 'wide' | 'exterior' | 'interior' | 'lighting'
  | 'linework' | 'color' | 'texture' | 'mood' | 'composition'
  | 'other';
export type CastKind = 'person' | 'animal' | 'creature' | 'robot' | 'toy' | 'vehicle' | 'object';
export type RefSubject = CastKind | 'place' | 'artwork' | 'other';
export interface RefQuality { blurry?: true; dark?: true; lowRes?: true; multiSubject?: true }

/** Every CastKind (validation lists). */
export const CAST_KINDS: readonly CastKind[] = ['person', 'animal', 'creature', 'robot', 'toy', 'vehicle', 'object'];

/** A user reference image. Order in the owning array = priority; index 0 = the "main" ref (no separate flag). */
export interface RefAsset extends AssetRef {
  label?: RefLabel;
  /** ≤ 140 chars, user/director ("her festival outfit"); sent to the image model in the legend. */
  note?: string;
  /** SERVER-ONLY ≤ 160 chars (vision piggyback on the upload safety check). */
  caption?: string;
  /** SERVER-ONLY (vision piggyback); drives ranking. */
  subject?: RefSubject;
  /** SERVER-ONLY. sha256(original bytes) first 16 hex (client-computed, server re-checked) — exact-dup hint. */
  hash?: string;
  /** SERVER-ONLY. 64-bit dHash (16 hex) of the stored image — near-dup + denylist. */
  dhash?: string;
  /** SERVER-ONLY. Free sharp heuristics at upload. */
  quality?: RefQuality;
  /** Sanitized original filename, ≤ 80. */
  name?: string;
  /** SERVER-ONLY. Pre-crop image (kept for "Reset crop"; GC-protected via `path`). */
  original?: { path: string; w?: number; h?: number };
  /** SERVER-ONLY. Crop box applied to `original` (normalized). */
  crop?: Box;
  addedBy?: 'user' | 'director' | 'import' | 'library';
}

/** Who owns a reference list. Defined here (not ops.ts) so doc.ts card types can use it without a cycle. */
export type RefOwner =
  | { kind: 'character'; id: string }
  | { kind: 'place'; id: string }
  | { kind: 'style' }
  | { kind: 'inbox' };

export type VersionOrigin = 'render' | 'edit' | 'derived' | 'adopted' | 'upload' | 'reused' | 'variation';

/** What a render was made from. On RenderState for the current asset; on RenderVersion in history. */
export interface VersionMeta {
  specHash?: string; // pageSpecHash / sheetSpecHash / placeSpecHash / coverSpecHash at render time
  qc?: QcReport;
  costUsd?: number;
  resolution?: Resolution;
  aspect?: AspectRatio; // the aspect REQUESTED from the model
  jobHash?: string; // exact job fingerprint (reuse dedup)
  origin?: VersionOrigin;
  note?: string; // edit instruction / redraw note
  parentPath?: string; // edits: the version it was made from
  continuityPath?: string; // previous-page reference actually attached
  refPaths?: string[]; // user ref paths actually attached ("drawn from older photos" hint)
  // ── Ship 2 (K2a; pro plan §5.2, I3): they describe THIS raster, so a new asset clears them and history keeps them.
  //    Never hashed. ──
  /** Where each drawn panel sits on this raster (page renders; panelization). */
  cuts?: PanelCuts;
  /** Staleness fingerprints of what this raster was drawn from (parts.ts partsOf). */
  parts?: VersionParts;
  /** The consistency anchors attached to the call that drew it (≤ CONSISTENCY_LIMITS.anchorKeys). */
  anchorKeys?: string[];
}
/** Every VersionMeta key (asset replacement clears exactly these). */
export const VERSION_META_KEYS: readonly (keyof VersionMeta)[] = [
  'specHash', 'qc', 'costUsd', 'resolution', 'aspect', 'jobHash', 'origin', 'note', 'parentPath', 'continuityPath', 'refPaths',
  // --- Ship 2 (K2a) ---
  'cuts', 'parts', 'anchorKeys'
];

export type RenderStatus = 'none' | 'queued' | 'rendering' | 'ready' | 'failed' | 'stale';

/** Normalized box on an image (0..1, origin top-left). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface KeepOut { panel: number; box: Box; kind: 'face' | 'hands' | 'action' | 'text' | 'other' }
export interface SpeakerMark { panel: number; characterId?: string; head: { x: number; y: number }; mouth?: { x: number; y: number } }

export interface QcReport {
  /** 0..1 — overall confidence the render matches its spec. */
  score: number;
  issues: string[];
  /** Panel rectangles in reading order (page renders). */
  panelBoxes?: Box[];
  /** Text the vision pass read off the image (in_art lettering verification / stray text). */
  textFound?: string[];
  checkedAt: number;
  model?: string;
  /** Regions balloons must not cover (from the per-render vision pass; ≤ 4 per panel). */
  keepOut?: KeepOut[];
  /** Where each speaking character's head/mouth is (tail aiming). */
  heads?: SpeakerMark[];
  // ── Ship 1 panel checks (plan §5.1; vision.ts). All optional and never hashed; a report without them is an
  //    older check and means "not measured", never "fine". publicQc copies only geometry: panelBoxes and the
  //    keepOut/heads boxes the lettering places around (no issue text, score, model or time). ──
  /** Per DRAWN panel in reading order: the script panel number whose moment it shows (0 = none). Stored only
   *  when answered for every drawn panel. A permutation is reported, never applied. */
  beats?: number[];
  /** Drawn panel numbers (1-based, reading order) whose art breaks over their border; [] = none do. */
  crosses?: number[];
  /** The panel rectangles the check measured, in reading order — kept even when their count differs from the
   *  plan (panelBoxes then holds the estimate). */
  drawnBoxes?: Box[];
  /** Speakers with lines in a panel whom the check reads as not drawn there (off-panel voices never). */
  missingSpeakers?: QcMissingSpeaker[];
  /** Where panelBoxes came from: measured by the check, or estimated from the layout blueprint. */
  boxesFrom?: 'vision' | 'estimate';
  // ── Ship 2 (K2a; pro plan §5.2): the check v2 (B3). A report without them is an older check ("not checked yet"). ──
  /** 2 = the check read the reference board (identity, continuity, style). */
  checkV?: 2;
  /** What the check found, with free/paid fix offers (≤ CONSISTENCY_LIMITS.findings). */
  findings?: ConsistencyFinding[];
}

/** A speaker the page check reads as not drawn in a panel (QcReport.missingSpeakers). */
export interface QcMissingSpeaker {
  /** Script panel number (1-based). */
  panel: number;
  castId: string;
}

export interface RenderVersion extends AssetRef, VersionMeta {
  /** Page targets: the balloon layout that belonged to this image (≤ MAX_BALLOON_SNAPSHOT). */
  balloons?: Balloon[];
  /** Starred versions are never evicted from the archive. */
  starred?: boolean;
}

/**
 * Sanitized provider facts of a failed render (P2-AMEND, from P1-JOBS / wm-plan). `text` is one line such as
 * 'OpenRouter · 429 · upstream Google · 17:42 UTC' — never a response body, a prompt or a key.
 * Set together with RenderState.error; cleared whenever `error` is cleared (applyOp enforces it).
 */
export interface RenderErrorDetail {
  /** Short machine code: an HTTP status ('429') or a StudioErrorCode. ≤ 40 chars. */
  code: string;
  /** Provider / route label ('OpenRouter', 'Gemini'). ≤ 60 chars. */
  provider?: string;
  /** When it failed (epoch ms). */
  at: number;
  /** One sanitized line for the Details row. ≤ 160 chars. */
  text: string;
}
export const ERROR_DETAIL_LIMITS = { code: 40, provider: 60, text: 160 } as const;

/** One clipped line: control characters and runs of whitespace become one space; trimmed AFTER the clip, so a
 *  second pass is a no-op (idempotent even when the clip lands on a space). */
const oneLine = (s: string, max: number): string =>
  s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();

/** A valid RenderErrorDetail (one line per string, clipped to ERROR_DETAIL_LIMITS) or undefined. Idempotent. */
export const normalizeErrorDetail = (value: unknown): RenderErrorDetail | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.code !== 'string' || typeof v.text !== 'string') return undefined;
  if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return undefined;
  const code = oneLine(v.code, ERROR_DETAIL_LIMITS.code);
  const text = oneLine(v.text, ERROR_DETAIL_LIMITS.text);
  if (!code || !text) return undefined;
  const out: RenderErrorDetail = { code, at: v.at, text };
  const provider = typeof v.provider === 'string' ? oneLine(v.provider, ERROR_DETAIL_LIMITS.provider) : '';
  if (provider) out.provider = provider;
  return out;
};

export interface RenderState extends VersionMeta {
  status: RenderStatus;
  asset?: AssetRef;
  /** Previous versions, newest first (cap MAX_RENDER_HISTORY; overflow moves to doc.archive). */
  history: RenderVersion[];
  model?: string;
  error?: string;
  /** Provider facts behind `error` (only while `error` is set). Dropped from public snapshots. */
  errorDetail?: RenderErrorDetail;
  attempts?: number;
  updatedAt?: number;
  /** PUBLIC SNAPSHOT ONLY: art withheld from readers. Never set on a live doc. */
  withheld?: 'safety';
}

/** A version pushed out of a target's history — still restorable and GC-protected. Lean: no qc/balloons. */
export interface ArchivedVersion extends AssetRef {
  targetKey: string; // renderTargetKey(): 'page:pg_x' | 'cover' | 'sheet:c_x' | 'place:pl_x' | 'style_option:so_x'
  label: string; // "Page 3", "Cover", "MAYA sheet", "Deleted page 4"
  archivedAt: number;
  specHash?: string;
  costUsd?: number;
  origin?: VersionOrigin;
  aspect?: AspectRatio;
  starred?: boolean;
  /** Edits: the version it was made from (kept from VersionMeta so fit_render's once-per-original check survives archiving). */
  parentPath?: string;
}

/** A deleted page, restorable (Undo / Media → Deleted). */
export interface TrashedPage { page: Page; fromN: number; deletedAt: number }

// ── Story ────────────────────────────────────────────────────────────────────

export interface Brief {
  title: string;
  logline?: string;
  premise?: string;
  genre?: string;
  tone?: string;
  audience?: string;
  setting?: string;
  themes?: string[];
  /** Free-form decisions/ideas the user has stated that don't fit a field ("no gore", "ends on a cliffhanger"). */
  notes: string[];
}

export interface Format {
  kind: ComicKind;
  pageCount: number;
  pageAspect: AspectRatio;
  /** 'auto' lets the writer vary density per page (3–6). */
  panelsPerPage: 'auto' | number;
  readingDirection: 'ltr' | 'rtl';
  lettering: LetteringMode;
  colorMode: ColorMode;
  /** BCP-47 language for dialogue (default 'en'). The SOURCE language of every translation. */
  language: string;
}

/** Raw material the user supplied (a pasted script, story, or notes). */
export interface Source {
  script?: string;
  updatedAt?: number;
}

export interface StyleOption {
  id: string;
  name: string;
  /** Prompt-ready description of the look (medium, linework, color, shading, influences). */
  spec: string;
  render: RenderState;
}

export interface StyleBible {
  status: 'empty' | 'drafted' | 'locked';
  name?: string;
  spec?: string;
  palette?: string[];
  linework?: string;
  /** Things the art must never do ("no photorealism", "no gore"). */
  avoid?: string[];
  presetId?: string;
  /** User-supplied style reference images. */
  refs: RefAsset[];
  /** The locked style board — the canonical visual anchor for every render. */
  board?: AssetRef;
  options: StyleOption[];
}

export interface CharacterLook {
  /** One dense visual sentence an artist could draw from. */
  summary: string;
  age?: string;
  gender?: string;
  build?: string;
  face?: string;
  hair?: string;
  eyes?: string;
  skin?: string;
  outfit?: string;
  palette?: string;
  props?: string;
  /** Distinguishing marks that must never drift (scar over left eye, red scarf). */
  marks?: string;
  /** Non-humans: what they are ("mallard duckling", "LEGO-style minifigure"). ≤ 120. */
  species?: string;
  /** Non-humans: coat/feather/paint markings that must never drift. ≤ 120. */
  markings?: string;
}

export type CastTier = 'lead' | 'support' | 'extra';

export interface Character {
  id: string;
  name: string;
  role?: string;
  /** lead/support get a model sheet; extras are text-locked only. */
  tier: CastTier;
  look: CharacterLook;
  personality?: string;
  /** How they talk — feeds dialogue writing. */
  voice?: string;
  /** User-supplied reference images (photos, drawings). */
  refs: RefAsset[];
  /** Model sheet (turnaround + expressions) — the identity anchor in every page render. */
  sheet: RenderState;
  /** Absent = 'person'. Non-humans are first-class cast (data-insights). */
  kind?: CastKind;
  /** 2–12 = a group drawn as one identity class ("three ducklings"). Absent/1 = single. */
  count?: number;
  /** Pages: 'auto' (default) = sheet + main photo for photo-based leads when spare character slots exist. */
  likeness?: 'auto' | 'sheet_only' | 'sheet_and_photo';
}

export interface Place {
  id: string;
  name: string;
  look: string;
  refs: RefAsset[];
  sheet: RenderState;
}

export type ShotType =
  | 'establishing' | 'wide' | 'full' | 'medium' | 'close_up'
  | 'extreme_close_up' | 'over_shoulder' | 'insert' | 'pov';

export type PanelSize = 'small' | 'medium' | 'large' | 'wide' | 'tall' | 'splash';

export type LineKind = 'speech' | 'thought' | 'caption' | 'sfx' | 'whisper' | 'shout';

export interface Line {
  id: string;
  kind: LineKind;
  /** Character id for speech/thought/whisper/shout; omitted for captions/sfx. */
  speakerId?: string;
  text: string;
  /** Overlay lettering overrides for this line (Pro inspector / restyle_balloons). Never hashed. */
  style?: LetterStylePatch;
  /** Rendering language when it differs from format.language (set by localizeDoc on fallback lines,
   *  or by the author for a deliberately foreign line). Never hashed. */
  lang?: string;
  /** Never translate this line (spell, made-up word, song). Never hashed. */
  noTranslate?: boolean;
}

export interface Panel {
  id: string;
  /** 1-based reading order within the page. */
  n: number;
  size: PanelSize;
  shot: ShotType;
  angle?: string;
  /** What is visibly happening in the frame — drawn, not narrated. */
  action: string;
  /** Characters visible in the panel (ids). Anyone not listed must not appear. */
  castIds: string[];
  placeId?: string;
  mood?: string;
  lines: Line[];
  // ── Ship 2 (K2a; pro plan §5.2). Never hashed. ──
  /** The panel as an object on the page (panels mode). Moves only through `page_frames`, so its lettering follows. */
  frame?: PanelFrame;
  /** Per-panel art direction (lens, light, staging…). */
  direction?: PanelDirection;
}

/** A lettered balloon placed on a page (overlay lettering). Coordinates are page-normalized 0..1. */
export interface Balloon {
  lineId: string;
  x: number;
  y: number;
  /** Width as a fraction of page width. */
  w: number;
  tailX?: number;
  tailY?: number;
  /** User moved it — never auto-relayout over it. */
  pinned?: boolean;
  /** Stacking order (higher draws later). Absent = reading order. Integer −100..100. */
  z?: number;
  /** Never moved by auto-layout or dragged; implies pinned. */
  locked?: boolean;
  /** Linked balloon: draw a connector neck to the balloon of this lineId (same panel, no cycles).
   *  Direction (P2-AMEND): `linkTo` points to the PREVIOUS line in reading order — a chain l1←l2←l3
   *  is drawn as one group; unlinking a balloon clears the links at both of its ends. */
  linkTo?: string;
  // ── Ship 2 (K2a; pro plan §5.2). Shared across languages. ──
  /** Rotation in degrees (body and text together; the tail tip stays put), ±EDITOR_LIMITS.balloonRot. */
  rot?: number;
  /** Minimum height (page fraction, ≤ EDITOR_LIMITS.minHMax): the height handle. */
  minH?: number;
}

export interface Page {
  id: string;
  /** 1-based page number. */
  n: number;
  summary: string;
  /** Blueprint of the panel arrangement ("Row 1: one wide panel. Row 2: two equal panels."). */
  layout: string;
  /** What makes the reader turn the page (last panel's hook). */
  turnHook?: string;
  panels: Panel[];
  render: RenderState;
  balloons: Balloon[];
  /** Starts a chapter here (reader scrubber marks, End-card TOC). ≤ 60 chars. Not hashed. */
  chapterTitle?: string;
  // ── Ship 2 (K2a; pro plan §5.2). Optional and never hashed: a page without them renders exactly as before. ──
  /** 'panels' = the page is shown as its panel frames (read through artModeOf, which falls back to 'page'). */
  artMode?: 'panels';
  /** Gutters, margins and borders of the frames; a missing field is its DEFAULT_FRAME_STYLE value (read: frameStyleOf). */
  frameStyle?: Partial<FrameStyle>;
  /** Overlays: stickers, images and shapes (≤ EDITOR_LIMITS.layersPerPage). */
  layers?: PageLayer[];
  /** What changes from this page on (outfits, props, where people are). */
  continuity?: PageContinuity;
}

// ── Ship 2 (K2a; pro plan §5.2): panels as objects, consistency, staleness parts ─────────────────────────────
//
// Every field is optional and NEVER hashed (I1): pageSpecHash, sheetSpecHash, placeSpecHash and coverSpecHash read
// explicit tuples that none of these enter. normalizeDoc drops malformed values, clamps ranges and is idempotent; a
// doc without them normalizes deep-equal to what it did before.

/** How a page shows its art: as drawn ('page'), or cut into editable panel frames ('panels'). */
export type ArtMode = 'page' | 'panels';

/** Frame look for a panels-mode page. Page fractions (gutter, margin, border, radius) and '#RRGGBB' colours. */
export interface FrameStyle {
  gutter: number;
  margin: number;
  border: number;
  color: string;
  bg: string;
  radius: number;
}
export const DEFAULT_FRAME_STYLE: FrameStyle = { gutter: 0.02, margin: 0.02, border: 0.004, color: '#111111', bg: '#ffffff', radius: 0 };

/** Zoom 1..EDITOR_LIMITS.fitZoomMax and pan −1..1 of the picture inside its frame. */
export interface PanelFrameFit {
  s: number;
  x: number;
  y: number;
}
/** Another picture in this frame: an earlier take or an image (box = its crop, normalized on that image). */
export interface PanelFrameSource {
  path: string;
  box?: Box;
}
export interface PanelFrameBorder {
  none?: true;
  w?: number;
  color?: string;
}
export interface PanelFrame {
  /** Page-normalized at the BOOK aspect (format.pageAspect); shortest side EDITOR_LIMITS.frameMin. */
  box: Box;
  /** Absent = the picture covers the frame, centred. */
  fit?: PanelFrameFit;
  /** Absent = this panel's cut of the page's current drawing. */
  src?: PanelFrameSource;
  border?: PanelFrameBorder;
  z?: number;
  locked?: true;
}

/** One drawn panel found on a raster (image-normalized box). */
export interface PanelCut {
  /** The script panel it shows (set by matching or by the user). */
  panelId?: string;
  /** Drawn panel number on the raster, 1-based reading order. */
  drawn: number;
  box: Box;
  /** 0..1 detection confidence. */
  conf: number;
  /** The script panel number whose moment it shows (QC beats). */
  shows?: number;
  /** The art breaks over this panel's border. */
  crosses?: true;
}
export type PanelCutsStatus = 'ok' | 'unsure' | 'mismatch';
export type PanelCutsBy = 'detect' | 'vision' | 'both' | 'user' | 'estimate';
export interface PanelCuts {
  status: PanelCutsStatus;
  by: PanelCutsBy;
  at: number;
  /** ≤ EDITOR_LIMITS.maxCuts. */
  cuts: PanelCut[];
  note?: string;
}

export type LayerShapeType = 'rect' | 'ellipse' | 'line';
export interface PageLayerShape {
  type: LayerShapeType;
  fill?: string;
  stroke?: string;
  strokeW?: number;
  radius?: number;
}
/** An overlay on a page: an image (sticker, prop, photo) or a shape. Page-normalized at the book aspect. */
export interface PageLayer {
  /** 'ly_…' (unique on its page). */
  id: string;
  kind: 'image' | 'shape';
  name?: string;
  box: Box;
  /** Degrees, ±EDITOR_LIMITS.layerRot. */
  rot?: number;
  z?: number;
  /** Keep inside this panel (its frame); the overlay follows the frame. */
  clip?: string;
  opacity?: number;
  flip?: 'h' | 'v';
  locked?: true;
  /** false = guide only: shown in the editor, never printed, exported or published. */
  print?: false;
  src?: { path: string; crop?: Box };
  shape?: PageLayerShape;
}

/** A scene: where and when a run of pages happens (doc.scenes). */
export interface Scene {
  id: string;
  name: string;
  placeId?: string;
  time?: string;
  weather?: string;
  light?: string;
  palette?: string;
}
/** What changes for one character from a page on (null = back to their default). */
export interface CastStateChange {
  outfit?: string | null;
  holding?: string[] | null;
  marks?: string[] | null;
  where?: string | null;
}
export interface PageContinuity {
  sceneId?: string;
  /** castId → the change (null = clears every change carried for them). ≤ CONSISTENCY_LIMITS.castChanges. */
  cast?: Record<string, CastStateChange | null>;
  /** prop name → its state (null = gone). ≤ CONSISTENCY_LIMITS.propChanges. */
  props?: Record<string, string | null>;
  /** ≤ CONSISTENCY_LIMITS.notes. */
  notes?: string[];
  by?: 'writer' | 'user' | 'fix';
}

export type DirectionLens = 'wide' | 'normal' | 'long' | 'macro';
export interface PanelCastDirection {
  expression?: string;
  pose?: string;
  gaze?: string;
  holding?: string[];
  pos?: 'left' | 'center' | 'right';
  depth?: 'fg' | 'mid' | 'bg';
}
export interface PanelDirection {
  lens?: DirectionLens;
  composition?: string;
  light?: string;
  palette?: string;
  focus?: string;
  /** ≤ CONSISTENCY_LIMITS.directionBackground details. */
  background?: string[];
  cast?: Record<string, PanelCastDirection>;
  /** Cast heard but not drawn in this panel. */
  offPanel?: string[];
  by?: 'writer' | 'user' | 'derived';
}

export type ConsistencyFindingKind = 'identity' | 'beat' | 'missing' | 'extra' | 'continuity' | 'style';
export type FixOffer =
  | { kind: 'rebind'; order: number[] }
  | { kind: 'off_panel' }
  | { kind: 'drop_cast' }
  | { kind: 'accept_state'; patch: PageContinuity }
  | { kind: 'panel_fix'; panelN: number; instruction: string }
  | { kind: 'redraw' };
export interface ConsistencyFinding {
  id: string;
  kind: ConsistencyFindingKind;
  /** Script panel number (1-based; 0 = the whole page). */
  panel: number;
  characterId?: string;
  severity: 'minor' | 'major';
  note: string;
  fix?: FixOffer;
  /** "Looks fine" for this version. */
  dismissed?: true;
}

/** Six-hex fingerprints of one panel's parts: cast, action, place, shot, mood, direction. */
export interface PanelParts {
  c: string;
  a: string;
  p: string;
  s: string;
  m: string;
  d?: string;
}
/** What a page version was drawn from, part by part (one record per page version; parts.ts partsOf). */
export interface VersionParts {
  panels?: Record<string, PanelParts>;
  cont?: string;
  places?: Record<string, string>;
  props?: Record<string, string>;
}

/** Book-wide consistency settings (doc.consistency). */
export interface ConsistencySettings {
  /** Reference images per page call (default CONSISTENCY_LIMITS.maxRefsDefault; the lock's model caps it). */
  maxRefs?: number;
  /** The page whose drawing is the style key for the others. */
  styleKeyPageId?: string;
  /** Anchor keys the user unticked (≤ PRO_PAGE_LIMITS.skipItems). */
  skip?: string[];
}

export interface CoverTitleStyle {
  title?: LetterStylePatch;
  tagline?: LetterStylePatch;
  /** Title block, page-normalized. Default { x: 0.06, y: 0.04, w: 0.88, h: 0.2 }. */
  box?: Box;
  /** Tagline top (0..1). Default: just under the title block. */
  taglineY?: number;
}
export const DEFAULT_COVER_TITLE_BOX: Box = { x: 0.06, y: 0.04, w: 0.88, h: 0.2 };

export interface Cover {
  title?: string;
  tagline?: string;
  direction?: string;
  render: RenderState;
  /** 'in_art' (ABSENT = in_art) = title painted by the image model — the default for new AND old covers
   *  (decisions-final #2). 'overlay' = textless art + software title (free edits, per-language titles).
   *  Once a painted cover exists, overlay is reached only via the one-time quoted `render_cover {textless:true}`;
   *  before the first cover render the author may pick it for free (a `cover` patch). */
  lettering?: LetteringMode;
  titleStyle?: CoverTitleStyle;
}

/** Deterministic book furniture — laid out by software, never billed. */
export interface BookSettings {
  titlePage: boolean;
  /** "The End" + credits page. */
  endPage: boolean;
  backCover: 'none' | 'auto';
  /** Back-cover blurb (default: brief.logline). ≤ 600. */
  blurb?: string;
  /** Author-written credit lines (≤ 8 × 120). Software never inserts the owner's name unless
   *  the publication's showCreator is on (then only the public username). */
  credits?: string[];
  /** Spreads: page 1 is a right-hand page. */
  firstPageRight: boolean;
  /** Exports letterbox every sheet to format.pageAspect. */
  uniformTrim: boolean;
}
export const DEFAULT_BOOK: BookSettings = { titlePage: false, endPage: false, backCover: 'none', firstPageRight: true, uniformTrim: true };

export type PageTurnStyle = 'paper' | 'slide' | 'fade';
/** How the published comic presents (creator's choice; viewers override locally). Guided View is never default. */
export interface ReaderSettings {
  turn: PageTurnStyle;
  /** Guided View shows the whole page before zooming into panels. */
  guidedOverview: boolean;
  paperTexture: boolean;
  ambient: boolean;
  credits?: string; // End-card line, ≤ 140
  dedication?: string; // inside-cover line, ≤ 140
}
export const DEFAULT_READER: ReaderSettings = { turn: 'paper', guidedOverview: true, paperTexture: true, ambient: true };

// ── Translations, safety ─────────────────────────────────────────────────────

/** 'stale', 'missing', 'stale_edited' are DERIVED (i18n.ts translationStatus), never stored. */
export type TranslationStatus = 'machine' | 'reviewed' | 'edited';
export interface TextTranslation {
  text: string;
  /** machine = unreviewed model output; reviewed = passed the automated linguist review; edited = author wrote it. */
  status: TranslationStatus;
  /** lineSourceHash()/textSourceHash() of the source when translated. Mismatch ⇒ stale. */
  sourceHash: string;
  /** Linguist gloss of THIS translation, written in the SOURCE language. */
  gloss?: string;
  /** Open linguist finding; cleared by edit / accept / re-translate. */
  issue?: { severity: 'minor' | 'major'; note: string; suggestion?: string };
  model?: string;
  at: number;
}
export interface BalloonGeometryOverride {
  x?: number; y?: number; w?: number; tailX?: number; tailY?: number;
  /** Multiplier on the kind's font size for this language (pinned auto-fit), 0.7–1.3. */
  fontScale?: number;
  pinned?: boolean;
}
export type TranslationRegister = 'everyday' | 'formal' | 'code_mixed';
export type EditionTextField = 'cover.title' | 'cover.tagline' | 'brief.title' | 'brief.logline';
export interface LanguageEdition {
  /** BCP-47 tag from LANGUAGES (languages.ts); never the source language. */
  lang: string;
  /** lineId → translation. */
  lines: Record<string, TextTranslation>;
  cover?: { title?: TextTranslation; tagline?: TextTranslation };
  brief?: { title?: TextTranslation; logline?: TextTranslation };
  /** lineId → geometry override for this language only (style stays on Line.style). */
  balloons: Record<string, BalloonGeometryOverride>;
  register: TranslationRegister;
}
export interface GlossaryTerm {
  id: string;
  term: string; // source-language form
  kind: 'character' | 'place' | 'title' | 'term';
  refId?: string; // Character/Place id when seeded from cast/places
  policy: 'transliterate' | 'translate' | 'keep';
  forms: Record<string, string>; // lang → target form
  note?: string;
}
/** format.language is the SOURCE language and never appears in editions.
 *  A language is publishable when editionReadiness(...).publishable (translated + reviewed, overlay lettering). */
export interface I18nState {
  editions: Record<string, LanguageEdition>;
  glossary: GlossaryTerm[];
}

export interface SafetyBlocker {
  target: RenderTarget | { kind: 'text'; lang?: string };
  status: Exclude<SafetyStatus, 'pass'>;
  categories: SafetyCategory[];
  note?: string;
}
export interface DocSafety {
  /** Last check over every publishable word (title, logline, cover text, cast names, dialogue, published translations). */
  text?: { hash: string; assessed?: AssessedRating; categories: SafetyCategory[]; at: number; model?: string };
  /** Last publish gate result. */
  publish?: { ok: boolean; rating: ContentRating; rev: number; at: number; blockers: SafetyBlocker[] };
  /** Screening of the source script (no excerpts, neutral locators only). */
  source?: { hash: string; assessed?: AssessedRating; categories: SafetyCategory[]; adaptNotes: string[]; at: number };
  /** Trademark names already explained to the user (no repeated IP notes). */
  ipNoted?: string[];
}

// ── Settings, spend, gate ────────────────────────────────────────────────────

// ── Image model lock (models.md §3) ──────────────────────────────────────────

export type RedrawScope = 'none' | 'pages_cover' | 'all';
export interface ImageModelChange { from: string; to: string; at: number; redraw: RedrawScope; quotedUsd: number }
/**
 * SERVER-ONLY. The image model this comic is drawn with. Set at the first comic image (sheet, place, page,
 * cover or edit — style swatches never lock); changed only by the `change_image_model` action after the
 * user's confirm. Absent = nothing drawn yet, or a legacy doc not yet migrated (modelLock.ts deriveLock).
 * normalizeDoc keeps a well-formed lock even when the registry no longer lists its id: a comic is never
 * silently re-pointed at another model.
 */
export interface ImageModelLock {
  /** Registry id, e.g. 'nano-banana-2.1' (kept even if the registry hides it). */
  modelId: string;
  /** Request id at lock time, e.g. 'google/gemini-nano-banana-2.1'. */
  providerModel?: string;
  /** Audit only, e.g. 'google/gemini-nano-banana-2.1-20261006'. */
  canonicalSlug?: string;
  lockedAt: number;
  origin: 'first_render' | 'migrated' | 'user_change';
  /** Newest first, cap DOC_LIMITS.modelChanges. */
  changes?: ImageModelChange[];
}
export const LOCK_ORIGINS: readonly ImageModelLock['origin'][] = ['first_render', 'migrated', 'user_change'];
export const REDRAW_SCOPES: readonly RedrawScope[] = ['none', 'pages_cover', 'all'];
/** Longest model / provider id a lock stores (registry ids and OpenRouter slugs are far shorter). */
export const LOCK_ID_MAX = 120;

export interface Settings {
  quality: QualityTier;
  confirm: ConfirmPolicy;
  /** Spend at or below this auto-runs under the 'big' policy. */
  bigSpendUsd: number;
  /** Hard cap for the whole project; nothing auto-spends past it. */
  budgetUsd?: number;
  /** Advanced: force a specific registry image model id. PRE-LOCK preference only: ignored once
   *  doc.imageModel exists (the server rejects changes with MODEL_LOCKED; models.md §3.4 item 5). */
  imageModelOverride?: string;
  /** The rating the author chose; clamped at use by effectiveRating() (audience + account ceilings). */
  rating?: ContentRating;
  /** Gate the first page render of a project (director-initiated spends only). Director may only tighten. */
  reviewFirstRender?: boolean;
}

export type SpendKind = 'chat' | 'plan' | 'style' | 'sheet' | 'page' | 'edit' | 'cover' | 'qc' | 'translate';
// Safety checks are platform-paid (decisions-final #10): they never create a SpendEntry.

export interface SpendEntry {
  id: string;
  at: number;
  kind: SpendKind;
  label: string;
  usd: number;
  model?: string;
  /** Paid by the user's own key (not billed by DreamStream) — still tracked so the user sees real cost. */
  byok: boolean;
  /** True when the provider didn't report a cost and this is the registry estimate. */
  estimated: boolean;
  /** renderTargetKey of the image this paid for (per-clip cost badges survive reorders). */
  target?: string;
  /** Honest "saved by software" amount: a reuse of an identical render, or a FREE step the user picked
   *  over a quoted PAID one in the same message (amount = that quote). usd is 0 for such entries. */
  savedUsd?: number;
  // ── models.md §3.3: what the attempt actually requested (image calls; absent on legacy entries) ──
  /** Resolution actually requested. */
  res?: Resolution;
  route?: 'openrouter' | 'gemini';
  /** Absent = 'ok' (legacy). A failed attempt is recorded with the cost the provider reported (usually 0). */
  outcome?: 'ok' | 'failed';
  /** List price at the time (observed-vs-list in Insights). */
  listUsd?: number;
  /** Reference images sent. */
  refs?: number;
}

/** Per-model running total (images = successful image calls; failed = attempts with outcome 'failed'). */
export interface SpendModelTotal { usd: number; images: number; failed: number }

export interface Spend {
  totalUsd: number;
  byKind: Partial<Record<SpendKind, number>>;
  /** Most recent first, capped. */
  entries: SpendEntry[];
  /** Running total of SpendEntry.savedUsd. */
  savedUsd?: number;
  // ── models.md §3.3 running totals: exact, NOT subject to the MAX_SPEND_ENTRIES cap. Kept by the `spend` op
  //    from the moment the doc's entry history is complete (modelInsights.ts rebuilds older docs from entries). ──
  byModel?: Record<string, SpendModelTotal>;
  /** renderTargetKey → usd. */
  byTarget?: Record<string, number>;
  failed?: { count: number; usd: number };
}

/** A spend the studio is waiting on the user to approve. */
export interface Gate {
  id: string;
  /** The action to run on approval (always a spend action, see ops.ts StudioAction). */
  action: import('./ops.js').StudioAction;
  title: string;
  summary: string;
  estimateUsd: number;
  imageCount: number;
  model: string;
  createdAt: number;
  status: 'open' | 'approved' | 'declined';
  /** Why it stopped: policy=confirm setting, budget=would exceed the budget cap, first_render / plan_review /
   *  redraw / no_intent = director-initiated spends the user must confirm. */
  reason: 'policy' | 'budget' | 'first_render' | 'plan_review' | 'redraw' | 'no_intent';
  /** Why a 'declined' gate closed when the user did NOT decline it: approved, but its target was gone
   *  (a deleted page, a cover drawn meanwhile) — the card reads "Nothing left to draw — nothing was spent.". */
  closedReason?: 'nothing_to_draw';
}

// ── Conversation ─────────────────────────────────────────────────────────────

export type StudioTab = 'story' | 'cast' | 'style' | 'pages' | 'media' | 'languages' | 'read';

/** Client-only actions (never sent to the server). */
export type ClientAction =
  | { type: 'open_reader'; immersive?: boolean; guided?: boolean }
  | { type: 'open_page'; pageId: string }
  | { type: 'open_tab'; tab: StudioTab }
  | { type: 'open_share' }
  | { type: 'undo' }
  | { type: 'set_mode'; mode: StudioMode }
  /** Open the image-model picker (models.md §3.8), optionally pre-highlighting a registry id. */
  | { type: 'open_model_picker'; suggest?: string }
  /** Open Settings at a section: 'budget' = this comic's budget cap (the "Raise the budget" chip on a
   *  budget-cap notice), 'keys' = the account's Settings → API keys. */
  | { type: 'open_settings'; section?: 'budget' | 'keys' };

/** A tappable chip. Exactly ONE of say | action | client (validated by normalizeDoc + server). */
export interface NextStep {
  label: string;
  /** Text sent to the director as the user's message (default: label when nothing else is set). */
  say?: string;
  /** Runs directly (no LLM). Spend actions carry quotedUsd so a stale chip re-quotes instead of overspending. */
  action?: import('./ops.js').StudioAction;
  client?: ClientAction;
  /** Price badge; 0 renders as "Free". */
  usd?: number;
}

export type OptionVisual =
  | { kind: 'layout'; panels: number; layout?: string }
  | { kind: 'pages'; count: number }
  | { kind: 'preset'; presetId: string }
  | { kind: 'cast'; characterId: string }
  | { kind: 'lettering'; presetId: string };

export interface OptionChoice {
  id: string;
  label: string;
  description?: string;
  /** Message sent on the user's behalf when picked (defaults to label). */
  reply?: string;
  visual?: OptionVisual;
}

/** One fix chip on a notice card (plan §5.1). Free fixes come first; a paid fix's action carries its quote. */
export interface NoticeFix {
  label: string;
  free: boolean;
  action: import('./ops.js').StudioAction;
}

/** Interactive cards that live inside the conversation. Every card renders LIVE doc state. */
export type Card =
  | { type: 'options'; id: string; question: string; choices: OptionChoice[]; multi?: boolean; allowCustom?: boolean; answered?: string[] }
  | { type: 'style_choice'; id: string }
  | { type: 'cast'; id: string; characterIds: string[] }
  | { type: 'plan'; id: string }
  | { type: 'gate'; id: string; gateId: string }
  | { type: 'renders'; id: string; targets: RenderTarget[]; label: string }
  /** `fixes` (plan §5.1): chips under the notice, free first; a paid one carries `quotedUsd` on its action and goes
   *  through the existing spend gate. */
  | { type: 'notice'; id: string; tone: 'info' | 'warn' | 'error' | 'success'; text: string; fixes?: NoticeFix[] }
  | { type: 'recap'; id: string }
  | { type: 'breakdown'; id: string; pageIds?: string[]; cover?: boolean; view?: 'plan' | 'status' | 'cost'; gateId?: string }
  | { type: 'versions'; id: string; target: RenderTarget }
  | { type: 'style_presets'; id: string; presetIds: string[]; note?: string; picked?: string }
  | { type: 'refs'; id: string; owner: RefOwner; paths: string[] }
  | {
      type: 'publish'; id: string; mode: 'publish' | 'update' | 'unpublish' | 'regenerate';
      request?: PublishRequest; status: 'pending' | 'running' | 'done' | 'declined' | 'failed';
      result?: { url?: string; error?: string; blockers?: SafetyBlocker[] };
    }
  | { type: 'share'; id: string }
  | { type: 'translation'; id: string; languages: string[] }
  /** reliability.md: a provider outage became a calm card with real options; `blockedAction` is the spend
   *  the preflight refused (re-sent once by "wait and retry" when the model is ok again). normalizeOutageCard
   *  keeps it only when its `type` is a known StudioAction type; the server validates the whole action when the
   *  client re-sends it, exactly as it does for every action it receives. */
  | {
      type: 'model_outage';
      id: string;
      modelId: string;
      options: OutageOption[];
      blockedAction?: import('./ops.js').StudioAction;
      /** Where the card came from: the preflight (nothing ran, nothing was charged) or a run that failed part-way. */
      origin?: 'preflight' | 'mid_run';
      /** Mid-run: what the failed part cost (finite, ≥ 0). The card says "you weren't charged" only when it is 0
       *  (or for a preflight card); a card without an origin makes no money claim. */
      chargedUsd?: number;
    }
  // --- history (versions plan §3.3): ids only; renders by fetching from the owner API ---
  | HistoryCard;

/** StudioAction type names (ops.ts defines the union and re-exports these). Spend actions may be gated. */
export const SPEND_ACTION_TYPES: ReadonlySet<string> = new Set([
  'render_style_options', 'render_sheets', 'render_pages', 'edit_page', 'render_cover', 'translate', 'recheck_page'
]);
/** Moved from routes/comic.ts:47 (single source for client + server). */
export const NON_SPEND_ACTION_TYPES: ReadonlySet<string> = new Set([
  'approve_gate', 'decline_gate', 'pick_style', 'plan_pages', 'approve_plan', 'patch', 'restore_render',
  'relayout_balloons', 'cancel',
  'fit_render', 'show_breakdown', 'use_preset', 'ref_crop',
  'publish', 'update_publication', 'unpublish', 'regenerate_link', 'decline_publish',
  'safety_recheck', 'swap_source_language', 'accept_translation_issue',
  'library_save', 'library_use', 'import_classic_cast',
  'change_image_model',
  // --- history (versions plan §3.3): every history path is free ---
  'history_save', 'history_restore', 'history_undo_ai', 'history_forget_photo', 'history_alternative'
]);

export type RenderTarget =
  | { kind: 'page'; id: string }
  | { kind: 'cover' }
  | { kind: 'sheet'; id: string }
  | { kind: 'place'; id: string }
  | { kind: 'style_option'; id: string };

export interface Msg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
  attachments?: RefAsset[];
  cards?: Card[];
  /** Suggested next prompts shown as chips under the latest assistant message (old clients). */
  suggestions?: string[];
  /** Acting chips (≤ DOC_LIMITS.nextSteps). `suggestions: string[]` stays for old clients. */
  nextSteps?: NextStep[];
}

export interface ComicDoc {
  v: number;
  id: string;
  createdAt: number;
  updatedAt: number;
  /** Monotonic revision, bumped by the server on every committed op batch. */
  rev: number;
  brief: Brief;
  format: Format;
  source: Source;
  style: StyleBible;
  cast: Character[];
  places: Place[];
  pages: Page[];
  cover: Cover;
  /** 'draft' = pages planned but not approved; 'approved' = user OK'd the page plan. */
  planStatus: 'none' | 'draft' | 'approved';
  settings: Settings;
  spend: Spend;
  gate: Gate | null;
  conversation: Msg[];
  /** Compressed memory of older conversation turns that scrolled out of the director's window. */
  memory?: string;
  /** Always filled by normalizeDoc; read via letterStyleOf(). */
  letterStyle?: LetteringStyle;
  book?: BookSettings;
  reader?: ReaderSettings;
  /** Newest first, cap MAX_ARCHIVE (oldest unstarred + unreferenced evicted). */
  archive?: ArchivedVersion[];
  /** Newest first, cap MAX_TRASH. */
  trash?: TrashedPage[];
  /** Uploaded but not yet assigned/sent (composer drafts). Pruned after 24 h by the server. */
  refInbox?: RefAsset[];
  i18n?: I18nState;
  /** Server-only. */
  safety?: DocSafety;
  /** Server-only mirror of comic_publications (absent = private). */
  publication?: PublicationMirror;
  /** Writer input fingerprint (free re-plan when unchanged). */
  planInputHash?: string;
  /** SERVER-ONLY. The locked image model (models.md §3); read through imageModelOf(). Never in public snapshots. */
  imageModel?: ImageModelLock;
  // ── Ship 2 (K2a; pro plan §5.2). Never part of any spec hash; History keeps them in the book section. ──
  /** ≤ CONSISTENCY_LIMITS.scenes. Read through scenesOf(). */
  scenes?: Scene[];
  /** Read through consistencyOf(). */
  consistency?: ConsistencySettings;
}

export const emptyRender = (): RenderState => ({ status: 'none', history: [] });

export const DEFAULT_FORMAT: Format = {
  kind: 'comic',
  pageCount: 6,
  pageAspect: '2:3',
  panelsPerPage: 'auto',
  readingDirection: 'ltr',
  lettering: 'overlay',
  colorMode: 'color',
  language: 'en'
};

export const DEFAULT_SETTINGS: Settings = {
  quality: 'standard',
  confirm: 'big',
  bigSpendUsd: 0.5,
  reviewFirstRender: true
};

export const createEmptyDoc = (id: string, title = 'Untitled comic', now = Date.now()): ComicDoc => ({
  v: COMIC_DOC_VERSION,
  id,
  createdAt: now,
  updatedAt: now,
  rev: 0,
  brief: { title, notes: [] },
  format: { ...DEFAULT_FORMAT },
  source: {},
  style: { status: 'empty', refs: [], options: [] },
  cast: [],
  places: [],
  pages: [],
  cover: { render: emptyRender() },
  planStatus: 'none',
  settings: { ...DEFAULT_SETTINGS },
  spend: { totalUsd: 0, byKind: {}, entries: [] },
  gate: null,
  conversation: [],
  letterStyle: { presetId: 'classic', auto: true }, // NEW docs: director may auto-pick a preset
  book: { ...DEFAULT_BOOK },
  reader: { ...DEFAULT_READER },
  archive: [],
  trash: [],
  refInbox: [],
  i18n: { editions: {}, glossary: [] }
});

// ── Normalization ────────────────────────────────────────────────────────────

const asArray = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const asRender = (value: unknown): RenderState => {
  const r = (value && typeof value === 'object' ? value : {}) as Partial<RenderState>;
  const out: RenderState = { ...r, status: r.status || 'none', history: asArray<RenderVersion>(r.history) };
  if (out.errorDetail !== undefined) {
    const detail = normalizeErrorDetail(out.errorDetail);
    if (detail) out.errorDetail = detail;
    else delete out.errorDetail;
  }
  return normalizeRenderShip2(out); // Ship 2 meta (cuts, parts, anchorKeys, findings): only when present
};

/** Every RefLabel (local copy: doc.ts may not import refs.ts — §2 cycle rule). */
const REF_LABEL_SET: ReadonlySet<string> = new Set<RefLabel>([
  'face', 'front', 'three_quarter', 'side', 'back', 'full_body', 'outfit', 'expression', 'pose', 'detail',
  'wide', 'exterior', 'interior', 'lighting',
  'linework', 'color', 'texture', 'mood', 'composition',
  'other'
]);

export const normalizeRefs = (value: unknown): RefAsset[] => {
  const seen = new Set<string>();
  return asArray<RefAsset>(value)
    .filter((r) => isObject(r) && typeof r.path === 'string' && !!r.path && !seen.has(r.path) && !!seen.add(r.path))
    .map((r) => {
      const ref: RefAsset = { ...r, source: r.source || 'upload' };
      if (ref.label !== undefined && !REF_LABEL_SET.has(ref.label)) delete ref.label;
      if (ref.note !== undefined) {
        if (typeof ref.note === 'string') ref.note = ref.note.slice(0, DOC_LIMITS.refNoteChars);
        else delete ref.note;
      }
      return ref;
    });
};

// ── Ship 2 normalizers (K2a; pro plan §5.2) ─────────────────────────────────
//
// Each drops what is malformed, clamps ranges, rounds geometry to 4 decimals and is idempotent. They run only on keys
// that are present, so a doc without Ship 2 data normalizes exactly as before (old docs deep-equal). applyOp runs the
// same functions on op payloads, so a value an op writes is already normal and a reload never changes it.

/** Ids the server accepts for new entities (ops.ts SAFE_ID_RE; local copy: doc.ts may not import ops.ts). */
const SHIP2_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Overlay ids: 'ly_…'. */
export const LAYER_ID_RE = /^ly_[A-Za-z0-9_-]{1,61}$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const HEX6_RE = /^[0-9a-f]{6}$/;
/** Object keys a record built from stored data never takes (prototype pollution). */
const UNSAFE_RECORD_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const safeId = (v: unknown): string | undefined => (typeof v === 'string' && SHIP2_ID_RE.test(v) && !UNSAFE_RECORD_KEYS.has(v) ? v : undefined);
const safeKey = (k: string, max: number): boolean => !!k && k.length <= max && !UNSAFE_RECORD_KEYS.has(k) && k === k.trim();
const textIn = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const s = oneLine(v, max);
  return s || undefined;
};
const intIn = (v: unknown, lo: number, hi: number): number | undefined => (finite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : undefined);
const rangeIn = (v: unknown, lo: number, hi: number): number | undefined => (finite(v) ? r4(Math.min(hi, Math.max(lo, v))) : undefined);
const hexColor = (v: unknown): string | undefined => (typeof v === 'string' && HEX_COLOR_RE.test(v) ? v : undefined);
const isHex6 = (v: unknown): v is string => typeof v === 'string' && HEX6_RE.test(v);
const textList = (v: unknown, maxItems: number, maxChars: number): string[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const item of v) {
    const t = textIn(item, maxChars);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= maxItems) break;
  }
  return out;
};
const oneOfList = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined);

/**
 * A box inside the unit square: finite, positive, each side at least `minSide`, moved inside [0, 1], 4 decimals.
 * Undefined when malformed (NaN, zero or negative size). Idempotent.
 */
export const normalizeUnitBox = (raw: unknown, minSide: number): Box | undefined => {
  if (!isObject(raw)) return undefined;
  const { x, y, w, h } = raw;
  if (!finite(x) || !finite(y) || !finite(w) || !finite(h) || w <= 0 || h <= 0) return undefined;
  const bw = r4(Math.min(1, Math.max(minSide, w)));
  const bh = r4(Math.min(1, Math.max(minSide, h)));
  return { x: r4(Math.min(1 - bw, Math.max(0, x))), y: r4(Math.min(1 - bh, Math.max(0, y))), w: bw, h: bh };
};

/**
 * A page's frame style as stored: the valid fields given (ranges clamped, '#RRGGBB' colours), or undefined when none is
 * valid. A missing field means its DEFAULT_FRAME_STYLE value — frameStyleOf fills them on read.
 */
export const normalizeFrameStyle = (raw: unknown): Partial<FrameStyle> | undefined => {
  if (!isObject(raw)) return undefined;
  const L = PRO_PAGE_LIMITS;
  const out: Partial<FrameStyle> = {};
  const gutter = rangeIn(raw.gutter, 0, L.frameGutterMax);
  if (gutter !== undefined) out.gutter = gutter;
  const margin = rangeIn(raw.margin, 0, L.frameMarginMax);
  if (margin !== undefined) out.margin = margin;
  const border = rangeIn(raw.border, 0, L.frameBorderMax);
  if (border !== undefined) out.border = border;
  const color = hexColor(raw.color);
  if (color) out.color = color;
  const bg = hexColor(raw.bg);
  if (bg) out.bg = bg;
  const radius = rangeIn(raw.radius, 0, L.frameRadiusMax);
  if (radius !== undefined) out.radius = radius;
  return Object.keys(out).length ? out : undefined;
};

/** A well-formed PanelFrame (box clamped to the page, shortest side EDITOR_LIMITS.frameMin), or undefined. */
export const normalizePanelFrame = (raw: unknown): PanelFrame | undefined => {
  if (!isObject(raw)) return undefined;
  const box = normalizeUnitBox(raw.box, EDITOR_LIMITS.frameMin);
  if (!box) return undefined;
  const out: PanelFrame = { box };
  if (isObject(raw.fit)) {
    const s = rangeIn(raw.fit.s, 1, EDITOR_LIMITS.fitZoomMax);
    const x = rangeIn(raw.fit.x, -1, 1);
    const y = rangeIn(raw.fit.y, -1, 1);
    if (s !== undefined && x !== undefined && y !== undefined) out.fit = { s, x, y };
  }
  if (isObject(raw.src) && typeof raw.src.path === 'string' && raw.src.path) {
    const src: PanelFrameSource = { path: raw.src.path };
    const crop = normalizeUnitBox(raw.src.box, PRO_PAGE_LIMITS.boxMin);
    if (crop) src.box = crop;
    out.src = src;
  }
  if (isObject(raw.border)) {
    const border: PanelFrameBorder = {};
    if (raw.border.none === true) border.none = true;
    const w = rangeIn(raw.border.w, 0, PRO_PAGE_LIMITS.frameBorderMax);
    if (w !== undefined) border.w = w;
    const color = hexColor(raw.border.color);
    if (color) border.color = color;
    if (Object.keys(border).length) out.border = border;
  }
  const z = intIn(raw.z, -PRO_PAGE_LIMITS.zMax, PRO_PAGE_LIMITS.zMax);
  if (z !== undefined) out.z = z;
  if (raw.locked === true) out.locked = true;
  return out;
};

const CUT_STATUSES: readonly PanelCutsStatus[] = ['ok', 'unsure', 'mismatch'];
const CUT_BY: readonly PanelCutsBy[] = ['detect', 'vision', 'both', 'user', 'estimate'];

/** A well-formed PanelCut (image-normalized box), or undefined. */
export const normalizePanelCut = (raw: unknown): PanelCut | undefined => {
  if (!isObject(raw)) return undefined;
  const drawn = intIn(raw.drawn, 1, 99);
  const box = normalizeUnitBox(raw.box, PRO_PAGE_LIMITS.boxMin);
  const conf = rangeIn(raw.conf, 0, 1);
  if (!drawn || !box || conf === undefined) return undefined;
  const out: PanelCut = { drawn, box, conf };
  const panelId = safeId(raw.panelId);
  if (panelId) out.panelId = panelId;
  const shows = intIn(raw.shows, 0, 99);
  if (shows !== undefined) out.shows = shows;
  if (raw.crosses === true) out.crosses = true;
  return out;
};

/** Well-formed PanelCuts (≤ EDITOR_LIMITS.maxCuts cuts; malformed cuts dropped), or undefined. */
export const normalizePanelCuts = (raw: unknown): PanelCuts | undefined => {
  if (!isObject(raw) || !Array.isArray(raw.cuts) || !finite(raw.at)) return undefined;
  const status = oneOfList(raw.status, CUT_STATUSES);
  const by = oneOfList(raw.by, CUT_BY);
  if (!status || !by) return undefined;
  const cuts = raw.cuts.map(normalizePanelCut).filter((c): c is PanelCut => !!c).slice(0, EDITOR_LIMITS.maxCuts);
  const out: PanelCuts = { status, by, at: raw.at, cuts };
  const note = textIn(raw.note, PRO_PAGE_LIMITS.cutNoteChars);
  if (note) out.note = note;
  return out;
};

const LAYER_SHAPES: readonly LayerShapeType[] = ['rect', 'ellipse', 'line'];

/** A well-formed PageLayer (an image layer needs `src`, a shape layer `shape`), or undefined. */
export const normalizePageLayer = (raw: unknown): PageLayer | undefined => {
  if (!isObject(raw) || typeof raw.id !== 'string' || !LAYER_ID_RE.test(raw.id)) return undefined;
  const kind = oneOfList(raw.kind, ['image', 'shape'] as const);
  const box = normalizeUnitBox(raw.box, PRO_PAGE_LIMITS.boxMin);
  if (!kind || !box) return undefined;
  const out: PageLayer = { id: raw.id, kind, box };
  if (kind === 'image') {
    if (!isObject(raw.src) || typeof raw.src.path !== 'string' || !raw.src.path) return undefined;
    const src: PageLayer['src'] = { path: raw.src.path };
    const crop = normalizeUnitBox(raw.src.crop, PRO_PAGE_LIMITS.boxMin);
    if (crop) src.crop = crop;
    out.src = src;
  } else {
    const type = isObject(raw.shape) ? oneOfList(raw.shape.type, LAYER_SHAPES) : undefined;
    if (!type || !isObject(raw.shape)) return undefined;
    const shape: PageLayerShape = { type };
    const fill = hexColor(raw.shape.fill);
    if (fill) shape.fill = fill;
    const stroke = hexColor(raw.shape.stroke);
    if (stroke) shape.stroke = stroke;
    const strokeW = rangeIn(raw.shape.strokeW, 0, PRO_PAGE_LIMITS.layerStrokeMax);
    if (strokeW !== undefined) shape.strokeW = strokeW;
    const radius = rangeIn(raw.shape.radius, 0, PRO_PAGE_LIMITS.layerRadiusMax);
    if (radius !== undefined) shape.radius = radius;
    out.shape = shape;
  }
  const name = textIn(raw.name, PRO_PAGE_LIMITS.layerNameChars);
  if (name) out.name = name;
  if (finite(raw.rot)) out.rot = r2(Math.min(EDITOR_LIMITS.layerRot, Math.max(-EDITOR_LIMITS.layerRot, raw.rot)));
  const z = intIn(raw.z, -PRO_PAGE_LIMITS.zMax, PRO_PAGE_LIMITS.zMax);
  if (z !== undefined) out.z = z;
  const clip = safeId(raw.clip);
  if (clip) out.clip = clip;
  const opacity = rangeIn(raw.opacity, 0, 1);
  if (opacity !== undefined) out.opacity = opacity;
  const flip = oneOfList(raw.flip, ['h', 'v'] as const);
  if (flip) out.flip = flip;
  if (raw.locked === true) out.locked = true;
  if (raw.print === false) out.print = false;
  return out;
};

/** A page's overlays: malformed and duplicate ids dropped, ≤ EDITOR_LIMITS.layersPerPage. Undefined when none. */
export const normalizePageLayers = (raw: unknown): PageLayer[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: PageLayer[] = [];
  for (const item of raw) {
    const layer = normalizePageLayer(item);
    if (!layer || seen.has(layer.id)) continue;
    seen.add(layer.id);
    out.push(layer);
    if (out.length >= EDITOR_LIMITS.layersPerPage) break;
  }
  return out.length ? out : undefined;
};

const normalizeCastStateChange = (raw: unknown): CastStateChange | null | undefined => {
  if (raw === null) return null;
  if (!isObject(raw)) return undefined;
  const L = PRO_PAGE_LIMITS;
  const out: CastStateChange = {};
  for (const k of ['outfit', 'where'] as const) {
    if (raw[k] === null) out[k] = null;
    else {
      const t = textIn(raw[k], L.continuityTextChars);
      if (t) out[k] = t;
    }
  }
  for (const k of ['holding', 'marks'] as const) {
    if (raw[k] === null) out[k] = null;
    else {
      const list = textList(raw[k], L.continuityListItems, L.continuityTextChars);
      if (list) out[k] = list;
    }
  }
  return Object.keys(out).length ? out : undefined;
};

const CONTINUITY_BY = ['writer', 'user', 'fix'] as const;

/** A well-formed PageContinuity (caps from CONSISTENCY_LIMITS), or undefined when nothing valid is left. */
export const normalizePageContinuity = (raw: unknown): PageContinuity | undefined => {
  if (!isObject(raw)) return undefined;
  const L = PRO_PAGE_LIMITS;
  const out: PageContinuity = {};
  const sceneId = safeId(raw.sceneId);
  if (sceneId) out.sceneId = sceneId;
  if (isObject(raw.cast)) {
    const cast: Record<string, CastStateChange | null> = {};
    let n = 0;
    for (const [id, value] of Object.entries(raw.cast)) {
      if (n >= CONSISTENCY_LIMITS.castChanges) break;
      if (!safeId(id)) continue;
      const change = normalizeCastStateChange(value);
      if (change === undefined) continue;
      cast[id] = change;
      n += 1;
    }
    if (n) out.cast = cast;
  }
  if (isObject(raw.props)) {
    const props: Record<string, string | null> = {};
    let n = 0;
    for (const [name, value] of Object.entries(raw.props)) {
      if (n >= CONSISTENCY_LIMITS.propChanges) break;
      if (!safeKey(name, L.sceneNameChars)) continue;
      if (value === null) props[name] = null;
      else {
        const t = textIn(value, L.continuityTextChars);
        if (!t) continue;
        props[name] = t;
      }
      n += 1;
    }
    if (n) out.props = props;
  }
  const notes = textList(raw.notes, CONSISTENCY_LIMITS.notes, L.continuityNoteChars);
  if (notes && notes.length) out.notes = notes;
  const by = oneOfList(raw.by, CONTINUITY_BY);
  if (by) out.by = by;
  return Object.keys(out).length ? out : undefined;
};

const LENSES: readonly DirectionLens[] = ['wide', 'normal', 'long', 'macro'];

/** A well-formed PanelDirection, or undefined when nothing valid is left. */
export const normalizePanelDirection = (raw: unknown): PanelDirection | undefined => {
  if (!isObject(raw)) return undefined;
  const L = PRO_PAGE_LIMITS;
  const out: PanelDirection = {};
  const lens = oneOfList(raw.lens, LENSES);
  if (lens) out.lens = lens;
  for (const k of ['composition', 'light', 'palette', 'focus'] as const) {
    const t = textIn(raw[k], L.directionTextChars);
    if (t) out[k] = t;
  }
  const background = textList(raw.background, CONSISTENCY_LIMITS.directionBackground, L.sceneTextChars);
  if (background && background.length) out.background = background;
  if (isObject(raw.cast)) {
    const cast: Record<string, PanelCastDirection> = {};
    let n = 0;
    for (const [id, value] of Object.entries(raw.cast)) {
      if (n >= CONSISTENCY_LIMITS.castChanges) break;
      if (!safeId(id) || !isObject(value)) continue;
      const one: PanelCastDirection = {};
      for (const k of ['expression', 'pose', 'gaze'] as const) {
        const t = textIn(value[k], L.directionCastTextChars);
        if (t) one[k] = t;
      }
      const holding = textList(value.holding, L.directionListItems, L.directionCastTextChars);
      if (holding && holding.length) one.holding = holding;
      const pos = oneOfList(value.pos, ['left', 'center', 'right'] as const);
      if (pos) one.pos = pos;
      const depth = oneOfList(value.depth, ['fg', 'mid', 'bg'] as const);
      if (depth) one.depth = depth;
      if (!Object.keys(one).length) continue;
      cast[id] = one;
      n += 1;
    }
    if (n) out.cast = cast;
  }
  if (Array.isArray(raw.offPanel)) {
    const offPanel = [...new Set(raw.offPanel.map(safeId).filter((id): id is string => !!id))].slice(0, CONSISTENCY_LIMITS.castChanges);
    if (offPanel.length) out.offPanel = offPanel;
  }
  const by = oneOfList(raw.by, ['writer', 'user', 'derived'] as const);
  if (by) out.by = by;
  return Object.keys(out).length ? out : undefined;
};

const FINDING_KINDS: readonly ConsistencyFindingKind[] = ['identity', 'beat', 'missing', 'extra', 'continuity', 'style'];

/** A well-formed FixOffer, or undefined. */
export const normalizeFixOffer = (raw: unknown): FixOffer | undefined => {
  if (!isObject(raw)) return undefined;
  switch (raw.kind) {
    case 'rebind': {
      if (!Array.isArray(raw.order) || !raw.order.length || raw.order.length > DOC_LIMITS.panelsPerPage) return undefined;
      const order = raw.order.map((n) => intIn(n, 1, 99));
      return order.every((n): n is number => n !== undefined) ? { kind: 'rebind', order } : undefined;
    }
    case 'off_panel':
    case 'drop_cast':
    case 'redraw':
      return { kind: raw.kind };
    case 'accept_state': {
      const patch = normalizePageContinuity(raw.patch);
      return patch ? { kind: 'accept_state', patch } : undefined;
    }
    case 'panel_fix': {
      const panelN = intIn(raw.panelN, 1, 99);
      const instruction = textIn(raw.instruction, PRO_PAGE_LIMITS.fixInstructionChars);
      return panelN && instruction ? { kind: 'panel_fix', panelN, instruction } : undefined;
    }
    default:
      return undefined;
  }
};

/** A well-formed ConsistencyFinding, or undefined. */
export const normalizeConsistencyFinding = (raw: unknown): ConsistencyFinding | undefined => {
  if (!isObject(raw)) return undefined;
  const id = safeId(raw.id);
  const kind = oneOfList(raw.kind, FINDING_KINDS);
  const panel = intIn(raw.panel, 0, 99);
  const severity = oneOfList(raw.severity, ['minor', 'major'] as const);
  const note = textIn(raw.note, PRO_PAGE_LIMITS.findingNoteChars);
  if (!id || !kind || panel === undefined || !severity || !note) return undefined;
  const out: ConsistencyFinding = { id, kind, panel, severity, note };
  const characterId = safeId(raw.characterId);
  if (characterId) out.characterId = characterId;
  const fix = normalizeFixOffer(raw.fix);
  if (fix) out.fix = fix;
  if (raw.dismissed === true) out.dismissed = true;
  return out;
};

/** A report's findings: malformed and duplicate ids dropped, ≤ CONSISTENCY_LIMITS.findings ([] is kept: checked, none). */
export const normalizeConsistencyFindings = (raw: unknown): ConsistencyFinding[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: ConsistencyFinding[] = [];
  for (const item of raw) {
    const f = normalizeConsistencyFinding(item);
    if (!f || seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
    if (out.length >= CONSISTENCY_LIMITS.findings) break;
  }
  return out;
};

/** Well-formed VersionParts (six-hex fingerprints; ≤ CONSISTENCY_LIMITS.partsKeys keys in all), or undefined. */
export const normalizeVersionParts = (raw: unknown): VersionParts | undefined => {
  if (!isObject(raw)) return undefined;
  let budget: number = CONSISTENCY_LIMITS.partsKeys;
  const out: VersionParts = {};
  if (isObject(raw.panels)) {
    const panels: Record<string, PanelParts> = {};
    for (const [id, v] of Object.entries(raw.panels)) {
      if (budget <= 0) break;
      if (!safeId(id) || !isObject(v) || ![v.c, v.a, v.p, v.s, v.m].every(isHex6)) continue;
      panels[id] = { c: v.c as string, a: v.a as string, p: v.p as string, s: v.s as string, m: v.m as string, ...(isHex6(v.d) ? { d: v.d } : {}) };
      budget -= 1;
    }
    if (Object.keys(panels).length) out.panels = panels;
  }
  if (isHex6(raw.cont)) out.cont = raw.cont;
  for (const k of ['places', 'props'] as const) {
    const src = raw[k];
    if (!isObject(src)) continue;
    const rec: Record<string, string> = {};
    for (const [key, v] of Object.entries(src)) {
      if (budget <= 0) break;
      const ok = k === 'places' ? !!safeId(key) : safeKey(key, PRO_PAGE_LIMITS.sceneNameChars);
      if (!ok || !isHex6(v)) continue;
      rec[key] = v;
      budget -= 1;
    }
    if (Object.keys(rec).length) out[k] = rec;
  }
  return Object.keys(out).length ? out : undefined;
};

/** Anchor keys of a version: strings, unique, ≤ CONSISTENCY_LIMITS.anchorKeys ([] kept: drawn with none). */
export const normalizeAnchorKeys = (raw: unknown): string[] | undefined => textList(raw, CONSISTENCY_LIMITS.anchorKeys, PRO_PAGE_LIMITS.anchorKeyChars);

/** A well-formed Scene, or undefined. */
export const normalizeScene = (raw: unknown): Scene | undefined => {
  if (!isObject(raw)) return undefined;
  const id = safeId(raw.id);
  const name = textIn(raw.name, PRO_PAGE_LIMITS.sceneNameChars);
  if (!id || !name) return undefined;
  const out: Scene = { id, name };
  const placeId = safeId(raw.placeId);
  if (placeId) out.placeId = placeId;
  for (const k of ['time', 'weather', 'light', 'palette'] as const) {
    const t = textIn(raw[k], PRO_PAGE_LIMITS.sceneTextChars);
    if (t) out[k] = t;
  }
  return out;
};

/** The book's scenes (unique ids, ≤ CONSISTENCY_LIMITS.scenes), or undefined when none. */
export const normalizeScenes = (raw: unknown): Scene[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const seen = new Set<string>();
  const out: Scene[] = [];
  for (const item of raw) {
    const s = normalizeScene(item);
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push(s);
    if (out.length >= CONSISTENCY_LIMITS.scenes) break;
  }
  return out.length ? out : undefined;
};

/** Well-formed consistency settings, or undefined when nothing valid is left. */
export const normalizeConsistencySettings = (raw: unknown): ConsistencySettings | undefined => {
  if (!isObject(raw)) return undefined;
  const out: ConsistencySettings = {};
  const maxRefs = intIn(raw.maxRefs, 1, PRO_PAGE_LIMITS.maxRefsMax);
  if (maxRefs !== undefined) out.maxRefs = maxRefs;
  const styleKeyPageId = safeId(raw.styleKeyPageId);
  if (styleKeyPageId) out.styleKeyPageId = styleKeyPageId;
  const skip = textList(raw.skip, PRO_PAGE_LIMITS.skipItems, PRO_PAGE_LIMITS.anchorKeyChars);
  if (skip && skip.length) out.skip = skip;
  return Object.keys(out).length ? out : undefined;
};

/** A balloon with its Ship 2 keys made valid (rot ±EDITOR_LIMITS.balloonRot, 0 < minH ≤ minHMax). Same object when it has none. */
export const normalizeBalloonShip2 = (b: Balloon): Balloon => {
  if (!isObject(b) || (!('rot' in b) && !('minH' in b))) return b;
  const out: Balloon = { ...b };
  if ('rot' in b) {
    if (finite(b.rot)) out.rot = r2(Math.min(EDITOR_LIMITS.balloonRot, Math.max(-EDITOR_LIMITS.balloonRot, b.rot)));
    else delete out.rot;
  }
  if ('minH' in b) {
    if (finite(b.minH) && b.minH > 0) out.minH = r4(Math.min(EDITOR_LIMITS.minHMax, b.minH));
    else delete out.minH;
  }
  return out;
};

const hasShip2Meta = (v: unknown): boolean =>
  isObject(v) && ('cuts' in v || 'parts' in v || 'anchorKeys' in v || (isObject(v.qc) && ('findings' in v.qc || 'checkV' in v.qc)));

/** Normalize the Ship 2 VersionMeta keys of a render or version IN PLACE (the caller passes a fresh copy). */
const normalizeShip2Meta = <T extends VersionMeta>(m: T): T => {
  if (m.cuts !== undefined) {
    const cuts = normalizePanelCuts(m.cuts);
    if (cuts) m.cuts = cuts;
    else delete m.cuts;
  }
  if (m.parts !== undefined) {
    const parts = normalizeVersionParts(m.parts);
    if (parts) m.parts = parts;
    else delete m.parts;
  }
  if (m.anchorKeys !== undefined) {
    const keys = normalizeAnchorKeys(m.anchorKeys);
    if (keys) m.anchorKeys = keys;
    else delete m.anchorKeys;
  }
  if (isObject(m.qc) && ('findings' in m.qc || 'checkV' in m.qc)) {
    const qc: QcReport = { ...m.qc };
    if ('findings' in qc) {
      const findings = normalizeConsistencyFindings(qc.findings);
      if (findings) qc.findings = findings;
      else delete qc.findings;
    }
    if ('checkV' in qc && qc.checkV !== 2) delete qc.checkV;
    m.qc = qc;
  }
  return m;
};

/** A render's Ship 2 meta (current and history versions) made valid. Same history array when no version has any. */
const normalizeRenderShip2 = (r: RenderState): RenderState => {
  if (hasShip2Meta(r)) normalizeShip2Meta(r);
  if (r.history.some(hasShip2Meta)) r.history = r.history.map((v) => (hasShip2Meta(v) ? normalizeShip2Meta({ ...v }) : v));
  return r;
};

/** A panel's Ship 2 keys made valid (the panel is a fresh copy). */
const normalizePanelShip2 = (panel: Panel): Panel => {
  if (panel.frame !== undefined) {
    const frame = normalizePanelFrame(panel.frame);
    if (frame) panel.frame = frame;
    else delete panel.frame;
  }
  if (panel.direction !== undefined) {
    const direction = normalizePanelDirection(panel.direction);
    if (direction) panel.direction = direction;
    else delete panel.direction;
  }
  return panel;
};

/** A page's Ship 2 keys made valid (the page is a fresh copy). */
const normalizePageShip2 = (page: Page): Page => {
  if (page.artMode !== undefined && page.artMode !== 'panels') delete page.artMode;
  if (page.frameStyle !== undefined) {
    const style = normalizeFrameStyle(page.frameStyle);
    if (style) page.frameStyle = style;
    else delete page.frameStyle;
  }
  if (page.layers !== undefined) {
    const layers = normalizePageLayers(page.layers);
    if (layers) page.layers = layers;
    else delete page.layers;
  }
  if (page.continuity !== undefined) {
    const continuity = normalizePageContinuity(page.continuity);
    if (continuity) page.continuity = continuity;
    else delete page.continuity;
  }
  if (page.balloons.some((b) => isObject(b) && ('rot' in b || 'minH' in b))) page.balloons = page.balloons.map(normalizeBalloonShip2);
  return page;
};

const normalizeLine = (l: Line): Line => {
  if (l.style === undefined && l.lang === undefined && l.noTranslate === undefined) return l; // identity
  const next: Line = { ...l }; // key order kept
  const style = sanitizeLetterStylePatch(l.style);
  if (style) next.style = style;
  else delete next.style;
  if (typeof l.lang !== 'string' || !l.lang) delete next.lang;
  if (l.noTranslate !== true) delete next.noTranslate;
  return next;
};

/** Extracted from the existing pages mapper + v5 fields. */
export const normalizePage = (p: Page, i: number): Page => {
  const page: Page = {
    ...p,
    n: typeof p.n === 'number' ? p.n : i + 1,
    summary: p.summary || '',
    layout: p.layout || '',
    panels: asArray<Panel>(p.panels).map((panel, j) =>
      normalizePanelShip2({
        ...panel,
        n: typeof panel.n === 'number' ? panel.n : j + 1,
        size: panel.size || 'medium',
        shot: panel.shot || 'medium',
        action: panel.action || '',
        castIds: asArray<string>(panel.castIds),
        lines: asArray<Line>(panel.lines).map(normalizeLine)
      })
    ),
    render: asRender(p.render),
    balloons: asArray<Balloon>(p.balloons)
  };
  if (typeof page.chapterTitle === 'string' && page.chapterTitle.trim()) {
    page.chapterTitle = page.chapterTitle.trim().slice(0, DOC_LIMITS.chapterTitleChars);
  } else delete page.chapterTitle;
  return normalizePageShip2(page); // Ship 2 (frames, layers, continuity, balloon rot/minH): only when present
};

/** Stable sort by (n, original index) then n = i+1. Idempotent; repairs gaps/duplicates; n is never hashed. */
export const renumberPages = (pages: Page[]): Page[] =>
  pages
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.n - b.p.n || a.i - b.i)
    .map(({ p }, i) => (p.n === i + 1 ? p : { ...p, n: i + 1 }));

/** Exactly ONE (or none) of say | action | client, and a non-empty label. */
export const isValidNextStep = (s: unknown): s is NextStep =>
  isObject(s) &&
  typeof s.label === 'string' &&
  !!s.label.trim() &&
  [s.say !== undefined, s.action !== undefined, s.client !== undefined].filter(Boolean).length <= 1;

const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const lockId = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() && v.length <= LOCK_ID_MAX ? v : undefined);

/** A well-formed ImageModelChange or undefined (quotedUsd clamped at 0; a negative quote is not a quote). */
export const normalizeImageModelChange = (value: unknown): ImageModelChange | undefined => {
  if (!isObject(value)) return undefined;
  const from = lockId(value.from);
  const to = lockId(value.to);
  if (!from || !to || !isFiniteNum(value.at)) return undefined;
  if (!REDRAW_SCOPES.includes(value.redraw as RedrawScope)) return undefined;
  const quotedUsd = isFiniteNum(value.quotedUsd) ? Math.max(0, value.quotedUsd) : 0;
  return { from, to, at: value.at, redraw: value.redraw as RedrawScope, quotedUsd };
};

/**
 * A well-formed ImageModelLock or undefined. Keeps the lock even when the registry no longer lists its
 * id (a comic is never re-pointed on read); drops malformed changes and keeps the newest
 * DOC_LIMITS.modelChanges. Idempotent; null optional fields (the wire turns undefined into null) are dropped.
 */
export const normalizeImageModelLock = (value: unknown): ImageModelLock | undefined => {
  if (!isObject(value)) return undefined;
  const modelId = lockId(value.modelId);
  if (!modelId || !isFiniteNum(value.lockedAt)) return undefined;
  if (!LOCK_ORIGINS.includes(value.origin as ImageModelLock['origin'])) return undefined;
  const out: ImageModelLock = { modelId, lockedAt: value.lockedAt, origin: value.origin as ImageModelLock['origin'] };
  const providerModel = lockId(value.providerModel);
  if (providerModel) out.providerModel = providerModel;
  const canonicalSlug = lockId(value.canonicalSlug);
  if (canonicalSlug) out.canonicalSlug = canonicalSlug;
  if (Array.isArray(value.changes)) {
    const changes = value.changes.map(normalizeImageModelChange).filter((c): c is ImageModelChange => !!c).slice(0, DOC_LIMITS.modelChanges);
    if (changes.length) out.changes = changes;
  }
  return out;
};

/** A StudioAction type name the server knows (spend or not). */
const isStudioActionType = (type: unknown): type is string => typeof type === 'string' && (SPEND_ACTION_TYPES.has(type) || NON_SPEND_ACTION_TYPES.has(type));

/**
 * A well-formed `model_outage` card (malformed options dropped; no valid option → undefined). A `blockedAction`
 * whose `type` is not a StudioAction type is dropped (the card stays): the client re-sends it as the "wait and
 * retry" action, and the server validates the full action on receipt like every other action. `origin` and
 * `chargedUsd` are kept only when valid (an invalid one is dropped, so the card makes no money claim).
 */
export const normalizeOutageCard = (value: unknown): Extract<Card, { type: 'model_outage' }> | undefined => {
  if (!isObject(value) || value.type !== 'model_outage') return undefined;
  if (typeof value.id !== 'string' || !value.id || typeof value.modelId !== 'string' || !value.modelId) return undefined;
  const options = (Array.isArray(value.options) ? value.options : []).map(normalizeOutageOption).filter((o): o is OutageOption => !!o);
  if (!options.length) return undefined;
  const out: Extract<Card, { type: 'model_outage' }> = { type: 'model_outage', id: value.id, modelId: value.modelId, options };
  if (isObject(value.blockedAction) && isStudioActionType(value.blockedAction.type)) out.blockedAction = value.blockedAction as never;
  if (value.origin === 'preflight' || value.origin === 'mid_run') out.origin = value.origin;
  if (typeof value.chargedUsd === 'number' && Number.isFinite(value.chargedUsd) && value.chargedUsd >= 0) out.chargedUsd = value.chargedUsd;
  return out;
};

/** At most this many fix chips on one notice card (free first). */
export const NOTICE_FIXES_MAX = 4;
const NOTICE_FIX_LABEL_MAX = 80;

const isNoticeFix = (f: unknown): f is NoticeFix =>
  isObject(f) &&
  typeof f.label === 'string' &&
  !!f.label.trim() &&
  f.label.length <= NOTICE_FIX_LABEL_MAX &&
  typeof f.free === 'boolean' &&
  isObject(f.action) &&
  isStudioActionType(f.action.type);

/**
 * A notice card's fix chips, validated: entries without a label, a free flag or an action of a known StudioAction
 * type are dropped, at most NOTICE_FIXES_MAX are kept, and none at all drops the key. Returns the SAME card when it
 * is already well-formed (the server validates the full action again when a chip is tapped, like every action).
 */
export const normalizeNoticeCard = (card: Extract<Card, { type: 'notice' }>): Extract<Card, { type: 'notice' }> => {
  if (card.fixes === undefined) return card;
  const fixes = Array.isArray(card.fixes) ? card.fixes.filter(isNoticeFix).slice(0, NOTICE_FIXES_MAX) : [];
  if (Array.isArray(card.fixes) && fixes.length === card.fixes.length) return card;
  const out = { ...card };
  if (fixes.length) out.fixes = fixes;
  else delete out.fixes;
  return out;
};

/** Cards of a message: `model_outage` cards are validated (dropped when malformed) and notice fix chips are
 *  validated; every other card is kept exactly as stored (their renderers read live doc state). Returns the SAME
 *  array when nothing changed. */
const normalizeCards = (cards: unknown): Card[] | undefined => {
  if (!Array.isArray(cards)) return undefined;
  let changed = false;
  const out: Card[] = [];
  for (const card of cards as Card[]) {
    if (isObject(card) && card.type === 'model_outage') {
      const next = normalizeOutageCard(card);
      if (!next) {
        changed = true;
        continue;
      }
      out.push(next);
      if (JSON.stringify(next) !== JSON.stringify(card)) changed = true;
    } else if (isObject(card) && card.type === 'notice' && (card as { fixes?: unknown }).fixes !== undefined) {
      const next = normalizeNoticeCard(card);
      if (next !== card) changed = true;
      out.push(next);
    } else out.push(card);
  }
  return changed ? out : (cards as Card[]);
};

const normalizeMsg = (m: Msg): Msg => {
  const msg: Msg = { ...m };
  if (m.attachments !== undefined) msg.attachments = normalizeRefs(m.attachments);
  if (m.cards !== undefined) {
    const cards = normalizeCards(m.cards);
    if (cards === undefined) delete msg.cards;
    else if (cards !== m.cards) msg.cards = cards;
  }
  if (m.nextSteps !== undefined) {
    const steps = asArray<NextStep>(m.nextSteps).filter(isValidNextStep).slice(0, DOC_LIMITS.nextSteps);
    if (steps.length) msg.nextSteps = steps;
    else delete msg.nextSteps;
  }
  return msg;
};

/** The §3.3 running totals of a stored spend, kept only when well-formed and non-empty (legacy docs stay as is). */
const normalizeSpendTotals = (spend: Partial<Spend>): Pick<Spend, 'byModel' | 'byTarget' | 'failed'> => {
  const out: Pick<Spend, 'byModel' | 'byTarget' | 'failed'> = {};
  if (isObject(spend.byModel)) {
    const byModel: Record<string, SpendModelTotal> = {};
    for (const [id, t] of Object.entries(spend.byModel)) {
      if (!id || !isObject(t) || !isFiniteNum(t.usd) || !isFiniteNum(t.images) || !isFiniteNum(t.failed)) continue;
      byModel[id] = { usd: t.usd, images: t.images, failed: t.failed };
    }
    if (Object.keys(byModel).length) out.byModel = byModel;
  }
  if (isObject(spend.byTarget)) {
    const byTarget: Record<string, number> = {};
    for (const [key, usd] of Object.entries(spend.byTarget)) if (key && isFiniteNum(usd)) byTarget[key] = usd;
    if (Object.keys(byTarget).length) out.byTarget = byTarget;
  }
  if (isObject(spend.failed) && isFiniteNum(spend.failed.count) && spend.failed.count > 0 && isFiniteNum(spend.failed.usd)) {
    out.failed = { count: spend.failed.count, usd: spend.failed.usd };
  }
  return out;
};

/** Validate book settings (also used by the `book` op). */
export const pickBook = (raw: unknown): BookSettings => {
  const b = isObject(raw) ? raw : {};
  return {
    titlePage: typeof b.titlePage === 'boolean' ? b.titlePage : DEFAULT_BOOK.titlePage,
    endPage: typeof b.endPage === 'boolean' ? b.endPage : DEFAULT_BOOK.endPage,
    backCover: b.backCover === 'auto' ? 'auto' : 'none',
    ...(typeof b.blurb === 'string' ? { blurb: b.blurb.slice(0, DOC_LIMITS.bookBlurbChars) } : {}),
    ...(Array.isArray(b.credits)
      ? {
          credits: b.credits
            .filter((c): c is string => typeof c === 'string')
            .slice(0, DOC_LIMITS.bookCredits)
            .map((c) => c.slice(0, DOC_LIMITS.bookCreditChars))
        }
      : {}),
    firstPageRight: typeof b.firstPageRight === 'boolean' ? b.firstPageRight : DEFAULT_BOOK.firstPageRight,
    uniformTrim: typeof b.uniformTrim === 'boolean' ? b.uniformTrim : DEFAULT_BOOK.uniformTrim
  };
};

/** Validate reader settings (also used by the `reader` op). */
export const pickReader = (raw: unknown): ReaderSettings => {
  const r = isObject(raw) ? raw : {};
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, DOC_LIMITS.readerTextChars) : undefined);
  const out: ReaderSettings = {
    turn: r.turn === 'slide' || r.turn === 'fade' ? r.turn : 'paper',
    guidedOverview: typeof r.guidedOverview === 'boolean' ? r.guidedOverview : DEFAULT_READER.guidedOverview,
    paperTexture: typeof r.paperTexture === 'boolean' ? r.paperTexture : DEFAULT_READER.paperTexture,
    ambient: typeof r.ambient === 'boolean' ? r.ambient : DEFAULT_READER.ambient
  };
  const credits = text(r.credits);
  if (credits) out.credits = credits;
  const dedication = text(r.dedication);
  if (dedication) out.dedication = dedication;
  return out;
};

const CONTENT_RATING_SET: ReadonlySet<string> = new Set(['G', 'PG', 'PG-13']);

/**
 * Fill defaults on a stored/partial document so every consumer can rely on the full
 * shape. Idempotent and non-destructive (unknown extra keys are preserved).
 */
export const normalizeDoc = (input: Partial<ComicDoc> & { id: string }): ComicDoc => {
  const base = createEmptyDoc(input.id, input.brief?.title || 'Untitled comic', input.createdAt || Date.now());
  const doc = { ...base, ...input } as ComicDoc;
  doc.v = COMIC_DOC_VERSION;
  doc.rev = typeof input.rev === 'number' ? input.rev : 0;
  doc.brief = { ...base.brief, ...(input.brief || {}), notes: asArray<string>(input.brief?.notes) };
  doc.format = { ...DEFAULT_FORMAT, ...(input.format || {}) };
  doc.source = { ...(input.source || {}) };
  const style = (input.style || {}) as Partial<StyleBible>;
  doc.style = {
    ...base.style,
    ...style,
    refs: normalizeRefs(style.refs),
    options: asArray<StyleOption>(style.options).map((o) => ({ ...o, render: asRender(o.render) }))
  };
  // kind/count/species/markings: untouched (no back-fill → no hash churn)
  doc.cast = asArray<Character>(input.cast).map((c) => ({
    ...c,
    tier: c.tier || 'support',
    // Object.assign, not a spread literal: same keys and order (no hash churn), and no TS2783 under the
    // Workers' strict typecheck (Character.look always carries `summary`, so the spread would overwrite it).
    look: Object.assign({ summary: '' }, c.look || {}),
    refs: normalizeRefs(c.refs),
    sheet: asRender(c.sheet)
  }));
  doc.places = asArray<Place>(input.places).map((p) => ({
    ...p,
    look: p.look || '',
    refs: normalizeRefs(p.refs),
    sheet: asRender(p.sheet)
  }));
  doc.pages = renumberPages(asArray<Page>(input.pages).map(normalizePage));
  doc.cover = { ...(input.cover || {}), render: asRender(input.cover?.render) }; // lettering ABSENT stays absent (= in_art)
  doc.planStatus = input.planStatus || (doc.pages.length ? 'draft' : 'none');
  doc.settings = { ...DEFAULT_SETTINGS, ...(input.settings || {}) }; // old docs get reviewFirstRender: true (intended)
  if (doc.settings.rating !== undefined && !CONTENT_RATING_SET.has(doc.settings.rating)) delete doc.settings.rating;
  const spend = (input.spend || {}) as Partial<Spend>;
  doc.spend = {
    totalUsd: typeof spend.totalUsd === 'number' ? spend.totalUsd : 0,
    byKind: { ...(spend.byKind || {}) },
    entries: asArray<SpendEntry>(spend.entries),
    ...(Number.isFinite(spend.savedUsd) && (spend.savedUsd as number) > 0 ? { savedUsd: spend.savedUsd } : {}),
    ...normalizeSpendTotals(spend)
  };
  doc.gate = input.gate || null;
  doc.conversation = asArray<Msg>(input.conversation).map(normalizeMsg);
  // ── v5 additions: explicit assignment (R3) ──
  doc.letterStyle = sanitizeLetteringStyle(input.letterStyle); // missing/invalid → { presetId: 'classic' } (NO auto)
  doc.book = pickBook(input.book); // storybook plates default is applied only on create / set_format
  doc.reader = pickReader(input.reader);
  doc.archive = asArray<ArchivedVersion>(input.archive).filter(
    (a) => isObject(a) && typeof a.path === 'string' && typeof a.targetKey === 'string'
  ); // never sliced here
  doc.trash = asArray<TrashedPage>(input.trash)
    .filter((t) => isObject(t) && isObject(t.page) && typeof (t.page as Page).id === 'string')
    .map((t) => ({
      page: normalizePage(t.page, 0),
      fromN: typeof t.fromN === 'number' ? t.fromN : 1,
      deletedAt: typeof t.deletedAt === 'number' ? t.deletedAt : 0
    }));
  doc.refInbox = normalizeRefs(input.refInbox);
  doc.i18n = normalizeI18n(input.i18n, doc.format.language);
  if (!isObject(input.safety)) delete doc.safety;
  if (!isPublicationMirror(input.publication)) delete doc.publication;
  if (typeof input.planInputHash !== 'string') delete doc.planInputHash;
  const lock = normalizeImageModelLock(input.imageModel);
  if (lock) doc.imageModel = lock;
  else delete doc.imageModel; // legacy docs: no key at all (deriveLock reads them; the next image commit persists)
  // --- Ship 2 (K2a): absent stays absent (old docs deep-equal); malformed or empty is dropped ---
  if (input.scenes !== undefined) {
    const scenes = normalizeScenes(input.scenes);
    if (scenes) doc.scenes = scenes;
    else delete doc.scenes;
  }
  if (input.consistency !== undefined) {
    const consistency = normalizeConsistencySettings(input.consistency);
    if (consistency) doc.consistency = consistency;
    else delete doc.consistency;
  }
  return doc;
};

// ── Accessors (R9) ───────────────────────────────────────────────────────────

export const letterStyleOf = (doc: ComicDoc): LetteringStyle => doc.letterStyle ?? DEFAULT_LETTERING;
export const bookOf = (doc: ComicDoc): BookSettings => doc.book ?? DEFAULT_BOOK;
export const readerOf = (doc: ComicDoc): ReaderSettings => doc.reader ?? DEFAULT_READER;
export const archiveOf = (doc: ComicDoc): ArchivedVersion[] => doc.archive ?? [];
export const trashOf = (doc: ComicDoc): TrashedPage[] => doc.trash ?? [];
export const refInboxOf = (doc: ComicDoc): RefAsset[] => doc.refInbox ?? [];
export const safetyOf = (doc: ComicDoc): DocSafety => doc.safety ?? {};
/** The persisted lock only (undefined until the first comic image, or on a legacy doc: see modelLock.ts). */
export const imageModelOf = (doc: ComicDoc): ImageModelLock | undefined => doc.imageModel;
// i18nOf lives in i18n.ts (re-exported by index.ts).

// --- Ship 2 (K2a; pro plan §5.2) ---
export const scenesOf = (doc: Pick<ComicDoc, 'scenes'>): Scene[] => doc.scenes ?? [];
export const consistencyOf = (doc: Pick<ComicDoc, 'consistency'>): ConsistencySettings => doc.consistency ?? {};
/** The page's full frame style (each missing field is its DEFAULT_FRAME_STYLE value). */
export const frameStyleOf = (page: Pick<Page, 'frameStyle'>): FrameStyle => (page.frameStyle ? { ...DEFAULT_FRAME_STYLE, ...page.frameStyle } : DEFAULT_FRAME_STYLE);
export const layersOf = (page: Pick<Page, 'layers'>): PageLayer[] => page.layers ?? [];

const usableBox = (b: unknown): b is Box =>
  isObject(b) && finite(b.x) && finite(b.y) && finite(b.w) && finite(b.h) && b.w > 0 && b.h > 0 && b.x >= -1e-9 && b.y >= -1e-9 && b.x + b.w <= 1 + 1e-6 && b.y + b.h <= 1 + 1e-6;

/** The page shape the panel helpers read (artMode is optional: a page without it is shown as drawn). */
export type PanelPageShape = Pick<Page, 'panels' | 'render'> & Partial<Pick<Page, 'artMode' | 'id'>>;

/**
 * The cut of the page's CURRENT drawing that shows this panel: the cut naming its id, else — when no cut names any
 * panel — the cut at the panel's index. Undefined when the drawing has no cuts (a new drawing clears them, I3).
 */
export const cutFor = (page: Pick<Page, 'panels' | 'render'>, panel: Pick<Panel, 'id'> | string): PanelCut | undefined => {
  const cuts = page?.render?.cuts?.cuts;
  if (!Array.isArray(cuts) || !cuts.length) return undefined;
  const id = typeof panel === 'string' ? panel : panel?.id;
  const named = cuts.find((c) => isObject(c) && c.panelId === id && usableBox(c.box));
  if (named) return named;
  if (cuts.some((c) => isObject(c) && c.panelId)) return undefined;
  const index = (page.panels || []).findIndex((p) => p.id === id);
  const at = index >= 0 ? cuts[index] : undefined;
  return at && usableBox(at.box) ? at : undefined;
};

/**
 * How the page is shown (I2): 'panels' only when the page opted in (artMode 'panels'), every panel has a usable frame,
 * and the frames that show the page's own drawing can be cut from it — the drawing exists, it carries cuts, and at
 * least one of those panels has its cut (a panel without one is an empty frame). Anything missing or inconsistent
 * (a redraw cleared the cuts, a frame is broken, no panels) falls back to 'page': the drawing as drawn, never a crash
 * or a blank page.
 */
export const artModeOf = (page: PanelPageShape | null | undefined): ArtMode => {
  if (!page || page.artMode !== 'panels') return 'page';
  const panels = Array.isArray(page.panels) ? page.panels : [];
  if (!panels.length || !panels.every((p) => isObject(p) && isObject(p.frame) && usableBox(p.frame.box))) return 'page';
  const raster = panels.filter((p) => !(isObject(p.frame!.src) && typeof p.frame!.src.path === 'string' && p.frame!.src.path));
  if (!raster.length) return 'panels';
  const cuts = page.render?.cuts;
  if (!page.render?.asset?.path || !cuts || !Array.isArray(cuts.cuts) || !cuts.cuts.length) return 'page';
  return raster.some((p) => !!cutFor(page, p)) ? 'panels' : 'page';
};

/**
 * Storage paths a page's panel objects show besides its drawing: frame sources (another take, an image) and image
 * overlays. `printOnly` leaves out guide-only overlays (print: false), which readers and exports never draw.
 */
export const pageSourcePaths = (page: Pick<Page, 'panels' | 'layers'>, opts: { printOnly?: boolean } = {}): string[] => {
  const out: string[] = [];
  const add = (path: unknown) => {
    if (typeof path === 'string' && path && !out.includes(path)) out.push(path);
  };
  for (const panel of page?.panels || []) add(panel?.frame?.src?.path);
  for (const layer of page?.layers || []) if (!(opts.printOnly && layer?.print === false)) add(layer?.src?.path);
  return out;
};

/** Every frame-source and overlay path of the doc mapped by fn (live and trashed pages). Returns the SAME doc when
 *  fn changed nothing. The companion of mapAssetRefs for server path rewrites: these are plain paths, not AssetRefs. */
export const mapPanelSourcePaths = (doc: ComicDoc, fn: (path: string) => string): ComicDoc => {
  let changed = false;
  const mapPage = (page: Page): Page => {
    let panels = page.panels;
    page.panels.forEach((panel, i) => {
      const path = panel.frame?.src?.path;
      if (!path) return;
      const next = fn(path);
      if (next === path) return;
      if (panels === page.panels) panels = page.panels.slice();
      panels[i] = { ...panel, frame: { ...panel.frame!, src: { ...panel.frame!.src!, path: next } } };
    });
    let layers = page.layers;
    page.layers?.forEach((layer, i) => {
      const path = layer.src?.path;
      if (!path) return;
      const next = fn(path);
      if (next === path) return;
      if (layers === page.layers) layers = page.layers!.slice();
      layers![i] = { ...layer, src: { ...layer.src!, path: next } };
    });
    if (panels === page.panels && layers === page.layers) return page;
    changed = true;
    return { ...page, panels, ...(layers ? { layers } : {}) };
  };
  const pages = doc.pages.map(mapPage);
  const trash = doc.trash?.map((t) => {
    const page = mapPage(t.page);
    return page === t.page ? t : { ...t, page };
  });
  if (!changed) return doc;
  const out: ComicDoc = { ...doc, pages: pages.some((p, i) => p !== doc.pages[i]) ? pages : doc.pages };
  if (doc.trash !== undefined) out.trash = trash && trash.some((t, i) => t !== doc.trash![i]) ? trash : doc.trash;
  return out;
};

// ── Cast helpers ─────────────────────────────────────────────────────────────

export const castKindOf = (c: Character): CastKind => c.kind ?? 'person';
/** Derived label (no new tier): recurring non-human with a sheet. */
export const isCompanion = (c: Character): boolean => castKindOf(c) !== 'person' && c.tier !== 'extra';

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
/** "three Ducklings" / "Frog" (English number words 2–12, digits otherwise). */
export const castNoun = (c: Character): string => {
  const name = (c.name || '').trim() || 'Unnamed';
  const count = typeof c.count === 'number' && Number.isFinite(c.count) ? Math.floor(c.count) : 1;
  if (count <= 1) return name;
  return `${count <= 12 ? NUMBER_WORDS[count] : String(count)} ${name}`;
};

// ── Lookups ──────────────────────────────────────────────────────────────────

export const findCharacter = (doc: ComicDoc, id?: string) => (id ? doc.cast.find((c) => c.id === id) : undefined);
export const findPlace = (doc: ComicDoc, id?: string) => (id ? doc.places.find((p) => p.id === id) : undefined);
export const findPage = (doc: ComicDoc, id?: string) => (id ? doc.pages.find((p) => p.id === id) : undefined);
export const pageByNumber = (doc: ComicDoc, n: number) => doc.pages.find((p) => p.n === n);

/** Case-insensitive character lookup by name (or id), for tool calls that name characters. */
export const resolveCharacter = (doc: ComicDoc, nameOrId?: string): Character | undefined => {
  if (!nameOrId) return undefined;
  const key = nameOrId.trim().toLowerCase();
  return doc.cast.find((c) => c.id === nameOrId || c.name.trim().toLowerCase() === key);
};

/** The render state a target points at (undefined when the target no longer exists). */
export const getRender = (doc: ComicDoc, target: RenderTarget): RenderState | undefined => {
  switch (target.kind) {
    case 'page':
      return findPage(doc, target.id)?.render;
    case 'cover':
      return doc.cover.render;
    case 'sheet':
      return findCharacter(doc, target.id)?.sheet;
    case 'place':
      return findPlace(doc, target.id)?.sheet;
    case 'style_option':
      return doc.style.options.find((o) => o.id === target.id)?.render;
    default:
      return undefined;
  }
};

export const renderTargetKey = (target: RenderTarget): string =>
  target.kind === 'cover' ? 'cover' : `${target.kind}:${target.id}`;

/** Inverse of renderTargetKey. */
export const parseTargetKey = (key: string): RenderTarget | null => {
  if (key === 'cover') return { kind: 'cover' };
  const m = /^(page|sheet|place|style_option):(.+)$/.exec(typeof key === 'string' ? key : '');
  if (!m) return null;
  return { kind: m[1] as 'page' | 'sheet' | 'place' | 'style_option', id: m[2] };
};

/** "Page 3" | "Cover" | "MAYA sheet" | "DOCKS" | "Style option". */
export const targetLabel = (doc: ComicDoc, target: RenderTarget): string => {
  switch (target.kind) {
    case 'page': {
      const p = findPage(doc, target.id);
      return p ? `Page ${p.n}` : 'Page';
    }
    case 'cover':
      return 'Cover';
    case 'sheet': {
      const c = findCharacter(doc, target.id);
      return c ? `${c.name.toUpperCase()} sheet` : 'Character sheet';
    }
    case 'place': {
      const p = findPlace(doc, target.id);
      return p ? p.name.toUpperCase() : 'Place';
    }
    default:
      return 'Style option';
  }
};

const metaOfRender = (r: RenderState): VersionMeta => {
  const out: Record<string, unknown> = {};
  for (const k of VERSION_META_KEYS) if (r[k] !== undefined && r[k] !== null) out[k] = r[k];
  return out as VersionMeta;
};

/** Current asset as a version (with RenderState meta) first, then history. */
export const versionsOf = (r: RenderState): RenderVersion[] => {
  const current = currentVersion(r);
  return current ? [current, ...r.history] : [...r.history];
};
export const currentVersion = (r: RenderState): RenderVersion | undefined =>
  r.asset ? { ...r.asset, ...metaOfRender(r) } : undefined;

/** Smallest variant with w ≥ minW, else the asset itself. */
export const thumbOf = (asset: AssetRef | undefined, minW = 320): { path: string; w?: number; h?: number } | undefined => {
  if (!asset) return undefined;
  const v = (asset.variants || []).filter((x) => x && x.w >= minW).sort((a, b) => a.w - b.w)[0];
  return v ? { path: v.path, w: v.w, h: v.h } : { path: asset.path, w: asset.w, h: asset.h };
};
/** Variant for a display box: smallest with w ≥ cssWidth × min(dpr, 2), else the original. */
export const variantFor = (asset: AssetRef, cssWidth: number, dpr = 1): { path: string; w?: number; h?: number } => {
  const need = Math.max(0, cssWidth) * Math.min(Math.max(dpr || 1, 1), 2);
  const v = (asset.variants || []).filter((x) => x && x.w >= need).sort((a, b) => a.w - b.w)[0];
  return v ? { path: v.path, w: v.w, h: v.h } : { path: asset.path, w: asset.w, h: asset.h };
};

// ── Asset traversal ──────────────────────────────────────────────────────────

/** Every AssetRef in the doc mapped by fn (used by asset_meta and server path rewrites).
 *  Visits: style.refs, style.board, style.options[].render, cast[].refs/sheet, places[].refs/sheet,
 *  pages[].render, cover.render, archive[], trash[].page.render, refInbox[], conversation[].attachments.
 *  RenderState = asset + history[]. Returns the SAME doc object when fn changed nothing. */
export const mapAssetRefs = (doc: ComicDoc, fn: (a: AssetRef) => AssetRef): ComicDoc => {
  let changed = false;
  const one = <T extends AssetRef>(a: T | undefined): T | undefined => {
    if (!a) return a;
    const next = fn(a) as T;
    if (next !== a) changed = true;
    return next;
  };
  const list = <T extends AssetRef>(arr: T[] | undefined): T[] | undefined => {
    if (!arr) return arr;
    let local = false;
    const out = arr.map((a) => {
      const n = one(a)!;
      if (n !== a) local = true;
      return n;
    });
    return local ? out : arr;
  };
  const render = (r: RenderState): RenderState => {
    const asset = one(r.asset);
    const history = list(r.history)!;
    return asset !== r.asset || history !== r.history ? { ...r, asset, history } : r;
  };
  const styleRefs = list(doc.style.refs)!;
  const board = one(doc.style.board);
  const options = doc.style.options.map((o) => {
    const r = render(o.render);
    return r === o.render ? o : { ...o, render: r };
  });
  const optionsChanged = options.some((o, i) => o !== doc.style.options[i]);
  const cast = doc.cast.map((c) => {
    const refs = list(c.refs)!;
    const sheet = render(c.sheet);
    return refs === c.refs && sheet === c.sheet ? c : { ...c, refs, sheet };
  });
  const places = doc.places.map((p) => {
    const refs = list(p.refs)!;
    const sheet = render(p.sheet);
    return refs === p.refs && sheet === p.sheet ? p : { ...p, refs, sheet };
  });
  const pages = doc.pages.map((p) => {
    const r = render(p.render);
    return r === p.render ? p : { ...p, render: r };
  });
  const coverRender = render(doc.cover.render);
  const archive = list(doc.archive);
  const trash = doc.trash?.map((t) => {
    const r = render(t.page.render);
    return r === t.page.render ? t : { ...t, page: { ...t.page, render: r } };
  });
  const refInbox = list(doc.refInbox);
  const conversation = doc.conversation.map((m) => {
    const attachments = list(m.attachments);
    return attachments === m.attachments ? m : { ...m, attachments };
  });
  if (!changed) return doc;
  const out: ComicDoc = {
    ...doc,
    style: styleRefs !== doc.style.refs || board !== doc.style.board || optionsChanged
      ? { ...doc.style, refs: styleRefs, ...(doc.style.board || board ? { board } : {}), options: optionsChanged ? options : doc.style.options }
      : doc.style,
    cast: cast.some((c, i) => c !== doc.cast[i]) ? cast : doc.cast,
    places: places.some((p, i) => p !== doc.places[i]) ? places : doc.places,
    pages: pages.some((p, i) => p !== doc.pages[i]) ? pages : doc.pages,
    cover: coverRender === doc.cover.render ? doc.cover : { ...doc.cover, render: coverRender },
    conversation: conversation.some((m, i) => m !== doc.conversation[i]) ? conversation : doc.conversation
  };
  if (doc.archive !== undefined) out.archive = archive;
  if (doc.trash !== undefined) out.trash = trash && trash.some((t, i) => t !== doc.trash![i]) ? trash : doc.trash;
  if (doc.refInbox !== undefined) out.refInbox = refInbox;
  return out;
};

/** Every storage path the doc references (GC protection, /urls allow-list, export). Ship 2: frame sources and
 *  overlay images too (on live and trashed pages) — the server sanitizer admits only this comic's own server art there. */
export const collectAssetPaths = (doc: ComicDoc): string[] => {
  const out = new Set<string>();
  const add = (a?: AssetRef | RefAsset) => {
    if (!a?.path) return;
    out.add(a.path);
    a.variants?.forEach((v) => v?.path && out.add(v.path));
    const original = (a as RefAsset).original;
    if (original?.path) out.add(original.path);
  };
  const addRender = (r?: RenderState) => {
    if (!r) return;
    add(r.asset);
    r.history.forEach(add);
  };
  doc.style.refs.forEach(add);
  add(doc.style.board);
  doc.style.options.forEach((o) => addRender(o.render));
  doc.cast.forEach((c) => {
    c.refs.forEach(add);
    addRender(c.sheet);
  });
  doc.places.forEach((p) => {
    p.refs.forEach(add);
    addRender(p.sheet);
  });
  doc.pages.forEach((p) => addRender(p.render));
  addRender(doc.cover.render);
  doc.conversation.forEach((m) => m.attachments?.forEach(add));
  archiveOf(doc).forEach(add);
  trashOf(doc).forEach((t) => addRender(t.page.render));
  refInboxOf(doc).forEach(add);
  // Ship 2 (K2a): frame sources and image overlays are GC-protected on live and trashed pages (guide-only ones too).
  doc.pages.forEach((p) => pageSourcePaths(p).forEach((path) => out.add(path)));
  trashOf(doc).forEach((t) => pageSourcePaths(t.page).forEach((path) => out.add(path)));
  return [...out];
};

/** What GET /projects/:id signs eagerly: current assets (+variants) of pages, cover, sheets, places,
 *  style options, style.board, every ref (+original), refInbox, conversation attachments, and (Ship 2) the frame
 *  sources and overlays of live pages.
 *  NOT history/archive/trash (signed lazily through POST /projects/:id/urls). */
export const displayAssetPaths = (doc: ComicDoc): string[] => {
  const out = new Set<string>();
  const add = (a?: AssetRef | RefAsset) => {
    if (!a?.path) return;
    out.add(a.path);
    a.variants?.forEach((v) => v?.path && out.add(v.path));
    const original = (a as RefAsset).original;
    if (original?.path) out.add(original.path);
  };
  doc.style.refs.forEach(add);
  add(doc.style.board);
  doc.style.options.forEach((o) => add(o.render.asset));
  doc.cast.forEach((c) => {
    c.refs.forEach(add);
    add(c.sheet.asset);
  });
  doc.places.forEach((p) => {
    p.refs.forEach(add);
    add(p.sheet.asset);
  });
  doc.pages.forEach((p) => add(p.render.asset));
  add(doc.cover.render.asset);
  refInboxOf(doc).forEach(add);
  doc.conversation.forEach((m) => m.attachments?.forEach(add));
  // Ship 2 (K2a): what a live page's frames and overlays show (the editor draws guide-only overlays too).
  doc.pages.forEach((p) => pageSourcePaths(p).forEach((path) => out.add(path)));
  return [...out];
};

// ── Spec hashes (R2: invariance for pageSpecHash) ────────────────────────────
//
// Back-compat F1 (plan §5.1): every spec hash serialises its tuple with stableStringify (object keys sorted
// at every depth, array order kept), so the hash never depends on key order. The TUPLES are unchanged — no
// field was added or removed — so nothing new is hashed (I1). Postgres jsonb reorders object keys on save,
// and the earlier JSON.stringify hashes made drawn pages read "Out of date" after a reload. Renders stamped
// before F1 carry that legacy serialisation: session.ts recoveryOps accepts them once per load (legacySpecHashFor
// over a few key-order variants) and re-stamps the canonical hash; a genuine edit matches no variant and stays
// stale, honestly.

/** Keys that never affect drawn art. Lines without them keep object identity → identical JSON. */
const hashableLine = (l: Line): Line => {
  if (l.style === undefined && l.lang === undefined && l.noTranslate === undefined) return l;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { style: _s, lang: _l, noTranslate: _n, ...rest } = l; // insertion order of the rest is preserved
  return rest as Line;
};

/** CharacterLook keys in the order the writer and the director tools build a look (legacy acceptance). */
export const CHARACTER_LOOK_KEYS = [
  'summary', 'age', 'gender', 'build', 'face', 'hair', 'eyes', 'skin', 'outfit', 'palette', 'props', 'marks', 'species', 'markings'
] as const satisfies readonly (keyof CharacterLook)[];

const pageSpecTuple = (doc: ComicDoc, page: Page): unknown[] => {
  const castIds = new Set(page.panels.flatMap((p) => p.castIds));
  const cast = doc.cast
    .filter((c) => castIds.has(c.id))
    .map((c) =>
      c.count && c.count > 1
        ? [c.id, c.look, c.sheet.asset?.path || '', c.count] // groups only; absent/1 ⇒ old tuple
        : [c.id, c.look, c.sheet.asset?.path || '']
    )
    .sort();
  const lettering = doc.format.lettering === 'in_art' ? page.panels.map((p) => p.lines.map(hashableLine)) : [];
  return [
    page.layout,
    page.panels.map((p) => [p.size, p.shot, p.angle, p.action, p.castIds, p.placeId, p.mood]),
    lettering,
    cast,
    doc.style.spec,
    doc.style.board?.path,
    doc.format.pageAspect,
    doc.format.colorMode,
    doc.format.lettering
  ];
};

/**
 * Fingerprint of everything a page render depends on. When it changes after a
 * render, the page is shown as "stale" (out of date with its script) — never
 * silently re-rendered. Key-order independent (F1).
 */
export const pageSpecHash = (doc: ComicDoc, page: Page): string => hashString(stableStringify(pageSpecTuple(doc, page)));

/** Pages whose current render no longer matches their spec. */
export const isPageStale = (doc: ComicDoc, page: Page): boolean =>
  page.render.status === 'ready' && !!page.render.specHash && page.render.specHash !== pageSpecHash(doc, page);

/** Leads (else supports) + companions ranked by panel appearances; if none, extras by appearances. ≤ 6.
 *  prompts.ts takes .slice(0, spec.refs.characters); the hash uses this list. */
export const coverCastOf = (doc: ComicDoc): Character[] => {
  const appearances = new Map<string, number>();
  for (const page of doc.pages) for (const panel of page.panels) for (const id of panel.castIds) appearances.set(id, (appearances.get(id) || 0) + 1);
  const rank = (list: Character[]) =>
    list
      .map((c, i) => ({ c, i, n: appearances.get(c.id) || 0 }))
      .sort((a, b) => b.n - a.n || a.i - b.i)
      .map((x) => x.c);
  const leads = doc.cast.filter((c) => c.tier === 'lead');
  const primary = leads.length ? leads : doc.cast.filter((c) => c.tier === 'support');
  const chosen = new Set(primary.map((c) => c.id));
  const picked = doc.cast.filter((c) => chosen.has(c.id) || isCompanion(c));
  const list = picked.length ? rank(picked) : rank(doc.cast.filter((c) => c.tier === 'extra' && (appearances.get(c.id) || 0) > 0));
  return list.slice(0, 6);
};

const sheetSpecTuple = (doc: ComicDoc, c: Character): unknown[] => ['sheet/1', c.look, castKindOf(c), c.count ?? 1, doc.style.spec, doc.style.board?.path, doc.format.colorMode];
const placeSpecTuple = (doc: ComicDoc, p: Place): unknown[] => ['place/1', p.look, doc.style.spec, doc.style.board?.path, doc.format.colorMode];
const coverSpecTuple = (doc: ComicDoc): unknown[] => {
  const lettering = doc.cover.lettering ?? 'in_art';
  return [
    'cover/1',
    lettering,
    lettering === 'in_art' ? [doc.cover.title ?? doc.brief.title, doc.cover.tagline ?? ''] : [], // overlay titles are software
    doc.cover.direction ?? '',
    coverCastOf(doc).map((c) => [c.id, c.look, c.sheet.asset?.path || '', c.count ?? 1]),
    doc.style.spec,
    doc.style.board?.path,
    doc.format.pageAspect,
    doc.format.colorMode
  ];
};

export const sheetSpecHash = (doc: ComicDoc, c: Character): string => hashString(stableStringify(sheetSpecTuple(doc, c)));
export const placeSpecHash = (doc: ComicDoc, p: Place): string => hashString(stableStringify(placeSpecTuple(doc, p)));
export const coverSpecHash = (doc: ComicDoc): string => hashString(stableStringify(coverSpecTuple(doc)));

/** The spec tuple of a target (style_option and missing targets → undefined). */
const specTupleFor = (doc: ComicDoc, target: RenderTarget): unknown[] | undefined => {
  switch (target.kind) {
    case 'page': {
      const page = findPage(doc, target.id);
      return page ? pageSpecTuple(doc, page) : undefined;
    }
    case 'cover':
      return coverSpecTuple(doc);
    case 'sheet': {
      const c = findCharacter(doc, target.id);
      return c ? sheetSpecTuple(doc, c) : undefined;
    }
    case 'place': {
      const p = findPlace(doc, target.id);
      return p ? placeSpecTuple(doc, p) : undefined;
    }
    default:
      return undefined;
  }
};

/**
 * Back-compat F1: the hash a render stamped BEFORE F1 would carry for this doc — the same tuple through
 * JSON.stringify, so it follows the doc's own object key order. Only the load-time legacy acceptance
 * (session.ts recoveryOps) reads it, over key-order variants of the doc; staleness never does.
 */
export const legacySpecHashFor = (doc: ComicDoc, target: RenderTarget): string | undefined => {
  const tuple = specTupleFor(doc, target);
  return tuple ? hashString(JSON.stringify(tuple)) : undefined;
};

const planInputTuple = (doc: ComicDoc): unknown[] => [
  'plan/1',
  doc.brief,
  doc.cast.map((c) => [c.id, c.name, c.tier, c.look, c.kind ?? 'person', c.count ?? 1, c.role ?? '', c.personality ?? '', c.voice ?? '']),
  doc.places.map((p) => [p.id, p.name, p.look]),
  hashString(doc.source.script || ''),
  doc.format
];

/**
 * R5: fingerprint of everything the writer reads for a full plan (brief + notes, cast names and looks, places,
 * the source script, the format). Unchanged + no instructions ⇒ the existing plan is returned for free.
 * Key-order independent (F1), so a save and reload never turns a free re-plan into a billed one.
 */
export const planInputHashOf = (doc: ComicDoc): string => hashString(stableStringify(planInputTuple(doc)));

/** Back-compat F1: planInputHashOf as it was stamped before F1 (JSON.stringify; the doc's own key order). */
export const legacyPlanInputHashOf = (doc: ComicDoc): string => hashString(JSON.stringify(planInputTuple(doc)));

/** The current spec hash of a target (style_option and missing targets → undefined). */
export const specHashFor = (doc: ComicDoc, target: RenderTarget): string | undefined => {
  switch (target.kind) {
    case 'page': {
      const page = findPage(doc, target.id);
      return page ? pageSpecHash(doc, page) : undefined;
    }
    case 'cover':
      return coverSpecHash(doc);
    case 'sheet': {
      const c = findCharacter(doc, target.id);
      return c ? sheetSpecHash(doc, c) : undefined;
    }
    case 'place': {
      const p = findPlace(doc, target.id);
      return p ? placeSpecHash(doc, p) : undefined;
    }
    default:
      return undefined;
  }
};

/** ready && render.specHash && render.specHash !== specHashFor(...). Pages: identical to isPageStale. */
export const isTargetStale = (doc: ComicDoc, target: RenderTarget): boolean => {
  const r = getRender(doc, target);
  if (!r || r.status !== 'ready' || !r.specHash) return false;
  const want = specHashFor(doc, target);
  return want !== undefined && r.specHash !== want;
};

export const totalPanels = (doc: ComicDoc) => doc.pages.reduce((n, p) => n + p.panels.length, 0);

let idCounter = 0;
/** Short unique id (prefix_random). Safe on server and client. Never called inside applyOp (R5). */
export const newId = (prefix: string): string => {
  idCounter = (idCounter + 1) % 1679616;
  // Typed locally: workers-types (the api-proxy Worker's strict typecheck) has no `globalThis.crypto`.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const rand = typeof c !== 'undefined' && 'randomUUID' in c ? c.randomUUID!().replace(/-/g, '').slice(0, 10) : Math.random().toString(36).slice(2, 12);
  return `${prefix}_${rand}${idCounter.toString(36)}`;
};
