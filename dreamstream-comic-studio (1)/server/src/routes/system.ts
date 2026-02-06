import { Router } from 'express';

export const systemRouter = Router();

systemRouter.get('/status', (_req, res) => {
  const geminiKeyPresent = !!process.env.GEMINI_API_KEY;
  const pixazoKeyPresent = !!(process.env.PIXAZO_API_KEY || process.env.PIXAZO_SUBSCRIPTION_KEY || process.env.FLUX_API_KEY);
  res.json({
    status: 'ok',
    geminiKeyPresent,
    pixazoKeyPresent
  });
});
