// Client-patch sanitizers "panels" (pro plan §5.3; K2b). Owner: K2b.
//
//   page_frames · page_cuts · panels_order · panel_add · panel_remove · layer
//
// Every op is FREE: frames, cuts, panel structure and overlays move what is already drawn; nothing is redrawn and no
// asset is created (I10). A sanitizer rebuilds the op from known keys with bounded values, or throws a StudioError that
// rejects the WHOLE batch:
//   400  malformed (an out-of-range or NaN box, a non-hex colour, an unknown panel, 13 cuts, a line of another page …);
//   409  CONFLICT (cuts for a drawing that is no longer the page's), LIMIT (25 overlays, 3 extra pictures),
//        CONTENT_POLICY (a blocked image);
// Image paths (frame.src, layer.src) follow the `render_use` rule (sanitize/timeline.ts) because collectAssetPaths trusts
// them for /urls signing and GC: an image this comic already holds (assetIndex), not blocked, written by the server for
// THIS comic (isServerArtForComic) and publishable (isServerArt). The page's own current drawing is always allowed as a
// frame source and is not an extra picture (ops.ts extraSourceCount).
//
// page_cuts provenance (wave note K2b-5, B9-12): the server never trusts a client's `by`. `keepBy` (the undo inverse that
// puts the detector's cuts back) keeps the incoming `by` only when the cuts deep-equal cuts the SERVER stamped for that
// same drawing, from what the doc durably holds — the page's current cuts while they are still server-stamped, a version
// of that same drawing in render.history (its VersionMeta.cuts) — or from this process's record (STAMPED_CUTS, remembered
// the moment a client first replaces them; lost on a restart). A claim the server can't prove (an Undo after the backend
// slept or redeployed — undo stacks outlive the process) is NOT refused: the keepBy is dropped and the cuts are written
// as the user's (by 'user'), the documented K2a fallback. Undo always works, a client never sets `by`, and the committed
// op (without keepBy) brings the client's mirror to the same value.
//
// Sanitizers see the doc as the batch has built it so far (jobs.ts sanitizePatchOps `working`), so a panel added earlier
// in the batch exists for the frames, cuts and overlays after it.
//
// Pro Edit (master plan §2.3 "Sanitizers", §5 Security; PE-SERVER). The new fields ride the existing ops: an effect overlay
// (`layer` kind 'effect' + `fx`), a library sticker (`src.lib`), `blend`, a frame border's `style` and `seed`, and a new
// line's named style (`styleId`, panel_add). A client may write a NEW value of any of them only while
// PRO_EDIT_OPS_PATCHABLE (shared/comic/ops.ts) is on; off, the server refuses exactly as before PE-SERVER (an effect is
// "an unknown overlay kind", the other keys are dropped). Either way a client may RE-ASSERT a value the doc already
// holds (an undo, a move of an overlay a newer build wrote, the editor's spread of the stored frame), never add or
// change one, so an edit never drops what it did not touch (rollback hazard: a frame edit keeps its border look). With
// the switch on:
//   - an effect's `gen@v` must be registered (fx/registry.ts) and every parameter fit its schema (an unknown setting, a
//     number out of range, an enum it does not list, a colour that is not #RRGGBB, the wrong kind: 400); the effect is
//     at most FX_LIMITS.fxBytes; `fx` belongs to an effect overlay only;
//   - a library sticker is refused with a calm reason: there is no catalogue the server knows until PE-ASSETS (S3), and
//     stickers resolve only against one (collisions C-10);
//   - `blend` is one of LAYER_BLENDS; a border look one of PANEL_BORDER_STYLES with an int32 seed.
// A layer of a kind this build does not know (opaque; written by a newer build) is never client-writable: a patch to one
// is refused (its delete is accepted and the op leaves it as written: PE-0).

import {
  LAYER_BLENDS,
  LAYER_ID_RE,
  PANEL_BORDER_STYLES,
  isKnownLayerKind,
  isOpaqueLayer,
  normalizeLayerFx,
  normalizePageLayer,
  normalizePanelCuts,
  normalizePanelFrame,
  type Box,
  type ComicDoc,
  type Line,
  type LineKind,
  type Page,
  type PageLayer,
  type Panel,
  type PanelCuts,
  type PanelFrame,
  type PanelSize,
  type ShotType
} from '../../../../shared/comic/doc.js';
import { normalizeAssetLibRef, sameLibRef } from '../../../../shared/comic/assets/index.js';
import { FX_GEN_RE, FX_PARAM_KEY_RE, fxGeneratorFor, fxParamsOf, fxWithinBudget, type FxParamValue, type LayerFx } from '../../../../shared/comic/fx/index.js';
import { hashString, stableStringify } from '../../../../shared/comic/hash.js';
import { sanitizeLetterStylePatch } from '../../../../shared/comic/lettering/style.js';
import { DOC_LIMITS, EDITOR_LIMITS, FX_LIMITS, PRO_PAGE_LIMITS } from '../../../../shared/comic/limits.js';
import { PRO_EDIT_OPS_PATCHABLE, SAFE_ID_RE, type DocOp, type LayerPatch, type PanelLineHome } from '../../../../shared/comic/ops.js';
import type { OpSanitizer, SanitizeCtx } from '../extensions.js';
import { isServerArt } from '../publication/snapshot.js';
import { StudioError } from '../types.js';
import { pageOf, safeIdOf, safeText, sanitizeDirection } from './consistency.js';
import { lineStyleIdOf } from './lettering.js';
import { clipText, enteredText, storableText } from './text.js';
import { OUTSIDE_IMAGE_MESSAGE, UNPUBLISHABLE_IMAGE_MESSAGE, assetIndex, isServerArtForComic, type AssetIndexEntry } from './timeline.js';

type Op<K extends DocOp['op']> = Extract<DocOp, { op: K }>;

