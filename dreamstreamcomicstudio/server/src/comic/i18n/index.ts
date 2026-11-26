// Translation seams (contract §12.8, i18n.md §8). Owner: P1-I18N.
//
// `translate` is a SPEND action: jobs.ts runFeatureAction() quotes it with estimateTranslation, runs
// gateDecision, then calls runTranslation (actions/i18n.ts). The run is software-first:
//   1. free paths (copies, punctuation, glossary-only lines, duplicates, loose matches) + glossary seed
//   2. the translator — the WRITER-CLASS chain — per chunk, languages up to TRANSLATE_CONCURRENCY (6) at a
//      time, validated + repaired; the text client already gives every call one more try (a rate limit after
//      3 s, a provider 5xx after 1.5 s), and a chunk the provider still rate-limits after that is asked once
//      more here, 8 to 15 s later; a "no" from the spending allowance stops every language
//   3. the linguist review with a gloss — ALWAYS
//   4. duplicates of the fresh lines copied for free, spend recorded, an APPENDED completion message
// A rerun over unchanged text makes no model call at all (caching by sourceHash in planTranslation).
//
// Prices in every text this run commits or returns are worded for the user (costText.ts): dollars for
// admins and own keys, "≈2% of your usage" for everyone on the included usage (P2-GATE L1). jobs.ts
// governMsg is not on this path, so runTranslation words them itself and runs the governDollars net.

import { newId, type Card, type ComicDoc, type EditionTextField, type Msg, type NextStep } from '../../../../shared/comic/doc.js';
import { editionProgress, editionReadiness, i18nOf, textSourceHash } from '../../../../shared/comic/i18n.js';
import { LANGUAGES, languageSpec, sameLanguage } from '../../../../shared/comic/languages.js';
import { DOC_LIMITS } from '../../../../shared/comic/limits.js';
import { formatUsd, PLATFORM_MARKUP, type SpendEstimate } from '../../../../shared/comic/models.js';
import { estimateDocJobs } from '../../../../shared/comic/plan.js';
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
import { billedLlm, newTextSpendTracker, priceBookFor, priceBookWithin, recordTextSpend, spendIsByok, textRatesWithin, type RunActionOptions, type StartedAction, type TextSpendTracker } from '../jobs.js';
import { textRatesOf, type TextRates } from '../../../../shared/comic/priceBook.js';
import type { PriceBook } from '../../../../shared/comic/modelLock.js';
import { textOpTag } from '../models/textRates.js';
import { costFormatter, costViewFor, DOLLAR_VIEW, governCard, governDollars, type CostView } from '../costText.js';
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
/**
 * In-memory price calibration per language: an EMA of what a finished run was BILLED ÷ what its plan priced
 * (translator + review). The plan already carries an expected repair round per chunk (REPAIR_SHARE, §8.6);
 * the real repair rate and every token-count drift show up here and correct the next quote. Logged, never
 * persisted — so a cold process quotes with the allowance alone.
 */
const calibration = new Map<string, number>();
export const resetTranslationCalibration = () => calibration.clear();
const calibrated = (lang: string) => calibration.get(lang) ?? 1;
/**
 * The factor a language's token estimate is quoted at: the higher of what translations have really cost against
 * their estimate (the book's text rates, from the usage ledger: models/textRates.ts), this process's calibration of
 * the language, and 1 — the token estimate is the floor (an observation only ever raises a quote).
 */
const quoteFactor = (lang: string, text?: Pick<TextRates, 'translateFactor'>) => Math.max(1, calibrated(lang), textRatesOf(text ? { text: text as TextRates } : null).translateFactor);
/**
 * The translate text rate for a request: read from the text rates' own in-memory source (jobs.ts textRatesWithin, the
 * call the translation quote route makes), never behind the image catalog's price wait — so the Approve card names the
 * rate the Translate button showed.
 */
export const translateRatesFor = (ctx: StudioContext): Promise<TextRates> => textRatesWithin(ctx);
const calibrate = (lang: string, estimated: number, actual: number) => {
  if (!(estimated > 0) || !(actual > 0)) return;
  const ratio = Math.min(2, Math.max(0.5, actual / estimated));
  const next = round4(0.7 * calibrated(lang) + 0.3 * ratio);
  calibration.set(lang, next);
  logger.info('comic_translate_calibration', { lang, estimatedUsd: estimated, billedUsd: actual, factor: next });
};

const modelPriceUsd = (model: string, input: number, output: number): number =>
  estimateTextCostUsd(model, input, output) ?? (input * UNKNOWN_PRICE.input + output * UNKNOWN_PRICE.output) / 1_000_000;

