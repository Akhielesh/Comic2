// Translations (I18N) — pure helpers over ComicDoc.i18n (contract §9.5).
//
// format.language is the SOURCE language and never appears in i18n.editions. Statuses
// 'missing' / 'stale' / 'stale_edited' are DERIVED here (never stored). A language is
// publishable once every translatable line is translated, current, reviewed (or written by
// the author), has no open major linguist issue, and the comic uses overlay lettering.

import type {
  Balloon,
  BalloonGeometryOverride,
  ComicDoc,
  EditionTextField,
  GlossaryTerm,
  I18nState,
  LanguageEdition,
  Line,
  TextTranslation,
  TranslationFailure,
  TranslationRegister,
  TranslationStatus
} from './doc.js';
import { hashString } from './hash.js';
import { languageSpec, sameLanguage } from './languages.js';
// Types only (erased at run time): translationProblems.ts re-exports the classifier below, so a value import here
// would be an import cycle.
import type { FixKind, LineRef, ProblemKind, TranslationProblem } from './translationProblems.js';

export const EMPTY_I18N: I18nState = { editions: {}, glossary: [] };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const clampNum = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;

const STATUSES: readonly TranslationStatus[] = ['machine', 'reviewed', 'edited'];
const REGISTERS: readonly TranslationRegister[] = ['everyday', 'formal', 'code_mixed'];

/** Normalize one stored translation; undefined when it has no string text. */
export const normalizeTextTranslation = (raw: unknown): TextTranslation | undefined => {
  if (!isObj(raw) || typeof raw.text !== 'string') return undefined;
  const t: TextTranslation = {
    text: raw.text,
    status: STATUSES.includes(raw.status as TranslationStatus) ? (raw.status as TranslationStatus) : 'machine',
    sourceHash: typeof raw.sourceHash === 'string' ? raw.sourceHash : '',
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? raw.at : 0
  };
  if (typeof raw.gloss === 'string' && raw.gloss) t.gloss = raw.gloss;
  if (isObj(raw.issue) && (raw.issue.severity === 'minor' || raw.issue.severity === 'major') && typeof raw.issue.note === 'string') {
    t.issue = { severity: raw.issue.severity, note: raw.issue.note };
    if (typeof raw.issue.suggestion === 'string') t.issue.suggestion = raw.issue.suggestion;
  }
  if (typeof raw.model === 'string' && raw.model) t.model = raw.model;
  return t;
};

/** Clamp a per-language balloon override (x, y, w, tail 0..1; fontScale 0.7..1.3). Undefined when empty. */
export const normalizeBalloonOverride = (raw: unknown): BalloonGeometryOverride | undefined => {
  if (!isObj(raw)) return undefined;
  const out: BalloonGeometryOverride = {};
  for (const k of ['x', 'y', 'w', 'tailX', 'tailY'] as const) {
    const v = clampNum(raw[k], 0, 1);
    if (v !== undefined) out[k] = v;
  }
  const fs = clampNum(raw.fontScale, 0.7, 1.3);
  if (fs !== undefined) out.fontScale = fs;
  if (typeof raw.pinned === 'boolean') out.pinned = raw.pinned;
  return Object.keys(out).length ? out : undefined;
};

const normalizeTexts = <K extends string>(raw: unknown, keys: readonly K[]): Partial<Record<K, TextTranslation>> | undefined => {
  if (!isObj(raw)) return undefined;
  const out: Partial<Record<K, TextTranslation>> = {};
  for (const k of keys) {
    const t = normalizeTextTranslation(raw[k]);
    if (t) out[k] = t;
  }
  return Object.keys(out).length ? out : undefined;
};

// ── Failure records (STU-T0) ─────────────────────────────────────────────────

/** At most this many failure records per edition (≈ 80 bytes each); later ones are dropped. */
export const TRANSLATION_FAILURES_MAX = 2000;
const FAILURE_REASONS: readonly TranslationFailure['reason'][] = ['unsafe', 'timeout', 'provider', 'empty'];
const FAILURE_KEY_MAX = 200;
const FAILURE_HASH_MAX = 64;