const bad = (message: string) => new StudioError('BAD_REQUEST', message, { status: 400 });
const conflict = (message: string) => new StudioError('CONFLICT', message, { status: 409 });
const limit = (message: string) => new StudioError('LIMIT', message, { status: 409 });
const policy = (message: string) => new StudioError('CONTENT_POLICY', message, { status: 409 });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const int32 = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
/** How far past the page edge a box may reach (rounding of client geometry), as a page fraction. */
const EDGE_SLACK = 1e-4;

const PANEL_SIZES: readonly PanelSize[] = ['small', 'medium', 'large', 'wide', 'tall', 'splash'];
const SHOT_TYPES: readonly ShotType[] = ['establishing', 'wide', 'full', 'medium', 'close_up', 'extreme_close_up', 'over_shoulder', 'insert', 'pov'];
const LINE_KINDS: readonly LineKind[] = ['speech', 'thought', 'caption', 'sfx', 'whisper', 'shout'];
const SPOKEN: ReadonlySet<LineKind> = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);
/** Text lengths the core `panel` / `line` sanitizers use (jobs.ts), so a panel added here holds what an edit may write. */
const PANEL_TEXT = { action: 2000, angle: 200, mood: 200, line: 600 } as const;
const CAST_PER_PANEL = 12;

// ── Values ────────────────────────────────────────────────────────────────────

/** A '#RRGGBB' colour, or a 400 (no CSS names, no url(), no short forms). */
const hexColor = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !HEX_COLOR_RE.test(v)) throw bad(`Invalid ${what} colour (use #RRGGBB).`);
  return v;
};

/** A finite number in [lo, hi], or a 400 (NaN, Infinity, a string, out of range). */
const numberIn = (v: unknown, lo: number, hi: number, what: string): number => {
  if (!finite(v) || v < lo || v > hi) throw bad(`Invalid ${what}.`);
  return v;
};

/**
 * A box inside the page (unit square): finite, positive, inside [0, 1] (a hair of rounding allowed), each side at least
 * `minSide`. A box past the page edge, NaN or empty is refused (400), never silently moved.
 */
export const boxIn = (raw: unknown, minSide: number, what: string): Box => {
  if (!isObject(raw)) throw bad(`Invalid ${what}.`);
  const { x, y, w, h } = raw;
  if (!finite(x) || !finite(y) || !finite(w) || !finite(h)) throw bad(`Invalid ${what}: every edge must be a number.`);
  if (w <= 0 || h <= 0 || x < -EDGE_SLACK || y < -EDGE_SLACK || x + w > 1 + EDGE_SLACK || y + h > 1 + EDGE_SLACK) {
    throw bad(`Invalid ${what}: it must sit inside the page.`);
  }
  if (w < minSide - EDGE_SLACK || h < minSide - EDGE_SLACK) throw bad(`Invalid ${what}: it is too small.`);
  return { x, y, w, h };
};

const boolOf = (v: unknown, what: string): boolean => {
  if (typeof v !== 'boolean') throw bad(`Invalid ${what}.`);
  return v;
};

const intIn = (v: unknown, lo: number, hi: number, what: string): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < lo || v > hi) throw bad(`Invalid ${what}.`);
  return v;
};

// ── Image paths (the render_use rule) ─────────────────────────────────────────

// The render_use rule's own words (OUTSIDE_IMAGE_MESSAGE, UNPUBLISHABLE_IMAGE_MESSAGE from sanitize/timeline.ts; pro plan
// §5.3 "the render_use rule and messages").

/**
 * A frame or overlay image path a client may set: the page's own current drawing; or an image this comic already holds
 * (assetIndex: renders, versions, archive, deleted pages, uploads), not blocked, written by the server for THIS comic
 * and publishable. A foreign path, a client-writable lane (`<uid>/…`, `u/<uid>/tmp/…`), another project's image or a
 * planted `upload` in the public img lane is refused — the same rule and words as "Use for page".
 */
export const checkImagePath = (doc: ComicDoc, page: Page, path: unknown, ctx: SanitizeCtx, index: Map<string, AssetIndexEntry> = assetIndex(doc)): string => {
  if (typeof path !== 'string' || !path || path.length > 512) throw bad('Pick a picture.');
  if (path === page.render.asset?.path) {
    const own = index.get(path);
    if (own?.blocked) throw policy("That image didn't pass the content check, so it can't be used.");
    return path;
  }
  const entry = index.get(path);
  if (!entry) throw bad("That image isn't part of this comic.");
  if (entry.blocked) throw policy("That image didn't pass the content check, so it can't be used.");
  if (!isServerArtForComic(path, doc, ctx?.userId)) throw bad(OUTSIDE_IMAGE_MESSAGE);
  if (!isServerArt(entry.asset)) throw bad(UNPUBLISHABLE_IMAGE_MESSAGE);
  return path;
};

/** Pictures a page's frames show besides its own drawing (ops.ts extraSourceCount: the page's asset never counts). */
export const extraSources = (page: Pick<Page, 'panels' | 'render'>): number =>
  new Set(page.panels.map((p) => p.frame?.src?.path).filter((path): path is string => !!path && path !== page.render.asset?.path)).size;

const sourcesLimitError = () =>
  limit(`A page's panels can show pictures from at most ${EDITOR_LIMITS.sourcesPerPage} other images — use one already on the page, or remove one first.`);

// ── Frames ────────────────────────────────────────────────────────────────────

/**
 * A client frame: every field checked (box inside the page, fit in range, hex colours, a servable src), then normalized.
 * `stored` is the panel's frame as the doc holds it: its border look (`style`, `seed`; Pro Edit) is carried through, so
 * a frame edit never drops it. A client sets a new look only while PRO_EDIT_OPS_PATCHABLE is on.
 */
