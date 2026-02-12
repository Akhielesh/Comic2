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

export const textRouter = Router();

textRouter.post('/analyze-script', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const requestedModel = req.header('X-Gemini-Model')?.trim() || undefined;
    const { script } = req.body || {};
    if (!script || typeof script !== 'string') {
      return res.status(400).json({ error: { message: 'script is required' } });
    }
    const result = await analyzeScript(apiKey, script, requestedModel);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

textRouter.post('/story-outline', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const requestedModel = req.header('X-Gemini-Model')?.trim() || undefined;
    const result = await generateStoryOutline(apiKey, req.body || {}, requestedModel);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

textRouter.post('/story-draft', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const requestedModel = req.header('X-Gemini-Model')?.trim() || undefined;
    const result = await generateStoryDraft(apiKey, req.body || {}, requestedModel);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

textRouter.post('/story-tool', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const requestedModel = req.header('X-Gemini-Model')?.trim() || undefined;
    const { script, instruction, history } = req.body || {};
    if (!script || typeof script !== 'string' || !instruction || typeof instruction !== 'string') {
      return res.status(400).json({ error: { message: 'script and instruction are required' } });
    }
    const result = await runStoryToolPrompt(apiKey, script, instruction, Array.isArray(history) ? history : [], requestedModel);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

textRouter.post('/extract-world', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const requestedModel = req.header('X-Gemini-Model')?.trim() || undefined;
    const { scenes } = req.body || {};
    if (!Array.isArray(scenes)) {
      return res.status(400).json({ error: { message: 'scenes array is required' } });
    }
    const result = await extractWorldDetails(apiKey, scenes, requestedModel);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

textRouter.post('/panel-breakdown', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const requestedModel = req.header('X-Gemini-Model')?.trim() || undefined;
    const { scene, style, layoutType, panelCount, continuityBible, sceneBindings, previousPanelContext } = req.body || {};
    // Relaxed validation: Default if missing to prevent build crashes
    const effectiveStyle = style || "classic comic book style";
    const effectiveLayout = layoutType || "classic";

    if (!scene) {
      return res.status(400).json({ error: { message: 'scene is required' } });
    }
    const result = await generatePanelBreakdown(
      apiKey,
      scene,
      effectiveStyle,
      effectiveLayout,
      panelCount || 3,
      continuityBible,
      sceneBindings,
      previousPanelContext,
      requestedModel
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

textRouter.post('/continuity-audit', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const requestedModel = req.header('X-Gemini-Model')?.trim() || undefined;
    const { panels } = req.body || {};
    if (!Array.isArray(panels) || panels.length === 0) {
      return res.status(400).json({ error: { message: 'panels array is required' } });
    }
    const result = await continuityAudit(apiKey, req.body || {}, requestedModel);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

textRouter.post('/continuity-summary', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const requestedModel = req.header('X-Gemini-Model')?.trim() || undefined;
    const { currentSummary, scene, panels } = req.body || {};
    if (!scene || !Array.isArray(panels)) {
      return res.status(400).json({ error: { message: 'scene and panels are required' } });
    }
    const result = await updateContinuitySummary(apiKey, currentSummary, scene, panels, requestedModel);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

textRouter.post('/testlab-report', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const requestedModel = req.header('X-Gemini-Model')?.trim() || undefined;
    const { report } = req.body || {};
    if (!report) {
      return res.status(400).json({ error: { message: 'report is required' } });
    }
    const result = await analyzeTestLabReport(apiKey, report, requestedModel);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
