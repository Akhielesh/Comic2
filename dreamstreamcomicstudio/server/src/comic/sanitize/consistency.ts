// Client-patch sanitizers "consistency" (pro plan §5.3; K2b). Owner: K2b (the stub rule does not apply: this is a real
// sanitizer, not a stub).
//
//   continuity · scene · consistency · finding   (+ the panel `direction` rule shared with jobs.ts and panels.ts)
//
// Every op is FREE (no spend, no render, no new asset; I10). A sanitizer rebuilds the op from known keys with bounded
// values, or throws a StudioError that rejects the WHOLE batch (400 malformed, 409 LIMIT at a cap). Text goes through
// safeText: jsonb-safe, one line, clipped, and softened in safe mode (a G or PG comic: the direction and continuity
// text reaches the image model). The whole-batch safety screen (sanitize/safety.ts) still reads every string after.
// Sanitizers see the doc as the batch has built it so far (jobs.ts sanitizePatchOps `working`), so a scene created
// earlier in the same batch exists for a continuity op after it.

import {
  normalizeConsistencySettings,
  normalizePageContinuity,
  normalizePanelDirection,
  normalizeScene,
  type ComicDoc,
  type Page,
  type PanelDirection,
  type Scene
} from '../../../../shared/comic/doc.js';
import { SAFE_ID_RE, type ConsistencyPatch, type ContinuityPatch, type DocOp, type ScenePatch } from '../../../../shared/comic/ops.js';
import { CONSISTENCY_LIMITS, PRO_PAGE_LIMITS } from '../../../../shared/comic/limits.js';
import { PLATFORM_CEILING, softenAction, type ContentRating } from '../../../../shared/comic/safety.js';
import type { OpSanitizer, SanitizeCtx } from '../extensions.js';
import { StudioError } from '../types.js';
import { enteredText } from './text.js';

type Op<K extends DocOp['op']> = Extract<DocOp, { op: K }>;

const bad = (message: string) => new StudioError('BAD_REQUEST', message, { status: 400 });
const limit = (message: string) => new StudioError('LIMIT', message, { status: 409 });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/** Object keys a record built from client data never takes (prototype pollution). */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Ratings whose direction and continuity text is softened on the way in ("safe mode": the comic's effective rating is
 * below the platform ceiling, a G or PG book). One constant: a policy change is a one-line edit.
 */
export const SAFE_TEXT_RATINGS: ReadonlySet<ContentRating> = new Set<ContentRating>(['G', 'PG']);

/** Safe mode for this request: the batch's effective rating is below the platform ceiling. */
export const isSafeMode = (ctx?: Pick<SanitizeCtx, 'rating'>): boolean => !!ctx?.rating && ctx.rating !== PLATFORM_CEILING && SAFE_TEXT_RATINGS.has(ctx.rating);

/**
 * Free text of a Ship 2 field as it enters the doc: a string only (else undefined), NUL and lone surrogates removed,
 * whitespace collapsed to one line, clipped without splitting a pair; softened (softenAction) in safe mode. '' when
 * nothing is left.
 */
export const safeText = (v: unknown, max: number, ctx?: Pick<SanitizeCtx, 'rating'>): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const line = enteredText(v.replace(/\s+/g, ' '), max);
  return isSafeMode(ctx) ? enteredText(softenAction(line), max) : line;
};

/** A SAFE_ID, or a 400 naming what it is. */
export const safeIdOf = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !SAFE_ID_RE.test(v) || UNSAFE_KEYS.has(v)) throw bad(`Invalid ${what} id.`);
  return v;
};

/** The page, or a 400 (the editor's view of the comic is behind). */
export const pageOf = (doc: ComicDoc, pageId: unknown): Page => {
  const id = safeIdOf(pageId, 'page');
  const page = doc.pages.find((p) => p.id === id);
  if (!page) throw bad('That page is no longer in the book.');
  return page;
};

/** A text list (strings only, each through safeText, empty ones dropped, ≤ maxItems). Throws on a non-array or a non-string. */
const textListOf = (v: unknown, maxItems: number, maxChars: number, what: string, ctx: SanitizeCtx): string[] => {
  if (!Array.isArray(v)) throw bad(`Invalid ${what}.`);
  const out: string[] = [];
  for (const item of v) {
    const t = safeText(item, maxChars, ctx);
    if (t === undefined) throw bad(`Invalid ${what}.`);
    if (t && !out.includes(t)) out.push(t);
  }
  return out.slice(0, maxItems);
};

// ── Panel direction (shared: jobs.ts `panel` patches, panels.ts panel_add) ──────

