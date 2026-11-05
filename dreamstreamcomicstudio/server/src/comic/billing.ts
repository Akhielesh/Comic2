// Per-call billing for Comic Studio (v4).
//
// Wraps the platform ledger (services/usageEnforcer.ts) so every paid call — each page,
// sheet, style board, edit, cover and text role — is reserved before it runs, settled
// with the provider-reported cost when it lands, and released when it fails.
//
// Why a request clone per call: usageEnforcer keeps the reservation on
// `req.usageReservation`, so N parallel page renders on one request would overwrite each
// other's reservation and settle/release the wrong one. `Object.create(req)` gives each
// call its own reservation slot while still reading the user, keys and headers through
// the prototype. The clone also pins what the ledger sees: a tiny body (so the estimator
// doesn't scan a 10 MB attachment payload), the model WE are calling (the client's
// X-Gemini-Model header must not re-price it), and BYOK flags that match the key the
// studio actually routes with.
//
// Metering runs on METERING_ENABLED (default on), NOT on Stripe's BILLING_ENABLED (which stays
// "false" in production): every Comic Studio image and text call reserves against the user's
// usage budget before it runs (P1-LIMITS). Platform-paid safety checks never pass through here —
// they are platform overhead and don't count against anyone's usage.
//
// Bookkeeping never breaks a render for an UNGOVERNED caller (admin/exempt/own key): ledger errors
// are logged and swallowed (fail open). A governed user's budget check never throws — when it
// can't run, usageEnforcer returns an honest refusal (fail closed) — and a real denial is never
// swallowed: the caller turns it into an honest notice card.

import type { Request } from 'express';
import type { LimitExceededDetails } from '../../../shared/types/billing.js';
import type { Resolution } from '../../../shared/comic/doc.js';
import { getImageModel, imagePriceUsd, type ImageJobKind, type ImageRoute } from '../../../shared/comic/models.js';
import { METERING_ENABLED } from '../config.js';
import { logger } from '../lib/logger.js';
import { recordModelUsage } from '../services/modelStats.js';
import { ownKeyPath, usageUnavailableMessage } from '../services/platformAllowance.js';
import { getSupabaseAdmin, getSupabaseCapabilityStatus } from '../services/supabase.js';
import { releaseReservedOperation, reserveForOperation, settleReservedOperation } from '../services/usageEnforcer.js';
import type { UsagePayload } from '../services/costEstimator.js';
import { studioKeysFromRequest } from './keys.js';
import { estimateTextCostUsd } from './textModels.js';
import type { BillingHooks, BillingReservation, BillingReserveResult } from './types.js';

type ReserveArgs = Parameters<BillingHooks['reserve']>[0];

export interface BillingDeps {
  reserve?: typeof reserveForOperation;
  settle?: typeof settleReservedOperation;
  release?: typeof releaseReservedOperation;
  /** Override METERING_ENABLED (tests). */
  enabled?: boolean;
  /** Base wait before a settle retry (tests pass 0). Default SETTLE_RETRY_DELAY_MS. */
  settleRetryDelayMs?: number;
}

/**
 * A settle that fails leaves a RESERVED row the budget stops counting after 20 minutes
 * (user_usage_budgets.sql) until the reconciliation job settles it at its hold when it runs
 * (jobs/strandedHolds.ts via `npm run billing:reconcile`; scheduled once the root workflow exists).
 * The provider call already happened, so a failed settle is retried before it is given up on —
 * but ONLY where the ledger's settle cannot move money twice: a hold that skipped the wallet
 * (usage budgets on) or a BYOK bypass settles by reservation id. The wallet branch runs
 * billing_settle_tokens first, which takes no reservation id (it deducts purchased credits and
 * adds overage), so a retry after a later write failed would charge the wallet again: one attempt.
 * A hold that is given up on is logged with its id and amount so it can be repaired.
 */
const SETTLE_ATTEMPTS = 3;
const SETTLE_RETRY_DELAY_MS = 400;

const wait = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

const noopReservation: BillingReservation = {
  async settle() {
    return {};
  },
  async release() {
    /* nothing reserved */
  }
};

/** Hooks that allow everything and record nothing (billing disabled, tests, scripts). */
export const noopBillingHooks: BillingHooks = {
  async reserve() {
    return { ok: true, reservation: noopReservation };
  }
};

const ADD_KEY_HINT = 'add your own key in Settings → API keys';

