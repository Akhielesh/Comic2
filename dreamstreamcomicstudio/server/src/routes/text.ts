import { Router } from 'express';
import { requireGeminiKey } from '../middleware/keys.js';
import {
  analyzeScript,
  generateStoryOutline,
  generateStoryDraft,
  runStoryToolPrompt,
  extractWorldDetails,
  generatePanelBreakdown,
  updateContinuitySummary,
  continuityAudit,
  analyzeTestLabReport
} from '../ai/text.js';
import { TEXT_MODEL } from '../config.js';
import {
  attachBillingToPayload,
  formatLimitErrorResponse,
  releaseReservedOperation,
  reserveForOperation,
  settleReservedOperation
} from '../services/usageEnforcer.js';
import { assertModelAllowedForUser } from '../services/modelAccessPolicy.js';

export const textRouter = Router();

const resolveRequestedModel = (headerValue?: string) => {
  const trimmed = headerValue?.trim();
  return trimmed || TEXT_MODEL;
};

const assertTextModelAccess = async (
  req: { user?: { id: string } },
  requestedModel: string
) => {
  if (!req.user?.id) return requestedModel;
  const access = await assertModelAllowedForUser({
    userId: req.user.id,
    scope: 'text',
    requestedModel
  });
  return access.effectiveModel;
};

textRouter.post('/analyze-script', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const effectiveModel = await assertTextModelAccess(req, resolveRequestedModel(req.header('X-Gemini-Model')));
    const { script } = req.body || {};
    if (!script || typeof script !== 'string') {
      return res.status(400).json({ error: { message: 'script is required' } });
    }

    const reserve = await reserveForOperation({
      req,
      operation: 'text.analyze_script',
      fallbackModel: effectiveModel,
      provider: 'gemini',
      projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      stage: 'script',
      metadata: { route: req.path, method: req.method }
    });

    if ('details' in reserve) {
      return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });
    }

    try {
      const result = await analyzeScript(apiKey, script, effectiveModel);
      const settled = await settleReservedOperation({
        req,
        operation: 'text.analyze_script',
        provider: 'gemini',
        model: effectiveModel,
        seed: {
          provider: 'gemini',
          model: effectiveModel,
          operation: 'text.analyze_script',
          projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          stage: 'script',
          byok: reserve.reservation.byokBypass
        },
        usage: result.usage,
        metadata: { route: req.path, method: req.method }
      });

      res.json(attachBillingToPayload(result as unknown as Record<string, unknown>, reserve.reservation, settled));
    } catch (error) {
      await releaseReservedOperation({
        req,
        operation: 'text.analyze_script',
        provider: 'gemini',
        model: effectiveModel,
        projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
        reason: (error as Error)?.message || 'text_request_failed',
        metadata: { route: req.path, method: req.method }
      });
      throw error;
    }
  } catch (err) {
    next(err);
  }
});

textRouter.post('/story-outline', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const effectiveModel = await assertTextModelAccess(req, resolveRequestedModel(req.header('X-Gemini-Model')));

    const reserve = await reserveForOperation({
      req,
      operation: 'text.story_outline',
      fallbackModel: effectiveModel,
      provider: 'gemini',
      projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      stage: 'story_outline',
      metadata: { route: req.path, method: req.method }
    });
    if ('details' in reserve) return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });

    try {
      const result = await generateStoryOutline(apiKey, req.body || {}, effectiveModel);
      const settled = await settleReservedOperation({
        req,
        operation: 'text.story_outline',
        provider: 'gemini',
        model: effectiveModel,
        seed: {
          provider: 'gemini',
          model: effectiveModel,
          operation: 'text.story_outline',
          projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          stage: 'story_outline',
          byok: reserve.reservation.byokBypass
        },
        usage: result.usage,
        metadata: { route: req.path, method: req.method }
      });
      res.json(attachBillingToPayload(result as unknown as Record<string, unknown>, reserve.reservation, settled));
    } catch (error) {
      await releaseReservedOperation({
        req,
        operation: 'text.story_outline',
        provider: 'gemini',
        model: effectiveModel,
        projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
        reason: (error as Error)?.message || 'text_request_failed',
        metadata: { route: req.path, method: req.method }
      });
      throw error;
    }
  } catch (err) {
    next(err);
  }
});