const LENSES = ['wide', 'normal', 'long', 'macro'] as const;
const POSITIONS = ['left', 'center', 'right'] as const;
const DEPTHS = ['fg', 'mid', 'bg'] as const;
const DIRECTION_BY = ['writer', 'user', 'derived'] as const;
const oneOf = <T extends string>(v: unknown, list: readonly T[], what: string): T => {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) throw bad(`Invalid ${what}.`);
  return v as T;
};

/**
 * A panel's direction from a client (pro plan §5.2 PanelDirection): every text through safeText; `cast` keys and
 * `offPanel` ids must be characters of the comic (unknown ids are dropped, never stored — a character removed since
 * the editor loaded is not an error); then the shared normalizer (caps, rounding). Undefined when nothing valid is
 * left (the caller clears the direction). Throws 400 on a malformed shape.
 */
export const sanitizeDirection = (raw: unknown, doc: Pick<ComicDoc, 'cast'>, ctx: SanitizeCtx): PanelDirection | undefined => {
  if (!isObject(raw)) throw bad('Invalid panel direction.');
  const L = PRO_PAGE_LIMITS;
  const cast = new Set(doc.cast.map((c) => c.id));
  const out: Record<string, unknown> = {};
  if (raw.lens !== undefined && raw.lens !== null) out.lens = oneOf(raw.lens, LENSES, 'lens');
  for (const k of ['composition', 'light', 'palette', 'focus'] as const) {
    if (raw[k] === undefined || raw[k] === null) continue;
    const t = safeText(raw[k], L.directionTextChars, ctx);
    if (t === undefined) throw bad(`Invalid panel direction: ${k}.`);
    if (t) out[k] = t;
  }
  if (raw.background !== undefined && raw.background !== null) out.background = textListOf(raw.background, CONSISTENCY_LIMITS.directionBackground, L.sceneTextChars, 'background details', ctx);
  if (raw.cast !== undefined && raw.cast !== null) {
    if (!isObject(raw.cast)) throw bad('Invalid panel direction: cast.');
    const staged: Record<string, Record<string, unknown>> = {};
    for (const [id, value] of Object.entries(raw.cast)) {
      if (!isObject(value)) throw bad('Invalid panel direction: cast.');
      if (UNSAFE_KEYS.has(id) || !SAFE_ID_RE.test(id) || !cast.has(id)) continue;
      const one: Record<string, unknown> = {};
      for (const k of ['expression', 'pose', 'gaze'] as const) {
        if (value[k] === undefined || value[k] === null) continue;
        const t = safeText(value[k], L.directionCastTextChars, ctx);
        if (t === undefined) throw bad(`Invalid panel direction: ${k}.`);
        if (t) one[k] = t;
      }
      if (value.holding !== undefined && value.holding !== null) one.holding = textListOf(value.holding, L.directionListItems, L.directionCastTextChars, 'what they hold', ctx);
      if (value.pos !== undefined && value.pos !== null) one.pos = oneOf(value.pos, POSITIONS, 'position');
      if (value.depth !== undefined && value.depth !== null) one.depth = oneOf(value.depth, DEPTHS, 'depth');
      if (Object.keys(one).length) staged[id] = one;
      if (Object.keys(staged).length >= CONSISTENCY_LIMITS.castChanges) break;
    }
    out.cast = staged;
  }
  if (raw.offPanel !== undefined && raw.offPanel !== null) {
    if (!Array.isArray(raw.offPanel)) throw bad('Invalid panel direction: off-panel voices.');
    out.offPanel = raw.offPanel.filter((id): id is string => typeof id === 'string' && SAFE_ID_RE.test(id) && !UNSAFE_KEYS.has(id) && cast.has(id));
  }
  if (raw.by !== undefined && raw.by !== null) out.by = oneOf(raw.by, DIRECTION_BY, 'direction source');
  return normalizePanelDirection(out);
};

// ── continuity ────────────────────────────────────────────────────────────────

const CONTINUITY_BY = ['writer', 'user', 'fix'] as const;

/** One character's state change (null = "back to what it was"). */
const castChangeOf = (raw: unknown, ctx: SanitizeCtx): Record<string, unknown> | null => {
  if (raw === null) return null;
  if (!isObject(raw)) throw bad('Invalid continuity change.');
  const L = PRO_PAGE_LIMITS;
  const out: Record<string, unknown> = {};
  for (const k of ['outfit', 'where'] as const) {
    if (raw[k] === undefined) continue;
    if (raw[k] === null) out[k] = null;
    else {
      const t = safeText(raw[k], L.continuityTextChars, ctx);
      if (t === undefined) throw bad(`Invalid continuity: ${k}.`);
      if (t) out[k] = t;
    }
  }
  for (const k of ['holding', 'marks'] as const) {
    if (raw[k] === undefined) continue;
    out[k] = raw[k] === null ? null : textListOf(raw[k], L.continuityListItems, L.continuityTextChars, `continuity ${k}`, ctx);
  }
  return out;
};