/** A friendly, actionable sentence for a ledger denial. */
export const billingDenialMessage = (details?: Partial<LimitExceededDetails> | null): string => {
  // A key already on file is named, never "add your own key" (UB-6). The fallback mode decides the words.
  const ownKey = details?.canFallbackToByok ? { canFallbackToByok: true, byokFallbackMode: details.byokFallbackMode ?? 'ask' } : undefined;
  switch (details?.reason) {
    case 'usage_budget_exhausted':
      // The gate's own percent-only sentence (top-up / own-key path); never a dollar figure. The key
      // "takes over from here" only when the usage is known to be used up (else the conservative path).
      return (
        details.message ||
        `You've used all of your DreamStream usage. It doesn't reset on its own — ask us for a top-up, or ${
          ownKey ? ownKeyPath(ownKey, (details.pctLeft ?? 100) < 0.5) : 'add your own API key in Settings → API keys'
        } to keep going.`
      );
    case 'usage_budget_unavailable':
      // An unreadable status keeps the account on the platform key, so a key on file never takes over
      // by itself here: the user switches (usageUnavailableMessage, the same in every mode).
      return (
        details.message ||
        (ownKey ? usageUnavailableMessage(ownKey) : `We couldn't check your usage just now, so nothing was spent. Please try again in a moment — or ${ADD_KEY_HINT}.`)
      );
    case 'platform_allowance_exhausted':
      return "You've used this month's included generation allowance. Add your own key in Settings → API keys, or upgrade.";
    case 'MONTHLY_INCLUDED_EXHAUSTED':
      return `You've used this month's included credits. Add credits or upgrade your plan — or ${ADD_KEY_HINT}.`;
    case 'DAILY_LIMIT_EXCEEDED':
      return `You've reached today's generation limit for your plan. It resets tomorrow — or upgrade, or ${ADD_KEY_HINT}.`;
    case 'INSUFFICIENT_CREDITS':
      return `You don't have enough credits for this. Add credits or upgrade — or ${ADD_KEY_HINT}.`;
    case 'PAYMENT_METHOD_REQUIRED':
      return 'Add a payment method in Settings → Billing to keep generating past your included credits.';
    case 'OVERAGE_CAP_REACHED':
      return `You've reached your monthly overage cap. Raise it in Settings → Billing, or ${ADD_KEY_HINT}.`;
    default:
      return `Billing couldn't approve this generation right now. Check your plan in Settings → Billing, or ${ADD_KEY_HINT}.`;
  }
};

/** The ledger only prices 1K/2K/4K; a 512 swatch is billed as 1K. */
const toLedgerResolution = (resolution?: Resolution): '1K' | '2K' | '4K' | undefined =>
  resolution === '2K' || resolution === '4K' ? resolution : resolution ? '1K' : undefined;

/** Registry list price for an image op, used when the provider reports no cost (Gemini direct). */
const registryImageCostUsd = (model: string, resolution: Resolution | undefined, units: number): number | undefined => {
  const spec = getImageModel(model);
  if (!spec || units <= 0) return undefined;
  return Math.round(imagePriceUsd(spec, resolution || '1K') * units * 1_000_000) / 1_000_000;
};

const finite = (n: unknown): number | undefined => (typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined);

/**
 * A per-call view of the request for the ledger. Reads everything else through the
 * prototype; owns its reservation slot.
 */
const cloneRequestForCall = (req: Request, args: ReserveArgs, byok: boolean): Request => {
  const clone = Object.create(req) as Request;
  clone.body = { model: args.model, operation: args.operation, stage: args.stage };
  const header = ((name: string) => (/^x-gemini-model$/i.test(name) ? undefined : req.header(name))) as Request['header'];
  clone.header = header;
  clone.get = header as Request['get'];
  clone.usageReservation = undefined;
  clone.usageLimitDetails = undefined;
  clone.allowanceNotices = undefined;
  const providerKeys = { ...(req.apiKeys?.providerKeys || {}) };
  const current = providerKeys[args.provider];
  providerKeys[args.provider] = { key: current?.key ?? null, byok };
  clone.apiKeys = { ...(req.apiKeys || {}), providerKeys };
  return clone;
};