/** A well-formed failure record or undefined. Only the four fields are kept (no model, no text); attempts are whole,
 *  1..9 (a count above 9 is kept as 9: a tenth refusal must not turn the line back into a plain missing one). */
export const normalizeTranslationFailure = (raw: unknown): TranslationFailure | undefined => {
  if (!isObj(raw) || !FAILURE_REASONS.includes(raw.reason as TranslationFailure['reason'])) return undefined;
  if (typeof raw.sourceHash !== 'string' || !raw.sourceHash || raw.sourceHash.length > FAILURE_HASH_MAX) return undefined;
  if (typeof raw.attempts !== 'number' || !Number.isFinite(raw.attempts) || raw.attempts < 1) return undefined;
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return undefined;
  return { reason: raw.reason as TranslationFailure['reason'], sourceHash: raw.sourceHash, attempts: Math.min(9, Math.floor(raw.attempts)), at: raw.at };
};

/** A usable failure-map key: a line id or an edition field name. */
export const isFailureKey = (key: unknown): key is string => typeof key === 'string' && !!key && key.length <= FAILURE_KEY_MAX && key !== '__proto__';

const normalizeFailures = (raw: unknown): Record<string, TranslationFailure> | undefined => {
  if (!isObj(raw)) return undefined;
  const out: Record<string, TranslationFailure> = {};
  let n = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (n >= TRANSLATION_FAILURES_MAX) break;
    if (!isFailureKey(key)) continue;
    const f = normalizeTranslationFailure(value);
    if (!f) continue;
    out[key] = f;
    n += 1;
  }
  return n ? out : undefined;
};

const normalizeEdition = (lang: string, raw: Record<string, unknown>): LanguageEdition => {
  const lines: Record<string, TextTranslation> = {};
  if (isObj(raw.lines)) {
    for (const [id, v] of Object.entries(raw.lines)) {
      const t = normalizeTextTranslation(v);
      if (t) lines[id] = t;
    }
  }
  const balloons: Record<string, BalloonGeometryOverride> = {};
  if (isObj(raw.balloons)) {
    for (const [id, v] of Object.entries(raw.balloons)) {
      const b = normalizeBalloonOverride(v);
      if (b) balloons[id] = b;
    }
  }
  const edition: LanguageEdition = {
    lang,
    lines,
    balloons,
    register: REGISTERS.includes(raw.register as TranslationRegister) ? (raw.register as TranslationRegister) : 'everyday'
  };
  const cover = normalizeTexts(raw.cover, ['title', 'tagline'] as const);
  if (cover) edition.cover = cover;
  const brief = normalizeTexts(raw.brief, ['title', 'logline'] as const);
  if (brief) edition.brief = brief;
  // Optional (STU-T0): an edition stored before failure records keeps exactly the keys it had.
  const failures = normalizeFailures(raw.failures);
  if (failures) edition.failures = failures;
  return edition;
};

const GLOSSARY_KINDS: readonly GlossaryTerm['kind'][] = ['character', 'place', 'title', 'term'];
const GLOSSARY_POLICIES: readonly GlossaryTerm['policy'][] = ['transliterate', 'translate', 'keep'];

export const normalizeGlossaryTerm = (raw: unknown): GlossaryTerm | undefined => {
  if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id || typeof raw.term !== 'string' || !raw.term) return undefined;
  const forms: Record<string, string> = {};
  if (isObj(raw.forms)) for (const [k, v] of Object.entries(raw.forms)) if (typeof v === 'string') forms[k] = v;
  const term: GlossaryTerm = {
    id: raw.id,
    term: raw.term,
    kind: GLOSSARY_KINDS.includes(raw.kind as GlossaryTerm['kind']) ? (raw.kind as GlossaryTerm['kind']) : 'term',
    policy: GLOSSARY_POLICIES.includes(raw.policy as GlossaryTerm['policy']) ? (raw.policy as GlossaryTerm['policy']) : 'transliterate',
    forms
  };
  if (typeof raw.refId === 'string' && raw.refId) term.refId = raw.refId;
  if (typeof raw.note === 'string' && raw.note) term.note = raw.note;
  return term;
};

