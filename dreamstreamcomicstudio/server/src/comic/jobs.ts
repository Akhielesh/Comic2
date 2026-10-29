// Job runner for Comic Studio (v5): direct studio actions, the spend gate, and the image
// render pipeline (contract §12.3).
//
// Every action either edits the doc (patch, pick a style, approve a plan, use a version) or
// SPENDS (style options, sheets, pages, edits, cover). Spend actions are estimated with the
// shared registry first and stop at a Gate when the user's confirm policy, the budget cap or
// a director guard (first render, plan review, redraw, no draw intent) says so — nothing is
// drawn until the gate is approved. A confirmed chip whose quote went stale is re-gated.
// Approved work renders server-side (closing the tab never loses a paid image):
//
//   targets marked queued → [missing sheets] → page 1 alone (continuity anchor) →
//   remaining pages (+ the cover) in parallel (≤3 image calls per project; one at a time
//   once the provider rate-limits this run) → per image: aspect check, pending safety
//   verdict, QC + balloons (pages), URL after the verdict (20 s owner-only fail-open).
//
// Software first: an implicit request never redraws a ready, current target (R1); a version
// made from exactly today's spec is put back for free (R2); an identical job's image is
// copied (R3) or joined while still drawing (R7). Each reuse is a $0 ledger line with the
// amount saved. Each image is billed per call (reserve → settle with the provider-reported
// cost → release on failure); a rate-limited image is re-queued once after the provider's
// Retry-After before it is marked failed. Conversation order follows causality: a director
// turn carries the live progress card and the completion is a NEW message appended after
// the reply, with next steps computed after the run. Nothing is ever left "queued".

import {
  CAST_KINDS,
  archiveOf,
  collectAssetPaths,
  emptyRender,
  findCharacter,
  findPage,
  findPlace,
  getRender,
  isPageStale,
  isTargetStale,
  mapAssetRefs,
  newId,
  normalizeErrorDetail,
  renderTargetKey,
  specHashFor,
  trashOf,
  versionsOf,
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
  type RenderErrorDetail,
  type RenderState,
  type RenderTarget,
  type Settings,
  type ShotType,
  type SpendKind,
  type StyleBible,
  type VersionMeta
} from '../../../shared/comic/doc.js';
import { CLIENT_PATCHABLE_OPS, isSpendAction, type DocOp, type SpendAction, type StudioAction } from '../../../shared/comic/ops.js';
import type { OpsOrigin } from '../../../shared/comic/events.js';
import { DEFAULT_CAPS, type StudioCaps } from '../../../shared/comic/capabilities.js';
import { hashString } from '../../../shared/comic/hash.js';
import { DOC_LIMITS } from '../../../shared/comic/limits.js';
import { REF_LABELS } from '../../../shared/comic/refs.js';
import {
  LOW_QC_SCORE as PLAN_LOW_QC_SCORE,
  coverNeedsDraw,
  missingSheetsFor as planMissingSheets,
  pageTargets as planPageTargets,
  quoteRenderPages
} from '../../../shared/comic/plan.js';
import { PLATFORM_CEILING, canServeToOwner, effectiveRating, safetyStatusOf, type ContentRating, type SafetyVerdict } from '../../../shared/comic/safety.js';
import {
  IMAGE_MODELS,
  PLAN_USD_PER_PAGE,
  PLATFORM_MARKUP,
  QC_USD_PER_PAGE,
  RELAYOUT_VISION_USD,
  TIER_PRESETS,
  aspectFromSize,
  aspectMatches,
  estimateJobs,
  formatUsd,
  imagePriceUsd,
  resolveImageJob,
  styleDirectionsUsd,
  type ImageJobKind,
  type ImageModelSpec,
  type ImageRoute,
  type SpendEstimate
} from '../../../shared/comic/models.js';
import { STYLE_PRESETS, getStylePreset, type StylePreset } from '../../../shared/comic/stylePresets.js';
import type { ChatMessage } from '../ai/providers/types.js';
import { BILLING_ENABLED } from '../config.js';
import { logger } from '../lib/logger.js';
import { PRO_QUALITY_USAGE_MESSAGE } from './access.js';
import { actionHandlerFor } from './actions/index.js';
import { castOpsForUncast, findUncastBeings } from './castScan.js';
import type { OrchestratorContext } from './context.js';
import { costFormatterFor, governCard, governDollars, costViewFor, type CostFormatter } from './costText.js';
import type { ActionHandler, SanitizeCtx } from './extensions.js';
import { imageFailureDetail, imageFailureInfo, pickImageRoute } from './imageClient.js';
import { prefersGeminiDirect } from './keys.js';
import { compileCharacterSheet, compileCover, compileEdit, compilePage, compilePlaceSheet, compileStyleOption } from './prompts.js';
import { InflightJobs, findJobHashAsset, findSpecHashVersion, jobHashOf, reusedLabel } from './reuse.js';
import { checkRenderSafety, onRenderVerdict, screenUploadPreview, takeRenderSafetyFollowups } from './safety/index.js';
import { estimateTextCostUsd, resolveTextRoute } from './textModels.js';
import { breakdownCardFor } from './tools/breakdown.js';
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
import { analyzePageRender, placeStoredBalloons } from './vision.js';
import { opSanitizerFor, patchScreens } from './sanitize/index.js';
import { clipText, enteredText, storableText } from './sanitize/text.js';
import { mergeRevisedPages, proposeStyleDirections, writePagePlan } from './writer.js';

// ── Limits & constants ───────────────────────────────────────────────────────

/** Concurrent image calls per project. */
export const MAX_PARALLEL_IMAGES = 3;
/** QC score under which the user is told a page may need another pass (one number: shared/comic/plan.ts). */
export const LOW_QC_SCORE = PLAN_LOW_QC_SCORE;
/** Attempts per image (the transport already retries 429/5xx once inside an attempt). */
const MAX_IMAGE_ATTEMPTS = 2;
/** Pauses and waits (tests shorten them). */
export const JOB_TIMINGS = {
  retryBackoffMs: 2500,
  saveRetryMs: 1000,
  /** A rate-limited image that still failed waits this long (or the provider's Retry-After) before its one re-queue. */
  rateLimitRequeueMs: 45_000,
  /** Up to this much random jitter on that wait, so parallel failures don't return in the same second. */
  requeueJitterMs: 5_000,
  /** Lower bound on a provider's Retry-After hint for that wait. */
  requeueMinMs: 5_000,
  /** The owner's private view shows an image after this long even without a safety verdict (decisions-final #10). */
  safetyFailOpenMs: 20_000,
  /** A completion waits at most this long for the director's reply to be committed first. */
  turnLockWaitMs: 30_000
};
/** Upper bound on a provider's Retry-After hint for the job-level re-queue. */
const REQUEUE_MAX_MS = 120_000;
/**
 * A rate-limited provider needs real breathing room before the job's second attempt (the
 * transport already waited and retried once): 5× the base pause plus up to one base pause
 * of jitter, so parallel jobs that failed together do not all come back in the same second.
 */
const RATE_LIMIT_BACKOFF_FACTOR = 5;
const MAX_STYLE_DIRECTIONS = 4;
const DEFAULT_STYLE_DIRECTIONS = 3;
const MAX_PATCH_OPS = 200;
/**
 * Undoing a removed edition sends one `translation` op per line; an all-translation batch may be
 * this long (DOC_LIMITS.lines-sized editions undo in one tap instead of failing at 200).
 */
const MAX_TRANSLATION_PATCH_OPS = 2000;
/**
 * User reference photos lazily safety-checked before one render (safety.md §3.2; platform-paid,
 * ≈ $0.0012 each, once per photo — the verdict is stored). ≥ the largest model's reference total
 * (models.ts refs.total ≤ 16), so no attached unchecked upload ever skips the check; only an
 * unavailable classifier fails open (decisions-final #10).
 */
const MAX_LAZY_REF_CHECKS = 16;
/** Chips on one message (shared cap). */
const MAX_NEXT_STEPS = DOC_LIMITS.nextSteps;
/** Chips nextStepsFor() offers from doc state alone (a completion may prepend its own). */
const DOC_NEXT_STEPS = 4;

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
const LOOK_FIELDS = ['summary', 'age', 'gender', 'build', 'face', 'hair', 'eyes', 'skin', 'outfit', 'palette', 'props', 'marks', 'species', 'markings'] as const;

// ── Small helpers ────────────────────────────────────────────────────────────

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** One-line text as it enters the doc or a prompt (P2-GATE L5): jsonb-safe (sanitize/text.ts), whitespace collapsed, clipped without splitting a pair. */
const clean = (value: unknown, max = TEXT_LIMIT): string =>
  typeof value === 'string' ? clipText(storableText(value).replace(/\s+/g, ' ').trim(), max) : '';
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

/** A timer that can be cancelled (no dangling timeouts after a race is decided). */
const delay = (ms: number): { promise: Promise<'timeout'>; cancel: () => void } => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, ms));
    (timer as { unref?: () => void }).unref?.();
  });
  return { promise, cancel: () => timer && clearTimeout(timer) };
};

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

/** An assistant message. `nextSteps` also fill the legacy string `suggestions` (old clients). */
const assistantMessage = (text: string, cards?: Card[], steps?: NextStep[] | string[]): Msg => {
  const list = (steps || []).slice(0, MAX_NEXT_STEPS);
  const objects = list.filter((s): s is NextStep => typeof s === 'object' && !!s);
  const labels = list.map((s) => (typeof s === 'string' ? s : s.label)).filter(Boolean);
  return {
    id: newId('msg'),
    role: 'assistant',
    text,
    at: Date.now(),
    ...(cards?.length ? { cards } : {}),
    ...(labels.length ? { suggestions: labels } : {}),
    ...(objects.length ? { nextSteps: objects } : {})
  };
};

/** Commit with an ops origin (undo attribution) and an optional undo label. */
const commitAs = (ctx: StudioContext, ops: DocOp[], origin?: OpsOrigin, label?: string): ComicDoc =>
  ctx.session.commit(ops, { ...(origin ? { origin } : {}), ...(label ? { label } : {}) });

/** The live status line. `cost` = the Free / AI / Image badge (an image draw, a writer or vision call, or free software work). */
const activity = (ctx: StudioContext, label: string, cost?: 'free' | 'text' | 'image') => {
  const id = newId('act');
  ctx.session.emit({ type: 'activity', id, label, phase: 'start', ...(cost ? { cost } : {}) });
  let ended = false;
  return (ok: boolean) => {
    if (ended) return;
    ended = true;
    ctx.session.emit({ type: 'activity', id, label, phase: 'end', ok, ...(cost ? { cost } : {}) });
  };
};

/** Prices in this user's terms: governed users (not admin, not their own key) read "≈2% of your usage", never dollars. */
const costOf = (ctx: StudioContext): CostFormatter => costFormatterFor(ctx);

/**
 * The safety net on every message a job commits: a governed user never reads a dollar amount
 * (any template that still says "$0.05" is reworded); notice cards are reworded the same way.
 */
const governMsg = (ctx: StudioContext, msg: Msg): Msg => {
  const view = costViewFor(ctx.caps);
  if (!view.governed) return msg;
  const cards = msg.cards?.map((c) => governCard(c, view));
  return { ...msg, text: governDollars(msg.text, view), ...(cards ? { cards } : {}) };
};

/**
 * Which transport an image model will use with these keys — the image client's OWN choice
 * (pickImageRoute), never a second opinion: the billing reserve is made for this route, so a
 * user's own Gemini key draws AND is billed as their own key (BYOK never touches usage), while
 * the platform key is reserved against usage. Null when no key reaches the model.
 */
export const imageRouteFor = (spec: ImageModelSpec, keys: StudioKeys): { route: ImageRoute; model: string; byok: boolean } | null => {
  try {
    const picked = pickImageRoute(spec, keys);
    return { route: picked.route, model: picked.model, byok: picked.key.byok };
  } catch (err) {
    if (err instanceof StudioError && err.code === 'NO_IMAGE_KEY') return null;
    throw err;
  }
};

/**
 * Whether spend will run on the user's own key: their Gemini key when the image client prefers
 * it (own Gemini key, no own OpenRouter key — prefersGeminiDirect), else OpenRouter's, else Gemini's.
 */
export const spendIsByok = (keys: StudioKeys): boolean =>
  prefersGeminiDirect(keys) || (keys.openrouter?.key ? Boolean(keys.openrouter.byok) : Boolean(keys.gemini?.byok));

/** BYOK-ness of an image spend: the key of the route that will draw ITS model (an OpenRouter-only model stays platform spend for an own-Gemini-key user). */
const imageSpendIsByok = (doc: ComicDoc, action: SpendAction, keys: StudioKeys): boolean =>
  imageRouteFor(modelLabel(doc, describeSpend(doc, action).kind).spec, keys)?.byok ?? spendIsByok(keys);

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

/** Identical image jobs drawing right now, per project (R7). */
const inflightJobs = new WeakMap<StudioSessionApi, InflightJobs>();
const inflightFor = (session: StudioSessionApi) => {
  let s = inflightJobs.get(session);
  if (!s) {
    s = new InflightJobs();
    inflightJobs.set(session, s);
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
          // OpenRouter may serve any model of the chain: the hold is priced at the dearest.
          models: route.models,
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
  ctx.session.commit(
    [
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
    ],
    { origin: 'job' }
  );
};

// ── Targets ──────────────────────────────────────────────────────────────────

/** Lead/support characters (and anyone explicitly requested) whose sheet must be drawn. */
const needsSheet = (c: Character) => c.tier !== 'extra' && c.sheet.status !== 'ready' && !isBusy(c.sheet);

/**
 * Pages a render_pages action draws. Without `force` never a ready, current page (R1):
 * only undrawn, failed and out-of-date pages with panels, never busy ones (shared plan.ts).
 */
export const pageTargets = (doc: ComicDoc, action: { pageIds?: string[]; force?: boolean }): Page[] => planPageTargets(doc, action);

/** Lead/support cast appearing on these pages that has no usable sheet yet (shared plan.ts: the chat card quotes the same). */
export const missingSheetsFor = (doc: ComicDoc, pages: Page[]): Character[] => planMissingSheets(doc, pages);

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

/** Whether a render_pages `includeCover` draws the cover now (forced: any idle cover; else undrawn or out of date). */
const coverWanted = (doc: ComicDoc, force?: boolean): boolean => (force ? !isBusy(doc.cover.render) : coverNeedsDraw(doc));

// Count what the runner will actually draw: sanitized directions (invalid ones are dropped),
// else the default proposal count. Mirrors RenderRun.styleOptions.
const styleDirections = (action: Extract<SpendAction, { type: 'render_style_options' }>) => sanitizeDirections(action.directions);
const styleDirectionCount = (action: Extract<SpendAction, { type: 'render_style_options' }>) =>
  styleDirections(action).length || DEFAULT_STYLE_DIRECTIONS;

/** The page re-check's display name (a vision text call, not an image model). */
export const RECHECK_MODEL_LABEL = 'Page check';

/** Registry estimate for a spend action (counts what would actually be drawn now). */
export function estimateSpendAction(doc: ComicDoc, action: SpendAction, byok: boolean): SpendEstimate {
  if (action.type === 'render_pages') {
    // One quote for the chat card, the board and the gate (shared/comic/plan.ts; plan.parity.test.ts).
    const q = quoteRenderPages(doc, { ...action, byok, tier: doc.settings.quality, modelOverride: doc.settings.imageModelOverride });
    return { usd: q.usd, imageCount: q.imageCount, model: q.model, lines: q.lines };
  }
  if (action.type === 'recheck_page') {
    // TEXT-priced: one vision call re-reads the page (lettering.md §9). No image is drawn.
    const usd = round4(RELAYOUT_VISION_USD * (byok ? 1 : PLATFORM_MARKUP));
    return { usd, imageCount: 0, model: RECHECK_MODEL_LABEL, lines: [{ label: 'page re-check', count: 1, usd }] };
  }
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
    // Writer text spend for proposing style directions (shared with the client's StylePanel quote).
    const usd = styleDirectionsUsd(byok);
    return { ...est, usd: round4(est.usd + usd), lines: [...est.lines, { label: 'style directions', count: 1, usd }] };
  }
  return est;
}

const budgetOf = (settings: Settings): number | undefined =>
  typeof settings.budgetUsd === 'number' && Number.isFinite(settings.budgetUsd) && settings.budgetUsd > 0 ? settings.budgetUsd : undefined;

/** No page of the project has ever been drawn (first_render guard). */
const neverDrawn = (doc: ComicDoc): boolean => doc.pages.every((p) => !p.render.asset && !p.render.history.length);

/** A confirmed spend whose fresh estimate outgrew the price on the chip/button (same tolerance as a gate). */
export const quoteIsStale = (quotedUsd: unknown, estimate: SpendEstimate): boolean =>
  typeof quotedUsd === 'number' && Number.isFinite(quotedUsd) && quotedUsd >= 0 && estimate.usd > quotedUsd * 1.15 + 0.01;

/**
 * Whether a spend must wait for the user, and why.
 * - `budget`: it would push the project past its budget cap (even when confirmed, unless the
 *   user approved going over).
 * - Confirmed spends (the user's own click or an approved gate) run.
 * - `forceGate`: a director guard. `redraw` and `policy` always stop (they replace paid work or
 *   honour a stale quote); `first_render` / `plan_review` / `no_intent` are skipped under
 *   confirm 'never'.
 * - render_pages from the director: `first_render` (nothing drawn yet, reviewFirstRender) and
 *   `plan_review` (the plan is still a draft), unless confirm is 'never'.
 * - else `policy` per the confirm setting.
 */
