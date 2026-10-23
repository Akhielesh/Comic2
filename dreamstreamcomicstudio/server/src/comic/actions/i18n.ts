// Feature actions "i18n" (contract §12.1). Owner: P1-I18N.
//
//   translate                 SPEND — estimate (estimateTranslation) → jobs.ts gateDecision → runTranslation
//   swap_source_language      free — a COMPLETE edition becomes the source; the old source becomes a
//                             reviewed edition; every other edition stays current (no re-translation)
//   accept_translation_issue  free — "Use suggestion" or "Looks right" on a reviewed line
//
// Handlers commit with the caller's ops origin and never post chat noise for inline review taps.

import { newId, type ComicDoc, type EditionTextField, type Line, type Msg, type NextStep, type TextTranslation } from '../../../../shared/comic/doc.js';
import { editionProgress, i18nOf, lineSourceHash, normalizeSource, textSourceHash } from '../../../../shared/comic/i18n.js';
import { languageSpec, sameLanguage } from '../../../../shared/comic/languages.js';
import type { DocOp, StudioAction } from '../../../../shared/comic/ops.js';
import { effectiveRating } from '../../../../shared/comic/safety.js';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities.js';
import { formatUsd } from '../../../../shared/comic/models.js';
import { editionTextEntry, editionTextSource, linesInOrder } from '../../../../shared/comic/translationPlan.js';
import type { ActionHandler } from '../extensions.js';
import { estimateTranslation, languageLabel, quoteTranslation, runTranslation } from '../i18n/index.js';
import { costViewFor, governCard, governDollars } from '../costText.js';
import { prefilterText } from '../safety/index.js';
import type { RunActionOptions, StartedAction } from '../jobs.js';
import type { StudioContext } from '../types.js';

type Swap = Extract<StudioAction, { type: 'swap_source_language' }>;
type Accept = Extract<StudioAction, { type: 'accept_translation_issue' }>;

const EDITION_FIELDS: readonly EditionTextField[] = ['brief.title', 'brief.logline', 'cover.title', 'cover.tagline'];
const isField = (v: string): v is EditionTextField => (EDITION_FIELDS as readonly string[]).includes(v);
const finished = (outcome: StartedAction['outcome']): StartedAction => ({ outcome, done: Promise.resolve() });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Prices worded for this user (costText.ts): dollars for admins and own keys, "≈2% of your usage" for
 * everyone on the included usage. Used for every committed text AND the outcome the director reads.
 */
const priced = (ctx: StudioContext, opts: RunActionOptions, text: string): string => governDollars(text, costViewFor(opts.caps ?? ctx.caps));

/** Deliver a short result: a notice in the director's message, or a new assistant message for a UI tap. */
const say = (ctx: StudioContext, opts: RunActionOptions, words: string, tone: 'info' | 'warn' | 'success', steps?: NextStep[]) => {
  const view = costViewFor(opts.caps ?? ctx.caps);
  const text = governDollars(words, view);
  const card = governCard({ type: 'notice', id: newId('card'), tone, text }, view);
  if (opts.collectCard) {
    opts.collectCard(card);
    if (steps?.length) opts.collectNextSteps?.(steps);
    return;
  }
  const msg: Msg = { id: newId('msg'), role: 'assistant', text, at: Date.now(), cards: [card], ...(steps?.length ? { nextSteps: steps, suggestions: steps.map((s) => s.label) } : {}) };
  ctx.session.commit([{ op: 'message', msg }], { origin: opts.origin ?? 'job' });
};

const refuse = (ctx: StudioContext, opts: RunActionOptions, words: string, code: 'BAD_REQUEST' | 'NOT_READY' | 'NOT_FOUND' | 'CONFLICT', steps?: NextStep[]): StartedAction => {
  const text = priced(ctx, opts, words);
  say(ctx, opts, text, 'warn', steps);
  return finished({ status: 'blocked', message: text, code });
};

// ── swap_source_language ─────────────────────────────────────────────────────

