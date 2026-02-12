import { Router } from 'express';
import { requireGeminiKey } from '../middleware/keys.js';
import { analyzeLayoutFromImages } from '../ai/vision.js';
import { TEXT_MODEL } from '../config.js';
import {
  attachBillingToPayload,
  formatLimitErrorResponse,
  releaseReservedOperation,
  reserveForOperation,
  settleReservedOperation
} from '../services/usageEnforcer.js';

export const visionRouter = Router();

visionRouter.post('/analyze-layout', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;

    const requestedModel = req.header('X-Gemini-Model')?.trim() || TEXT_MODEL;
    const { images } = req.body || {};
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: { message: 'images array is required' } });
    }

    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : undefined;
    const reserve = await reserveForOperation({
      req,
      operation: 'vision.analyze_layout',
      fallbackModel: requestedModel,
      provider: 'gemini',
      imageUnits: images.length,
      projectId,
      comicId: projectId,
      stage: 'layout_analysis',
      metadata: {
        route: req.path,
        imageCount: images.length
      }
    });

    if ('details' in reserve) {
      return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });
    }

    try {
      const result = await analyzeLayoutFromImages(apiKey, images, requestedModel);
      const settled = await settleReservedOperation({
        req,
        operation: 'vision.analyze_layout',
        provider: 'gemini',
        model: requestedModel,
        seed: {
          provider: 'gemini',
          model: requestedModel,
          operation: 'vision.analyze_layout',
          imageUnits: images.length,
          projectId,
          comicId: projectId,
          stage: 'layout_analysis',
          byok: reserve.reservation.byokBypass
        },
        usage: result.usage,
        imageUnits: images.length,
        metadata: {
          route: req.path,
          imageCount: images.length
        }
      });

      res.json(attachBillingToPayload(result as unknown as Record<string, unknown>, reserve.reservation, settled));
    } catch (error) {
      await releaseReservedOperation({
        req,
        operation: 'vision.analyze_layout',
        provider: 'gemini',
        model: requestedModel,
        projectId,
        reason: (error as Error)?.message || 'vision_request_failed',
        metadata: {
          route: req.path,
          imageCount: images.length
        }
      });
      throw error;
    }
  } catch (err) {
    next(err);
  }
});