export function createBillingHooks(req: Request, projectId: string, deps: BillingDeps = {}): BillingHooks {
  const enabled = deps.enabled ?? METERING_ENABLED;
  if (!enabled || !(req as Request & { user?: { id: string } })?.user?.id) return noopBillingHooks;

  const reserveFn = deps.reserve || reserveForOperation;
  const settleFn = deps.settle || settleReservedOperation;
  const releaseFn = deps.release || releaseReservedOperation;
  const retryDelayMs = Math.max(0, deps.settleRetryDelayMs ?? SETTLE_RETRY_DELAY_MS);
  // Same resolution the studio routes with, so BYOK-ness always matches the key used.
  const keys = studioKeysFromRequest(req);

  const reserve = async (args: ReserveArgs): Promise<BillingReserveResult> => {
    const byok = Boolean(keys[args.provider as ImageRoute]?.byok);
    const clone = cloneRequestForCall(req, args, byok);
    const isImage = (args.imageUnits || 0) > 0;
    const metadata: Record<string, unknown> = {
      surface: 'comic_studio_v4',
      stage: args.stage,
      ...(args.resolution ? { resolution: args.resolution } : {})
    };

    // The studio's own price for THIS call (registry image price at the resolution it renders;
    // text list price for its token budget) — the usage budget never holds less than this, so
    // parallel page renders can't each under-reserve against a stale catalog row. A text call
    // on a fallback chain may be served by any of its models: the floor is the dearest of them.
    const textModels = isImage ? [] : [args.model, ...(args.models || [])].filter((m, i, all) => !!m && all.indexOf(m) === i);
    const estimateFloorUsd = isImage
      ? registryImageCostUsd(args.model, args.resolution, args.imageUnits || 0)
      : textModels.reduce<number | undefined>((best, m) => {
          const usd = estimateTextCostUsd(m, args.inputTokens || 0, args.outputTokens || 0);
          return usd === undefined ? best : best === undefined || usd > best ? usd : best;
        }, undefined);

    let reserved: Awaited<ReturnType<typeof reserveForOperation>>;
    try {
      reserved = await reserveFn({
        req: clone,
        operation: args.operation,
        provider: args.provider,
        fallbackModel: args.model,
        ...(textModels.length > 1 ? { pricedModels: textModels } : {}),
        imageUnits: args.imageUnits ?? 0,
        resolution: toLedgerResolution(args.resolution),
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        projectId,
        comicId: projectId,
        stage: args.stage,
        metadata,
        ...(estimateFloorUsd !== undefined && estimateFloorUsd > 0 ? { estimateFloorUsd } : {})
      });
    } catch (err) {
      logger.warn('comic_billing_reserve_failed', {
        operation: args.operation,
        model: args.model,
        message: (err as Error)?.message
      });
      return { ok: true, reservation: noopReservation };
    }

    if (!reserved.allowed) {
      const details = (reserved as { details?: LimitExceededDetails }).details;
      logger.info('comic_billing_denied', { operation: args.operation, model: args.model, reason: details?.reason });
      return { ok: false, code: 'BILLING_DENIED', message: billingDenialMessage(details) };
    }

    const seed = reserved.seed;
    let done = false;

    const reservation: BillingReservation = {
      async settle(result) {
        if (done) return {};
        done = true;
        const imageUnits = finite(result.imageUnits) ?? args.imageUnits ?? 0;
        const reported = finite(result.costUsd);
        // Gemini direct reports no cost: settle image ops at the registry list price for
        // the resolution actually rendered, not a single flat catalog row.
        const providerCostUsd = reported ?? (isImage ? registryImageCostUsd(args.model, args.resolution, imageUnits) : undefined);
        const promptTokens = finite(result.promptTokens);
        const completionTokens = finite(result.completionTokens);
        const usage: UsagePayload = {
          ...(promptTokens !== undefined ? { promptTokens } : {}),
          ...(completionTokens !== undefined ? { candidatesTokens: completionTokens } : {}),
          ...(promptTokens !== undefined || completionTokens !== undefined
            ? { totalTokens: (promptTokens || 0) + (completionTokens || 0) }
            : {}),
          ...(providerCostUsd !== undefined && providerCostUsd > 0 ? { providerCostUsd } : {})
        };
        const held = clone.usageReservation;
        const attempts = held && (held.walletSkipped || held.byokBypass) ? SETTLE_ATTEMPTS : 1;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          try {
            const settled = await settleFn({
              req: clone,
              operation: args.operation,
              provider: reserved.provider,
              model: reserved.model,
              seed,
              usage,
              imageUnits,
              metadata: { ...metadata, providerCostReported: reported !== undefined }
            });
            // Surface allowance threshold notices (30/70/90%) on the real request so the
            // route can drain them with consumeAllowanceNotices(req).
            const notices = Object.prototype.hasOwnProperty.call(clone, 'allowanceNotices') ? clone.allowanceNotices : undefined;
            if (notices?.length) req.allowanceNotices = [...(req.allowanceNotices || []), ...notices];
            return { billableUsd: typeof settled?.billableUsd === 'number' ? settled.billableUsd : undefined };
          } catch (err) {
            const reservationId = clone.usageReservation?.reservationId;
            if (attempt < attempts) {
              logger.warn('comic_billing_settle_retry', { operation: args.operation, model: args.model, reservationId, attempt, message: (err as Error)?.message });
              await wait(retryDelayMs * attempt);
              continue;
            }
            // Given up: the hold is stranded (it stops counting after 20 minutes). Everything a
            // repair needs is in this one line — the id, the amount and what it was for.
            logger.error('comic_billing_settle_failed', {
              operation: args.operation,
              model: args.model,
              reservationId,
              stranded: true,
              attempts: attempt,
              // The amount actually held (the ledger's estimate), not just the studio's floor for it.
              holdUsd: held?.estimated?.estimatedProviderCostUsd ?? estimateFloorUsd,
              providerCostUsd,
              projectId,
              message: (err as Error)?.message
            });
            return {};
          }
        }
        return {};
      },
      async release(reason) {
        if (done) return;
        done = true;
        try {
          await releaseFn({
            req: clone,
            operation: args.operation,
            provider: reserved.provider,
            model: reserved.model,
            projectId,
            reason: String(reason || 'released').slice(0, 300),
            metadata
          });
        } catch (err) {
          logger.error('comic_billing_release_failed', {
            operation: args.operation,
            model: args.model,
            message: (err as Error)?.message
          });
        }
      }
    };

    return { ok: true, reservation };
  };

  return { reserve };
}