export const frameOf = (doc: ComicDoc, page: Page, raw: unknown, ctx: SanitizeCtx, index?: Map<string, AssetIndexEntry>, stored?: PanelFrame): PanelFrame => {
  if (!isObject(raw)) throw bad('Invalid panel frame.');
  const out: Record<string, unknown> = { box: boxIn(raw.box, EDITOR_LIMITS.frameMin, 'panel frame') };
  if (raw.fit !== undefined && raw.fit !== null) {
    if (!isObject(raw.fit)) throw bad('Invalid panel crop.');
    out.fit = {
      s: numberIn(raw.fit.s, 1, EDITOR_LIMITS.fitZoomMax, 'panel zoom'),
      x: numberIn(raw.fit.x, -1, 1, 'panel crop'),
      y: numberIn(raw.fit.y, -1, 1, 'panel crop')
    };
  }
  if (raw.src !== undefined && raw.src !== null) {
    if (!isObject(raw.src)) throw bad('Invalid panel picture.');
    const src: Record<string, unknown> = { path: checkImagePath(doc, page, raw.src.path, ctx, index) };
    if (raw.src.box !== undefined && raw.src.box !== null) src.box = boxIn(raw.src.box, PRO_PAGE_LIMITS.boxMin, 'picture crop');
    out.src = src;
  }
  if (raw.border !== undefined && raw.border !== null) {
    if (!isObject(raw.border)) throw bad('Invalid panel border.');
    const border: Record<string, unknown> = {};
    if (raw.border.none !== undefined) {
      if (raw.border.none !== true) throw bad('Invalid panel border.');
      border.none = true;
    }
    if (raw.border.w !== undefined) border.w = numberIn(raw.border.w, 0, PRO_PAGE_LIMITS.frameBorderMax, 'border width');
    if (raw.border.color !== undefined) border.color = hexColor(raw.border.color, 'border');
    Object.assign(border, borderLookOf(raw.border, stored));
    out.border = border;
  } else {
    // No border sent: with the switch off the panel still keeps its stored look (drawn at the page's border width).
    const look = borderLookOf({}, stored);
    if (Object.keys(look).length) out.border = look;
  }
  if (raw.z !== undefined && raw.z !== null) out.z = intIn(raw.z, -PRO_PAGE_LIMITS.zMax, PRO_PAGE_LIMITS.zMax, 'panel stacking order');
  if (raw.locked !== undefined && raw.locked !== null) {
    if (raw.locked !== true) throw bad('Invalid panel lock.');
    out.locked = true;
  }
  const frame = normalizePanelFrame(out);
  if (!frame) throw bad('Invalid panel frame.');
  return frame;
};

/**
 * The border look a frame takes (Pro Edit). With PRO_EDIT_OPS_PATCHABLE on, the client's frame is the whole truth (the
 * editor spreads the stored frame, and an undo sends the old frame back exactly): `style` one of PANEL_BORDER_STYLES and
 * `seed` an int32 when sent, absent otherwise. Off, a client can neither add nor change a look, and a frame edit never
 * drops one: the stored look is carried through whatever the client sent (rollback hazard, PE-0 wave note 4).
 */
const borderLookOf = (raw: Record<string, unknown>, stored: PanelFrame | undefined): Pick<NonNullable<PanelFrame['border']>, 'style' | 'seed'> => {
  const out: Pick<NonNullable<PanelFrame['border']>, 'style' | 'seed'> = {};
  if (PRO_EDIT_OPS_PATCHABLE) {
    if (raw.style !== undefined && raw.style !== null) {
      if (typeof raw.style !== 'string' || !(PANEL_BORDER_STYLES as readonly string[]).includes(raw.style)) throw bad('Invalid panel border look.');
      out.style = raw.style as NonNullable<PanelFrame['border']>['style'];
    }
    if (raw.seed !== undefined && raw.seed !== null) {
      if (!int32(raw.seed)) throw bad('Invalid panel border look.');
      out.seed = raw.seed;
    }
    return out;
  }
  if (stored?.border?.style) out.style = stored.border.style;
  if (stored?.border?.seed !== undefined) out.seed = stored.border.seed;
  return out;
};

/** A page's frame style: known keys only, numbers in range, hex colours. */
const frameStyleOf = (raw: unknown): Record<string, unknown> => {
  if (!isObject(raw)) throw bad('Invalid frame style.');
  const L = PRO_PAGE_LIMITS;
  const out: Record<string, unknown> = {};
  if (raw.gutter !== undefined) out.gutter = numberIn(raw.gutter, 0, L.frameGutterMax, 'gutter');
  if (raw.margin !== undefined) out.margin = numberIn(raw.margin, 0, L.frameMarginMax, 'page margin');
  if (raw.border !== undefined) out.border = numberIn(raw.border, 0, L.frameBorderMax, 'border width');
  if (raw.color !== undefined) out.color = hexColor(raw.color, 'border');
  if (raw.bg !== undefined) out.bg = hexColor(raw.bg, 'paper');
  if (raw.radius !== undefined) out.radius = numberIn(raw.radius, 0, L.frameRadiusMax, 'corner radius');
  if (!Object.keys(out).length) throw bad('Invalid frame style.');
  return out;
};

