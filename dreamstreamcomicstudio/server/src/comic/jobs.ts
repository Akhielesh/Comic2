// Job runner for Comic Studio (v4): direct studio actions, the spend gate, and the
// image render pipeline.
//
// Every action either edits the doc (patch, pick a style, approve a plan, restore a
// version) or SPENDS (style options, sheets, pages, edits, cover). Spend actions are
// estimated with the shared registry first and stop at a Gate when the user's confirm
// policy or budget cap says so — nothing is drawn until the gate is approved. Approved
// work renders server-side (closing the tab never loses a paid image):
//
//   targets marked queued → [missing sheets] → page 1 alone (continuity anchor) →
//   remaining pages in parallel (≤3 image calls per project) → per page: vision QC +
//   balloon layout (fail-soft) → spend entry + signed URL for every image.
//
// Each image is billed per call (reserve → settle with the provider-reported cost →
// release on failure); the doc's spend ledger records every paid call (BYOK flagged),
// so the header total is always truthful. Cancellation stops work that has not started;
// in-flight image calls finish and are kept (they are paid). Nothing is ever left
// "queued". See docs/features/comic-studio-v4.md §2–§5.

import {
  collectAssetPaths,
  emptyRender,
  findCharacter,
  findPage,
  findPlace,
  getRender,
  isPageStale,
  newId,
  pageSpecHash,
  renderTargetKey,
  type AspectRatio,
  type AssetRef,
  type Balloon,
  type Box,
  type Card,
  type Character,
  type ComicDoc,
  type ComicKind,
  type ColorMode,
  type ConfirmPolicy,
  type Format,
  type Gate,
  type LetteringMode,
  type LineKind,
  type Msg,
  type NextStep,
  type Page,
  type PanelSize,
  type Place,
  type QcReport,
  type QualityTier,
  type RenderState,
  type RenderTarget,
  type Settings,
  type ShotType,
  type SpendKind,
  type StyleBible
} from '../../../shared/comic/doc.js';
import { CLIENT_PATCHABLE_OPS, isSpendAction, type DocOp, type SpendAction, type StudioAction } from '../../../shared/comic/ops.js';
import type { OpsOrigin } from '../../../shared/comic/events.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities.js';
import { effectiveRating } from '../../../shared/comic/safety.js';
import {
  IMAGE_MODELS,
  PLATFORM_MARKUP,
  QC_USD_PER_PAGE,
  TIER_PRESETS,
  estimateJobs,
  formatUsd,
  imagePriceUsd,
  resolveImageJob,
  type ImageJobKind,
  type ImageModelSpec,
  type ImageRoute,
  type SpendEstimate
} from '../../../shared/comic/models.js';
import { STYLE_PRESETS, getStylePreset, type StylePreset } from '../../../shared/comic/stylePresets.js';
import type { ChatMessage } from '../ai/providers/types.js';
import { logger } from '../lib/logger.js';
import { actionHandlerFor } from './actions/index.js';
import type { OrchestratorContext } from './context.js';
import type { ActionHandler, SanitizeCtx } from './extensions.js';
import { compileCharacterSheet, compileCover, compileEdit, compilePage, compilePlaceSheet, compileStyleOption } from './prompts.js';
import { estimateTextCostUsd, resolveTextRoute } from './textModels.js';
import {
  StudioError,
  type BillingReservation,
  type CompiledImageJob,
  type ImageReference,
  type ImageResult,
  type LlmClient,
  type LlmResult,
  type StudioContext,
  type StudioErrorCode,
  type StudioKeys,
  type StudioSessionApi
} from './types.js';
import { analyzePageRender, estimatePanelBoxes, fallbackBalloons } from './vision.js';
import { opSanitizerFor, patchScreens } from './sanitize/index.js';
import { mergeRevisedPages, proposeStyleDirections, writePagePlan } from './writer.js';

// ── Limits & constants ───────────────────────────────────────────────────────

/** Concurrent image calls per project. */
export const MAX_PARALLEL_IMAGES = 3;
/** QC score under which the user is told a page may need another pass. */
export const LOW_QC_SCORE = 0.45;
/** Attempts per image (the transport already retries 429/5xx once inside an attempt). */
const MAX_IMAGE_ATTEMPTS = 2;
/** Pauses between attempts (tests shorten them). */
export const JOB_TIMINGS = { retryBackoffMs: 2500, saveRetryMs: 1000 };
const MAX_STYLE_DIRECTIONS = 4;
const DEFAULT_STYLE_DIRECTIONS = 3;
/** Writer text spend for proposing style directions (one strong-model call, occasional repair). */
const STYLE_DIRECTIONS_USD = 0.015;
const MAX_PATCH_OPS = 200;

const TEXT_LIMIT = 4_000;
const LONG_TEXT_LIMIT = 200_000;

export const COMIC_KINDS: ComicKind[] = ['comic', 'manga', 'webtoon', 'strip', 'storybook'];
export const ASPECT_RATIOS: AspectRatio[] = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1'];
export const LETTERING_MODES: LetteringMode[] = ['overlay', 'in_art'];
export const COLOR_MODES: ColorMode[] = ['color', 'bw', 'limited'];
export const QUALITY_TIERS: QualityTier[] = ['draft', 'standard', 'pro'];
export const CONFIRM_POLICIES: ConfirmPolicy[] = ['always', 'big', 'never'];
export const PANEL_SIZES: PanelSize[] = ['small', 'medium', 'large', 'wide', 'tall', 'splash'];
export const SHOT_TYPES: ShotType[] = ['establishing', 'wide', 'full', 'medium', 'close_up', 'extreme_close_up', 'over_shoulder', 'insert', 'pov'];
export const LINE_KINDS: LineKind[] = ['speech', 'thought', 'caption', 'sfx', 'whisper', 'shout'];
const SPOKEN_KINDS = new Set<LineKind>(['speech', 'thought', 'whisper', 'shout']);
const CAST_TIERS = ['lead', 'support', 'extra'] as const;
const LOOK_FIELDS = ['summary', 'age', 'gender', 'build', 'face', 'hair', 'eyes', 'skin', 'outfit', 'palette', 'props', 'marks'] as const;

// ── Small helpers ────────────────────────────────────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const clean = (value: unknown, max = TEXT_LIMIT): string =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const round4 = (n: number) => Math.round(n * 10000) / 10000;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isBusy = (render?: RenderState) => render?.status === 'queued' || render?.status === 'rendering';
const badRequest = (message: string) => new StudioError('BAD_REQUEST', message, { status: 400 });
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });

const asStudioError = (err: unknown, fallback = 'Something went wrong. Please try again.'): StudioError => {
  if (err instanceof StudioError) return err;
  logger.error('comic_job_unexpected_error', { message: (err as Error)?.message, stack: (err as Error)?.stack?.split('\n').slice(0, 4).join(' | ') });
  return new StudioError('INTERNAL', fallback, { status: 500, cause: err });
};

export const noticeCard = (tone: 'info' | 'warn' | 'error' | 'success', text: string): Card => ({
  type: 'notice',
  id: newId('card'),
  tone,
  text
});

const assistantMessage = (text: string, cards?: Card[], suggestions?: string[]): Msg => ({
  id: newId('msg'),
  role: 'assistant',
  text,
  at: Date.now(),
  ...(cards?.length ? { cards } : {}),
  ...(suggestions?.length ? { suggestions } : {})
});

const activity = (ctx: StudioContext, label: string) => {
  const id = newId('act');
  ctx.session.emit({ type: 'activity', id, label, phase: 'start' });
  let ended = false;
  return (ok: boolean) => {
    if (ended) return;
    ended = true;
    ctx.session.emit({ type: 'activity', id, label, phase: 'end', ok });
  };
};

/** Which transport an image model will use with these keys (mirrors the image client). */
export const imageRouteFor = (spec: ImageModelSpec, keys: StudioKeys): { route: ImageRoute; model: string; byok: boolean } | null => {
  if (keys.openrouter?.key && spec.routes.openrouter) return { route: 'openrouter', model: spec.routes.openrouter, byok: keys.openrouter.byok };
  if (keys.gemini?.key && spec.routes.gemini) return { route: 'gemini', model: spec.routes.gemini, byok: keys.gemini.byok };
  return null;
};

/** Whether spend will run on the user's own key (OpenRouter preferred, else Gemini). */
export const spendIsByok = (keys: StudioKeys): boolean =>
  keys.openrouter?.key ? Boolean(keys.openrouter.byok) : Boolean(keys.gemini?.byok);

/** Spend in the same unit as estimates: provider cost, plus platform markup unless BYOK. */
const chargedUsd = (providerUsd: number, byok: boolean) => round4(Math.max(0, providerUsd) * (byok ? 1 : PLATFORM_MARKUP));

const imageOperation: Record<ImageJobKind, string> = {
  style_option: 'comic.image.style',
  sheet: 'comic.image.sheet',
  place: 'comic.image.sheet',
  page: 'comic.image.page',
  edit: 'comic.image.edit',
  cover: 'comic.image.cover'
};

// ── Per-project image concurrency ────────────────────────────────────────────

class Semaphore {
  private active = 0;
  private readonly waiters: { resolve: () => void; reject: (err: unknown) => void }[] = [];

  constructor(private readonly size: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new StudioError('CANCELLED', 'Cancelled.', { status: 499 });
    if (this.active < this.size) {
      this.active += 1;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject
      };
      const onAbort = () => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new StudioError('CANCELLED', 'Cancelled.', { status: 499 }));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(waiter);
    });
    return this.releaser();
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next.resolve();
      else this.active = Math.max(0, this.active - 1);
    };
  }
}

const imageSlots = new WeakMap<StudioSessionApi, Semaphore>();
const slotsFor = (session: StudioSessionApi) => {
  let s = imageSlots.get(session);
  if (!s) {
    s = new Semaphore(MAX_PARALLEL_IMAGES);
    imageSlots.set(session, s);
  }
  return s;
};

// Spend a run has committed to but not yet landed. The budget gate adds this so two
// back-to-back requests on the single-threaded server each see the other's reservation
// (otherwise concurrent runs each quote against a stale `doc.spend.totalUsd` and overshoot).
const pendingSpend = new WeakMap<StudioSessionApi, number>();
const pendingUsdOf = (s: StudioSessionApi) => pendingSpend.get(s) || 0;
const addPending = (s: StudioSessionApi, delta: number) => pendingSpend.set(s, Math.max(0, round4(pendingUsdOf(s) + delta)));

// ── Billed text calls ────────────────────────────────────────────────────────

export interface TextSpendTracker {
  /** Charged USD (markup applied unless BYOK). */
  usd: number;
  estimated: boolean;
  byok: boolean;
  calls: number;
  model?: string;
}

export const newTextSpendTracker = (): TextSpendTracker => ({ usd: 0, estimated: false, byok: false, calls: 0 });

const textOf = (messages: ChatMessage[]): { chars: number; images: number } => {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else for (const part of m.content || []) part.type === 'text' ? (chars += part.text.length) : (images += 1);
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return { chars, images };
};

/** Generic per-1M prices when a model is not in the price table (keeps estimates honest, never $0). */
const UNKNOWN_TEXT_PRICE = { input: 1, output: 5 };

/**
 * An LlmClient that reserves/settles platform billing around every call and accumulates
 * the charged cost in `tracker` (estimated from tokens when the provider reports none).
 */
