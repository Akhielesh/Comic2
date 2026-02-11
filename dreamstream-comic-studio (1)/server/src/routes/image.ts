import { Router } from 'express';
import { requireGeminiKey, requirePixazoKey } from '../middleware/keys.js';
import { checkLimits, incrementUserUsage } from '../middleware/limits.js'; // [NEW]
import { generateGeminiImage } from '../ai/image.js';
import { generateFluxImage } from '../ai/flux.js';

export const imageRouter = Router();

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

imageRouter.post('/gemini', checkLimits('gemini'), async (req, res, next) => { // [NEW] checkLimits
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const { prompt, aspectRatio, resolution, referenceImages, model } = req.body || {};
    const modelId = typeof model === 'string' && model.trim() ? model.trim() : undefined;
    if (!prompt || !aspectRatio || !resolution) {
      return res.status(400).json({ error: { message: 'prompt, aspectRatio, resolution are required' } });
    }
    const result = await generateGeminiImage(apiKey, prompt, aspectRatio, resolution, referenceImages || [], modelId);

    // [NEW] Track usage if successful
    if (req.user?.id) {
      await recordUsageBestEffort(req.user.id, '/image/gemini');
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

imageRouter.post('/flux', checkLimits('pixazo'), async (req, res, next) => { // [NEW] checkLimits
  try {
    const apiKey = requirePixazoKey(req, res);
    if (!apiKey) return;
    const { prompt, aspectRatio, resolution, negativePrompt, seed, steps } = req.body || {};
    if (!prompt || !aspectRatio || !resolution) {
      return res.status(400).json({ error: { message: 'prompt, aspectRatio, resolution are required' } });
    }
    const result = await generateFluxImage(apiKey, { prompt, aspectRatio, resolution, negativePrompt, seed, steps });

    // [NEW] Track usage if successful
    if (req.user?.id) {
      await recordUsageBestEffort(req.user.id, '/image/flux');
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});
