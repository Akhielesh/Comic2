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
  GlossaryTerm,
  I18nState,
  LanguageEdition,
  Line,
  TextTranslation,
  TranslationRegister,
  TranslationStatus
} from './doc.js';
import { hashString } from './hash.js';
import { languageSpec, sameLanguage } from './languages.js';

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

export interface ReadinessIssue {
  code: 'missing' | 'stale' | 'unreviewed' | 'major_issue' | 'in_art_pages' | 'overflow' | 'cover_in_art';
  count: number; blocking: boolean; text: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Owner rule: publishable ⇔ every translatable line is translated, not stale, status ∈ {reviewed, edited},
 *  no open MAJOR issue, and format.lettering === 'overlay' (in_art_pages is blocking: overlay lettering is
 *  required for translated editions). overflow and cover_in_art are non-blocking warnings. */
export const editionReadiness = (doc: ComicDoc, lang: string, overflowLineIds?: string[]): { publishable: boolean; issues: ReadinessIssue[] } => {
  if (isSource(doc, lang)) return { publishable: true, issues: [] };
  const issues: ReadinessIssue[] = [];
  const edition = i18nOf(doc).editions[lang];
  const p = editionProgress(doc, lang);
  if (!edition) {
    issues.push({ code: 'missing', count: Math.max(1, p.total), blocking: true, text: 'This language has not been added yet.' });
    return { publishable: false, issues };
  }
  if (p.missing) issues.push({ code: 'missing', count: p.missing, blocking: true, text: `${plural(p.missing, 'line')} not translated yet.` });
  const stale = p.stale + p.staleEdited;
  if (stale) issues.push({ code: 'stale', count: stale, blocking: true, text: `${plural(stale, 'line')} changed since translating.` });
  if (p.unreviewed) issues.push({ code: 'unreviewed', count: p.unreviewed, blocking: true, text: `${plural(p.unreviewed, 'line')} waiting for review.` });
  let major = 0;
  for (const line of allLines(doc)) {
    const status = translationStatus(doc, lang, line);
    if ((status === 'machine' || status === 'reviewed' || status === 'edited') && edition.lines[line.id]?.issue?.severity === 'major') major += 1;
  }
  if (major) issues.push({ code: 'major_issue', count: major, blocking: true, text: `${plural(major, 'line')} flagged by the review.` });
  if (doc.format.lettering === 'in_art') {
    const pages = doc.pages.filter((pg) => pg.panels.some((panel) => panel.lines.some(needsTranslation))).length;
    if (pages) issues.push({ code: 'in_art_pages', count: pages, blocking: true, text: `${plural(pages, 'page')} have lettering painted into the art; translated editions need overlay lettering.` });
  }
  const overflow = (overflowLineIds || []).length;
  if (overflow) issues.push({ code: 'overflow', count: overflow, blocking: false, text: `${plural(overflow, 'balloon')} may be tight in this language.` });
  if (p.coverTitle === 'in_art_only') issues.push({ code: 'cover_in_art', count: 1, blocking: false, text: 'The cover title is painted in the source language.' });
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
