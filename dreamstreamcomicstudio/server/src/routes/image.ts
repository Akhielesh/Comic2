import { Request, Response, Router } from 'express';
import crypto from 'node:crypto';
import { requireGeminiKey, requirePixazoKey, requireOpenRouterKey, requireNvidiaKey, requireIdeogramKey } from '../middleware/keys.js';
import { checkLimits } from '../middleware/limits.js';
import { BILLING_ENABLED, FLUX_MODEL_ID, IDEMPOTENCY_TTL_MS, IMAGE_INCLUDE_DATA_URL_LEGACY, IMAGE_MODEL, OPENROUTER_IMAGE_MODEL, NVIDIA_IMAGE_MODEL, IDEOGRAM_MODEL_ID } from '../config.js';
import { generateGeminiImage } from '../ai/image.js';
import { generateFluxImage } from '../ai/flux.js';
import { generateIdeogramImage } from '../ai/ideogram.js';
import { getProvider, resolveProviderContext } from '../ai/gateway.js';
import type { GenerateImageResult } from '../ai/providers/types.js';
import { resolveStageModel } from '../ai/stageModels.js';
import { persistGeneratedImage } from '../services/imageStorage.js';
import {
  attachBillingToPayload,
  formatLimitErrorResponse,
  hasByokForProvider,
  releaseReservedOperation,
  reserveForOperation,
  settleReservedOperation
} from '../services/usageEnforcer.js';
import {
  assertModelAllowedForTier,
  createFreeNanoBananaLimitError,
  resolvePlanTierForUser,
  toEffectiveTier,
  tryConsumeFreeNanoBananaUsage
} from '../services/modelAccessPolicy.js';
import { getAllowanceStatus, isUsageExemptAdmin, meteringEnabled } from '../services/platformAllowance.js';
import { IMAGE_MODELS } from '../../../shared/comic/models.js';
import type { BillingPlanTier, ReservationState } from '../../../shared/types/billing.js';

export const imageRouter = Router();

type IdempotencyResult = Record<string, unknown>;
type IdempotencyRecord = {
  expiresAt: number;
  requestHash: string;
  response: IdempotencyResult;
};

const idempotencyResponseCache = new Map<string, IdempotencyRecord>();
const idempotencyInFlight = new Map<string, Promise<IdempotencyRecord>>();
let idempotencyOperationCount = 0;
const MAX_IDEMPOTENCY_CACHE_BYTES = 2_000_000;
const MAX_IDEMPOTENCY_CACHE_ENTRIES = 1000; // hard cap so a burst of unique keys can't grow memory unbounded

const cleanupExpiredIdempotencyRecords = (now: number) => {
  for (const [key, value] of idempotencyResponseCache.entries()) {
    if (value.expiresAt <= now) {
      idempotencyResponseCache.delete(key);
    }
  }
  // Expiry alone can't bound memory when many distinct keys arrive inside one TTL window.
  // Map preserves insertion order, so evicting from the front drops the oldest records
  // (which, with a uniform TTL, are also the soonest to expire) until we're under the cap.
  if (idempotencyResponseCache.size > MAX_IDEMPOTENCY_CACHE_ENTRIES) {
    const overflow = idempotencyResponseCache.size - MAX_IDEMPOTENCY_CACHE_ENTRIES;
    let removed = 0;
    for (const key of idempotencyResponseCache.keys()) {
      if (removed >= overflow) break;
      idempotencyResponseCache.delete(key);
      removed += 1;
    }
  }
};

const normalizeIdempotencyKey = (value?: string | null) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 128);
};

const hashPayload = (payload: unknown) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(payload ?? null))
    .digest('hex');

const toIdempotencyConflictError = () => {
  const error = new Error('Idempotency key already used with a different payload.') as Error & {
    status?: number;
    publicCode?: string;
  };
  error.status = 409;
  error.publicCode = 'CONFLICT';
  return error;
};

const withIdempotency = async (
  req: Request,
  res: Response,
  scope: string,
  operation: () => Promise<IdempotencyResult>
) => {
  const headerKey = normalizeIdempotencyKey(req.header('Idempotency-Key'));
  if (!headerKey) {
    return operation();
  }

  const actor = req.user?.id || req.ip || 'anonymous';
  const cacheKey = `${scope}:${actor}:${headerKey}`;
  const requestHash = hashPayload(req.body);
  const now = Date.now();

  idempotencyOperationCount += 1;
  if (idempotencyOperationCount % 100 === 0) {
    cleanupExpiredIdempotencyRecords(now);
    idempotencyOperationCount = 0;
  }

  const cached = idempotencyResponseCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    if (cached.requestHash !== requestHash) {
      throw toIdempotencyConflictError();
    }
    res.setHeader('Idempotency-Replayed', 'true');
    return cached.response;
  }
  if (cached) {
    idempotencyResponseCache.delete(cacheKey);
  }

  const pending = idempotencyInFlight.get(cacheKey);
  if (pending) {
    const resolved = await pending;
    if (resolved.requestHash !== requestHash) {
      throw toIdempotencyConflictError();
    }
    res.setHeader('Idempotency-Replayed', 'true');
    return resolved.response;
  }

  const executionPromise = (async () => {
    const response = await operation();
    const record: IdempotencyRecord = {
      requestHash,
      response,
      expiresAt: Date.now() + IDEMPOTENCY_TTL_MS
    };
    try {
      const estimatedBytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
      if (estimatedBytes <= MAX_IDEMPOTENCY_CACHE_BYTES) {
        idempotencyResponseCache.set(cacheKey, record);
      } else {
        console.warn('[IDEMPOTENCY] Skipping cache for oversized response', {
          scope,
          estimatedBytes,
          maxBytes: MAX_IDEMPOTENCY_CACHE_BYTES
        });
      }
    } catch {
      console.warn('[IDEMPOTENCY] Failed to estimate response size; skipping cache storage.', { scope });
    }
    return record;
  })();

  idempotencyInFlight.set(cacheKey, executionPromise);
  res.setHeader('Idempotency-Replayed', 'false');

  try {
    const resolved = await executionPromise;
    return resolved.response;
  } finally {
    idempotencyInFlight.delete(cacheKey);
  }
};