// ── Per-call facts: comic_image_calls + model_usage_monthly (models.md §3.4 item 9, §4.5 S7) ──────────────
//
// Every image attempt (and every vision-QC call, kind 'qc') becomes one row in comic_image_calls, written with
// the service role (RLS: owners read their own rows; inserts are service-role only). A successful image also bumps
// the aggregate counter model_usage_monthly (product 'comic_studio'). Recording is fire-and-forget: it never
// blocks a render, never throws into one, and a failed write is logged and dropped — the money facts that matter
// for billing live in the usage ledger (above) and the doc's spend entries, not here.

/** One provider call as comic_image_calls stores it (column meanings: server/sql/comic_image_calls.sql). */
export interface ImageCallRecord {
  userId: string;
  projectId?: string;
  /** Registry id (the vision model id for kind 'qc'). */
  modelId: string;
  /** The provider's model id that was requested. */
  providerModel?: string;
  route?: ImageRoute;
  /** Which upstream provider served (or refused) the call, when the transport reports it. */
  providerName?: string;
  kind: ImageJobKind | 'qc';
  /** '512' | '1K' | '2K' | '4K'; null for QC rows. */
  res?: Resolution | null;
  aspect?: string;
  refs?: number;
  /** 'blocked' = stopped before any provider call (the money-safe preflight). */
  outcome: 'ok' | 'failed' | 'blocked';
  httpStatus?: number;
  /** StudioError code ('RATE_LIMIT' for 429s) or the preflight's 'MODEL_DOWN'. */
  errorCode?: string;
  /** Provider-reported cost before markup; null = not reported. */
  providerCostUsd?: number | null;
  /** What this user was charged for it (markup applied unless BYOK). */
  billedUsd?: number;
  byok?: boolean;
  latencyMs?: number;
  /** The model version the provider reported (models.md §2.5; audit of a provider-side redirect). */
  modelVersion?: string;
}

export interface ImageCallRecorder {
  /** Fire-and-forget: must never throw and never be awaited by a render. */
  record(row: ImageCallRecord): void;
}

/** The product name the comic studio's calls are counted under in model_usage_monthly. */
export const COMIC_USAGE_PRODUCT = 'comic_studio';

const ROUTES: ReadonlySet<string> = new Set(['openrouter', 'gemini']);
const RESOLUTIONS: ReadonlySet<string> = new Set(['512', '1K', '2K', '4K']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clip = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? v.slice(0, max) : null);
const money6 = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 1_000_000) / 1_000_000 : null);
const int = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : null;