/** The ops that make a complete edition the source (pure; caller checks completeness). */
export function swapSourceOps(doc: ComicDoc, lang: string, now = Date.now()): DocOp[] {
  const i18n = i18nOf(doc);
  const edition = i18n.editions[lang];
  const oldSource = doc.format.language;
  if (!edition || sameLanguage(lang, oldSource)) return [];
  const ops: DocOp[] = [];
  const lines = linesInOrder(doc).map(({ page, line }) => ({ page, line }));
  const newText = (line: Line): string => (line.noTranslate || !normalizeSource(line.text) ? line.text : edition.lines[line.id]?.text ?? line.text);

  // Other editions stay current: their entries that matched the old source are re-hashed to the new one.
  const others = Object.keys(i18n.editions).filter((k) => k !== lang);
  const refreshed: Record<string, Record<string, TextTranslation>> = {};
  for (const other of others) {
    const e = i18n.editions[other];
    const out: Record<string, TextTranslation> = {};
    for (const { line } of lines) {
      const t = e.lines[line.id];
      if (!t || t.sourceHash !== lineSourceHash(line)) continue;
      out[line.id] = { ...t, sourceHash: lineSourceHash({ ...line, text: newText(line) }) };
    }
    refreshed[other] = out;
  }

  ops.push({ op: 'edition', lang, patch: null });
  ops.push({ op: 'format', patch: { language: lang } });
  for (const { page, line } of lines) {
    const text = newText(line);
    if (text === line.text) continue;
    const panel = page.panels.find((p) => p.lines.some((l) => l.id === line.id))!;
    ops.push({ op: 'line', pageId: page.id, panelId: panel.id, id: line.id, patch: { text } });
  }
  // Brief + cover texts.
  const briefPatch: Record<string, string> = {};
  const coverPatch: Record<string, string> = {};
  for (const field of EDITION_FIELDS) {
    const t = editionTextEntry(doc, lang, field);
    if (!t?.text) continue;
    const [group, key] = field.split('.');
    (group === 'brief' ? briefPatch : coverPatch)[key] = t.text;
  }
  if (Object.keys(briefPatch).length) ops.push({ op: 'brief', patch: briefPatch });
  if (Object.keys(coverPatch).length) ops.push({ op: 'cover', patch: coverPatch });

  // The old source becomes a reviewed edition.
  ops.push({ op: 'edition', lang: oldSource, patch: { register: edition.register } });
  const back: Record<string, TextTranslation> = {};
  for (const { line } of lines) {
    if (!normalizeSource(line.text) || line.noTranslate) continue;
    back[line.id] = { text: line.text, status: 'reviewed', sourceHash: lineSourceHash({ ...line, text: newText(line) }), at: now };
  }
  if (Object.keys(back).length) ops.push({ op: 'translations', lang: oldSource, lines: back });
  for (const field of EDITION_FIELDS) {
    const old = editionTextSource(doc, field);
    const t = editionTextEntry(doc, lang, field);
    if (!old || !t?.text) continue;
    ops.push({ op: 'edition_text', lang: oldSource, field, value: { text: old, status: 'reviewed', sourceHash: textSourceHash(t.text), at: now } });
  }
  for (const [other, out] of Object.entries(refreshed)) if (Object.keys(out).length) ops.push({ op: 'translations', lang: other, lines: out });

  // Glossary: the new source form becomes the term; the old term becomes the old source's form.
  for (const term of i18n.glossary) {
    const form = term.forms[lang];
    if (!form || term.policy === 'keep') continue;
    ops.push({ op: 'glossary_term', id: term.id, patch: { term: form, forms: { [oldSource]: term.term, [lang]: null as unknown as string } } });
  }
  return ops;
}

async function swapSource(ctx: StudioContext, action: Swap, opts: RunActionOptions): Promise<StartedAction> {
  const doc = ctx.session.doc;
  const spec = languageSpec(typeof action.lang === 'string' ? action.lang : '');
  if (!spec) return refuse(ctx, opts, "I don't know that language.", 'BAD_REQUEST');
  const lang = spec.code;
  if (sameLanguage(lang, doc.format.language)) return finished({ status: 'done', message: `${languageLabel(lang)} is already the comic's language.` });
  if (!i18nOf(doc).editions[lang]) {
    const usd = quoteTranslation(doc, ctx.keys, { languages: [lang] }).estimate.usd;
    return refuse(ctx, opts, `There is no ${spec.english} translation yet. Translate it first (≈ ${formatUsd(usd)}), then it can become the source.`, 'NOT_READY', [
      { label: `Translate into ${spec.english}`, action: { type: 'translate', languages: [lang], quotedUsd: usd }, usd }
    ]);
  }
  const p = editionProgress(doc, lang);
  if (p.missing || p.stale || p.staleEdited) {
    const usd = quoteTranslation(doc, ctx.keys, { languages: [lang] }).estimate.usd;
    const gaps = [p.missing ? `${plural(p.missing, 'line')} missing` : '', p.stale + p.staleEdited ? `${plural(p.stale + p.staleEdited, 'line')} out of date` : ''].filter(Boolean).join(' and ');
    return refuse(ctx, opts, `The ${spec.english} translation has ${gaps}, so it can't become the source yet. Finish it first (≈ ${formatUsd(usd)}).`, 'NOT_READY', [
      { label: 'Translate missing lines', action: { type: 'translate', languages: [lang], quotedUsd: usd }, usd }
    ]);
  }
  const oldSource = doc.format.language;
  const ops = swapSourceOps(doc, lang);
  ctx.session.commit(ops, { origin: opts.origin ?? 'user', label: `Make ${spec.english} the source` });
  const inArt = doc.format.lettering === 'in_art' && doc.pages.some((pg) => pg.render.asset);
  const text = priced(
    ctx,
    opts,
    `${languageLabel(lang)} is now the comic's language; ${languageLabel(oldSource)} became a reviewed translation. Every other translation stays current ($0).${inArt ? ' The pages have the old lettering painted into the art, so they are now marked out of date.' : ''}`
  );
  say(ctx, opts, text, 'success');
  return finished({ status: 'done', message: text });
}