const pageFrames: OpSanitizer<Op<'page_frames'>> = {
  op: 'page_frames',
  sanitize(doc, op, ctx) {
    const page = pageOf(doc, op.pageId);
    const out: Op<'page_frames'> = { op: 'page_frames', pageId: page.id };
    if (hasOwn(op, 'artMode') && op.artMode !== undefined) {
      if (op.artMode !== 'panels' && op.artMode !== null) throw bad('Invalid page display.');
      out.artMode = op.artMode;
    }
    if (hasOwn(op, 'frameStyle') && op.frameStyle !== undefined) out.frameStyle = op.frameStyle === null ? null : (frameStyleOf(op.frameStyle) as Op<'page_frames'>['frameStyle']);
    if (op.frames !== undefined && op.frames !== null) {
      if (!Array.isArray(op.frames) || op.frames.length > DOC_LIMITS.panelsPerPage) throw bad('Invalid panel frames.');
      const index = assetIndex(doc);
      const seen = new Set<string>();
      const frames: { panelId: string; frame: PanelFrame | null }[] = [];
      for (const f of op.frames as unknown[]) {
        if (!isObject(f)) throw bad('Invalid panel frame.');
        const panelId = safeIdOf(f.panelId, 'panel');
        if (!page.panels.some((p) => p.id === panelId)) throw bad('That panel is no longer on the page.');
        if (seen.has(panelId)) throw bad('A panel appears twice in that change.');
        seen.add(panelId);
        const stored = page.panels.find((p) => p.id === panelId)?.frame;
        frames.push({ panelId, frame: f.frame === null || f.frame === undefined ? null : frameOf(doc, page, f.frame, ctx, index, stored) });
      }
      out.frames = frames;
      // ≤ EDITOR_LIMITS.sourcesPerPage extra pictures on the page as it will be (applyOp would silently refuse more).
      const next = { ...page, panels: page.panels.map((p) => (seen.has(p.id) ? { ...p, frame: frames.find((f) => f.panelId === p.id)!.frame ?? undefined } : p)) };
      if (extraSources(next) > EDITOR_LIMITS.sourcesPerPage) throw sourcesLimitError();
    }
    if (op.moveBalloons !== undefined) out.moveBalloons = boolOf(op.moveBalloons, 'balloon setting');
    if (out.artMode === undefined && out.frameStyle === undefined && out.frames === undefined) throw bad('Nothing to change in the panels.');
    return out;
  }
};

// ── Cuts (and their provenance) ──────────────────────────────────────────────

/** Cuts the server stamped, per drawing (`<projectId>|<path>` → hashes of the stamped values): bounded, process-local. */
const STAMPED_CUTS = new Map<string, string[]>();
/** Drawings remembered (oldest forgotten first) and stamped values kept per drawing. */
export const STAMPED_CUTS_MAX = 4000;
const STAMPED_PER_PATH = 6;

const cutsHash = (cuts: PanelCuts): string => hashString(stableStringify(cuts));
const stampKey = (doc: Pick<ComicDoc, 'id'>, path: string): string => `${doc.id}|${path}`;

/**
 * Remember cuts the server stamped on a drawing (the panelize seam, and any doc state the server itself holds: a
 * stored doc's cuts whose `by` is not 'user' were written by the server or accepted under this same rule).
 */
export const rememberStampedCuts = (doc: Pick<ComicDoc, 'id'>, path: string, cuts: PanelCuts | undefined): void => {
  if (!cuts || cuts.by === 'user' || !path) return;
  const normal = normalizePanelCuts(cuts);
  if (!normal) return;
  const key = stampKey(doc, path);
  const hash = cutsHash(normal);
  const list = STAMPED_CUTS.get(key) || [];
  if (list.includes(hash)) return;
  STAMPED_CUTS.delete(key);
  STAMPED_CUTS.set(key, [...list, hash].slice(-STAMPED_PER_PATH));
  while (STAMPED_CUTS.size > STAMPED_CUTS_MAX) STAMPED_CUTS.delete(STAMPED_CUTS.keys().next().value as string);
};

const stampedHash = (cuts: PanelCuts | undefined): string | null => {
  if (!cuts || cuts.by === 'user') return null;
  const normal = normalizePanelCuts(cuts);
  return normal ? cutsHash(normal) : null;
};

/**
 * Whether `cuts` deep-equal cuts the server stamped for this drawing (the keepBy rule). Durable sources first (the live
 * cuts while server-stamped; a version of the same drawing in render.history), then this process's record.
 */
export const isServerStampedCuts = (doc: Pick<ComicDoc, 'id'>, page: Pick<Page, 'render'>, path: string, cuts: PanelCuts): boolean => {
  if (cuts.by === 'user') return false;
  const hash = cutsHash(cuts);
  if (page.render.asset?.path === path && stampedHash(page.render.cuts) === hash) return true;
  if (page.render.history.some((v) => v.path === path && stampedHash(v.cuts) === hash)) return true;
  return (STAMPED_CUTS.get(stampKey(doc, path)) || []).includes(hash);
};

/** Test hook: forget every remembered stamp. */
export const __resetStampedCutsForTests = (): void => STAMPED_CUTS.clear();

const CUT_STATUSES = ['ok', 'unsure', 'mismatch'] as const;
const CUT_BY = ['detect', 'vision', 'both', 'user', 'estimate'] as const;

/** Client cuts: ≤ EDITOR_LIMITS.maxCuts, every box inside the drawing, ids of this page's panels, confidences in [0, 1]. */
const cutsOf = (page: Page, raw: unknown, ctx: SanitizeCtx): PanelCuts => {
  if (!isObject(raw)) throw bad('Invalid panel cuts.');
  if (!Array.isArray(raw.cuts)) throw bad('Invalid panel cuts.');
  if (raw.cuts.length > EDITOR_LIMITS.maxCuts) throw bad(`A drawing can be cut into at most ${EDITOR_LIMITS.maxCuts} panels.`);
  if (typeof raw.status !== 'string' || !(CUT_STATUSES as readonly string[]).includes(raw.status)) throw bad('Invalid panel cuts.');
  if (typeof raw.by !== 'string' || !(CUT_BY as readonly string[]).includes(raw.by)) throw bad('Invalid panel cuts.');
  if (!finite(raw.at)) throw bad('Invalid panel cuts.');
  const named = new Set<string>();
  const cuts = raw.cuts.map((c) => {
    if (!isObject(c)) throw bad('Invalid panel cut.');
    const cut: Record<string, unknown> = {
      drawn: intIn(c.drawn, 1, 99, 'panel cut'),
      box: boxIn(c.box, PRO_PAGE_LIMITS.boxMin, 'panel cut'),
      conf: numberIn(c.conf, 0, 1, 'cut confidence')
    };
    if (c.panelId !== undefined && c.panelId !== null) {
      const id = safeIdOf(c.panelId, 'panel');
      if (!page.panels.some((p) => p.id === id)) throw bad('A cut names a panel that is no longer on the page.');
      if (named.has(id)) throw bad('Two cuts name the same panel.');
      named.add(id);
      cut.panelId = id;
    }
    if (c.shows !== undefined && c.shows !== null) cut.shows = intIn(c.shows, 0, 99, 'panel cut');
    if (c.crosses !== undefined && c.crosses !== null) {
      if (c.crosses !== true) throw bad('Invalid panel cut.');
      cut.crosses = true;
    }
    return cut;
  });
  const out: Record<string, unknown> = { status: raw.status, by: raw.by, at: raw.at, cuts };
  if (raw.note !== undefined && raw.note !== null) {
    const note = safeText(raw.note, PRO_PAGE_LIMITS.cutNoteChars, ctx);
    if (note === undefined) throw bad('Invalid panel cuts note.');
    if (note) out.note = note;
  }
  const normal = normalizePanelCuts(out);
  if (!normal || normal.cuts.length !== cuts.length) throw bad('Invalid panel cuts.');
  return normal;
};

