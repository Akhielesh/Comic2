import { Request, Response, Router } from 'express';
import crypto from 'node:crypto';
import { requireGeminiKey, requirePixazoKey, requireOpenRouterKey, requireNvidiaKey } from '../middleware/keys.js';
import { checkLimits } from '../middleware/limits.js';
import { FLUX_MODEL_ID, IDEMPOTENCY_TTL_MS, IMAGE_INCLUDE_DATA_URL_LEGACY, IMAGE_MODEL, OPENROUTER_IMAGE_MODEL, NVIDIA_IMAGE_MODEL } from '../config.js';
import { generateGeminiImage } from '../ai/image.js';
import { generateFluxImage } from '../ai/flux.js';
import { getProvider, resolveProviderContext } from '../ai/gateway.js';
import { resolveStageModel } from '../ai/stageModels.js';
import { persistGeneratedImage } from '../services/imageStorage.js';
import {
  attachBillingToPayload,
  formatLimitErrorResponse,
  releaseReservedOperation,
  reserveForOperation,
  settleReservedOperation
} from '../services/usageEnforcer.js';
import {
  assertModelAllowedForTier,
  createFreeNanoBananaLimitError,
  resolvePlanTierForUser,
  tryConsumeFreeNanoBananaUsage
} from '../services/modelAccessPolicy.js';

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

