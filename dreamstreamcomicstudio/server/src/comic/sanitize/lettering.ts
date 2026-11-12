// Client-patch sanitizers "lettering" (contract §5.4 / §12.1, lettering.md §9): letter_style, line_style.
// Owned by P1-LETTER-ENGINE. A sanitizer returns the op to commit (normalized: clamped ranges, valid
// enums/fonts/colours, unknown keys dropped) or throws StudioError 400 to reject the whole batch, so
// nothing reaches the doc unvalidated and the client never shows a change that vanishes on refresh.
//
// Lettering edits are free overlay changes for everyone (Easy can do everything Pro can by talking),
// so there is no caps gate here; ownership is enforced by the route before sanitizing.
//
// Pro Edit (master plan §2.3 "Sanitizers"; PE-SERVER):
//   - The Pro text keys and ids (PRO_STYLE_KEYS, a Pro shape, SFX effect or font) stay refused from a client, as today:
//     the shared sanitizers decide them, and PE-LETTER's opt-in (`allowPro`) is wired here by the S2 integration as
//     `allowPro: PRO_EDIT_OPS_PATCHABLE` (collisions B-3). This file never forks their rules.
//   - RE-ASSERT (PE-0 wave note 9, approved by the lead for S2): a client may re-send a Pro key or id whose JSON equals
//     what the doc stores, never add or change one. So an undo after a rollback keeps a stored Pro style: a single-line
//     line_style (every line_style inverse is one op per line) checked against that line's style, and the letter_style
//     base / kinds / speakers patches checked against doc.letterStyle (jobs.ts never applies letter_style to the batch's
//     working doc, so the restore after an inverse's reset still sees the stored look). Re-adding a deleted line stays
//     lossy: there is nothing stored to compare with.
//   - Named styles (`letterStyle.named`, `Line.styleId`) count as Pro fields (lead decision C-9): with
//     PRO_EDIT_OPS_PATCHABLE on, a letter_style `named` patch keeps at most PRO_LETTER_LIMITS.namedStyles styles with
//     names of at most namedNameChars (a calm 400/409 otherwise); off, it is dropped as before. A line's styleId
//     (lineStyleIdOf) is kept only with the switch on, when it names a saved style or re-asserts the line's own; off,
//     it is dropped as before (the line op merges, so the stored one stays).

import type { ComicDoc, Line, LineKind } from '../../../../shared/comic/doc.js';
import { PRO_LETTER_LIMITS } from '../../../../shared/comic/limits.js';
import { PRO_EDIT_OPS_PATCHABLE, type DocOp } from '../../../../shared/comic/ops.js';
import {
  LETTERING_PRESET_IDS,
  LINE_KINDS,
  PRO_STYLE_KEYS,
  mergeStylePatch,
  sanitizeLetterStylePatch,
  sanitizeLetteringStyleOpPatch,
  type LetterStylePatch,
  type LetteringStyleOpPatch
} from '../../../../shared/comic/lettering/style.js';
import type { OpSanitizer } from '../extensions.js';
import { StudioError } from '../types.js';

/** Max lines one line_style op may touch, and the serialized style size per line. */
export const LINE_STYLE_MAX_IDS = 80;
export const LINE_STYLE_MAX_BYTES = 2048;
const LETTER_STYLE_MAX_BYTES = 16 * 1024;

const bad = (message: string) => new StudioError('BAD_REQUEST', message, { status: 400 });
const limit = (message: string) => new StudioError('LIMIT', message, { status: 409 });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bytes = (v: unknown): number => {
  try {
    return JSON.stringify(v ?? null).length;
  } catch {
    return Infinity;
  }
};

type LetterStyleOp = Extract<DocOp, { op: 'letter_style' }>;
type LineStyleOp = Extract<DocOp, { op: 'line_style' }>;
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

// ── Re-assert (PE-0 wave note 9) ─────────────────────────────────────────────

/** The style keys a client sanitizer refuses but the load keeps: the Pro text keys, and a shape / SFX effect / font id
 *  this build cannot draw. Only these are ever re-asserted. */
const REASSERT_KEYS: ReadonlySet<string> = new Set<string>([...PRO_STYLE_KEYS, 'shape', 'sfxEffect', 'font']);

/**
 * A client style patch with the Pro keys it re-asserts put back: `client` is what the client sanitizer kept, `stored`
 * the style the doc holds. A key of `raw` the client sanitizer dropped is kept only when it is a REASSERT_KEYS key whose
 * structurally checked value (the load keep) has the same JSON as the stored one. Keys come in the load's canonical order,
 * so the stored style is rebuilt exactly. Undefined when nothing is left.
 */