export function gateDecision(
  doc: ComicDoc,
  estimate: SpendEstimate,
  confirmed: boolean,
  opts: {
    budgetApproved?: boolean;
    pendingUsd?: number;
    priorUsd?: number;
    forceGate?: Gate['reason'];
    /** The spend would replace a ready, current image (a director redraw always stops). */
    redraw?: boolean;
    action?: SpendAction;
  } = {}
): Gate['reason'] | null {
  const budget = budgetOf(doc.settings);
  if (budget !== undefined && !opts.budgetApproved && round4(doc.spend.totalUsd + (opts.pendingUsd || 0) + estimate.usd) > budget + 1e-9) return 'budget';
  if (confirmed) return null;
  const policy = doc.settings.confirm;
  if (opts.forceGate) {
    if (opts.forceGate === 'redraw' || opts.forceGate === 'policy' || opts.forceGate === 'budget') return opts.forceGate;
    if (policy !== 'never') return opts.forceGate;
  }
  if (opts.redraw) return 'redraw';
  if (opts.action?.type === 'render_pages' && policy !== 'never') {
    if (doc.settings.reviewFirstRender !== false && neverDrawn(doc)) return 'first_render';
    if (doc.planStatus === 'draft') return 'plan_review';
  }
  switch (policy) {
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
  /** Pro-tier spend is not allowed for this user; the message explains why (derived user text). */
  qualityDenied?: string;
  /** Approving a budget gate lets this one action go over the budget. */
  budgetApproved?: boolean;
  /** USD this director turn has already started without approval (for the per-turn 'big' gate). */
  priorUsd?: number;
  /** Director turns: cards (gate, live renders progress, breakdown, notices) go into the director's message. */
  collectCard?: (card: Card) => void;
  /**
   * What this user may do (contract §12.3). Absent ⇒ ctx.caps; when neither is given the
   * quality check falls back to `qualityDenied` (P2-SERVER makes this required once every
   * caller passes it).
   */
  caps?: StudioCaps;
  /** Director turns: next steps for the director's message. */
  collectNextSteps?: (steps: NextStep[]) => void;
  /** Force a gate even below bigSpendUsd (drawIntent 'none', first_render, plan_review, redraw). */
  forceGate?: Gate['reason'];
  /** A re-quote of an approval whose price moved: the old quote, so the new card says the price changed. */
  staleFrom?: number;
  /** Ops origin for session.commit (undo + "saved by software" attribution). Absent ⇒ 'director' when collecting, else none. */
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

/** The caller's origin; a director turn (collecting cards) is 'director'; otherwise none (old callers). */
const originOf = (opts: Pick<RunActionOptions, 'origin' | 'collectCard'>): OpsOrigin | undefined => opts.origin ?? (opts.collectCard ? 'director' : undefined);

/** Deliver conversation cards (and chips): into the director's message when collecting, else as a new assistant message. */
const deliver = (ctx: StudioContext, opts: RunActionOptions, text: string, cards: Card[], steps?: NextStep[] | string[]) => {
  if (opts.collectCard) {
    cards.forEach((c) => opts.collectCard!(c));
    const objects = (steps || []).filter((s): s is NextStep => typeof s === 'object' && !!s);
    if (objects.length) opts.collectNextSteps?.(objects);
    return;
  }
  commitAs(ctx, [{ op: 'message', msg: governMsg(ctx, assistantMessage(text, cards, steps)) }], 'job');
};

const blocked = (ctx: StudioContext, opts: RunActionOptions, message: string, tone: 'info' | 'warn' | 'error' = 'warn', steps?: NextStep[] | string[]) => {
  deliver(ctx, opts, message, [noticeCard(tone, message)], steps);
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
      return finished(declineGate(ctx, action.gateId, opts));
    case 'pick_style':
      return finished(pickStyle(ctx, action.optionId, opts));
    case 'plan_pages':
      return finished(await planPages(ctx, { instructions: action.instructions }, opts));
    case 'approve_plan':
      return finished(approvePlan(ctx, opts));
    case 'patch':
      return finished(applyPatch(ctx, action.ops, opts));
    case 'restore_render':
      return finished(restoreRender(ctx, action.target, action.path, opts));
    case 'relayout_balloons':
      return relayoutBalloons(ctx, action.pageId, opts, { useVision: action.useVision === true });
    case 'cancel':
      ctx.session.abort.abort();
      return finished({ status: 'done', message: 'Stopped. Anything already drawing will finish and be kept.' });
    default:
      throw badRequest(`Unknown action "${(action as { type: string }).type}".`);
  }
}

/**
 * Run a registered feature action. Spend handlers with an estimate (translate) go through
 * estimate → gateDecision → run exactly like the core spends (a stale chip quote re-gates).
 */
export async function runFeatureAction(ctx: StudioContext, handler: ActionHandler, action: StudioAction, opts: RunActionOptions): Promise<StartedAction> {
  if (!handler.spend || !handler.estimate || !isSpendAction(action)) return handler.run(ctx, action, opts);
  const estimate = await handler.estimate(ctx, action);
  const stale = opts.confirmed && quoteIsStale(action.quotedUsd, estimate);
  const reason = gateDecision(ctx.session.doc, estimate, opts.confirmed && !stale, {
    budgetApproved: opts.budgetApproved,
    pendingUsd: pendingUsdOf(ctx.session),
    priorUsd: opts.priorUsd,
    forceGate: stale ? 'policy' : opts.forceGate,
    action
  });
  if (reason) return createGate(ctx, action, estimate, reason, opts, { staleFrom: stale ? (action.quotedUsd as number) : opts.staleFrom });
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
  const handler = actionHandlerFor(gate.action.type);
  const estimate = handler?.estimate ? await handler.estimate(ctx, gate.action) : estimateSpendAction(doc, gate.action, imageSpendIsByok(doc, gate.action, ctx.keys));
  const nickname = handler ? gate.model : gateModelName(doc, gate.action, estimate);
  const origin = originOf(opts);
  if (!gateStillHolds(gate, estimate, nickname)) {
    // The plan, quality or model changed since the card was shown: never run a bigger
    // or different spend on an old approval — re-quote instead. `forceGate: 'policy'` holds
    // under every confirm setting (under 'big' a cheaper-than-threshold price would otherwise
    // run at once); `staleFrom` makes the new card say the price changed.
    commitAs(ctx, [{ op: 'gate', gate: { ...gate, status: 'declined' } }], origin);
    const requote: RunActionOptions = { ...opts, confirmed: false, budgetApproved: false, forceGate: 'policy', staleFrom: gate.estimateUsd };
    return handler ? runFeatureAction(ctx, handler, gate.action, requote) : startSpend(ctx, gate.action, requote);
  }
  // Commit 'approved' first (before startSpend, so a same-kind open gate isn't flipped to
  // 'declined' by startSpend), then put the card back if the spend never started —
  // so it never claims "drawing now" when a busy page / missing key / invalid-now blocked it.
  const ops: DocOp[] = [{ op: 'gate', gate: { ...gate, status: 'approved' } }];
  // Approving the plan review IS approving the plan.
  if (gate.reason === 'plan_review' && doc.planStatus === 'draft' && doc.pages.length) ops.push({ op: 'plan_status', status: 'approved' });
  commitAs(ctx, ops, origin, 'Approve');
  const reopen = () => {
    const cur = ctx.session.doc.gate;
    if (cur?.id === gate.id && cur.status === 'approved') commitAs(ctx, [{ op: 'gate', gate: { ...cur, status: 'open' } }], origin);
  };
  // Nothing left to do (the quoted page was deleted, the cover got drawn meanwhile): the gate is
  // closed, never left 'approved' — its card would claim "drawing now" beside "nothing was spent".
  const close = () => {
    const cur = ctx.session.doc.gate;
    if (cur?.id === gate.id && cur.status === 'approved') commitAs(ctx, [{ op: 'gate', gate: { ...cur, status: 'declined' } }], origin);
  };
  const next = { ...opts, confirmed: true, budgetApproved: gate.reason === 'budget' || opts.budgetApproved };
  try {
    const started = handler ? await handler.run(ctx, gate.action, next) : await startSpend(ctx, gate.action, next);
    if (started.outcome.status === 'blocked') reopen();
    else if (started.outcome.status === 'nothing') close();
    return started;
  } catch (err) {
    reopen();
    throw err;
  }
}

function declineGate(ctx: StudioContext, gateId: string, opts: RunActionOptions): ActionOutcome {
  const gate = ctx.session.doc.gate;
  if (!gate || gate.id !== gateId) throw new StudioError('BAD_REQUEST', 'That approval is no longer open.', { status: 409 });
  if (gate.status === 'open') commitAs(ctx, [{ op: 'gate', gate: { ...gate, status: 'declined' } }], originOf(opts));
  return { status: 'done', message: 'Declined — nothing was spent.' };
}

interface SpendPlan {
  /** What will be drawn, for titles and summaries ("6 pages + 2 character sheets"). */
  what: string;
  title: string;
  /** Primary image kind (quality access + model naming). */
  kind: ImageJobKind;
}

/** "page 2" · "pages 1–3" · "pages 1, 3 and 4" · "5 pages". */
const pagesPhrase = (pages: { n: number }[]): string => {
  const ns = [...new Set(pages.map((p) => p.n))].sort((a, b) => a - b);
  if (!ns.length) return 'no pages';
  if (ns.length === 1) return `page ${ns[0]}`;
  const consecutive = ns.every((n, i) => i === 0 || n === ns[i - 1] + 1);
  if (consecutive) return `pages ${ns[0]}–${ns[ns.length - 1]}`;
  if (ns.length <= 4) return `pages ${ns.slice(0, -1).join(', ')} and ${ns[ns.length - 1]}`;
  return `${ns.length} pages`;
};

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
      const cover = action.includeCover && coverWanted(doc, action.force);
      const pageText = pages.length ? pagesPhrase(pages) : '';
      const what = [pageText, sheets ? plural(sheets, 'character sheet') : '', cover ? 'the cover' : ''].filter(Boolean).join(' + ') || 'nothing';
      const verb = action.force ? 'Redraw' : 'Draw';
      return { what, title: `${verb} ${[pageText, cover ? 'the cover' : ''].filter(Boolean).join(' + ') || 'pages'}?`, kind: pages.length ? 'page' : cover ? 'cover' : 'page' };
    }
    case 'edit_page': {
      const page = findPage(doc, action.pageId);
      return { what: `an edit of page ${page?.n ?? '?'}`, title: `Edit page ${page?.n ?? '?'}?`, kind: 'edit' };
    }
    case 'render_cover':
      return action.textless
        ? { what: 'a textless cover (the title becomes editable text)', title: 'Redraw the cover without lettering?', kind: 'cover' }
        : { what: 'the cover', title: 'Draw the cover?', kind: 'cover' };
    case 'translate':
      return { what: `a translation (${(action.languages || []).join(', ')})`, title: 'Translate?', kind: 'page' };
    case 'recheck_page': {
      const page = findPage(doc, action.pageId);
      // in_art comics have their words painted in: the re-check only renews the page check (QC).
      const after = doc.format.lettering === 'in_art' ? 'its page check is renewed' : 'its balloons are re-laid';
      return { what: `a re-check of page ${page?.n ?? '?'} (the art is read again, then ${after})`, title: `Re-check page ${page?.n ?? '?'}?`, kind: 'page' };
    }
    default:
      return { what: 'images', title: 'Spend?', kind: 'page' };
  }
};

const modelLabel = (doc: ComicDoc, kind: ImageJobKind) => {
  const { spec, resolution } = resolveImageJob(kind, doc.settings.quality, doc.settings.imageModelOverride);
  return { nickname: spec.nickname, resolution, spec };
};

/** Spends priced in text (feature handlers, the page re-check): no image model, no resolution on the card. */
const isTextSpend = (action: SpendAction): boolean => !!actionHandlerFor(action.type) || action.type === 'recheck_page';

/** The model a gate names (and re-checks on approval): the estimate's for text spends, the registry's image model otherwise. */
const gateModelName = (doc: ComicDoc, action: SpendAction, estimate: SpendEstimate): string =>
  isTextSpend(action) ? estimate.model : modelLabel(doc, describeSpend(doc, action).kind).nickname;

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

/** The bound action without its chip quote (the gate card is the new quote). */
const withoutQuote = (action: SpendAction): SpendAction => {
  if (!('quotedUsd' in action)) return action;
  const copy = { ...action } as SpendAction & { quotedUsd?: number };
  delete copy.quotedUsd;
  return copy;
};

function createGate(
  ctx: StudioContext,
  rawAction: SpendAction,
  estimate: SpendEstimate,
  reason: Gate['reason'],
  opts: RunActionOptions,
  extra: { staleFrom?: number } = {}
): StartedAction {
  const doc = ctx.session.doc;
  const action = withoutQuote(bindSpendAction(doc, rawAction));
  const plan = describeSpend(doc, action);
  const textSpend = isTextSpend(action);
  const { nickname, resolution } = textSpend ? { nickname: estimate.model, resolution: '' } : modelLabel(doc, plan.kind);
  const budget = budgetOf(doc.settings);
  const after = round4(doc.spend.totalUsd + pendingUsdOf(ctx.session) + estimate.usd);
  const cost = costOf(ctx);
  const price = cost.approx(estimate.usd);
  // A governed user never reads dollars: the budget line says what happens, not the sums.
  const overBudget = reason === 'budget' && budget !== undefined
    ? cost.governed
      ? '. That would go over the budget set for this comic.'
      : `. That would bring this comic to ${formatUsd(after)} — over your ${formatUsd(budget)} budget.`
    : '.';
  const summary = `${plan.what}${textSpend ? '' : ` on ${nickname} (${resolution})`} · ${price}${overBudget}`;
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
  const cards: Card[] = [];
  // The user sees what they approve (decisions-final #3): the breakdown of the bound pages above the gate.
  if (action.type === 'render_pages') {
    // The cover tile shows only when the quote includes it (an already drawn, current cover is not re-quoted).
    const cover = !!action.includeCover && coverWanted(doc, action.force);
    cards.push({ type: 'breakdown', id: newId('card'), pageIds: action.pageIds || [], cover, view: 'cost', gateId: gate.id });
  }
  cards.push({ type: 'gate', id: newId('card'), gateId: gate.id });
  commitAs(ctx, [{ op: 'gate', gate }], originOf(opts));
  const onModel = textSpend ? '' : ` on ${nickname}`;
  const text = (() => {
    switch (reason) {
      case 'budget':
        return `This would go over your budget: ${price} for ${plan.what}. Approve to go over, or raise the budget.`;
      case 'first_render':
        return `Before the first drawing, here's exactly what I'll draw: ${plan.what}${onModel}, ${price}. Approve to start, or change anything first.`;
      case 'plan_review':
        return `Here's the plan I'd draw: ${plan.what}${onModel}, ${price}. Approve to draw it, or edit any page first.`;
      case 'redraw':
        return `That's already drawn and up to date — a new take of ${plan.what} costs ${price}. Approve to redraw.`;
      case 'no_intent':
        return `I can draw ${plan.what} for ${price}${onModel} — tap Approve if you want it.`;
      default:
        return extra.staleFrom !== undefined
          ? `The price changed since that button was shown: ${plan.what} is now ${price} (was ${cost(extra.staleFrom)}). Approve to go ahead.`
          : `Ready when you are: ${price} for ${plan.what}${onModel}.`;
    }
  })();
  deliver(ctx, opts, text, cards);
  const message = (() => {
    switch (reason) {
      case 'budget':
        return cost.governed
          ? `Over budget: ${plan.what} (${price}) would go over this comic's budget. Waiting for the user to approve or raise the budget.`
          : `Over budget: ${plan.what} (${price}) would take the comic to ${formatUsd(after)} (budget ${formatUsd(budget || 0)}). Waiting for the user to approve or raise the budget.`;
      case 'first_render':
        return `Quoted ${price} for ${plan.what} — the first drawing of this comic waits for the user's approval (the breakdown is shown).`;
      case 'plan_review':
        return `Quoted ${price} for ${plan.what} — the plan is still a draft, so the user reviews it and approves (the breakdown is shown).`;
      case 'redraw':
        return `Quoted ${price} for a new take of ${plan.what} — it is already drawn and current, so the user must approve the redraw.`;
      case 'no_intent':
        return `Quoted ${price} — waiting for the user (they didn't ask to draw).`;
      default:
        return `Waiting for the user to approve ${cost.governed ? price : `~${formatUsd(estimate.usd)}`} (${plan.what}${onModel}).`;
    }
  })();
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
      // An image exists but didn't pass the content check: never "render it first" (it IS drawn) — say why and what works.
      if (page.render.asset?.path && !canServeToOwner(page.render.asset)) {
        return `Page ${page.n}'s current take didn't pass the content check, so it can't be edited — redraw it safer instead (or pick an earlier version in its history).`;
      }
      if (page.render.status !== 'ready' || !page.render.asset?.path) throw badRequest(`Page ${page.n} has no image to edit yet — draw it first.`);
      if (!clean(action.instruction, 2000)) throw badRequest('Say what to change on the page.');
      return null;
    }
    default:
      return null;
  }
};

/** Whether this spend would replace a ready, current image (a director redraw always gates). */
const replacesCurrentArt = (doc: ComicDoc, action: SpendAction): boolean => {
  switch (action.type) {
    case 'render_pages':
      return (
        !!action.force &&
        (pageTargets(doc, action).some((p) => p.render.status === 'ready' && !isPageStale(doc, p)) ||
          (!!action.includeCover && doc.cover.render.status === 'ready' && !coverNeedsDraw(doc)))
      );
    case 'render_sheets':
      return !!action.force && sheetTargets(doc, action).characters.some((c) => c.sheet.status === 'ready' && !isTargetStale(doc, { kind: 'sheet', id: c.id }));
    case 'render_cover':
      return doc.cover.render.status === 'ready' && !!doc.cover.render.asset && !coverNeedsDraw(doc);
    default:
      return false;
  }
};

/** The quote for a single new take of one page / the cover (chip prices). */
const quoteOf = (doc: ComicDoc, action: SpendAction, byok: boolean) => estimateSpendAction(doc, action, byok).usd;

/** A spend that would draw nothing: what exists, what's next ($0). */
const nothingToDraw = (doc: ComicDoc, action: SpendAction, byok: boolean, cost: CostFormatter): { message: string; steps: NextStep[]; breakdown: boolean } => {
  if (action.type === 'render_sheets') {
    return { message: 'All character sheets are already drawn and up to date — nothing was spent.', steps: nextStepsFor(doc, { byok }), breakdown: false };
  }
  if (action.type !== 'render_pages') return { message: 'Nothing to draw right now — nothing was spent.', steps: nextStepsFor(doc, { byok }), breakdown: false };
  const ids = action.pageIds?.length ? new Set(action.pageIds) : null;
  const asked = doc.pages.filter((p) => !ids || ids.has(p.id)).sort((a, b) => a.n - b.n);
  const busy = asked.filter((p) => isBusy(p.render));
  const empty = asked.filter((p) => !p.panels.length);
  const ready = asked.filter((p) => p.render.status === 'ready' && !isPageStale(doc, p));
  const parts: string[] = [];
  // Pages the request named that are no longer in the plan (deleted since the quote): say so by their old number.
  const gone = ids ? [...ids].filter((id) => !doc.pages.some((p) => p.id === id)) : [];
  if (gone.length) {
    const numbers = gone.map((id) => trashOf(doc).find((t) => t.page.id === id)?.fromN).filter((n): n is number => typeof n === 'number');
    const label = numbers.length === gone.length ? capitalize(pagesPhrase(numbers.map((n) => ({ n })))) : gone.length === 1 ? 'The page you approved' : `${gone.length} of the pages you approved`;
    parts.push(`${label} ${gone.length === 1 ? 'is' : 'are'} no longer in the plan.`);
  }
  if (ready.length) {
    parts.push(
      ready.length === doc.pages.length && !ids
        ? `Every page is already drawn and up to date (${plural(ready.length, 'page')}).`
        : `${ready.length === 1 ? `Page ${ready[0].n} is` : `${capitalize(pagesPhrase(ready))} are`} already drawn and up to date.`
    );
    const multi = ready.filter((p) => versionsOf(p.render).length > 1);
    if (multi.length) parts.push(`${multi.length === 1 ? `Page ${multi[0].n} has ${versionsOf(multi[0].render).length} versions` : `${capitalize(pagesPhrase(multi))} have earlier versions`} you can switch between for free.`);
  }
  if (busy.length) parts.push(`${capitalize(pagesPhrase(busy))} ${busy.length === 1 ? 'is' : 'are'} still drawing.`);
  if (empty.length) parts.push(`${capitalize(pagesPhrase(empty))} ${empty.length === 1 ? 'has' : 'have'} no panels yet — write ${empty.length === 1 ? 'it' : 'them'} first.`);
  const cover = doc.cover.render;
  if (cover.status === 'ready') parts.push(coverNeedsDraw(doc) ? 'The cover is out of date.' : 'The cover is drawn too.');
  else if (!isBusy(cover)) parts.push(`The cover isn't drawn yet (${cost.approx(quoteOf(doc, { type: 'render_cover' }, byok))}).`);
  parts.push('Nothing was spent.');
  const steps = nextStepsFor(doc, { byok });
  // "A new take" is the honest paid alternative (a click is a confirmation; the chip carries its quote).
  const first = ready[0];
  if (first) {
    const take: SpendAction = { type: 'render_pages', pageIds: [first.id], force: true };
    const usd = quoteOf(doc, take, byok);
    steps.push({ label: `New take of page ${first.n}`, action: { ...take, quotedUsd: usd }, usd });
  }
  return { message: parts.join(' '), steps: dedupeSteps(steps).slice(0, MAX_NEXT_STEPS), breakdown: true };
};

/**
 * Quality/model access: caps when given (contract §12.3), else the legacy qualityDenied text.
 * While billing is off there is no plan to buy: the denial says what IS included (P1-LIMITS).
 */
