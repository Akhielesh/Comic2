// Text as it ENTERS the doc (P2-GATE L5). Postgres jsonb rejects `\u0000` (22P05) and an unpaired
// UTF-16 surrogate (22P02) anywhere in a document. The doc store cleans what it writes (store.ts
// jsonbSafe), but a live doc that still holds such a character hashes differently from its stored
// copy once reloaded (page spec hashes, translation source hashes), so pages and lines would show
// as outdated and a later redraw/re-translate quote could include them. Every text sanitizer drops
// those characters at the door instead, and never splits a pair when it clips — so the live doc and
// the stored doc are the same bytes. Pure; no I/O; safe to import anywhere (jobs.ts included).

/** A NUL or a UTF-16 surrogate: the only characters that need a second look. */
const SUSPECT = /[\u0000\uD800-\uDFFF]/;
/** A high surrogate with no low one after it, or a low surrogate with no high one before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * One string as Postgres jsonb accepts it: NULs and lone surrogates removed; whole pairs (emoji,
 * supplementary scripts) kept. Same reference when there is nothing to fix. Other control characters
 * are left to each field's own rule (a premise keeps its line breaks; a name does not).
 */
export const storableText = (s: string): string => (SUSPECT.test(s) ? s.replace(/\u0000/g, '').replace(LONE_SURROGATE, '') : s);

/** `s.slice(0, max)` that never ends on half a pair: a high surrogate left at the cut is dropped too. */
export const clipText = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const out = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
};

/** The entry form of a free-text field: cleaned, trimmed, then clipped without splitting a pair. */
export const enteredText = (s: string, max: number): string => clipText(storableText(s).trim(), max);
