// Robust JSON coercion for LLM output.
//
// The legacy pipeline relied on Gemini's `responseSchema` to guarantee valid
// JSON. OpenRouter's structured-output support varies by model, so any model
// output that is *supposed* to be JSON must be defensively parsed: strip
// markdown fences, scan for the first balanced block, and clean common glitches
// (trailing commas) before giving up.

import { extractJson } from './json.js';

/** Remove ```json fences and surrounding prose markers. */
const stripFences = (text: string): string =>
  text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();

/**
 * Scan for the first balanced {...} or [...] block. String/escape aware so that
 * braces inside string literals don't throw off the depth counter.
 */
export const extractBalancedJson = (text: string): string | null => {
  const src = text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch !== '{' && ch !== '[') continue;
    const open = ch;
    const close = ch === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < src.length; j++) {
      const c = src[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') {
        inString = true;
        continue;
      }
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) return src.slice(i, j + 1);
      }
    }
  }
  return null;
};

/** Best-effort cleanup of common LLM JSON glitches (currently: trailing commas). */
const cleanupJsonish = (text: string): string => text.replace(/,(\s*[}\]])/g, '$1');

/**
 * Coerce arbitrary model output into parsed JSON.
 * Strategy: direct parse -> fence-aware extractor -> balanced-block scan ->
 * trailing-comma cleanup. Throws if nothing parses.
 */
export const coerceJson = (text: string): unknown => {
  const trimmed = (text || '').trim();
  if (!trimmed) throw new Error('Empty response: no JSON to parse.');

  // 1. direct parse
  try {
    return JSON.parse(trimmed);
  } catch {
    /* continue */
  }

  // 2. existing fence-aware extractor
  try {
    return extractJson(trimmed);
  } catch {
    /* continue */
  }

  // 3. balanced-block scan on fence-stripped text
  const stripped = stripFences(trimmed);
  const balanced = extractBalancedJson(stripped);
  if (balanced) {
    try {
      return JSON.parse(balanced);
    } catch {
      try {
        return JSON.parse(cleanupJsonish(balanced));
      } catch {
        /* continue */
      }
    }
  }

  // 4. last resort: clean the whole thing
  try {
    return JSON.parse(cleanupJsonish(stripped));
  } catch (err) {
    throw new Error(`Unable to coerce model output into JSON: ${(err as Error).message}`);
  }
};

/** Like coerceJson but returns null instead of throwing. */
export const coerceJsonOrNull = (text: string): unknown | null => {
  try {
    return coerceJson(text);
  } catch {
    return null;
  }
};