export const reassertedStylePatch = (raw: unknown, client: LetterStylePatch | undefined, stored: LetterStylePatch | undefined): LetterStylePatch | undefined => {
  const kept = sanitizeLetterStylePatch(raw, { keepStoredPro: true });
  if (!kept) return client;
  const have = sanitizeLetterStylePatch(stored, { keepStoredPro: true }) as Record<string, unknown> | undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(kept)) {
    if (client && hasOwn(client, key)) out[key] = (client as Record<string, unknown>)[key];
    else if (REASSERT_KEYS.has(key) && have && hasOwn(have, key) && JSON.stringify(have[key]) === JSON.stringify(value)) out[key] = value;
  }
  // A key the client sanitizer kept that the load keep reads differently cannot occur (same rule), but never lose one.
  for (const [key, value] of Object.entries(client || {})) if (!hasOwn(out, key)) out[key] = value;
  return Object.keys(out).length ? (out as LetterStylePatch) : undefined;
};

/** The letter_style op patch with the Pro keys its base / kinds / speakers re-assert against doc.letterStyle put back. */
const reassertedLetterPatch = (raw: Record<string, unknown>, client: LetteringStyleOpPatch | null, doc: ComicDoc): LetteringStyleOpPatch | null => {
  const stored = doc.letterStyle;
  const out: LetteringStyleOpPatch = { ...(client || {}) };
  const one = (rawPatch: unknown, clientPatch: LetterStylePatch | null | undefined, storedPatch: LetterStylePatch | undefined): LetterStylePatch | null | undefined => {
    if (clientPatch === null || rawPatch === null || rawPatch === undefined) return clientPatch;
    return reassertedStylePatch(rawPatch, clientPatch, storedPatch);
  };
  if (hasOwn(raw, 'base') && raw.base !== undefined) {
    const base = one(raw.base, client?.base, stored?.base);
    if (base !== undefined) out.base = base;
  }
  if (isObject(raw.kinds)) {
    const kinds: Partial<Record<LineKind, LetterStylePatch | null>> = { ...(client?.kinds || {}) };
    for (const k of LINE_KINDS) {
      if (raw.kinds[k] === undefined) continue;
      const p = one(raw.kinds[k], client?.kinds?.[k], stored?.kinds?.[k]);
      if (p !== undefined) kinds[k] = p;
    }
    if (Object.keys(kinds).length) out.kinds = kinds;
  }
  if (isObject(raw.speakers)) {
    const speakers: Record<string, LetterStylePatch | null> = { ...(client?.speakers || {}) };
    for (const [id, v] of Object.entries(raw.speakers)) {
      if (v === undefined) continue;
      const p = one(v, client?.speakers?.[id], stored?.speakers && hasOwn(stored.speakers, id) ? stored.speakers[id] : undefined);
      if (p !== undefined) speakers[id] = p;
    }
    if (Object.keys(speakers).length) out.speakers = speakers;
  }
  return Object.keys(out).length ? out : null;
};

// ── Named styles (Pro fields, lead decision C-9) ─────────────────────────────

/**
 * A line's named style as a client may set it (`Line.styleId`), or undefined to drop it. Only while
 * PRO_EDIT_OPS_PATCHABLE is on: an id that names a saved style (an own key of doc.letterStyle.named) is kept, the line's
 * own stored styleId (`stored`) is re-asserted even when that saved style is gone, any other id is dropped, and null
 * (or '') clears. Off, it is always dropped, exactly as before PE-SERVER: a `line` patch merges, so a dropped key leaves
 * the stored styleId as it is (no re-assert is needed, and none is accepted).
 */
export const lineStyleIdOf = (doc: Pick<ComicDoc, 'letterStyle'>, v: unknown, stored?: string): string | null | undefined => {
  if (v === undefined || !PRO_EDIT_OPS_PATCHABLE) return undefined;
  if (v === null || v === '') return stored !== undefined ? null : undefined;
  if (typeof v !== 'string') return undefined;
  if (stored !== undefined && v === stored) return v;
  const named = doc.letterStyle?.named;
  return named && hasOwn(named, v) ? v : undefined;
};

/**
 * The doc-wide rules of a letter_style `named` patch (switch on): each entry a saved style with a name of 1..namedNameChars
 * characters (null deletes one), at most PRO_LETTER_LIMITS.namedStyles saved styles once applied. The entries themselves
 * are the shared sanitizer's (PE-LETTER's `allowPro`); this adds the count against what the doc already holds.
 */
const checkNamedPatch = (doc: ComicDoc, named: unknown): void => {
  if (!isObject(named)) throw bad('Invalid saved lettering styles.');
  const stored = doc.letterStyle?.named ?? {};
  const ids = new Set(Object.keys(stored));
  for (const [id, v] of Object.entries(named)) {
    if (v === null) {
      ids.delete(id);
      continue;
    }
    if (!isObject(v)) throw bad('Invalid saved lettering style.');
    if (typeof v.name !== 'string' || !v.name.trim()) throw bad('A saved lettering style needs a name.');
    if (v.name.length > PRO_LETTER_LIMITS.namedNameChars) throw bad(`Keep a saved style's name to ${PRO_LETTER_LIMITS.namedNameChars} characters.`);
    ids.add(id);
  }
  if (ids.size > PRO_LETTER_LIMITS.namedStyles && ids.size > Object.keys(stored).length) {
    throw limit(`A comic keeps up to ${PRO_LETTER_LIMITS.namedStyles} saved lettering styles — remove one first.`);
  }
};