export function billedLlm(ctx: StudioContext, args: { stage: SpendKind; operation: string; tracker: TextSpendTracker }): LlmClient {
  return {
    async complete(req) {
      // Cancelled before we even reserved: nothing to bill or release.
      if (req.signal?.aborted) throw new StudioError('CANCELLED', 'Cancelled.', { status: 499 });
      const route = resolveTextRoute(req.role, ctx.keys);
      const size = textOf(req.messages);
      const approxPrompt = Math.ceil(size.chars / 4) + size.images * 1100;
      let reservation: BillingReservation | undefined;
      if (route) {
        const reserved = await ctx.billing.reserve({
          operation: args.operation,
          provider: route.route,
          model: route.model,
          stage: args.stage,
          inputTokens: approxPrompt,
          outputTokens: req.maxTokens
        });
        if (reserved.ok === false) throw new StudioError('BILLING_DENIED', reserved.message, { status: 402 });
        reservation = reserved.reservation;
        // Cancelled while the reserve was in flight: release it — nothing was dispatched, so
        // billing the usual CANCELLED estimate here would be charging for a call never made.
        // (Nothing is awaited between here and llm.ts's own pre-dispatch abort check.)
        if (req.signal?.aborted) {
          await reservation.release('cancelled_before_dispatch');
          throw new StudioError('CANCELLED', 'Cancelled.', { status: 499 });
        }
      }
      let result: LlmResult;
      try {
        result = await ctx.llm.complete(req);
      } catch (err) {
        const code = err instanceof StudioError ? err.code : undefined;
        if (code === 'CANCELLED' || code === 'TIMEOUT') {
          // The upstream request is NOT aborted (the provider takes no signal) — it keeps
          // generating on our key after the caller gave up. Releasing here would let a
          // cancel-spam loop burn platform money with nothing ever counted, so bill a
          // conservative estimate (prompt + half the output budget) instead.
          const outputGuess = Math.ceil((req.maxTokens || 2000) / 2);
          const providerGuess =
            (route && estimateTextCostUsd(route.model, approxPrompt, outputGuess)) ??
            (approxPrompt * UNKNOWN_TEXT_PRICE.input + outputGuess * UNKNOWN_TEXT_PRICE.output) / 1_000_000;
          await reservation?.settle({ costUsd: providerGuess, promptTokens: approxPrompt, completionTokens: outputGuess });
          if (route) {
            args.tracker.usd = round4(args.tracker.usd + chargedUsd(providerGuess, route.key.byok));
            args.tracker.byok = route.key.byok;
            args.tracker.estimated = true;
            args.tracker.calls += 1;
            args.tracker.model = route.model;
          }
        } else {
          await reservation?.release(String((err as Error)?.message || 'text_call_failed'));
        }
        throw err;
      }
      await reservation?.settle({ costUsd: result.costUsd, promptTokens: result.promptTokens, completionTokens: result.completionTokens });
      let provider = typeof result.costUsd === 'number' && Number.isFinite(result.costUsd) ? result.costUsd : undefined;
      if (provider === undefined) {
        const promptTokens = result.promptTokens ?? approxPrompt;
        const completionTokens = result.completionTokens ?? Math.ceil(((result.text || '').length + JSON.stringify(result.toolCalls || []).length) / 4);
        provider =
          estimateTextCostUsd(result.model || route?.model || '', promptTokens, completionTokens) ??
          (promptTokens * UNKNOWN_TEXT_PRICE.input + completionTokens * UNKNOWN_TEXT_PRICE.output) / 1_000_000;
        args.tracker.estimated = true;
      }
      args.tracker.usd = round4(args.tracker.usd + chargedUsd(provider, result.byok));
      args.tracker.byok = result.byok;
      args.tracker.calls += 1;
      args.tracker.model = result.model || args.tracker.model;
      return result;
    }
  };
}

/** Commit one spend entry for a text tracker (no-op when nothing was called). */
export const recordTextSpend = (ctx: StudioContext, tracker: TextSpendTracker, kind: SpendKind, label: string): void => {
  if (!tracker.calls) return;
  ctx.session.commit([
    {
      op: 'spend',
      entry: {
        id: newId('sp'),
        at: Date.now(),
        kind,
        label,
        usd: tracker.usd,
        ...(tracker.model ? { model: tracker.model } : {}),
        byok: tracker.byok,
        estimated: tracker.estimated
      }
    }
  ]);
};

// ── Targets ──────────────────────────────────────────────────────────────────

/** Lead/support characters (and anyone explicitly requested) whose sheet must be drawn. */
const needsSheet = (c: Character) => c.tier !== 'extra' && c.sheet.status !== 'ready' && !isBusy(c.sheet);

export const pageTargets = (doc: ComicDoc, action: { pageIds?: string[]; force?: boolean }): Page[] => {
  const ids = Array.isArray(action.pageIds) && action.pageIds.length ? new Set(action.pageIds) : null;
  return doc.pages
    .filter((p) => (ids ? ids.has(p.id) : true))
    .filter((p) => p.panels.length > 0 && !isBusy(p.render))
    .filter((p) => action.force || p.render.status !== 'ready' || isPageStale(doc, p))
    .sort((a, b) => a.n - b.n);
};

/** Lead/support cast appearing on these pages that has no usable sheet yet. */
export const missingSheetsFor = (doc: ComicDoc, pages: Page[]): Character[] => {
  const ids = new Set(pages.flatMap((p) => p.panels.flatMap((panel) => panel.castIds)));
  return doc.cast.filter((c) => ids.has(c.id) && needsSheet(c));
};

export const sheetTargets = (
  doc: ComicDoc,
  action: { characterIds?: string[]; force?: boolean }
): { characters: Character[]; places: Place[] } => {
  const ids = Array.isArray(action.characterIds) && action.characterIds.length ? action.characterIds : null;
  if (!ids) return { characters: doc.cast.filter(needsSheet), places: [] };
  const wanted = (r: RenderState) => !isBusy(r) && (action.force || r.status !== 'ready');
  return {
    characters: doc.cast.filter((c) => ids.includes(c.id) && wanted(c.sheet)),
    places: doc.places.filter((p) => ids.includes(p.id) && wanted(p.sheet))
  };
};

// Count what the runner will actually draw: sanitized directions (invalid ones are dropped),
// else the default proposal count. Mirrors RenderRun.styleOptions.
const styleDirections = (action: Extract<SpendAction, { type: 'render_style_options' }>) => sanitizeDirections(action.directions);
const styleDirectionCount = (action: Extract<SpendAction, { type: 'render_style_options' }>) =>
  styleDirections(action).length || DEFAULT_STYLE_DIRECTIONS;

/** Registry estimate for a spend action (counts what would actually be drawn now). */
export function estimateSpendAction(doc: ComicDoc, action: SpendAction, byok: boolean): SpendEstimate {
  const jobs: { kind: ImageJobKind; count: number; label?: string }[] = [];
  switch (action.type) {
    case 'render_style_options':
      jobs.push({ kind: 'style_option', count: styleDirectionCount(action), label: 'style options' });
      break;
    case 'render_sheets': {
      const { characters, places } = sheetTargets(doc, action);
      jobs.push({ kind: 'sheet', count: characters.length, label: 'character sheets' });
      jobs.push({ kind: 'place', count: places.length, label: 'location sheets' });
      break;
    }
    case 'render_pages': {
      const pages = pageTargets(doc, action);
      jobs.push({ kind: 'page', count: pages.length, label: 'pages' });
      jobs.push({ kind: 'sheet', count: missingSheetsFor(doc, pages).length, label: 'character sheets' });
      break;
    }
    case 'edit_page':
      jobs.push({ kind: 'edit', count: 1, label: 'page edit' });
      break;
    case 'render_cover':
      jobs.push({ kind: 'cover', count: 1, label: 'cover' });
      break;
    default:
      break;
  }
  const est = estimateJobs(jobs, doc.settings.quality, { override: doc.settings.imageModelOverride, byok });
  // When no directions are passed the runner also makes a writer call to propose them; the
  // image-only estimate would understate the quote and the budget gate. Add that text line.
  if (action.type === 'render_style_options' && !styleDirections(action).length) {
    const usd = round4(STYLE_DIRECTIONS_USD * (byok ? 1 : PLATFORM_MARKUP));
    return { ...est, usd: round4(est.usd + usd), lines: [...est.lines, { label: 'style directions', count: 1, usd }] };
  }
  return est;
}

const budgetOf = (settings: Settings): number | undefined =>
  typeof settings.budgetUsd === 'number' && Number.isFinite(settings.budgetUsd) && settings.budgetUsd > 0 ? settings.budgetUsd : undefined;

/**
 * Whether a spend must wait for the user. 'budget' when it would push the project past
 * its budget cap (even when confirmed, unless the user approved going over), else
 * 'policy' per the confirm setting when the spend is not already confirmed.
 */
export function gateDecision(
  doc: ComicDoc,
  estimate: SpendEstimate,
  confirmed: boolean,
  opts: { budgetApproved?: boolean; pendingUsd?: number; priorUsd?: number } = {}
): null | 'policy' | 'budget' {
  const budget = budgetOf(doc.settings);
  if (budget !== undefined && !opts.budgetApproved && round4(doc.spend.totalUsd + (opts.pendingUsd || 0) + estimate.usd) > budget + 1e-9) return 'budget';
  if (confirmed) return null;
  switch (doc.settings.confirm) {
    case 'always':
      return 'policy';
    case 'never':
      return null;
    case 'big':
    default:
      // 'big' weighs this spend against what the same director turn has already started
      // (priorUsd), so many individually-small spends can't add up past the threshold unseen.
      return round4((opts.priorUsd || 0) + estimate.usd) > (Number.isFinite(doc.settings.bigSpendUsd) ? doc.settings.bigSpendUsd : 0.5) ? 'policy' : null;
  }
}

// ── Run options & outcomes ───────────────────────────────────────────────────

export interface RunActionOptions {
  /** The user explicitly asked for this spend (a UI click or an approved gate). */
  confirmed: boolean;
  /** Pro-tier spend is not allowed for this user; the message explains why. */
  qualityDenied?: string;
  /** Approving a budget gate lets this one action go over the budget. */
  budgetApproved?: boolean;
  /** USD this director turn has already started without approval (for the per-turn 'big' gate). */
  priorUsd?: number;
  /** Cards meant for the conversation go here (director turns) instead of a new message. */
  collectCard?: (card: Card) => void;
  // ── v5 (contract §12.3; optional until P1-JOBS makes caps/origin required) ──
  /** What this user may do; replaces qualityDenied (kept as derived user text). Absent ⇒ ctx.caps ⇒ DEFAULT_CAPS. */
  caps?: StudioCaps;
  /** Director turns: next steps for the director's message. */
  collectNextSteps?: (steps: NextStep[]) => void;
  /** Force a gate even below bigSpendUsd (drawIntent 'none', first_render, plan_review, redraw). */
  forceGate?: Gate['reason'];
  /** Ops origin for session.commit (undo + "saved by software" attribution). */
  origin?: OpsOrigin;
}

export type ActionOutcome =
  | { status: 'done'; message: string; nextSteps?: NextStep[] }
  | { status: 'started'; message: string; estimate: SpendEstimate }
  | { status: 'gated'; message: string; gate: Gate }
  | { status: 'blocked'; message: string; code?: StudioErrorCode }
  /** Everything requested is already ready and fresh ($0). */
  | { status: 'nothing'; message: string; nextSteps: NextStep[] };

export interface StartedAction {
  outcome: ActionOutcome;
  /** Settles when the background work (renders, QC) is finished. Never rejects. */
  done: Promise<void>;
}

const finished = (outcome: ActionOutcome): StartedAction => ({ outcome, done: Promise.resolve() });

/** Deliver conversation cards: into the director's message when collecting, else as a new assistant message. */
const deliver = (ctx: StudioContext, opts: RunActionOptions, text: string, cards: Card[], suggestions?: string[]) => {
  if (opts.collectCard) {
    cards.forEach((c) => opts.collectCard!(c));
    return;
  }
  ctx.session.commit([{ op: 'message', msg: assistantMessage(text, cards, suggestions) }]);
};

const blocked = (ctx: StudioContext, opts: RunActionOptions, message: string, tone: 'info' | 'warn' | 'error' = 'warn', suggestions?: string[]) => {
  deliver(ctx, opts, message, [noticeCard(tone, message)], suggestions);
  return finished({ status: 'blocked', message });
};

// ── Public entry points ──────────────────────────────────────────────────────

/** Run an action to completion (renders included). Errors that prevent the action throw StudioError. */
export async function runAction(ctx: StudioContext, action: StudioAction, opts: RunActionOptions): Promise<void> {
  const started = await startAction(ctx, action, opts);
  await started.done;
}

/**
 * Validate, gate and start an action. Doc-only actions complete before this resolves;
 * spend actions resolve once they are gated/blocked or their targets are queued, with
 * `done` settling when the renders finish.
 */