textRouter.post('/story-draft', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const effectiveModel = await assertTextModelAccess(req, resolveRequestedModel(req.header('X-Gemini-Model')));

    const reserve = await reserveForOperation({
      req,
      operation: 'text.story_draft',
      fallbackModel: effectiveModel,
      provider: 'gemini',
      projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      stage: 'story_draft',
      metadata: { route: req.path, method: req.method }
    });
    if ('details' in reserve) return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });

    try {
      const result = await generateStoryDraft(apiKey, req.body || {}, effectiveModel);
      const settled = await settleReservedOperation({
        req,
        operation: 'text.story_draft',
        provider: 'gemini',
        model: effectiveModel,
        seed: {
          provider: 'gemini',
          model: effectiveModel,
          operation: 'text.story_draft',
          projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          stage: 'story_draft',
          byok: reserve.reservation.byokBypass
        },
        usage: result.usage,
        metadata: { route: req.path, method: req.method }
      });
      res.json(attachBillingToPayload(result as unknown as Record<string, unknown>, reserve.reservation, settled));
    } catch (error) {
      await releaseReservedOperation({
        req,
        operation: 'text.story_draft',
        provider: 'gemini',
        model: effectiveModel,
        projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
        reason: (error as Error)?.message || 'text_request_failed',
        metadata: { route: req.path, method: req.method }
      });
      throw error;
    }
  } catch (err) {
    next(err);
  }
});

textRouter.post('/story-tool', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const effectiveModel = await assertTextModelAccess(req, resolveRequestedModel(req.header('X-Gemini-Model')));
    const { script, instruction, history } = req.body || {};
    if (!script || typeof script !== 'string' || !instruction || typeof instruction !== 'string') {
      return res.status(400).json({ error: { message: 'script and instruction are required' } });
    }

    const reserve = await reserveForOperation({
      req,
      operation: 'text.story_tool',
      fallbackModel: effectiveModel,
      provider: 'gemini',
      projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      stage: 'story_tool',
      metadata: { route: req.path, method: req.method }
    });
    if ('details' in reserve) return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });

    try {
      const result = await runStoryToolPrompt(apiKey, script, instruction, Array.isArray(history) ? history : [], effectiveModel);
      const settled = await settleReservedOperation({
        req,
        operation: 'text.story_tool',
        provider: 'gemini',
        model: effectiveModel,
        seed: {
          provider: 'gemini',
          model: effectiveModel,
          operation: 'text.story_tool',
          projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          stage: 'story_tool',
          byok: reserve.reservation.byokBypass
        },
        usage: result.usage,
        metadata: { route: req.path, method: req.method }
      });
      res.json(attachBillingToPayload(result as unknown as Record<string, unknown>, reserve.reservation, settled));
    } catch (error) {
      await releaseReservedOperation({
        req,
        operation: 'text.story_tool',
        provider: 'gemini',
        model: effectiveModel,
        projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
        reason: (error as Error)?.message || 'text_request_failed',
        metadata: { route: req.path, method: req.method }
      });
      throw error;
    }
  } catch (err) {
    next(err);
  }
});