const letterStyleSanitizer: OpSanitizer<LetterStyleOp> = {
  op: 'letter_style',
  sanitize(doc: ComicDoc, op: LetterStyleOp): LetterStyleOp {
    if (!isObject(op)) throw bad('Invalid lettering style change.');
    if (op.patch === null) return { op: 'letter_style', patch: null };
    const raw = op.patch as unknown;
    if (!isObject(raw)) throw bad('Invalid lettering style change.');
    if (bytes(raw) > LETTER_STYLE_MAX_BYTES) throw bad('That lettering style change is too large.');
    if (raw.presetId !== undefined && !(LETTERING_PRESET_IDS as readonly unknown[]).includes(raw.presetId)) {
      throw bad(`Unknown lettering preset. Choose one of: ${LETTERING_PRESET_IDS.join(', ')}.`);
    }
    const castIds = new Set((doc.cast || []).map((c) => c.id));
    if (isObject(raw.speakers)) {
      const unknown = Object.keys(raw.speakers).filter((id) => !castIds.has(id));
      if (unknown.length) throw bad('A speaker in that lettering change is not in the cast.');
    }
    if (PRO_EDIT_OPS_PATCHABLE && raw.named !== undefined) checkNamedPatch(doc, raw.named);
    const client = sanitizeLetteringStyleOpPatch(raw, castIds);
    // Invalid (not just empty) is still refused: the probe key makes an otherwise-valid patch non-empty.
    if (!client && !sanitizeLetteringStyleOpPatch({ ...raw, keepOverrides: false }, castIds)) throw bad('That lettering style change has nothing valid in it.');
    const patch = reassertedLetterPatch(raw, client, doc);
    if (!patch) throw bad('That lettering style change has nothing valid in it.');
    return { op: 'letter_style', patch };
  }
};

const linesOfPage = (doc: ComicDoc, pageId: string): Map<string, Line> | undefined => {
  const page = doc.pages.find((p) => p.id === pageId);
  if (!page) return undefined;
  const out = new Map<string, Line>();
  for (const panel of page.panels) for (const line of panel.lines) out.set(line.id, line);
  return out;
};

const lineStyleSanitizer: OpSanitizer<LineStyleOp> = {
  op: 'line_style',
  sanitize(doc: ComicDoc, op: LineStyleOp): LineStyleOp {
    if (!isObject(op)) throw bad('Invalid balloon style change.');
    const pageId = typeof op.pageId === 'string' ? op.pageId : '';
    const lines = pageId ? linesOfPage(doc, pageId) : undefined;
    if (!lines) throw bad('That page is no longer in the plan.');
    if (!Array.isArray(op.lineIds) || !op.lineIds.length) throw bad('Pick at least one balloon to restyle.');
    if (op.lineIds.length > LINE_STYLE_MAX_IDS) throw bad(`Restyle at most ${LINE_STYLE_MAX_IDS} balloons at once.`);
    const ids: string[] = [];
    for (const id of op.lineIds) {
      if (typeof id !== 'string' || !lines.has(id)) throw bad('A balloon in that change is not on this page any more.');
      if (!ids.includes(id)) ids.push(id);
    }
    const mode = op.mode;
    if (mode !== undefined && mode !== 'merge' && mode !== 'replace') throw bad('Invalid balloon style mode.');
    const out: LineStyleOp = { op: 'line_style', pageId, lineIds: ids, patch: null };
    if (mode) out.mode = mode;
    if (op.patch === null) return out;
    if (!isObject(op.patch)) throw bad('Invalid balloon style change.');
    if (bytes(op.patch) > LINE_STYLE_MAX_BYTES) throw bad('That balloon style is too large.');
    const client = sanitizeLetterStylePatch(op.patch);
    // Re-assert (wave note 9): one line's own stored Pro keys may come back (an undo after a rollback); never new ones.
    const patch: LetterStylePatch | undefined = ids.length === 1 ? reassertedStylePatch(op.patch, client, lines.get(ids[0])?.style) : client;
    if (!patch) {
      // replace with an empty/invalid patch would silently wipe styles: be explicit instead.
      throw bad('That balloon style change has nothing valid in it.');
    }
    for (const id of ids) {
      const next = mode === 'replace' ? patch : mergeStylePatch(lines.get(id)?.style, patch);
      if (bytes(next) > LINE_STYLE_MAX_BYTES) throw bad('That balloon style is too large.');
    }
    out.patch = patch;
    return out;
  }
};

export const LETTERING_SANITIZERS: OpSanitizer[] = [letterStyleSanitizer as OpSanitizer, lineStyleSanitizer as OpSanitizer];
