// Translation seams (contract §12.8, i18n.md §8). Owner: P1-I18N.
//
// `translate` is a SPEND action: jobs.ts runFeatureAction() quotes it with estimateTranslation, runs
// gateDecision, then calls runTranslation (actions/i18n.ts). The run is software-first:
//   1. free paths (copies, punctuation, glossary-only lines, duplicates, loose matches) + glossary seed
//   2. the translator — the WRITER-CLASS chain — per chunk, languages 3 at a time, validated + repaired
//   3. the linguist review with a gloss — ALWAYS
//   4. duplicates of the fresh lines copied for free, spend recorded, an APPENDED completion message
// A rerun over unchanged text makes no model call at all (caching by sourceHash in planTranslation).

import { newId, type Card, type ComicDoc, type EditionTextField, type Msg, type NextStep } from '../../../../shared/comic/doc.js';
import { editionProgress, editionReadiness, i18nOf, textSourceHash } from '../../../../shared/comic/i18n.js';
import { LANGUAGES, languageSpec, sameLanguage } from '../../../../shared/comic/languages.js';
import { DOC_LIMITS } from '../../../../shared/comic/limits.js';
import { estimateJobs, formatUsd, PLATFORM_MARKUP, type SpendEstimate } from '../../../../shared/comic/models.js';
import type { DocOp, SpendAction } from '../../../../shared/comic/ops.js';
import { effectiveRating } from '../../../../shared/comic/safety.js';
import { DEFAULT_CAPS } from '../../../../shared/comic/capabilities.js';
import {
  chunkTranslation,
  editionTextSource,
  freeTranslationOps,
  planIsFree,
  planLineCount,
  planTranslation,
  syncGlossaryOps,
  type TranslationPlan
} from '../../../../shared/comic/translationPlan.js';
import { graphemes } from '../../../../shared/comic/textLayout.js';
import { logger } from '../../lib/logger.js';
import { billedLlm, newTextSpendTracker, recordTextSpend, spendIsByok, type RunActionOptions, type StartedAction, type TextSpendTracker } from '../jobs.js';
import { estimateTextCostUsd, resolveTextRoute, TEXT_ROLE_DEFAULTS } from '../textModels.js';
import { StudioError, type StudioContext, type StudioKeys } from '../types.js';
import { applyReview, reviewTranslations } from './linguist.js';
import type { TranslatorItem } from './prompts.js';
import { chunkOps, translateChunk } from './translate.js';

type TranslateAction = Extract<SpendAction, { type: 'translate' }>;

export { translatorSystemPrompt, linguistSystemPrompt } from './prompts.js';

// ── Languages ────────────────────────────────────────────────────────────────

const NAME_INDEX: ReadonlyMap<string, string> = new Map(
  LANGUAGES.flatMap((l) => [
    [l.code.toLowerCase(), l.code],
    [l.english.toLowerCase(), l.code],
    [l.endonym.toLowerCase(), l.code],
    [l.english.toLowerCase().replace(/\s*\(.*\)$/, ''), l.code]
  ])
);
const EXTRA_NAMES: Record<string, string> = { chinese: 'zh-Hans', mandarin: 'zh-Hans', 'simplified chinese': 'zh-Hans', farsi: '', persian: '', bangla: 'bn', hindustani: 'hi', 'bahasa': 'id', 'brazilian portuguese': 'pt' };

/** A registry code for a BCP-47 tag OR a language name in English or its own script ("Telugu", "తెలుగు"). */
export function resolveLanguage(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  if (!v || v.length > 40) return undefined;
  const byTag = languageSpec(v);
  if (byTag) return byTag.code;
  const key = v.toLowerCase();
  return NAME_INDEX.get(key) || EXTRA_NAMES[key] || undefined;
}

/** Known codes (deduped, source dropped), unknown inputs and whether the source was named. */
export function resolveLanguages(doc: ComicDoc, raw: unknown): { codes: string[]; unknown: string[]; includedSource: boolean } {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const codes: string[] = [];
  const unknown: string[] = [];
  let includedSource = false;
  for (const item of list.slice(0, 40)) {
    const code = resolveLanguage(item);
    if (!code) {
      if (typeof item === 'string' && item.trim()) unknown.push(item.trim().slice(0, 40));
      continue;
    }
    if (sameLanguage(code, doc.format.language)) {
      includedSource = true;
      continue;
    }
    if (!codes.includes(code)) codes.push(code);
  }
  return { codes: codes.slice(0, DOC_LIMITS.editions), unknown, includedSource };
}