export async function startAction(ctx: StudioContext, action: StudioAction, opts: RunActionOptions): Promise<StartedAction> {
  if (!action || typeof action !== 'object' || typeof (action as { type?: unknown }).type !== 'string') {
    throw badRequest('Unknown action.');
  }
  // Feature actions (contract §12.1) go through the registry; core types never do.
  const handler = actionHandlerFor(action.type);
  if (handler) return runFeatureAction(ctx, handler, action, opts);
  if (isSpendAction(action)) return startSpend(ctx, action, opts);
  switch (action.type) {
    case 'approve_gate':
      return approveGate(ctx, action.gateId, opts);
    case 'decline_gate':
      return finished(declineGate(ctx, action.gateId));
    case 'pick_style':
      return finished(pickStyle(ctx, action.optionId));
    case 'plan_pages':
      return finished(await planPages(ctx, { instructions: action.instructions }, opts));
    case 'approve_plan':
      return finished(approvePlan(ctx));
    case 'patch':
      return finished(applyPatch(ctx, action.ops, opts));
    case 'restore_render':
      return finished(restoreRender(ctx, action.target, action.path));
    case 'relayout_balloons':
      return finished(await relayoutBalloons(ctx, action.pageId));
    case 'cancel':
      ctx.session.abort.abort();
      return finished({ status: 'done', message: 'Stopped. Anything already drawing will finish and be kept.' });
    default:
      throw badRequest(`Unknown action "${(action as { type: string }).type}".`);
  }
}

/**
 * Run a registered feature action. Wave 0 calls the handler directly; P1-JOBS routes
 * `spend: true` handlers (translate) through estimate → gateDecision → run like startSpend.
 */
async function runFeatureAction(ctx: StudioContext, handler: ActionHandler, action: StudioAction, opts: RunActionOptions): Promise<StartedAction> {
  return handler.run(ctx, action, opts);
}

/** Who is patching, for the feature sanitizers (§12.1 SanitizeCtx). */
export const sanitizeCtxFor = (ctx: StudioContext, opts: Pick<RunActionOptions, 'caps'> = {}): SanitizeCtx => {
  const caps = opts.caps ?? ctx.caps ?? DEFAULT_CAPS;
  return {
    userId: ctx.userId,
    caps,
    rating: ctx.rating ?? effectiveRating(ctx.session.doc, caps.ratingCeiling).rating,
    now: Date.now()
  };
};

// ── Gates ────────────────────────────────────────────────────────────────────

async function approveGate(ctx: StudioContext, gateId: string, opts: RunActionOptions): Promise<StartedAction> {
  const gate = ctx.session.doc.gate;
  if (!gate || gate.id !== gateId || gate.status !== 'open') {
    throw new StudioError('BAD_REQUEST', 'That approval is no longer open — ask again to get a fresh estimate.', { status: 409 });
  }
  if (!isSpendAction(gate.action)) throw badRequest('That approval has nothing to run.');
  const doc = ctx.session.doc;
  const estimate = estimateSpendAction(doc, gate.action, spendIsByok(ctx.keys));
  const { nickname } = modelLabel(doc, describeSpend(doc, gate.action).kind);
  if (!gateStillHolds(gate, estimate, nickname)) {
    // The plan, quality or model changed since the card was shown: never run a bigger
    // or different spend on an old approval — re-quote instead.
    ctx.session.commit([{ op: 'gate', gate: { ...gate, status: 'declined' } }]);
    return startSpend(ctx, gate.action, { ...opts, confirmed: false, budgetApproved: false });
  }
  // Commit 'approved' first (before startSpend, so a same-kind open gate isn't flipped to
  // 'declined' at startSpend:L749), then put the card back if the spend never started —
  // so it never claims "drawing now" when a busy page / missing key / invalid-now blocked it.
  ctx.session.commit([{ op: 'gate', gate: { ...gate, status: 'approved' } }]);
  const reopen = () => {
    const cur = ctx.session.doc.gate;
    if (cur?.id === gate.id && cur.status === 'approved') ctx.session.commit([{ op: 'gate', gate: { ...cur, status: 'open' } }]);
  };
  try {
    const started = await startSpend(ctx, gate.action, { ...opts, confirmed: true, budgetApproved: gate.reason === 'budget' || opts.budgetApproved });
    if (started.outcome.status === 'blocked') reopen();
    return started;
  } catch (err) {
    reopen();
    throw err;
  }
}

function declineGate(ctx: StudioContext, gateId: string): ActionOutcome {
  const gate = ctx.session.doc.gate;
  if (!gate || gate.id !== gateId) throw new StudioError('BAD_REQUEST', 'That approval is no longer open.', { status: 409 });
  if (gate.status === 'open') ctx.session.commit([{ op: 'gate', gate: { ...gate, status: 'declined' } }]);
  return { status: 'done', message: 'Declined — nothing was spent.' };
}

interface SpendPlan {
  /** What will be drawn, for titles and summaries ("6 pages + 2 character sheets"). */
  what: string;
  title: string;
  /** Primary image kind (quality access + model naming). */
  kind: ImageJobKind;
}

const describeSpend = (doc: ComicDoc, action: SpendAction): SpendPlan => {
  switch (action.type) {
    case 'render_style_options': {
      const n = styleDirectionCount(action);
      return { what: plural(n, 'style option'), title: `Draw ${plural(n, 'style option')}?`, kind: 'style_option' };
    }
    case 'render_sheets': {
      const { characters, places } = sheetTargets(doc, action);
      const parts = [characters.length ? plural(characters.length, 'character sheet') : '', places.length ? plural(places.length, 'location sheet') : ''].filter(Boolean);
      return { what: parts.join(' + ') || 'sheets', title: `Draw ${parts.join(' + ') || 'sheets'}?`, kind: 'sheet' };
    }
    case 'render_pages': {
      const pages = pageTargets(doc, action);
      const sheets = missingSheetsFor(doc, pages).length;
      const pageText = pages.length === 1 ? `page ${pages[0].n}` : plural(pages.length, 'page');
      const what = sheets ? `${pageText} + ${plural(sheets, 'character sheet')}` : pageText;
      return { what, title: `Draw ${pageText}?`, kind: 'page' };
    }
    case 'edit_page': {
      const page = findPage(doc, action.pageId);
      return { what: `an edit of page ${page?.n ?? '?'}`, title: `Edit page ${page?.n ?? '?'}?`, kind: 'edit' };
    }
    case 'render_cover':
      return { what: 'the cover', title: 'Draw the cover?', kind: 'cover' };
    default:
      return { what: 'images', title: 'Spend?', kind: 'page' };
  }
};

const modelLabel = (doc: ComicDoc, kind: ImageJobKind) => {
  const { spec, resolution } = resolveImageJob(kind, doc.settings.quality, doc.settings.imageModelOverride);
  return { nickname: spec.nickname, resolution, spec };
};

/**
 * Pin an open-ended spend action to the work it would do right now, so approving its
 * gate later runs exactly what the card quoted — not whatever the plan grew into since.
 */
export const bindSpendAction = (doc: ComicDoc, action: SpendAction): SpendAction => {
  switch (action.type) {
    case 'render_pages':
      return action.pageIds?.length ? action : { ...action, pageIds: pageTargets(doc, action).map((p) => p.id) };
    case 'render_sheets': {
      if (action.characterIds?.length) return action;
      const { characters, places } = sheetTargets(doc, action);
      return { ...action, characterIds: [...characters.map((c) => c.id), ...places.map((p) => p.id)] };
    }
    default:
      return action;
  }
};

/** A gate's quote is still honest when the work, model and price have not grown. */
const gateStillHolds = (gate: Gate, estimate: SpendEstimate, nickname: string): boolean =>
  estimate.imageCount <= gate.imageCount && estimate.usd <= gate.estimateUsd * 1.15 + 0.01 && nickname === gate.model;

function createGate(ctx: StudioContext, rawAction: SpendAction, estimate: SpendEstimate, reason: 'policy' | 'budget', opts: RunActionOptions): StartedAction {
  const doc = ctx.session.doc;
  const action = bindSpendAction(doc, rawAction);
  const plan = describeSpend(doc, action);
  const { nickname, resolution } = modelLabel(doc, plan.kind);
  const budget = budgetOf(doc.settings);
  const after = round4(doc.spend.totalUsd + pendingUsdOf(ctx.session) + estimate.usd);
  const summary =
    `${plan.what} on ${nickname} (${resolution}) · ≈ ${formatUsd(estimate.usd)}` +
    (reason === 'budget' && budget !== undefined
      ? `. That would bring this comic to ${formatUsd(after)} — over your ${formatUsd(budget)} budget.`
      : '.');
  const gate: Gate = {
    id: newId('gate'),
    action,
    title: plan.title,
    summary,
    estimateUsd: estimate.usd,
    imageCount: estimate.imageCount,
    model: nickname,
    createdAt: Date.now(),
    status: 'open',
    reason
  };
  const card: Card = { type: 'gate', id: newId('card'), gateId: gate.id };
  ctx.session.commit([{ op: 'gate', gate }]);
  const text =
    reason === 'budget'
      ? `This would go over your budget: ≈ ${formatUsd(estimate.usd)} for ${plan.what}. Approve to go over, or raise the budget.`
      : `Ready when you are: ≈ ${formatUsd(estimate.usd)} for ${plan.what} on ${nickname}.`;
  deliver(ctx, opts, text, [card]);
  const message =
    reason === 'budget'
      ? `Over budget: ${plan.what} (≈ ${formatUsd(estimate.usd)}) would take the comic to ${formatUsd(after)} (budget ${formatUsd(budget || 0)}). Waiting for the user to approve or raise the budget.`
      : `Waiting for the user to approve ~${formatUsd(estimate.usd)} (${plan.what} on ${nickname}).`;
  return finished({ status: 'gated', message, gate });
}

// ── Spend actions ────────────────────────────────────────────────────────────

const validateSpendAction = (doc: ComicDoc, action: SpendAction): string | null => {
  switch (action.type) {
    case 'render_pages':
      if (!doc.pages.length) return 'There is no page plan yet — plan the pages first, then draw them.';
      return null;
    case 'render_style_options':
      // A second batch would replace options that are still being paid for.
      if (doc.style.options.some((o) => isBusy(o.render))) return 'Style options are still drawing — pick one when they land, then ask for more if none fits.';
      return null;
    case 'render_cover':
      if (isBusy(doc.cover.render)) return 'The cover is already drawing.';
      return null;
    case 'edit_page': {
      const page = findPage(doc, action.pageId);
      if (!page) throw badRequest('That page is no longer in the plan.');
      if (isBusy(page.render)) throw new StudioError('BAD_REQUEST', `Page ${page.n} is still drawing — edit it when it's done.`, { status: 409 });
      if (page.render.status !== 'ready' || !page.render.asset?.path) throw badRequest(`Page ${page.n} has no image to edit yet — draw it first.`);
      if (!clean(action.instruction, 2000)) throw badRequest('Say what to change on the page.');
      return null;
    }
    default:
      return null;
  }
};

const nothingToDo = (action: SpendAction): string => {
  switch (action.type) {
    case 'render_pages':
      return 'Every page is already drawn and up to date. Ask to redraw a specific page if you want another take.';
    case 'render_sheets':
      return 'All character sheets are already drawn.';
    default:
      return 'Nothing to draw right now.';
  }
};

async function startSpend(ctx: StudioContext, action: SpendAction, opts: RunActionOptions): Promise<StartedAction> {
  const doc = ctx.session.doc;
  const problem = validateSpendAction(doc, action);
  if (problem) return blocked(ctx, opts, problem, 'info');

  const plan = describeSpend(doc, action);
  const { spec } = modelLabel(doc, plan.kind);
  if (!ctx.keys.openrouter?.key && !ctx.keys.gemini?.key) {
    return blocked(ctx, opts, 'Connect a Gemini or OpenRouter key in Settings → API keys to draw images.', 'error');
  }
  if (!imageRouteFor(spec, ctx.keys)) {
    return blocked(ctx, opts, `${spec.nickname} needs ${spec.routes.openrouter ? 'an OpenRouter' : 'a Gemini'} key. Add one in Settings → API keys.`, 'error');
  }
  const qualityDenied = opts.qualityDenied ?? (ctx as OrchestratorContext).qualityDenied;
  // Anything other than the everyday model (Pro, or an advanced override such as
  // GPT Image / FLUX / Seedream) is a paid-plan feature on the platform key.
  if (qualityDenied && spec.id !== TIER_PRESETS.standard.model) {
    return blocked(ctx, opts, `${qualityDenied} Switch to Standard quality to keep going.`, 'warn', ['Switch to Standard quality']);
  }

  const estimate = estimateSpendAction(doc, action, spendIsByok(ctx.keys));
  if (estimate.imageCount <= 0) return blocked(ctx, opts, nothingToDo(action), 'info');

  const reason = gateDecision(doc, estimate, opts.confirmed, { budgetApproved: opts.budgetApproved, pendingUsd: pendingUsdOf(ctx.session), priorUsd: opts.priorUsd });
  if (reason) return createGate(ctx, action, estimate, reason, opts);

  // Proceeding: retire any open gate for the same kind of spend (it is now moot).
  const open = ctx.session.doc.gate;
  if (open?.status === 'open' && open.action.type === action.type) ctx.session.commit([{ op: 'gate', gate: { ...open, status: 'declined' } }]);

  // Pin the model/quality now so mid-run settings changes can't move this spend off the
  // quoted/authorised price (the latest sheets and pages are still used — see prepare()).
  const pinned: Pick<Settings, 'quality' | 'imageModelOverride'> = { quality: doc.settings.quality, imageModelOverride: doc.settings.imageModelOverride };
  const runner = new RenderRun(ctx, estimate, pinned);
  runner.reserve();
  const message = `Started drawing ${plan.what} (≈ ${formatUsd(estimate.usd)} on ${spec.nickname}). They appear on the board as they finish.`;
  let done: Promise<void>;
  switch (action.type) {
    case 'render_style_options':
      done = runner.styleOptions(action);
      break;
    case 'render_sheets':
      done = runner.sheets(action);
      break;
    case 'render_pages':
      done = runner.pages(action);
      break;
    case 'edit_page':
      done = runner.edit(action);
      break;
    case 'render_cover':
      done = runner.cover();
      break;
    default:
      throw badRequest('Unknown spend action.');
  }
  return { outcome: { status: 'started', message, estimate }, done: done.catch(() => undefined).finally(() => runner.releaseReservation()) };
}

