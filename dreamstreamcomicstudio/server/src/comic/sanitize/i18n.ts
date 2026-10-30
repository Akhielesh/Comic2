// Client-patch sanitizers "i18n" (contract §5.4 / §12.1). Owner: P1-I18N.
//
// A sanitizer returns the op to commit (rewritten with forced fields/stamps) or throws StudioError
// (400 / 409) to reject the whole batch. Free text is screened afterwards by the safety patch screen
// (sanitize/safety.ts sees the whole batch, translations included).
//
//   edition          registry tag, never the source; only `register`; creation counts toward the cap (409)
//   translation      edition + line exist; text 1–600 chars; FORCED {status:'edited', at:now,
//                    sourceHash: lineSourceHash(current line)}; model is cleared. What an Undo sends back
//                    is KEPT where it can only add information or a publish block, never lift one:
//                    a gloss (≤ 300), a review issue ({severity, note ≤ 300, suggestion ≤ 600}), status
//                    'machine' (an unreviewed AI draft: "waiting for review") and an OLDER sourceHash
//                    (a line changed since translating: stale). 'reviewed' is never accepted.
//   edition_text     edition exists, the source field is non-empty; same forcing with textSourceHash
//   edition_balloon  edition + line exist; x/y/w/tail clamped 0..1, fontScale 0.7..1.3, pinned boolean
//   glossary_term    id shape; term ≤ 80; kind/policy enums; forms keys are registry langs (not the
//                    source), values ≤ 80 (null deletes); note ≤ 140; ≤ 200 terms (409)

import type { ComicDoc, EditionTextField, GlossaryTerm, Line, TextTranslation, TranslationRegister } from '../../../../shared/comic/doc.js';
import { trashOf } from '../../../../shared/comic/doc.js';
import { i18nOf, lineSourceHash, normalizeSource, textSourceHash } from '../../../../shared/comic/i18n.js';
import { languageSpec, sameLanguage } from '../../../../shared/comic/languages.js';
import { DOC_LIMITS } from '../../../../shared/comic/limits.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import { editionTextSource } from '../../../../shared/comic/translationPlan.js';
import type { OpSanitizer } from '../extensions.js';
import { StudioError } from '../types.js';
import { clipText, storableText } from './text.js';

type Op<K extends DocOp['op']> = Extract<DocOp, { op: K }>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const bad = (message: string) => new StudioError('BAD_REQUEST', message, { status: 400 });
const limit = (message: string) => new StudioError('LIMIT', message, { status: 409 });

const REGISTERS: readonly TranslationRegister[] = ['everyday', 'formal', 'code_mixed'];
const EDITION_FIELDS: readonly EditionTextField[] = ['brief.title', 'brief.logline', 'cover.title', 'cover.tagline'];
const KINDS: readonly GlossaryTerm['kind'][] = ['character', 'place', 'title', 'term'];
const POLICIES: readonly GlossaryTerm['policy'][] = ['transliterate', 'translate', 'keep'];
const GLOSSARY_ID = /^[A-Za-z0-9_-]{1,80}$/;
const TERM_CHARS = 80;
const NOTE_CHARS = 140;
const GLOSS_CHARS = 300;
const ISSUE_NOTE_CHARS = 300;
const ISSUE_SUGGESTION_CHARS = 600;

/** A registry tag (canonical spelling) that is not the comic's source language. */
const editionLang = (doc: ComicDoc, raw: unknown): string => {
  const spec = typeof raw === 'string' ? languageSpec(raw) : undefined;
  if (!spec || spec.code !== raw) throw bad('Unknown language.');
  if (sameLanguage(spec.code, doc.format.language)) throw bad("That is the comic's own language — edit the lines directly.");
  return spec.code;
};

const existingEdition = (doc: ComicDoc, raw: unknown): string => {
  const lang = editionLang(doc, raw);
  if (!i18nOf(doc).editions[lang]) throw bad(`There is no ${languageSpec(lang)?.english || lang} translation yet.`);
  return lang;
};

/** A line of a live page or of a page in Deleted: the Undo of removing a language puts a deleted page's translations
 *  and balloons back too (ops.ts lineIdsOf with trash), so the sanitizer accepts those lines. */
const findLine = (doc: ComicDoc, id: unknown): Line => {
  if (typeof id === 'string') {
    for (const p of [...doc.pages, ...trashOf(doc).map((t) => t.page)]) for (const panel of p.panels) for (const l of panel.lines) if (l.id === id) return l;
  }
  throw bad('That line no longer exists.');
};

/** Storable (no NUL or lone surrogate — jsonb; see ./text.ts) THEN source-normalized, so the trim sees the cleaned text. */
const storableSource = (raw: string): string => normalizeSource(storableText(raw));

