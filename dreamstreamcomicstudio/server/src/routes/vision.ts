import { Router } from 'express';
import { requireGeminiKey } from '../middleware/keys.js';
import { analyzeLayoutFromImages, analyzeStyleFromImages } from '../ai/vision.js';
import { TEXT_MODEL } from '../config.js';
import {
  attachBillingToPayload,
  formatLimitErrorResponse,
  releaseReservedOperation,
  reserveForOperation,
  settleReservedOperation
} from '../services/usageEnforcer.js';
import { assertModelAllowedForUser } from '../services/modelAccessPolicy.js';

export const visionRouter = Router();

visionRouter.post('/analyze-layout', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;

    const requestedModel = req.header('X-Gemini-Model')?.trim() || TEXT_MODEL;
    let effectiveModel = requestedModel;
    if (req.user?.id) {
      const access = await assertModelAllowedForUser({
        userId: req.user.id,
        scope: 'vision',
        requestedModel
      });
      effectiveModel = access.effectiveModel;
    }
    const { images } = req.body || {};
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: { message: 'images array is required' } });
    }

    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : undefined;
    const reserve = await reserveForOperation({
      req,
      operation: 'vision.analyze_layout',
      fallbackModel: effectiveModel,
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
      const result = await analyzeLayoutFromImages(apiKey, images, effectiveModel);
      const settled = await settleReservedOperation({
        req,
        operation: 'vision.analyze_layout',
        provider: 'gemini',
        model: effectiveModel,
        seed: {
          provider: 'gemini',
          model: effectiveModel,
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
          model: effectiveModel,
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

// PageStudio: understand the art style of a reference image (and/or a text hint) and
// return a reusable style brief + tags for the single-sheet generator.
visionRouter.post('/analyze-style', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;

    const requestedModel = req.header('X-Gemini-Model')?.trim() || TEXT_MODEL;
    let effectiveModel = requestedModel;
    if (req.user?.id) {
      const access = await assertModelAllowedForUser({
        userId: req.user.id,
        scope: 'vision',
        requestedModel
      });
      effectiveModel = access.effectiveModel;
    }

    const { images, textHint } = req.body || {};
    const imageList: string[] = Array.isArray(images) ? images.filter((i) => typeof i === 'string') : [];
    if (imageList.length === 0 && (typeof textHint !== 'string' || !textHint.trim())) {
      return res.status(400).json({ error: { message: 'Provide a reference image or a text style hint.' } });
    }

    const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : undefined;
    const reserve = await reserveForOperation({
      req,
      operation: 'vision.analyze_style',
      fallbackModel: effectiveModel,
      provider: 'gemini',
      imageUnits: Math.max(1, imageList.length),
      projectId,
      comicId: projectId,
      stage: 'style_analysis',
      metadata: { route: req.path, imageCount: imageList.length }
    });

    if ('details' in reserve) {
      return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });
    }

    try {
      const result = await analyzeStyleFromImages(apiKey, imageList, typeof textHint === 'string' ? textHint : undefined, effectiveModel);
      const settled = await settleReservedOperation({
        req,
        operation: 'vision.analyze_style',
        provider: 'gemini',
        model: effectiveModel,
        seed: {
          provider: 'gemini',
          model: effectiveModel,
          operation: 'vision.analyze_style',
          imageUnits: Math.max(1, imageList.length),
          projectId,
          comicId: projectId,
          stage: 'style_analysis',
          byok: reserve.reservation.byokBypass
        },
        usage: result.usage,
        imageUnits: Math.max(1, imageList.length),
        metadata: { route: req.path, imageCount: imageList.length }
      });

      res.json(attachBillingToPayload(result as unknown as Record<string, unknown>, reserve.reservation, settled));
    } catch (error) {
      await releaseReservedOperation({
        req,
        operation: 'vision.analyze_style',
        provider: 'gemini',
        model: effectiveModel,
        projectId,
        reason: (error as Error)?.message || 'vision_request_failed',
        metadata: { route: req.path, imageCount: imageList.length }
      });
      throw error;
    }
  } catch (err) {
    next(err);
  }
});