// ── Render run ───────────────────────────────────────────────────────────────

interface ImageJob {
  target: RenderTarget;
  kind: ImageJobKind;
  spend: SpendKind;
  /** Spend/ledger label ("Page 3"). */
  label: string;
  /** Live status line ("Drawing page 3"). */
  activityLabel: string;
  /** Compile against the CURRENT doc (so freshly drawn sheets/pages are used). */
  compile: (doc: ComicDoc) => CompiledImageJob;
  /** Render state before this run touched it (restored on cancel). */
  prev: { status: RenderState['status']; error?: string; hasAsset: boolean };
  /** Failure keeps the previous status (edits: the existing page is still good). */
  keepStatusOnFailure?: boolean;
  region?: Box;
  /** Page specHash to record (pages only). */
  hashPage?: boolean;
  /** Page id to QC + letter after the image lands. */
  qcPageId?: string;
}

interface JobResult {
  job: ImageJob;
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

const restoredStatus = (prev: ImageJob['prev']): RenderState['status'] =>
  prev.status === 'queued' || prev.status === 'rendering' ? (prev.hasAsset ? 'ready' : 'none') : prev.status;

/** Doc copy with the given storage paths removed, so a recompile labels only images we can attach. */
const withoutAssets = (doc: ComicDoc, missing: Set<string>): ComicDoc => {
  const keep = (a?: AssetRef) => (a && !missing.has(a.path) ? a : undefined);
  const render = (r: RenderState): RenderState => (r.asset && missing.has(r.asset.path) ? { ...r, asset: undefined, status: 'none' } : r);
  return {
    ...doc,
    style: { ...doc.style, board: keep(doc.style.board), refs: doc.style.refs.filter((a) => !missing.has(a.path)) },
    cast: doc.cast.map((c) => ({ ...c, refs: c.refs.filter((a) => !missing.has(a.path)), sheet: render(c.sheet) })),
    places: doc.places.map((p) => ({ ...p, refs: p.refs.filter((a) => !missing.has(a.path)), sheet: render(p.sheet) })),
    pages: doc.pages.map((p) => ({ ...p, render: render(p.render) }))
  };
};

/** Best-matching preset for a doc that never chose a style (genre/tone/kind/color fit). */
export const pickDefaultPreset = (doc: ComicDoc): StylePreset => {
  const story = [doc.brief.genre, doc.brief.tone, doc.brief.audience, doc.brief.premise, doc.brief.logline, doc.brief.setting]
    .map((s) => clean(s, 2000).toLowerCase())
    .join(' ');
  const score = (p: StylePreset) => {
    let s = 0;
    if (p.kind && p.kind === doc.format.kind) s += 3;
    for (const tag of p.bestFor) if (story.includes(tag.toLowerCase())) s += 2;
    if (doc.format.colorMode === 'bw') s += p.colorMode === 'bw' ? 3 : -4;
    else if (p.colorMode === 'bw') s -= 3;
    if (doc.format.colorMode === 'limited' && p.colorMode === 'limited') s += 2;
    return s;
  };
  return [...STYLE_PRESETS].sort((a, b) => score(b) - score(a))[0] || STYLE_PRESETS[0];
};

const presetStylePatch = (preset: StylePreset, status: StyleBible['status']): Partial<Omit<StyleBible, 'options'>> => ({
  status,
  name: preset.name,
  spec: preset.spec,
  palette: [...preset.palette],
  linework: preset.linework,
  avoid: [...preset.avoid],
  presetId: preset.id
});

const nearestReadyBefore = (doc: ComicDoc, page: Page): Page | undefined =>
  doc.pages
    .filter((p) => p.n < page.n && p.render.status === 'ready' && p.render.asset?.path)
    .sort((a, b) => b.n - a.n)[0];

class RenderRun {
  private readonly session: StudioSessionApi;
  /** Captured at start: only an explicit cancel stops this run (not a closed tab). */
  private readonly signal: AbortSignal;
  private readonly slots: Semaphore;
  private readonly results: JobResult[] = [];
  private readonly notices: Card[] = [];
  private stopReason: string | null = null;
  private spentUsd = 0;
  /** Estimate still held as pending spend (released as images land or the run ends). */
  private reservedLeft = 0;
  private progressId: string | null = null;
  private progressCard: Extract<Card, { type: 'renders' }> | null = null;
  private readonly started = Date.now();

  constructor(
    private readonly ctx: StudioContext,
    private readonly estimate: SpendEstimate,
    private readonly pinned: Pick<Settings, 'quality' | 'imageModelOverride'>
  ) {
    this.session = ctx.session;
    this.signal = ctx.session.abort.signal;
    this.slots = slotsFor(ctx.session);
  }

  /** Hold this run's estimate as pending spend so a concurrent budget check counts it. */
  reserve() {
    this.reservedLeft = this.estimate.usd;
    addPending(this.session, this.reservedLeft);
  }

  /** Give back whatever estimate never landed (run failed, cancelled, or had no jobs). */
  releaseReservation() {
    if (this.reservedLeft > 0) addPending(this.session, -this.reservedLeft);
    this.reservedLeft = 0;
  }

  // ── Action bodies ─────────────────────────────────────────────────────────

  async pages(action: Extract<SpendAction, { type: 'render_pages' }>): Promise<void> {
    const doc = this.session.doc;
    const pages = pageTargets(doc, action);
    const sheets = missingSheetsFor(doc, pages);
    const sheetJobs = sheets.map((c) => this.sheetJob(c));
    const pageJobs = pages.map((p) => this.pageJob(p));
    await this.run([...sheetJobs, ...pageJobs], `Drawing ${pages.length === 1 ? `page ${pages[0].n}` : plural(pages.length, 'page')}`, async () => {
      this.ensureStyle();
      if (this.session.doc.planStatus === 'draft') this.session.commit([{ op: 'plan_status', status: 'approved' }]);
      // Sheets first: every page uses them as identity anchors.
      await Promise.all(sheetJobs.map((j) => this.runJob(j)));
      // Page 1 alone: the continuity anchor for the rest.
      const [first, ...rest] = pageJobs;
      if (first) await this.runJob(first);
      await Promise.all(rest.map((j) => this.runJob(j)));
    });
  }

  async sheets(action: Extract<SpendAction, { type: 'render_sheets' }>): Promise<void> {
    const { characters, places } = sheetTargets(this.session.doc, action);
    const jobs = [...characters.map((c) => this.sheetJob(c)), ...places.map((p) => this.placeJob(p))];
    await this.run(jobs, `Drawing ${plural(jobs.length, 'sheet')}`, async () => {
      this.ensureStyle();
      await Promise.all(jobs.map((j) => this.runJob(j)));
    });
  }

  async edit(action: Extract<SpendAction, { type: 'edit_page' }>): Promise<void> {
    const page = findPage(this.session.doc, action.pageId)!;
    const job = this.editJob(page, action);
    await this.run([job], `Editing page ${page.n}`, async () => {
      await this.runJob(job);
    });
  }

  async cover(): Promise<void> {
    const job: ImageJob = {
      target: { kind: 'cover' },
      kind: 'cover',
      spend: 'cover',
      label: 'Cover',
      activityLabel: 'Drawing the cover',
      compile: (doc) => compileCover(doc),
      prev: this.prevOf({ kind: 'cover' })
    };
    await this.run([job], 'Drawing the cover', async () => {
      this.ensureStyle();
      await this.runJob(job);
    });
  }

  async styleOptions(action: Extract<SpendAction, { type: 'render_style_options' }>): Promise<void> {
    const end = activity(this.ctx, 'Finding style directions');
    let directions: { name: string; spec: string }[];
    try {
      directions = sanitizeDirections(action.directions);
      if (!directions.length) {
        const tracker = newTextSpendTracker();
        try {
          const proposed = await proposeStyleDirections({
            doc: this.session.doc,
            llm: billedLlm(this.ctx, { stage: 'style', operation: 'comic.text.writer', tracker }),
            count: DEFAULT_STYLE_DIRECTIONS,
            signal: this.signal
          });
          directions = sanitizeDirections(proposed.options);
        } finally {
          recordTextSpend(this.ctx, tracker, 'style', 'Style directions');
        }
      }
      end(true);
    } catch (err) {
      end(false);
      const error = asStudioError(err);
      if (error.code === 'CANCELLED') return;
      this.post(`I couldn't come up with style directions: ${error.userMessage}`, [noticeCard('error', error.userMessage)]);
      return;
    }
    if (!directions.length) {
      this.post("I couldn't come up with style directions this time — pick a preset in Style instead.", [noticeCard('warn', 'No usable style directions came back.')]);
      return;
    }
    // Another batch committed while we were proposing: never clear options being paid for.
    if (this.session.doc.style.options.some((o) => isBusy(o.render))) {
      this.post(
        'Another set of style options is already drawing — pick from those, then ask for more if none fits.',
        [noticeCard('info', 'Style options are already drawing.')]
      );
      return;
    }
    const at = Date.now();
    // Per-option retry: every requested direction matches an existing not-ready option, so
    // redraw those in place instead of clearing the whole board (and any paid, ready options).
    const existing = this.session.doc.style.options;
    const matched = directions.map((d) => existing.find((o) => o.name === d.name && o.spec === d.spec && o.render.status !== 'ready'));
    const isRetry = matched.every((m): m is NonNullable<typeof m> => !!m) && new Set(matched.map((m) => m!.id)).size === matched.length;
    const options = isRetry
      ? matched.map((m, i) => ({ id: m!.id, name: directions[i].name, spec: directions[i].spec }))
      : directions.map((d) => ({ id: newId('so'), ...d }));
    this.session.commit([
      ...(isRetry ? [] : [{ op: 'style_options_clear' } as DocOp]),
      ...options.map((o): DocOp => ({ op: 'style_option', id: o.id, patch: { name: o.name, spec: o.spec, render: { status: 'none', history: [], updatedAt: at } } }))
    ]);
    const jobs = options.map(
      (o): ImageJob => ({
        target: { kind: 'style_option', id: o.id },
        kind: 'style_option',
        spend: 'style',
        label: `Style: ${o.name}`,
        activityLabel: `Drawing “${o.name}”`,
        compile: (doc) => {
          const option = doc.style.options.find((x) => x.id === o.id);
          if (!option) throw badRequest('That style option was replaced.');
          return compileStyleOption(doc, option);
        },
        prev: { status: 'none', hasAsset: false }
      })
    );
    await this.run(jobs, `Drawing ${plural(jobs.length, 'style option')}`, async () => {
      await Promise.all(jobs.map((j) => this.runJob(j)));
    });
  }

  // ── Job builders ──────────────────────────────────────────────────────────

  private prevOf(target: RenderTarget): ImageJob['prev'] {
    const r = getRender(this.session.doc, target);
    return { status: r?.status || 'none', ...(r?.error ? { error: r.error } : {}), hasAsset: !!r?.asset?.path };
  }