const cleanText = (raw: unknown): string => {
  if (typeof raw !== 'string') throw bad('Send the translated text.');
  const text = storableSource(raw);
  if (!text) throw bad('Type the translation, or remove it.');
  if (text.length > DOC_LIMITS.translationChars) throw bad(`A translation can be at most ${DOC_LIMITS.translationChars} characters.`);
  return text;
};

const clamp01 = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : undefined);

/** A gloss the client sends back (Undo of an edit): plain text ≤ 300 chars, or nothing. */
const clientGloss = (raw: unknown): string | undefined => {
  if (typeof raw !== 'string') return undefined;
  const text = storableSource(raw);
  return text ? clipText(text, GLOSS_CHARS) : undefined;
};

/** A review flag the client sends back (Undo of an edit). It can only ADD blocking (a major issue), never lift it. */
const clientIssue = (raw: unknown): TextTranslation['issue'] | undefined => {
  if (!isObj(raw) || typeof raw.note !== 'string') return undefined;
  const severity = raw.severity;
  if (severity !== 'major' && severity !== 'minor') return undefined;
  const note = storableSource(raw.note);
  if (!note) return undefined;
  const issue: NonNullable<TextTranslation['issue']> = { severity, note: clipText(note, ISSUE_NOTE_CHARS) };
  const suggestion = typeof raw.suggestion === 'string' ? storableSource(raw.suggestion) : '';
  if (suggestion) issue.suggestion = clipText(suggestion, ISSUE_SUGGESTION_CHARS);
  return issue;
};

/**
 * A source hash the client sends back (Undo to a line that had changed since translating): kept only when it is
 * a well-formed hash that is NOT the current one — it can only mark the line stale (a publish block), never
 * claim a translation is current. Anything else → undefined (the current hash is stamped).
 */
const olderSourceHash = (raw: unknown, current: string): string | undefined =>
  typeof raw === 'string' && /^[0-9a-f]{8}$/.test(raw) && raw !== current ? raw : undefined;

export const sanitizeEdition: OpSanitizer<Op<'edition'>> = {
  op: 'edition',
  sanitize(doc, op) {
    const lang = editionLang(doc, op.lang);
    const exists = !!i18nOf(doc).editions[lang];
    if (op.patch === null) return { op: 'edition', lang, patch: null };
    if (!isObj(op.patch)) throw bad('Bad edition change.');
    if (!exists && Object.keys(i18nOf(doc).editions).length >= DOC_LIMITS.editions) throw limit(`A comic can have up to ${DOC_LIMITS.editions} translations.`);
    const register = op.patch.register;
    if (register !== undefined && !REGISTERS.includes(register)) throw bad('Register must be everyday, formal or code_mixed.');
    return { op: 'edition', lang, patch: register ? { register } : {} };
  }
};

export const sanitizeTranslation: OpSanitizer<Op<'translation'>> = {
  op: 'translation',
  sanitize(doc, op, ctx) {
    const lang = existingEdition(doc, op.lang);
    const line = findLine(doc, op.lineId);
    if (op.patch === null) return { op: 'translation', lang, lineId: line.id, patch: null };
    if (!isObj(op.patch)) throw bad('Bad translation change.');
    const text = cleanText(op.patch.text);
    // Forced: a human edit is 'edited' (the client never mints 'reviewed' or a model), stamped now, against
    // the CURRENT source. An Undo sends the previous entry back; of it, only what can add a publish block is
    // kept: 'machine' (back to "waiting for review"), an older source hash (back to "changed since
    // translating"), the review flag, and the gloss (information). Unsent gloss/issue are cleared — the
    // old ones described a different text.
    const current = lineSourceHash(line);
    const patch: Partial<TextTranslation> = {
      text,
      status: op.patch.status === 'machine' ? 'machine' : 'edited',
      at: ctx.now,
      sourceHash: olderSourceHash(op.patch.sourceHash, current) ?? current,
      gloss: clientGloss(op.patch.gloss),
      issue: clientIssue(op.patch.issue),
      model: undefined
    };
    return { op: 'translation', lang, lineId: line.id, patch };
  }
};

export const sanitizeEditionText: OpSanitizer<Op<'edition_text'>> = {
  op: 'edition_text',
  sanitize(doc, op, ctx) {
    const lang = existingEdition(doc, op.lang);
    if (!EDITION_FIELDS.includes(op.field)) throw bad('Unknown title field.');
    if (op.value === null) return { op: 'edition_text', lang, field: op.field, value: null };
    if (!isObj(op.value)) throw bad('Bad title change.');
    const source = editionTextSource(doc, op.field);
    if (!source) throw bad('There is no original text to translate for that field.');
    const text = cleanText(op.value.text);
    return { op: 'edition_text', lang, field: op.field, value: { text, status: 'edited', sourceHash: textSourceHash(source), at: ctx.now } };
  }
};