const isMissingServiceRoleKeyError = (error: unknown) => {
  const maybeError = error as { publicCode?: string; status?: number; message?: string; details?: string };
  return (
    maybeError?.publicCode === 'MISSING_SERVICE_ROLE_KEY' ||
    maybeError?.publicCode === 'MISSING_SUPABASE_CONFIG' ||
    (maybeError?.status === 503 &&
      (String(maybeError?.message || '').includes('SUPABASE_SERVICE_ROLE_KEY') ||
        String(maybeError?.details || '').includes('VITE_SUPABASE_URL')))
  );
};

const buildTimings = (apiMs = 0, saveMs = 0) => ({
  apiMs,
  saveMs,
  totalMs: apiMs + saveMs
});

const toBillingLimitError = (details: unknown) => {
  const error = new Error('Token billing limit exceeded.') as Error & {
    status?: number;
    publicCode?: string;
    details?: unknown;
  };
  error.status = 402;
  error.publicCode = 'BILLING_LIMIT_EXCEEDED';
  error.details = details;
  return error;
};

// ── Model access + daily cap on the legacy routes (P1-LIMITS / P2-PLATFORM) ────────────────────
// With Stripe billing ON the plan decides which image models a user may request. With billing OFF
// and usage metering ON (production today) there are no plans to buy: the usage budget is the one
// meter, and the rule matches Comic Studio (comic/access.ts): the user's own key, admins, exempt
// budget rows and `allow_pro` rows may request any model; everyone else (governed testers) gets
// the everyday list. A usage lookup that fails closes to the everyday list. Metering off keeps
// the legacy plan gate.

export type ImageModelAccess =
  | { mode: 'plan'; planTier: BillingPlanTier | string }
  | { mode: 'usage'; pro: boolean };

export interface ImageModelAccessDeps {
  billingEnabled?: boolean;
  meteringEnabled?: boolean;
  planFor?: (userId: string) => Promise<BillingPlanTier | string>;
  isAdmin?: (req: Request) => Promise<boolean>;
  statusFor?: (userId: string) => Promise<{ enabled: boolean; governed: boolean; allowPro: boolean }>;
}

export const resolveImageModelAccess = async (
  req: Request,
  opts: { byok: boolean },
  deps: ImageModelAccessDeps = {}
): Promise<ImageModelAccess> => {
  const userId = req.user?.id;
  const billingOn = deps.billingEnabled ?? BILLING_ENABLED;
  const meteringOn = deps.meteringEnabled ?? meteringEnabled();
  if (billingOn || !meteringOn) {
    return { mode: 'plan', planTier: userId ? await (deps.planFor || resolvePlanTierForUser)(userId) : 'free' };
  }
  if (opts.byok) return { mode: 'usage', pro: true };
  if (!userId) return { mode: 'usage', pro: false };
  try {
    if (await (deps.isAdmin || isUsageExemptAdmin)(req)) return { mode: 'usage', pro: true };
    const status = await (deps.statusFor || getAllowanceStatus)(userId);
    if (!status.enabled) return { mode: 'usage', pro: false };
    return { mode: 'usage', pro: !status.governed || status.allowPro };
  } catch {
    return { mode: 'usage', pro: false };
  }
};

/** The honest refusal for a governed user asking for a model outside the included usage. */
export const IMAGE_MODEL_USAGE_MESSAGE =
  "This image model isn't part of your included usage yet — Nano Banana works great, or add your own Gemini key in Settings → API keys to use it.";

export const assertImageModelAllowed = (access: ImageModelAccess, requestedModel: string) => {
  if (access.mode === 'plan') {
    return assertModelAllowedForTier({ scope: 'image', planTier: access.planTier, requestedModel });
  }
  try {
    return assertModelAllowedForTier({ scope: 'image', planTier: access.pro ? 'creator' : 'free', requestedModel });
  } catch (err) {
    // No plans while billing is off: say what actually limits the user (no plan-tier wording).
    const original = err as Error & { status?: number; publicCode?: string; details?: Record<string, unknown> };
    const error = new Error(IMAGE_MODEL_USAGE_MESSAGE) as Error & { status?: number; publicCode?: string; details?: Record<string, unknown> };
    error.status = original.status ?? 403;
    error.publicCode = original.publicCode ?? 'MODEL_NOT_ALLOWED_FOR_PLAN';
    error.details = {
      scope: 'image',
      reason: 'usage_budget',
      requestedModel: original.details?.requestedModel ?? requestedModel,
      allowedModels: original.details?.allowedModels ?? []
    };
    throw error;
  }
};

/**
 * The id an OpenRouter image model is judged by on the access lists. A registry model that also has
 * a direct Gemini route is judged by that Gemini twin, so both routes agree on the same model (the
 * route's default, Nano Banana legacy `google/gemini-2.5-flash-image`, stays included like
 * `gemini-2.5-flash-image` on /gemini). Everything else is judged by its own id.
 */
const openRouterImageGateId = (modelId: string): string =>
  IMAGE_MODELS.find((spec) => spec.routes.openrouter === modelId)?.routes.gemini ?? modelId;

/**
 * OpenRouter's $0 `:free` variant, spelled exactly as OpenRouter publishes it. Deliberately
 * case-sensitive (unlike the pricing helper `hasFreeSuffix`, which also prices `:FREE` at $0): a
 * spelling OpenRouter does not publish is not a variant it is known to serve for free, so it goes
 * through the gate instead of skipping it (fails closed).
 */
const isOpenRouterFreeVariant = (modelId: string): boolean => modelId.endsWith(':free');

/**
 * The model gate for a platform-funded OpenRouter image call (S12): the same rule as /gemini and
 * Comic Studio. The caller's own OpenRouter key is never gated (the platform pays nothing; BYOK
 * never counts), and an OpenRouter `:free` variant costs nothing to anyone. Everything else is
 * checked against the caller's access BEFORE any hold or provider call, on the model that will
 * actually run (after any capability downgrade), so a governed user gets the honest refusal.
 */
