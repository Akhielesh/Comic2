import { Router } from 'express';
import { requireGeminiKey } from '../middleware/keys.js';
import { analyzeScript, generateStoryOutline, generateStoryDraft, extractWorldDetails, generatePanelBreakdown, updateContinuitySummary, analyzeTestLabReport } from '../ai/text.js';

export const textRouter = Router();

textRouter.post('/analyze-script', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const { script } = req.body || {};
    if (!script || typeof script !== 'string') {
      return res.status(400).json({ error: { message: 'script is required' } });
    }
    const result = await analyzeScript(apiKey, script);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

textRouter.post('/story-outline', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const result = await generateStoryOutline(apiKey, req.body || {});
    res.json(result);
  } catch (err) {
    next(err);
  }
});

textRouter.post('/story-draft', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const result = await generateStoryDraft(apiKey, req.body || {});
    res.json(result);
  } catch (err) {
    next(err);
  }
});

textRouter.post('/extract-world', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const { scenes } = req.body || {};
    if (!Array.isArray(scenes)) {
      return res.status(400).json({ error: { message: 'scenes array is required' } });
    }
    const result = await extractWorldDetails(apiKey, scenes);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

textRouter.post('/panel-breakdown', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const { scene, style, layoutType, panelCount } = req.body || {};
    // Relaxed validation: Default if missing to prevent build crashes
    const effectiveStyle = style || "classic comic book style";
    const effectiveLayout = layoutType || "classic";

    if (!scene) {
      return res.status(400).json({ error: { message: 'scene is required' } });
    }
    const result = await generatePanelBreakdown(apiKey, scene, effectiveStyle, effectiveLayout, panelCount || 3);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

textRouter.post('/continuity-summary', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const { currentSummary, scene, panels } = req.body || {};
    if (!scene || !Array.isArray(panels)) {
      return res.status(400).json({ error: { message: 'scene and panels are required' } });
    }
    const result = await updateContinuitySummary(apiKey, currentSummary, scene, panels);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

textRouter.post('/testlab-report', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const { report } = req.body || {};
    if (!report) {
      return res.status(400).json({ error: { message: 'report is required' } });
    }
    const result = await analyzeTestLabReport(apiKey, report);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