/** A `continuity` patch: null clears a key; every id must exist (the scene in doc.scenes, cast keys in doc.cast). */
const continuityPatchOf = (doc: ComicDoc, raw: unknown, ctx: SanitizeCtx): ContinuityPatch => {
  if (!isObject(raw)) throw bad('Invalid continuity.');
  const L = PRO_PAGE_LIMITS;
  const out: Record<string, unknown> = {};
  if (hasOwn(raw, 'sceneId') && raw.sceneId !== undefined) {
    if (raw.sceneId === null) out.sceneId = null;
    else {
      const id = safeIdOf(raw.sceneId, 'scene');
      if (!(doc.scenes || []).some((s) => s.id === id)) throw bad('That scene is no longer in the comic.');
      out.sceneId = id;
    }
  }
  if (hasOwn(raw, 'cast') && raw.cast !== undefined) {
    if (raw.cast === null) out.cast = null;
    else {
      if (!isObject(raw.cast)) throw bad('Invalid continuity: cast.');
      const entries = Object.entries(raw.cast);
      if (entries.length > CONSISTENCY_LIMITS.castChanges) throw limit(`A page can change at most ${CONSISTENCY_LIMITS.castChanges} characters' state.`);
      const cast: Record<string, unknown> = {};
      for (const [id, value] of entries) {
        safeIdOf(id, 'character');
        if (!doc.cast.some((c) => c.id === id)) throw bad('That character is no longer in the cast.');
        cast[id] = castChangeOf(value, ctx);
      }
      out.cast = cast;
    }
  }
  if (hasOwn(raw, 'props') && raw.props !== undefined) {
    if (raw.props === null) out.props = null;
    else {
      if (!isObject(raw.props)) throw bad('Invalid continuity: props.');
      const entries = Object.entries(raw.props);
      if (entries.length > CONSISTENCY_LIMITS.propChanges) throw limit(`A page can change at most ${CONSISTENCY_LIMITS.propChanges} props.`);
      const props: Record<string, unknown> = {};
      for (const [name, value] of entries) {
        const key = safeText(name, L.sceneNameChars, ctx);
        if (!key || UNSAFE_KEYS.has(key)) throw bad('Invalid prop name.');
        if (value === null) props[key] = null;
        else {
          const t = safeText(value, L.continuityTextChars, ctx);
          if (t === undefined) throw bad('Invalid prop state.');
          if (t) props[key] = t;
        }
      }
      out.props = props;
    }
  }
  if (hasOwn(raw, 'notes') && raw.notes !== undefined) {
    out.notes = raw.notes === null ? null : textListOf(raw.notes, CONSISTENCY_LIMITS.notes, L.continuityNoteChars, 'continuity notes', ctx);
  }
  if (hasOwn(raw, 'by') && raw.by !== undefined) out.by = raw.by === null ? null : oneOf(raw.by, CONTINUITY_BY, 'continuity source');
  return out as ContinuityPatch;
};

const continuity: OpSanitizer<Op<'continuity'>> = {
  op: 'continuity',
  sanitize(doc, op, ctx) {
    const page = pageOf(doc, op.pageId);
    if (op.patch === null) return { op: 'continuity', pageId: page.id, patch: null };
    const patch = continuityPatchOf(doc, op.patch, ctx);
    // The merged value must normalize (a patch that leaves nothing valid is a clear, which the op does itself).
    normalizePageContinuity({ ...(page.continuity || {}), ...patch });
    return { op: 'continuity', pageId: page.id, patch };
  }
};

// ── scene ─────────────────────────────────────────────────────────────────────