const assertOpenRouterImageModelAllowed = async (req: Request, effectiveModel: string): Promise<void> => {
  if (hasByokForProvider(req, 'openrouter')) return;
  if (isOpenRouterFreeVariant(effectiveModel)) return;
  const access = await resolveImageModelAccess(req, { byok: false });
  assertImageModelAllowed(access, openRouterImageGateId(effectiveModel));
};

/**
 * The Ideogram models the platform route can actually run: ai/ideogram.ts maps exactly these ids to
 * an Ideogram model version (any other id silently runs the default version while the hold and the
 * settle are priced at whatever id the caller sent).
 */
const IDEOGRAM_ROUTE_MODELS: ReadonlySet<string> = new Set([IDEOGRAM_MODEL_ID, 'ideogram/ideogram-v2', 'ideogram/ideogram-v2-turbo']);

/** The honest refusal for a governed user asking for Ideogram on the platform key. */
export const IDEOGRAM_MODEL_USAGE_MESSAGE =
  "Ideogram isn't part of your included usage yet — Nano Banana works great, or add your own Ideogram key in Settings → API keys to use it.";

/** The refusal for a model id the Ideogram route does not run (any caller on the platform key). */
export const IDEOGRAM_UNKNOWN_MODEL_MESSAGE = "That model isn't available on Ideogram here — pick Ideogram V2 or V2 Turbo.";

const ideogramModelRefusal = (access: ImageModelAccess, requestedModel: string, message: string) => {
  const error = new Error(message) as Error & { status?: number; publicCode?: string; details?: Record<string, unknown> };
  error.status = 403;
  error.publicCode = 'MODEL_NOT_ALLOWED_FOR_PLAN';
  error.details = {
    scope: 'image',
    ...(access.mode === 'plan' ? { planTier: String(access.planTier || 'free').toLowerCase() } : { reason: 'usage_budget' }),
    requestedModel,
    allowedModels: message === IDEOGRAM_UNKNOWN_MODEL_MESSAGE ? [...IDEOGRAM_ROUTE_MODELS] : []
  };
  return error;
};

/**
 * The model gate for a platform-funded Ideogram call (owner decision, conservative): the caller's
 * own Ideogram key is never gated (the platform pays nothing; BYOK never counts). On the platform
 * key, governed users get the everyday list only — Ideogram is not on it — so they get the honest
 * refusal; admins, exempt and `allow_pro` rows (or a paid plan while the legacy plan gate applies)
 * may run the Ideogram models this route knows, and nothing else. Checked BEFORE any hold or
 * provider call, so a refusal costs nothing.
 */
const assertIdeogramModelAllowed = async (req: Request, modelId: string): Promise<void> => {
  if (hasByokForProvider(req, 'ideogram')) return;
  const access = await resolveImageModelAccess(req, { byok: false });
  const pro = access.mode === 'plan' ? toEffectiveTier(access.planTier) === 'pro' : access.pro;
  if (!pro) {
    throw ideogramModelRefusal(
      access,
      modelId,
      access.mode === 'usage' ? IDEOGRAM_MODEL_USAGE_MESSAGE : 'Selected model is not available for this plan tier.'
    );
  }
  if (!IDEOGRAM_ROUTE_MODELS.has(modelId)) throw ideogramModelRefusal(access, modelId, IDEOGRAM_UNKNOWN_MODEL_MESSAGE);
};

/**
 * The free plan's daily Nano Banana cap only applies where the usage budget is NOT the meter:
 * never on the user's own key (it never counts), never when the budget governed the call or the
 * admin/exempt rule skipped the wallet ("no daily caps" — P1-LIMITS). Users the budget does not
 * cover (no default budget, metering off) keep the plan's wallet limits, cap included.
 */
export const freeDailyCapApplies = (reservation: Pick<ReservationState, 'byokBypass' | 'governed' | 'walletSkipped'>): boolean =>
  !reservation.byokBypass && !reservation.governed && !reservation.walletSkipped;

/**
 * The `usage` block a legacy image response carries. Governed users never see dollars for their
 * usage (P1-LIMITS), so the provider-reported cost is left out of THEIR response (settle still
 * records it); admins, exempt accounts and own-key calls keep the full block.
 */
export const publicImageUsage = <T extends { providerCostUsd?: number }>(
  usage: T,
  reservation: Pick<ReservationState, 'governed'>
): T | Omit<T, 'providerCostUsd'> => {
  if (!reservation.governed) return usage;
  const { providerCostUsd: _cost, ...rest } = usage;
  return rest;
};

// ── Metering around a provider image call ───────────────────────────────────────────────────────
// The provider call IS the spend. When it fails, the hold is released (nothing was spent). Once it
// succeeded the spend is real and is SETTLED — even when storing the image afterwards fails —
// because releasing then would erase real platform spend from the user's usage and the ledger.

/** Release a hold whose provider call produced nothing. Best effort: the original error wins. */
const releaseQuietly = async (operation: string, release: () => Promise<unknown>): Promise<void> => {
  try {
    await release();
  } catch (releaseError) {
    console.error(`[BILLING] release failed (${operation})`, (releaseError as Error)?.message || releaseError);
  }
};

type SettleResult = Awaited<ReturnType<typeof settleReservedOperation>>;

/**
 * Settle a call whose provider spend already happened. Never throws: a failed settle leaves the
 * RESERVED hold in place (it keeps counting until the reconciliation job repairs it) — it is never
 * released, and the user still gets the image they paid for.
 */
const settleSpentQuietly = async (operation: string, settle: () => Promise<SettleResult>): Promise<SettleResult | null> => {
  try {
    return await settle();
  } catch (settleError) {
    console.error(`[BILLING] settle failed (${operation})`, (settleError as Error)?.message || settleError);
    return null;
  }
};