const pageCuts: OpSanitizer<Op<'page_cuts'>> = {
  op: 'page_cuts',
  sanitize(doc, op, ctx) {
    const page = pageOf(doc, op.pageId);
    const current = page.render.asset?.path;
    // Remember what the server stamped on this drawing before a client replaces it (the undo's keepBy needs it).
    if (current) rememberStampedCuts(doc, current, page.render.cuts);
    if (typeof op.path !== 'string' || !op.path) throw bad('Pick a drawing.');
    if (!current || op.path !== current) throw conflict('That page was redrawn since — its panels were not changed. Check the cuts on the new drawing.');
    const out: Op<'page_cuts'> = { op: 'page_cuts', pageId: page.id, path: current, cuts: op.cuts === null || op.cuts === undefined ? null : cutsOf(page, op.cuts, ctx) };
    if (op.keepBy !== undefined) {
      const keepBy = boolOf(op.keepBy, 'cut provenance');
      // Provenance is the server's: keepBy keeps a non-user `by` only for cuts it stamped on this very drawing. Clearing
      // the cuts, or cuts already the user's, claim nothing. An unproven claim drops keepBy (written as by 'user').
      if (keepBy && (!out.cuts || out.cuts.by === 'user' || isServerStampedCuts(doc, page, current, out.cuts))) out.keepBy = true;
    }
    if (op.moveBalloons !== undefined) out.moveBalloons = boolOf(op.moveBalloons, 'balloon setting');
    return out;
  }
};

// ── Panel structure ───────────────────────────────────────────────────────────

const panelsOrder: OpSanitizer<Op<'panels_order'>> = {
  op: 'panels_order',
  sanitize(doc, op) {
    const page = pageOf(doc, op.pageId);
    if (!Array.isArray(op.order) || !op.order.length || op.order.length > DOC_LIMITS.panelsPerPage) throw bad('Invalid panel order.');
    const seen = new Set<string>();
    for (const v of op.order as unknown[]) {
      const id = safeIdOf(v, 'panel');
      if (!page.panels.some((p) => p.id === id)) throw bad('A panel in that order is no longer on the page.');
      if (seen.has(id)) throw bad('A panel appears twice in that order.');
      seen.add(id);
    }
    return { op: 'panels_order', pageId: page.id, order: [...seen] };
  }
};

const textOf = (v: unknown, max: number, what: string): string => {
  if (typeof v !== 'string') throw bad(`Invalid ${what}.`);
  return enteredText(v, max);
};

/** Every line id of the doc (live pages) → its page id. */
const linePages = (doc: ComicDoc): Map<string, string> => {
  const out = new Map<string, string>();
  for (const p of doc.pages) for (const panel of p.panels) for (const l of panel.lines) out.set(l.id, p.id);
  return out;
};