const qualityProblem = (ctx: StudioContext, opts: RunActionOptions, spec: ImageModelSpec): string | null => {
  const caps = opts.caps ?? ctx.caps;
  const doc = ctx.session.doc;
  if (caps) {
    const overridden = !!doc.settings.imageModelOverride && spec.id !== TIER_PRESETS[doc.settings.quality]?.model;
    if (overridden && !caps.modelOverride) {
      return BILLING_ENABLED
        ? `${spec.nickname} is an advanced model for paid plans or your own key.`
        : `${spec.nickname} isn't part of your included usage yet — add your own Gemini/OpenRouter key in Settings → API keys to use it.`;
    }
    if (!caps.qualityTiers.includes(doc.settings.quality) && spec.id !== TIER_PRESETS.standard.model) {
      return BILLING_ENABLED ? `${capitalize(doc.settings.quality)} quality needs a paid plan or your own key.` : PRO_QUALITY_USAGE_MESSAGE;
    }
    return null;
  }
  const qualityDenied = opts.qualityDenied ?? (ctx as OrchestratorContext).qualityDenied;
  // Anything other than the everyday model (Pro, or an advanced override such as
  // GPT Image / FLUX / Seedream) is a paid-plan feature on the platform key.
  return qualityDenied && spec.id !== TIER_PRESETS.standard.model ? qualityDenied : null;
};

async function startSpend(ctx: StudioContext, action: SpendAction, opts: RunActionOptions): Promise<StartedAction> {
  // The page re-check is TEXT-priced (one vision call, no image): its own runner, same gate.
  if (action.type === 'recheck_page') return startRecheck(ctx, action, opts);
  const doc = ctx.session.doc;
  const problem = validateSpendAction(doc, action);
  if (problem) return blocked(ctx, opts, problem, 'info');

  const plan = describeSpend(doc, action);
  const { spec } = modelLabel(doc, plan.kind);
  if (!ctx.keys.openrouter?.key && !ctx.keys.gemini?.key) {
    return blocked(ctx, opts, 'Connect a Gemini or OpenRouter key in Settings → API keys to draw images.', 'error');
  }
  const picked = imageRouteFor(spec, ctx.keys);
  if (!picked) {
    return blocked(ctx, opts, `${spec.nickname} needs ${spec.routes.openrouter ? 'an OpenRouter' : 'a Gemini'} key. Add one in Settings → API keys.`, 'error');
  }
  const denied = qualityProblem(ctx, opts, spec);
  if (denied) {
    return blocked(ctx, opts, /\bStandard\b/.test(denied) ? denied : `${denied} Switch to Standard quality to keep going.`, 'warn', [
      { label: 'Switch to Standard quality', action: { type: 'patch', ops: [{ op: 'settings', patch: { quality: 'standard' } }] }, usd: 0 }
    ]);
  }

  // Priced for the key that will draw (the quote, the markup and the reserve agree).
  const byok = picked.byok;
  const estimate = estimateSpendAction(doc, action, byok);
  if (estimate.imageCount <= 0) {
    // Everything requested is ready and current (R1): $0, with what exists and what's next.
    const nothing = nothingToDraw(doc, action, byok, costOf(ctx));
    const cards: Card[] = nothing.breakdown
      ? [{ type: 'breakdown', id: newId('card'), view: 'status', cover: true, ...(action.type === 'render_pages' && action.pageIds?.length ? { pageIds: action.pageIds } : {}) }]
      : [noticeCard('info', nothing.message)];
    deliver(ctx, opts, nothing.message, cards, nothing.steps);
    return finished({ status: 'nothing', message: nothing.message, nextSteps: nothing.steps });
  }

  const stale = opts.confirmed && quoteIsStale(action.quotedUsd, estimate);
  const reason = gateDecision(doc, estimate, opts.confirmed && !stale, {
    budgetApproved: opts.budgetApproved,
    pendingUsd: pendingUsdOf(ctx.session),
    priorUsd: opts.priorUsd,
    forceGate: stale ? 'policy' : opts.forceGate,
    redraw: !opts.confirmed && replacesCurrentArt(doc, action),
    action
  });
  if (reason) return createGate(ctx, action, estimate, reason, opts, { staleFrom: stale ? (action.quotedUsd as number) : opts.staleFrom });

  // Proceeding: retire any open gate for the same kind of spend (it is now moot).
  const open = ctx.session.doc.gate;
  if (open?.status === 'open' && open.action.type === action.type) commitAs(ctx, [{ op: 'gate', gate: { ...open, status: 'declined' } }], 'job');

  // Pin the model/quality now so mid-run settings changes can't move this spend off the
  // quoted/authorised price (the latest sheets and pages are still used — see prepare()).
  const pinned: Pick<Settings, 'quality' | 'imageModelOverride'> = { quality: doc.settings.quality, imageModelOverride: doc.settings.imageModelOverride };
  const runner = new RenderRun(ctx, estimate, pinned, opts, byok);
  runner.reserve();
  const message = `Started drawing ${plan.what} (${costOf(ctx).approx(estimate.usd)} on ${spec.nickname}). They appear on the board as they finish; I'll post when they're ready.`;
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
      done = runner.cover(action);
      break;
    default:
      throw badRequest('Unknown spend action.');
  }
  return { outcome: { status: 'started', message, estimate }, done: done.catch(() => undefined).finally(() => runner.releaseReservation()) };
}

/**
 * recheck_page (lettering.md §9): the PAID re-read of a drawn page — one vision call (QC, faces,
 * speakers' heads), then the balloons are re-laid around the art. Gated, budgeted and refused for
 * restricted accounts like every spend (the route refuses SpendActions); never runs without a key,
 * on a busy page, on an undrawn page or on art that didn't pass the content check. Honest outcome:
 * the message says what ran and what it cost, read from the ledger, not assumed.
 */
async function startRecheck(ctx: StudioContext, action: Extract<SpendAction, { type: 'recheck_page' }>, opts: RunActionOptions): Promise<StartedAction> {
  const doc = ctx.session.doc;
  const page = typeof action.pageId === 'string' ? findPage(doc, action.pageId) : undefined;
  if (!page) throw badRequest('That page is no longer in the plan.');
  if (isBusy(page.render)) return blocked(ctx, opts, `Page ${page.n} is still drawing — re-check it when it's done.`, 'info');
  const asset = page.render.status === 'ready' ? page.render.asset : undefined;
  if (!asset?.path) {
    return blocked(ctx, opts, `Page ${page.n} isn't drawn yet, so there is nothing to re-check — its balloons are placed from the layout for free.`, 'info');
  }
  if (!canServeToOwner(asset)) {
    return blocked(ctx, opts, `Page ${page.n}'s current take didn't pass the content check, so it can't be re-checked — redraw it safer instead.`, 'warn');
  }
  const visionRoute = resolveTextRoute('vision', ctx.keys);
  if (!visionRoute) return blocked(ctx, opts, 'Connect a Gemini or OpenRouter key in Settings → API keys to re-check pages.', 'error');

  // A text spend: priced for the key the vision call runs on (text routes OpenRouter-first).
  const byok = visionRoute.key.byok;
  const estimate = estimateSpendAction(doc, action, byok);
  const stale = opts.confirmed && quoteIsStale(action.quotedUsd, estimate);
  const reason = gateDecision(doc, estimate, opts.confirmed && !stale, {
    budgetApproved: opts.budgetApproved,
    pendingUsd: pendingUsdOf(ctx.session),
    priorUsd: opts.priorUsd,
    forceGate: stale ? 'policy' : opts.forceGate,
    action
  });
  if (reason) return createGate(ctx, action, estimate, reason, opts, { staleFrom: stale ? (action.quotedUsd as number) : opts.staleFrom });
  const open = ctx.session.doc.gate;
  if (open?.status === 'open' && open.action.type === action.type) commitAs(ctx, [{ op: 'gate', gate: { ...open, status: 'declined' } }], 'job');

  const cost = costOf(ctx);
  // What THIS re-check cost, read from its own ledger entry (other runs may spend meanwhile).
  const entriesBefore = new Set(ctx.session.doc.spend.entries.map((e) => e.id));
  addPending(ctx.session, estimate.usd);
  const notices: Card[] = [];
  let out: LetterResult = { visionRan: false };
  try {
    let dataUrl: string;
    try {
      dataUrl = await ctx.assets.loadDataUrl(asset.path);
    } catch (err) {
      logger.warn('comic_recheck_load_failed', { projectId: ctx.projectId, pageId: page.id, message: (err as Error)?.message });
      return blocked(ctx, opts, `I couldn't load page ${page.n}'s image to re-check it — nothing was spent. Try again in a moment.`, 'error');
    }
    out = await letterPage(ctx, page.id, dataUrl, ctx.session.abort.signal, (card) => notices.push(card), { forceVision: true });
  } finally {
    addPending(ctx.session, -estimate.usd);
  }
  const spent = round4(
    ctx.session.doc.spend.entries.reduce((sum, e) => (!entriesBefore.has(e.id) && e.kind === 'qc' && e.label === `Check page ${page.n}` ? sum + (e.usd || 0) : sum), 0)
  );
  const qc = findPage(ctx.session.doc, page.id)?.render.qc;
  const faces = qc?.keepOut?.some((k) => k.kind === 'face');
  const overlay = ctx.session.doc.format.lettering !== 'in_art';
  const message = out.visionRan
    ? `Re-checked page ${page.n} (${cost(spent || estimate.usd)})${overlay ? ` and re-laid its balloons around the art${faces ? ', keeping faces clear' : ''}` : ''}.${typeof qc?.score === 'number' ? ` Page check score: ${qc.score.toFixed(2)}.` : ''}`
    : out.visionError?.code === 'BILLING_DENIED'
      ? // Usage left / a spending limit said no: say THAT (its message is already in the user's terms), not "try later".
        `${out.visionError.userMessage.replace(/[.!]?\s*$/, '.')} ${overlay ? `Page ${page.n}'s balloons were re-laid from the stored layout instead` : `Page ${page.n} is unchanged`} — nothing was spent.`
      : `The re-check of page ${page.n} couldn't run just now${overlay ? ', so its balloons were re-laid from the stored layout instead' : ''}${spent ? ` (${cost(spent)} was spent on the attempt)` : ' — nothing was spent'}.`;
  deliver(ctx, opts, message, notices.length ? notices : [noticeCard(out.visionRan ? 'success' : 'warn', message)]);
  return finished({ status: 'done', message });
}

// ── Render run ───────────────────────────────────────────────────────────────

interface CompileOpts {
  /** Safe take: one notch gentler (safety.md §3.2). */
  safe?: boolean;
  /**
   * Rating CEILING for the art (the account-age ceiling): the compilers take min(effectiveRating(doc), rating),
   * so a kids comic is never drawn above PG whatever is passed (P1-RENDER).
   */
  rating?: ContentRating;
}

interface ImageJob {
  target: RenderTarget;
  kind: ImageJobKind;
  spend: SpendKind;
  /** Spend/ledger label ("Page 3"). */
  label: string;
  /** Live status line ("Drawing page 3"). */
  activityLabel: string;
  /** Compile against the CURRENT doc (so freshly drawn sheets/pages are used). */
  compile: (doc: ComicDoc, opts: CompileOpts) => CompiledImageJob;
  /** Render state before this run touched it (restored on cancel). */
  prev: { status: RenderState['status']; error?: string; hasAsset: boolean };
  /** Failure keeps the previous status (edits: the existing page is still good). */
  keepStatusOnFailure?: boolean;
  region?: Box;
  /** Page id to QC + letter after the image lands. */
  qcPageId?: string;
  /** Implicit request (draw what is missing or out of date): reuse rules R2/R3/R7 apply. */
  implicit: boolean;
  /** Start with the safe-take compile (explicit "Redraw safer"). */
  safe?: boolean;
  /** Edit instruction / redraw note recorded on the version. */
  note?: string;
  /** Doc view this job compiles and hashes against (textless cover). */
  docFor?: (doc: ComicDoc) => ComicDoc;
  /** Ops committed together with the new asset (textless cover → overlay title). */
  landedOps?: () => DocOp[];
  /** Already re-queued once after a provider rate limit. */
  requeued?: boolean;
}

interface JobResult {
  job: ImageJob;
  ok: boolean;
  skipped?: boolean;
  error?: string;
  /** Reused for free (R2/R3/R7): what drawing it would have cost. */
  savedUsd?: number;
  /** Which reuse rule put it there (the completion says it honestly). */
  reuse?: 'R2' | 'R3' | 'R7';
  /** Drawn, but the content check blocked it. */
  blocked?: boolean;
  /** …and the previous version is current again. */
  previousBack?: boolean;
  /** Came back in another shape ("1:1"), requested `want`. */
  aspect?: { got: AspectRatio; want: AspectRatio };
  /** The provider rate-limited it (even if a retry worked). */
  rateLimited?: boolean;
  /** "OpenRouter · 429 · 17:42 UTC" — sanitized, for the completion message. */
  detail?: string;
  /** Drawn on the safe-take retry after the image model's filter declined the first take. */
  saferTake?: boolean;
}

type DrawOutcome = { kind: 'done' } | { kind: 'requeue'; afterMs: number };

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