imageRouter.post('/gemini', checkLimits('gemini'), async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const {
      prompt,
      aspectRatio,
      resolution,
      referenceImages,
      model,
      projectId,
      storage = 'project',
      cropToRatio
    } = req.body || {};
    const modelId = typeof model === 'string' && model.trim() ? model.trim() : undefined;
    if (!prompt || !aspectRatio || !resolution) {
      return res.status(400).json({ error: { message: 'prompt, aspectRatio, resolution are required' } });
    }
    if (storage !== 'test' && !req.user?.id) {
      return res.status(401).json({ error: { message: 'User not authenticated for image persistence' } });
    }

    const payload = await withIdempotency(req, res, 'image:gemini', async () => {
      const effectiveModel = modelId || IMAGE_MODEL;
      const access = await resolveImageModelAccess(req, { byok: hasByokForProvider(req, 'gemini') });
      assertImageModelAllowed(access, effectiveModel);

      const reserve = await reserveForOperation({
        req,
        operation: 'image.gemini.generate',
        fallbackModel: effectiveModel,
        provider: 'gemini',
        resolution,
        imageUnits: 1,
        projectId: typeof projectId === 'string' ? projectId : undefined,
        comicId: typeof projectId === 'string' ? projectId : undefined,
        stage: typeof req.body?.stage === 'string' ? req.body.stage : 'generation',
        metadata: {
          route: '/api/image/gemini',
          storage
        }
      });

      if ('details' in reserve) {
        throw toBillingLimitError(formatLimitErrorResponse(reserve.details));
      }

      const releaseHold = (reason: string) =>
        releaseQuietly('image.gemini.generate', () =>
          releaseReservedOperation({
            req,
            operation: 'image.gemini.generate',
            provider: 'gemini',
            model: effectiveModel,
            projectId: typeof projectId === 'string' ? projectId : undefined,
            reason,
            metadata: { route: '/api/image/gemini', storage }
          })
        );

      // The free plan's daily Nano Banana cap — only where the usage budget isn't the meter.
      if (req.user?.id && freeDailyCapApplies(reserve.reservation)) {
        let freeNanoBananaUsage: Awaited<ReturnType<typeof tryConsumeFreeNanoBananaUsage>>;
        try {
          freeNanoBananaUsage = await tryConsumeFreeNanoBananaUsage({
            userId: req.user.id,
            planTier: access.mode === 'plan' ? access.planTier : await resolvePlanTierForUser(req.user.id),
            modelId: effectiveModel
          });
        } catch (capError) {
          await releaseHold('free_cap_unavailable');
          throw capError;
        }
        if (freeNanoBananaUsage.applied && !freeNanoBananaUsage.allowed) {
          await releaseHold('free_daily_cap_reached');
          throw createFreeNanoBananaLimitError({
            usedCount: freeNanoBananaUsage.usedCount,
            limit: freeNanoBananaUsage.limit,
            resetAt: freeNanoBananaUsage.resetAt
          });
        }
      }

      let generated: Awaited<ReturnType<typeof generateGeminiImage>>;
      try {
        generated = await generateGeminiImage(apiKey, prompt, aspectRatio, resolution, referenceImages || [], effectiveModel);
      } catch (error) {
        // Nothing came back from the provider: free the hold.
        await releaseHold((error as Error)?.message || 'generation_failed');
        throw error;
      }
      const apiMs = generated.timings?.apiMs || 0;
      let responsePayload: Record<string, unknown> = { ...generated };

      // From here the provider has been paid: the spend is settled, never released.
      const settleSpend = () =>
        settleSpentQuietly('image.gemini.generate', () =>
          settleReservedOperation({
            req,
            operation: 'image.gemini.generate',
            provider: 'gemini',
            model: effectiveModel || generated.model || IMAGE_MODEL,
            seed: {
              provider: 'gemini',
              model: effectiveModel || generated.model || IMAGE_MODEL,
              operation: 'image.gemini.generate',
              imageUnits: 1,
              resolution,
              projectId: typeof projectId === 'string' ? projectId : undefined,
              comicId: typeof projectId === 'string' ? projectId : undefined,
              stage: typeof req.body?.stage === 'string' ? req.body.stage : 'generation',
              byok: reserve.reservation.byokBypass
            },
            usage: (generated as { usage?: { promptTokens?: number; candidatesTokens?: number; totalTokens?: number; estimatedTokens?: number } }).usage,
            imageUnits: 1,
            metadata: {
              route: '/api/image/gemini',
              storage
            }
          })
        );

      try {
        if (storage !== 'test') {
          const saved = await persistGeneratedImage({
            userId: req.user!.id,
            projectId,
            dataUrl: generated.dataUrl,
            source: 'gemini',
            resolution,
            cropToRatio
          });

          responsePayload = {
            ...generated,
            imageId: saved.imageId,
            imageUrl: saved.imageUrl,
            mimeType: saved.mimeType,
            timings: buildTimings(apiMs, saved.saveMs),
            dataUrl: IMAGE_INCLUDE_DATA_URL_LEGACY ? generated.dataUrl : undefined
          };

          if (process.env.NODE_ENV !== 'production') {
            console.info('[METRICS] image_pipeline', {
              provider: 'gemini',
              upload_bytes_original: saved.originalBytes,
              upload_bytes_stored: saved.storedBytes,
              compression_ratio: Number(saved.compressionRatio.toFixed(4)),
              image_save_ms: saved.saveMs
            });
          }
        }
      } catch (persistError) {
        // Storing failed AFTER a successful generation: record the real spend, then surface the error.
        await settleSpend();
        throw persistError;
      }

      // Settle in the background so the generated image returns immediately. The reservation is
      // already recorded; the daily reconciliation job repairs any settle that fails here.
      void settleSpend();
      return attachBillingToPayload(responsePayload, reserve.reservation, null);
    });

    res.json(payload);
  } catch (err) {
    if (isMissingServiceRoleKeyError(err)) {
      const publicCode = (err as { publicCode?: string })?.publicCode || 'MISSING_SERVICE_ROLE_KEY';
      return res.status(503).json({
        error: {
          code: publicCode,
          message: publicCode === 'MISSING_SUPABASE_CONFIG'
            ? 'Server storage persistence is unavailable. Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
            : 'Server storage persistence is unavailable. Please set SUPABASE_SERVICE_ROLE_KEY.'
        }
      });
    }
    next(err);
  }
});