/** A client panel for panel_add: the core panel rules (text lengths, cast and place exist) plus a frame and a direction. */
const panelOf = (doc: ComicDoc, page: Page, raw: unknown, ctx: SanitizeCtx): Panel => {
  if (!isObject(raw)) throw bad('Invalid panel.');
  const id = safeIdOf(raw.id, 'panel');
  if (page.panels.some((p) => p.id === id)) throw bad('That panel is already on the page.');
  const castIds = new Set(doc.cast.map((c) => c.id));
  const panel: Panel = {
    id,
    n: 0,
    size: raw.size === undefined ? 'medium' : (PANEL_SIZES.includes(raw.size as PanelSize) ? (raw.size as PanelSize) : (() => { throw bad('Invalid panel size.'); })()),
    shot: raw.shot === undefined ? 'medium' : (SHOT_TYPES.includes(raw.shot as ShotType) ? (raw.shot as ShotType) : (() => { throw bad('Invalid camera shot.'); })()),
    action: raw.action === undefined ? '' : textOf(raw.action, PANEL_TEXT.action, 'panel action'),
    castIds: [],
    lines: []
  };
  if (raw.castIds !== undefined) {
    if (!Array.isArray(raw.castIds) || raw.castIds.length > CAST_PER_PANEL) throw bad('Invalid panel cast.');
    for (const c of raw.castIds as unknown[]) {
      if (typeof c !== 'string' || !castIds.has(c)) throw bad('That character is no longer in the cast.');
      if (!panel.castIds.includes(c)) panel.castIds.push(c);
    }
  }
  if (raw.angle !== undefined && raw.angle !== null) {
    const angle = textOf(raw.angle, PANEL_TEXT.angle, 'camera angle');
    if (angle) panel.angle = angle;
  }
  if (raw.mood !== undefined && raw.mood !== null) {
    const mood = textOf(raw.mood, PANEL_TEXT.mood, 'mood');
    if (mood) panel.mood = mood;
  }
  if (raw.placeId !== undefined && raw.placeId !== null && raw.placeId !== '') {
    if (typeof raw.placeId !== 'string' || !doc.places.some((p) => p.id === raw.placeId)) throw bad('That location is no longer in the comic.');
    panel.placeId = raw.placeId;
  }
  // Lines: one of THIS page moves into the panel (its own Line object, applyOp); a new id is a new line; a line of another
  // page refuses the op. A new line's id is unique in the comic.
  const rawLines = raw.lines === undefined ? [] : raw.lines;
  if (!Array.isArray(rawLines) || rawLines.length > DOC_LIMITS.linesPerPanel) throw bad(`A panel holds up to ${DOC_LIMITS.linesPerPanel} lines.`);
  const pageOfLine = linePages(doc);
  const ids = new Set<string>();
  for (const l of rawLines as unknown[]) {
    if (!isObject(l)) throw bad('Invalid line.');
    const lineId = safeIdOf(l.id, 'line');
    if (ids.has(lineId)) throw bad('A line appears twice in that panel.');
    ids.add(lineId);
    const home = pageOfLine.get(lineId);
    if (home && home !== page.id) throw bad('That line belongs to another page.');
    if (home) {
      panel.lines.push({ id: lineId } as Line); // applyOp moves the page's own Line object
      continue;
    }
    const kind: LineKind = l.kind === undefined ? 'speech' : LINE_KINDS.includes(l.kind as LineKind) ? (l.kind as LineKind) : (() => { throw bad('Invalid line kind.'); })();
    const line: Line = { id: lineId, kind, text: typeof l.text === 'string' ? clipText(storableText(l.text), PANEL_TEXT.line) : '' };
    if (l.text !== undefined && typeof l.text !== 'string') throw bad('Invalid line text.');
    if (l.speakerId !== undefined && l.speakerId !== null && l.speakerId !== '') {
      if (typeof l.speakerId !== 'string' || !castIds.has(l.speakerId)) throw bad('That speaker is no longer in the cast.');
      if (SPOKEN.has(kind)) line.speakerId = l.speakerId;
    }
    if (l.style !== undefined && l.style !== null) {
      const style = sanitizeLetterStylePatch(l.style, { allowPro: PRO_EDIT_OPS_PATCHABLE }); // Pro keys only with the switch (B-3)
      if (style) line.style = style;
    }
    if (typeof l.lang === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(l.lang)) line.lang = l.lang;
    if (l.noTranslate === true) line.noTranslate = true;
    // A named style (Pro Edit): kept only while PRO_EDIT_OPS_PATCHABLE is on and it names a saved style; dropped otherwise.
    const styleId = lineStyleIdOf(doc, l.styleId);
    if (styleId) line.styleId = styleId;
    panel.lines.push(line);
  }
  if (raw.frame !== undefined && raw.frame !== null) panel.frame = frameOf(doc, page, raw.frame, ctx);
  if (raw.direction !== undefined && raw.direction !== null) {
    const direction = sanitizeDirection(raw.direction, doc, ctx);
    if (direction) panel.direction = direction;
  }
  return panel;
};

const panelAdd: OpSanitizer<Op<'panel_add'>> = {
  op: 'panel_add',
  sanitize(doc, op, ctx) {
    const page = pageOf(doc, op.pageId);
    if (page.panels.length >= DOC_LIMITS.panelsPerPage) throw limit(`A page can have up to ${DOC_LIMITS.panelsPerPage} panels.`);
    // A frameless panel is valid on any page (FIX F1): it is the exact undo of removing a frameless panel; on a page shown
    // in frames it shows the page as drawn again (I2).
    const panel = panelOf(doc, page, op.panel, ctx);
    if (extraSources({ ...page, panels: [...page.panels, panel] }) > EDITOR_LIMITS.sourcesPerPage) throw sourcesLimitError();
    const out: Op<'panel_add'> = { op: 'panel_add', pageId: page.id, panel };
    if (op.index !== undefined && op.index !== null) out.index = intIn(op.index, 0, page.panels.length, 'panel position');
    return out;
  }
};

const panelRemove: OpSanitizer<Op<'panel_remove'>> = {
  op: 'panel_remove',
  sanitize(doc, op) {
    const page = pageOf(doc, op.pageId);
    const id = safeIdOf(op.id, 'panel');
    const removed = page.panels.find((p) => p.id === id);
    if (!removed) throw bad('That panel is no longer on the page.');
    const out: Op<'panel_remove'> = { op: 'panel_remove', pageId: page.id, id };
    const counts = new Map(page.panels.map((p) => [p.id, p.lines.length]));
    const homed = new Set<string>();
    if (op.lineHomes !== undefined && op.lineHomes !== null) {
      if (!Array.isArray(op.lineHomes) || op.lineHomes.length > removed.lines.length) throw bad('Invalid line homes.');
      const homes: PanelLineHome[] = [];
      for (const h of op.lineHomes as unknown[]) {
        if (!isObject(h)) throw bad('Invalid line home.');
        const lineId = safeIdOf(h.lineId, 'line');
        const panelId = safeIdOf(h.panelId, 'panel');
        if (!removed.lines.some((l) => l.id === lineId)) throw bad("A line home names a line that isn't in that panel.");
        if (panelId === id || !page.panels.some((p) => p.id === panelId)) throw bad('A line home names a panel that is no longer on the page.');
        if (homed.has(lineId)) throw bad('A line appears twice in the line homes.');
        homed.add(lineId);
        homes.push({ lineId, panelId, index: intIn(h.index, 0, DOC_LIMITS.linesPerPanel, 'line position') });
        counts.set(panelId, (counts.get(panelId) || 0) + 1);
      }
      if (homes.length) out.lineHomes = homes;
    }
    if (op.linesTo !== undefined && op.linesTo !== null) {
      const to = safeIdOf(op.linesTo, 'panel');
      if (to === id || !page.panels.some((p) => p.id === to)) throw bad('The panel the lines should go to is no longer on the page.');
      counts.set(to, (counts.get(to) || 0) + removed.lines.filter((l) => !homed.has(l.id)).length);
      out.linesTo = to;
    }
    counts.delete(id);
    for (const [panelId, n] of counts) {
      if (n > DOC_LIMITS.linesPerPanel) {
        const panel = page.panels.find((p) => p.id === panelId)!;
        throw bad(`Panel ${panel.n} would have more than ${DOC_LIMITS.linesPerPanel} lines — move some lines to another panel first.`);
      }
    }
    return out;
  }
};