export const languageLabel = (code: string): string => {
  const spec = languageSpec(code);
  if (!spec) return code;
  return spec.endonym === spec.english ? spec.english : `${spec.endonym} (${spec.english})`;
};
const englishName = (code: string) => languageSpec(code)?.english || code;
const joinList = (items: string[]) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** "I can translate into: Hindi, Telugu, …" — the honest refusal for unknown names. */
export const supportedLanguagesText = (doc: ComicDoc): string =>
  `I can translate into: ${LANGUAGES.filter((l) => !sameLanguage(l.code, doc.format.language)).map((l) => l.english).join(', ')}.`;

// ── Quote (§8.4) ─────────────────────────────────────────────────────────────

const UNKNOWN_PRICE = { input: 1, output: 5 };
/** In-memory output-token calibration per language (EMA of actual ÷ estimated). Logged, never persisted. */
const calibration = new Map<string, number>();
export const resetTranslationCalibration = () => calibration.clear();
const calibrated = (lang: string) => calibration.get(lang) ?? 1;
const calibrate = (lang: string, estimated: number, actual: number) => {
  if (!(estimated > 0) || !(actual > 0)) return;
  const ratio = Math.min(2, Math.max(0.5, actual / estimated));
  const next = round4(0.7 * calibrated(lang) + 0.3 * ratio);
  calibration.set(lang, next);
  logger.info('comic_translate_calibration', { lang, estimated, actual, factor: next });
};

const modelPriceUsd = (model: string, input: number, output: number): number =>
  estimateTextCostUsd(model, input, output) ?? (input * UNKNOWN_PRICE.input + output * UNKNOWN_PRICE.output) / 1_000_000;

/** Friendly model name for the gate ("Claude Sonnet 5.5 + review"). */
const MODEL_NAMES: Record<string, string> = {
  'anthropic/claude-sonnet-5.5': 'Claude Sonnet 5.5',
  'google/gemini-4-argon': 'Gemini 4 Argon',
  'gemini-4-argon': 'Gemini 4 Argon',
  'google/gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'openai/gpt-6-luna': 'GPT-6 Luna'
};
const modelName = (id: string) => MODEL_NAMES[id] || id.split('/').pop() || id;

export interface LanguageQuote {
  lang: string;
  /** Lines the translator writes (in-plan duplicates excluded). */
  lines: number;
  /** Lines done for $0 (free paths + duplicates). */
  free: number;
  upToDate: boolean;
  usd: number;
  seconds: number;
}

export interface TranslationQuote {
  estimate: SpendEstimate;
  plans: TranslationPlan[];
  perLanguage: LanguageQuote[];
  byok: boolean;
}

/** Pure quote for languages that are already resolved codes (no ctx: the quote route uses it too). */
export function quoteTranslation(doc: ComicDoc, keys: StudioKeys, action: Pick<TranslateAction, 'languages' | 'pageIds' | 'force' | 'overwriteEdits'>): TranslationQuote {
  const byok = spendIsByok(keys);
  const markup = byok ? 1 : PLATFORM_MARKUP;
  const trModel = resolveTextRoute('translator', keys)?.model ?? TEXT_ROLE_DEFAULTS.translator.models[0];
  const lnModel = resolveTextRoute('linguist', keys)?.model ?? TEXT_ROLE_DEFAULTS.linguist.models[0];
  const plans: TranslationPlan[] = [];
  const perLanguage: LanguageQuote[] = [];
  const lines: SpendEstimate['lines'] = [];
  for (const lang of action.languages) {
    const plan = planTranslation(doc, lang, { pageIds: action.pageIds, force: action.force, overwriteEdits: action.overwriteEdits });
    plans.push(plan);
    const out = plan.tokens.output * calibrated(lang);
    const raw = (plan.calls ? modelPriceUsd(trModel, plan.tokens.input, out) : 0) + (plan.reviewCalls ? modelPriceUsd(lnModel, plan.tokens.reviewInput, plan.tokens.reviewOutput) : 0);
    const usd = round4(raw * markup);
    const translated = planLineCount(plan);
    const free = plan.freeLines.length + (plan.deferred?.length || 0);
    const chunks = chunkTranslation(plan.toTranslate).length || (plan.calls ? 1 : 0);
    const seconds = Math.round(chunks * 4 + out / 70 + (plan.reviewCalls || 0) * 3 + plan.tokens.reviewOutput / 140);
    perLanguage.push({ lang, lines: translated + plan.coverTexts.length, free, upToDate: planIsFree(plan) && !plan.freeLines.length, usd, seconds });
    if (usd > 0) lines.push({ label: englishName(lang), count: translated + plan.coverTexts.length + (plan.toReview?.length || 0), usd });
  }
  const usd = round4(lines.reduce((s, l) => s + l.usd, 0));
  // Languages run 3 at a time.
  return {
    estimate: { usd, imageCount: 0, model: `${modelName(trModel)} + review`, lines },
    plans,
    perLanguage,
    byok
  };
}