/** Keeps editions whose key is a LANGUAGES tag and not the source; drops non-string line texts; defaults
 *  balloons {} and register 'everyday'; glossary entries need id+term (forms {} default, policy 'transliterate').
 *  Legacy keys (published, inArtPolicy, status, allowFallback, updatedAt) are DROPPED. */
export const normalizeI18n = (raw: unknown, sourceLang: string): I18nState => {
  if (!isObj(raw)) return { editions: {}, glossary: [] };
  const editions: Record<string, LanguageEdition> = {};
  if (isObj(raw.editions)) {
    for (const [key, value] of Object.entries(raw.editions)) {
      const spec = languageSpec(key);
      if (!spec || spec.code !== key || sameLanguage(key, sourceLang) || !isObj(value)) continue;
      editions[key] = normalizeEdition(key, value);
    }
  }
  const seen = new Set<string>();
  const glossary = (Array.isArray(raw.glossary) ? raw.glossary : [])
    .map(normalizeGlossaryTerm)
    .filter((t): t is GlossaryTerm => !!t && !seen.has(t.id) && !!seen.add(t.id));
  return { editions, glossary };
};

export const i18nOf = (doc: ComicDoc): I18nState => doc.i18n ?? EMPTY_I18N;

// ── Source hashes ────────────────────────────────────────────────────────────

/** NFC; collapse ASCII whitespace only (NBSP and U+202F stay glued); trim (ASCII whitespace only). */
export const normalizeSource = (text: string): string =>
  (typeof text === 'string' ? text : '')
    .normalize('NFC')
    .replace(/[ \t\n\r\f\v]+/g, ' ')
    .replace(/^ +| +$/g, '');

/** hashString(['L1', kind, speakerId||'', normalizeSource(text), noTranslate ? 1 : 0].join('␟')) */
export const lineSourceHash = (line: Pick<Line, 'kind' | 'text' | 'speakerId' | 'noTranslate'>): string =>
  hashString(['L1', line.kind, line.speakerId || '', normalizeSource(line.text), line.noTranslate ? 1 : 0].join('␟'));

export const textSourceHash = (text: string): string => hashString(['T1', normalizeSource(text)].join('␟'));

