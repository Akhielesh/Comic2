import { Router } from 'express';
import { requireGeminiKey, requirePixazoKey } from '../middleware/keys.js';
import { checkLimits, incrementUserUsage } from '../middleware/limits.js';
import { IMAGE_INCLUDE_DATA_URL_LEGACY } from '../config.js';
import { generateGeminiImage } from '../ai/image.js';
import { generateFluxImage } from '../ai/flux.js';
import { persistGeneratedImage } from '../services/imageStorage.js';

export const imageRouter = Router();

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

    const generated = await generateGeminiImage(apiKey, prompt, aspectRatio, resolution, referenceImages || [], modelId);
    const apiMs = generated.timings?.apiMs || 0;
    let payload: Record<string, unknown> = { ...generated };

    if (storage !== 'test') {
      if (!req.user?.id) {
        return res.status(401).json({ error: { message: 'User not authenticated for image persistence' } });
      }
      const saved = await persistGeneratedImage({
        userId: req.user.id,
        projectId,
        dataUrl: generated.dataUrl,
        source: 'gemini',
        resolution,
        cropToRatio
      });

      payload = {
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

    const generated = await generateFluxImage(apiKey, { prompt, aspectRatio, resolution, negativePrompt, seed, steps });
    const apiMs = generated.timings?.apiMs || 0;
    let payload: Record<string, unknown> = { ...generated };

    if (storage !== 'test') {
      if (!req.user?.id) {
        return res.status(401).json({ error: { message: 'User not authenticated for image persistence' } });
      }
      const saved = await persistGeneratedImage({
        userId: req.user.id,
        projectId,
        dataUrl: generated.dataUrl,
        source: 'flux',
        resolution,
        cropToRatio
      });

      payload = {
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
