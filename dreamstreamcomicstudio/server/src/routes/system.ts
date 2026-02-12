import { Router } from 'express';
import { getMissingRequiredEnvVars, STRICT_ENV_VALIDATION } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { checkSupabaseReachability, getSupabaseCapabilityStatus } from '../services/supabase.js';

export const systemRouter = Router();

systemRouter.get('/status', (_req, res) => {
  const capabilities = getSupabaseCapabilityStatus();
  res.json({
    status: 'ok',
    ...capabilities
  });
});

systemRouter.get('/ready', async (_req, res) => {
  const missingEnvVars = getMissingRequiredEnvVars();
  const supabase = await checkSupabaseReachability();
  const ready = missingEnvVars.length === 0 && supabase.reachable;

  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    strictEnvValidation: STRICT_ENV_VALIDATION,
    checks: {
      env: {
        ok: missingEnvVars.length === 0,
        missing: missingEnvVars
      },
      supabase: {
        ok: supabase.reachable,
        latencyMs: supabase.latencyMs,
        ...(supabase.error ? { error: supabase.error } : {}),
        ...(supabase.warning ? { warning: supabase.warning } : {})
      }
    }
  });
});

systemRouter.get('/diagnostics', requireAuth, requireAdmin, (_req, res) => {
  const geminiKeyPresent = !!process.env.GEMINI_API_KEY;
  const pixazoKeyPresent = !!(process.env.PIXAZO_API_KEY || process.env.PIXAZO_SUBSCRIPTION_KEY || process.env.FLUX_API_KEY);
  const capabilities = getSupabaseCapabilityStatus();

  res.json({
    status: 'ok',
    geminiKeyPresent,
    pixazoKeyPresent,
    ...capabilities
  });
});