textRouter.post('/extract-world', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const effectiveModel = await assertTextModelAccess(req, resolveRequestedModel(req.header('X-Gemini-Model')));
    const { scenes, script } = req.body || {};
    if (!Array.isArray(scenes)) {
      return res.status(400).json({ error: { message: 'scenes array is required' } });
    }

    const reserve = await reserveForOperation({
      req,
      operation: 'text.extract_world',
      fallbackModel: effectiveModel,
      provider: 'gemini',
      projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      stage: 'world',
      metadata: { route: req.path, method: req.method }
    });
    if ('details' in reserve) return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });

    try {
      const result = await extractWorldDetails(
        apiKey,
        scenes,
        typeof script === 'string' ? script : undefined,
        effectiveModel
      );
      const settled = await settleReservedOperation({
        req,
        operation: 'text.extract_world',
        provider: 'gemini',
        model: effectiveModel,
        seed: {
          provider: 'gemini',
          model: effectiveModel,
          operation: 'text.extract_world',
          projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          stage: 'world',
          byok: reserve.reservation.byokBypass
        },
        usage: result.usage,
        metadata: { route: req.path, method: req.method }
      });
      res.json(attachBillingToPayload(result as unknown as Record<string, unknown>, reserve.reservation, settled));
    } catch (error) {
      await releaseReservedOperation({
        req,
        operation: 'text.extract_world',
        provider: 'gemini',
        model: effectiveModel,
        projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
        reason: (error as Error)?.message || 'text_request_failed',
        metadata: { route: req.path, method: req.method }
      });
      throw error;
    }
  } catch (err) {
    next(err);
  }
});

textRouter.post('/panel-breakdown', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const effectiveModel = await assertTextModelAccess(req, resolveRequestedModel(req.header('X-Gemini-Model')));
    const { scene, style, layoutType, panelCount, continuityBible, sceneBindings, previousPanelContext } = req.body || {};
    const effectiveStyle = style || 'classic comic book style';
    const effectiveLayout = layoutType || 'classic';

    if (!scene) {
      return res.status(400).json({ error: { message: 'scene is required' } });
    }

    const reserve = await reserveForOperation({
      req,
      operation: 'text.panel_breakdown',
      fallbackModel: effectiveModel,
      provider: 'gemini',
      projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      stage: typeof req.body?.stage === 'string' ? req.body.stage : 'preview',
      metadata: { route: req.path, method: req.method }
    });
    if ('details' in reserve) return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });

    try {
      const result = await generatePanelBreakdown(
        apiKey,
        scene,
        effectiveStyle,
        effectiveLayout,
        panelCount || 3,
        continuityBible,
        sceneBindings,
        previousPanelContext,
        effectiveModel
      );

      const settled = await settleReservedOperation({
        req,
        operation: 'text.panel_breakdown',
        provider: 'gemini',
        model: effectiveModel,
        seed: {
          provider: 'gemini',
          model: effectiveModel,
          operation: 'text.panel_breakdown',
          projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          stage: typeof req.body?.stage === 'string' ? req.body.stage : 'preview',
          byok: reserve.reservation.byokBypass
        },
        usage: result.usage,
        metadata: { route: req.path, method: req.method }
      });
      res.json(attachBillingToPayload(result as unknown as Record<string, unknown>, reserve.reservation, settled));
    } catch (error) {
      await releaseReservedOperation({
        req,
        operation: 'text.panel_breakdown',
        provider: 'gemini',
        model: effectiveModel,
        projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
        reason: (error as Error)?.message || 'text_request_failed',
        metadata: { route: req.path, method: req.method }
      });
      throw error;
    }
  } catch (err) {
    next(err);
  }
});

textRouter.post('/continuity-audit', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const effectiveModel = await assertTextModelAccess(req, resolveRequestedModel(req.header('X-Gemini-Model')));
    const { panels } = req.body || {};
    if (!Array.isArray(panels) || panels.length === 0) {
      return res.status(400).json({ error: { message: 'panels array is required' } });
    }

    const reserve = await reserveForOperation({
      req,
      operation: 'text.continuity_audit',
      fallbackModel: effectiveModel,
      provider: 'gemini',
      projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      stage: 'continuity_audit',
      metadata: { route: req.path, method: req.method }
    });
    if ('details' in reserve) return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });

    try {
      const result = await continuityAudit(apiKey, req.body || {}, effectiveModel);
      const settled = await settleReservedOperation({
        req,
        operation: 'text.continuity_audit',
        provider: 'gemini',
        model: effectiveModel,
        seed: {
          provider: 'gemini',
          model: effectiveModel,
          operation: 'text.continuity_audit',
          projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          stage: 'continuity_audit',
          byok: reserve.reservation.byokBypass
        },
        usage: result.usage,
        metadata: { route: req.path, method: req.method }
      });
      res.json(attachBillingToPayload(result as unknown as Record<string, unknown>, reserve.reservation, settled));
    } catch (error) {
      await releaseReservedOperation({
        req,
        operation: 'text.continuity_audit',
        provider: 'gemini',
        model: effectiveModel,
        projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
        reason: (error as Error)?.message || 'text_request_failed',
        metadata: { route: req.path, method: req.method }
      });
      throw error;
    }
  } catch (err) {
    next(err);
  }
});