// ── accept_translation_issue ─────────────────────────────────────────────────

async function acceptIssue(ctx: StudioContext, action: Accept, opts: RunActionOptions): Promise<StartedAction> {
  const doc = ctx.session.doc;
  const spec = languageSpec(typeof action.lang === 'string' ? action.lang : '');
  const edition = spec ? i18nOf(doc).editions[spec.code] : undefined;
  if (!spec || !edition) return finished({ status: 'blocked', message: 'That translation no longer exists.', code: 'NOT_FOUND' });
  const lang = spec.code;
  const id = typeof action.lineId === 'string' ? action.lineId : '';
  const rating = ctx.rating ?? effectiveRating(doc, (ctx.caps ?? DEFAULT_CAPS).ratingCeiling).rating;
  const now = Date.now();

  let cur: TextTranslation | undefined;
  let current = false;
  if (isField(id)) {
    cur = editionTextEntry(doc, lang, id);
    current = !!cur && cur.sourceHash === textSourceHash(editionTextSource(doc, id));
  } else {
    const line = linesInOrder(doc).find(({ line: l }) => l.id === id)?.line;
    cur = line ? edition.lines[id] : undefined;
    current = !!cur && !!line && cur.sourceHash === lineSourceHash(line);
  }
  if (!cur) return finished({ status: 'blocked', message: 'That line has no translation to review.', code: 'NOT_FOUND' });
  if (!current) return finished({ status: 'blocked', message: 'That line changed since it was translated — translate it again first.', code: 'CONFLICT' });

  const next: TextTranslation = { ...cur, status: 'reviewed', at: now };
  delete next.issue;
  if (action.useSuggestion) {
    const suggestion = cur.issue?.suggestion;
    if (!suggestion) return finished({ status: 'blocked', message: 'There is no suggestion for that line.', code: 'NOT_FOUND' });
    if (prefilterText(suggestion, rating).decision === 'block') return finished({ status: 'blocked', message: "That suggestion doesn't fit the comic's content rules.", code: 'BAD_REQUEST' });
    next.text = suggestion;
    // The gloss described the previous wording.
    delete next.gloss;
  }
  const op: DocOp = isField(id) ? { op: 'edition_text', lang, field: id, value: next } : { op: 'translations', lang, lines: { [id]: next } };
  ctx.session.commit([op], { origin: opts.origin ?? 'user', label: action.useSuggestion ? 'Use suggestion' : 'Mark reviewed' });
  const message = action.useSuggestion ? 'Used the suggestion.' : 'Marked as reviewed.';
  if (opts.collectCard) opts.collectCard({ type: 'notice', id: newId('card'), tone: 'success', text: message });
  return finished({ status: 'done', message });
}

export const I18N_ACTIONS: ActionHandler[] = [
  {
    type: 'translate',
    spend: true,
    estimate: (ctx, action) => estimateTranslation(ctx, action as Extract<StudioAction, { type: 'translate' }>),
    run: (ctx, action, opts) => runTranslation(ctx, action as Extract<StudioAction, { type: 'translate' }>, opts)
  },
  { type: 'swap_source_language', spend: false, run: (ctx, action, opts) => swapSource(ctx, action as Swap, opts) },
  { type: 'accept_translation_issue', spend: false, run: (ctx, action, opts) => acceptIssue(ctx, action as Accept, opts) }
];