  private sheetJob(c: Character): ImageJob {
    return {
      target: { kind: 'sheet', id: c.id },
      kind: 'sheet',
      spend: 'sheet',
      label: `Sheet: ${c.name}`,
      activityLabel: `Drawing ${c.name}'s sheet`,
      compile: (doc) => {
        const current = findCharacter(doc, c.id);
        if (!current) throw badRequest(`${c.name} is no longer in the cast.`);
        return compileCharacterSheet(doc, current);
      },
      prev: this.prevOf({ kind: 'sheet', id: c.id })
    };
  }

  private placeJob(p: Place): ImageJob {
    return {
      target: { kind: 'place', id: p.id },
      kind: 'place',
      spend: 'sheet',
      label: `Location: ${p.name}`,
      activityLabel: `Drawing ${p.name}`,
      compile: (doc) => {
        const current = findPlace(doc, p.id);
        if (!current) throw badRequest(`${p.name} is no longer a location.`);
        return compilePlaceSheet(doc, current);
      },
      prev: this.prevOf({ kind: 'place', id: p.id })
    };
  }

  private pageJob(p: Page): ImageJob {
    return {
      target: { kind: 'page', id: p.id },
      kind: 'page',
      spend: 'page',
      label: `Page ${p.n}`,
      activityLabel: `Drawing page ${p.n}`,
      compile: (doc) => {
        const page = findPage(doc, p.id);
        if (!page) throw badRequest(`Page ${p.n} is no longer in the plan.`);
        return compilePage(doc, page, { previousPage: nearestReadyBefore(doc, page) });
      },
      prev: this.prevOf({ kind: 'page', id: p.id }),
      hashPage: true,
      qcPageId: p.id
    };
  }

  private editJob(p: Page, action: Extract<SpendAction, { type: 'edit_page' }>): ImageJob {
    const region = sanitizeBox(action.region);
    const panelN = Number.isInteger(action.panelN) && p.panels.some((x) => x.n === action.panelN) ? action.panelN : undefined;
    const instruction = clean(action.instruction, 2000);
    return {
      target: { kind: 'page', id: p.id },
      kind: 'edit',
      spend: 'edit',
      label: `Edit page ${p.n}`,
      activityLabel: `Editing page ${p.n}`,
      compile: (doc) => {
        const page = findPage(doc, p.id);
        if (!page) throw badRequest(`Page ${p.n} is no longer in the plan.`);
        return compileEdit(doc, page, { instruction, ...(panelN !== undefined ? { panelN } : {}), hasRegion: !!region });
      },
      prev: this.prevOf({ kind: 'page', id: p.id }),
      keepStatusOnFailure: true,
      ...(region ? { region } : {}),
      qcPageId: p.id
    };
  }

  // ── Orchestration ─────────────────────────────────────────────────────────

  /**
   * Queue every target, post the progress message, run `body`, then make sure nothing is
   * left queued/rendering and summarize the outcome in the conversation.
   */
  private async run(jobs: ImageJob[], label: string, body: () => Promise<void>): Promise<void> {
    if (!jobs.length) return;
    const at = Date.now();
    this.session.commit(
      jobs.map((j): DocOp => ({ op: 'render', target: j.target, patch: { status: 'queued', error: undefined, updatedAt: at } }))
    );
    this.startProgress(jobs, label);
    const end = activity(this.ctx, label);
    try {
      await body();
    } catch (err) {
      const error = asStudioError(err);
      if (error.code !== 'CANCELLED') this.notices.push(noticeCard('error', error.userMessage));
    } finally {
      this.settleLeftovers(jobs);
      end(this.results.some((r) => r.ok) && !this.results.some((r) => !r.ok && !r.skipped));
      this.finishProgress(jobs);
    }
  }

  private startProgress(jobs: ImageJob[], label: string) {
    this.progressCard = { type: 'renders', id: newId('card'), targets: jobs.map((j) => j.target), label };
    const msg = assistantMessage(`${label} (≈ ${formatUsd(this.estimate.usd)}).`, [this.progressCard]);
    this.progressId = msg.id;
    this.session.commit([{ op: 'message', msg }]);
  }

  /** Background work always posts its own message (a director turn may have ended by now). */
  private post(text: string, cards: Card[]) {
    this.session.commit([{ op: 'message', msg: assistantMessage(text, cards) }]);
  }

  /** Anything still queued/rendering that this run owns goes back to its previous state (or failed). */
  private settleLeftovers(jobs: ImageJob[]) {
    const doc = this.session.doc;
    const ops: DocOp[] = [];
    const at = Date.now();
    for (const job of jobs) {
      // Already settled by this run: any busy state on the target now belongs to another
      // run (e.g. a Retry that queued it). Never write our stale `prev` over it.
      if (this.results.some((r) => r.job === job)) continue;
      const render = getRender(doc, job.target);
      if (!render || !isBusy(render)) continue;
      this.results.push({ job, ok: false, skipped: true });
      ops.push({ op: 'render', target: job.target, patch: { status: restoredStatus(job.prev), error: job.prev.error, updatedAt: at } });
    }
    if (ops.length) this.session.commit(ops);
  }

  private finishProgress(jobs: ImageJob[]) {
    if (!this.progressId) return;
    const ok = this.results.filter((r) => r.ok);
    const failed = this.results.filter((r) => !r.ok && !r.skipped);
    const skipped = this.results.filter((r) => r.skipped);
    const noun = (list: JobResult[]) => describeJobs(list.map((r) => r.job));
    const parts: string[] = [];
    if (ok.length === jobs.length) {
      parts.push(`Done — ${noun(ok)} (${formatUsd(this.spentUsd)}).`);
    } else {
      if (ok.length) parts.push(`Drew ${noun(ok)} (${formatUsd(this.spentUsd)}).`);
      if (failed.length) {
        const first = failed[0];
        parts.push(`${capitalize(noun(failed))} failed${first.error ? ` — ${first.job.label}: ${first.error}` : ''}.`);
      }
      if (skipped.length) {
        parts.push(
          this.stopReason
            ? `Stopped before ${noun(skipped)}: ${this.stopReason}`
            : this.signal.aborted
              ? `Stopped before ${noun(skipped)}.`
              : `${capitalize(noun(skipped))} did not start.`
        );
      }
      if (!ok.length && !failed.length && !skipped.length) parts.push('Nothing was drawn.');
      if (failed.length && !this.stopReason) parts.push('Retry from the board or ask me to try again.');
    }
    const lead = this.progressCard!.targets.every((t) => t.kind === 'style_option') && ok.length
      ? [{ type: 'style_choice', id: newId('card') } as Card]
      : [this.progressCard!];
    const text =
      lead[0].type === 'style_choice'
        ? `Here ${ok.length === 1 ? 'is a direction' : `are ${ok.length} directions`} for the look — tap one to lock it.${failed.length || skipped.length ? ` ${parts.join(' ')}` : ''}`
        : parts.join(' ');
    const current = this.session.doc.conversation.find((m) => m.id === this.progressId);
    const msg: Msg = {
      ...(current || assistantMessage('')),
      id: this.progressId,
      role: 'assistant',
      text,
      cards: [...lead, ...this.notices]
    };
    this.session.commit([{ op: 'message', msg }]);
    logger.info('comic_render_run_finished', {
      projectId: this.ctx.projectId,
      ok: ok.length,
      failed: failed.length,
      skipped: skipped.length,
      usd: this.spentUsd,
      ms: Date.now() - this.started
    });
  }

  private ensureStyle() {
    const doc = this.session.doc;
    if (clean(doc.style.spec)) return;
    const preset = pickDefaultPreset(doc);
    const patch = presetStylePatch(preset, doc.style.status === 'locked' ? 'locked' : 'drafted');
    // Keep anything the user already said the art must avoid.
    patch.avoid = [...new Set([...(doc.style.avoid || []), ...preset.avoid])];
    this.session.commit([{ op: 'style', patch }]);
    this.notices.push(noticeCard('info', `No style was chosen yet, so I used “${preset.name}”. Pick another in Style any time.`));
  }

  // ── One image ─────────────────────────────────────────────────────────────

  private restore(job: ImageJob) {
    const render = getRender(this.session.doc, job.target);
    if (render && isBusy(render)) {
      this.session.commit([
        { op: 'render', target: job.target, patch: { status: restoredStatus(job.prev), error: job.prev.error, updatedAt: Date.now() } }
      ]);
    }
    this.results.push({ job, ok: false, skipped: true });
  }

  private fail(job: ImageJob, message: string, attempts?: number) {
    const status = job.keepStatusOnFailure ? restoredStatus(job.prev) : 'failed';
    this.session.commit([
      {
        op: 'render',
        target: job.target,
        patch: { status, error: message, updatedAt: Date.now(), ...(attempts ? { attempts } : {}) }
      }
    ]);
    this.results.push({ job, ok: false, error: message });
    if (job.keepStatusOnFailure) this.notices.push(noticeCard('error', `${job.label} didn't work: ${message}`));
  }

  private async runJob(job: ImageJob): Promise<void> {
    if (this.stopReason || this.signal.aborted) return this.restore(job);
    let release: (() => void) | null = null;
    try {
      release = await this.slots.acquire(this.signal);
    } catch {
      return this.restore(job);
    }
    try {
      if (this.stopReason || this.signal.aborted) return this.restore(job);
      if (!getRender(this.session.doc, job.target)) {
        this.results.push({ job, ok: false, skipped: true });
        return;
      }
      await this.draw(job);
    } catch (err) {
      const error = asStudioError(err);
      this.fail(job, error.userMessage);
    } finally {
      release?.();
    }
  }