/** The snake_case row for comic_image_calls (bounded values only; anything malformed becomes null). */
export const imageCallRow = (r: ImageCallRecord): Record<string, unknown> => {
  const row: Record<string, unknown> = {
    user_id: r.userId,
    project_id: typeof r.projectId === 'string' && UUID_RE.test(r.projectId) ? r.projectId : null,
    model_id: clip(r.modelId, 120),
    provider_model: clip(r.providerModel, 160),
    route: r.route && ROUTES.has(r.route) ? r.route : null,
    provider_name: clip(r.providerName, 80),
    kind: clip(r.kind, 20),
    res: typeof r.res === 'string' && RESOLUTIONS.has(r.res) ? r.res : null,
    aspect: clip(r.aspect, 10),
    refs: int(r.refs, 0, 32),
    outcome: r.outcome,
    http_status: int(r.httpStatus, 0, 999),
    error_code: clip(r.errorCode, 40),
    provider_cost_usd: money6(r.providerCostUsd),
    billed_usd: money6(r.billedUsd),
    byok: typeof r.byok === 'boolean' ? r.byok : null,
    latency_ms: int(r.latencyMs, 0, 3_600_000)
  };
  const version = clip(r.modelVersion, 160);
  if (version) row.model_version = version;
  return row;
};

export interface ImageCallRecorderDeps {
  /** The service-role client (default: getSupabaseAdmin, only when storage is configured). */
  db?: () => { from(table: string): { insert(row: Record<string, unknown>): PromiseLike<{ error: { message?: string } | null }> } };
  /** model_usage_monthly bump (default: services/modelStats recordModelUsage). */
  bumpUsage?: (product: string, source: string, model: string) => void;
  /** Override the storage check (tests). */
  enabled?: boolean;
}

/**
 * comic_image_calls writer (service role) + the model_usage_monthly bump. A row with `model_version` is retried
 * once without it when the column does not exist yet (server/sql/comic_image_calls_model_version.sql not applied),
 * so recording keeps working before that PROD STEP.
 */
export function createImageCallRecorder(deps: ImageCallRecorderDeps = {}): ImageCallRecorder {
  const enabled = () => deps.enabled ?? getSupabaseCapabilityStatus().storagePersistenceEnabled;
  const db = deps.db ?? (() => getSupabaseAdmin() as unknown as ReturnType<NonNullable<ImageCallRecorderDeps['db']>>);
  const bump = deps.bumpUsage ?? recordModelUsage;
  const insert = async (row: Record<string, unknown>): Promise<void> => {
    const first = await db().from('comic_image_calls').insert(row);
    if (!first.error) return;
    if ('model_version' in row && /model_version/i.test(String(first.error.message || ''))) {
      const { model_version: _drop, ...rest } = row;
      const second = await db().from('comic_image_calls').insert(rest);
      if (!second.error) return;
      throw new Error(String(second.error.message || 'insert failed'));
    }
    throw new Error(String(first.error.message || 'insert failed'));
  };
  return {
    record(r) {
      try {
        if (!enabled() || !r || typeof r.userId !== 'string' || !UUID_RE.test(r.userId)) return;
        const row = imageCallRow(r);
        void insert(row).catch((err: unknown) => {
          logger.warn('comic_image_call_record_failed', { kind: row.kind, outcome: row.outcome, message: String((err as Error)?.message || err).slice(0, 200) });
        });
        if (r.outcome === 'ok' && r.kind !== 'qc') bump(COMIC_USAGE_PRODUCT, row.route ? String(row.route) : 'openrouter', String(row.provider_model || row.model_id || ''));
      } catch (err) {
        logger.warn('comic_image_call_record_failed', { message: String((err as Error)?.message || err).slice(0, 200) });
      }
    }
  };
}

/** Records nothing (tests, scripts). */
export const noopImageCallRecorder: ImageCallRecorder = { record() {} };

let processRecorder: ImageCallRecorder | null = null;

/** The process-wide recorder (built lazily: importing this module writes and schedules nothing). */
export const imageCallRecorder = (): ImageCallRecorder => (processRecorder ??= createImageCallRecorder());

/** Swap the process-wide recorder (tests; null = rebuild lazily). Returns the previous one. */
export const setImageCallRecorder = (recorder: ImageCallRecorder | null): ImageCallRecorder | null => {
  const previous = processRecorder;
  processRecorder = recorder;
  return previous;
};

/** Record one call. Never throws, never awaits: a recording failure can never fail a job. */
export const recordImageCall = (row: ImageCallRecord): void => {
  try {
    imageCallRecorder().record(row);
  } catch (err) {
    logger.warn('comic_image_call_record_failed', { message: String((err as Error)?.message || err).slice(0, 200) });
  }
};