imageRouter.post('/flux', checkLimits('pixazo'), async (req, res, next) => {
  try {
    const apiKey = requirePixazoKey(req, res);
    if (!apiKey) return;
    const {
      prompt,
      aspectRatio,
      resolution,
      negativePrompt,
      seed,
      steps,
      projectId,
      storage = 'project',
      cropToRatio
    } = req.body || {};
    if (!prompt || !aspectRatio || !resolution) {
      return res.status(400).json({ error: { message: 'prompt, aspectRatio, resolution are required' } });
    }
    if (storage !== 'test' && !req.user?.id) {
      return res.status(401).json({ error: { message: 'User not authenticated for image persistence' } });
    }

    const payload = await withIdempotency(req, res, 'image:flux', async () => {
      const reserve = await reserveForOperation({
        req,
        operation: 'image.flux.generate',
        fallbackModel: FLUX_MODEL_ID,
        provider: 'pixazo',
        resolution,
        imageUnits: 1,
        projectId: typeof projectId === 'string' ? projectId : undefined,
        comicId: typeof projectId === 'string' ? projectId : undefined,
        stage: typeof req.body?.stage === 'string' ? req.body.stage : 'generation',
        metadata: {
          route: '/api/image/flux',
          storage
        }
      });

      if ('details' in reserve) {
        throw toBillingLimitError(formatLimitErrorResponse(reserve.details));
      }

      let generated: Awaited<ReturnType<typeof generateFluxImage>>;
      try {
        generated = await generateFluxImage(apiKey, { prompt, aspectRatio, resolution, negativePrompt, seed, steps });
      } catch (error) {
        // Nothing came back from the provider: free the hold.
        await releaseQuietly('image.flux.generate', () =>
          releaseReservedOperation({
            req,
            operation: 'image.flux.generate',
            provider: 'pixazo',
            model: FLUX_MODEL_ID,
            projectId: typeof projectId === 'string' ? projectId : undefined,
            reason: (error as Error)?.message || 'generation_failed',
            metadata: { route: '/api/image/flux', storage }
          })
        );
        throw error;
      }
      const apiMs = generated.timings?.apiMs || 0;
      let responsePayload: Record<string, unknown> = { ...generated };

      // From here the provider has been paid: the spend is settled, never released.
      const settleSpend = () =>
        settleSpentQuietly('image.flux.generate', () =>
          settleReservedOperation({
            req,
            operation: 'image.flux.generate',
            provider: 'pixazo',
            model: generated.model || FLUX_MODEL_ID,
            seed: {
              provider: 'pixazo',
              model: generated.model || FLUX_MODEL_ID,
              operation: 'image.flux.generate',
              imageUnits: 1,
              resolution,
              projectId: typeof projectId === 'string' ? projectId : undefined,
              comicId: typeof projectId === 'string' ? projectId : undefined,
              stage: typeof req.body?.stage === 'string' ? req.body.stage : 'generation',
              byok: reserve.reservation.byokBypass
            },
            usage: (generated as { usage?: { promptTokens?: number; candidatesTokens?: number; totalTokens?: number; estimatedTokens?: number } }).usage,
            imageUnits: 1,
            metadata: {
              route: '/api/image/flux',
              storage
            }
          })
        );

      try {
        if (storage !== 'test') {
          const saved = await persistGeneratedImage({
            userId: req.user!.id,
            projectId,
            dataUrl: generated.dataUrl,
            source: 'flux',
            resolution,
            cropToRatio
          });

          responsePayload = {
            ...generated,
            imageId: saved.imageId,
            imageUrl: saved.imageUrl,
            mimeType: saved.mimeType,
            timings: buildTimings(apiMs, saved.saveMs),
            dataUrl: IMAGE_INCLUDE_DATA_URL_LEGACY ? generated.dataUrl : undefined
          };

          if (process.env.NODE_ENV !== 'production') {
            console.info('[METRICS] image_pipeline', {
              provider: 'flux',
              upload_bytes_original: saved.originalBytes,
              upload_bytes_stored: saved.storedBytes,
              compression_ratio: Number(saved.compressionRatio.toFixed(4)),
              image_save_ms: saved.saveMs
            });
          }
        }
      } catch (persistError) {
        // Storing failed AFTER a successful generation: record the real spend, then surface the error.
        await settleSpend();
        throw persistError;
      }

      const settledBilling = await settleSpend();
      return attachBillingToPayload(responsePayload, reserve.reservation, settledBilling);
    });

    res.json(payload);
  } catch (err) {
    if (isMissingServiceRoleKeyError(err)) {
      const publicCode = (err as { publicCode?: string })?.publicCode || 'MISSING_SERVICE_ROLE_KEY';
      return res.status(503).json({
        error: {
          code: publicCode,
          message: publicCode === 'MISSING_SUPABASE_CONFIG'
            ? 'Server storage persistence is unavailable. Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
            : 'Server storage persistence is unavailable. Please set SUPABASE_SERVICE_ROLE_KEY.'
        }
      });
    }
    next(err);
  }
});

