// Client-patch sanitizers "reader" (contract §5.4 / §12.1, reader.md §7). Owner: P1-READER.
//
//   reader   how the published comic presents in the reader (creator's choice; viewers override locally)
//
// The op is FREE (no spend, no render). The sanitizer rebuilds the patch from known keys only:
// enums and booleans are checked, credits/dedication are trimmed, stripped of control characters and
// capped at DOC_LIMITS.readerTextChars (longer text is rejected, never silently cut). `null` (or an
// empty string) clears a text key — `reader` is a deep-merge op (contract R4). Anything else rejects
// the whole batch with a 400 that says what to fix. Free text then goes through the batch-wide safety
// pre-filter (sanitize/safety.ts patch screen), which covers reader credits/dedication.
//
// Guided View is never the default (decisions-final #11): the rejected alias `guidedDefault` gets a
// clear message instead of a silent drop.

import type { ComicDoc, ReaderSettings } from '../../../../shared/comic/doc.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import { DOC_LIMITS } from '../../../../shared/comic/limits.js';
import type { OpSanitizer } from '../extensions.js';
import { StudioError } from '../types.js';

type ReaderOp = Extract<DocOp, { op: 'reader' }>;

export const READER_TURN_STYLES = ['paper', 'slide', 'fade'] as const;
const BOOLEAN_KEYS = ['guidedOverview', 'paperTexture', 'ambient'] as const;
const TEXT_KEYS = ['credits', 'dedication'] as const;
const KNOWN_KEYS: ReadonlySet<string> = new Set<string>(['turn', ...BOOLEAN_KEYS, ...TEXT_KEYS]);
/** Wire value that clears a deep-merge key (contract R4). */
const CLEAR = null as unknown as undefined;

const bad = (message: string) => new StudioError('BAD_REQUEST', message, { status: 400 });
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Trim, drop control characters, collapse runs of spaces (line breaks become spaces). */
export const cleanReaderText = (v: string): string =>
  v
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Validate a reader patch (shared by the client-patch sanitizer and the director tool).
 * Returns only the keys that were sent, with clean values; throws StudioError 400 otherwise.
 */
export function sanitizeReaderPatch(raw: unknown): Partial<ReaderSettings> {
  if (!isObject(raw)) throw bad('Invalid reader settings change.');
  if ('guidedDefault' in raw) {
    throw bad('Guided View is never the default — readers open it with one tap. Use guidedOverview to choose whether it starts with the whole page.');
  }
  const unknown = Object.keys(raw).filter((k) => !KNOWN_KEYS.has(k));
  if (unknown.length) throw bad(`Unknown reader setting: ${unknown.slice(0, 3).join(', ')}.`);
  const patch: Partial<ReaderSettings> = {};
  if (raw.turn !== undefined) {
    if (!(READER_TURN_STYLES as readonly unknown[]).includes(raw.turn)) throw bad(`Page-turn style must be one of: ${READER_TURN_STYLES.join(', ')}.`);
    patch.turn = raw.turn as ReaderSettings['turn'];
  }
  for (const key of BOOLEAN_KEYS) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'boolean') throw bad(`${key} must be true or false.`);
    patch[key] = raw[key] as boolean;
  }
  for (const key of TEXT_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (v === null) {
      patch[key] = CLEAR;
      continue;
    }
    if (typeof v !== 'string') throw bad(`The ${key === 'credits' ? 'credits line' : 'dedication'} must be text.`);
    const text = cleanReaderText(v);
    if (text.length > DOC_LIMITS.readerTextChars) {
      throw bad(`Keep the ${key === 'credits' ? 'credits line' : 'dedication'} to ${DOC_LIMITS.readerTextChars} characters (it has ${text.length}).`);
    }
    patch[key] = text ? text : CLEAR;
  }
  if (!Object.keys(patch).length) throw bad('Nothing to change in the reader settings.');
  return patch;
}

const readerSanitizer: OpSanitizer<ReaderOp> = {
  op: 'reader',
  sanitize(_doc: ComicDoc, op: ReaderOp): ReaderOp {
    if (!isObject(op)) throw bad('Invalid reader settings change.');
    return { op: 'reader', patch: sanitizeReaderPatch(op.patch) };
  }
};

export const READER_SANITIZERS: OpSanitizer[] = [readerSanitizer as OpSanitizer];