/** Quote a translation (per-language plans; $0 lines are free). */
export async function estimateTranslation(ctx: StudioContext, action: TranslateAction): Promise<SpendEstimate & { plans: TranslationPlan[] }> {
  const doc = ctx.session.doc;
  const { codes } = resolveLanguages(doc, action.languages);
  if (!codes.length) throw new StudioError('BAD_REQUEST', supportedLanguagesText(doc), { status: 400 });
  const q = quoteTranslation(doc, ctx.keys, { ...action, languages: codes });
  return { ...q.estimate, plans: q.plans };
}

// ── Run ──────────────────────────────────────────────────────────────────────

const cancelled = (ctx: StudioContext) => ctx.signal?.aborted || ctx.session.abort.signal.aborted;

const activity = (ctx: StudioContext, label: string) => {
  const id = newId('act');
  ctx.session.emit({ type: 'activity', id, label, phase: 'start', cost: 'text' });
  return (ok: boolean) => ctx.session.emit({ type: 'activity', id, label, phase: 'end', ok, cost: 'text' });
};

interface LanguageResult {
  lang: string;
  translated: number;
  free: number;
  reviewed: number;
  autoFixed: number;
  failed: number;
  unsafe: number;
  tooLong: number;
  reviewSkipped: number;
  cancelled: boolean;
  error?: string;
  usd: number;
  byok: boolean;
}

/** Simple promise pool (languages run with concurrency ≤ 3). */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export const TRANSLATE_CONCURRENCY = 3;

const ratingOf = (ctx: StudioContext) => ctx.rating ?? effectiveRating(ctx.session.doc, (ctx.caps ?? DEFAULT_CAPS).ratingCeiling).rating;

/** Cover/brief texts for the translator (one item per distinct source text). */
const extrasFor = (doc: ComicDoc, fields: EditionTextField[]): TranslatorItem[] => {
  const seen = new Set<string>();
  const out: TranslatorItem[] = [];
  for (const field of fields) {
    const text = editionTextSource(doc, field);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    const kind = field.endsWith('title') ? 'title' : field.endsWith('tagline') ? 'tagline' : 'logline';
    out.push({ id: field, kind, text, maxChars: Math.max(12, Math.ceil(graphemes(text).length * (kind === 'logline' ? 1.6 : 1.4))) });
  }
  return out;
};