const scene: OpSanitizer<Op<'scene'>> = {
  op: 'scene',
  sanitize(doc, op, ctx) {
    const id = safeIdOf(op.id, 'scene');
    const scenes = doc.scenes || [];
    const existing = scenes.find((s) => s.id === id);
    if (op.patch === null) return { op: 'scene', id, patch: null };
    if (!isObject(op.patch)) throw bad('Invalid scene.');
    const raw = op.patch as Record<string, unknown>;
    const L = PRO_PAGE_LIMITS;
    const patch: Record<string, unknown> = {};
    if (raw.name !== undefined) {
      const name = safeText(raw.name, L.sceneNameChars, ctx);
      if (!name) throw bad('A scene needs a name.');
      patch.name = name;
    }
    if (raw.placeId !== undefined) {
      if (raw.placeId === null) patch.placeId = null;
      else {
        const placeId = safeIdOf(raw.placeId, 'location');
        if (!doc.places.some((p) => p.id === placeId)) throw bad('That location is no longer in the comic.');
        patch.placeId = placeId;
      }
    }
    for (const k of ['time', 'weather', 'light', 'palette'] as const) {
      if (raw[k] === undefined) continue;
      if (raw[k] === null) patch[k] = null;
      else {
        const t = safeText(raw[k], L.sceneTextChars, ctx);
        if (t === undefined) throw bad(`Invalid scene: ${k}.`);
        patch[k] = t || null;
      }
    }
    if (!existing) {
      if (scenes.length >= CONSISTENCY_LIMITS.scenes) throw limit(`A comic can have up to ${CONSISTENCY_LIMITS.scenes} scenes.`);
      if (!patch.name) throw bad('A new scene needs a name.');
    }
    // What the op will store must be a valid scene (a name is required).
    const merged: Record<string, unknown> = { ...(existing || {}), id };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    if (!normalizeScene(merged)) throw bad('A scene needs a name.');
    const out: Op<'scene'> = { op: 'scene', id, patch: patch as ScenePatch };
    if (op.index !== undefined && op.index !== null) {
      if (typeof op.index !== 'number' || !Number.isInteger(op.index) || op.index < 0) throw bad('Invalid scene position.');
      out.index = op.index;
    }
    return out;
  }
};

// ── consistency (book settings) ───────────────────────────────────────────────

const consistency: OpSanitizer<Op<'consistency'>> = {
  op: 'consistency',
  sanitize(doc, op, ctx) {
    if (!isObject(op.patch)) throw bad('Invalid consistency settings.');
    const raw = op.patch as Record<string, unknown>;
    const L = PRO_PAGE_LIMITS;
    const patch: Record<string, unknown> = {};
    if (raw.maxRefs !== undefined) {
      if (raw.maxRefs === null) patch.maxRefs = null;
      else {
        if (typeof raw.maxRefs !== 'number' || !Number.isInteger(raw.maxRefs) || raw.maxRefs < 1 || raw.maxRefs > L.maxRefsMax) {
          throw bad(`Reference images per page must be a whole number from 1 to ${L.maxRefsMax}.`);
        }
        patch.maxRefs = raw.maxRefs;
      }
    }
    if (raw.styleKeyPageId !== undefined) {
      if (raw.styleKeyPageId === null) patch.styleKeyPageId = null;
      else {
        const id = safeIdOf(raw.styleKeyPageId, 'page');
        if (!doc.pages.some((p) => p.id === id)) throw bad('That page is no longer in the book.');
        patch.styleKeyPageId = id;
      }
    }
    if (raw.skip !== undefined) {
      if (raw.skip === null) patch.skip = null;
      else {
        if (!Array.isArray(raw.skip)) throw bad('Invalid skipped references.');
        if (raw.skip.length > L.skipItems) throw limit(`Up to ${L.skipItems} references can be skipped.`);
        const skip: string[] = [];
        for (const key of raw.skip) {
          const k = safeText(key, L.anchorKeyChars, ctx);
          if (!k) throw bad('Invalid skipped reference.');
          if (!skip.includes(k)) skip.push(k);
        }
        patch.skip = skip;
      }
    }
    if (!Object.keys(patch).length) throw bad('Nothing to change in the consistency settings.');
    normalizeConsistencySettings({ ...(doc.consistency || {}), ...patch });
    return { op: 'consistency', patch: patch as ConsistencyPatch };
  }
};

// ── finding ("Looks fine") ────────────────────────────────────────────────────

const finding: OpSanitizer<Op<'finding'>> = {
  op: 'finding',
  sanitize(doc, op) {
    const page = pageOf(doc, op.pageId);
    const id = safeIdOf(op.id, 'check');
    const findings = page.render.qc?.findings;
    if (!Array.isArray(findings) || !findings.some((f) => f.id === id)) throw bad("That check isn't on this page's current drawing any more.");
    if (!isObject(op.patch)) throw bad('Invalid check change.');
    // Only `dismissed` can change: a finding's text, kind and fix come from the server's check.
    const keys = Object.keys(op.patch).filter((k) => (op.patch as Record<string, unknown>)[k] !== undefined);
    if (keys.some((k) => k !== 'dismissed')) throw bad('Only “Looks fine” can change on a check.');
    const d = (op.patch as Record<string, unknown>).dismissed;
    if (d !== true && d !== false && d !== null) throw bad('Invalid check change.');
    return { op: 'finding', pageId: page.id, id, patch: { dismissed: d as boolean } };
  }
};

export const CONSISTENCY_SANITIZERS: OpSanitizer[] = [continuity, scene, consistency, finding] as OpSanitizer[];

/** Scenes a doc holds (re-exported for the panels sanitizer and tests). */
export const scenesIn = (doc: ComicDoc): Scene[] => doc.scenes || [];