export const sanitizeEditionBalloon: OpSanitizer<Op<'edition_balloon'>> = {
  op: 'edition_balloon',
  sanitize(doc, op) {
    const lang = existingEdition(doc, op.lang);
    const line = findLine(doc, op.lineId);
    if (op.patch === null) return { op: 'edition_balloon', lang, lineId: line.id, patch: null };
    if (!isObj(op.patch)) throw bad('Bad balloon change.');
    const raw = op.patch as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    for (const k of ['x', 'y', 'w', 'tailX', 'tailY'] as const) {
      if (raw[k] === null) patch[k] = undefined;
      else {
        const v = clamp01(raw[k]);
        if (v !== undefined) patch[k] = v;
      }
    }
    if (raw.fontScale === null) patch.fontScale = undefined;
    else if (typeof raw.fontScale === 'number' && Number.isFinite(raw.fontScale)) patch.fontScale = Math.min(1.3, Math.max(0.7, raw.fontScale));
    if (typeof raw.pinned === 'boolean') patch.pinned = raw.pinned;
    if (!Object.keys(patch).length) throw bad('Nothing to change on that balloon.');
    return { op: 'edition_balloon', lang, lineId: line.id, patch: patch as Op<'edition_balloon'>['patch'] };
  }
};

export const sanitizeGlossaryTerm: OpSanitizer<Op<'glossary_term'>> = {
  op: 'glossary_term',
  sanitize(doc, op) {
    if (typeof op.id !== 'string' || !GLOSSARY_ID.test(op.id)) throw bad('Bad glossary id.');
    const glossary = i18nOf(doc).glossary;
    const prev = glossary.find((t) => t.id === op.id);
    if (op.patch === null) return { op: 'glossary_term', id: op.id, patch: null };
    if (!isObj(op.patch)) throw bad('Bad glossary change.');
    const raw = op.patch as Record<string, unknown>;
    const patch: Partial<GlossaryTerm> = {};
    if (raw.term !== undefined) {
      if (typeof raw.term !== 'string' || !storableSource(raw.term)) throw bad('A glossary term needs its original wording.');
      patch.term = clipText(storableSource(raw.term), TERM_CHARS);
    }
    if (!prev && !patch.term) throw bad('A new glossary term needs its original wording.');
    if (!prev && glossary.length >= DOC_LIMITS.glossaryTerms) throw limit(`The glossary holds up to ${DOC_LIMITS.glossaryTerms} terms.`);
    if (raw.kind !== undefined) {
      if (!KINDS.includes(raw.kind as GlossaryTerm['kind'])) throw bad('Glossary kind must be character, place, title or term.');
      patch.kind = raw.kind as GlossaryTerm['kind'];
    }
    if (raw.policy !== undefined) {
      if (!POLICIES.includes(raw.policy as GlossaryTerm['policy'])) throw bad('Glossary policy must be transliterate, translate or keep.');
      patch.policy = raw.policy as GlossaryTerm['policy'];
    }
    if (raw.note !== undefined) {
      if (raw.note === null || raw.note === '') patch.note = undefined;
      else if (typeof raw.note === 'string') patch.note = clipText(storableSource(raw.note), NOTE_CHARS);
      else throw bad('Glossary notes are text.');
    }
    if (raw.refId !== undefined) {
      const ok = typeof raw.refId === 'string' && (doc.cast.some((c) => c.id === raw.refId) || doc.places.some((p) => p.id === raw.refId));
      if (ok) patch.refId = raw.refId as string;
    }
    if (raw.forms !== undefined) {
      if (!isObj(raw.forms)) throw bad('Glossary forms are language → text.');
      const forms: Record<string, string | null> = {};
      for (const [k, v] of Object.entries(raw.forms).slice(0, 40)) {
        const spec = languageSpec(k);
        if (!spec || spec.code !== k || sameLanguage(k, doc.format.language)) throw bad(`Unknown glossary language “${k.slice(0, 20)}”.`);
        if (v === null || v === '') forms[k] = null;
        else if (typeof v === 'string' && storableSource(v)) forms[k] = clipText(storableSource(v), TERM_CHARS);
        else throw bad('Glossary forms are text.');
      }
      patch.forms = forms as Record<string, string>;
    }
    return { op: 'glossary_term', id: op.id, patch };
  }
};

export const I18N_SANITIZERS: OpSanitizer[] = [
  sanitizeEdition,
  sanitizeTranslation,
  sanitizeEditionText,
  sanitizeEditionBalloon,
  sanitizeGlossaryTerm
] as OpSanitizer[];