async function runLanguage(ctx: StudioContext, lang: string, action: TranslateAction, onPage: (label: string) => (ok: boolean) => void): Promise<LanguageResult> {
  const spec = languageSpec(lang)!;
  const tracker: TextSpendTracker = newTextSpendTracker();
  const res: LanguageResult = { lang, translated: 0, free: 0, reviewed: 0, autoFixed: 0, failed: 0, unsafe: 0, tooLong: 0, reviewSkipped: 0, cancelled: false, usd: 0, byok: false };
  const llmT = billedLlm(ctx, { stage: 'translate', operation: 'comic.text.translator', tracker });
  const llmL = billedLlm(ctx, { stage: 'translate', operation: 'comic.text.linguist', tracker });
  const rating = ratingOf(ctx);
  const opts = { pageIds: action.pageIds, force: action.force, overwriteEdits: action.overwriteEdits };
  const plan = planTranslation(ctx.session.doc, lang, opts);
  const chunks = chunkTranslation(plan.toTranslate);
  const extras = extrasFor(ctx.session.doc, plan.coverTexts);
  if (!chunks.length && extras.length) chunks.push([]);
  const translatedIds: string[] = [];
  let estimatedOut = 0;
  let actualOut = 0;
  try {
    for (const [i, chunk] of chunks.entries()) {
      if (cancelled(ctx)) {
        res.cancelled = true;
        break;
      }
      const doc = ctx.session.doc;
      const pages = chunk
        .map((g) => ({ page: doc.pages.find((p) => p.id === g.pageId), lineIds: new Set(g.lineIds) }))
        .filter((g): g is { page: NonNullable<typeof g.page>; lineIds: Set<string> } => !!g.page);
      const first = pages[0]?.page.n;
      const end = onPage(first ? `Translating page ${first} into ${spec.endonym}…` : `Translating the title into ${spec.endonym}…`);
      try {
        const result = await translateChunk(llmT, { doc, lang, pages, extras: i === 0 ? extras : [], rating, signal: ctx.session.abort.signal });
        const ops = chunkOps(ctx.session.doc, lang, result, Date.now(), result.model);
        if (ops.length) ctx.session.commit(ops, { origin: 'job' });
        translatedIds.push(...Object.keys(result.lines), ...Object.keys(result.extras));
        res.translated += Object.keys(result.lines).length;
        res.failed += result.failed.length;
        res.unsafe += result.unsafe.length;
        res.tooLong += Object.values(result.lines).filter((l) => l.tooLong).length;
        estimatedOut += plan.tokens.output / Math.max(1, chunks.length);
        actualOut += result.completionTokens;
        end(true);
      } catch (err) {
        end(false);
        const code = err instanceof StudioError ? err.code : undefined;
        if (code === 'CANCELLED') {
          res.cancelled = true;
          break;
        }
        res.error = err instanceof StudioError ? err.userMessage : 'The translator did not answer.';
        logger.warn('comic_translate_chunk_failed', { projectId: ctx.projectId, lang, code: code || 'INTERNAL', message: (err as Error)?.message });
        res.failed += chunk.reduce((n, g) => n + g.lineIds.length, 0);
        if (code === 'BILLING_DENIED' || code === 'NO_TEXT_KEY') break;
      }
    }

    // The linguist review — always (the lines just written + any current line still waiting for review).
    const reviewIds = [...new Set([...translatedIds, ...(plan.toReview || [])])];
    if (reviewIds.length && !res.cancelled) {
      const end = onPage(`Reviewing the ${spec.english} translation…`);
      const run = await reviewTranslations(llmL, ctx.session.doc, lang, reviewIds, ctx.session.abort.signal);
      const outcome = applyReview(ctx.session.doc, lang, run.verdicts, rating, Date.now());
      if (outcome.ops.length) ctx.session.commit(outcome.ops, { origin: 'job' });
      res.reviewed += outcome.reviewed;
      res.autoFixed += outcome.autoFixed;
      res.reviewSkipped += Math.max(0, reviewIds.length - run.verdicts.size);
      if (run.error?.code === 'CANCELLED') res.cancelled = true;
      else if (run.error && !res.error) res.error = run.error.userMessage;
      end(!run.error);
    }
  } finally {
    // Duplicates of the fresh lines (and any other free work) — $0, after the review so copies inherit it.
    const again = planTranslation(ctx.session.doc, lang, opts);
    const free = freeTranslationOps(ctx.session.doc, again);
    if (free.length) {
      ctx.session.commit(free, { origin: 'job' });
      res.free += again.freeLines.length;
    }
    recordTextSpend(ctx, tracker, 'translate', `Translate · ${spec.english}`);
    res.usd = tracker.usd;
    res.byok = tracker.byok;
    calibrate(lang, estimatedOut, actualOut);
  }
  return res;
}