  /** Compile, attach references (dropping any that can't be loaded), bill, draw, save, record. */
  private async draw(job: ImageJob): Promise<void> {
    const { ctx, session } = this;
    session.commit([{ op: 'render', target: job.target, patch: { status: 'rendering', updatedAt: Date.now() } }]);
    const end = activity(ctx, job.activityLabel);

    let prepared: { compiled: CompiledImageJob; references: ImageReference[]; docAtCompile: ComicDoc };
    try {
      prepared = await this.prepare(job);
    } catch (err) {
      end(false);
      return this.fail(job, asStudioError(err).userMessage);
    }
    const { compiled, references, docAtCompile } = prepared;
    const picked = imageRouteFor(compiled.spec, ctx.keys);
    if (!picked) {
      end(false);
      return this.fail(job, `${compiled.spec.nickname} needs an OpenRouter or Gemini key. Add one in Settings → API keys.`);
    }

    const reserved = await ctx.billing.reserve({
      operation: imageOperation[job.kind],
      provider: picked.route,
      model: picked.model,
      stage: job.spend,
      imageUnits: 1,
      resolution: compiled.resolution
    });
    if (reserved.ok === false) {
      end(false);
      // Parallel jobs can be denied together: the first explains, the rest just don't start.
      if (this.stopReason) return this.restore(job);
      this.stopReason = reserved.message;
      this.notices.push(noticeCard('error', reserved.message));
      return this.fail(job, reserved.message);
    }
    const reservation = reserved.reservation;

    let result: ImageResult | undefined;
    let lastError: StudioError | undefined;
    let attempts = 0;
    let failedSpend = 0;
    // A deadline-abort hits a non-streaming request the provider keeps generating (and
    // billing); it is flagged `abandoned` so we settle an estimate instead of releasing.
    let abandonedUsd = 0;
    while (attempts < MAX_IMAGE_ATTEMPTS) {
      attempts += 1;
      try {
        // No abort signal: a call that has started is paid and is always kept.
        result = await ctx.images({
          spec: compiled.spec,
          resolution: compiled.resolution,
          aspect: compiled.aspect,
          prompt: compiled.prompt,
          references
        });
        break;
      } catch (err) {
        lastError = asStudioError(err, 'The image could not be drawn. Please try again.');
        const spent = (err as { spentUsd?: unknown })?.spentUsd;
        if (typeof spent === 'number' && Number.isFinite(spent) && spent > 0) failedSpend += spent;
        if ((err as { abandoned?: boolean })?.abandoned) {
          // Our own deadline fired after dispatch: the provider still bills it, so do not
          // retry (that would pay twice) — bill the registry price and stop.
          abandonedUsd += imagePriceUsd(compiled.spec, compiled.resolution);
          break;
        }
        if (!lastError.retryable || attempts >= MAX_IMAGE_ATTEMPTS || this.signal.aborted || lastError.code === 'CANCELLED') break;
        logger.warn('comic_image_job_retry', { projectId: ctx.projectId, target: renderTargetKey(job.target), code: lastError.code });
        await sleep(JOB_TIMINGS.retryBackoffMs, this.signal);
        if (this.signal.aborted) break;
      }
    }

    if (!result) {
      end(false);
      const owed = round4(failedSpend + abandonedUsd);
      if (owed > 0) {
        await reservation.settle({ costUsd: owed, imageUnits: 0 });
        this.recordImageSpend(job, compiled, owed, abandonedUsd > 0, picked.byok, abandonedUsd > 0 ? ' (timed out)' : ' (failed attempt)');
      } else {
        await reservation.release(lastError?.code || 'image_failed');
      }
      const message = lastError?.code === 'CANCELLED' ? 'Cancelled.' : lastError?.userMessage || 'The image could not be drawn.';
      if (lastError?.code === 'CANCELLED') return this.restore(job);
      return this.fail(job, message, attempts);
    }

    const providerUsd = typeof result.costUsd === 'number' && Number.isFinite(result.costUsd) ? result.costUsd : undefined;
    const imageUsd = providerUsd ?? imagePriceUsd(compiled.spec, compiled.resolution);
    // Earlier paid-but-failed attempts of this same job are billed alongside the image.
    const settleUsd = failedSpend > 0 ? round4(imageUsd + failedSpend) : providerUsd;
    let asset: AssetRef;
    try {
      asset = await this.saveImage(result.dataUrl, compiled.spec.id);
    } catch (err) {
      // Paid but lost: bill it honestly and say so.
      end(false);
      await reservation.settle({ costUsd: settleUsd, imageUnits: 1 });
      if (failedSpend > 0) this.recordImageSpend(job, compiled, failedSpend, false, picked.byok, ' (failed attempt)');
      this.recordImageSpend(job, compiled, imageUsd, providerUsd === undefined, result.byok, ' (not saved)');
      logger.error('comic_image_save_failed', { projectId: ctx.projectId, target: renderTargetKey(job.target), message: (err as Error)?.message });
      return this.fail(job, "The image was drawn but couldn't be saved. Please retry.", attempts);
    }
    await reservation.settle({ costUsd: settleUsd, imageUnits: 1 });
    if (failedSpend > 0) this.recordImageSpend(job, compiled, failedSpend, false, picked.byok, ' (failed attempt)');
    const usd = this.recordImageSpend(job, compiled, imageUsd, providerUsd === undefined, result.byok, '');

    const page = job.hashPage ? findPage(docAtCompile, (job.target as { id: string }).id) : undefined;
    session.commit([
      {
        op: 'render',
        target: job.target,
        patch: {
          status: 'ready',
          asset,
          model: compiled.spec.id,
          resolution: compiled.resolution,
          costUsd: usd,
          attempts,
          updatedAt: Date.now(),
          error: undefined,
          ...(job.qcPageId ? { qc: undefined } : {}),
          ...(page ? { specHash: pageSpecHash(docAtCompile, page) } : {})
        }
      }
    ]);
    this.results.push({ job, ok: true });
    end(true);
    // The image is saved and paid for: nothing after this point may fail the render.
    try {
      await ctx.publishUrls([asset.path]);
      if (job.qcPageId) await this.letterPage(job.qcPageId, result.dataUrl);
    } catch (err) {
      logger.warn('comic_post_render_failed', { projectId: ctx.projectId, target: renderTargetKey(job.target), message: (err as Error)?.message });
    }
  }

  /** Compile with references we can actually load; recompile without any that are missing. */
  private async prepare(job: ImageJob): Promise<{ compiled: CompiledImageJob; references: ImageReference[]; docAtCompile: ComicDoc }> {
    // Use the live doc (freshly drawn sheets/pages) but pin the model/quality to what was
    // quoted and authorised, so a mid-run settings change can't pick a pricier/gated model.
    const live = this.session.doc;
    const docAtCompile: ComicDoc = { ...live, settings: { ...live.settings, quality: this.pinned.quality, imageModelOverride: this.pinned.imageModelOverride } };
    const missing = new Set<string>();
    let regionDataUrl: string | undefined;
    for (let pass = 0; pass < 3; pass += 1) {
      const compiled = job.compile(missing.size ? withoutAssets(docAtCompile, missing) : docAtCompile);
      const references: ImageReference[] = [];
      let dropped = false;
      for (const ref of compiled.references) {
        if (ref.path === '__region__') {
          if (!job.region) continue;
          if (!regionDataUrl) {
            const current = references[0]?.dataUrl;
            if (!current) throw new StudioError('NOT_FOUND', "Couldn't load the page to mark the area.", { status: 404 });
            regionDataUrl = await this.ctx.assets.outlineRegion(current, job.region);
          }
          references.push({ label: ref.label, dataUrl: regionDataUrl });
          continue;
        }
        try {
          references.push({ label: ref.label, dataUrl: await this.ctx.assets.loadDataUrl(ref.path) });
        } catch (err) {
          if (job.kind === 'edit' && references.length === 0) {
            throw new StudioError('NOT_FOUND', "Couldn't load the current page image to edit. Try redrawing the page.", { status: 404, cause: err });
          }
          logger.warn('comic_reference_missing', { projectId: this.ctx.projectId, path: ref.path, label: ref.label, message: (err as Error)?.message });
          missing.add(ref.path);
          dropped = true;
        }
      }
      if (!dropped) return { compiled, references, docAtCompile };
    }
    // Still missing after recompiles: give up on references rather than mislabel them.
    const compiled = job.compile(withoutAssets(docAtCompile, new Set(collectAssetPaths(docAtCompile))));
    return { compiled, references: [], docAtCompile };
  }

  private async saveImage(dataUrl: string, model: string): Promise<AssetRef> {
    const args = { userId: this.ctx.userId, projectId: this.ctx.projectId, dataUrl, model };
    try {
      return await this.ctx.assets.saveGenerated(args);
    } catch (err) {
      logger.warn('comic_image_save_retry', { projectId: this.ctx.projectId, message: (err as Error)?.message });
      await sleep(JOB_TIMINGS.saveRetryMs);
      return this.ctx.assets.saveGenerated(args);
    }
  }

  /** Commit a spend entry for one image call; returns the charged USD. */
  private recordImageSpend(job: ImageJob, compiled: CompiledImageJob, providerUsd: number, estimated: boolean, byok: boolean, suffix: string): number {
    const usd = chargedUsd(providerUsd, byok);
    this.spentUsd = round4(this.spentUsd + usd);
    // Move this amount out of the pending reservation in the same tick it is committed.
    const settled = Math.min(usd, this.reservedLeft);
    if (settled > 0) {
      this.reservedLeft = round4(this.reservedLeft - settled);
      addPending(this.session, -settled);
    }
    this.session.commit([
      {
        op: 'spend',
        entry: { id: newId('sp'), at: Date.now(), kind: job.spend, label: `${job.label}${suffix}`, usd, model: compiled.spec.id, byok, estimated }
      }
    ]);
    return usd;
  }

