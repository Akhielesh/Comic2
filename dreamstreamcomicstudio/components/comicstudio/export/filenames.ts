// Safe download and ZIP-entry names (requirements-addendum §3: "filenames sanitized in downloads").
//
// A title is author text: it may hold path separators, Windows-reserved characters, control and bidi
// characters (an "evil.pdf‮fdp.exe"-style spoof), a leading dot, a reserved device name or simply be
// very long. Every name a download or a ZIP entry uses goes through `sanitizeFilename`, which:
//   - keeps letters, marks and digits of EVERY script (a Telugu title stays Telugu — Indic text needs
//     its combining marks and ZWJ/ZWNJ), folds Latin accents to ASCII ("Café" → "cafe") so classic
//     names stay exactly what they were;
//   - turns everything else (spaces, punctuation, / \ : * ? " < > |) into single hyphens;
//   - drops control, bidi-override, zero-width-space and BOM characters outright;
//   - never starts with a dot or hyphen, never ends with a dot, space or hyphen;
//   - is cut at a grapheme boundary (never half a syllable) and never names a Windows device.

import { graphemes } from '../../../shared/comic/textLayout';
import { languageSpec } from '../../../shared/comic/languages';
import type { ComicDoc } from '../../../shared/comic/doc';

/** Longest stem (graphemes) a download name keeps. */
export const MAX_STEM_GRAPHEMES = 60;
/**
 * Longest stem in UTF-8 bytes. File systems cap a NAME at 255 bytes (ext4, APFS) and a Telugu or
 * Devanagari grapheme is 3–12 bytes, so 60 graphemes alone could overflow once "-te-motion-9x16.mp4"
 * is appended. ASCII titles are never affected (60 graphemes = 60 bytes).
 */
export const MAX_STEM_BYTES = 150;

// Control characters, bidi embeddings/overrides/isolates, LRM/RLM/ALM, zero-width space, word joiner, BOM.
// ZWNJ (U+200C) and ZWJ (U+200D) are kept: Indic and Arabic spellings need them.
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f؜​‎‏‪-‮⁠-⁤⁦-⁩﻿]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

const hasNonLatinLetters = (s: string): boolean => /(?!\p{Script=Latin})\p{L}/u.test(s);
const utf8Length = (s: string): number => new TextEncoder().encode(s).length;

/**
 * A filesystem- and header-safe name. `fallback` is used when nothing usable is left.
 * Latin-only titles are ASCII-folded and lower-cased; titles with letters of other scripts keep them.
 */
export function sanitizeFilename(name: unknown, opts: { fallback?: string; maxGraphemes?: number } = {}): string {
  const fallback = opts.fallback ?? 'comic';
  const max = Math.max(1, Math.floor(opts.maxGraphemes ?? MAX_STEM_GRAPHEMES));
  let s = typeof name === 'string' ? name : '';
  s = s.replace(INVISIBLE, '');
  try {
    s = s.normalize('NFC');
  } catch {
    /* keep as is */
  }
  let out: string;
  if (!hasNonLatinLetters(s)) {
    // Latin (or no letters at all): the classic ASCII slug.
    out = s
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');
  } else {
    out = s
      .normalize('NFC')
      .toLowerCase()
      // Keep letters, combining marks, digits and the joiners Indic/Arabic spellings need.
      .replace(/[^\p{L}\p{M}\p{N}‌‍]+/gu, '-');
  }
  out = out.replace(/-+/g, '-').replace(/^[-.]+|[-. ]+$/g, '');
  const gs = graphemes(out).slice(0, max);
  while (gs.length > 1 && utf8Length(gs.join('')) > MAX_STEM_BYTES) gs.pop();
  if (gs.join('') !== out) out = gs.join('').replace(/[-. ]+$/g, '');
  // One "grapheme" stacked with hundreds of combining marks is no name at all.
  if (!out || utf8Length(out) > MAX_STEM_BYTES) return fallback;
  if (WINDOWS_RESERVED.test(out)) out = `${out}-comic`;
  return out;
}

/** A language code safe for a file or folder name ('te', 'zh-Hans'); undefined when malformed. */
export function safeLangCode(lang: unknown): string | undefined {
  if (typeof lang !== 'string') return undefined;
  const t = lang.trim();
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/.test(t) ? t : undefined;
}

/**
 * File-name stem from the (localized) title: "The Saffron Thief!" → "the-saffron-thief"; with a
 * language that is not the comic's source, "-te" is appended ("the-saffron-thief-te").
 */
export function exportFileStem(doc: Pick<ComicDoc, 'brief'> & Partial<Pick<ComicDoc, 'cover'>>, lang?: string): string {
  const title = doc.brief?.title || '';
  const stem = sanitizeFilename(title);
  const code = safeLangCode(lang);
  return code ? `${stem}-${code}` : stem;
}

/** Folder name for one language inside an "all languages" ZIP: "te-telugu", "zh-Hans-chinese-simplified". */
export function languageFolderName(lang: string): string {
  const code = safeLangCode(lang) ?? 'lang';
  const english = languageSpec(code)?.english;
  const label = english ? sanitizeFilename(english, { fallback: '' }) : '';
  return label ? `${code}-${label}` : code;
}

/** Two-or-more-digit counter for reading-order file names ("00", "07", "112"). */
export const padIndex = (i: number, total: number): string => String(i).padStart(Math.max(2, String(Math.max(0, total - 1)).length), '0');
