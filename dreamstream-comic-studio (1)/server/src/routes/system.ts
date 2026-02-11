import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';

export const systemRouter = Router();

systemRouter.get('/status', (_req, res) => {
  res.json({
    status: 'ok'
  });
});

systemRouter.get('/diagnostics', requireAuth, requireAdmin, (_req, res) => {
  const geminiKeyPresent = !!process.env.GEMINI_API_KEY;
  const pixazoKeyPresent = !!(process.env.PIXAZO_API_KEY || process.env.PIXAZO_SUBSCRIPTION_KEY || process.env.FLUX_API_KEY);

  res.json({
    status: 'ok',
    geminiKeyPresent,
    pixazoKeyPresent
  });
});