/** In-art lettering: translated editions need overlay lettering (owner rule) — the quoted fix. */
export function overlayFix(doc: ComicDoc, byok: boolean): { pages: string[]; usd: number } | null {
  if (doc.format.lettering !== 'in_art') return null;
  const pages = doc.pages.filter((p) => p.panels.some((panel) => panel.lines.some((l) => l.text.trim() && !l.noTranslate)) && (p.render.asset || p.render.history.length));
  const usd = pages.length ? estimateJobs([{ kind: 'page', count: pages.length }], doc.settings.quality, { override: doc.settings.imageModelOverride, byok }).usd : 0;
  return { pages: pages.map((p) => p.id), usd };
}

/** Painted cover title: the one-time textless cover + editable overlay title (decisions-final #2). */
export function textlessCoverQuote(doc: ComicDoc, byok: boolean): number | null {
  const painted = (doc.cover.lettering ?? 'in_art') === 'in_art' && !!doc.cover.render.asset;
  if (!painted) return null;
  return estimateJobs([{ kind: 'cover', count: 1 }], doc.settings.quality, { override: doc.settings.imageModelOverride, byok }).usd;
}

/** The appended completion message (honest per-language summary + the next steps). */
export function completionMessage(doc: ComicDoc, results: LanguageResult[], keys: StudioKeys): { text: string; nextSteps: NextStep[] } {
  const byok = spendIsByok(keys);
  const parts: string[] = [];
  const ready: string[] = [];
  const steps: NextStep[] = [];
  let missingLangs: string[] = [];
  for (const r of results) {
    const p = editionProgress(doc, r.lang);
    const label = languageLabel(r.lang);
    const bits: string[] = [];
    bits.push(`${p.done} of ${plural(p.total, 'line')} done`);
    if (r.free) bits.push(`${r.free} by software for free`);
    if (r.autoFixed) bits.push(`${plural(r.autoFixed, 'line')} corrected by the review`);
    const majors = Object.values(i18nOf(doc).editions[r.lang]?.lines || {}).filter((t) => t.issue?.severity === 'major').length;
    if (majors) bits.push(`${plural(majors, 'line')} flagged for a look`);
    if (p.unreviewed) bits.push(`${p.unreviewed} still waiting for review`);
    if (p.missing) bits.push(`${p.missing} still missing`);
    if (r.unsafe) bits.push(`${plural(r.unsafe, 'line')} didn't pass the content check and stayed untranslated`);
    if (r.tooLong) bits.push(`${plural(r.tooLong, 'balloon')} may be tight`);
    parts.push(`${label}: ${bits.join(', ')}.`);
    if (p.missing || p.stale) missingLangs.push(r.lang);
    if (editionReadiness(doc, r.lang).publishable) ready.push(languageSpec(r.lang)?.endonym || r.lang);
  }
  const anyCancelled = results.some((r) => r.cancelled);
  const errors = [...new Set(results.map((r) => r.error).filter((e): e is string => !!e))];
  const usd = round4(results.reduce((s, r) => s + r.usd, 0));
  let head: string;
  if (anyCancelled) head = 'Stopped — the finished pages are kept.';
  else if (ready.length === results.length) head = `${joinList(results.map((r) => englishName(r.lang)))} ${results.length === 1 ? 'is' : 'are'} translated and reviewed.`;
  else head = `Translation finished for ${joinList(results.map((r) => englishName(r.lang)))}.`;
  const cost = usd > 0 ? ` Cost ${formatUsd(usd)}${byok ? ' on your key' : ''}.` : ' Cost $0 — done by the editor, no AI cost.';
  const lines = [head, ...parts];
  if (errors.length) lines.push(`${errors[0]}${/[.!?]$/.test(errors[0]) ? '' : '.'} Translate again to retry — only the missing lines are charged.`);
  const fix = overlayFix(doc, byok);
  if (fix && fix.pages.length) {
    lines.push(`Your pages have the lettering painted into the art, so readers would still see the original words. Translated editions need overlay lettering: redrawing ${plural(fix.pages.length, 'page')} without text costs ≈ ${formatUsd(fix.usd)}, and after that every language is free.`);
    steps.push({ label: 'Set up lettering for translations', client: { type: 'open_tab', tab: 'languages' } });
  } else if (ready.length) {
    lines.push(`Ready to publish in ${joinList(ready)} — readers pick their language in the reader.`);
  }
  const cover = textlessCoverQuote(doc, byok);
  if (cover !== null && results.length) {
    lines.push(`The cover title is painted in ${englishName(doc.format.language)}. A textless cover with an editable title is a one-time ≈ ${formatUsd(cover)}; every language's title is free after that.`);
    steps.push({ label: 'Textless cover', action: { type: 'render_cover', textless: true, quotedUsd: cover }, usd: cover });
  }
  steps.unshift({ label: 'Review translations', client: { type: 'open_tab', tab: 'languages' } });
  if (ready.length && !fix?.pages.length) steps.push({ label: 'Publish', client: { type: 'open_share' } });
  missingLangs = missingLangs.filter((l) => !results.find((r) => r.lang === l)?.unsafe);
  if (missingLangs.length && !anyCancelled) {
    const again = quoteTranslation(doc, keys, { languages: missingLangs }).estimate.usd;
    steps.push({ label: 'Translate missing lines', action: { type: 'translate', languages: missingLangs, quotedUsd: again }, usd: again });
  }
  return { text: `${lines.join(' ')}${cost}`.trim(), nextSteps: steps.slice(0, DOC_LIMITS.nextSteps) };
}