/** Whether a text role runs on the user's own key: the key of its own route (text routes are OpenRouter-first). */
const textRoleIsByok = (role: 'translator' | 'linguist', keys: StudioKeys): boolean => resolveTextRoute(role, keys)?.key.byok ?? spendIsByok(keys);

/**
 * The uncalibrated price of one language plan (translator + review) in the user's terms: markup unless that role runs
 * on the user's key. `provider`: the provider cost alone (no markup), the base the ledger compares a bill with.
 */
const planUsd = (plan: TranslationPlan, keys: StudioKeys, provider = false): number => {
  const markup = (role: 'translator' | 'linguist') => (provider || textRoleIsByok(role, keys) ? 1 : PLATFORM_MARKUP);
  const trModel = resolveTextRoute('translator', keys)?.model ?? TEXT_ROLE_DEFAULTS.translator.models[0];
  const lnModel = resolveTextRoute('linguist', keys)?.model ?? TEXT_ROLE_DEFAULTS.linguist.models[0];
  return (
    (plan.calls ? modelPriceUsd(trModel, plan.tokens.input, plan.tokens.output) * markup('translator') : 0) +
    (plan.reviewCalls ? modelPriceUsd(lnModel, plan.tokens.reviewInput, plan.tokens.reviewOutput) * markup('linguist') : 0)
  );
};

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
export function quoteTranslation(
  doc: ComicDoc,
  keys: StudioKeys,
  action: Pick<TranslateAction, 'languages' | 'pageIds' | 'force' | 'overwriteEdits'>,
  /** The user's text rates (the request's PriceBook): what translations really cost against their estimate. */
  text?: Pick<TextRates, 'translateFactor'>
): TranslationQuote {
  // Priced for the key the translator will run on (not the images' key).
  const byok = textRoleIsByok('translator', keys);
  const trModel = resolveTextRoute('translator', keys)?.model ?? TEXT_ROLE_DEFAULTS.translator.models[0];
  const plans: TranslationPlan[] = [];
  const perLanguage: LanguageQuote[] = [];
  const lines: SpendEstimate['lines'] = [];
  for (const lang of action.languages) {
    const plan = planTranslation(doc, lang, { pageIds: action.pageIds, force: action.force, overwriteEdits: action.overwriteEdits });
    plans.push(plan);
    const out = plan.tokens.output;
    const usd = round4(planUsd(plan, keys) * quoteFactor(lang, text));
    const translated = planLineCount(plan);
    const free = plan.freeLines.length + (plan.deferred?.length || 0);
    const chunks = chunkTranslation(plan.toTranslate).length || (plan.calls ? 1 : 0);
    const seconds = Math.round(chunks * 4 + out / 70 + (plan.reviewCalls || 0) * 3 + plan.tokens.reviewOutput / 140);
    perLanguage.push({ lang, lines: translated + plan.coverTexts.length, free, upToDate: planIsFree(plan) && !plan.freeLines.length, usd, seconds });
    if (usd > 0) lines.push({ label: englishName(lang), count: translated + plan.coverTexts.length + (plan.toReview?.length || 0), usd });
  }
  const usd = round4(lines.reduce((s, l) => s + l.usd, 0));
  // Languages run up to TRANSLATE_CONCURRENCY at a time; that changes the wait, never the price.
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
  const q = quoteTranslation(doc, ctx.keys, { ...action, languages: codes }, await translateRatesFor(ctx));
  return { ...q.estimate, plans: q.plans };
}

// ── Run ──────────────────────────────────────────────────────────────────────

/**
 * Stop is the session's abort, captured when the run starts (a later request's resetAbort must not
 * undo a Stop the user pressed during this run). Like renders, a translation keeps going in the
 * background when the HTTP stream drops (a phone locking mid-run): only Stop cancels it.
 */
const cancelled = (signal: AbortSignal) => signal.aborted;

/** Languages being translated right now, per session: a double tap or a director call mid-run never pays twice. */
const inFlight = new WeakMap<object, Set<string>>();
const runningFor = (ctx: StudioContext): Set<string> => {
  let set = inFlight.get(ctx.session);
  if (!set) {
    set = new Set();
    inFlight.set(ctx.session, set);
  }
  return set;
};
/** True while `lang` is being translated in this session (tests + the director's honesty). */
export const translationRunning = (ctx: StudioContext, lang: string): boolean => !!inFlight.get(ctx.session)?.has(lang);

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
  /** Chunks of this language that were asked a second time here (a rate limit the text client could not ride out). */
  retries?: number;
  /** Translator calls of this language that failed, by error code (counts only; a RATE_LIMIT is a call the text client tried twice). */
  callErrors?: Record<string, number>;
  /** Wall time of this language in the run. */
  ms?: number;
  /** Set when the spending allowance said no in this or another lane: no more chunks were started. */
  stoppedBy?: 'billing';
  /** The allowance's own words, set only on the lane that heard the "no" (the run's message leads with them). */
  denied?: string;
}

