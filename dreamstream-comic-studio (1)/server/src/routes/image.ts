import { Router } from 'express';
import { requireGeminiKey, requirePixazoKey } from '../middleware/keys.js';
import { generateGeminiImage } from '../ai/image.js';
import { generateFluxImage } from '../ai/flux.js';

export const imageRouter = Router();

imageRouter.post('/gemini', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const { prompt, aspectRatio, resolution, referenceImages } = req.body || {};
    if (!prompt || !aspectRatio || !resolution) {
      return res.status(400).json({ error: { message: 'prompt, aspectRatio, resolution are required' } });
    }
    const result = await generateGeminiImage(apiKey, prompt, aspectRatio, resolution, referenceImages || []);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

imageRouter.post('/flux', async (req, res, next) => {
  try {
    const apiKey = requirePixazoKey(req, res);
    if (!apiKey) return;
    const { prompt, aspectRatio, resolution, negativePrompt, seed, steps } = req.body || {};
    if (!prompt || !aspectRatio || !resolution) {
      return res.status(400).json({ error: { message: 'prompt, aspectRatio, resolution are required' } });
    }
    const result = await generateFluxImage(apiKey, { prompt, aspectRatio, resolution, negativePrompt, seed, steps });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