const translationCard = (languages: string[]): Card => ({ type: 'translation', id: newId('card'), languages });

const message = (text: string, cards?: Card[], nextSteps?: NextStep[]): Msg => ({
  id: newId('msg'),
  role: 'assistant',
  text,
  at: Date.now(),
  ...(cards?.length ? { cards } : {}),
  ...(nextSteps?.length ? { nextSteps, suggestions: nextSteps.map((s) => s.label) } : {})
});

/** Tell the user (director turn: a card in its message; UI tap: a new assistant message). */
const tell = (ctx: StudioContext, opts: RunActionOptions, text: string, tone: 'info' | 'warn' | 'success' = 'info', steps?: NextStep[]) => {
  if (opts.collectCard) {
    opts.collectCard({ type: 'notice', id: newId('card'), tone, text });
    if (steps?.length) opts.collectNextSteps?.(steps);
    return;
  }
  ctx.session.commit([{ op: 'message', msg: message(text, [{ type: 'notice', id: newId('card'), tone, text }], steps) }], { origin: 'job' });
};

const finished = (outcome: StartedAction['outcome']): StartedAction => ({ outcome, done: Promise.resolve() });

/** Run an approved translation (background; `done` settles when every edition finished). */
export async function runTranslation(ctx: StudioContext, action: TranslateAction, opts: RunActionOptions): Promise<StartedAction> {
  const doc = ctx.session.doc;
  const { codes, unknown } = resolveLanguages(doc, action.languages);
  if (!codes.length) {
    const text = unknown.length ? `I don't know ${joinList(unknown)} as a language. ${supportedLanguagesText(doc)}` : `${englishName(doc.format.language)} is already the comic's language. ${supportedLanguagesText(doc)}`;
    tell(ctx, opts, text, 'warn');
    return finished({ status: 'blocked', message: text, code: 'BAD_REQUEST' });
  }
  const existing = Object.keys(i18nOf(doc).editions);
  const added = codes.filter((c) => !existing.includes(c));
  if (existing.length + added.length > DOC_LIMITS.editions) {
    const text = `A comic can have up to ${DOC_LIMITS.editions} translations; remove one in Languages first.`;
    tell(ctx, opts, text, 'warn');
    return finished({ status: 'blocked', message: text, code: 'LIMIT' });
  }
  const quote = quoteTranslation(doc, ctx.keys, { ...action, languages: codes });
  const paid = quote.plans.some((p) => !planIsFree(p));
  if (paid && !resolveTextRoute('translator', ctx.keys)) {
    const text = 'Translation needs an AI key: connect a Gemini or OpenRouter key in Settings → API keys.';
    tell(ctx, opts, text, 'warn');
    return finished({ status: 'blocked', message: text, code: 'NO_TEXT_KEY' });
  }

  // 1 · free work first: glossary seed + editions + every $0 line.
  const seed: DocOp[] = [...syncGlossaryOps(doc)];
  for (const lang of codes) if (!i18nOf(doc).editions[lang]) seed.push({ op: 'edition', lang, patch: {} });
  if (seed.length) ctx.session.commit(seed, { origin: 'job' });
  let freeCount = 0;
  for (const lang of codes) {
    const plan = planTranslation(ctx.session.doc, lang, { pageIds: action.pageIds, force: action.force, overwriteEdits: action.overwriteEdits });
    const ops = freeTranslationOps(ctx.session.doc, plan);
    if (ops.length) {
      ctx.session.commit(ops, { origin: 'job' });
      freeCount += plan.freeLines.length;
    }
  }
  const names = joinList(codes.map(englishName));

  if (!paid) {
    const upToDate = freeCount === 0;
    const text = upToDate
      ? `${names} ${codes.length === 1 ? 'is' : 'are'} already up to date. Nothing to translate ($0).`
      : `Done for free: ${plural(freeCount, 'line')} copied by software into ${names} ($0 — no AI needed).`;
    const steps: NextStep[] = [{ label: 'Review translations', client: { type: 'open_tab', tab: 'languages' } }];
    if (!opts.collectCard) ctx.session.commit([{ op: 'message', msg: message(text, [translationCard(codes)], steps) }], { origin: 'job' });
    else {
      opts.collectCard(translationCard(codes));
      opts.collectNextSteps?.(steps);
    }
    return finished({ status: 'done', message: text, nextSteps: steps });
  }

  const lines = quote.perLanguage.reduce((n, l) => n + l.lines, 0);
  // Duplicates of lines being translated now are copied for free once their twin is done.
  freeCount += quote.plans.reduce((n, p) => n + (p.deferred?.length || 0), 0);
  const skipped = unknown.length ? ` (I don't know ${joinList(unknown)} as a language, so I left it out.)` : '';
  const startText = `Translating ${plural(lines, 'line')} into ${names} (≈ ${formatUsd(quote.estimate.usd)}${quote.byok ? ' on your key' : ''})${freeCount ? `; ${plural(freeCount, 'line')} reused for free` : ''}. Every line gets a linguist review.${skipped}`;
  const card = translationCard(codes);
  let startMsgId: string | undefined;
  if (opts.collectCard) opts.collectCard(card);
  else {
    const msg = message(startText, [card]);
    startMsgId = msg.id;
    ctx.session.commit([{ op: 'message', msg }], { origin: 'job' });
  }

  const work = (async () => {
    let results: LanguageResult[] = [];
    try {
      results = await pool(codes, TRANSLATE_CONCURRENCY, (lang) =>
        runLanguage(ctx, lang, { ...action, languages: [lang] }, (label) => activity(ctx, label))
      );
    } catch (err) {
      logger.error('comic_translate_failed', { projectId: ctx.projectId, message: (err as Error)?.message });
    }
    const done = ctx.session.doc;
    const { text, nextSteps } = results.length
      ? completionMessage(done, results, ctx.keys)
      : { text: "The translation couldn't run. Nothing was charged for unfinished lines — try again in a moment.", nextSteps: [] as NextStep[] };
    const last = done.conversation[done.conversation.length - 1];
    if (startMsgId && last?.id === startMsgId) {
      // A UI-started run rewrites its own progress message while it is still the last one.
      ctx.session.commit([{ op: 'message_patch', id: startMsgId, patch: { text, at: Date.now(), nextSteps, suggestions: nextSteps.map((s) => s.label) } }], { origin: 'job' });
    } else {
      ctx.session.commit([{ op: 'message', msg: message(text, startMsgId ? [translationCard(codes)] : undefined, nextSteps) }], { origin: 'job' });
    }
    const usd = round4(results.reduce((s, r) => s + r.usd, 0));
    logger.info('comic_translate_done', { projectId: ctx.projectId, langs: codes, usd, translated: results.reduce((n, r) => n + r.translated, 0), free: freeCount + results.reduce((n, r) => n + r.free, 0) });
  })();
  const done = ctx.track(work).then(
    () => undefined,
    () => undefined
  );
  return { outcome: { status: 'started', message: `${startText} The result arrives as a new message.`, estimate: quote.estimate }, done };
}

/** Source text hash of a cover/brief field (re-exported for the sanitizer). */
export const editionFieldHash = (doc: ComicDoc, field: EditionTextField): string => textSourceHash(editionTextSource(doc, field));