// Ideogram image generation (BYOK). Mirrors the Flux route: reserve credits,
// generate, persist, then settle. A BYOK X-Ideogram-Key bypasses platform billing.
imageRouter.post('/ideogram', checkLimits('ideogram'), async (req, res, next) => {
  try {
    const apiKey = requireIdeogramKey(req, res);
    if (!apiKey) return;
    const {
      prompt,
      aspectRatio,
      resolution,
      negativePrompt,
      seed,
      modelId,
      projectId,
      storage = 'project',
      cropToRatio
    } = req.body || {};
    if (!prompt || !aspectRatio || !resolution) {
      return res.status(400).json({ error: { message: 'prompt, aspectRatio, resolution are required' } });
    }
    if (storage !== 'test' && !req.user?.id) {
      return res.status(401).json({ error: { message: 'User not authenticated for image persistence' } });
    }

    const resolvedModel = typeof modelId === 'string' && modelId.trim() ? modelId.trim() : IDEOGRAM_MODEL_ID;

    const payload = await withIdempotency(req, res, 'image:ideogram', async () => {
      // The model gate runs before any hold or provider call (platform key only).
      await assertIdeogramModelAllowed(req, resolvedModel);

      const reserve = await reserveForOperation({
        req,
        operation: 'image.ideogram.generate',
        fallbackModel: resolvedModel,
        provider: 'ideogram',
        resolution,
        imageUnits: 1,
        projectId: typeof projectId === 'string' ? projectId : undefined,
        comicId: typeof projectId === 'string' ? projectId : undefined,
        stage: typeof req.body?.stage === 'string' ? req.body.stage : 'generation',
        metadata: {
          route: '/api/image/ideogram',
          storage
        }
      });

      if ('details' in reserve) {
        throw toBillingLimitError(formatLimitErrorResponse(reserve.details));
      }

      let generated: Awaited<ReturnType<typeof generateIdeogramImage>>;
      try {
        generated = await generateIdeogramImage(apiKey, { prompt, aspectRatio, resolution, negativePrompt, seed, modelId: resolvedModel });
      } catch (error) {
        // Nothing came back from the provider: free the hold.
        await releaseQuietly('image.ideogram.generate', () =>
          releaseReservedOperation({
            req,
            operation: 'image.ideogram.generate',
            provider: 'ideogram',
            model: resolvedModel,
            projectId: typeof projectId === 'string' ? projectId : undefined,
            reason: (error as Error)?.message || 'generation_failed',
            metadata: { route: '/api/image/ideogram', storage }
          })
        );
        throw error;
      }
      const apiMs = generated.timings?.apiMs || 0;
      let responsePayload: Record<string, unknown> = { ...generated };

      // From here the provider has been paid: the spend is settled, never released.
      const settleSpend = () =>
        settleSpentQuietly('image.ideogram.generate', () =>
          settleReservedOperation({
            req,
            operation: 'image.ideogram.generate',
            provider: 'ideogram',
            model: generated.model || resolvedModel,
            seed: {
              provider: 'ideogram',
              model: generated.model || resolvedModel,
              operation: 'image.ideogram.generate',
              imageUnits: 1,
              resolution,
              projectId: typeof projectId === 'string' ? projectId : undefined,
              comicId: typeof projectId === 'string' ? projectId : undefined,
              stage: typeof req.body?.stage === 'string' ? req.body.stage : 'generation',
              byok: reserve.reservation.byokBypass
            },
            usage: (generated as { usage?: { promptTokens?: number; candidatesTokens?: number; totalTokens?: number; estimatedTokens?: number } }).usage,
            imageUnits: 1,
            metadata: {
              route: '/api/image/ideogram',
              storage
            }
          })
        );

      try {
        if (storage !== 'test') {
          const saved = await persistGeneratedImage({
            userId: req.user!.id,
            projectId,
            dataUrl: generated.dataUrl,
            source: 'ideogram',
            resolution,
            cropToRatio
          });

          responsePayload = {
            ...generated,
            imageId: saved.imageId,
            imageUrl: saved.imageUrl,
            mimeType: saved.mimeType,
            timings: buildTimings(apiMs, saved.saveMs),
            dataUrl: IMAGE_INCLUDE_DATA_URL_LEGACY ? generated.dataUrl : undefined
          };

          if (process.env.NODE_ENV !== 'production') {
            console.info('[METRICS] image_pipeline', {
              provider: 'ideogram',
              upload_bytes_original: saved.originalBytes,
              upload_bytes_stored: saved.storedBytes,
              compression_ratio: Number(saved.compressionRatio.toFixed(4)),
              image_save_ms: saved.saveMs
            });
          }
        }
      } catch (persistError) {
        // Storing failed AFTER a successful generation: record the real spend, then surface the error.
        await settleSpend();
        throw persistError;
      }

      const settledBilling = await settleSpend();
      return attachBillingToPayload(responsePayload, reserve.reservation, settledBilling);
    });

    res.json(payload);
  } catch (err) {
    if (isMissingServiceRoleKeyError(err)) {
      const publicCode = (err as { publicCode?: string })?.publicCode || 'MISSING_SERVICE_ROLE_KEY';
      return res.status(503).json({
        error: {
          code: publicCode,
          message: publicCode === 'MISSING_SUPABASE_CONFIG'
            ? 'Server storage persistence is unavailable. Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
            : 'Server storage persistence is unavailable. Please set SUPABASE_SERVICE_ROLE_KEY.'
        }
      });
    }
    next(err);
  }
});