/** Paths that can never be sent to an image model: blocked or quarantined by the content check. */
const blockedPaths = (doc: ComicDoc): Set<string> => {
  const out = new Set<string>();
  mapAssetRefs(doc, (a) => {
    if (a?.path && !canServeToOwner(a)) out.add(a.path);
    return a;
  });
  return out;
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
    .filter((p) => p.n < page.n && p.render.status === 'ready' && p.render.asset?.path && canServeToOwner(p.render.asset))
    .sort((a, b) => b.n - a.n)[0];

/** Every user reference path (style, cast, places) — the fallback for VersionMeta.refPaths when a compiler reports none. */
const userRefPaths = (doc: ComicDoc): Set<string> =>
  new Set([...doc.style.refs, ...doc.cast.flatMap((c) => c.refs), ...doc.places.flatMap((p) => p.refs)].map((r) => r.path).filter(Boolean));

/**
 * Unchecked user uploads among these paths (safety.md §3.2 lazy check): uploaded refs with no safety
 * verdict, AND model sheets with source 'upload' and no verdict — a sheet brought back by Undo of a
 * character / place removal (restoredRef: its provenance can't be proven, so it comes back as an
 * upload with no verdict). A sheet the runner drew itself keeps source 'generated' and its own check.
 */
const uncheckedRefs = (doc: ComicDoc, paths: string[]): RefAssetLike[] => {
  const wanted = new Set(paths);
  const out: RefAssetLike[] = [];
  const seen = new Set<string>();
  const sheets = [...doc.cast.map((c) => c.sheet?.asset), ...doc.places.map((p) => p.sheet?.asset)];
  for (const r of [...doc.style.refs, ...doc.cast.flatMap((c) => c.refs), ...doc.places.flatMap((p) => p.refs), ...sheets]) {
    if (!r?.path || seen.has(r.path) || !wanted.has(r.path)) continue;
    seen.add(r.path);
    if (r.source !== 'upload' || r.safety) continue;
    out.push(r as RefAssetLike);
  }
  return out;
};
type RefAssetLike = ComicDoc['cast'][number]['refs'][number];

/** Lazy checks in flight per session (two parallel pages sharing a photo check it once). */
const refChecks = new WeakMap<StudioSessionApi, Map<string, Promise<'allow' | 'block' | 'unavailable'>>>();

class RenderRun {
  private readonly session: StudioSessionApi;
  /** Captured at start: only an explicit cancel stops this run (not a closed tab). */
  private readonly signal: AbortSignal;
  private readonly slots: Semaphore;
  private readonly inflight: InflightJobs;
  private readonly results: JobResult[] = [];
  private readonly notices: Card[] = [];
  /** Chips this run adds in front of the doc-state next steps (aspect fixes, fresh takes). */
  private readonly extraSteps: NextStep[] = [];
  private stopReason: string | null = null;
  private spentUsd = 0;
  private savedUsd = 0;
  /** Estimate still held as pending spend (released as images land or the run ends). */
  private reservedLeft = 0;
  private progressId: string | null = null;
  private progressCard: Extract<Card, { type: 'renders' }> | null = null;
  /** The live progress card sits in the director's message; the completion is appended. */
  private hosted = false;
  /**
   * The director's message can still take the card: false once the run awaited anything before
   * its progress card (style directions proposed by the writer) — the reply may be committed by then.
   */
  private hostable = true;
  /** A late director run's own progress message, committed after the director's reply. */
  private progressPosted: Promise<void> | null = null;
  private readonly started = Date.now();
  /** One image at a time after the provider rate-limited this run (incident 2026-10-22). */
  private serial = false;
  private inFlight = 0;
  private turnWaiters: (() => void)[] = [];
  /** Prices in this user's terms (governed users read usage, never dollars). */
  private readonly cost: CostFormatter;

  constructor(
    private readonly ctx: StudioContext,
    private readonly estimate: SpendEstimate,
    private readonly pinned: Pick<Settings, 'quality' | 'imageModelOverride'>,
    private readonly opts: RunActionOptions,
    private readonly byok: boolean
  ) {
    this.session = ctx.session;
    this.signal = ctx.session.abort.signal;
    this.slots = slotsFor(ctx.session);
    this.inflight = inflightFor(ctx.session);
    this.cost = costOf(ctx);
    this.signal.addEventListener('abort', this.onAbort, { once: true });
  }

  /** Compile options for every compiler: the safe take and the account's rating ceiling (the compiler takes the minimum). */
  private compileOpts(opts: CompileOpts): CompileOpts {
    const rating = this.ctx.caps?.ratingCeiling ?? this.ctx.rating;
    return { ...(opts.safe ? { safe: true } : {}), ...(rating ? { rating } : {}) };
  }

  /** Waiters for a serial turn give up on cancel (removed when the run ends: no listener build-up per session). */
  private readonly onAbort = () => this.wakeTurns();

  /** Hold this run's estimate as pending spend so a concurrent budget check counts it. */
  reserve() {
    this.reservedLeft = this.estimate.usd;
    addPending(this.session, this.reservedLeft);
  }

  /** Give back whatever estimate never landed (run failed, cancelled, or had no jobs). Called once the run is over. */
  releaseReservation() {
    if (this.reservedLeft > 0) addPending(this.session, -this.reservedLeft);
    this.reservedLeft = 0;
    this.signal.removeEventListener('abort', this.onAbort);
  }

  /** Release part of the pending reservation (a reuse that cost nothing). */
  private releaseShare(usd: number) {
    const share = Math.min(Math.max(0, usd), this.reservedLeft);
    if (share > 0) {
      this.reservedLeft = round4(this.reservedLeft - share);
      addPending(this.session, -share);
    }
  }

  /** What one image of this job would cost at the pinned quality (savedUsd, reservation shares, chip quotes). */
  private priceOf(kind: ImageJobKind): number {
    return estimateJobs([{ kind, count: 1 }], this.pinned.quality, { override: this.pinned.imageModelOverride, byok: this.byok }).usd;
  }

  private commit(ops: DocOp[], label?: string) {
    return commitAs(this.ctx, ops, 'job', label);
  }

  /** A spend chip always carries its quote (a tap is the confirmation; a stale quote re-gates instead of overspending). */
  private priced(step: NextStep): NextStep {
    const action = step.action;
    if (!action || !isSpendAction(action) || typeof action.quotedUsd === 'number' || actionHandlerFor(action.type)) return step;
    const usd = estimateSpendAction(this.session.doc, action, this.byok).usd;
    return { ...step, action: { ...action, quotedUsd: usd }, usd };
  }

  /** A job message in the user's terms (the governed-dollars safety net). */
  private message(msg: Msg): Msg {
    return governMsg(this.ctx, msg);
  }

  // ── Action bodies ─────────────────────────────────────────────────────────

  async pages(action: Extract<SpendAction, { type: 'render_pages' }>): Promise<void> {
    const doc = this.session.doc;
    const pages = pageTargets(doc, action);
    const sheets = missingSheetsFor(doc, pages);
    const sheetJobs = sheets.map((c) => this.sheetJob(c, false));
    const pageJobs = pages.map((p) => this.pageJob(p, action));
    const coverJob = action.includeCover && coverWanted(doc, action.force) ? this.coverJob({ type: 'render_cover', ...(action.safe ? { safe: true } : {}) }, !!action.force) : null;
    const jobs = [...sheetJobs, ...pageJobs, ...(coverJob ? [coverJob] : [])];
    const label = `Drawing ${[pages.length ? pagesPhrase(pages) : '', coverJob ? 'the cover' : ''].filter(Boolean).join(' and ') || 'the pages'}`;
    await this.run(jobs, label, async () => {
      this.ensureStyle();
      if (this.session.doc.planStatus === 'draft') this.commit([{ op: 'plan_status', status: 'approved' }]);
      // Sheets first: every page uses them as identity anchors.
      await Promise.all(sheetJobs.map((j) => this.runJob(j)));
      // Page 1 alone: the continuity anchor for the rest; the cover can then use it too.
      const [first, ...rest] = pageJobs;
      if (first) await this.runJob(first);
      await Promise.all([...rest.map((j) => this.runJob(j)), ...(coverJob ? [this.runJob(coverJob)] : [])]);
    });
  }

  async sheets(action: Extract<SpendAction, { type: 'render_sheets' }>): Promise<void> {
    const { characters, places } = sheetTargets(this.session.doc, action);
    const jobs = [...characters.map((c) => this.sheetJob(c, !!action.force)), ...places.map((p) => this.placeJob(p, !!action.force))];
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

  async cover(action: Extract<SpendAction, { type: 'render_cover' }>): Promise<void> {
    const doc = this.session.doc;
    const explicit = doc.cover.render.status === 'ready' && !coverNeedsDraw(doc);
    const job = this.coverJob(action, explicit);
    await this.run([job], action.textless ? 'Drawing a textless cover' : 'Drawing the cover', async () => {
      this.ensureStyle();
      await this.runJob(job);
    });
  }

  async styleOptions(action: Extract<SpendAction, { type: 'render_style_options' }>): Promise<void> {
    const end = activity(this.ctx, 'Finding style directions', 'text');
    let directions: { name: string; spec: string }[];
    try {
      directions = sanitizeDirections(action.directions);
      if (!directions.length) {
        // The writer call is awaited before the progress card exists: too late to ride the reply.
        this.hostable = false;
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
      await this.post(`I couldn't come up with style directions: ${error.userMessage}`, [noticeCard('error', error.userMessage)]);
      return;
    }
    if (!directions.length) {
      await this.post("I couldn't come up with style directions this time — pick a preset in Style instead.", [noticeCard('warn', 'No usable style directions came back.')]);
      return;
    }
    // Another batch committed while we were proposing: never clear options being paid for.
    if (this.session.doc.style.options.some((o) => isBusy(o.render))) {
      await this.post('Another set of style options is already drawing — pick from those, then ask for more if none fits.', [noticeCard('info', 'Style options are already drawing.')]);
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
    this.commit([
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
        compile: (doc, opts) => {
          const option = doc.style.options.find((x) => x.id === o.id);
          if (!option) throw badRequest('That style option was replaced.');
          return compileStyleOption(doc, option, this.compileOpts(opts));
        },
        prev: { status: 'none', hasAsset: false },
        implicit: true
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

  private sheetJob(c: Character, force: boolean): ImageJob {
    return {
      target: { kind: 'sheet', id: c.id },
      kind: 'sheet',
      spend: 'sheet',
      label: `Sheet: ${c.name}`,
      activityLabel: `Drawing ${c.name}'s sheet`,
      compile: (doc, opts) => {
        const current = findCharacter(doc, c.id);
        if (!current) throw badRequest(`${c.name} is no longer in the cast.`);
        return compileCharacterSheet(doc, current, this.compileOpts(opts));
      },
      prev: this.prevOf({ kind: 'sheet', id: c.id }),
      implicit: !force,
      ...(force ? { note: 'New take' } : {})
    };
  }

  private placeJob(p: Place, force: boolean): ImageJob {
    return {
      target: { kind: 'place', id: p.id },
      kind: 'place',
      spend: 'sheet',
      label: `Location: ${p.name}`,
      activityLabel: `Drawing ${p.name}`,
      compile: (doc, opts) => {
        const current = findPlace(doc, p.id);
        if (!current) throw badRequest(`${p.name} is no longer a location.`);
        return compilePlaceSheet(doc, current, this.compileOpts(opts));
      },
      prev: this.prevOf({ kind: 'place', id: p.id }),
      implicit: !force,
      ...(force ? { note: 'New take' } : {})
    };
  }

  private pageJob(p: Page, action: Extract<SpendAction, { type: 'render_pages' }>): ImageJob {
    return {
      target: { kind: 'page', id: p.id },
      kind: 'page',
      spend: 'page',
      label: `Page ${p.n}`,
      activityLabel: `Drawing page ${p.n}`,
      compile: (doc, opts) => {
        const page = findPage(doc, p.id);
        if (!page) throw badRequest(`Page ${p.n} is no longer in the plan.`);
        return compilePage(doc, page, { previousPage: nearestReadyBefore(doc, page), ...this.compileOpts(opts) });
      },
      prev: this.prevOf({ kind: 'page', id: p.id }),
      qcPageId: p.id,
      implicit: !action.force && !action.safe,
      ...(action.safe ? { safe: true, note: 'Safer take' } : action.force ? { note: 'New take' } : {})
    };
  }

  private coverJob(action: Extract<SpendAction, { type: 'render_cover' }>, explicit: boolean): ImageJob {
    const textless = !!action.textless;
    return {
      target: { kind: 'cover' },
      kind: 'cover',
      spend: 'cover',
      label: 'Cover',
      activityLabel: textless ? 'Drawing a textless cover' : 'Drawing the cover',
      // docFor sets cover.lettering='overlay' too, so the spec hash and the TEXTLESS COVER line agree.
      compile: (doc, opts) => compileCover(doc, { ...this.compileOpts(opts), ...(textless ? { textless: true } : {}) }),
      prev: this.prevOf({ kind: 'cover' }),
      implicit: !explicit && !textless && !action.safe,
      ...(action.safe ? { safe: true, note: 'Safer take' } : textless ? { note: 'Textless cover' } : explicit ? { note: 'New take' } : {}),
      ...(textless
        ? {
            docFor: (doc: ComicDoc): ComicDoc => ({ ...doc, cover: { ...doc.cover, lettering: 'overlay' } }),
            landedOps: (): DocOp[] => [{ op: 'cover', patch: { lettering: 'overlay' } }]
          }
        : {})
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
      compile: (doc, opts) => {
        const page = findPage(doc, p.id);
        if (!page) throw badRequest(`Page ${p.n} is no longer in the plan.`);
        return compileEdit(doc, page, { instruction, ...(panelN !== undefined ? { panelN } : {}), hasRegion: !!region, ...this.compileOpts(opts) });
      },
      prev: this.prevOf({ kind: 'page', id: p.id }),
      keepStatusOnFailure: true,
      ...(region ? { region } : {}),
      qcPageId: p.id,
      implicit: false,
      note: instruction,
      ...(action.safe ? { safe: true } : {})
    };
  }

  // ── Orchestration ─────────────────────────────────────────────────────────

  /**
   * Queue every target, show the progress card, run `body`, then make sure nothing is left
   * queued/rendering and post the real outcome.
   */
  private async run(jobs: ImageJob[], label: string, body: () => Promise<void>): Promise<void> {
    if (!jobs.length) return;
    const at = Date.now();
    this.commit(jobs.map((j): DocOp => ({ op: 'render', target: j.target, patch: { status: 'queued', error: undefined, updatedAt: at } })));
    this.startProgress(jobs, label);
    const end = activity(this.ctx, label, 'image');
    try {
      await body();
    } catch (err) {
      const error = asStudioError(err);
      if (error.code !== 'CANCELLED') this.notices.push(noticeCard('error', error.userMessage));
    } finally {
      this.settleLeftovers(jobs);
      end(this.results.some((r) => r.ok) && !this.results.some((r) => !r.ok && !r.skipped));
      try {
        await this.finishProgress(jobs);
      } catch (err) {
        logger.error('comic_render_finish_failed', { projectId: this.ctx.projectId, message: (err as Error)?.message });
      }
    }
  }

  /**
   * Director turns: the live `renders` card goes INTO the director's message (no message is
   * committed now). UI clicks: a progress message right after the click.
   */
  private startProgress(jobs: ImageJob[], label: string) {
    this.progressCard = { type: 'renders', id: newId('card'), targets: jobs.map((j) => j.target), label };
    if (this.opts.collectCard && this.hostable) {
      this.hosted = true;
      this.opts.collectCard(this.progressCard);
      return;
    }
    const msg = this.message(assistantMessage(`${label} (${this.cost.approx(this.estimate.usd)}).`, [this.progressCard]));
    this.progressId = msg.id;
    if (this.opts.collectCard) {
      // A director run that started late (after the writer proposed style directions): the card
      // gets its own progress message — below the director's reply, never above it.
      this.progressPosted = this.afterTurn(() => this.commit([{ op: 'message', msg: { ...msg, at: Date.now() } }]));
      return;
    }
    this.commit([{ op: 'message', msg }]);
  }

  /**
   * Run `fn` after any director turn that is still writing its reply, so a completion can
   * never land above the message that started it. Bounded: never waits forever on a lock.
   */
  private async afterTurn(fn: () => void): Promise<void> {
    const s = this.session as StudioSessionApi & { runExclusive?: <T>(work: () => Promise<T>) => Promise<T>; turnRunning?: boolean };
    if (typeof s.runExclusive !== 'function' || !s.turnRunning) return fn();
    let ran = false;
    const once = () => {
      if (ran) return;
      ran = true;
      fn();
    };
    const timer = delay(JOB_TIMINGS.turnLockWaitMs);
    await Promise.race([s.runExclusive(async () => once()), timer.promise.then(once)]);
    timer.cancel();
  }

  /** Background work always posts its own message, after a running director turn's reply. */
  private async post(text: string, cards: Card[]) {
    await this.afterTurn(() => this.commit([{ op: 'message', msg: this.message(assistantMessage(text, cards, nextStepsFor(this.session.doc, { byok: this.byok }))) }]));
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
    if (ops.length) this.commit(ops);
  }

  /** The completion sentence(s): the real outcome, in plain words, with money spent and saved. */
  private outcomeText(jobs: ImageJob[]): string {
    const drawn = this.results.filter((r) => r.ok && !r.reuse && !r.blocked);
    const reused = this.results.filter((r) => r.ok && !!r.reuse);
    const blockedR = this.results.filter((r) => r.ok && r.blocked);
    const failed = this.results.filter((r) => !r.ok && !r.skipped);
    const skipped = this.results.filter((r) => r.skipped);
    const noun = (list: JobResult[]) => describeJobs(list.map((r) => r.job));
    const are = (list: JobResult[]) => (list.length === 1 ? 'is' : 'are');
    const parts: string[] = [];
    const total = jobs.length;
    if (drawn.length) {
      const partial = drawn.length < total && total > 1;
      parts.push(
        partial && drawn.every((r) => r.job.kind === 'page') && jobs.every((j) => j.kind === 'page')
          ? `${drawn.length} of ${total} pages are ready (${this.cost(this.spentUsd)}): ${noun(drawn)}.`
          : `${capitalize(noun(drawn))} ${are(drawn)} ready (${this.cost(this.spentUsd)}).`
      );
    } else if (this.spentUsd > 0) {
      parts.push(`Spent ${this.cost(this.spentUsd)} on attempts that didn't produce a usable image.`);
    }
    const safer = drawn.filter((r) => r.saferTake);
    if (safer.length) parts.push(`The first take of ${noun(safer)} tripped the image model's filter, so I drew ${safer.length === 1 ? 'it' : 'them'} a little tamer.`);
    const backFree = reused.filter((r) => r.reuse === 'R2');
    const copied = reused.filter((r) => r.reuse !== 'R2');
    // "saved ≈$0.07" (dollars) / "saved ≈2% of your usage" (governed: the words carry their own ≈).
    const savedOf = (list: JobResult[]) => {
      const usd = round4(list.reduce((s, r) => s + (r.savedUsd || 0), 0));
      return this.cost.governed ? this.cost(usd) : `≈${formatUsd(usd)}`;
    };
    if (backFree.length) {
      parts.push(
        `${capitalize(noun(backFree))} ${backFree.length === 1 ? 'is' : 'are'} back from an earlier version drawn from exactly this script — free (saved ${savedOf(backFree)}).`
      );
    }
    if (copied.length) parts.push(`${capitalize(noun(copied))} reused an identical earlier drawing — free (saved ${savedOf(copied)}).`);
    if (blockedR.length) {
      const back = blockedR.every((r) => r.previousBack);
      parts.push(`${capitalize(noun(blockedR))} didn't fit the content rules${back ? ', so the previous version is back' : ' and stays hidden'} — a safer redraw is one tap away.`);
    }
    const shapes = this.results.filter((r) => r.aspect);
    for (const r of shapes.slice(0, 2)) parts.push(`${r.job.label} came back ${r.aspect!.got} instead of ${r.aspect!.want}.`);
    if (failed.length) {
      const first = failed[0];
      const reason = first.error ? first.error.trim().replace(/[.!\s]+$/, '') : '';
      const limited = failed.filter((r) => r.rateLimited && r.job.requeued);
      parts.push(
        `${capitalize(noun(failed))} failed${reason ? ` — ${failed.length > 1 ? `${first.job.label}: ` : ''}${reason}` : ''}${first.detail ? ` [${first.detail}]` : ''}.`
      );
      if (limited.length) parts.push(`I already waited for the provider and tried ${limited.length === 1 ? 'it' : 'them'} once more.`);
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
    if (!drawn.length && !reused.length && !blockedR.length && !failed.length && !skipped.length) parts.push('Nothing was drawn.');
    if (failed.length && !this.stopReason) parts.push('Retry from the board or ask me to try again.');
    const doc = this.session.doc;
    const drewPages = [...drawn, ...reused].some((r) => r.job.kind === 'page');
    if (drewPages && !failed.length && doc.cover.render.status !== 'ready' && !isBusy(doc.cover.render) && !jobs.some((j) => j.kind === 'cover')) {
      parts.push('Want the cover next?');
    }
    return parts.join(' ');
  }

  /**
   * The real outcome as a message, with next steps computed AFTER the run. Director runs
   * append it (the reply above carries the live card); UI runs rewrite their progress message
   * in place while it is still the last message, else point to a new message below.
   */
  private async finishProgress(jobs: ImageJob[]) {
    if (!this.progressCard) return;
    const ok = this.results.filter((r) => r.ok);
    const failed = this.results.filter((r) => !r.ok && !r.skipped);
    const skipped = this.results.filter((r) => r.skipped);
    const styleRun = this.progressCard.targets.every((t) => t.kind === 'style_option');
    const outcome = this.outcomeText(jobs);
    const text =
      styleRun && ok.length
        ? `Here ${ok.length === 1 ? 'is a direction' : `are ${ok.length} directions`} for the look — tap one to lock it.${failed.length || skipped.length ? ` ${outcome}` : ''}`
        : outcome;
    // Render verdicts (P1-SAFETY): a blocked take's "Redraw it safer" / "Check again" chips and an
    // over-the-rating notice ride on THIS summary, so the run stays one message.
    const safety = takeRenderSafetyFollowups(this.session);
    if (safety.notices.length) this.notices.push(...safety.notices);
    const steps = dedupeSteps([...safety.steps.map((s) => this.priced(s)), ...this.extraSteps, ...nextStepsFor(this.session.doc, { byok: this.byok })]).slice(0, MAX_NEXT_STEPS);
    const lead: Card[] = styleRun && ok.length ? [{ type: 'style_choice', id: newId('card') }] : [];
    if (this.hosted) {
      await this.afterTurn(() => this.commit([{ op: 'message', msg: this.message(assistantMessage(text, [...lead, ...this.notices], steps)) }]));
    } else {
      if (this.progressPosted) await this.progressPosted;
      const conversation = this.session.doc.conversation;
      const current = conversation.find((m) => m.id === this.progressId);
      const isLast = !!current && conversation[conversation.length - 1]?.id === this.progressId;
      if (isLast || !current) {
        const msg = this.message(assistantMessage(text, [...(lead.length ? lead : [this.progressCard]), ...this.notices], steps));
        this.commit([{ op: 'message', msg: { ...msg, id: this.progressId!, ...(current ? { at: current.at } : {}) } }]);
      } else {
        // Other messages arrived meanwhile: keep the progress card where it was, point down, append the outcome.
        const pointer = `${this.progressCard.label} — finished (${this.cost(this.spentUsd)}); see below.`;
        this.commit([
          { op: 'message', msg: { ...current, text: pointer, cards: [this.progressCard] } },
          { op: 'message', msg: this.message(assistantMessage(text, [...lead, ...this.notices], steps)) }
        ]);
      }
    }
    logger.info('comic_render_run_finished', {
      projectId: this.ctx.projectId,
      ok: ok.length,
      failed: failed.length,
      skipped: skipped.length,
      reused: this.results.filter((r) => r.reuse).length,
      serial: this.serial,
      usd: this.spentUsd,
      savedUsd: this.savedUsd,
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
    this.commit([{ op: 'style', patch }]);
    this.notices.push(noticeCard('info', `No style was chosen yet, so I used “${preset.name}”. Pick another in Style any time.`));
  }

  // ── Serial mode (after a rate limit) ──────────────────────────────────────

  private async takeTurn(): Promise<void> {
    while (this.serial && this.inFlight > 0 && !this.signal.aborted) {
      await new Promise<void>((resolve) => this.turnWaiters.push(resolve));
    }
    this.inFlight += 1;
  }

  private endTurn() {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.wakeTurns();
  }

  private wakeTurns() {
    const waiters = this.turnWaiters.splice(0);
    waiters.forEach((w) => w());
  }

  private noteRateLimit(job: ImageJob) {
    if (this.serial) return;
    this.serial = true;
    logger.warn('comic_render_run_serial', { projectId: this.ctx.projectId, target: renderTargetKey(job.target) });
  }

  // ── One image ─────────────────────────────────────────────────────────────

  private restore(job: ImageJob) {
    const render = getRender(this.session.doc, job.target);
    if (render && isBusy(render)) {
      this.commit([{ op: 'render', target: job.target, patch: { status: restoredStatus(job.prev), error: job.prev.error, updatedAt: Date.now() } }]);
    }
    this.results.push({ job, ok: false, skipped: true });
  }

  /**
   * Mark a job failed. Status, error and the sanitized errorDetail travel in ONE patch (P2-AMEND:
   * a later patch that changes the status or the error without a detail drops it, by design).
   */
  private fail(job: ImageJob, message: string, attempts?: number, extra: Partial<JobResult> = {}, errorDetail?: RenderErrorDetail) {
    const status = job.keepStatusOnFailure ? restoredStatus(job.prev) : 'failed';
    this.commit([
      {
        op: 'render',
        target: job.target,
        patch: { status, error: message, updatedAt: Date.now(), ...(attempts ? { attempts } : {}), ...(errorDetail ? { errorDetail } : {}) }
      }
    ]);
    this.results.push({ job, ok: false, error: message, ...extra });
    if (job.keepStatusOnFailure) this.notices.push(noticeCard('error', `${job.label} didn't work: ${message}`));
  }

  private async runJob(job: ImageJob): Promise<void> {
    if (this.stopReason || this.signal.aborted) return this.restore(job);
    // R2: a version made from exactly today's spec comes back for free (no slot, no money).
    if (job.implicit && (await this.reuseSpecVersion(job))) return;
    let release: (() => void) | null = null;
    for (;;) {
      await this.takeTurn();
      try {
        release = await this.slots.acquire(this.signal);
      } catch {
        this.endTurn();
        return this.restore(job);
      }
      // The provider rate-limited this run while we waited for a slot: let the others finish first.
      if (this.serial && this.inFlight > 1 && !this.signal.aborted) {
        release();
        release = null;
        this.endTurn();
        continue;
      }
      break;
    }
    let outcome: DrawOutcome = { kind: 'done' };
    try {
      if (this.stopReason || this.signal.aborted) return this.restore(job);
      if (!getRender(this.session.doc, job.target)) {
        this.results.push({ job, ok: false, skipped: true });
        return;
      }
      outcome = await this.draw(job);
    } catch (err) {
      const error = asStudioError(err);
      this.fail(job, error.userMessage);
    } finally {
      release?.();
      this.endTurn();
    }
    if (outcome.kind === 'requeue') {
      // Incident follow-up: wait for the provider (Retry-After or 45 s, jittered, abortable), then once more.
      job.requeued = true;
      const seconds = Math.max(1, Math.round(outcome.afterMs / 1000));
      const end = activity(this.ctx, `Waiting for the provider… ${job.label.toLowerCase()} retries in ${seconds} s`);
      await sleep(outcome.afterMs, this.signal);
      end(!this.signal.aborted);
      if (this.signal.aborted || this.stopReason) return this.restore(job);
      return this.runJob(job);
    }
  }

  /** R2 for one job: put back a stored version made from the current spec. True when reused. */
  private async reuseSpecVersion(job: ImageJob): Promise<boolean> {
    const doc = this.session.doc;
    const match = findSpecHashVersion(doc, job.target);
    if (!match) return false;
    const saved = this.priceOf(job.kind);
    const balloonsBefore = job.target.kind === 'page' ? findPage(doc, job.target.id)?.balloons : undefined;
    // Un-busy first (render_use is a no-op on a busy target), then swap in the version.
    this.commit(
      [
        { op: 'render', target: job.target, patch: { status: restoredStatus(job.prev), error: undefined, updatedAt: Date.now() } },
        { op: 'render_use', target: job.target, path: match.path, at: Date.now() },
        this.reuseSpend(job, saved, match.version.model)
      ],
      'Reuse version'
    );
    this.releaseShare(saved);
    this.savedUsd = round4(this.savedUsd + saved);
    this.results.push({ job, ok: true, savedUsd: saved, reuse: 'R2' });
    this.extraStepFreshTake(job);
    void this.ctx.publishUrls([match.path]);
    logger.info('comic_render_reused', { projectId: this.ctx.projectId, rule: 'R2', target: renderTargetKey(job.target), from: match.from, savedUsd: saved });
    // The version brought its own balloon layout back when it had one; otherwise (an archived
    // version, or the lines changed) the balloons are re-laid from its stored QC — free, QC once.
    const page = job.target.kind === 'page' ? findPage(this.session.doc, job.target.id) : undefined;
    if (page && page.balloons === balloonsBefore) {
      try {
        await letterPage(this.ctx, page.id, null, this.signal, (card) => this.notices.push(card));
      } catch (err) {
        logger.warn('comic_reuse_relayout_failed', { projectId: this.ctx.projectId, pageId: page.id, message: (err as Error)?.message });
      }
    }
    return true;
  }

  /** A zero-cost ledger line for a reuse (decisions-final #6). */
  private reuseSpend(job: ImageJob, savedUsd: number, model?: string): DocOp {
    return {
      op: 'spend',
      entry: {
        id: newId('sp'),
        at: Date.now(),
        kind: job.spend,
        label: reusedLabel(job.label, savedUsd),
        usd: 0,
        ...(model ? { model } : {}),
        byok: this.byok,
        estimated: false,
        target: renderTargetKey(job.target),
        savedUsd
      }
    };
  }

  /** After a free reuse, the honest paid alternative stays one tap away. */
  private extraStepFreshTake(job: ImageJob) {
    const doc = this.session.doc;
    let action: SpendAction | null = null;
    if (job.target.kind === 'page') action = { type: 'render_pages', pageIds: [job.target.id], force: true };
    else if (job.target.kind === 'cover') action = { type: 'render_cover' };
    else if (job.target.kind === 'sheet') action = { type: 'render_sheets', characterIds: [job.target.id], force: true };
    if (!action) return;
    const usd = quoteOf(doc, action, this.byok);
    if (usd <= 0) return;
    this.extraSteps.push({ label: `Fresh take of ${job.label.toLowerCase()}`, action: { ...action, quotedUsd: usd }, usd });
  }

  /**
   * Compile, attach references (dropping any that can't be loaded), reuse an identical job
   * (R3/R7), bill, draw (safe-take retry once), save, check the shape, record the version.
   */
  private async draw(job: ImageJob): Promise<DrawOutcome> {
    const { ctx } = this;
    this.commit([{ op: 'render', target: job.target, patch: { status: 'rendering', updatedAt: Date.now() } }]);
    const end = activity(ctx, job.activityLabel, 'image');

    let prepared: Awaited<ReturnType<RenderRun['prepare']>>;
    try {
      prepared = await this.prepare(job, { safe: !!job.safe });
    } catch (err) {
      end(false);
      this.fail(job, asStudioError(err).userMessage);
      return { kind: 'done' };
    }

    // R3 / R7: an identical job already drew (or is drawing) this exact image.
    let settleInflight: ((asset: AssetRef | null) => void) | null = null;
    if (job.implicit) {
      const claim = await this.reuseIdenticalJob(job, prepared);
      if (claim === 'reused') {
        end(true);
        return { kind: 'done' };
      }
      settleInflight = claim;
    }
    try {
      const out = await this.drawPrepared(job, prepared, end);
      settleInflight?.(out.asset);
      return out.outcome;
    } catch (err) {
      settleInflight?.(null);
      throw err;
    }
  }

  /**
   * R3 (same job hash anywhere in the doc), then R7 (the same job drawing right now). Returns
   * 'reused', or this job's in-flight registration (claimed synchronously with the check, so
   * two identical parallel jobs can never both pay).
   */
  private async reuseIdenticalJob(
    job: ImageJob,
    prepared: Awaited<ReturnType<RenderRun['prepare']>>
  ): Promise<'reused' | ((asset: AssetRef | null) => void)> {
    let joined = false;
    // Bounded: each round either copies, registers, or waits for a leader to finish. When a
    // leader fails (rate limit, billing, filter), ONE waiting twin takes over as the new leader
    // and the others join it — identical twins never all pay after a failure.
    for (let round = 0; round < 4; round += 1) {
      const found = findJobHashAsset(this.session.doc, prepared.jobHash, job.target);
      if (found) {
        await this.adopt(job, prepared, found.asset, found.meta, found.model, joined ? 'R7' : 'R3');
        return 'reused';
      }
      const joining = this.inflight.get(prepared.jobHash);
      if (!joining) return this.inflight.register(prepared.jobHash);
      joined = true;
      await joining;
      if (this.signal.aborted) break;
      // Landed: its asset (with its jobHash) is in the doc now — the next round copies it.
      // Failed: the next round registers this job as the new leader (or joins whoever did).
    }
    return this.inflight.get(prepared.jobHash) ? () => undefined : this.inflight.register(prepared.jobHash);
  }

  /** Copy an identical job's image into this target for free, then letter it (QC once). */
  private async adopt(
    job: ImageJob,
    prepared: Awaited<ReturnType<RenderRun['prepare']>>,
    asset: AssetRef,
    meta: VersionMeta,
    model: string | undefined,
    rule: 'R3' | 'R7'
  ): Promise<void> {
    const saved = this.priceOf(job.kind);
    // A copied picture in the wrong frame gets the same honest notice and free Fit chip as a fresh one.
    const aspect = this.checkAspect(job, prepared.compiled, asset);
    this.commit(
      [
        {
          op: 'render',
          target: job.target,
          patch: {
            status: 'ready',
            asset: { ...asset },
            ...(model ? { model } : {}),
            ...prepared.meta,
            ...(meta.qc ? { qc: meta.qc } : {}),
            origin: 'reused',
            costUsd: 0,
            attempts: 0,
            error: undefined,
            updatedAt: Date.now()
          }
        },
        this.reuseSpend(job, saved, model)
      ],
      'Reuse drawing'
    );
    this.releaseShare(saved);
    this.savedUsd = round4(this.savedUsd + saved);
    this.results.push({ job, ok: true, savedUsd: saved, reuse: rule, ...(aspect ? { aspect } : {}) });
    this.extraStepFreshTake(job);
    logger.info('comic_render_reused', { projectId: this.ctx.projectId, rule, target: renderTargetKey(job.target), savedUsd: saved });
    await this.ctx.publishUrls([asset.path]);
    // QC once: the copied image keeps its report; balloons are placed from it for free.
    if (job.qcPageId) await letterPage(this.ctx, job.qcPageId, null, this.signal, (card) => this.notices.push(card));
  }

  private async drawPrepared(
    job: ImageJob,
    initial: Awaited<ReturnType<RenderRun['prepare']>>,
    end: (ok: boolean) => void
  ): Promise<{ outcome: DrawOutcome; asset: AssetRef | null }> {
    const { ctx, session } = this;
    let prepared = initial;
    let safe = !!job.safe;
    const picked = imageRouteFor(prepared.compiled.spec, ctx.keys);
    if (!picked) {
      end(false);
      this.fail(job, `${prepared.compiled.spec.nickname} needs an OpenRouter or Gemini key. Add one in Settings → API keys.`);
      return { outcome: { kind: 'done' }, asset: null };
    }

    const reserved = await ctx.billing.reserve({
      operation: imageOperation[job.kind],
      provider: picked.route,
      model: picked.model,
      stage: job.spend,
      imageUnits: 1,
      resolution: prepared.compiled.resolution
    });
    if (reserved.ok === false) {
      end(false);
      // Parallel jobs can be denied together: the first explains, the rest just don't start.
      if (this.stopReason) {
        this.restore(job);
        return { outcome: { kind: 'done' }, asset: null };
      }
      this.stopReason = reserved.message;
      this.notices.push(noticeCard('error', reserved.message));
      this.fail(job, reserved.message);
      return { outcome: { kind: 'done' }, asset: null };
    }
    const reservation = reserved.reservation;

    let result: ImageResult | undefined;
    let lastError: StudioError | undefined;
    let lastRaw: unknown;
    let attempts = 0;
    let failedSpend = 0;
    let rateLimited = false;
    let saferTake = false;
    let safeRetried = false;
    // A deadline-abort hits a non-streaming request the provider keeps generating (and
    // billing); it is flagged `abandoned` so we settle an estimate instead of releasing.
    let abandonedUsd = 0;
    while (attempts < MAX_IMAGE_ATTEMPTS) {
      attempts += 1;
      try {
        // No abort signal: a call that has started is paid and is always kept.
        result = await ctx.images({
          spec: prepared.compiled.spec,
          resolution: prepared.compiled.resolution,
          aspect: prepared.compiled.aspect,
          prompt: prepared.compiled.prompt,
          references: prepared.references
        });
        if (safe && safeRetried) saferTake = true;
        break;
      } catch (err) {
        lastRaw = err;
        lastError = asStudioError(err, 'The image could not be drawn. Please try again.');
        const spent = (err as { spentUsd?: unknown })?.spentUsd;
        if (typeof spent === 'number' && Number.isFinite(spent) && spent > 0) failedSpend += spent;
        if (lastError.code === 'RATE_LIMIT') {
          rateLimited = true;
          this.noteRateLimit(job);
        }
        if ((err as { abandoned?: boolean })?.abandoned) {
          // Our own deadline fired after dispatch: the provider still bills it, so do not
          // retry (that would pay twice) — bill the registry price and stop.
          abandonedUsd += imagePriceUsd(prepared.compiled.spec, prepared.compiled.resolution);
          break;
        }
        if (this.signal.aborted || lastError.code === 'CANCELLED') break;
        // Safe take: the image model's filter declined this take (not billed) — recompile one
        // notch gentler and try once more, within the approved spend (safety.md §3.2).
        if (lastError.code === 'SAFETY_BLOCKED' && !safe && !safeRetried) {
          safeRetried = true;
          safe = true;
          try {
            prepared = await this.prepare(job, { safe: true });
          } catch {
            break;
          }
          attempts = Math.min(attempts, MAX_IMAGE_ATTEMPTS - 1);
          logger.warn('comic_image_safe_take', { projectId: ctx.projectId, target: renderTargetKey(job.target) });
          continue;
        }
        if (!lastError.retryable || attempts >= MAX_IMAGE_ATTEMPTS) break;
        logger.warn('comic_image_job_retry', { projectId: ctx.projectId, target: renderTargetKey(job.target), code: lastError.code });
        await sleep(
          lastError.code === 'RATE_LIMIT'
            ? JOB_TIMINGS.retryBackoffMs * RATE_LIMIT_BACKOFF_FACTOR + Math.round(Math.random() * JOB_TIMINGS.retryBackoffMs)
            : JOB_TIMINGS.retryBackoffMs,
          this.signal
        );
        if (this.signal.aborted) break;
      }
    }

    if (!result) {
      end(false);
      const owed = round4(failedSpend + abandonedUsd);
      if (owed > 0) {
        await reservation.settle({ costUsd: owed, imageUnits: 0 });
        this.recordImageSpend(job, prepared.compiled, owed, abandonedUsd > 0, picked.byok, abandonedUsd > 0 ? ' (timed out)' : ' (failed attempt)');
      } else {
        await reservation.release(lastError?.code || 'image_failed');
      }
      if (lastError?.code === 'CANCELLED') {
        this.restore(job);
        return { outcome: { kind: 'done' }, asset: null };
      }
      const detail = this.failureDetail(lastRaw);
      logger.warn('comic_image_job_failed', {
        projectId: ctx.projectId,
        target: renderTargetKey(job.target),
        code: lastError?.code,
        detail,
        requeued: !!job.requeued
      });
      // Incident follow-up: a rate-limited image is re-queued once after the provider's
      // Retry-After (or 45 s) before it is marked failed.
      if (lastError?.code === 'RATE_LIMIT' && !job.requeued && !this.signal.aborted && !this.stopReason) {
        this.commit([{ op: 'render', target: job.target, patch: { status: 'queued', error: undefined, updatedAt: Date.now() } }]);
        return { outcome: { kind: 'requeue', afterMs: this.requeueDelay(lastRaw) }, asset: null };
      }
      const message = lastError?.userMessage || 'The image could not be drawn.';
      this.fail(job, message, attempts, { rateLimited, ...(detail ? { detail } : {}) }, this.errorDetailOf(lastRaw, lastError, detail));
      return { outcome: { kind: 'done' }, asset: null };
    }

    const { compiled } = prepared;
    const providerUsd = typeof result.costUsd === 'number' && Number.isFinite(result.costUsd) ? result.costUsd : undefined;
    const imageUsd = providerUsd ?? imagePriceUsd(compiled.spec, compiled.resolution);
    // Earlier paid-but-failed attempts of this same job are billed alongside the image.
    const settleUsd = failedSpend > 0 ? round4(imageUsd + failedSpend) : providerUsd;
    let saved: AssetRef;
    try {
      saved = await this.saveImage(result.dataUrl, compiled.spec.id);
    } catch (err) {
      // Paid but lost: bill it honestly and say so.
      end(false);
      await reservation.settle({ costUsd: settleUsd, imageUnits: 1 });
      if (failedSpend > 0) this.recordImageSpend(job, compiled, failedSpend, false, picked.byok, ' (failed attempt)');
      this.recordImageSpend(job, compiled, imageUsd, providerUsd === undefined, result.byok, ' (not saved)');
      logger.error('comic_image_save_failed', { projectId: ctx.projectId, target: renderTargetKey(job.target), message: (err as Error)?.message });
      this.fail(job, "The image was drawn but couldn't be saved. Please retry.", attempts);
      return { outcome: { kind: 'done' }, asset: null };
    }
    await reservation.settle({ costUsd: settleUsd, imageUnits: 1 });
    if (failedSpend > 0) this.recordImageSpend(job, compiled, failedSpend, false, picked.byok, ' (failed attempt)');
    const usd = this.recordImageSpend(job, compiled, imageUsd, providerUsd === undefined, result.byok, '');

    // Shape check (free): never an automatic redraw or fit — offer them.
    const aspect = this.checkAspect(job, compiled, saved, result.route);
    // The safety verdict is pending until the check lands (the owner sees "Checking…").
    const asset: AssetRef = { ...saved, safety: { pending: true, at: Date.now() } };
    session.commit(
      [
        {
          op: 'render',
          target: job.target,
          patch: {
            status: 'ready',
            asset,
            model: compiled.spec.id,
            costUsd: usd,
            attempts,
            updatedAt: Date.now(),
            error: undefined,
            ...prepared.meta,
            ...(job.kind === 'edit' ? { origin: 'edit' as const } : { origin: 'render' as const }),
            ...(safe && !job.note ? { note: 'Safer take' } : {})
          }
        },
        ...(job.landedOps ? job.landedOps() : [])
      ],
      { origin: 'job' }
    );
    this.results.push({ job, ok: true, ...(aspect ? { aspect } : {}), ...(rateLimited ? { rateLimited } : {}), ...(saferTake ? { saferTake } : {}) });
    if (saferTake) logger.info('comic_image_safe_take_ok', { projectId: ctx.projectId, target: renderTargetKey(job.target) });
    end(true);
    // The image is saved and paid for: nothing after this point may fail the render.
    try {
      const checked = await this.afterSave(job, asset, result.dataUrl);
      if (checked.blocked) {
        const r = this.results.find((x) => x.job === job && x.ok);
        if (r) {
          r.blocked = true;
          r.previousBack = checked.previousBack;
        }
      }
    } catch (err) {
      logger.warn('comic_post_render_failed', { projectId: ctx.projectId, target: renderTargetKey(job.target), message: (err as Error)?.message });
    }
    return { outcome: { kind: 'done' }, asset };
  }

  /**
   * RenderState.errorDetail for a failed draw (the Details row): the provider's status code or our
   * StudioError code, the route label and the sanitized one-liner. Never a body, a prompt or a key.
   */
  private errorDetailOf(raw: unknown, error: StudioError | undefined, detail: string | undefined): RenderErrorDetail | undefined {
    const info = imageFailureInfo(raw);
    const code = info && Number.isFinite(info.status) && (info.status as number) > 0 ? String(info.status) : error?.code;
    if (!code) return undefined;
    const provider = info && detail ? detail.split(' · ')[0] : undefined;
    return normalizeErrorDetail({ code, ...(provider ? { provider } : {}), at: Date.now(), text: detail || `${provider ? `${provider} · ` : ''}${code}` });
  }

  /** "OpenRouter · 429 · upstream Google · 17:42 UTC" (sanitized; never a key or a body). */
  private failureDetail(err: unknown): string | undefined {
    const base = imageFailureDetail(err);
    if (!base) return undefined;
    const t = new Date();
    const hh = String(t.getUTCHours()).padStart(2, '0');
    const mm = String(t.getUTCMinutes()).padStart(2, '0');
    return `${base} · ${hh}:${mm} UTC`;
  }

  /** The provider's Retry-After (bounded) or the default wait, plus jitter. */
  private requeueDelay(err: unknown): number {
    const hinted = imageFailureInfo(err)?.retryAfterMs;
    const base =
      typeof hinted === 'number' && Number.isFinite(hinted) && hinted > 0
        ? Math.min(REQUEUE_MAX_MS, Math.max(JOB_TIMINGS.requeueMinMs, hinted))
        : JOB_TIMINGS.rateLimitRequeueMs;
    return Math.max(0, Math.round(base + Math.random() * JOB_TIMINGS.requeueJitterMs));
  }

  /** Log + notice + chips when the image came back in another shape (pages and covers). */
  private checkAspect(job: ImageJob, compiled: CompiledImageJob, asset: AssetRef, route?: ImageRoute): { got: AspectRatio; want: AspectRatio } | null {
    if (aspectMatches(compiled.aspect, asset.w, asset.h)) return null;
    const got = aspectFromSize(asset.w || 0, asset.h || 0);
    const want = compiled.aspect;
    logger.info('comic_aspect_mismatch', { projectId: this.ctx.projectId, target: renderTargetKey(job.target), want, w: asset.w, h: asset.h, route: route ?? 'reused', model: compiled.spec.id });
    if (job.target.kind !== 'page' && job.target.kind !== 'cover') return { got, want };
    const what = job.target.kind === 'cover' ? 'the cover' : job.label.toLowerCase().replace(/^edit /, '');
    this.notices.push(noticeCard('warn', `${capitalize(what)} came back ${got} instead of ${want}. Fit it to ${want} for free, keep it, or redraw it.`));
    const redraw: SpendAction =
      job.target.kind === 'cover' ? { type: 'render_cover' } : { type: 'render_pages', pageIds: [job.target.id], force: true };
    const usd = this.priceOf(job.target.kind === 'cover' ? 'cover' : 'page');
    this.extraSteps.push(
      { label: `Fit to ${want} (Free)`, action: { type: 'fit_render', target: job.target, mode: 'auto' }, usd: 0 },
      { label: got === '1:1' ? 'Keep square' : `Keep ${got}`, say: `Keep ${what} as it is (${got}).` },
      { label: `Redraw at ${want}`, action: { ...redraw, quotedUsd: usd }, usd }
    );
    return { got, want };
  }

  /**
   * After the save: QC + balloons (pages), the safety verdict, then the URL. The URL waits
   * for the verdict, or 20 s at most for the owner's private view (decisions-final #10).
   * Resolves whether the verdict blocked the image and whether a previous version is back.
   */
  private async afterSave(job: ImageJob, asset: AssetRef, dataUrl: string): Promise<{ blocked: boolean; previousBack: boolean }> {
    const { ctx } = this;
    let verdict: SafetyVerdict | undefined;
    const work = (async () => {
      if (job.qcPageId) {
        const lettered = await letterPage(ctx, job.qcPageId, dataUrl, this.signal, (card) => this.notices.push(card));
        verdict = lettered.safety;
      }
      if (!verdict) verdict = await checkRenderSafety(ctx, job.target, asset).catch(() => undefined);
      await onRenderVerdict(ctx, job.target, asset, verdict);
    })();
    const timer = delay(JOB_TIMINGS.safetyFailOpenMs);
    const first = await Promise.race([work.then(() => 'verdict' as const, () => 'verdict' as const), timer.promise]);
    timer.cancel();
    let published = false;
    if (first === 'timeout') {
      // Fail open for the OWNER only; publishing re-checks everything.
      logger.warn('comic_safety_fail_open', { projectId: ctx.projectId, target: renderTargetKey(job.target) });
      await ctx.publishUrls([asset.path]);
      published = true;
    }
    try {
      await work;
    } catch (err) {
      logger.warn('comic_render_check_failed', { projectId: ctx.projectId, target: renderTargetKey(job.target), message: (err as Error)?.message });
    }
    // Never "Checking…" forever: whatever the check found (or nothing — unchecked) is recorded.
    const still = findAsset(ctx.session.doc, asset.path);
    if (still?.safety?.pending) commitAs(ctx, [{ op: 'asset_meta', path: asset.path, patch: { safety: verdict ?? null } }], 'job');
    const latest = findAsset(ctx.session.doc, asset.path) ?? asset;
    const isBlocked = safetyStatusOf(verdict ?? latest.safety, PLATFORM_CEILING) === 'blocked' || !canServeToOwner(latest);
    if (isBlocked) {
      // The previous version (if any) is current again: make sure the owner can see it.
      const current = getRender(ctx.session.doc, job.target)?.asset;
      const previousBack = !!current?.path && current.path !== asset.path && canServeToOwner(current);
      if (previousBack) await ctx.publishUrls([current!.path]);
      return { blocked: true, previousBack };
    }
    if (!published) await ctx.publishUrls([asset.path]);
    return { blocked: false, previousBack: false };
  }

  /** Compile with references we can actually load; recompile without any that are missing or blocked. */
  private async prepare(
    job: ImageJob,
    opts: CompileOpts
  ): Promise<{ compiled: CompiledImageJob; references: ImageReference[]; docAtCompile: ComicDoc; jobHash: string; meta: VersionMeta }> {
    // Use the live doc (freshly drawn sheets/pages) but pin the model/quality to what was
    // quoted and authorised, so a mid-run settings change can't pick a pricier/gated model.
    const live = this.session.doc;
    const pinnedDoc: ComicDoc = { ...live, settings: { ...live.settings, quality: this.pinned.quality, imageModelOverride: this.pinned.imageModelOverride } };
    const docAtCompile = job.docFor ? job.docFor(pinnedDoc) : pinnedDoc;
    // Blocked or quarantined images are never sent to a model (safety.md §3.2 reference gate).
    const missing = blockedPaths(docAtCompile);
    // The compilers apply the safe take (SAFE TAKE line + softened actions) and the rating ceiling themselves.
    const compileWith = (doc: ComicDoc) => job.compile(doc, opts);
    let regionDataUrl: string | undefined;
    let result: { compiled: CompiledImageJob; references: ImageReference[]; attached: string[] } | null = null;
    let lazyChecked = false;
    for (let pass = 0; pass < 4 && !result; pass += 1) {
      const compiled = compileWith(missing.size ? withoutAssets(docAtCompile, missing) : docAtCompile);
      if (!lazyChecked) {
        // safety.md §3.2: an uploaded photo nobody has checked yet (screen unavailable at upload, a
        // legacy import, an Undo re-add) is checked before its first use as a reference; a blocked
        // one is dropped and the job recompiled without it.
        lazyChecked = true;
        const refused = await this.lazyRefCheck(docAtCompile, compiled.references.map((r) => r.path));
        if (refused.length) {
          refused.forEach((path) => missing.add(path));
          continue;
        }
      }
      const references: ImageReference[] = [];
      const attached: string[] = [];
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
          attached.push(`__region__:${job.region.x},${job.region.y},${job.region.w},${job.region.h}`);
          continue;
        }
        try {
          references.push({ label: ref.label, dataUrl: await this.ctx.assets.loadDataUrl(ref.path) });
          attached.push(ref.path);
        } catch (err) {
          if (job.kind === 'edit' && references.length === 0) {
            throw new StudioError('NOT_FOUND', "Couldn't load the current page image to edit. Try redrawing the page.", { status: 404, cause: err });
          }
          logger.warn('comic_reference_missing', { projectId: this.ctx.projectId, path: ref.path, label: ref.label, message: (err as Error)?.message });
          missing.add(ref.path);
          dropped = true;
        }
      }
      if (!dropped) result = { compiled, references, attached };
    }
    // Still missing after recompiles: give up on references rather than mislabel them.
    if (!result) result = { compiled: compileWith(withoutAssets(docAtCompile, new Set(collectAssetPaths(docAtCompile)))), references: [], attached: [] };
    const { compiled, references, attached } = result;
    const jobHash = jobHashOf({ specId: compiled.spec.id, resolution: compiled.resolution, aspect: compiled.aspect, prompt: compiled.prompt, referencePaths: attached });
    return { compiled, references, docAtCompile, jobHash, meta: this.versionMeta(job, compiled, docAtCompile, attached, jobHash) };
  }

  /** The full VersionMeta for this draw (contract §12.3: specHash for every target kind, aspect, lineage). */
  private versionMeta(job: ImageJob, compiled: CompiledImageJob, docAtCompile: ComicDoc, attached: string[], jobHash: string): VersionMeta {
    const base = getRender(docAtCompile, job.target);
    // Edits keep the BASE version's spec hash (the edit didn't change the script); renders take today's.
    const specHash = job.kind === 'edit' ? base?.specHash : specHashFor(docAtCompile, job.target);
    // Continuity by PATH, never by label (a cast member or place named "Previous Page" can't spoof it).
    const page = job.kind === 'page' && job.target.kind === 'page' ? findPage(docAtCompile, job.target.id) : undefined;
    const previousPath = page ? nearestReadyBefore(docAtCompile, page)?.render.asset?.path : undefined;
    const continuityPath = previousPath && attached.includes(previousPath) ? previousPath : undefined;
    // The compiler's own list of USER refs, filtered to what was really attached. An empty list is recorded
    // too: "drawn without photos" lets sheetRefsChanged offer a redraw once photos are added.
    const attachedSet = new Set(attached);
    const reported = Array.isArray(compiled.refPaths) ? compiled.refPaths.filter((p) => attachedSet.has(p)) : undefined;
    const userRefs = userRefPaths(docAtCompile);
    const refPaths = reported ?? attached.filter((p) => userRefs.has(p));
    return {
      ...(specHash ? { specHash } : {}),
      resolution: compiled.resolution,
      aspect: compiled.aspect,
      jobHash,
      ...(job.note ? { note: job.note.slice(0, 300) } : {}),
      ...(job.kind === 'edit' && base?.asset?.path ? { parentPath: base.asset.path } : {}),
      ...(continuityPath ? { continuityPath } : {}),
      ...(reported || refPaths.length ? { refPaths } : {})
    };
  }

  /** Lazy safety check of unchecked uploads among `paths` (≤ MAX_LAZY_REF_CHECKS, shared per session). Returns the blocked paths. */
  private async lazyRefCheck(doc: ComicDoc, paths: string[]): Promise<string[]> {
    const pending = uncheckedRefs(doc, paths).slice(0, MAX_LAZY_REF_CHECKS);
    if (!pending.length) return [];
    let checks = refChecks.get(this.session);
    if (!checks) {
      checks = new Map();
      refChecks.set(this.session, checks);
    }
    const map = checks;
    const refused: string[] = [];
    await Promise.all(
      pending.map(async (ref) => {
        let check = map.get(ref.path);
        if (!check) {
          check = this.checkRef(ref.path).finally(() => map.delete(ref.path));
          map.set(ref.path, check);
        }
        if ((await check) === 'block') refused.push(ref.path);
      })
    );
    if (refused.length && !this.notices.some((n) => n.type === 'notice' && /reference photo/.test(n.text))) {
      this.notices.push(
        noticeCard('warn', `${refused.length === 1 ? "One of your reference photos didn't" : `${refused.length} of your reference photos didn't`} pass the content check, so ${refused.length === 1 ? 'it was' : 'they were'} left out of this drawing.`)
      );
    }
    return refused;
  }

  /** One platform-paid check of an uploaded photo; the verdict is stored on the ref so it is checked once. */
  private async checkRef(path: string): Promise<'allow' | 'block' | 'unavailable'> {
    try {
      const dataUrl = await this.ctx.assets.previewDataUrl(path, 768);
      const comma = dataUrl.indexOf(',');
      if (!dataUrl.startsWith('data:') || comma < 0) return 'unavailable';
      const res = await screenUploadPreview(this.ctx, Buffer.from(dataUrl.slice(comma + 1), 'base64'), 'upload');
      if (res.verdict && findAsset(this.session.doc, path)) {
        commitAs(this.ctx, [{ op: 'asset_meta', path, patch: { safety: res.verdict } }], 'job');
      }
      if (res.decision === 'block') logger.info('comic_ref_lazy_check_blocked', { projectId: this.ctx.projectId });
      return res.decision;
    } catch (err) {
      // Fail open for the owner's private draw (decisions-final #10): the image model's own filter and
      // the render check still apply; publishing re-checks everything.
      logger.warn('comic_ref_lazy_check_failed', { projectId: this.ctx.projectId, message: (err as Error)?.message });
      return 'unavailable';
    }
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
    this.commit([
      {
        op: 'spend',
        entry: {
          id: newId('sp'),
          at: Date.now(),
          kind: job.spend,
          label: `${job.label}${suffix}`,
          usd,
          model: compiled.spec.id,
          byok,
          estimated,
          target: renderTargetKey(job.target)
        }
      }
    ]);
    return usd;
  }
}

/** The AssetRef with this path anywhere in the doc (current, history, refs…). */
const findAsset = (doc: ComicDoc, path: string): AssetRef | undefined => {
  let found: AssetRef | undefined;
  mapAssetRefs(doc, (a) => {
    if (!found && a?.path === path) found = a;
    return a;
  });
  return found;
};

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

const describeJobs = (jobs: ImageJob[]): string => {
  const count = (kind: ImageJobKind | ImageJobKind[]) => jobs.filter((j) => (Array.isArray(kind) ? kind.includes(j.kind) : j.kind === kind)).length;
  const pages = jobs.filter((j) => j.kind === 'page');
  const pageNs = pages.map((j) => Number(/(\d+)$/.exec(j.label)?.[1])).filter((n) => Number.isFinite(n)).map((n) => ({ n }));
  const parts = [
    pages.length === 1 ? pages[0].label.toLowerCase() : pages.length ? (pageNs.length === pages.length ? pagesPhrase(pageNs) : plural(pages.length, 'page')) : '',
    count('edit') ? (count('edit') === 1 ? jobs.find((j) => j.kind === 'edit')!.label.toLowerCase().replace(/^edit /, 'the edit of ') : plural(count('edit'), 'edit')) : '',
    count(['sheet', 'place']) ? plural(count(['sheet', 'place']), 'sheet') : '',
    count('style_option') ? plural(count('style_option'), 'style option') : '',
    count('cover') ? 'the cover' : ''
  ].filter(Boolean);
  if (parts.length <= 1) return parts[0] || 'nothing';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
};

/**
 * A fresh layout over the page's stored balloons (lettering.md §6.6 / §9): pinned and LOCKED
 * balloons never move; a re-laid balloon keeps what the user decided about it — its stacking
 * order (z) and its link to the previous line (linkTo, when that line is still on the page).
 */
export const mergeBalloons = (page: Page, fresh: Balloon[], overlay: boolean): Balloon[] => {
  if (!overlay) return [];
  const lineIds = new Set(page.panels.flatMap((p) => p.lines.map((l) => l.id)));
  const kept = page.balloons.filter((b) => (b.pinned || b.locked) && lineIds.has(b.lineId));
  const keptIds = new Set(kept.map((b) => b.lineId));
  const before = new Map(page.balloons.map((b) => [b.lineId, b]));
  const seen = new Set<string>();
  const out: Balloon[] = [...kept];
  for (const b of fresh) {
    if (!lineIds.has(b.lineId) || keptIds.has(b.lineId) || seen.has(b.lineId)) continue;
    seen.add(b.lineId);
    const prev = before.get(b.lineId);
    const z = typeof prev?.z === 'number' && Number.isFinite(prev.z) ? prev.z : undefined;
    const linkTo = prev?.linkTo && prev.linkTo !== b.lineId && lineIds.has(prev.linkTo) ? prev.linkTo : undefined;
    const { z: _z, linkTo: _l, locked: _k, ...rest } = b;
    out.push({ ...rest, ...(z !== undefined ? { z } : {}), ...(linkTo ? { linkTo } : {}) });
  }
  return out;
};

/** What letterPage found: the safety verdict folded into QC (when the vision pass returned one). */
export interface LetterResult {
  safety?: SafetyVerdict;
  /** A (billed) vision call ran. */
  visionRan: boolean;
  /** Why the vision call didn't run or failed (not on cancel): the paid re-check says so honestly. */
  visionError?: StudioError;
}

/**
 * Run the vision pass on a page image and commit its QC report + balloons. Never throws:
 * without vision (no key, billing denied, provider error, cancelled) balloons are laid out
 * from the panel blueprint. QC once: an asset that already carries a QC report (restored,
 * reused, derived fit) is never re-checked unless `forceVision` — its stored panel boxes
 * place the balloons for free.
 */
export async function letterPage(
  ctx: StudioContext,
  pageId: string,
  dataUrl: string | null,
  signal: AbortSignal,
  onNotice: (card: Card) => void,
  opts: { forceVision?: boolean } = {}
): Promise<LetterResult> {
  const doc = ctx.session.doc;
  const page = findPage(doc, pageId);
  if (!page) return { visionRan: false };
  const overlay = doc.format.lettering !== 'in_art';
  const stored = page.render.asset ? page.render.qc : undefined;
  let qc: QcReport | undefined;
  let balloons: Balloon[] | undefined;
  let safety: SafetyVerdict | undefined;
  let visionRan = false;
  let visionError: StudioError | undefined;
  if (dataUrl && !signal.aborted && (!stored || opts.forceVision)) {
    const end = activity(ctx, `Checking page ${page.n}`, 'text');
    const tracker = newTextSpendTracker();
    try {
      const analysis = await analyzePageRender({
        doc,
        page,
        dataUrl,
        llm: billedLlm(ctx, { stage: 'qc', operation: 'comic.text.vision', tracker }),
        signal
      });
      visionRan = true;
      qc = analysis.qc;
      balloons = analysis.balloons;
      // The safety block rides the QC answer (verdictFromVision); absent ⇒ unchecked, never a pass.
      safety = analysis.safety;
      end(true);
    } catch (err) {
      end(false);
      const error = asStudioError(err);
      if (error.code !== 'CANCELLED') {
        visionError = error;
        logger.warn('comic_page_qc_failed', { projectId: ctx.projectId, pageId, code: error.code, message: error.message });
      }
    } finally {
      if (tracker.calls && !tracker.usd && tracker.estimated) tracker.usd = chargedUsd(QC_USD_PER_PAGE, tracker.byok);
      recordTextSpend(ctx, tracker, 'qc', `Check page ${page.n}`);
    }
  }
  // Re-read: lines may have been edited while the check ran.
  const current = findPage(ctx.session.doc, pageId);
  if (!current) return { ...(safety ? { safety } : {}), visionRan, ...(visionError ? { visionError } : {}) };
  // A shape mismatch is a QC fact too (the board and the timeline show it).
  const r = current.render;
  if (qc && r.asset && r.aspect && !aspectMatches(r.aspect, r.asset.w, r.asset.h)) {
    const note = `Came back ${aspectFromSize(r.asset.w || 0, r.asset.h || 0)} instead of ${r.aspect}.`;
    if (!qc.issues.includes(note)) qc = { ...qc, issues: [...qc.issues, note] };
  }
  // Free placement (no vision this time): the shared engine over the stored QC — measured panel
  // boxes, faces and speakers' heads — or the panel blueprint when the page was never checked.
  if (!balloons) balloons = overlay ? placeStoredBalloons(ctx.session.doc, current, qc ?? (current.render.asset ? current.render.qc : undefined)) : [];
  const ops: DocOp[] = [{ op: 'balloons', pageId, balloons: mergeBalloons(current, balloons, overlay) }];
  if (qc) ops.unshift({ op: 'render', target: { kind: 'page', id: pageId }, patch: { qc } });
  commitAs(ctx, ops, 'job');
  if (qc && qc.score < LOW_QC_SCORE) {
    const issues = qc.issues.slice(0, 3).join(' ');
    onNotice(
      noticeCard(
        'warn',
        `Page ${current.n} may need another pass${issues ? `: ${issues}` : '.'} Say “redraw page ${current.n}” for a new take, or open it to fix one panel.`
      )
    );
  }
  return { ...(safety ? { safety } : {}), visionRan, ...(visionError ? { visionError } : {}) };
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

function pickStyle(ctx: StudioContext, optionId: string, opts: RunActionOptions): ActionOutcome {
  const doc = ctx.session.doc;
  const option = doc.style.options.find((o) => o.id === optionId);
  if (!option) throw badRequest('That style option is no longer available.');
  if (isBusy(option.render)) throw new StudioError('BAD_REQUEST', `“${option.name}” is still drawing — pick it when it's done.`, { status: 409 });
  const board = option.render.status === 'ready' ? option.render.asset : undefined;
  const origin = originOf(opts);
  commitAs(ctx, [{ op: 'style', patch: { status: 'locked', name: option.name, spec: option.spec, board, presetId: undefined, palette: undefined, linework: undefined } }], origin, 'Pick style');
  const steps = nextStepsFor(ctx.session.doc, { byok: spendIsByok(ctx.keys) });
  deliver(ctx, opts, `Locked “${option.name}”. Every sheet and page now follows it.`, [], steps);
  return { status: 'done', message: `Locked the style “${option.name}”.`, nextSteps: steps };
}

function approvePlan(ctx: StudioContext, opts: RunActionOptions): ActionOutcome {
  const doc = ctx.session.doc;
  if (!doc.pages.length) throw badRequest('There is no page plan to approve yet.');
  if (doc.planStatus !== 'approved') commitAs(ctx, [{ op: 'plan_status', status: 'approved' }], originOf(opts), 'Approve plan');
  return { status: 'done', message: 'Plan approved.' };
}

/** A page that has (or had) art: a current image or any history. */
const hasArt = (p: Page) => !!p.render.asset?.path || p.render.history.length > 0;

/**
 * R5: fingerprint of everything the writer reads for a full plan (brief + notes, cast names and
 * looks, places, the source script, the format). Unchanged + no instructions ⇒ the existing
 * plan is returned for free.
 */
export const planInputHashOf = (doc: ComicDoc): string =>
  hashString(
    JSON.stringify([
      'plan/1',
      doc.brief,
      doc.cast.map((c) => [c.id, c.name, c.tier, c.look, c.kind ?? 'person', c.count ?? 1, c.role ?? '', c.personality ?? '', c.voice ?? '']),
      doc.places.map((p) => [p.id, p.name, p.look]),
      hashString(doc.source.script || ''),
      doc.format
    ])
  );

/** The plan's input fingerprint, persisted on the doc by the server-only `plan_input_hash` op (survives a reload). */
const knownPlanHash = (session: StudioSessionApi): string | undefined => session.doc.planInputHash;

/**
 * Write (or revise) the page plan with the writer model.
 * - Unchanged inputs and no instructions (R5): the existing plan comes back for free.
 * - Nothing drawn yet: a full plan reuses existing page ids by position (harmless, no art).
 * - Pages drawn: art must follow the story beat, not the slot. A full re-plan of the same
 *   page count rewrites every page IN PLACE by id (drawn pages show as out of date); a
 *   different count is refused with "use revise_pages / insert_page / delete_page" BEFORE
 *   any paid call. A page the writer drops that has art goes to the trash, never lost.
 * - Afterwards: newly introduced cast is added, recurring uncast beings are cast (castScan),
 *   and the breakdown card shows the plan.
 */
export async function planPages(
  ctx: StudioContext,
  args: { instructions?: string; pageIds?: string[] },
  opts: Pick<RunActionOptions, 'collectCard' | 'collectNextSteps' | 'origin'> = {}
): Promise<ActionOutcome> {
  const signal = ctx.session.abort.signal;
  const before = ctx.session.doc;
  const instructions = clean(args.instructions, 8000);
  let pageIds = Array.isArray(args.pageIds) && args.pageIds.length ? args.pageIds : undefined;
  const origin = originOf(opts);
  const runOpts = { ...opts, confirmed: false } as RunActionOptions;
  const byok = spendIsByok(ctx.keys);

  if (!pageIds && !instructions && before.pages.length && before.planStatus !== 'none' && knownPlanHash(ctx.session) === planInputHashOf(before)) {
    const steps = nextStepsFor(before, { byok });
    const text = `Nothing changed since the plan was written, so here it is again — ${plural(before.pages.length, 'page')}, no writer call (${costOf(ctx).governed ? 'free' : '$0'}).`;
    deliver(ctx, runOpts, text, [breakdownCardFor(before, { view: 'plan' })], steps);
    return { status: 'done', message: `${planHeadline(before)} (unchanged inputs — returned the existing plan, $0)`, nextSteps: steps };
  }

  const drawn = before.pages.filter(hasArt);
  let rewroteAll = false;
  if (!pageIds && drawn.length) {
    const wanted = Math.max(1, Math.round(before.format.pageCount || before.pages.length));
    if (wanted !== before.pages.length) {
      const message =
        `${drawn.length === 1 ? `Page ${drawn[0].n} is` : `${capitalize(pagesPhrase(drawn))} are`} already drawn, so I won't re-plan the whole book from scratch — ` +
        `the art could land on the wrong story beat. Use revise_pages for the pages to change, insert_page to add a page or delete_page to remove one. Nothing was spent.`;
      const userText = `${drawn.length === 1 ? `Page ${drawn[0].n} is` : 'Some pages are'} already drawn, so I won't re-plan the whole book from scratch (the art could end up on the wrong page). Tell me which pages to change, or add/remove pages in the timeline — nothing was spent.`;
      deliver(ctx, runOpts, userText, [noticeCard('info', userText)], nextStepsFor(before, { byok }));
      return { status: 'blocked', message, code: 'CONFLICT' };
    }
    // Same page count: rewrite every page in place, by id (the writer returns the target ids).
    pageIds = before.pages.map((p) => p.id);
    rewroteAll = true;
  }
  const revising = !!pageIds;

  const tracker = newTextSpendTracker();
  const end = activity(ctx, revising && !rewroteAll ? 'Rewriting pages' : 'Writing the page plan', 'text');
  let result: Awaited<ReturnType<typeof writePagePlan>>;
  try {
    result = await writePagePlan({
      doc: ctx.session.doc,
      llm: billedLlm(ctx, { stage: 'plan', operation: 'comic.text.writer', tracker }),
      ...(instructions ? { instructions } : {}),
      ...(revising ? { pageIds } : {}),
      // The account-clamped rating: a kids comic (or a young account) is never written above its ceiling.
      rating: ctx.rating ?? effectiveRating(ctx.session.doc, ctx.caps?.ratingCeiling).rating,
      signal
    });
    end(true);
  } catch (err) {
    end(false);
    throw asStudioError(err);
  } finally {
    recordTextSpend(ctx, tracker, 'plan', revising && !rewroteAll ? 'Revise pages' : 'Page plan');
  }

  const doc = ctx.session.doc;
  const ops: DocOp[] = [];
  for (const c of result.newCast) {
    if (findCharacter(doc, c.id)) continue;
    ops.push({ op: 'character', id: c.id, patch: { ...c, sheet: c.sheet || emptyRender(), refs: c.refs || [] } });
  }
  let pages: Page[];
  if (revising) {
    // By id: every returned page lands on the page with the same id (art stays with its beat).
    pages = mergeRevisedPages(doc.pages, result.pages);
  } else {
    const old = [...doc.pages].sort((a, b) => a.n - b.n);
    const fresh = [...result.pages].sort((a, b) => a.n - b.n);
    const byId = new Set(old.map((p) => p.id));
    const matchesById = fresh.some((p) => byId.has(p.id));
    if (matchesById) {
      // The writer returned existing ids: map by id; new ids are new pages.
      const merged = mergeRevisedPages(old.filter((p) => fresh.some((f) => f.id === p.id)), fresh);
      pages = fresh.map((f) => {
        const m = merged.find((x) => x.id === f.id);
        return m ? { ...m, n: f.n } : f;
      });
    } else {
      // Nothing drawn (checked above): page identity by position is harmless.
      const reassigned = fresh.map((p, i) => (old[i] && !hasArt(old[i]) ? { ...p, id: old[i].id } : p));
      const merged = mergeRevisedPages(old.slice(0, reassigned.length), reassigned);
      pages = [...merged, ...reassigned.slice(merged.length)];
    }
    // A page with art that the new plan drops goes to the trash (paid art is never silently lost).
    const kept = new Set(pages.map((p) => p.id));
    for (const p of old) if (!kept.has(p.id) && hasArt(p) && !isBusy(p.render)) ops.push({ op: 'page_delete', id: p.id, deletedAt: Date.now() });
  }
  ops.push({ op: 'pages', pages });
  // A (re)written plan is a draft again until the user approves it (a revision of some pages keeps the status).
  if (!revising || rewroteAll || doc.planStatus === 'none') ops.push({ op: 'plan_status', status: 'draft' });
  commitAs(ctx, ops, origin, revising && !rewroteAll ? 'Revise pages' : 'Plan pages');

  // Software safety net: recurring animals, toys, vehicles… that the plan uses become cast.
  let castNote = '';
  try {
    const beings = findUncastBeings(ctx.session.doc);
    const castOps = beings.length ? castOpsForUncast(ctx.session.doc, beings) : [];
    if (castOps.length) {
      commitAs(ctx, castOps, origin, 'Add cast');
      const names = beings.map((b) => (b.count && b.count > 1 ? `${b.name} ×${b.count}` : b.name));
      castNote = ` Also added to the cast so they stay consistent: ${names.join(', ')}.`;
    }
  } catch (err) {
    logger.warn('comic_cast_scan_failed', { projectId: ctx.projectId, message: (err as Error)?.message });
  }

  // R5: remember what the writer read (server-only op; a reload keeps it, so an unchanged re-plan stays free).
  commitAs(ctx, [{ op: 'plan_input_hash', hash: planInputHashOf(ctx.session.doc) }], 'job');
  const after = ctx.session.doc;
  const headline = planHeadline(after, revising && !rewroteAll ? pageIds : undefined);
  const card: Card = breakdownCardFor(after, { view: 'plan', ...(revising && !rewroteAll ? { pageIds } : {}) });
  const drawnNote = drawn.length && revising ? ' Drawn pages that changed show as out of date until you redraw them.' : '';
  const text = revising && !rewroteAll
    ? `Rewrote ${plural(result.pages.length, 'page')}.${drawnNote}${castNote}`
    : `Here's the plan: ${plural(after.pages.length, 'page')}${result.newCast.length ? `, plus ${plural(result.newCast.length, 'new character')}` : ''}. Read it here — edit anything, then draw the pages.${drawnNote}${castNote}`;
  const steps = nextStepsFor(after, { byok });
  deliver(ctx, runOpts, text, [card], steps);
  return { status: 'done', message: `${headline}${castNote}`, nextSteps: steps };
}

/** "Planned 6 pages: 1. Maya arrives (4 panels) · 2. …" — the tool result the director reads. */
export const planHeadline = (doc: ComicDoc, onlyIds?: string[]): string => {
  const pages = doc.pages.filter((p) => !onlyIds || onlyIds.includes(p.id));
  const lines = pages.slice(0, 40).map((p) => `${p.n}. ${clean(p.summary, 140) || '(no summary)'} (${plural(p.panels.length, 'panel')})`);
  return `${onlyIds ? 'Revised' : 'Planned'} ${plural(pages.length, 'page')}: ${lines.join(' · ')}`;
};

/**
 * Compatibility action: put a stored version back (`render_use`). The version keeps its own
 * meta, so a version made for another spec or shape stays "out of date" honestly; blocked or
 * quarantined versions are refused.
 */
function restoreRender(ctx: StudioContext, target: RenderTarget, path: string, opts: RunActionOptions): ActionOutcome {
  const doc = ctx.session.doc;
  if (!isObject(target) || typeof (target as { kind?: unknown }).kind !== 'string') throw badRequest('Unknown render target.');
  const render = getRender(doc, target);
  if (!render) throw badRequest('That image no longer exists.');
  if (isBusy(render)) throw new StudioError('BAD_REQUEST', 'Wait for the current drawing to finish before restoring a version.', { status: 409 });
  if (render.asset?.path === path) return { status: 'done', message: 'That version is already current.' };
  const key = renderTargetKey(target);
  const version: (AssetRef & Partial<VersionMeta>) | undefined =
    render.history.find((a) => a.path === path) ?? archiveOf(doc).find((a) => a.path === path && a.targetKey === key);
  if (!version) throw badRequest("That version isn't in this image's history.");
  if (!canServeToOwner(version)) {
    throw new StudioError('CONTENT_POLICY', "That version didn't pass the content check, so it can't be used.", { status: 422 });
  }
  commitAs(ctx, [{ op: 'render_use', target, path, at: Date.now() }], originOf(opts), 'Use version');
  void ctx.publishUrls([version.path]);
  // Truth about shape and freshness (bug 4:5 → 1:1: a restored square page used to look current).
  if (target.kind !== 'page' && target.kind !== 'cover') return { status: 'done', message: 'Restored that version.' };
  const after = ctx.session.doc;
  const want = after.format.pageAspect;
  const shapeOff = !aspectMatches(want, version.w, version.h);
  const stale = isTargetStale(after, target);
  if (!shapeOff && !stale) return { status: 'done', message: 'Restored that version.' };
  const got = aspectFromSize(version.w || 0, version.h || 0);
  const label = target.kind === 'cover' ? 'the cover' : `page ${findPage(after, target.id)?.n ?? '?'}`;
  const byok = spendIsByok(ctx.keys);
  const steps: NextStep[] = [];
  const notes: string[] = [];
  if (shapeOff) {
    notes.push(`note it's ${got}, your pages are ${want}`);
    const redraw: SpendAction = target.kind === 'cover' ? { type: 'render_cover' } : { type: 'render_pages', pageIds: [target.id], force: true };
    const usd = quoteOf(after, redraw, byok);
    steps.push(
      { label: `Fit to ${want} (Free)`, action: { type: 'fit_render', target, mode: 'auto' }, usd: 0 },
      { label: `Switch book to ${got} (Free)`, action: { type: 'patch', ops: [{ op: 'format', patch: { pageAspect: got } }] }, usd: 0 },
      { label: `Redraw at ${want}`, action: { ...redraw, quotedUsd: usd }, usd }
    );
  }
  if (stale) notes.push(`it was drawn for an earlier version of ${label}, so it shows as out of date`);
  const message = `Restored ${label} — ${notes.join('; ')}.`;
  deliver(ctx, opts, message, [], steps);
  return { status: 'done', message, ...(steps.length ? { nextSteps: steps } : {}) };
}

/**
 * Re-lay the balloons on a page — always FREE: the stored QC (measured panel boxes, faces and
 * speakers' heads) or the panel blueprint places them with the shared engine (lettering.md
 * §6.6), no image load, no AI call. Balloons the user placed (pinned) or locked stay put.
 * `useVision` is the legacy alias of the paid re-check: it becomes a `recheck_page` spend that
 * always shows its quote first (never an ungated paid call).
 */
async function relayoutBalloons(ctx: StudioContext, pageId: string, opts: RunActionOptions, flags: { useVision?: boolean } = {}): Promise<StartedAction> {
  const doc = ctx.session.doc;
  const page = typeof pageId === 'string' ? findPage(doc, pageId) : undefined;
  if (!page) throw badRequest('That page is no longer in the plan.');
  if (flags.useVision) return startSpend(ctx, { type: 'recheck_page', pageId: page.id }, { ...opts, confirmed: false, forceGate: 'policy' });
  const end = activity(ctx, `Placing page ${page.n}'s balloons`, 'free');
  try {
    // A low score is already visible on the page's QC report; no extra message.
    await letterPage(ctx, page.id, null, ctx.session.abort.signal, () => undefined);
    end(true);
  } catch (err) {
    end(false);
    throw err;
  }
  const measured = !!(page.render.asset && page.render.qc?.panelBoxes?.length);
  return finished({
    status: 'done',
    message: `Re-laid out the balloons on page ${page.n} (free — no AI call${measured ? ', placed around the art the page check measured' : ', placed from the panel layout'}).`
  });
}

// ── Patch validation ─────────────────────────────────────────────────────────

/** Free text as it enters the doc: no NUL or lone surrogate (jsonb — see sanitize/text.ts), trimmed, clipped without splitting a pair. */
const str = (v: unknown, max = TEXT_LIMIT): string | undefined => (typeof v === 'string' ? enteredText(v, max) : undefined);
const strList = (v: unknown, maxItems = 40, max = 400): string[] | undefined =>
  Array.isArray(v) ? v.map((x) => str(x, max)).filter((x): x is string => !!x).slice(0, maxItems) : undefined;
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined => (typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined);
const num = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;

/** A field sanitizer's "drop this key, keep the rest of the edit" answer (an unknown value is never stored). */
const DROP: unique symbol = Symbol('drop');
/**
 * A field sanitizer's "unset this optional field" answer. Contract R4: the Undo inverse of a FIRST edit sends
 * null for a key that was absent before (a first logline, turn hook, role, kind…). It goes back to absent
 * (undefined: never stored, so spec hashes match the ones before the edit) instead of failing the whole Undo.
 */
const CLEAR: unique symbol = Symbol('clear');
/** An optional field: null clears it (R4); any other value goes through `fn`. Never for a required field. */
const clearable =
  (fn: (v: unknown) => unknown) =>
  (v: unknown): unknown =>
    v === null ? CLEAR : fn(v);

/**
 * Copy only the listed keys whose sanitizer accepts the value; throws when a present key is invalid,
 * except a sanitizer that answers DROP (that key is left out and the rest of the edit still applies)
 * or CLEAR (the key is unset).
 */
const pick = (raw: unknown, spec: Record<string, (v: unknown) => unknown>, what: string): Record<string, unknown> => {
  if (!isObject(raw)) throw badRequest(`Invalid ${what}.`);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.prototype.hasOwnProperty.call(spec, key)) continue;
    const fn = spec[key];
    if (value === undefined) continue;
    const v = fn(value);
    if (v === DROP) continue;
    if (v === CLEAR) {
      out[key] = undefined;
      continue;
    }
    if (v === undefined) throw badRequest(`Invalid ${what}: ${key}.`);
    out[key] = v;
  }
  return out;
};

/** Character.likeness values a client may set (contract §5.4; absent = 'auto'). */
const CAST_LIKENESS: readonly NonNullable<Character['likeness']>[] = ['auto', 'sheet_only', 'sheet_and_photo'];
/** Character.count: 1 = a single being, 2–12 = a group drawn as one identity class ("three ducklings"). */
const CAST_COUNT_MAX = 12;
/** Non-human look lines (doc.ts CharacterLook.species / markings: ≤ 120). */
const LOOK_LINE_FIELDS = new Set<string>(['species', 'markings']);
const LOOK_LINE_MAX = 120;

/**
 * Look text as stored: C0/C1 control characters and lone surrogates removed (Postgres jsonb rejects
 * \u0000 and unpaired surrogates; a clip never splits a pair), trimmed, clipped. ZWJ/ZWNJ and combining
 * marks stay (Telugu, Hindi). `oneLine` (species, markings) also turns tabs/newlines into one space.
 */
const lookText = (v: unknown, max: number, oneLine: boolean): string | undefined => {
  if (typeof v !== 'string') return undefined;
  let s = v
    .replace(/[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  s = (oneLine ? s.replace(/\s+/g, ' ') : s.replace(/[\u000B\u000C]/g, ' ')).trim().slice(0, max);
  if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  return s.trim();
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
        v === null || v === '' ? null : typeof v === 'string' && IMAGE_MODELS.some((m) => m.id === v && m.lifecycle !== 'deprecated') ? v : undefined,
      reviewFirstRender: (v) => (typeof v === 'boolean' ? v : undefined)
    },
    'settings'
  );
  // null clears an optional setting.
  if (out.budgetUsd === null || out.budgetUsd === 0) out.budgetUsd = undefined;
  if (out.imageModelOverride === null) out.imageModelOverride = undefined;
  return out as Partial<Settings>;
};

/**
 * A client/tool look patch: only LOOK_FIELDS, strings only (anything else is dropped), control characters
 * stripped. summary ≤ 600, species / markings one line ≤ 120, the rest ≤ 300. '' clears a field.
 */
export const sanitizeLook = (raw: unknown): Record<string, string> | undefined => {
  if (!isObject(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const key of LOOK_FIELDS) {
    const line = LOOK_LINE_FIELDS.has(key);
    const v = lookText(raw[key], key === 'summary' ? 600 : line ? LOOK_LINE_MAX : 300, line);
    if (v !== undefined) out[key] = v;
  }
  return out;
};

/**
 * A client `character` look patch: sanitizeLook, plus `null` = "this field was not set" (contract R4: the Undo
 * inverse of a first species / markings / hair … sends null). It clears the key (undefined, never stored, so the
 * page spec hash is the one before the edit) instead of being ignored, which left the field set after Undo.
 * `summary` is always present and never cleared.
 */
const clientLook = (raw: unknown): Record<string, string | undefined> | undefined => {
  const out: Record<string, string | undefined> | undefined = sanitizeLook(raw);
  if (!out || !isObject(raw)) return out;
  for (const key of LOOK_FIELDS) if (key !== 'summary' && raw[key] === null) out[key] = undefined;
  return out;
};

const ARCHIVE_ONLY_KEYS = ['targetKey', 'archivedAt', 'starred', 'balloons'] as const;
const META_KEYS = ['specHash', 'qc', 'costUsd', 'resolution', 'aspect', 'jobHash', 'origin', 'note', 'parentPath', 'continuityPath', 'refPaths'] as const;

/** An asset as a plain reference: version/archive bookkeeping stripped (refs carry no render meta). */
const asPlainRef = (a: AssetRef): AssetRef => {
  const copy = { ...a } as AssetRef & Record<string, unknown>;
  const archived = typeof copy.targetKey === 'string';
  for (const k of ARCHIVE_ONLY_KEYS) delete copy[k];
  for (const k of META_KEYS) delete copy[k];
  // An archive entry's `label` is a display name ("Page 3"), not a RefLabel.
  if (archived) delete copy.label;
  return copy;
};

/**
 * Asset refs a client may set (refs, style board): any image the project already owns —
 * renders, versions, archive, trash, uploads (`collectAssetPaths` scope, so the Media bin's
 * "Use as reference" works) — never a foreign path, never a blocked or quarantined image.
 */
const knownAssets = (doc: ComicDoc) => {
  const known = new Map<string, AssetRef>();
  mapAssetRefs(doc, (a) => {
    if (a?.path && !known.has(a.path) && canServeToOwner(a)) known.set(a.path, asPlainRef(a));
    return a;
  });
  return known;
};

/**
 * A path this project wrote itself (u/<user>/p/<project>/{ref,img}/<id>.<ext>) — never a size
 * variant, a quarantine (q/) or publication (pub/) copy, never another user's or project's.
 * Contract §5.4 restore paths: Undo of character_remove / place_remove re-creates the entity with
 * its photos, which no longer appear in the doc (collectAssetPaths) once it was removed.
 */
export const isOwnProjectAssetPath = (path: unknown, userId: string | undefined, projectId: string | undefined): path is string => {
  if (typeof path !== 'string' || !userId || !projectId || path.length > 512 || path.includes('..')) return false;
  const m = /^u\/([^/]+)\/p\/([^/]+)\/(?:ref|img)\/([A-Za-z0-9_-]{1,80})\.(?:webp|png|jpe?g)$/.exec(path);
  return !!m && m[1] === userId && m[2] === projectId && !/_w\d{2,4}$/.test(m[3]);
};

/**
 * A restored ref rebuilt by the server: client-sent safety/hash/meta are dropped. It is always an
 * UPLOAD — in a ref list and as a sheet render alike: the client's "generated" can't be proven for a
 * path the doc no longer holds (an attachment in img/ would otherwise come back as a trusted sheet) —
 * so the job runner's lazy check (uncheckedRefs walks refs AND sheets) reads it before its first use
 * as a reference (safety.md §3.2).
 */
const restoredRef = (item: unknown, path: string, now: number): AssetRef => {
  const raw = isObject(item) ? item : {};
  const dim = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 20_000 ? Math.round(v) : undefined);
  const w = dim(raw.w);
  const h = dim(raw.h);
  const label = typeof raw.label === 'string' && (REF_LABELS as readonly string[]).includes(raw.label) ? raw.label : undefined;
  const note = clean(raw.note, 140);
  return {
    path,
    source: 'upload',
    at: now,
    ...(w && h ? { w, h } : {}),
    ...(label ? { label } : {}),
    ...(note ? { note } : {})
  } as AssetRef;
};

/**
 * The client's own copy says this image didn't pass the content check (blocked or quarantined): it
 * never comes back through a restore. Trusting that claim can only keep an image OUT, never let one in.
 */
const reportedBlocked = (item: unknown): boolean =>
  isObject(item) && isObject(item.safety) && !canServeToOwner({ safety: item.safety as unknown as SafetyVerdict });

type RestoreScope = { userId?: string; projectId: string; now: number; blocked: Set<string> };

/** An own-project path that may come back: never one the doc knows as blocked or quarantined. */
const restorable = (path: unknown, restore?: RestoreScope): path is string =>
  !!restore && isOwnProjectAssetPath(path, restore.userId, restore.projectId) && !restore.blocked.has(path);

const assetList = (known: Map<string, AssetRef>, restore?: RestoreScope) => (v: unknown): AssetRef[] | undefined => {
  if (!Array.isArray(v) || v.length > 12) return undefined;
  const out: AssetRef[] = [];
  for (const item of v) {
    const path = isObject(item) ? item.path : item;
    const ref = typeof path === 'string' ? known.get(path) : undefined;
    if (ref) {
      out.push(ref);
      continue;
    }
    // Not in the doc any more: only this project's own objects come back (Undo of a removal), rebuilt.
    if (restorable(path, restore)) {
      // A photo the client itself knew as blocked stays out; the rest of the undo still applies.
      if (!reportedBlocked(item)) out.push(restoredRef(item, path, restore.now));
      continue;
    }
    return undefined;
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
  // Undoing a removed edition sends one `translation` op per line: such an all-translation batch may be longer.
  const translationOnly = ops.every((o) => isObject(o) && o.op === 'translation');
  if (ops.length > (translationOnly ? MAX_TRANSLATION_PATCH_OPS : MAX_PATCH_OPS)) throw badRequest('Too many changes at once.');
  const known = knownAssets(doc);
  // Photos of a removed character/place/style come back only from this project's own storage lanes.
  const restore: RestoreScope | undefined = sanitizeCtx?.userId
    ? { userId: sanitizeCtx.userId, projectId: doc.id, now: sanitizeCtx.now ?? Date.now(), blocked: blockedPaths(doc) }
    : undefined;
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
            logline: clearable((v) => str(v, 600)),
            premise: clearable((v) => str(v, 4000)),
            genre: clearable((v) => str(v, 120)),
            tone: clearable((v) => str(v, 200)),
            audience: clearable((v) => str(v, 200)),
            setting: clearable((v) => str(v, 1000)),
            themes: clearable((v) => strList(v, 12, 120)),
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
        // The script is kept as typed (line breaks, spacing); only what jsonb rejects goes, and the clip never splits a pair.
        const patch = pick(raw.patch, { script: clearable((v) => (typeof v === 'string' ? clipText(storableText(v), LONG_TEXT_LIMIT) : undefined)) }, 'source');
        out.push({ op: 'source', patch: { ...patch, updatedAt: Date.now() } });
        break;
      }
      case 'style': {
        const patch = pick(
          raw.patch,
          {
            status: (v) => oneOf(v, ['empty', 'drafted', 'locked'] as const),
            name: clearable((v) => str(v, 80)),
            spec: clearable((v) => str(v, 2000)),
            palette: clearable((v) => strList(v, 8, 40)),
            linework: clearable((v) => str(v, 300)),
            avoid: clearable((v) => strList(v, 12, 120)),
            presetId: (v) => (v === null ? null : typeof v === 'string' && getStylePreset(v) ? v : undefined),
            refs: assetList(known, restore),
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
            role: clearable((v) => str(v, 200)),
            tier: (v) => oneOf(v, CAST_TIERS),
            look: clientLook,
            personality: clearable((v) => str(v, 1000)),
            voice: clearable((v) => str(v, 600)),
            refs: assetList(known, restore),
            // Cast details (the board's kind / group / likeness pickers, and Undo of character_remove, which
            // re-creates the whole entity). An unknown value is dropped, never stored; the rest of the edit applies.
            // null (the Undo inverse of a first kind / count / likeness) unsets it: person / single / 'auto'.
            kind: clearable((v) => oneOf(v, CAST_KINDS) ?? DROP),
            count: clearable((v) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= CAST_COUNT_MAX ? v : DROP)),
            likeness: clearable((v) => oneOf(v, CAST_LIKENESS) ?? DROP),
            sheet: (v) => restoredSheet(v, known, restore)
          },
          'character'
        );
        if (!castIds.has(charId) && !patch.name) throw badRequest('A new character needs a name.');
        // A sheet comes back only with a re-created character (Undo of a removal), never over a live one.
        if (castIds.has(charId)) delete patch.sheet;
        castIds.add(charId);
        out.push({ op: 'character', id: charId, patch: patch as Partial<Character> });
        break;
      }
      case 'character_remove':
        out.push({ op: 'character_remove', id: id(raw.id, 'character') });
        break;
      case 'place': {
        const placeId = id(raw.id, 'place');
        const patch = pick(
          raw.patch,
          { name: (v) => str(v, 80) || undefined, look: (v) => str(v, 1500), refs: assetList(known, restore), sheet: (v) => restoredSheet(v, known, restore) },
          'location'
        );
        if (!placeIds.has(placeId) && !patch.name) throw badRequest('A new location needs a name.');
        if (placeIds.has(placeId)) delete patch.sheet;
        placeIds.add(placeId);
        out.push({ op: 'place', id: placeId, patch: patch as Partial<Place> });
        break;
      }
      case 'place_remove':
        out.push({ op: 'place_remove', id: id(raw.id, 'place') });
        break;
      case 'page': {
        const p = page(raw.id);
        const patch = pick(
          raw.patch,
          {
            summary: (v) => str(v, 1000),
            layout: (v) => str(v, 1000),
            turnHook: clearable((v) => str(v, 500)),
            // Reader look: chapter openers ("" or null clears; the safety patch screen reads the text).
            chapterTitle: (v) => (v === null || v === '' ? null : str(v, DOC_LIMITS.chapterTitleChars) || undefined)
          },
          'page'
        );
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
            angle: clearable((v) => str(v, 200)),
            action: (v) => str(v, 2000),
            castIds: (v) => (Array.isArray(v) && v.length <= 12 && v.every((x) => typeof x === 'string' && castIds.has(x)) ? [...new Set(v as string[])] : undefined),
            placeId: (v) => (v === null || v === '' ? null : typeof v === 'string' && placeIds.has(v) ? v : undefined),
            mood: clearable((v) => str(v, 200))
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
            // Balloon text as typed (no trim: the editor owns spacing), jsonb-safe, clipped without splitting a pair.
            text: (v) => (typeof v === 'string' ? clipText(storableText(v), 600) : undefined)
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
        // The array REPLACES the page's balloons, so links are checked against the new array (in order):
        // a link that would close a cycle with an earlier balloon of the same array is dropped.
        const linked = new Map<string, string>();
        const balloons = raw.balloons.map((item) => {
          const balloon = sanitizeBalloon(item, lineIds, { ...p, balloons: [] });
          if (!balloon.linkTo) return balloon;
          const seen = new Set<string>([balloon.lineId]);
          let cycle = false;
          for (let at: string | undefined = balloon.linkTo; at; at = linked.get(at)) {
            if (seen.has(at)) {
              cycle = true;
              break;
            }
            seen.add(at);
          }
          if (cycle) {
            const { linkTo: _drop, ...rest } = balloon;
            return rest;
          }
          linked.set(balloon.lineId, balloon.linkTo);
          return balloon;
        });
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
            pinned: (v) => (typeof v === 'boolean' ? v : undefined),
            // lettering.md §9: stacking order, lock, link to the previous line (null clears).
            z: (v) => (v === null ? null : balloonZ(v)),
            locked: (v) => (typeof v === 'boolean' ? v : undefined),
            linkTo: (v) => (v === null ? null : balloonLink(p, raw.lineId as string, v))
          },
          'balloon'
        );
        out.push({ op: 'balloon', pageId: p.id, lineId: raw.lineId, patch: patch as Partial<Balloon> });
        break;
      }
      case 'cover': {
        const patch = pick(
          raw.patch,
          { title: clearable((v) => str(v, 200)), tagline: clearable((v) => str(v, 300)), direction: clearable((v) => str(v, 1500)) },
          'cover'
        );
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

/** Stacking order: an integer −100..100. */
const balloonZ = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-100, Math.min(100, Math.round(v))) : undefined);

/** linkTo: a line on the same page, never itself, never closing a cycle through the page's existing links. */
const balloonLink = (page: Page, lineId: string, v: unknown): string | undefined => {
  if (typeof v !== 'string' || v === lineId) return undefined;
  if (!page.panels.some((panel) => panel.lines.some((l) => l.id === v))) return undefined;
  const links = new Map(page.balloons.filter((b) => b.linkTo).map((b) => [b.lineId, b.linkTo as string]));
  links.set(lineId, v);
  const seen = new Set<string>([lineId]);
  for (let at: string | undefined = v; at; at = links.get(at)) {
    if (seen.has(at)) return undefined;
    seen.add(at);
  }
  return v;
};

const sanitizeBalloon = (raw: unknown, lineIds: Set<string>, page?: Page): Balloon => {
  if (!isObject(raw) || typeof raw.lineId !== 'string' || !lineIds.has(raw.lineId)) throw badRequest('Invalid balloon.');
  const x = num(raw.x, 0, 1);
  const y = num(raw.y, 0, 1);
  const w = num(raw.w, 0.04, 1);
  if (x === undefined || y === undefined || w === undefined) throw badRequest('Invalid balloon position.');
  const tailX = num(raw.tailX, 0, 1);
  const tailY = num(raw.tailY, 0, 1);
  const z = balloonZ(raw.z);
  const linkTo = page && raw.linkTo !== undefined && raw.linkTo !== null ? balloonLink(page, raw.lineId, raw.linkTo) : undefined;
  return {
    lineId: raw.lineId,
    x,
    y,
    w,
    ...(tailX !== undefined ? { tailX } : {}),
    ...(tailY !== undefined ? { tailY } : {}),
    ...(raw.pinned === true || raw.locked === true ? { pinned: true } : {}),
    ...(z !== undefined ? { z } : {}),
    ...(raw.locked === true ? { locked: true } : {}),
    ...(linkTo ? { linkTo } : {})
  };
};

/**
 * A sheet render sent back by Undo of character_remove / place_remove: its current image and versions
 * must be images this comic holds (or this project's own objects); everything else is rebuilt. A
 * render that can't be trusted comes back empty ("not drawn") rather than failing the whole undo.
 */
const restoredSheet = (v: unknown, known: Map<string, AssetRef>, restore?: RestoreScope): RenderState | undefined => {
  if (!isObject(v)) return undefined;
  const one = (a: unknown): AssetRef | undefined => {
    const path = isObject(a) ? a.path : undefined;
    if (typeof path !== 'string') return undefined;
    const hit = known.get(path);
    if (hit) return hit;
    return restorable(path, restore) && !reportedBlocked(a) ? restoredRef(a, path, restore!.now) : undefined;
  };
  const asset = one(v.asset);
  const history = (Array.isArray(v.history) ? v.history : []).slice(0, 12).map(one).filter((a): a is AssetRef => !!a);
  const status = v.status === 'ready' && asset ? 'ready' : asset ? 'stale' : 'none';
  const specHash = typeof v.specHash === 'string' && v.specHash.length <= 128 ? v.specHash : undefined;
  return { status, history, ...(asset ? { asset } : {}), ...(specHash && asset ? { specHash } : {}), updatedAt: Date.now() } as RenderState;
};

function applyPatch(ctx: StudioContext, ops: unknown, opts: RunActionOptions): ActionOutcome {
  const sanitized = sanitizePatchOps(ctx.session.doc, ops, sanitizeCtxFor(ctx, opts));
  commitAs(ctx, sanitized, originOf(opts));
  return { status: 'done', message: `Saved ${plural(sanitized.length, 'change')}.` };
}

// ── Next steps ───────────────────────────────────────────────────────────────

const dedupeSteps = (steps: NextStep[]): NextStep[] => {
  const seen = new Set<string>();
  return steps.filter((s) => {
    const key = s.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** The published comic is behind the studio: a page or the cover changed after the last publish. */
const publicationBehind = (doc: ComicDoc): boolean => {
  const pub = doc.publication;
  if (!pub || pub.status !== 'live') return false;
  const at = pub.publishedAt || 0;
  return doc.pages.some((p) => (p.render.updatedAt || 0) > at && p.render.status === 'ready') || ((doc.cover.render.updatedAt || 0) > at && doc.cover.render.status === 'ready');
};

/**
 * 2–4 acting chips from doc state (deterministic, $0). They follow the forward motion
 * idea → style → cast → plan → draw → cover → read → share, and they act: a spend chip
 * carries its action and quote (a tap is the confirmation; a stale quote re-gates),
 * navigation is a client action, everything else is said to the director.
 * - Never "draw all" when every page is drawn and current.
 * - "Make the cover" as soon as page 1 is ready.
 * - "Compare versions" before "Redraw" when a low-QC page has ≥ 2 versions.
 * - "Share it" after the last page; "Update the published version" when the comic is behind.
 */
export function nextStepsFor(doc: ComicDoc, opts: { byok?: boolean } = {}): NextStep[] {
  const byok = !!opts.byok;
  const out: NextStep[] = [];
  const add = (s: NextStep | null) => {
    if (s && !out.some((o) => o.label === s.label)) out.push(s);
  };
  const say = (label: string): NextStep => ({ label });
  const spend = (label: string, action: SpendAction): NextStep | null => {
    const est = estimateSpendAction(doc, action, byok);
    if (est.imageCount <= 0) return null;
    return { label, action: { ...action, quotedUsd: est.usd }, usd: est.usd };
  };
  const hasIdea = !!(clean(doc.brief.premise) || clean(doc.brief.logline) || clean(doc.source.script) || doc.cast.length);
  if (!hasIdea) return [say('A heist comic set in Mumbai'), say('Paste a script'), say('A cozy fantasy for kids')];

  const pagesBusy = doc.pages.some((p) => isBusy(p.render));
  const castBusy = doc.cast.some((c) => isBusy(c.sheet));
  if (doc.style.status === 'empty' || (doc.style.status === 'drafted' && !doc.style.options.length && !doc.style.spec)) add(say('Show me 3 styles'));
  if (!doc.cast.length) add(say('Suggest a cast'));
  if (doc.style.status !== 'empty' && !castBusy && doc.cast.some(needsSheet) && doc.planStatus === 'none') add(spend('Draw the character sheets', { type: 'render_sheets' }));
  if (doc.planStatus === 'none') {
    const usd = round4(PLAN_USD_PER_PAGE * Math.max(1, doc.format.pageCount || 1) * (byok ? 1 : PLATFORM_MARKUP));
    add({ label: 'Plan the pages', action: { type: 'plan_pages' }, usd });
  }
  if (doc.pages.length && !pagesBusy) {
    const undrawn = doc.pages.filter((p) => p.render.status !== 'ready' && p.panels.length);
    const stale = doc.pages.filter((p) => isPageStale(doc, p));
    if (doc.planStatus === 'draft') {
      add(spend(undrawn.length === doc.pages.length ? 'Approve & draw all' : 'Approve & draw the rest', { type: 'render_pages' }));
      add(say('Make page 1 more dramatic'));
    } else if (doc.planStatus === 'approved') {
      if (undrawn.length) add(spend(undrawn.length === doc.pages.length ? 'Draw all pages' : 'Draw the remaining pages', { type: 'render_pages' }));
      else if (stale.length) add(spend('Redraw the out-of-date pages', { type: 'render_pages' }));
    }
  }
  const page1 = doc.pages.find((p) => p.n === 1);
  if (page1?.render.status === 'ready' && doc.cover.render.status !== 'ready' && !isBusy(doc.cover.render)) add(spend('Make the cover', { type: 'render_cover' }));
  const weak = [...doc.pages].sort((a, b) => a.n - b.n).find((p) => p.render.status === 'ready' && typeof p.render.qc?.score === 'number' && p.render.qc.score < LOW_QC_SCORE && !isBusy(p.render));
  if (weak) {
    if (versionsOf(weak.render).length >= 2) add({ label: `Compare page ${weak.n} versions`, client: { type: 'open_page', pageId: weak.id } });
    add(spend(`Redraw page ${weak.n}`, { type: 'render_pages', pageIds: [weak.id], force: true }));
  }
  const allDrawn = doc.pages.length > 0 && doc.pages.every((p) => p.render.status === 'ready');
  if (allDrawn) {
    add({ label: 'Read it', client: { type: 'open_reader' } });
    if (publicationBehind(doc)) add({ label: 'Update the published version', client: { type: 'open_share' } });
    else if (!doc.publication) add({ label: 'Share it', client: { type: 'open_share' } });
  }
  if (out.length < 2 && doc.pages.length) add(say('Add a twist on the last page'));
  if (out.length < 2) add(say('Make it funnier'));
  return out.slice(0, DOC_NEXT_STEPS);
}

/**
 * 2–4 short next-step chips as text (legacy `Msg.suggestions` and the director's reply);
 * the labels of nextStepsFor().
 */
export function suggestNextSteps(doc: ComicDoc): string[] {
  return nextStepsFor(doc).map((s) => s.label);
}

export { isSpendAction };
