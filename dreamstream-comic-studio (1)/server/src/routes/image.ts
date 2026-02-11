import { Router } from 'express';
import { requireGeminiKey, requirePixazoKey } from '../middleware/keys.js';
import { checkLimits, incrementUserUsage } from '../middleware/limits.js'; // [NEW]
import { generateGeminiImage } from '../ai/image.js';
import { generateFluxImage } from '../ai/flux.js';

export const imageRouter = Router();

imageRouter.post('/gemini', checkLimits, async (req, res, next) => { // [NEW] checkLimits
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const { prompt, aspectRatio, resolution, referenceImages, model } = req.body || {};
    if (!prompt || !aspectRatio || !resolution) {
      return res.status(400).json({ error: { message: 'prompt, aspectRatio, resolution are required' } });
    }
    const result = await generateGeminiImage(apiKey, prompt, aspectRatio, resolution, referenceImages || [], model);

    // [NEW] Track usage if successful
    if (req.user?.id) {
      await incrementUserUsage(req.user.id);
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

imageRouter.post('/flux', checkLimits, async (req, res, next) => { // [NEW] checkLimits
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
      await incrementUserUsage(req.user.id);
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});