/** Letters-only hash: equal ⇒ only punctuation/case/spacing changed (free carry-over). */
export const looseSourceHash = (text: string): string =>
  hashString(['X1', (typeof text === 'string' ? text : '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, '')].join('␟'));

// ── Status & progress ────────────────────────────────────────────────────────

export type DerivedStatus = 'missing' | 'stale' | 'stale_edited' | TranslationStatus | 'not_needed';

const isSource = (doc: ComicDoc, lang: string) => sameLanguage(lang, doc.format.language);
const needsTranslation = (line: Line) => !!normalizeSource(line.text) && line.noTranslate !== true;

export const translationStatus = (doc: ComicDoc, lang: string, line: Line): DerivedStatus => {
  if (isSource(doc, lang) || !needsTranslation(line)) return 'not_needed';
  const entry = i18nOf(doc).editions[lang]?.lines[line.id];
  if (!entry) return 'missing';
  if (entry.sourceHash !== lineSourceHash(line)) return entry.status === 'edited' ? 'stale_edited' : 'stale';
  return entry.status;
};

const allLines = (doc: ComicDoc): Line[] => doc.pages.flatMap((p) => p.panels.flatMap((panel) => panel.lines));

export interface EditionProgress {
  lang: string; total: number; done: number; missing: number; stale: number; staleEdited: number;
  unreviewed: number; flagged: number; edited: number; coverTitle: 'ok' | 'missing' | 'in_art_only';
}

const coverTitleStatus = (doc: ComicDoc, lang: string): EditionProgress['coverTitle'] => {
  const painted = (doc.cover.lettering ?? 'in_art') === 'in_art' && !!doc.cover.render.asset;
  if (painted) return 'in_art_only';
  const edition = i18nOf(doc).editions[lang];
  return edition?.cover?.title || edition?.brief?.title ? 'ok' : 'missing';
};

export const editionProgress = (doc: ComicDoc, lang: string): EditionProgress => {
  const out: EditionProgress = {
    lang, total: 0, done: 0, missing: 0, stale: 0, staleEdited: 0, unreviewed: 0, flagged: 0, edited: 0,
    coverTitle: coverTitleStatus(doc, lang)
  };
  const edition = i18nOf(doc).editions[lang];
  for (const line of allLines(doc)) {
    const status = translationStatus(doc, lang, line);
    if (status === 'not_needed') continue;
    out.total += 1;
    if (status === 'missing') out.missing += 1;
    else if (status === 'stale') out.stale += 1;
    else if (status === 'stale_edited') out.staleEdited += 1;
    else {
      out.done += 1;
      const issue = edition?.lines[line.id]?.issue;
      // "Waiting for review" = a machine line no reviewer has judged. One the review (or software) flagged
      // MAJOR was judged: it counts as flagged (blocking via major_issue), never as unreviewed as well.
      if (status === 'machine' && issue?.severity !== 'major') out.unreviewed += 1;
      if (status === 'edited') out.edited += 1;
      if (issue) out.flagged += 1;
    }
  }
  return out;
};

// ── Problems: what is wrong, where, and what fixes it (STU-T0) ───────────────
//
// The one classifier behind translationProblems() (re-exported, with its types and fixPlanFor, from
// translationProblems.ts) and editionReadiness() below, so the Languages tab, the review, the chat and a refused
// publish always name the same lines. Pure and free.

/** The translator's content-check notes (server/src/comic/i18n/translate.ts, word for word): a line flagged with one
 *  of them is the creator's to settle — translating it again would only meet the same check. */
export const CONTENT_CHECK_NOTES: readonly string[] = [
  "The translation didn't pass the content check.",
  'The content check is unsure about this wording — please read it before publishing.'
];

/** Titles in the order the review shows them (before the pages). */
const TITLE_FIELDS: readonly EditionTextField[] = ['brief.title', 'brief.logline', 'cover.title', 'cover.tagline'];
const TITLE_WORDS: Record<EditionTextField, string> = {
  'brief.title': 'the title',
  'brief.logline': 'the logline',
  'cover.title': 'the cover title',
  'cover.tagline': 'the cover tagline'
};
const isTitleField = (id: string): id is EditionTextField => (TITLE_FIELDS as readonly string[]).includes(id);

/** The source of a title field (translationPlan.ts editionTextSource; kept here so i18n.ts imports nothing back). */
const titleSource = (doc: ComicDoc, field: EditionTextField): string => {
  const [group, key] = field.split('.') as ['cover' | 'brief', string];
  const v = (doc[group] as unknown as Record<string, unknown> | undefined)?.[key];
  return normalizeSource(typeof v === 'string' ? v : '');
};
const titleEntry = (edition: LanguageEdition | undefined, field: EditionTextField): TextTranslation | undefined => {
  const [group, key] = field.split('.') as ['cover' | 'brief', string];
  return (edition?.[group] as Record<string, TextTranslation> | undefined)?.[key];
};

const titleRef = (field: EditionTextField): LineRef => ({ lineId: field, pageId: '', page: 0, panel: 0, line: 0, kind: 'caption', field });

/** Every line with its address, pages by n, panels by n, lines in array order (the review's row order). Built fresh
 *  on every call: readiness (which gates publishing) never reads a cached walk. */
const addressedLines = (doc: ComicDoc): { line: Line; ref: LineRef }[] => {
  const out: { line: Line; ref: LineRef }[] = [];
  for (const page of [...(doc.pages || [])].sort((a, b) => a.n - b.n))
    for (const panel of [...page.panels].sort((a, b) => a.n - b.n))
      panel.lines.forEach((line, i) => {
        const ref: LineRef = { lineId: line.id, pageId: page.id, page: page.n, panel: panel.n, line: i + 1, kind: line.kind };
        if (line.speakerId) ref.speakerId = line.speakerId;
        out.push({ line, ref });
      });
  return out;
};

// Docs are immutable (ops return new pages arrays), so the addresses of one pages array never change: one walk serves
// every row of a review or list (lineRefOf per row would otherwise sort the whole book each time).
const refsByPages = new WeakMap<object, ReadonlyMap<string, LineRef>>();

/** Every line's address (live pages), keyed by line id, in reading order. Computed once per pages array; the refs are
 *  frozen (shared between callers). Titles are not in it (lineRefOf answers them). */
export const lineRefsOf = (doc: ComicDoc): ReadonlyMap<string, LineRef> => {
  const pages = Array.isArray(doc?.pages) ? doc.pages : undefined;
  if (!pages) return new Map();
  const hit = refsByPages.get(pages);
  if (hit) return hit;
  const map = new Map<string, LineRef>();
  for (const { ref } of addressedLines(doc)) if (!map.has(ref.lineId)) map.set(ref.lineId, Object.freeze(ref));
  refsByPages.set(pages, map);
  return map;
};

/** Where a line (live pages only) or a title field is; undefined for anything else. */
export const lineRefOf = (doc: ComicDoc, lineId: string): LineRef | undefined => {
  if (typeof lineId !== 'string') return undefined;
  if (isTitleField(lineId)) return titleRef(lineId);
  return lineRefsOf(doc).get(lineId);
};

const placeOf = (r: LineRef): string => (r.field ? TITLE_WORDS[r.field] : `page ${r.page}, panel ${r.panel}, line ${r.line}`);

/**
 * "page 4, panel 2, line 1"; "page 4, panel 2, line 1 and page 5, panel 1, line 3"; three or more are split by
 * semicolons, and past `max` the rest are counted: "…; page 5, panel 1, line 3 and 2 more". Titles read "the title".
 */
export const whereText = (refs: readonly LineRef[], max = 3): string => {
  if (!refs.length) return '';
  const cap = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 3;
  const parts = refs.slice(0, cap).map(placeOf);
  if (refs.length > cap) parts.push(`${refs.length - cap} more`);
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(parts.length > 2 ? '; ' : '')} and ${parts[parts.length - 1]}`;
};

type LineIssueCode = 'missing' | 'stale' | 'unreviewed' | 'major_issue';
interface Classified { problem: TranslationProblem; code?: LineIssueCode }

/** A flagged line whose redo failed this many times in a row is the creator's (no further machine retry is offered). */
const FLAGGED_REDO_ATTEMPTS = 2;

const FAILURE_FIX: Record<TranslationFailure['reason'], { kind: ProblemKind; fix: FixKind }> = {
  unsafe: { kind: 'refused', fix: 'creator' },
  timeout: { kind: 'timed_out', fix: 'smaller_parts' },
  provider: { kind: 'provider_failed', fix: 'translate' },
  empty: { kind: 'provider_failed', fix: 'translate' }
};

/** One text's problem (undefined = none). `blocking` false for titles; a minor note never blocks. */
const judge = (lang: string, ref: LineRef, entry: TextTranslation | undefined, hash: string, stored: TranslationFailure | undefined, blocking: boolean): Classified | undefined => {
  // A failure counts only for the source it was recorded on.
  const failure = stored && stored.sourceHash === hash ? stored : undefined;
  const make = (kind: ProblemKind, fix: FixKind, code: LineIssueCode | undefined, extra?: Pick<TranslationProblem, 'note' | 'reason'>): Classified => {
    const block = kind !== 'note' && blocking;
    return { problem: { lang, kind, ref, blocking: block, fix, ...extra }, code: block ? code : undefined };
  };
  if (!entry || entry.sourceHash !== hash) {
    const code: LineIssueCode = entry ? 'stale' : 'missing';
    // The author's own words whose original changed: theirs to settle (never re-translated over them).
    if (entry?.status === 'edited') return make('stale_edited', 'creator', code);
    if (failure) return make(FAILURE_FIX[failure.reason].kind, FAILURE_FIX[failure.reason].fix, code, { reason: failure.reason });
    return make(entry ? 'stale' : 'missing', 'translate', code);
  }
  const issue = entry.issue;
  if (issue?.severity === 'major') {
    const note = { note: issue.note };
    if (entry.status === 'edited' || CONTENT_CHECK_NOTES.includes(issue.note)) return make('flagged', 'creator', 'major_issue', note);
    // A redo of this flagged line failed (the run records it on the current source and keeps the old wording): never
    // the same paid redo again blindly. Refused → the creator's; a time-out → once more in small parts; a provider
    // error or an empty answer → once more; after that the creator's. The code stays major_issue (same readiness).
    if (failure) {
      const extra = { ...note, reason: failure.reason };
      const again = failure.attempts < FLAGGED_REDO_ATTEMPTS;
      if (failure.reason === 'unsafe') return make('refused', 'creator', 'major_issue', extra);
      if (failure.reason === 'timeout') return make('flagged', again ? 'smaller_parts' : 'creator', 'major_issue', extra);
      return make('flagged', again ? 'redo' : 'creator', 'major_issue', extra);
    }
    return make('flagged', 'redo', 'major_issue', note);
  }
  if (entry.status === 'machine') return failure ? make('review_failed', 'finish_review', 'unreviewed', { reason: failure.reason }) : make('waiting', 'finish_review', 'unreviewed');
  if (issue) return make('note', null, undefined, { note: issue.note });
  return undefined;
};

const classify = (doc: ComicDoc, lang: string): Classified[] => {
  if (isSource(doc, lang)) return [];
  const edition = i18nOf(doc).editions[lang];
  const failures = edition?.failures;
  const own = (key: string) => (failures && Object.prototype.hasOwnProperty.call(failures, key) ? failures[key] : undefined);
  const out: Classified[] = [];
  for (const field of TITLE_FIELDS) {
    const source = titleSource(doc, field);
    if (!source) continue;
    const c = judge(lang, titleRef(field), titleEntry(edition, field), textSourceHash(source), own(field), false);
    if (c) out.push(c);
  }
  for (const { line, ref } of addressedLines(doc)) {
    if (!needsTranslation(line)) continue;
    const entry = edition && Object.prototype.hasOwnProperty.call(edition.lines, line.id) ? edition.lines[line.id] : undefined;
    const c = judge(lang, ref, entry, lineSourceHash(line), own(line.id), true);
    if (c) out.push(c);
  }
  return out;
};

/**
 * Every translation problem of `lang`, titles first, then page → panel → line (pages by n, panels by n, lines in
 * panel order — the review's rows). One problem per text, the most pressing:
 *   not current (missing / stale): the author's edit → stale_edited (creator); a failure on the CURRENT source →
 *   refused (creator) / timed_out (smaller_parts) / provider_failed (translate); else missing / stale (translate);
 *   current: a MAJOR issue → flagged (redo; creator on the author's words or a content-check flag); when a redo of it
 *   failed on this source: refused (creator) after a refusal, else flagged with smaller_parts (time-out) or redo, and
 *   creator once FLAGGED_REDO_ATTEMPTS failed; machine → waiting, or review_failed with a failure (finish_review); a
 *   minor issue → note (fix null, never blocking).
 * Titles never block. A problem never carries translation text. [] for the source language.
 */
export const translationProblems = (doc: ComicDoc, lang: string): TranslationProblem[] => classify(doc, lang).map((c) => c.problem);

export interface ReadinessIssue {
  code: 'missing' | 'stale' | 'unreviewed' | 'major_issue' | 'in_art_pages' | 'overflow' | 'cover_in_art';
  count: number; blocking: boolean; text: string;
  /** STU-T0: the first 5 lines it is about, in reading order (line issues and overflow only). */
  refs?: LineRef[];
  /** STU-T0: whereText over all of them ("page 4, panel 2, line 1 and 2 more"); `text` itself never changes. */
  where?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const READINESS_REFS = 5;

const LINE_ISSUES: readonly [LineIssueCode, (n: number) => string][] = [
  ['missing', (n) => `${plural(n, 'line')} not translated yet.`],
  ['stale', (n) => `${plural(n, 'line')} changed since translating.`],
  ['unreviewed', (n) => `${plural(n, 'line')} waiting for review.`],
  ['major_issue', (n) => `${plural(n, 'line')} flagged by the review.`]
];

/** Owner rule: publishable ⇔ every translatable line is translated, not stale, status ∈ {reviewed, edited},
 *  no open MAJOR issue, and format.lettering === 'overlay' (in_art_pages is blocking: overlay lettering is
 *  required for translated editions). overflow and cover_in_art are non-blocking warnings.
 *  The line issues are counted from translationProblems (a refused, timed-out or failed line is "not translated yet";
 *  a failed review is "waiting for review"), with the same texts as always, plus `refs` and `where`. */
export const editionReadiness = (doc: ComicDoc, lang: string, overflowLineIds?: string[]): { publishable: boolean; issues: ReadinessIssue[] } => {
  if (isSource(doc, lang)) return { publishable: true, issues: [] };
  const issues: ReadinessIssue[] = [];
  const edition = i18nOf(doc).editions[lang];
  if (!edition) {
    issues.push({ code: 'missing', count: Math.max(1, editionProgress(doc, lang).total), blocking: true, text: 'This language has not been added yet.' });
    return { publishable: false, issues };
  }
  const byCode = new Map<LineIssueCode, LineRef[]>();
  for (const c of classify(doc, lang)) {
    if (!c.code) continue;
    const list = byCode.get(c.code) ?? [];
    list.push(c.problem.ref);
    byCode.set(c.code, list);
  }
  for (const [code, text] of LINE_ISSUES) {
    const refs = byCode.get(code);
    if (refs?.length) issues.push({ code, count: refs.length, blocking: true, text: text(refs.length), refs: refs.slice(0, READINESS_REFS), where: whereText(refs) });
  }
  if (doc.format.lettering === 'in_art') {
    const pages = doc.pages.filter((pg) => pg.panels.some((panel) => panel.lines.some(needsTranslation))).length;
    if (pages) issues.push({ code: 'in_art_pages', count: pages, blocking: true, text: `${plural(pages, 'page')} have lettering painted into the art; translated editions need overlay lettering.` });
  }
  const overflow = (overflowLineIds || []).length;
  if (overflow) {
    const tight = new Set(overflowLineIds);
    const refs = addressedLines(doc).filter((x) => tight.has(x.ref.lineId)).map((x) => x.ref);
    const issue: ReadinessIssue = { code: 'overflow', count: overflow, blocking: false, text: `${plural(overflow, 'balloon')} may be tight in this language.` };
    if (refs.length) Object.assign(issue, { refs: refs.slice(0, READINESS_REFS), where: whereText(refs) });
    issues.push(issue);
  }
  if (coverTitleStatus(doc, lang) === 'in_art_only') issues.push({ code: 'cover_in_art', count: 1, blocking: false, text: 'The cover title is painted in the source language.' });
  return { publishable: !issues.some((i) => i.blocking), issues };
};

// ── Localized view ───────────────────────────────────────────────────────────

const own = <T>(map: Record<string, T> | undefined, key: string): T | undefined =>
  map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const unit = (v: number) => Math.min(1, Math.max(0, v));

/**
 * An edition position for a line that has NO stored source balloon (software-placed in the source, moved in
 * this language only) as a full balloon. Needs finite x / y and w > 0, else undefined (the line keeps its
 * software placement); the tail only as a pair; pinned only when true; fontScale 0.7–1.3 like the stored path.
 */
const editionOnlyBalloon = (lineId: string, o: BalloonGeometryOverride | undefined): Balloon | undefined => {
  if (!isObj(o) || !finite(o.x) || !finite(o.y) || !finite(o.w) || o.w <= 0) return undefined;
  const b: Balloon & Pick<BalloonGeometryOverride, 'fontScale'> = { lineId, x: unit(o.x), y: unit(o.y), w: Math.min(1, o.w) };
  if (finite(o.tailX) && finite(o.tailY)) {
    b.tailX = unit(o.tailX);
    b.tailY = unit(o.tailY);
  }
  if (o.pinned === true) b.pinned = true;
  if (finite(o.fontScale)) b.fontScale = Math.min(1.3, Math.max(0.7, o.fontScale));
  return b;
};

/**
 * The doc as a reader of `lang` sees it. Pure; memoizable. Edition balloon overrides apply over the stored
 * source balloon; an override for a line with no stored balloon on its page is appended as a full balloon
 * (after the stored ones, in reading order), so the reader and the export draw what the edition editor shows.
 */
export const localizeDoc = (doc: ComicDoc, lang: string): ComicDoc => {
  const source = doc.format.language;
  if (isSource(doc, lang)) return doc;
  const edition = i18nOf(doc).editions[lang];
  if (!edition) return doc;
  const overrides = edition.balloons;
  const pages = doc.pages.map((page) => {
    const balloons = page.balloons.map((b) => {
      const o = own(overrides, b.lineId);
      return o ? { ...b, ...o } : b;
    });
    const placed = new Set(page.balloons.map((b) => b.lineId));
    for (const panel of page.panels)
      for (const line of panel.lines) {
        if (placed.has(line.id)) continue;
        const extra = editionOnlyBalloon(line.id, own(overrides, line.id));
        if (!extra) continue;
        placed.add(line.id);
        balloons.push(extra);
      }
    return {
      ...page,
      panels: page.panels.map((panel) => ({
        ...panel,
        lines: panel.lines.map((line): Line => {
          if (line.noTranslate) return { ...line, lang: line.lang ?? source };
          const t = own(edition.lines, line.id);
          if (t) return { ...line, text: t.text };
          return { ...line, lang: line.lang ?? source };
        })
      })),
      balloons
    };
  });
  const cover = { ...doc.cover };
  if (edition.cover?.title) cover.title = edition.cover.title.text;
  if (edition.cover?.tagline) cover.tagline = edition.cover.tagline.text;
  const brief = { ...doc.brief };
  if (edition.brief?.title) brief.title = edition.brief.title.text;
  if (edition.brief?.logline) brief.logline = edition.brief.logline.text;
  return {
    ...doc,
    brief,
    cover,
    pages,
    format: { ...doc.format, language: edition.lang },
    i18n: { editions: {}, glossary: [] }
  };
};

/** Lines shown in the source language because no translation exists (noTranslate lines excluded). */
export const fallbackLineIds = (localized: ComicDoc): string[] =>
  allLines(localized)
    .filter((l) => !l.noTranslate && !!l.lang && !sameLanguage(l.lang, localized.format.language))
    .map((l) => l.id);

const publicText = (t: TextTranslation): TextTranslation => ({ text: t.text, status: 'reviewed', sourceHash: '', at: 0 });

/** Public projection for the snapshot: only `langs`, entries stripped to { text, status:'reviewed', sourceHash:'', at: 0 },
 *  no gloss/issue/model, register dropped, glossary []. */
export const publicI18n = (i18n: I18nState, langs: readonly string[]): I18nState => {
  const editions: Record<string, LanguageEdition> = {};
  for (const lang of langs) {
    const e = i18n.editions[lang];
    if (!e) continue;
    const lines: Record<string, TextTranslation> = {};
    for (const [id, t] of Object.entries(e.lines)) lines[id] = publicText(t);
    const out = { lang: e.lang, lines, balloons: { ...e.balloons } } as LanguageEdition;
    if (e.cover) {
      out.cover = {};
      if (e.cover.title) out.cover.title = publicText(e.cover.title);
      if (e.cover.tagline) out.cover.tagline = publicText(e.cover.tagline);
    }
    if (e.brief) {
      out.brief = {};
      if (e.brief.title) out.brief.title = publicText(e.brief.title);
      if (e.brief.logline) out.brief.logline = publicText(e.brief.logline);
    }
    delete (out as Partial<LanguageEdition>).register;
    editions[lang] = out;
  }
  return { editions, glossary: [] };
};
