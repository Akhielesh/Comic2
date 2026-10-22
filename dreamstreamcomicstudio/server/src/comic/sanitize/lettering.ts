// Client-patch sanitizers "lettering" (contract §5.4 / §12.1, lettering.md §9): letter_style, line_style.
// Owned by P1-LETTER-ENGINE. A sanitizer returns the op to commit (normalized: clamped ranges, valid
// enums/fonts/colours, unknown keys dropped) or throws StudioError 400 to reject the whole batch, so
// nothing reaches the doc unvalidated and the client never shows a change that vanishes on refresh.
//
// Lettering edits are free overlay changes for everyone (Easy can do everything Pro can by talking),
// so there is no caps gate here; ownership is enforced by the route before sanitizing.

import type { ComicDoc, Line } from '../../../../shared/comic/doc.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import {
  LETTERING_PRESET_IDS,
  mergeStylePatch,
  sanitizeLetterStylePatch,
  sanitizeLetteringStyleOpPatch,
  type LetterStylePatch
} from '../../../../shared/comic/lettering/style.js';
import type { OpSanitizer } from '../extensions.js';
import { StudioError } from '../types.js';

/** Max lines one line_style op may touch, and the serialized style size per line. */
export const LINE_STYLE_MAX_IDS = 80;
export const LINE_STYLE_MAX_BYTES = 2048;
const LETTER_STYLE_MAX_BYTES = 16 * 1024;

const bad = (message: string) => new StudioError('BAD_REQUEST', message, { status: 400 });
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
    const patch = sanitizeLetteringStyleOpPatch(raw, castIds);
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
    const patch: LetterStylePatch | undefined = sanitizeLetterStylePatch(op.patch);
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