/**
 * Simple promise pool (languages run with concurrency ≤ `limit`). Once `halted()` is true no worker takes
 * another item; the items never started stay `undefined`.
 */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>, halted: () => boolean = () => false): Promise<(R | undefined)[]> {
  const out: (R | undefined)[] = new Array(items.length).fill(undefined);
  let next = 0;
  const worker = async () => {
    while (next < items.length && !halted()) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.floor(limit) || 1), items.length) }, worker));
  return out;
}

/**
 * Languages translated at once (3 before 2026-11-19). Each lane holds at most one allowance hold and one
 * provider call. Lower it if the `comic_translate_timing` line shows `callErrors.RATE_LIMIT` with `byok: true`
 * (people's own keys meeting their rate limit).
 */
export const TRANSLATE_CONCURRENCY = 6;

/**
 * Run knobs (tests shorten the wait): the lanes, and the wait before a chunk's one retry here (min..max,
 * jittered). It is well past the text client's own 3 s rate-limit retry, so a per-minute limit has had time to
 * ease and six lanes that met it together do not come back together.
 */
export const TRANSLATE_TIMINGS = { lanes: TRANSLATE_CONCURRENCY, retryMinMs: 8000, retryMaxMs: 15000 };

/** The wait before a chunk is asked again: uniformly between retryMinMs and retryMaxMs. */
export const chunkRetryDelayMs = (random: () => number = Math.random): number => {
  const lo = Math.max(0, TRANSLATE_TIMINGS.retryMinMs);
  const hi = Math.max(lo, TRANSLATE_TIMINGS.retryMaxMs);
  return Math.round(lo + (hi - lo) * Math.min(1, Math.max(0, random())));
};

/**
 * True for a chunk failure worth one more ask HERE: a provider rate limit (RATE_LIMIT, or a bare 429), or a
 * NOT_AVAILABLE (nothing was sent). Every other failure is not asked again by the lanes:
 *  - the text client (llm.ts) already gave the call its one more try: a rate limit after 3 s; a provider 5xx,
 *    a network blip, an empty reply or a model not found after 1.5 s. A failure that reaches here has been
 *    asked twice, and stacking a second layer on it would double the requests a struggling key gets;
 *  - an unreadable reply was answered (and paid for at the provider) twice already; the text client
 *    deliberately does not pay a third time, and a failed call is never billed, so the platform (or the
 *    person's own key, untracked) would pay for every extra ask;
 *  - Stop, the allowance, no key, a timeout (it waited the role's full time and was billed an estimate), a
 *    rejected key, a key out of credits, a safety refusal: asking again changes nothing or costs again.
 * A rate limit is the one failure a longer wait fixes (a per-minute limit outlasts the text client's 3 s).
 */
export function chunkRetryable(err: unknown): boolean {
  if (err instanceof StudioError) return err.code === 'RATE_LIMIT' || err.code === 'NOT_AVAILABLE';
  if (!err || typeof err !== 'object') return false;
  const tagged = err as { status?: unknown; statusCode?: unknown };
  return Number(tagged.status ?? tagged.statusCode) === 429;
}

/** Wait `ms`, ending early when Stop is pressed (the caller checks the signal after). */
const waitUnlessStopped = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/** Run-wide state shared by every lane: once the allowance says no anywhere, no lane starts another call. */
interface RunStop {
  /** The allowance's own words, from the first lane it refused. */
  billing?: string;
  /**
   * A chunk's retry here met another rate limit: the key stays limited past the wait, so no other chunk of this
   * run is asked a second time (each ask is already two requests through the text client).
   */
  noRetry?: boolean;
}

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

/** The chunk's pages as they are in `doc` now (a page deleted meanwhile drops out). */
const chunkPages = (doc: ComicDoc, chunk: ReturnType<typeof chunkTranslation>[number]) =>
  chunk
    .map((g) => ({ page: doc.pages.find((p) => p.id === g.pageId), lineIds: new Set(g.lineIds) }))
    .filter((g): g is { page: NonNullable<typeof g.page>; lineIds: Set<string> } => !!g.page);

const cancelledError = () => new StudioError('CANCELLED', 'Cancelled.', { status: 499 });

const emptyResult = (lang: string): LanguageResult => ({
  lang,
  translated: 0,
  free: 0,
  reviewed: 0,
  autoFixed: 0,
  failed: 0,
  unsafe: 0,
  tooLong: 0,
  reviewSkipped: 0,
  cancelled: false,
  usd: 0,
  byok: false,
  retries: 0,
  callErrors: {},
  ms: 0
});

