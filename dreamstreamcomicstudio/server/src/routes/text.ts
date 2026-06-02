import { Router } from 'express';
import { requireGeminiKey, requireOpenRouterKey } from '../middleware/keys.js';
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
import { TEXT_MODEL, NVIDIA_TEXT_MODEL } from '../config.js';
import { pickTextModel } from '../ai/autoRouter.js';
import { resolveStageModel, type PipelineStage } from '../ai/stageModels.js';
import { getProvider, resolveProviderContext } from '../ai/gateway.js';
import type { ChatMessage } from '../ai/providers/types.js';
import {
  attachBillingToPayload,
  formatLimitErrorResponse,
  releaseReservedOperation,
  reserveForOperation,
  settleReservedOperation
} from '../services/usageEnforcer.js';
import { assertModelAllowedForUser } from '../services/modelAccessPolicy.js';
import { validateExtractWorldBody } from './text.validation.js';

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

type TextProvider = { apiKey: string; model: string; provider: 'openrouter' | 'gemini' | 'nvidia' };

// Text generation routes through OpenRouter or NVIDIA Build (both OpenAI-compatible, via the
// gateway shim in ai/client.ts) when their key is present, otherwise the legacy Gemini path.
// An explicit `X-Text-Source` (set when the user picks a model from a given source) wins;
// otherwise precedence is OpenRouter → NVIDIA → Gemini. Sends 401 when no key is available.
const resolveTextProvider = async (
  req: any,
  res: any,
  stage: PipelineStage = 'generate'
): Promise<TextProvider | null> => {
  const textSource = String(req.header('X-Text-Source') || '').trim().toLowerCase();
  const openRouterKey = req.apiKeys?.openRouterKey;
  const nvidiaKey = req.apiKeys?.nvidiaKey;
  const requested = req.header('X-Text-Model')?.trim();

  // NVIDIA uses its own (publisher/model) ids and a limited capability catalog, so we pass
  // the requested model straight through (no OpenRouter-catalog stage downgrade) and default
  // to NVIDIA_TEXT_MODEL when none/incompatible is supplied.
  const nvidiaPick = (): TextProvider => ({
    apiKey: nvidiaKey as string,
    model: requested && requested.includes('/') ? requested : NVIDIA_TEXT_MODEL,
    provider: 'nvidia'
  });
  const openRouterPick = async (): Promise<TextProvider> => {
    // Validate the requested model against the stage's required capabilities (e.g.
    // structured-JSON for analyze/world/panel/audit) and downgrade if needed.
    const { model } = await resolveStageModel(stage, requested, { costPref: 'free' });
    return { apiKey: openRouterKey as string, model, provider: 'openrouter' };
  };

  // Explicit source selection wins (the user picked a model from this source).
  if (textSource === 'nvidia' && nvidiaKey) return nvidiaPick();
  if (textSource === 'openrouter' && openRouterKey) return openRouterPick();

  // Fallback precedence.
  if (openRouterKey) return openRouterPick();
  if (nvidiaKey) return nvidiaPick();

  const geminiKey = req.apiKeys?.geminiKey;
  if (geminiKey) {
    const model = await assertTextModelAccess(req, resolveRequestedModel(req.header('X-Gemini-Model')));
    return { apiKey: geminiKey, model, provider: 'gemini' };
  }
  res.status(401).json({
    error: {
      message: 'No AI text key found. Add an OpenRouter, NVIDIA Build, or Gemini key in Settings → API Configuration.',
      code: 'TEXT_KEY_MISSING'
    }
  });
  return null;
};

