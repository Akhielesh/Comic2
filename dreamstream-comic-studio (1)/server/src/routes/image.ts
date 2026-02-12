import { Request, Response, Router } from 'express';
import crypto from 'node:crypto';
import { requireGeminiKey, requirePixazoKey } from '../middleware/keys.js';
import { checkLimits, incrementUserUsage } from '../middleware/limits.js';
import { IDEMPOTENCY_TTL_MS, IMAGE_INCLUDE_DATA_URL_LEGACY } from '../config.js';
import { generateGeminiImage } from '../ai/image.js';
import { generateFluxImage } from '../ai/flux.js';
import { persistGeneratedImage } from '../services/imageStorage.js';

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

const recordUsageBestEffort = async (userId: string, route: string) => {
  try {
    await incrementUserUsage(userId);
  } catch (error) {
    console.error(`[USAGE] ${route} generation succeeded but usage accounting failed`, {
      userId,
      error,
    });
  }
};

const buildTimings = (apiMs = 0, saveMs = 0) => ({
  apiMs,
  saveMs,
  totalMs: apiMs + saveMs
});

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
      const generated = await generateGeminiImage(apiKey, prompt, aspectRatio, resolution, referenceImages || [], modelId);
      const apiMs = generated.timings?.apiMs || 0;
      let responsePayload: Record<string, unknown> = { ...generated };

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

      if (req.user?.id) {
        await recordUsageBestEffort(req.user.id, '/image/gemini');
      }

      return responsePayload;
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
      const generated = await generateFluxImage(apiKey, { prompt, aspectRatio, resolution, negativePrompt, seed, steps });
      const apiMs = generated.timings?.apiMs || 0;
      let responsePayload: Record<string, unknown> = { ...generated };

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

      if (req.user?.id) {
        await recordUsageBestEffort(req.user.id, '/image/flux');
      }

      return responsePayload;
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
