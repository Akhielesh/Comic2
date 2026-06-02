import { Request, Response, Router } from 'express';
import { requireGeminiKey, requireOpenRouterKey } from '../middleware/keys.js';
import {
  analyzeLayoutFromImages,
  analyzeImagesViaOpenRouter,
  buildStylePrompt,
  parseStyleResponse
} from '../ai/vision.js';
import { TEXT_MODEL, OPENROUTER_TEXT_MODEL } from '../config.js';
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

// PageStudio vision intake (style + layout). These run through the OpenRouter gateway so
// they share the SAME BYOK key as image generation — no separate Gemini key required.
const runOpenRouterVision = async (
  req: Request,
  res: Response,
  opts: {
    operation: string;
    stage: string;
    images: string[];
    instruction: string;
    build: (text: string, model: string, usage: ReturnType<typeof toSettleUsage>) => Record<string, unknown>;
  }
): Promise<void> => {
  const apiKey = requireOpenRouterKey(req, res);
  if (!apiKey) return;

  // Vision needs a multimodal model. Do NOT fall back to the user's selected text model
  // (which may be text-only and would reject the image). Honor an explicit vision override
  // header, else use the configured vision-capable default.
  const requestedModel = req.header('X-Vision-Model')?.trim() || OPENROUTER_TEXT_MODEL;
  const projectId = typeof req.body?.projectId === 'string' ? req.body.projectId : undefined;
  const imageUnits = Math.max(1, opts.images.length);

  const reserve = await reserveForOperation({
    req,
    operation: opts.operation,
    fallbackModel: requestedModel,
    provider: 'openrouter',
    imageUnits,
    projectId,
    comicId: projectId,
    stage: opts.stage,
    metadata: { route: req.path, imageCount: opts.images.length }
  });
  if ('details' in reserve) {
    res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });
    return;
  }

  try {
    const result = await analyzeImagesViaOpenRouter(apiKey, opts.images, opts.instruction, requestedModel);
    const usage = toSettleUsage(result.usage);
    const settled = await settleReservedOperation({
      req,
      operation: opts.operation,
      provider: 'openrouter',
      model: result.model,
      seed: {
        provider: 'openrouter',
        model: result.model,
        operation: opts.operation,
        imageUnits,
        projectId,
        comicId: projectId,
        stage: opts.stage,
        byok: reserve.reservation.byokBypass
      },
      usage,
      imageUnits,
      metadata: { route: req.path, imageCount: opts.images.length }
    });
    res.json(attachBillingToPayload(opts.build(result.text, result.model, usage), reserve.reservation, settled));
  } catch (error) {
    await releaseReservedOperation({
      req,
      operation: opts.operation,
      provider: 'openrouter',
      model: requestedModel,
      projectId,
      reason: (error as Error)?.message || 'vision_request_failed',
      metadata: { route: req.path, imageCount: opts.images.length }
    });
    throw error;
  }
};

const toSettleUsage = (usage: { promptTokens?: number; completionTokens?: number; totalTokens?: number; costUsd?: number }) => ({
  promptTokens: usage.promptTokens,
  candidatesTokens: usage.completionTokens,
  totalTokens: usage.totalTokens,
  providerCostUsd: usage.costUsd
});

// Understand the art style of a reference image (and/or text hint) → reusable brief + tags.
visionRouter.post('/analyze-style', async (req, res, next) => {
  try {
    const { images, textHint } = req.body || {};
    const imageList: string[] = Array.isArray(images) ? images.filter((i) => typeof i === 'string') : [];
    if (imageList.length === 0 && (typeof textHint !== 'string' || !textHint.trim())) {
      return res.status(400).json({ error: { message: 'Provide a reference image or a text style hint.' } });
    }
    await runOpenRouterVision(req, res, {
      operation: 'vision.analyze_style',
      stage: 'style_analysis',
      images: imageList,
      instruction: buildStylePrompt(typeof textHint === 'string' ? textHint : undefined),
      build: (text, model, usage) => {
        const { brief, tags } = parseStyleResponse(text);
        return {
          brief: brief || 'Could not analyze style. Try a clearer reference image or describe the style in text.',
          tags,
          prompt: buildStylePrompt(typeof textHint === 'string' ? textHint : undefined),
          responseText: text,
          usage,
          model
        };
      }
    });
  } catch (err) {
    next(err);
  }
});

// Extract the panel/caption layout of an uploaded comic page (OpenRouter path for PageStudio).
visionRouter.post('/page-layout', async (req, res, next) => {
  try {
    const { images } = req.body || {};
    const imageList: string[] = Array.isArray(images) ? images.filter((i) => typeof i === 'string') : [];
    if (imageList.length === 0) {
      return res.status(400).json({ error: { message: 'images array is required' } });
    }
    const instruction =
      'Analyze this comic book page. Describe its panel layout and caption/lettering treatment precisely as a ' +
      'creative brief for a comic-generation AI — number of panels, their relative sizes and positions, gutter ' +
      'style, and where captions/speech bubbles sit. Two or three sentences, no commentary.';
    await runOpenRouterVision(req, res, {
      operation: 'vision.page_layout',
      stage: 'layout_analysis',
      images: imageList,
      instruction,
      build: (text, model, usage) => ({
        description: text || 'Could not analyze layout.',
        prompt: instruction,
        responseText: text,
        usage,
        model
      })
    });
  } catch (err) {
    next(err);
  }
});