  /** Vision QC + balloon layout for a freshly drawn page (fail-soft to the layout fallback). */
  private async letterPage(pageId: string, dataUrl: string): Promise<void> {
    await letterPage(this.ctx, pageId, dataUrl, this.signal, (card) => this.notices.push(card));
  }
}

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const describeJobs = (jobs: ImageJob[]): string => {
  const count = (kind: ImageJobKind | ImageJobKind[]) => jobs.filter((j) => (Array.isArray(kind) ? kind.includes(j.kind) : j.kind === kind)).length;
  const pages = jobs.filter((j) => j.kind === 'page');
  const parts = [
    pages.length === 1 ? pages[0].label.toLowerCase() : pages.length ? plural(pages.length, 'page') : '',
    count('edit') ? (count('edit') === 1 ? jobs.find((j) => j.kind === 'edit')!.label.toLowerCase().replace(/^edit /, 'the edit of ') : plural(count('edit'), 'edit')) : '',
    count(['sheet', 'place']) ? plural(count(['sheet', 'place']), 'sheet') : '',
    count('style_option') ? plural(count('style_option'), 'style option') : '',
    count('cover') ? 'the cover' : ''
  ].filter(Boolean);
  return parts.join(', ') || 'nothing';
};

const mergeBalloons = (page: Page, fresh: Balloon[], overlay: boolean): Balloon[] => {
  if (!overlay) return [];
  const lineIds = new Set(page.panels.flatMap((p) => p.lines.map((l) => l.id)));
  const pinned = page.balloons.filter((b) => b.pinned && lineIds.has(b.lineId));
  const pinnedIds = new Set(pinned.map((b) => b.lineId));
  const seen = new Set<string>();
  const out: Balloon[] = [...pinned];
  for (const b of fresh) {
    if (!lineIds.has(b.lineId) || pinnedIds.has(b.lineId) || seen.has(b.lineId)) continue;
    seen.add(b.lineId);
    out.push(b);
  }
  return out;
};

/**
 * Run the vision pass on a page image and commit its QC report + balloons. Never throws:
 * without vision (no key, billing denied, provider error, cancelled) balloons are laid
 * out from the panel blueprint.
 */
export async function letterPage(
  ctx: StudioContext,
  pageId: string,
  dataUrl: string | null,
  signal: AbortSignal,
  onNotice: (card: Card) => void
): Promise<void> {
  const doc = ctx.session.doc;
  const page = findPage(doc, pageId);
  if (!page) return;
  const overlay = doc.format.lettering !== 'in_art';
  const layout = { readingDirection: doc.format.readingDirection, kind: doc.format.kind } as const;
  let qc: QcReport | undefined;
  let balloons: Balloon[] | undefined;
  if (dataUrl && !signal.aborted) {
    const end = activity(ctx, `Checking page ${page.n}`);
    const tracker = newTextSpendTracker();
    try {
      const analysis = await analyzePageRender({
        doc,
        page,
        dataUrl,
        llm: billedLlm(ctx, { stage: 'qc', operation: 'comic.text.vision', tracker }),
        signal
      });
      qc = analysis.qc;
      balloons = analysis.balloons;
      end(true);
    } catch (err) {
      end(false);
      const error = asStudioError(err);
      if (error.code !== 'CANCELLED') logger.warn('comic_page_qc_failed', { projectId: ctx.projectId, pageId, code: error.code, message: error.message });
    } finally {
      if (tracker.calls && !tracker.usd && tracker.estimated) tracker.usd = chargedUsd(QC_USD_PER_PAGE, tracker.byok);
      recordTextSpend(ctx, tracker, 'qc', `Check page ${page.n}`);
    }
  }
  // Re-read: lines may have been edited while the check ran.
  const current = findPage(ctx.session.doc, pageId);
  if (!current) return;
  if (!balloons) balloons = overlay ? fallbackBalloons(current, qc?.panelBoxes || estimatePanelBoxes(current, layout), layout) : [];
  const ops: DocOp[] = [{ op: 'balloons', pageId, balloons: mergeBalloons(current, balloons, overlay) }];
  if (qc) ops.unshift({ op: 'render', target: { kind: 'page', id: pageId }, patch: { qc } });
  ctx.session.commit(ops);
  if (qc && qc.score < LOW_QC_SCORE) {
    const issues = qc.issues.slice(0, 3).join(' ');
    onNotice(
      noticeCard(
        'warn',
        `Page ${current.n} may need another pass${issues ? `: ${issues}` : '.'} Say “redraw page ${current.n}” for a new take, or open it to fix one panel.`
      )
    );
  }
}

// ── Doc-only actions ─────────────────────────────────────────────────────────

const sanitizeDirections = (raw: unknown): { name: string; spec: string }[] =>
  (Array.isArray(raw) ? raw : [])
    .filter(isObject)
    .map((d) => ({ name: clean(d.name, 60), spec: clean(d.spec, 1500) }))
    .filter((d) => d.name && d.spec)
    .slice(0, MAX_STYLE_DIRECTIONS);

const sanitizeBox = (raw: unknown): Box | undefined => {
  if (!isObject(raw)) return undefined;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : Number.NaN);
  const x = n(raw.x);
  const y = n(raw.y);
  let w = n(raw.w);
  let h = n(raw.h);
  if ([x, y, w, h].some(Number.isNaN)) return undefined;
  w = Math.min(w, 1 - x);
  h = Math.min(h, 1 - y);
  if (w < 0.01 || h < 0.01) return undefined;
  return { x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
};

function pickStyle(ctx: StudioContext, optionId: string): ActionOutcome {
  const doc = ctx.session.doc;
  const option = doc.style.options.find((o) => o.id === optionId);
  if (!option) throw badRequest('That style option is no longer available.');
  if (isBusy(option.render)) throw new StudioError('BAD_REQUEST', `“${option.name}” is still drawing — pick it when it's done.`, { status: 409 });
  const board = option.render.status === 'ready' ? option.render.asset : undefined;
  ctx.session.commit([
    {
      op: 'style',
      patch: { status: 'locked', name: option.name, spec: option.spec, board, presetId: undefined, palette: undefined, linework: undefined }
    }
  ]);
  ctx.session.commit([
    {
      op: 'message',
      msg: assistantMessage(`Locked “${option.name}”. Every sheet and page now follows it.`, undefined, suggestNextSteps(ctx.session.doc))
    }
  ]);
  return { status: 'done', message: `Locked the style “${option.name}”.` };
}

function approvePlan(ctx: StudioContext): ActionOutcome {
  const doc = ctx.session.doc;
  if (!doc.pages.length) throw badRequest('There is no page plan to approve yet.');
  if (doc.planStatus !== 'approved') ctx.session.commit([{ op: 'plan_status', status: 'approved' }]);
  return { status: 'done', message: 'Plan approved.' };
}

/**
 * Write (or revise) the page plan with the writer model. A full plan reuses existing page
 * ids by position so drawn pages are kept (shown as out of date), never wiped; a revision
 * rewrites only `pageIds`. New cast the writer introduced is added first.
 */
export async function planPages(
  ctx: StudioContext,
  args: { instructions?: string; pageIds?: string[] },
  opts: Pick<RunActionOptions, 'collectCard'> = {}
): Promise<ActionOutcome> {
  const signal = ctx.session.abort.signal;
  const revising = Array.isArray(args.pageIds) && args.pageIds.length > 0;
  const tracker = newTextSpendTracker();
  const end = activity(ctx, revising ? 'Rewriting pages' : 'Writing the page plan');
  let result: Awaited<ReturnType<typeof writePagePlan>>;
  try {
    result = await writePagePlan({
      doc: ctx.session.doc,
      llm: billedLlm(ctx, { stage: 'plan', operation: 'comic.text.writer', tracker }),
      ...(clean(args.instructions, 8000) ? { instructions: clean(args.instructions, 8000) } : {}),
      ...(revising ? { pageIds: args.pageIds } : {}),
      signal
    });
    end(true);
  } catch (err) {
    end(false);
    throw asStudioError(err);
  } finally {
    recordTextSpend(ctx, tracker, 'plan', revising ? 'Revise pages' : 'Page plan');
  }

  const doc = ctx.session.doc;
  const ops: DocOp[] = [];
  for (const c of result.newCast) {
    if (findCharacter(doc, c.id)) continue;
    ops.push({ op: 'character', id: c.id, patch: { ...c, sheet: c.sheet || emptyRender(), refs: c.refs || [] } });
  }
  let pages: Page[];
  if (revising) {
    pages = mergeRevisedPages(doc.pages, result.pages);
  } else {
    const old = [...doc.pages].sort((a, b) => a.n - b.n);
    const fresh = [...result.pages].sort((a, b) => a.n - b.n);
    // Keep page identity by position so existing renders survive as "out of date".
    const reassigned = fresh.map((p, i) => (old[i] ? { ...p, id: old[i].id } : p));
    const merged = mergeRevisedPages(old.slice(0, reassigned.length), reassigned);
    pages = [...merged, ...reassigned.slice(merged.length)];
  }
  ops.push({ op: 'pages', pages });
  if (!revising || doc.planStatus === 'none') ops.push({ op: 'plan_status', status: 'draft' });
  ctx.session.commit(ops);

  const after = ctx.session.doc;
  const headline = planHeadline(after, revising ? args.pageIds : undefined);
  const card: Card = { type: 'plan', id: newId('card') };
  const text = revising
    ? `Rewrote ${plural(result.pages.length, 'page')}. Drawn pages that changed show as out of date until you redraw them.`
    : `Here's the plan: ${plural(after.pages.length, 'page')}${result.newCast.length ? `, plus ${plural(result.newCast.length, 'new character')}` : ''}. Read it on the board — edit anything, then draw the pages.`;
  if (opts.collectCard) opts.collectCard(card);
  else ctx.session.commit([{ op: 'message', msg: assistantMessage(text, [card], suggestNextSteps(after)) }]);
  return { status: 'done', message: headline };
}

/** "Planned 6 pages: 1. Maya arrives (4 panels) · 2. …" — the tool result the director reads. */
export const planHeadline = (doc: ComicDoc, onlyIds?: string[]): string => {
  const pages = doc.pages.filter((p) => !onlyIds || onlyIds.includes(p.id));
  const lines = pages.slice(0, 40).map((p) => `${p.n}. ${clean(p.summary, 140) || '(no summary)'} (${plural(p.panels.length, 'panel')})`);
  return `${onlyIds ? 'Revised' : 'Planned'} ${plural(pages.length, 'page')}: ${lines.join(' · ')}`;
};

function restoreRender(ctx: StudioContext, target: RenderTarget, path: string): ActionOutcome {
  const doc = ctx.session.doc;
  if (!isObject(target) || typeof (target as { kind?: unknown }).kind !== 'string') throw badRequest('Unknown render target.');
  const render = getRender(doc, target);
  if (!render) throw badRequest('That image no longer exists.');
  if (isBusy(render)) throw new StudioError('BAD_REQUEST', 'Wait for the current drawing to finish before restoring a version.', { status: 409 });
  if (render.asset?.path === path) return { status: 'done', message: 'That version is already current.' };
  const version = render.history.find((a) => a.path === path);
  if (!version) throw badRequest("That version isn't in this image's history.");
  // v5 contract: restore_render is a compatibility action that commits `render_use` (history versions now carry
  // their own VersionMeta, which render_use lifts onto the render; versions without meta come back without qc/specHash).
  ctx.session.commit([{ op: 'render_use', target, path, at: Date.now() }]);
  void ctx.publishUrls([version.path]);
  return { status: 'done', message: 'Restored that version.' };
}

async function relayoutBalloons(ctx: StudioContext, pageId: string): Promise<ActionOutcome> {
  const doc = ctx.session.doc;
  const page = findPage(doc, pageId);
  if (!page) throw badRequest('That page is no longer in the plan.');
  const path = page.render.status === 'ready' ? page.render.asset?.path : undefined;
  let dataUrl: string | null = null;
  if (path && (ctx.keys.openrouter?.key || ctx.keys.gemini?.key)) {
    dataUrl = await ctx.assets.loadDataUrl(path).catch((err) => {
      logger.warn('comic_relayout_load_failed', { projectId: ctx.projectId, pageId, message: (err as Error)?.message });
      return null;
    });
  }
  // A low score here is already visible on the page's QC report; no extra message.
  await letterPage(ctx, pageId, dataUrl, ctx.session.abort.signal, () => undefined);
  return { status: 'done', message: `Re-laid out the balloons on page ${page.n}.` };
}

// ── Patch validation ─────────────────────────────────────────────────────────

const str = (v: unknown, max = TEXT_LIMIT): string | undefined => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
const strList = (v: unknown, maxItems = 40, max = 400): string[] | undefined =>
  Array.isArray(v) ? v.map((x) => str(x, max)).filter((x): x is string => !!x).slice(0, maxItems) : undefined;
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined);
const num = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;

/** Copy only the listed keys whose sanitizer accepts the value; throws when a present key is invalid. */
const pick = (raw: unknown, spec: Record<string, (v: unknown) => unknown>, what: string): Record<string, unknown> => {
  if (!isObject(raw)) throw badRequest(`Invalid ${what}.`);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const fn = spec[key];
    if (!fn) continue;
    if (value === undefined) continue;
    const v = fn(value);
    if (v === undefined) throw badRequest(`Invalid ${what}: ${key}.`);
    out[key] = v;
  }
  return out;
};

export const sanitizeFormatPatch = (raw: unknown): Partial<Format> =>
  pick(
    raw,
    {
      kind: (v) => oneOf(v, COMIC_KINDS),
      pageCount: (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(40, Math.max(1, Math.round(v))) : undefined),
      pageAspect: (v) => oneOf(v, ASPECT_RATIOS),
      panelsPerPage: (v) => (v === 'auto' ? 'auto' : typeof v === 'number' && Number.isFinite(v) ? Math.min(9, Math.max(1, Math.round(v))) : undefined),
      readingDirection: (v) => oneOf(v, ['ltr', 'rtl'] as const),
      lettering: (v) => oneOf(v, LETTERING_MODES),
      colorMode: (v) => oneOf(v, COLOR_MODES),
      language: (v) => (typeof v === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(v.trim()) ? v.trim() : undefined)
    },
    'format'
  ) as Partial<Format>;

export const sanitizeSettingsPatch = (raw: unknown): Partial<Settings> => {
  const out = pick(
    raw,
    {
      quality: (v) => oneOf(v, QUALITY_TIERS),
      confirm: (v) => oneOf(v, CONFIRM_POLICIES),
      bigSpendUsd: (v) => num(v, 0, 1000),
      budgetUsd: (v) => (v === null ? null : num(v, 0, 100_000)),
      imageModelOverride: (v) =>
        v === null || v === '' ? null : typeof v === 'string' && IMAGE_MODELS.some((m) => m.id === v && m.lifecycle !== 'deprecated') ? v : undefined
    },
    'settings'
  );
  // null clears an optional setting.
  if (out.budgetUsd === null || out.budgetUsd === 0) out.budgetUsd = undefined;
  if (out.imageModelOverride === null) out.imageModelOverride = undefined;
  return out as Partial<Settings>;
};

