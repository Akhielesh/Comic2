import { Router } from 'express';
import { requireGeminiKey } from '../middleware/keys.js';
import { analyzeLayoutFromImages } from '../ai/vision.js';

export const visionRouter = Router();

visionRouter.post('/analyze-layout', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const requestedModel = req.header('X-Gemini-Model')?.trim() || undefined;
    const { images } = req.body || {};
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: { message: 'images array is required' } });
    }
    const result = await analyzeLayoutFromImages(apiKey, images, requestedModel);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
