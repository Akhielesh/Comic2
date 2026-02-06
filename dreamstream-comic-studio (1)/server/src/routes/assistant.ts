import { Router } from 'express';
import { requireGeminiKey } from '../middleware/keys.js';
import { queryMasterAssistant, queryStoryAssistant } from '../ai/assistant.js';

export const assistantRouter = Router();

assistantRouter.post('/story', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const { script, message, history } = req.body || {};
    if (!script || !message) {
      return res.status(400).json({ error: { message: 'script and message are required' } });
    }
    const result = await queryStoryAssistant(apiKey, script, message, Array.isArray(history) ? history : []);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

assistantRouter.post('/master', async (req, res, next) => {
  try {
    const apiKey = requireGeminiKey(req, res);
    if (!apiKey) return;
    const { message, history, context } = req.body || {};
    if (!message || !context) {
      return res.status(400).json({ error: { message: 'message and context are required' } });
    }
    const result = await queryMasterAssistant(apiKey, message, Array.isArray(history) ? history : [], context);
    res.json(result);
  } catch (err) {
    next(err);
  }
});