export const sanitizeLook = (raw: unknown): Record<string, string> | undefined => {
  if (!isObject(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const key of LOOK_FIELDS) {
    const v = str(raw[key], key === 'summary' ? 600 : 300);
    if (v !== undefined) out[key] = v;
  }
  return out;
};

/** Asset refs a client may set: only paths the doc already references (no foreign paths). */
const knownAssets = (doc: ComicDoc) => {
  const known = new Map<string, AssetRef>();
  const add = (a?: AssetRef) => a?.path && known.set(a.path, a);
  doc.style.refs.forEach(add);
  add(doc.style.board);
  doc.style.options.forEach((o) => {
    add(o.render.asset);
    o.render.history.forEach(add);
  });
  doc.cast.forEach((c) => c.refs.forEach(add));
  doc.places.forEach((p) => p.refs.forEach(add));
  doc.conversation.forEach((m) => m.attachments?.forEach(add));
  return known;
};

const assetList = (known: Map<string, AssetRef>) => (v: unknown): AssetRef[] | undefined => {
  if (!Array.isArray(v) || v.length > 12) return undefined;
  const out: AssetRef[] = [];
  for (const item of v) {
    const path = isObject(item) ? item.path : item;
    const ref = typeof path === 'string' ? known.get(path) : undefined;
    if (!ref) return undefined;
    out.push(ref);
  }
  return out;
};

/**
 * Validate a client `patch` action. Only CLIENT_PATCHABLE_OPS are accepted; each op is
 * re-built from known keys with bounded values; anything structurally wrong rejects the
 * whole batch (BAD_REQUEST) so a half-applied edit never happens.
 */
export function sanitizePatchOps(doc: ComicDoc, ops: unknown, sanitizeCtx?: SanitizeCtx): DocOp[] {
  if (!Array.isArray(ops) || !ops.length) throw badRequest('Nothing to change.');
  if (ops.length > MAX_PATCH_OPS) throw badRequest('Too many changes at once.');
  const known = knownAssets(doc);
  const castIds = new Set(doc.cast.map((c) => c.id));
  const placeIds = new Set(doc.places.map((p) => p.id));
  // Characters/places created earlier in the same batch count as existing.
  const out: DocOp[] = [];
  for (const raw of ops) {
    if (!isObject(raw) || typeof raw.op !== 'string') throw badRequest('Invalid change.');
    const kind = raw.op as DocOp['op'];
    if (!CLIENT_PATCHABLE_OPS.has(kind)) throw badRequest(`“${kind}” can't be changed directly.`);
    const id = (v: unknown, what: string) => {
      if (typeof v !== 'string' || !SAFE_ID.test(v)) throw badRequest(`Invalid ${what} id.`);
      return v;
    };
    const page = (pageId: unknown) => {
      const p = findPage(doc, id(pageId, 'page'));
      if (!p) throw badRequest('That page is no longer in the plan.');
      return p;
    };
    const panelOf = (p: Page, panelId: unknown) => {
      const panel = p.panels.find((x) => x.id === id(panelId, 'panel'));
      if (!panel) throw badRequest('That panel is no longer on the page.');
      return panel;
    };
    switch (kind) {
      case 'brief': {
        const patch = pick(
          raw.patch,
          {
            title: (v) => str(v, 200),
            logline: (v) => str(v, 600),
            premise: (v) => str(v, 4000),
            genre: (v) => str(v, 120),
            tone: (v) => str(v, 200),
            audience: (v) => str(v, 200),
            setting: (v) => str(v, 1000),
            themes: (v) => strList(v, 12, 120),
            notes: (v) => strList(v, 40, 500)
          },
          'brief'
        );
        if (patch.title === '') delete patch.title;
        out.push({ op: 'brief', patch });
        break;
      }
      case 'note_add': {
        const text = str(raw.text, 500);
        if (!text) throw badRequest('Invalid note.');
        out.push({ op: 'note_add', text });
        break;
      }
      case 'format':
        out.push({ op: 'format', patch: sanitizeFormatPatch(raw.patch) });
        break;
      case 'settings':
        out.push({ op: 'settings', patch: sanitizeSettingsPatch(raw.patch) });
        break;
      case 'source': {
        const patch = pick(raw.patch, { script: (v) => (typeof v === 'string' ? v.slice(0, LONG_TEXT_LIMIT) : undefined) }, 'source');
        out.push({ op: 'source', patch: { ...patch, updatedAt: Date.now() } });
        break;
      }
      case 'style': {
        const patch = pick(
          raw.patch,
          {
            status: (v) => oneOf(v, ['empty', 'drafted', 'locked'] as const),
            name: (v) => str(v, 80),
            spec: (v) => str(v, 2000),
            palette: (v) => strList(v, 8, 40),
            linework: (v) => str(v, 300),
            avoid: (v) => strList(v, 12, 120),
            presetId: (v) => (v === null ? null : typeof v === 'string' && getStylePreset(v) ? v : undefined),
            refs: assetList(known),
            board: (v) => (v === null ? null : assetList(known)([v])?.[0])
          },
          'style'
        );
        if (patch.presetId === null) patch.presetId = undefined;
        if (patch.board === null) patch.board = undefined;
        out.push({ op: 'style', patch: patch as Partial<StyleBible> });
        break;
      }
      case 'character': {
        const charId = id(raw.id, 'character');
        const patch = pick(
          raw.patch,
          {
            name: (v) => str(v, 80) || undefined,
            role: (v) => str(v, 200),
            tier: (v) => oneOf(v, CAST_TIERS),
            look: sanitizeLook,
            personality: (v) => str(v, 1000),
            voice: (v) => str(v, 600),
            refs: assetList(known)
          },
          'character'
        );
        if (!castIds.has(charId) && !patch.name) throw badRequest('A new character needs a name.');
        castIds.add(charId);
        out.push({ op: 'character', id: charId, patch: patch as Partial<Character> });
        break;
      }
      case 'character_remove':
        out.push({ op: 'character_remove', id: id(raw.id, 'character') });
        break;
      case 'place': {
        const placeId = id(raw.id, 'place');
        const patch = pick(raw.patch, { name: (v) => str(v, 80) || undefined, look: (v) => str(v, 1500), refs: assetList(known) }, 'location');
        if (!placeIds.has(placeId) && !patch.name) throw badRequest('A new location needs a name.');
        placeIds.add(placeId);
        out.push({ op: 'place', id: placeId, patch: patch as Partial<Place> });
        break;
      }
      case 'place_remove':
        out.push({ op: 'place_remove', id: id(raw.id, 'place') });
        break;
      case 'page': {
        const p = page(raw.id);
        const patch = pick(raw.patch, { summary: (v) => str(v, 1000), layout: (v) => str(v, 1000), turnHook: (v) => str(v, 500) }, 'page');
        out.push({ op: 'page', id: p.id, patch });
        break;
      }
      case 'panel': {
        const p = page(raw.pageId);
        const panel = panelOf(p, raw.id);
        const patch = pick(
          raw.patch,
          {
            size: (v) => oneOf(v, PANEL_SIZES),
            shot: (v) => oneOf(v, SHOT_TYPES),
            angle: (v) => str(v, 200),
            action: (v) => str(v, 2000),
            castIds: (v) => (Array.isArray(v) && v.length <= 12 && v.every((x) => typeof x === 'string' && castIds.has(x)) ? [...new Set(v as string[])] : undefined),
            placeId: (v) => (v === null || v === '' ? null : typeof v === 'string' && placeIds.has(v) ? v : undefined),
            mood: (v) => str(v, 200)
          },
          'panel'
        );
        if (patch.placeId === null) patch.placeId = undefined;
        out.push({ op: 'panel', pageId: p.id, id: panel.id, patch });
        break;
      }
      case 'line': {
        const p = page(raw.pageId);
        const panel = panelOf(p, raw.panelId);
        const lineId = id(raw.id, 'line');
        if (raw.patch === null) {
          out.push({ op: 'line', pageId: p.id, panelId: panel.id, id: lineId, patch: null });
          break;
        }
        const patch = pick(
          raw.patch,
          {
            kind: (v) => oneOf(v, LINE_KINDS),
            speakerId: (v) => (v === null || v === '' ? null : typeof v === 'string' && castIds.has(v) ? v : undefined),
            text: (v) => (typeof v === 'string' ? v.slice(0, 600) : undefined)
          },
          'line'
        );
        if (patch.speakerId === null) patch.speakerId = undefined;
        const kindAfter = (patch.kind as LineKind | undefined) || panel.lines.find((l) => l.id === lineId)?.kind || 'speech';
        if (!SPOKEN_KINDS.has(kindAfter) && 'speakerId' in patch) patch.speakerId = undefined;
        out.push({ op: 'line', pageId: p.id, panelId: panel.id, id: lineId, patch });
        break;
      }
      case 'balloons': {
        const p = page(raw.pageId);
        if (!Array.isArray(raw.balloons) || raw.balloons.length > 80) throw badRequest('Invalid balloons.');
        const lineIds = new Set(p.panels.flatMap((x) => x.lines.map((l) => l.id)));
        const balloons = raw.balloons.map((b) => sanitizeBalloon(b, lineIds));
        out.push({ op: 'balloons', pageId: p.id, balloons });
        break;
      }
      case 'balloon': {
        const p = page(raw.pageId);
        const lineIds = new Set(p.panels.flatMap((x) => x.lines.map((l) => l.id)));
        if (typeof raw.lineId !== 'string' || !lineIds.has(raw.lineId)) throw badRequest('That line is no longer on the page.');
        const patch = pick(
          raw.patch,
          {
            x: (v) => num(v, 0, 1),
            y: (v) => num(v, 0, 1),
            w: (v) => num(v, 0.04, 1),
            tailX: (v) => num(v, 0, 1),
            tailY: (v) => num(v, 0, 1),
            pinned: (v) => (typeof v === 'boolean' ? v : undefined)
          },
          'balloon'
        );
        out.push({ op: 'balloon', pageId: p.id, lineId: raw.lineId, patch });
        break;
      }
      case 'cover': {
        const patch = pick(raw.patch, { title: (v) => str(v, 200), tagline: (v) => str(v, 300), direction: (v) => str(v, 1500) }, 'cover');
        out.push({ op: 'cover', patch });
        break;
      }
      case 'plan_status': {
        const status = oneOf(raw.status, ['none', 'draft', 'approved'] as const);
        if (!status) throw badRequest('Invalid plan status.');
        if (status !== 'none' && !doc.pages.length) throw badRequest('There is no page plan yet.');
        out.push({ op: 'plan_status', status });
        break;
      }
      default: {
        // v5 feature ops (letter_style, page_*, ref_*, edition*, …): their own sanitizer.
        const sanitizer = opSanitizerFor(kind);
        if (!sanitizer) throw badRequest(`“${kind}” can't be changed directly.`);
        out.push(sanitizer.sanitize(doc, raw as unknown as DocOp, sanitizeCtx ?? defaultSanitizeCtx(doc)));
      }
    }
  }
  let screened = out;
  for (const screen of patchScreens()) screened = screen(doc, screened, sanitizeCtx ?? defaultSanitizeCtx(doc));
  return screened;
}

/** Patches validated without a request context (tools, tests): default caps, the doc's own rating. */
const defaultSanitizeCtx = (doc: ComicDoc): SanitizeCtx => ({
  userId: '',
  caps: DEFAULT_CAPS,
  rating: effectiveRating(doc, DEFAULT_CAPS.ratingCeiling).rating,
  now: Date.now()
});

const sanitizeBalloon = (raw: unknown, lineIds: Set<string>): Balloon => {
  if (!isObject(raw) || typeof raw.lineId !== 'string' || !lineIds.has(raw.lineId)) throw badRequest('Invalid balloon.');
  const x = num(raw.x, 0, 1);
  const y = num(raw.y, 0, 1);
  const w = num(raw.w, 0.04, 1);
  if (x === undefined || y === undefined || w === undefined) throw badRequest('Invalid balloon position.');
  const tailX = num(raw.tailX, 0, 1);
  const tailY = num(raw.tailY, 0, 1);
  return {
    lineId: raw.lineId,
    x,
    y,
    w,
    ...(tailX !== undefined ? { tailX } : {}),
    ...(tailY !== undefined ? { tailY } : {}),
    ...(raw.pinned === true ? { pinned: true } : {})
  };
};

function applyPatch(ctx: StudioContext, ops: unknown, opts: RunActionOptions): ActionOutcome {
  const sanitized = sanitizePatchOps(ctx.session.doc, ops, sanitizeCtxFor(ctx, opts));
  if (opts.origin) ctx.session.commit(sanitized, { origin: opts.origin });
  else ctx.session.commit(sanitized);
  return { status: 'done', message: `Saved ${plural(sanitized.length, 'change')}.` };
}

// ── Suggestions ──────────────────────────────────────────────────────────────

/**
 * 2–4 short next-step chips from doc state (deterministic). They follow the default
 * forward motion: idea → style → cast sheets → plan → render → cover → read.
 */
export function suggestNextSteps(doc: ComicDoc): string[] {
  const out: string[] = [];
  const hasIdea = !!(clean(doc.brief.premise) || clean(doc.brief.logline) || clean(doc.source.script) || doc.cast.length);
  const rendering = doc.pages.some((p) => isBusy(p.render)) || doc.cast.some((c) => isBusy(c.sheet));
  if (!hasIdea) {
    out.push('A heist comic set in Mumbai', 'Paste a script', 'A cozy fantasy for kids');
    return out.slice(0, 4);
  }
  if (doc.style.status === 'empty') out.push('Show me 3 styles');
  else if (doc.style.status === 'drafted' && !doc.style.options.length) out.push('Show me 3 styles');
  const sheetless = doc.cast.filter((c) => c.tier !== 'extra' && c.sheet.status !== 'ready' && !isBusy(c.sheet));
  if (doc.style.status !== 'empty' && sheetless.length) out.push('Draw the character sheets');
  if (!doc.cast.length) out.push('Suggest a cast');
  if (doc.planStatus === 'none') out.push('Plan the pages');
  if (doc.planStatus === 'draft') out.push('Render all pages', 'Make page 1 more dramatic');
  if (doc.planStatus === 'approved' && !rendering) {
    const undrawn = doc.pages.filter((p) => p.render.status !== 'ready' && !isBusy(p.render));
    const stale = doc.pages.filter((p) => isPageStale(doc, p));
    if (undrawn.length) out.push(undrawn.length === doc.pages.length ? 'Render all pages' : 'Render the remaining pages');
    else if (stale.length) out.push('Redraw the out-of-date pages');
  }
  const allDrawn = doc.pages.length > 0 && doc.pages.every((p) => p.render.status === 'ready');
  if (allDrawn && doc.cover.render.status !== 'ready' && !isBusy(doc.cover.render)) out.push('Make the cover');
  if (allDrawn) out.push('Read it');
  if (out.length < 2 && doc.pages.length) out.push('Add a twist on the last page');
  if (out.length < 2) out.push('Make it funnier');
  return [...new Set(out)].slice(0, 4);
}

export { isSpendAction };