const cleanupExpiredIdempotencyRecords = (now: number) => {
  for (const [key, value] of idempotencyResponseCache.entries()) {
    if (value.expiresAt <= now) {
      idempotencyResponseCache.delete(key);
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
      const planTier = req.user?.id ? await resolvePlanTierForUser(req.user.id) : 'free';
      assertModelAllowedForTier({
        scope: 'image',
        planTier,
        requestedModel: effectiveModel
      });

      const freeNanoBananaUsage = req.user?.id
        ? await tryConsumeFreeNanoBananaUsage({
            userId: req.user.id,
            planTier,
            modelId: effectiveModel
          })
        : {
            applied: false as const,
            allowed: true as const,
            usedCount: 0,
            limit: 0
          };
      if (freeNanoBananaUsage.applied && !freeNanoBananaUsage.allowed) {
        throw createFreeNanoBananaLimitError({
          usedCount: freeNanoBananaUsage.usedCount,
          limit: freeNanoBananaUsage.limit,
          resetAt: freeNanoBananaUsage.resetAt
        });
      }

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

      const generated = await generateGeminiImage(apiKey, prompt, aspectRatio, resolution, referenceImages || [], effectiveModel);
      const apiMs = generated.timings?.apiMs || 0;
      let responsePayload: Record<string, unknown> = { ...generated };

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

          console.info('[METRICS] image_pipeline', {
            provider: 'gemini',
            upload_bytes_original: saved.originalBytes,
            upload_bytes_stored: saved.storedBytes,
            compression_ratio: Number(saved.compressionRatio.toFixed(4)),
            image_save_ms: saved.saveMs
          });
        }

        // Settle billing in the background so the generated image returns immediately.
        // The reservation is already recorded; the daily reconciliation job repairs any
        // settle that fails here.
        void settleReservedOperation({
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
        }).catch((settleError) => {
          console.error('[BILLING] async settle failed (image.gemini.generate)', (settleError as Error)?.message || settleError);
        });

        return attachBillingToPayload(responsePayload, reserve.reservation, null);
      } catch (error) {
        await releaseReservedOperation({
          req,
          operation: 'image.gemini.generate',
          provider: 'gemini',
          model: effectiveModel || generated.model || IMAGE_MODEL,
          projectId: typeof projectId === 'string' ? projectId : undefined,
          reason: (error as Error)?.message || 'generation_failed',
          metadata: {
            route: '/api/image/gemini',
            storage
          }
        });
        throw error;
      }
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

      const generated = await generateFluxImage(apiKey, { prompt, aspectRatio, resolution, negativePrompt, seed, steps });
      const apiMs = generated.timings?.apiMs || 0;
      let responsePayload: Record<string, unknown> = { ...generated };
      let settledBilling: Awaited<ReturnType<typeof settleReservedOperation>> | null = null;

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

          console.info('[METRICS] image_pipeline', {
            provider: 'flux',
            upload_bytes_original: saved.originalBytes,
            upload_bytes_stored: saved.storedBytes,
            compression_ratio: Number(saved.compressionRatio.toFixed(4)),
            image_save_ms: saved.saveMs
          });
        }

        settledBilling = await settleReservedOperation({
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
        });

        return attachBillingToPayload(responsePayload, reserve.reservation, settledBilling);
      } catch (error) {
        await releaseReservedOperation({
          req,
          operation: 'image.flux.generate',
          provider: 'pixazo',
          model: generated.model || FLUX_MODEL_ID,
          projectId: typeof projectId === 'string' ? projectId : undefined,
          reason: (error as Error)?.message || 'generation_failed',
          metadata: {
            route: '/api/image/flux',
            storage
          }
        });
        throw error;
      }
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
// platform billing; otherwise the platform key funds the call and credits are metered.
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
      const requestedImageModel = typeof model === 'string' && model.trim() ? model.trim() : OPENROUTER_IMAGE_MODEL;
      const costPref = req.freeOnly ? 'free-only' : 'quality';
      const { model: effectiveModel, downgradedFrom, reason: downgradeReason } =
        await resolveStageModel('image_generation', requestedImageModel, { costPref });
      if (downgradedFrom) {
        console.warn('[IMAGE] model downgraded', { route: '/api/image/openrouter', downgradedFrom, to: effectiveModel, reason: downgradeReason });
      }
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
      const generated = await getProvider('openrouter').generateImage(
        {
          model: effectiveModel,
          prompt: promptWithHint,
          referenceImages: Array.isArray(referenceImages) ? referenceImages : [],
          negativePrompt: typeof negativePrompt === 'string' ? negativePrompt : undefined
        },
        resolveProviderContext(apiKey)
      );
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
        usage,
        timings: buildTimings(apiMs),
        ...(downgradedFrom ? { modelDowngrade: { from: downgradedFrom, to: effectiveModel, reason: downgradeReason } } : {})
      };

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

          console.info('[METRICS] image_pipeline', {
            provider: 'openrouter',
            upload_bytes_original: saved.originalBytes,
            upload_bytes_stored: saved.storedBytes,
            compression_ratio: Number(saved.compressionRatio.toFixed(4)),
            image_save_ms: saved.saveMs
          });
        }

        // Settle billing in the background so the generated image returns immediately.
        // The reservation is already recorded; the daily reconciliation job repairs any
        // settle that fails here. Per-key cost attribution still works via usage.providerCostUsd.
        void settleReservedOperation({
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
        }).catch((settleError) => {
          console.error('[BILLING] async settle failed (image.openrouter.generate)', (settleError as Error)?.message || settleError);
        });

        return attachBillingToPayload(responsePayload, reserve.reservation, null);
      } catch (error) {
        await releaseReservedOperation({
          req,
          operation: 'image.openrouter.generate',
          provider: 'openrouter',
          model: generated.model || effectiveModel,
          projectId: typeof projectId === 'string' ? projectId : undefined,
          reason: (error as Error)?.message || 'generation_failed',
          metadata: { route: '/api/image/openrouter', storage }
        });
        throw error;
      }
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
      const generated = await getProvider('nvidia').generateImage(
        {
          model: effectiveModel,
          prompt: promptWithHint,
          referenceImages: Array.isArray(referenceImages) ? referenceImages : [],
          negativePrompt: typeof negativePrompt === 'string' ? negativePrompt : undefined
        },
        resolveProviderContext(apiKey, 'nvidia')
      );
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
        usage,
        timings: buildTimings(apiMs)
      };

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

        void settleReservedOperation({
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
        }).catch((settleError) => {
          console.error('[BILLING] async settle failed (image.nvidia.generate)', (settleError as Error)?.message || settleError);
        });

        return attachBillingToPayload(responsePayload, reserve.reservation, null);
      } catch (error) {
        await releaseReservedOperation({
          req,
          operation: 'image.nvidia.generate',
          provider: 'nvidia',
          model: generated.model || effectiveModel,
          projectId: typeof projectId === 'string' ? projectId : undefined,
          reason: (error as Error)?.message || 'generation_failed',
          metadata: { route: '/api/image/nvidia', storage }
        });
        throw error;
      }
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