textRouter.post('/analyze-script', async (req, res, next) => {
  try {
    const resolved = await resolveTextProvider(req, res, 'analyze_script');
    if (!resolved) return;
    const { apiKey, model: effectiveModel, provider } = resolved;
    const { script } = req.body || {};
    if (!script || typeof script !== 'string') {
      return res.status(400).json({ error: { message: 'script is required' } });
    }

    const reserve = await reserveForOperation({
      req,
      operation: 'text.analyze_script',
      fallbackModel: effectiveModel,
      provider,
      projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      stage: 'script',
      metadata: { route: req.path, method: req.method }
    });

    if ('details' in reserve) {
      return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });
    }

    try {
      const creativeDirection = typeof req.body?.creativeDirection === 'string' ? req.body.creativeDirection : undefined;
      const result = await analyzeScript(apiKey, script, effectiveModel, creativeDirection);
      const settled = await settleReservedOperation({
        req,
        operation: 'text.analyze_script',
        provider,
        model: effectiveModel,
        seed: {
          provider,
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
        provider,
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
    const resolved = await resolveTextProvider(req, res);
    if (!resolved) return;
    const { apiKey, model: effectiveModel, provider } = resolved;

    const reserve = await reserveForOperation({
      req,
      operation: 'text.story_outline',
      fallbackModel: effectiveModel,
      provider,
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
        provider,
        model: effectiveModel,
        seed: {
          provider,
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
        provider,
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
    const resolved = await resolveTextProvider(req, res);
    if (!resolved) return;
    const { apiKey, model: effectiveModel, provider } = resolved;

    const reserve = await reserveForOperation({
      req,
      operation: 'text.story_draft',
      fallbackModel: effectiveModel,
      provider,
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
        provider,
        model: effectiveModel,
        seed: {
          provider,
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
        provider,
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
    const resolved = await resolveTextProvider(req, res);
    if (!resolved) return;
    const { apiKey, model: effectiveModel, provider } = resolved;
    const { script, instruction, history } = req.body || {};
    if (!script || typeof script !== 'string' || !instruction || typeof instruction !== 'string') {
      return res.status(400).json({ error: { message: 'script and instruction are required' } });
    }

    const reserve = await reserveForOperation({
      req,
      operation: 'text.story_tool',
      fallbackModel: effectiveModel,
      provider,
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
        provider,
        model: effectiveModel,
        seed: {
          provider,
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
        provider,
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
    const resolved = await resolveTextProvider(req, res, 'extract_world');
    if (!resolved) return;
    const { apiKey, model: effectiveModel, provider } = resolved;
    const validated = validateExtractWorldBody(req.body);
    if ('status' in validated) return res.status(validated.status).json({ error: validated.error });
    const { scenes, script } = validated;

    const reserve = await reserveForOperation({
      req,
      operation: 'text.extract_world',
      fallbackModel: effectiveModel,
      provider,
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
        script,
        effectiveModel,
        typeof req.body?.creativeDirection === 'string' ? req.body.creativeDirection : undefined
      );
      const diagnostics = result.diagnostics || {
        input_scene_count: Array.isArray(scenes) ? scenes.length : 0,
        entity_counts: {
          characters: Array.isArray(result.characters) ? result.characters.length : 0,
          items: Array.isArray(result.items) ? result.items.length : 0,
          locations: Array.isArray(result.locations) ? result.locations.length : 0
        },
        filtered_entity_count: 0,
        dropped_entities: [],
        ungrounded_characters_dropped: 0
      };
      const resultWithDiagnostics = {
        ...result,
        diagnostics
      };
      const settled = await settleReservedOperation({
        req,
        operation: 'text.extract_world',
        provider,
        model: effectiveModel,
        seed: {
          provider,
          model: effectiveModel,
          operation: 'text.extract_world',
          projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          comicId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
          stage: 'world',
          byok: reserve.reservation.byokBypass
        },
        usage: resultWithDiagnostics.usage,
        metadata: { route: req.path, method: req.method }
      });
      res.json(attachBillingToPayload(resultWithDiagnostics as unknown as Record<string, unknown>, reserve.reservation, settled));
    } catch (error) {
      await releaseReservedOperation({
        req,
        operation: 'text.extract_world',
        provider,
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
    const resolved = await resolveTextProvider(req, res, 'panel_breakdown');
    if (!resolved) return;
    const { apiKey, model: effectiveModel, provider } = resolved;
    const { scene, style, layoutType, panelCount, continuityBible, sceneBindings, previousPanelContext, continuitySummary } = req.body || {};
    const effectiveStyle = style || 'classic comic book style';
    const effectiveLayout = layoutType || 'classic';

    if (!scene) {
      return res.status(400).json({ error: { message: 'scene is required' } });
    }

    const reserve = await reserveForOperation({
      req,
      operation: 'text.panel_breakdown',
      fallbackModel: effectiveModel,
      provider,
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
        effectiveModel,
        typeof continuitySummary === 'string' ? continuitySummary : undefined,
        typeof req.body?.creativeDirection === 'string' ? req.body.creativeDirection : undefined
      );

      const settled = await settleReservedOperation({
        req,
        operation: 'text.panel_breakdown',
        provider,
        model: effectiveModel,
        seed: {
          provider,
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
        provider,
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
    const resolved = await resolveTextProvider(req, res, 'continuity_audit');
    if (!resolved) return;
    const { apiKey, model: effectiveModel, provider } = resolved;
    const { panels } = req.body || {};
    if (!Array.isArray(panels) || panels.length === 0) {
      return res.status(400).json({ error: { message: 'panels array is required' } });
    }

    const reserve = await reserveForOperation({
      req,
      operation: 'text.continuity_audit',
      fallbackModel: effectiveModel,
      provider,
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
        provider,
        model: effectiveModel,
        seed: {
          provider,
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
        provider,
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
    const resolved = await resolveTextProvider(req, res);
    if (!resolved) return;
    const { apiKey, model: effectiveModel, provider } = resolved;
    const { currentSummary, scene, panels } = req.body || {};
    if (!scene || !Array.isArray(panels)) {
      return res.status(400).json({ error: { message: 'scene and panels are required' } });
    }

    const reserve = await reserveForOperation({
      req,
      operation: 'text.continuity_summary',
      fallbackModel: effectiveModel,
      provider,
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
        provider,
        model: effectiveModel,
        seed: {
          provider,
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
        provider,
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
    const resolved = await resolveTextProvider(req, res);
    if (!resolved) return;
    const { apiKey, model: effectiveModel, provider } = resolved;
    const { report } = req.body || {};
    if (!report) {
      return res.status(400).json({ error: { message: 'report is required' } });
    }

    const reserve = await reserveForOperation({
      req,
      operation: 'text.testlab_report',
      fallbackModel: effectiveModel,
      provider,
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
        provider,
        model: effectiveModel,
        seed: {
          provider,
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
        provider,
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

// Unified OpenRouter text generation. Provider-agnostic passthrough used to
// exercise the new API source directly (and the seam the pipeline routes can
// migrate onto). Accepts either { prompt, system } or a full { messages } array;
// set { jsonMode: true } to force a JSON object response. BYOK via X-OpenRouter-Key.
textRouter.post('/generate', async (req, res, next) => {
  try {
    const apiKey = requireOpenRouterKey(req, res);
    if (!apiKey) return;
    const { prompt, messages, system, model, jsonMode, temperature, maxTokens, projectId } = req.body || {};

    const chatMessages: ChatMessage[] = Array.isArray(messages) && messages.length > 0
      ? messages
      : [
          ...(typeof system === 'string' && system.trim() ? [{ role: 'system' as const, content: system }] : []),
          { role: 'user' as const, content: typeof prompt === 'string' ? prompt : '' }
        ];

    const hasContent = chatMessages.some((m) =>
      typeof m?.content === 'string' ? m.content.trim().length > 0 : Array.isArray(m?.content) && m.content.length > 0
    );
    if (!hasContent) {
      return res.status(400).json({ error: { message: 'prompt or messages is required' } });
    }

    const effectiveModel = typeof model === 'string' && model.trim() ? model.trim() : await pickTextModel({ preferFree: true });

    const reserve = await reserveForOperation({
      req,
      operation: 'text.openrouter.generate',
      fallbackModel: effectiveModel,
      provider: 'openrouter',
      projectId: typeof projectId === 'string' ? projectId : undefined,
      comicId: typeof projectId === 'string' ? projectId : undefined,
      stage: 'generate',
      metadata: { route: req.path, method: req.method }
    });
    if ('details' in reserve) return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });

    try {
      const result = await getProvider('openrouter').generateText(
        {
          model: effectiveModel,
          messages: chatMessages,
          jsonMode: Boolean(jsonMode),
          temperature: typeof temperature === 'number' ? temperature : undefined,
          maxTokens: typeof maxTokens === 'number' ? maxTokens : undefined
        },
        resolveProviderContext(apiKey)
      );

      const usage = {
        promptTokens: result.usage.promptTokens,
        candidatesTokens: result.usage.completionTokens,
        totalTokens: result.usage.totalTokens,
        providerCostUsd: result.usage.costUsd
      };

      const settled = await settleReservedOperation({
        req,
        operation: 'text.openrouter.generate',
        provider: 'openrouter',
        model: result.model || effectiveModel,
        seed: {
          provider: 'openrouter',
          model: result.model || effectiveModel,
          operation: 'text.openrouter.generate',
          projectId: typeof projectId === 'string' ? projectId : undefined,
          comicId: typeof projectId === 'string' ? projectId : undefined,
          stage: 'generate',
          byok: reserve.reservation.byokBypass
        },
        usage,
        metadata: { route: req.path, method: req.method }
      });

      res.json(attachBillingToPayload(
        { text: result.text, json: result.json, model: result.model, usage } as Record<string, unknown>,
        reserve.reservation,
        settled
      ));
    } catch (error) {
      await releaseReservedOperation({
        req,
        operation: 'text.openrouter.generate',
        provider: 'openrouter',
        model: effectiveModel,
        projectId: typeof projectId === 'string' ? projectId : undefined,
        reason: (error as Error)?.message || 'text_request_failed',
        metadata: { route: req.path, method: req.method }
      });
      throw error;
    }
  } catch (err) {
    next(err);
  }
});