// Unified OpenRouter image generation. Works regardless of the AI_PROVIDER flag
// so the new source can be exercised directly. BYOK (X-OpenRouter-Key) bypasses
// platform billing; otherwise the platform key funds the call, credits are metered and the
// model must be one the caller's access includes (the same gate as /gemini).
imageRouter.post('/openrouter', async (req, res, next) => {
  try {
    const apiKey = requireOpenRouterKey(req, res);
    if (!apiKey) return;
    const {
      prompt,
      aspectRatio,
      resolution,
      negativePrompt,
      referenceImages,
      model,
      projectId,
      storage = 'project',
      cropToRatio
    } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: { message: 'prompt is required' } });
    }
    if (storage !== 'test' && !req.user?.id) {
      return res.status(401).json({ error: { message: 'User not authenticated for image persistence' } });
    }

    const payload = await withIdempotency(req, res, 'image:openrouter', async () => {
      // Honor the caller's model. When none is sent, use the configured default image
      // model (a capable image model) — NOT a free auto-pick, which would silently
      // swap the user onto an arbitrary (often slow) free model.
      //
      // Under free-only mode, force 'free-only': the stage either resolves to a
      // genuinely-free model or throws NoFreeModelAvailableError (which surfaces as
      // HTTP 402 NO_FREE_MODEL_AVAILABLE so the client can show the Block + explain UX).
      //
      // When free-only is OFF (the user explicitly opted into paid), image Auto is
      // free-FIRST — not 'quality' — so we never silently bill for a paid image model
      // when a free one exists; paid is used only as a last resort.
      const requestedImageModel = typeof model === 'string' && model.trim() ? model.trim() : OPENROUTER_IMAGE_MODEL;
      const costPref = req.freeOnly ? 'free-only' : 'free';
      const { model: effectiveModel, downgradedFrom, reason: downgradeReason } =
        await resolveStageModel('image_generation', requestedImageModel, { costPref });
      if (downgradedFrom) {
        console.warn('[IMAGE] model downgraded', { route: '/api/image/openrouter', downgradedFrom, to: effectiveModel, reason: downgradeReason });
      }
      // Platform-funded calls may only run a model the caller's access includes (refused before any spend).
      await assertOpenRouterImageModelAllowed(req, effectiveModel);
      const effectiveResolution = resolution || '1024x1024';

      const reserve = await reserveForOperation({
        req,
        operation: 'image.openrouter.generate',
        fallbackModel: effectiveModel,
        provider: 'openrouter',
        resolution: effectiveResolution,
        imageUnits: 1,
        projectId: typeof projectId === 'string' ? projectId : undefined,
        comicId: typeof projectId === 'string' ? projectId : undefined,
        stage: typeof req.body?.stage === 'string' ? req.body.stage : 'generation',
        metadata: { route: '/api/image/openrouter', storage }
      });

      if ('details' in reserve) {
        throw toBillingLimitError(formatLimitErrorResponse(reserve.details));
      }

      const apiStart = Date.now();
      const promptWithHint = typeof aspectRatio === 'string' && aspectRatio.trim()
        ? `${prompt}\n\n(Aspect ratio: ${aspectRatio.trim()})`
        : prompt;
      let generated: GenerateImageResult;
      try {
        generated = await getProvider('openrouter').generateImage(
          {
            model: effectiveModel,
            prompt: promptWithHint,
            referenceImages: Array.isArray(referenceImages) ? referenceImages : [],
            negativePrompt: typeof negativePrompt === 'string' ? negativePrompt : undefined
          },
          resolveProviderContext(apiKey)
        );
      } catch (error) {
        // Nothing came back from the provider: free the hold.
        await releaseQuietly('image.openrouter.generate', () =>
          releaseReservedOperation({
            req,
            operation: 'image.openrouter.generate',
            provider: 'openrouter',
            model: effectiveModel,
            projectId: typeof projectId === 'string' ? projectId : undefined,
            reason: (error as Error)?.message || 'generation_failed',
            metadata: { route: '/api/image/openrouter', storage }
          })
        );
        throw error;
      }
      const apiMs = Date.now() - apiStart;

      const dataUrl = generated.imageDataUrl;
      const mimeType = /^data:(.*?);base64,/.exec(dataUrl)?.[1] || 'image/png';
      const usage = {
        promptTokens: generated.usage.promptTokens,
        candidatesTokens: generated.usage.completionTokens,
        totalTokens: generated.usage.totalTokens,
        providerCostUsd: generated.usage.costUsd
      };

      let responsePayload: Record<string, unknown> = {
        dataUrl,
        mimeType,
        prompt,
        model: generated.model,
        usage: publicImageUsage(usage, reserve.reservation),
        timings: buildTimings(apiMs),
        ...(downgradedFrom ? { modelDowngrade: { from: downgradedFrom, to: effectiveModel, reason: downgradeReason } } : {})
      };

      // From here the provider has been paid: the spend is settled, never released.
      const settleSpend = () =>
        settleSpentQuietly('image.openrouter.generate', () =>
          settleReservedOperation({
            req,
            operation: 'image.openrouter.generate',
            provider: 'openrouter',
            model: generated.model || effectiveModel,
            seed: {
              provider: 'openrouter',
              model: generated.model || effectiveModel,
              operation: 'image.openrouter.generate',
              imageUnits: 1,
              resolution: effectiveResolution,
              projectId: typeof projectId === 'string' ? projectId : undefined,
              comicId: typeof projectId === 'string' ? projectId : undefined,
              stage: typeof req.body?.stage === 'string' ? req.body.stage : 'generation',
              byok: reserve.reservation.byokBypass
            },
            usage,
            imageUnits: 1,
            metadata: { route: '/api/image/openrouter', storage }
          })
        );

      try {
        if (storage !== 'test') {
          const saved = await persistGeneratedImage({
            userId: req.user!.id,
            projectId,
            dataUrl,
            source: 'openrouter',
            resolution: effectiveResolution,
            cropToRatio
          });

          responsePayload = {
            ...responsePayload,
            imageId: saved.imageId,
            imageUrl: saved.imageUrl,
            mimeType: saved.mimeType,
            timings: buildTimings(apiMs, saved.saveMs),
            dataUrl: IMAGE_INCLUDE_DATA_URL_LEGACY ? dataUrl : undefined
          };

          if (process.env.NODE_ENV !== 'production') {
            console.info('[METRICS] image_pipeline', {
              provider: 'openrouter',
              upload_bytes_original: saved.originalBytes,
              upload_bytes_stored: saved.storedBytes,
              compression_ratio: Number(saved.compressionRatio.toFixed(4)),
              image_save_ms: saved.saveMs
            });
          }
        }
      } catch (persistError) {
        // Storing failed AFTER a successful generation: record the real spend, then surface the error.
        await settleSpend();
        throw persistError;
      }

      // Settle in the background so the generated image returns immediately. The reservation is
      // already recorded; the daily reconciliation job repairs any settle that fails here.
      void settleSpend();
      return attachBillingToPayload(responsePayload, reserve.reservation, null);
    });

    res.json(payload);
  } catch (err) {
    if (isMissingServiceRoleKeyError(err)) {
      const publicCode = (err as { publicCode?: string })?.publicCode || 'MISSING_SERVICE_ROLE_KEY';
      return res.status(503).json({
        error: {
          code: publicCode,
          message: publicCode === 'MISSING_SUPABASE_CONFIG'
            ? 'Server storage persistence is unavailable. Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
            : 'Server storage persistence is unavailable. Please set SUPABASE_SERVICE_ROLE_KEY.'
        }
      });
    }
    next(err);
  }
});