// ── Overlays ──────────────────────────────────────────────────────────────────

const SHAPES = ['rect', 'ellipse', 'line'] as const;

/** Why a library sticker is refused in S2 (no catalogue the server knows until PE-ASSETS, S3; collisions C-10). */
export const STICKER_NOT_YET_MESSAGE = "Stickers from the library aren't available yet — use a picture from this comic instead.";
const FX_TOO_LARGE_MESSAGE = 'That effect has too many settings to store — reset some of them first.';
const FX_UNKNOWN_MESSAGE = "That effect isn't available in this version of the studio.";

/** The calm words for one effect setting out of its schema. */
const fxParamError = (name: string, key: string, label: string | undefined, why: 'unknown' | 'range' | 'value' | 'colour' | 'kind') => {
  const what = label ? `${label.toLowerCase()} (${key})` : key;
  switch (why) {
    case 'unknown':
      return bad(`${name} has no setting called “${key}”.`);
    case 'range':
      return bad(`That ${name} setting, ${what}, is out of range.`);
    case 'value':
      return bad(`That ${name} setting, ${what}, isn't one of its choices.`);
    case 'colour':
      return bad(`That ${name} setting, ${what}, must be a colour like #RRGGBB.`);
    default:
      return bad(`That ${name} setting, ${what}, has the wrong kind of value.`);
  }
};

/**
 * A client's new effect (PRO_EDIT_OPS_PATCHABLE on): a registered `gen@v`, an int32 seed and parameters that fit the
 * generator's schema exactly (refused, never clamped: a value the client did not mean is never stored), ≤
 * FX_LIMITS.paramsPerFx of them, the whole effect ≤ FX_LIMITS.fxBytes. Only the parameters sent are stored (a missing one
 * draws at its default: fxParamsOf).
 */