textRouter.post('/continuity-summary', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const effectiveModel = await assertTextModelAccess(req, resolveRequestedModel(req.header('X-Gemini-Model')));
    const { currentSummary, scene, panels } = req.body || {};
    if (!scene || !Array.isArray(panels)) {
      return res.status(400).json({ error: { message: 'scene and panels are required' } });
    }

    const reserve = await reserveForOperation({
      req,
      operation: 'text.continuity_summary',
      fallbackModel: effectiveModel,
      provider: 'gemini',
      projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      stage: 'continuity_summary',
      metadata: { route: req.path, method: req.method }
    });
    if ('details' in reserve) return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });

    try {
      const result = await updateContinuitySummary(apiKey, currentSummary, scene, panels, effectiveModel);
      const settled = await settleReservedOperation({
        req,
        operation: 'text.continuity_summary',
        provider: 'gemini',
        model: effectiveModel,
        seed: {
          provider: 'gemini',
          model: effectiveModel,
          operation: 'text.continuity_summary',
          projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          stage: 'continuity_summary',
          byok: reserve.reservation.byokBypass
        },
        usage: result.usage,
        metadata: { route: req.path, method: req.method }
      });
      res.json(attachBillingToPayload(result as unknown as Record<string, unknown>, reserve.reservation, settled));
    } catch (error) {
      await releaseReservedOperation({
        req,
        operation: 'text.continuity_summary',
        provider: 'gemini',
        model: effectiveModel,
        projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
        reason: (error as Error)?.message || 'text_request_failed',
        metadata: { route: req.path, method: req.method }
      });
      throw error;
    }
  } catch (err) {
    next(err);
  }
});

textRouter.post('/testlab-report', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const effectiveModel = await assertTextModelAccess(req, resolveRequestedModel(req.header('X-Gemini-Model')));
    const { report } = req.body || {};
    if (!report) {
      return res.status(400).json({ error: { message: 'report is required' } });
    }

    const reserve = await reserveForOperation({
      req,
      operation: 'text.testlab_report',
      fallbackModel: effectiveModel,
      provider: 'gemini',
      projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      stage: 'testlab',
      metadata: { route: req.path, method: req.method }
    });
    if ('details' in reserve) return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });

    try {
      const result = await analyzeTestLabReport(apiKey, report, effectiveModel);
      const settled = await settleReservedOperation({
        req,
        operation: 'text.testlab_report',
        provider: 'gemini',
        model: effectiveModel,
        seed: {
          provider: 'gemini',
          model: effectiveModel,
          operation: 'text.testlab_report',
          projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          stage: 'testlab',
          byok: reserve.reservation.byokBypass
        },
        usage: result.usage,
        metadata: { route: req.path, method: req.method }
      });
      res.json(attachBillingToPayload(result as unknown as Record<string, unknown>, reserve.reservation, settled));
    } catch (error) {
      await releaseReservedOperation({
        req,
        operation: 'text.testlab_report',
        provider: 'gemini',
        model: effectiveModel,
        projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
        reason: (error as Error)?.message || 'text_request_failed',
        metadata: { route: req.path, method: req.method }
      });
      throw error;
    }
  } catch (err) {
    next(err);
  }
});