/** The allowance said no to this lane: every lane stops, and this lane keeps the words for the run's message. */
const stopForBilling = (stop: RunStop, res: LanguageResult, message: string) => {
  if (stop.billing === undefined) stop.billing = message;
  res.stoppedBy = 'billing';
  res.denied = message;
};

const codeOf = (err: unknown): string => (err instanceof StudioError ? err.code : 'INTERNAL');

async function runLanguage(ctx: StudioContext, lang: string, action: TranslateAction, signal: AbortSignal, onPage: (label: string) => (ok: boolean) => void, stop: RunStop = {}): Promise<LanguageResult> {
  const spec = languageSpec(lang)!;
  const tracker: TextSpendTracker = newTextSpendTracker();
  const res: LanguageResult = emptyResult(lang);
  // An approved translation outlives its HTTP stream. Queue admission and billing
  // use this run's Stop signal. A chunk already dispatched still finishes and settles.
  const runContext = { ...ctx, signal };
  const rating = ratingOf(ctx);
  const opts = { pageIds: action.pageIds, force: action.force, overwriteEdits: action.overwriteEdits };
  const plan = planTranslation(ctx.session.doc, lang, opts);
  // This language's translator and review calls are one priced operation, compared with the plan's own token
  // estimate (provider cost, never the calibrated quote) when the next translation is quoted (models/textRates.ts).
  const op = textOpTag('translate', 1, planUsd(plan, ctx.keys, true));
  const llmT = billedLlm(runContext, { stage: 'translate', operation: 'comic.text.translator', tracker, ...(op ? { textOp: op } : {}) });
  const llmL = billedLlm(runContext, { stage: 'translate', operation: 'comic.text.linguist', tracker, ...(op ? { textOp: op } : {}) });
  const chunks = chunkTranslation(plan.toTranslate);
  const extras = extrasFor(ctx.session.doc, plan.coverTexts);
  if (!chunks.length && extras.length) chunks.push([]);
  const translatedIds: string[] = [];
  // What this plan priced before calibration; the bill of a finished run is compared to it (calibrate).
  const quoted = planUsd(plan, ctx.keys);
  try {
    for (const [i, chunk] of chunks.entries()) {
      if (cancelled(signal)) {
        res.cancelled = true;
        break;
      }
      // Another lane (or this one) heard "no" from the allowance: no lane starts another chunk.
      if (stop.billing !== undefined) {
        res.stoppedBy = 'billing';
        break;
      }
      const first = chunkPages(ctx.session.doc, chunk)[0]?.page.n;
      const end = onPage(first ? `Translating page ${first} into ${spec.endonym}…` : `Translating the title into ${spec.endonym}…`);
      // No abort signal on the call itself: Stop takes effect AFTER the current chunk (a started call is
      // paid for, so its lines are kept), exactly like a render that is already drawing. Each ask reads the
      // doc as it is then (the author may have edited lines during a retry's wait).
      const ask = async () => {
        const doc = ctx.session.doc;
        try {
          return await translateChunk(llmT, { doc, lang, pages: chunkPages(doc, chunk), extras: i === 0 ? extras : [], rating });
        } catch (err) {
          const callErrors = (res.callErrors ??= {});
          callErrors[codeOf(err)] = (callErrors[codeOf(err)] || 0) + 1;
          throw err;
        }
      };
      try {
        let result: Awaited<ReturnType<typeof translateChunk>>;
        try {
          result = await ask();
        } catch (err) {
          // A rate limit the text client could not ride out (its own retry came 3 s later) gets ONE more ask
          // here, 8 to 15 s later with jitter, before the chunk's lines count as failed. A failed call held
          // nothing back (billedLlm released its hold), so the success path and its price are unchanged. Once
          // a retry meets another rate limit, the rest of the run asks nothing twice (stop.noRetry).
          if (!chunkRetryable(err) || stop.noRetry) throw err;
          await waitUnlessStopped(chunkRetryDelayMs(), signal);
          if (cancelled(signal)) throw cancelledError();
          if (stop.billing !== undefined || stop.noRetry) throw err;
          res.retries = (res.retries || 0) + 1;
          logger.warn('comic_translate_chunk_retry', { projectId: ctx.projectId, lang, code: codeOf(err) });
          try {
            result = await ask();
          } catch (again) {
            if (chunkRetryable(again)) stop.noRetry = true;
            throw again;
          }
        }
        // Ops against the doc as it is NOW (the author may have edited lines while the chunk was out).
        const ops = chunkOps(ctx.session.doc, lang, result, Date.now(), result.model);
        if (ops.length) ctx.session.commit(ops, { origin: 'job' });
        // Only what the commit actually wrote goes to the review; an author's edit made meanwhile is theirs.
        const written = new Set<string>();
        for (const op of ops) {
          if (op.op === 'translations') for (const id of Object.keys(op.lines)) written.add(id);
          else if (op.op === 'edition_text') written.add(op.field);
        }
        translatedIds.push(...[...Object.keys(result.lines), ...Object.keys(result.extras)].filter((id) => written.has(id)));
        res.translated += Object.keys(result.lines).filter((id) => written.has(id)).length;
        res.failed += result.failed.length;
        res.unsafe += result.unsafe.length;
        res.tooLong += Object.values(result.lines).filter((l) => l.tooLong).length;
        end(true);
      } catch (err) {
        end(false);
        const code = err instanceof StudioError ? err.code : undefined;
        if (code === 'CANCELLED') {
          res.cancelled = true;
          break;
        }
        res.error = err instanceof StudioError ? err.userMessage : 'The translator did not answer.';
        // Every lane stops BEFORE this is logged, so nothing new starts once the allowance said no.
        if (code === 'BILLING_DENIED') stopForBilling(stop, res, res.error);
        logger.warn('comic_translate_chunk_failed', { projectId: ctx.projectId, lang, code: code || 'INTERNAL', message: (err as Error)?.message });
        res.failed += chunk.reduce((n, g) => n + g.lineIds.length, 0);
        if (code === 'BILLING_DENIED' || code === 'NO_TEXT_KEY') break;
      }
    }

    // The linguist review — always (the lines just written + any current line still waiting for review) —
    // unless the allowance said no in some lane: then no new paid call starts, and the written lines wait
    // for review (the next run reviews them: they stay in plan.toReview).
    const reviewIds = [...new Set([...translatedIds, ...(plan.toReview || [])])];
    if (reviewIds.length && !res.cancelled && stop.billing !== undefined) {
      res.stoppedBy = 'billing';
      res.reviewSkipped += reviewIds.length;
    } else if (reviewIds.length && !res.cancelled) {
      const end = onPage(`Reviewing the ${spec.english} translation…`);
      const run = await reviewTranslations(llmL, ctx.session.doc, lang, reviewIds, signal);
      const outcome = applyReview(ctx.session.doc, lang, run.verdicts, rating, Date.now());
      if (outcome.ops.length) ctx.session.commit(outcome.ops, { origin: 'job' });
      res.reviewed += outcome.reviewed;
      res.autoFixed += outcome.autoFixed;
      res.reviewSkipped += Math.max(0, reviewIds.length - run.verdicts.size);
      if (run.error?.code === 'CANCELLED') res.cancelled = true;
      else if (run.error && !res.error) res.error = run.error.userMessage;
      if (run.error?.code === 'BILLING_DENIED') {
        // The allowance's words win over an earlier chunk error: they are why nothing more runs.
        res.error = run.error.userMessage;
        stopForBilling(stop, res, run.error.userMessage);
      }
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
    // Only a run that did all its work is a fair comparison (a stopped or failed one billed less than planned).
    if (!res.cancelled && !res.error && !res.stoppedBy) calibrate(lang, quoted, tracker.usd);
  }
  return res;
}

/**
 * In-art lettering: translated editions need overlay lettering (owner rule) — the quoted fix, on the comic's locked
 * model, at the user's PriceBook (the Languages tab's "Redraw N pages" names the same figure).
 */
export function overlayFix(doc: ComicDoc, byok: boolean, prices?: PriceBook): { pages: string[]; usd: number } | null {
  if (doc.format.lettering !== 'in_art') return null;
  const pages = doc.pages.filter((p) => p.panels.some((panel) => panel.lines.some((l) => l.text.trim() && !l.noTranslate)) && (p.render.asset || p.render.history.length));
  const usd = pages.length ? estimateDocJobs(doc, [{ kind: 'page', count: pages.length }], { byok, ...(prices ? { prices } : {}) }).usd : 0;
  return { pages: pages.map((p) => p.id), usd };
}

/**
 * Painted cover title: the one-time textless cover + editable overlay title (decisions-final #2), on the locked model,
 * at the user's PriceBook (the chip's quotedUsd is the figure its approval names).
 */
export function textlessCoverQuote(doc: ComicDoc, byok: boolean, prices?: PriceBook): number | null {
  const painted = (doc.cover.lettering ?? 'in_art') === 'in_art' && !!doc.cover.render.asset;
  if (!painted) return null;
  return estimateDocJobs(doc, [{ kind: 'cover', count: 1 }], { byok, ...(prices ? { prices } : {}) }).usd;
}

/**
 * The appended completion message (honest per-language summary + the next steps). `view` words every
 * price for the user (costViewFor(caps)): a governed user reads "≈1% of your usage", never dollars.
 */
export function completionMessage(
  doc: ComicDoc,
  results: LanguageResult[],
  keys: StudioKeys,
  view: CostView = DOLLAR_VIEW,
  text?: Pick<TextRates, 'translateFactor'>,
  /** The user's PriceBook for the image steps it offers (overlay redraw, textless cover). Absent = the registry list. */
  prices?: PriceBook
): { text: string; nextSteps: NextStep[] } {
  // The image quotes below (overlay redraw, textless cover) stay keys-level; the translation's own
  // cost line names the translator's key.
  const byok = spendIsByok(keys);
  const textByok = textRoleIsByok('translator', keys);
  const fmt = costFormatter(view);
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
  // The allowance's "no" stopped every lane: its own words (from the lane that heard it) lead, once, whatever
  // else a lane reported before or while the stop came.
  const billingStop = results.find((r) => r.denied)?.denied;
  const errors = [...new Set([billingStop, ...results.map((r) => r.error)].filter((e): e is string => !!e))];
  const usd = round4(results.reduce((s, r) => s + r.usd, 0));
  let head: string;
  if (anyCancelled) head = 'Stopped — the finished pages are kept.';
  else if (ready.length === results.length) head = `${joinList(results.map((r) => englishName(r.lang)))} ${results.length === 1 ? 'is' : 'are'} translated and reviewed.`;
  else head = `Translation finished for ${joinList(results.map((r) => englishName(r.lang)))}.`;
  const cost = fmt.governed
    ? usd > 0
      ? ` Used ${fmt(usd)}.`
      : ' Free — done by the editor, no AI needed.'
    : usd > 0
      ? ` Cost ${formatUsd(usd)}${textByok ? ' on your key' : ''}.`
      : ' Cost $0 — done by the editor, no AI cost.';
  const lines = [head, ...parts];
  if (errors.length) {
    // Which languages the "no" cut short: all of them, or only some (a language that had already finished
    // is not one of them). One language alone needs no such sentence.
    const halted = billingStop ? results.filter((r) => r.stoppedBy === 'billing') : [];
    const who = halted.length < 2 ? '' : halted.length === results.length ? 'Every language' : joinList(halted.map((r) => englishName(r.lang)));
    const stopped = who ? ` ${who} stopped there; the lines already written are kept.` : '';
    lines.push(`${errors[0]}${/[.!?]$/.test(errors[0]) ? '' : '.'}${stopped} Translate again to retry — only the missing lines are charged.`);
  }
  const fix = overlayFix(doc, byok, prices);
  if (fix && fix.pages.length) {
    lines.push(`Your pages have the lettering painted into the art, so readers would still see the original words. Translated editions need overlay lettering: redrawing ${plural(fix.pages.length, 'page')} without text ${fmt.governed ? `uses ${fmt.approx(fix.usd)}` : `costs ≈ ${formatUsd(fix.usd)}`}, and after that every language is free.`);
    steps.push({ label: 'Set up lettering for translations', client: { type: 'open_tab', tab: 'languages' } });
  } else if (ready.length) {
    lines.push(`Ready to publish in ${joinList(ready)} — readers pick their language in the reader.`);
  }
  const cover = textlessCoverQuote(doc, byok, prices);
  if (cover !== null && results.length) {
    lines.push(`The cover title is painted in ${englishName(doc.format.language)}. A textless cover with an editable title is a one-time ${fmt.approx(cover)}; every language's title is free after that.`);
    steps.push({ label: 'Textless cover', action: { type: 'render_cover', textless: true, quotedUsd: cover }, usd: cover });
  }
  steps.unshift({ label: 'Review translations', client: { type: 'open_tab', tab: 'languages' } });
  if (ready.length && !fix?.pages.length) steps.push({ label: 'Publish', client: { type: 'open_share' } });
  missingLangs = missingLangs.filter((l) => !results.find((r) => r.lang === l)?.unsafe);
  if (missingLangs.length && !anyCancelled) {
    const again = quoteTranslation(doc, keys, { languages: missingLangs }, text).estimate.usd;
    steps.push({ label: 'Translate missing lines', action: { type: 'translate', languages: missingLangs, quotedUsd: again }, usd: again });
  }
  // The net under the template: an error text or a later line that still carries a dollar figure.
  return { text: governDollars(`${lines.join(' ')}${cost}`.trim(), view), nextSteps: steps.slice(0, DOC_LIMITS.nextSteps) };
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

/** The price view for this run's user (the request's caps; absent ⇒ the context's). */
const viewFor = (ctx: StudioContext, opts: RunActionOptions): CostView => costViewFor(opts.caps ?? ctx.caps);

/**
 * Tell the user (director turn: a card in its message; UI tap: a new assistant message). The words are
 * priced for the user first; returns them so the outcome the caller reads says exactly the same.
 */
const tell = (ctx: StudioContext, opts: RunActionOptions, words: string, tone: 'info' | 'warn' | 'success' = 'info', steps?: NextStep[]): string => {
  const view = viewFor(ctx, opts);
  const text = governDollars(words, view);
  const card = governCard({ type: 'notice', id: newId('card'), tone, text }, view);
  if (opts.collectCard) {
    opts.collectCard(card);
    if (steps?.length) opts.collectNextSteps?.(steps);
    return text;
  }
  ctx.session.commit([{ op: 'message', msg: message(text, [card], steps) }], { origin: 'job' });
  return text;
};

const finished = (outcome: StartedAction['outcome']): StartedAction => ({ outcome, done: Promise.resolve() });

/** Run an approved translation (background; `done` settles when every edition finished). */
export async function runTranslation(ctx: StudioContext, action: TranslateAction, opts: RunActionOptions): Promise<StartedAction> {
  const doc = ctx.session.doc;
  // The run's messages say when it started (Msg.runAt): its result never moves the chat past a question asked meanwhile.
  const runAt = Date.now();
  // Every price this run words — start, completion, notices, the outcome — is worded for this user.
  const view = viewFor(ctx, opts);
  const fmt = costFormatter(view);
  const resolved = resolveLanguages(doc, action.languages);
  const { unknown } = resolved;
  if (!resolved.codes.length) {
    const words = unknown.length ? `I don't know ${joinList(unknown)} as a language. ${supportedLanguagesText(doc)}` : `${englishName(doc.format.language)} is already the comic's language. ${supportedLanguagesText(doc)}`;
    const text = tell(ctx, opts, words, 'warn');
    return finished({ status: 'blocked', message: text, code: 'BAD_REQUEST' });
  }
  // A language already being translated in this session is never started twice (no double charge).
  const running = runningFor(ctx);
  const busy = resolved.codes.filter((c) => running.has(c));
  const codes = resolved.codes.filter((c) => !running.has(c));
  const busyNote = busy.length ? `${joinList(busy.map(englishName))} ${busy.length === 1 ? 'is' : 'are'} already being translated — that result arrives as a new message.` : '';
  if (!codes.length) {
    const text = tell(ctx, opts, `${busyNote} Nothing new was started or charged.`, 'info');
    return finished({ status: 'blocked', message: text, code: 'CONFLICT' });
  }
  const existing = Object.keys(i18nOf(doc).editions);
  const added = codes.filter((c) => !existing.includes(c));
  if (existing.length + added.length > DOC_LIMITS.editions) {
    const text = tell(ctx, opts, `A comic can have up to ${DOC_LIMITS.editions} translations; remove one in Languages first.`, 'warn');
    return finished({ status: 'blocked', message: text, code: 'LIMIT' });
  }
  const rates = await translateRatesFor(ctx);
  // The image steps the completion message offers are priced at the user's book: fetched while the run works.
  void priceBookFor(ctx);
  const quote = quoteTranslation(doc, ctx.keys, { ...action, languages: codes }, rates);
  const paid = quote.plans.some((p) => !planIsFree(p));
  if (paid && !resolveTextRoute('translator', ctx.keys)) {
    const text = tell(ctx, opts, 'Translation needs an AI key: connect a Gemini or OpenRouter key in Settings → API keys.', 'warn');
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
    let text = upToDate
      ? `${names} ${codes.length === 1 ? 'is' : 'are'} already up to date. Nothing to translate (${fmt.governed ? 'free' : '$0'}).`
      : `Done for free: ${plural(freeCount, 'line')} copied by software into ${names} (${fmt.governed ? 'no AI needed' : '$0 — no AI needed'}).`;
    if (busyNote) text = `${text} ${busyNote}`;
    text = governDollars(text, view);
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
  const price = fmt.governed ? fmt.approx(quote.estimate.usd) : `≈ ${formatUsd(quote.estimate.usd)}${quote.byok ? ' on your key' : ''}`;
  const startText = governDollars(
    `Translating ${plural(lines, 'line')} into ${names} (${price})${freeCount ? `; ${plural(freeCount, 'line')} reused for free` : ''}. Every line gets a linguist review.${skipped}${busyNote ? ` ${busyNote}` : ''}`,
    view
  );
  const card = translationCard(codes);
  let startMsgId: string | undefined;
  if (opts.collectCard) opts.collectCard(card);
  else {
    const msg: Msg = { ...message(startText, [card]), runAt };
    startMsgId = msg.id;
    ctx.session.commit([{ op: 'message', msg }], { origin: 'job' });
  }

  // Captured now: a Stop pressed during this run stays pressed even if a later request resets the session abort.
  const signal = ctx.session.abort.signal;
  for (const lang of codes) running.add(lang);
  const work = (async () => {
    let results: LanguageResult[] = [];
    // Shared by every lane: once the allowance says no anywhere, no lane starts another chunk or language.
    const stop: RunStop = {};
    const lanes = Math.min(Math.max(1, Math.floor(TRANSLATE_TIMINGS.lanes) || TRANSLATE_CONCURRENCY), codes.length);
    const runStarted = Date.now();
    try {
      const out = await pool(
        codes,
        lanes,
        async (lang) => {
          const t0 = Date.now();
          try {
            const r = await runLanguage(ctx, lang, { ...action, languages: [lang] }, signal, (label) => activity(ctx, label), stop);
            r.ms = Date.now() - t0;
            return r;
          } finally {
            running.delete(lang);
          }
        },
        () => stop.billing !== undefined
      );
      // A language the stop kept from starting is reported honestly: nothing of it was asked or charged.
      results = codes.map((lang, i) => out[i] ?? { ...emptyResult(lang), stoppedBy: 'billing' as const });
    } catch (err) {
      logger.error('comic_translate_failed', { projectId: ctx.projectId, message: (err as Error)?.message });
    } finally {
      for (const lang of codes) running.delete(lang);
    }
    const done = ctx.session.doc;
    const { text, nextSteps } = results.length
      ? completionMessage(done, results, ctx.keys, view, rates, await priceBookWithin(ctx))
      : { text: "The translation couldn't run. Nothing was charged for unfinished lines — try again in a moment.", nextSteps: [] as NextStep[] };
    const last = done.conversation[done.conversation.length - 1];
    if (startMsgId && last?.id === startMsgId) {
      // A UI-started run rewrites its own progress message while it is still the last one.
      ctx.session.commit([{ op: 'message_patch', id: startMsgId, patch: { text, at: Date.now(), nextSteps, suggestions: nextSteps.map((s) => s.label) } }], { origin: 'job' });
    } else {
      // Otherwise the summary is APPENDED (fresh `at`, after whatever the user said meanwhile) and a
      // UI-started progress message points down to it instead of still saying "Translating…".
      const ops: DocOp[] = [];
      if (startMsgId && done.conversation.some((m) => m.id === startMsgId)) {
        ops.push({ op: 'message_patch', id: startMsgId, patch: { text: `${startText} The result is below.` } });
      }
      ops.push({ op: 'message', msg: { ...message(text, startMsgId ? [translationCard(codes)] : undefined, nextSteps), runAt } });
      ctx.session.commit(ops, { origin: 'job' });
    }
    const usd = round4(results.reduce((s, r) => s + r.usd, 0));
    logger.info('comic_translate_done', { projectId: ctx.projectId, langs: codes, usd, translated: results.reduce((n, r) => n + r.translated, 0), free: freeCount + results.reduce((n, r) => n + r.free, 0) });
    // Counts and milliseconds only (no words, no user): tells whether 6 lanes meet rate limits on own keys
    // (`byok`: the translator ran on the person's own key, where the lane count should come down first).
    // `callErrors` counts the translator calls that failed, by code: a RATE_LIMIT there is a call the provider
    // still rate-limited after the text client's own retry; `retries` counts the chunks asked again here. A
    // single 429 the text client rode out shows only in its own `comic_llm_retry` line.
    const callErrors: Record<string, number> = {};
    for (const r of results) for (const [code, n] of Object.entries(r.callErrors || {})) callErrors[code] = (callErrors[code] || 0) + n;
    logger.info('comic_translate_timing', {
      projectId: ctx.projectId,
      byok: textRoleIsByok('translator', ctx.keys),
      langs: codes.length,
      lanes,
      ms: Date.now() - runStarted,
      perLangMs: Object.fromEntries(results.map((r) => [r.lang, r.ms ?? 0])),
      retries: results.reduce((n, r) => n + (r.retries || 0), 0),
      callErrors,
      failedLines: results.reduce((n, r) => n + r.failed, 0),
      stoppedBy: stop.billing !== undefined ? 'billing' : results.some((r) => r.cancelled) ? 'user' : null
    });
  })();
  const done = ctx.track(work).then(
    () => undefined,
    () => undefined
  );
  return { outcome: { status: 'started', message: `${startText} The result arrives as a new message.`, estimate: quote.estimate }, done };
}

/** Source text hash of a cover/brief field (re-exported for the sanitizer). */
export const editionFieldHash = (doc: ComicDoc, field: EditionTextField): string => textSourceHash(editionTextSource(doc, field));