// NVIDIA Build image generation (free tier) via the OpenAI-compatible /images/generations
// endpoint. BYOK (X-Nvidia-Key) bypasses platform billing. NOTE: written against NVIDIA's
// documented OpenAI-compatible image API but not runtime-verified in the sandbox — validate
// end-to-end with a real nvapi- key in a networked environment.
imageRouter.post('/nvidia', async (req, res, next) => {
  try {
    const apiKey = requireNvidiaKey(req, res);
    if (!apiKey) return;
    const {
      prompt,
      aspectRatio,
      resolution,
      negativePrompt,
      referenceImages,
      model,
      projectId,
      storage = 'project',
      cropToRatio
    } = req.body || {};
    if (!prompt || typeof prompt !== 'string') {
      return res.status(400).json({ error: { message: 'prompt is required' } });
    }
    if (storage !== 'test' && !req.user?.id) {
      return res.status(401).json({ error: { message: 'User not authenticated for image persistence' } });
    }

    const payload = await withIdempotency(req, res, 'image:nvidia', async () => {
      const effectiveModel = typeof model === 'string' && model.trim() ? model.trim() : NVIDIA_IMAGE_MODEL;
      const effectiveResolution = resolution || '1024x1024';

      const reserve = await reserveForOperation({
        req,
        operation: 'image.nvidia.generate',
        fallbackModel: effectiveModel,
        provider: 'nvidia',
        resolution: effectiveResolution,
        imageUnits: 1,
        projectId: typeof projectId === 'string' ? projectId : undefined,
        comicId: typeof projectId === 'string' ? projectId : undefined,
        stage: typeof req.body?.stage === 'string' ? req.body.stage : 'generation',
        metadata: { route: '/api/image/nvidia', storage }
      });
      if ('details' in reserve) {
        throw toBillingLimitError(formatLimitErrorResponse(reserve.details));
      }

      const apiStart = Date.now();
      const promptWithHint = typeof aspectRatio === 'string' && aspectRatio.trim()
        ? `${prompt}\n\n(Aspect ratio: ${aspectRatio.trim()})`
        : prompt;
      let generated: GenerateImageResult;
      try {
        generated = await getProvider('nvidia').generateImage(
          {
            model: effectiveModel,
            prompt: promptWithHint,
            referenceImages: Array.isArray(referenceImages) ? referenceImages : [],
            negativePrompt: typeof negativePrompt === 'string' ? negativePrompt : undefined
          },
          resolveProviderContext(apiKey, 'nvidia')
        );
      } catch (error) {
        // Nothing came back from the provider: free the hold.
        await releaseQuietly('image.nvidia.generate', () =>
          releaseReservedOperation({
            req,
            operation: 'image.nvidia.generate',
            provider: 'nvidia',
            model: effectiveModel,
            projectId: typeof projectId === 'string' ? projectId : undefined,
            reason: (error as Error)?.message || 'generation_failed',
            metadata: { route: '/api/image/nvidia', storage }
          })
        );
        throw error;
      }
      const apiMs = Date.now() - apiStart;

      const dataUrl = generated.imageDataUrl;
      const mimeType = /^data:(.*?);base64,/.exec(dataUrl)?.[1] || 'image/png';
      const usage = {
        promptTokens: generated.usage.promptTokens,
        candidatesTokens: generated.usage.completionTokens,
        totalTokens: generated.usage.totalTokens,
        providerCostUsd: generated.usage.costUsd
      };

      let responsePayload: Record<string, unknown> = {
        dataUrl,
        mimeType,
        prompt,
        model: generated.model,
        usage: publicImageUsage(usage, reserve.reservation),
        timings: buildTimings(apiMs)
      };

      // From here the provider has been paid: the spend is settled, never released.
      const settleSpend = () =>
        settleSpentQuietly('image.nvidia.generate', () =>
          settleReservedOperation({
            req,
            operation: 'image.nvidia.generate',
            provider: 'nvidia',
            model: generated.model || effectiveModel,
            seed: {
              provider: 'nvidia',
              model: generated.model || effectiveModel,
              operation: 'image.nvidia.generate',
              imageUnits: 1,
              resolution: effectiveResolution,
              projectId: typeof projectId === 'string' ? projectId : undefined,
              comicId: typeof projectId === 'string' ? projectId : undefined,
              stage: typeof req.body?.stage === 'string' ? req.body.stage : 'generation',
              byok: reserve.reservation.byokBypass
            },
            usage,
            imageUnits: 1,
            metadata: { route: '/api/image/nvidia', storage }
          })
        );

      try {
        if (storage !== 'test') {
          const saved = await persistGeneratedImage({
            userId: req.user!.id,
            projectId,
            dataUrl,
            source: 'nvidia',
            resolution: effectiveResolution,
            cropToRatio
          });
          responsePayload = {
            ...responsePayload,
            imageId: saved.imageId,
            imageUrl: saved.imageUrl,
            mimeType: saved.mimeType,
            timings: buildTimings(apiMs, saved.saveMs),
            dataUrl: IMAGE_INCLUDE_DATA_URL_LEGACY ? dataUrl : undefined
          };
        }
      } catch (persistError) {
        // Storing failed AFTER a successful generation: record the real spend, then surface the error.
        await settleSpend();
        throw persistError;
      }

      // Settle in the background so the generated image returns immediately. The reservation is
      // already recorded; the daily reconciliation job repairs any settle that fails here.
      void settleSpend();
      return attachBillingToPayload(responsePayload, reserve.reservation, null);
    });

    res.json(payload);
  } catch (err) {
    if (isMissingServiceRoleKeyError(err)) {
      const publicCode = (err as { publicCode?: string })?.publicCode || 'MISSING_SERVICE_ROLE_KEY';
      return res.status(503).json({
        error: {
          code: publicCode,
          message: publicCode === 'MISSING_SUPABASE_CONFIG'
            ? 'Server storage persistence is unavailable. Please set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
            : 'Server storage persistence is unavailable. Please set SUPABASE_SERVICE_ROLE_KEY.'
        }
      });
    }
    next(err);
  }
});