export const fxOf = (raw: unknown): LayerFx => {
  if (!isObject(raw)) throw bad('Invalid effect.');
  if (!fxWithinBudget(raw)) throw bad(FX_TOO_LARGE_MESSAGE);
  const { gen, v } = raw;
  if (typeof gen !== 'string' || !FX_GEN_RE.test(gen) || typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw bad('Invalid effect.');
  const generator = fxGeneratorFor({ gen, v });
  if (!generator) throw bad(FX_UNKNOWN_MESSAGE);
  if (!int32(raw.seed)) throw bad('Invalid effect seed.');
  const given: Record<string, FxParamValue> = {};
  if (raw.params !== undefined && raw.params !== null) {
    if (!isObject(raw.params)) throw bad('Invalid effect settings.');
    const entries = Object.entries(raw.params);
    if (entries.length > FX_LIMITS.paramsPerFx) throw bad(FX_TOO_LARGE_MESSAGE);
    for (const [key, value] of entries) {
      const spec = FX_PARAM_KEY_RE.test(key) && hasOwn(generator.params, key) ? generator.params[key] : undefined;
      if (!spec) throw fxParamError(generator.name, key, undefined, 'unknown');
      if (spec.kind === 'number') {
        if (!finite(value)) throw fxParamError(generator.name, key, spec.label, 'kind');
        if (value < spec.min || value > spec.max || (spec.int && !Number.isInteger(value))) throw fxParamError(generator.name, key, spec.label, 'range');
      } else if (spec.kind === 'enum') {
        if (typeof value !== 'string') throw fxParamError(generator.name, key, spec.label, 'kind');
        if (!spec.values.includes(value)) throw fxParamError(generator.name, key, spec.label, 'value');
      } else if (spec.kind === 'color') {
        if (typeof value !== 'string' || !HEX_COLOR_RE.test(value)) throw fxParamError(generator.name, key, spec.label, 'colour');
      } else if (typeof value !== 'boolean') throw fxParamError(generator.name, key, spec.label, 'kind');
      given[key] = value as FxParamValue;
    }
  }
  // The schema's own reading of what was sent (numbers to 4 places), restricted to the keys sent.
  const resolved = fxParamsOf(generator, given);
  const params: Record<string, FxParamValue> = {};
  for (const key of Object.keys(given)) params[key] = resolved[key];
  const fx: LayerFx = { gen, v, seed: raw.seed, params };
  if (!fxWithinBudget(fx)) throw bad(FX_TOO_LARGE_MESSAGE);
  const normal = normalizeLayerFx(fx);
  if (!normal) throw bad('Invalid effect.');
  return normal;
};

/**
 * A `layer` patch: known keys, every value checked (null clears a key). `existing` is the overlay as the doc holds it:
 * a Pro value equal to it is re-asserted (accepted whatever the switch); a new one needs PRO_EDIT_OPS_PATCHABLE.
 */
const layerPatchOf = (doc: ComicDoc, page: Page, raw: Record<string, unknown>, ctx: SanitizeCtx, existing?: PageLayer): LayerPatch => {
  const L = PRO_PAGE_LIMITS;
  const pro = PRO_EDIT_OPS_PATCHABLE;
  const out: Record<string, unknown> = {};
  const set = (key: string, fn: (v: unknown) => unknown, clearable = true) => {
    if (!hasOwn(raw, key) || raw[key] === undefined) return;
    if (raw[key] === null) {
      if (!clearable) throw bad(`Invalid overlay: ${key}.`);
      out[key] = null;
      return;
    }
    out[key] = fn(raw[key]);
  };
  set('kind', (v) => {
    // Never an unknown kind (opaque layers are a newer build's, never a client's); an effect needs the switch, unless the
    // overlay already is one.
    if (!isKnownLayerKind(v)) throw bad('Invalid overlay kind.');
    if (v === 'effect' && !pro && existing?.kind !== 'effect') throw bad('Invalid overlay kind.');
    return v;
  }, false);
  set('name', (v) => {
    const name = safeText(v, L.layerNameChars, ctx);
    if (name === undefined) throw bad('Invalid overlay name.');
    return name || null;
  });
  set('box', (v) => boxIn(v, L.boxMin, 'overlay'), false);
  set('rot', (v) => numberIn(v, -EDITOR_LIMITS.layerRot, EDITOR_LIMITS.layerRot, 'overlay rotation'));
  set('z', (v) => intIn(v, -L.zMax, L.zMax, 'overlay stacking order'));
  set('clip', (v) => {
    const id = safeIdOf(v, 'panel');
    if (!page.panels.some((p) => p.id === id)) throw bad('That panel is no longer on the page.');
    return id;
  });
  set('opacity', (v) => numberIn(v, 0, 1, 'overlay opacity'));
  set('flip', (v) => {
    if (v !== 'h' && v !== 'v') throw bad('Invalid overlay flip.');
    return v;
  });
  set('locked', (v) => {
    if (v !== true && v !== false) throw bad('Invalid overlay lock.');
    return v === true ? true : null;
  });
  // print: false = guide only (never printed; PD-5 real-person photos default to it). true = printed (the default).
  set('print', (v) => {
    if (v !== true && v !== false) throw bad('Invalid overlay print setting.');
    return v === false ? false : null;
  });
  set('src', (v) => {
    if (!isObject(v)) throw bad('Invalid overlay picture.');
    const crop = v.crop !== undefined && v.crop !== null ? boxIn(v.crop, L.boxMin, 'overlay crop') : undefined;
    if (v.lib !== undefined && v.lib !== null) {
      // A library sticker: only the one this overlay already shows (re-asserted, e.g. an undo of a move). A new triple
      // is refused calmly while the switch is on (no catalogue until PE-ASSETS); off, the path rule below refuses it
      // as before.
      const lib = normalizeAssetLibRef(v.lib);
      if (lib && sameLibRef(lib, existing?.src?.lib) && (v.path === undefined || v.path === null)) return { lib, ...(crop ? { crop } : {}) };
      if (pro) throw bad(STICKER_NOT_YET_MESSAGE);
    }
    const src: Record<string, unknown> = { path: checkImagePath(doc, page, v.path, ctx) };
    if (crop) src.crop = crop;
    return src;
  });
  set('shape', (v) => {
    if (!isObject(v)) throw bad('Invalid overlay shape.');
    if (typeof v.type !== 'string' || !(SHAPES as readonly string[]).includes(v.type)) throw bad('Invalid overlay shape.');
    const shape: Record<string, unknown> = { type: v.type };
    if (v.fill !== undefined && v.fill !== null) shape.fill = hexColor(v.fill, 'fill');
    if (v.stroke !== undefined && v.stroke !== null) shape.stroke = hexColor(v.stroke, 'outline');
    if (v.strokeW !== undefined && v.strokeW !== null) shape.strokeW = numberIn(v.strokeW, 0, L.layerStrokeMax, 'outline width');
    if (v.radius !== undefined && v.radius !== null) shape.radius = numberIn(v.radius, 0, L.layerRadiusMax, 'corner radius');
    return shape;
  });
  // ── Pro Edit: effect and blend. Off, a value is kept only when it re-asserts the stored one, and anything else is
  //    dropped as before PE-SERVER; on, a new value is checked (null clears). ──
  const proKey = (key: 'fx' | 'blend', fn: (v: unknown) => unknown) => {
    if (!hasOwn(raw, key) || raw[key] === undefined) return;
    const v = raw[key];
    if (v !== null && existing && existing[key] !== undefined && sameJson(v, existing[key])) out[key] = existing[key];
    else if (!pro) return;
    else out[key] = v === null ? null : fn(v);
  };
  proKey('fx', fxOf);
  proKey('blend', (v) => {
    if (typeof v !== 'string' || !(LAYER_BLENDS as readonly string[]).includes(v)) throw bad('Invalid overlay blend.');
    return v;
  });
  return out as LayerPatch;
};

const layer: OpSanitizer<Op<'layer'>> = {
  op: 'layer',
  sanitize(doc, op, ctx) {
    const page = pageOf(doc, op.pageId);
    if (typeof op.id !== 'string' || !LAYER_ID_RE.test(op.id)) throw bad('Invalid overlay id.');
    const layers = page.layers || [];
    const existing = layers.find((l) => l.id === op.id);
    if (op.patch === null || op.patch === undefined) return { op: 'layer', pageId: page.id, id: op.id, patch: null };
    if (!isObject(op.patch)) throw bad('Invalid overlay.');
    // A newer build's overlay (opaque) is never client-writable (its delete above is accepted; the op leaves it as written).
    if (existing && isOpaqueLayer(existing)) throw bad('Invalid overlay: a newer version of the studio made that one, so it stays as it is.');
    if (!existing && layers.length >= EDITOR_LIMITS.layersPerPage) throw limit(`A page can have up to ${EDITOR_LIMITS.layersPerPage} overlays — remove one first.`);
    const patch = layerPatchOf(doc, page, op.patch as Record<string, unknown>, ctx, existing);
    // What the op will store must be a valid overlay (an image needs its picture, a shape its shape).
    const merged: Record<string, unknown> = { ...(existing || {}) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === undefined) delete merged[k];
      else merged[k] = v;
    }
    merged.id = op.id;
    // Effect settings belong to an effect overlay (a shape or picture would silently lose them).
    if (patch.fx && merged.kind !== 'effect') throw bad('Only an effect overlay takes effect settings.');
    const normal: PageLayer | undefined = normalizePageLayer(merged);
    if (!normal) throw bad(existing ? 'Invalid overlay.' : 'A new overlay needs a kind, a box and its picture, shape or effect.');
    const out: Op<'layer'> = { op: 'layer', pageId: page.id, id: op.id, patch };
    if (op.index !== undefined && op.index !== null) out.index = intIn(op.index, 0, layers.length, 'overlay position');
    return out;
  }
};

export const PANELS_SANITIZERS: OpSanitizer[] = [pageFrames, pageCuts, panelsOrder, panelAdd, panelRemove, layer] as OpSanitizer[];
