import { Request, Response, NextFunction } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    apiKeys?: {
      geminiKey?: string | null;
      pixazoKey?: string | null;
      /** Resolved OpenRouter key (BYOK header or platform env). */
      openRouterKey?: string | null;
      /** True when the OpenRouter key came from the end-user (BYOK), not the platform. */
      openRouterByok?: boolean;
    };
  }
}

export const attachKeys = (req: Request, _res: Response, next: NextFunction) => {
  const geminiKey = req.header('X-Gemini-Key') || process.env.GEMINI_API_KEY || null;
  const pixazoKey = req.header('X-Pixazo-Key')
    || req.header('X-Flux-Key')
    || process.env.PIXAZO_API_KEY
    || process.env.PIXAZO_SUBSCRIPTION_KEY
    || process.env.FLUX_API_KEY
    || null;
  const openRouterHeaderKey = req.header('X-OpenRouter-Key') || null;
  const openRouterKey = openRouterHeaderKey || process.env.OPENROUTER_API_KEY || null;
  req.apiKeys = {
    geminiKey,
    pixazoKey,
    openRouterKey,
    openRouterByok: Boolean(openRouterHeaderKey)
  };
  next();
};

export const requireOpenRouterKey = (req: Request, res: Response): string | null => {
  const openRouterKey = req.apiKeys?.openRouterKey;
  if (!openRouterKey) {
    res.status(401).json({
      error: {
        message: 'OpenRouter API key missing. Add your key in Settings (free tier) or configure OPENROUTER_API_KEY on the server.',
        code: 'OPENROUTER_KEY_MISSING'
      }
    });
    return null;
  }
  return openRouterKey;
};

export const requireGeminiKey = (req: Request, res: Response): string | null => {
  const geminiKey = req.apiKeys?.geminiKey;
  if (!geminiKey) {
    res.status(401).json({ error: { message: 'Gemini API key missing.' } });
    return null;
  }
  return geminiKey;
};

export const requirePixazoKey = (req: Request, res: Response): string | null => {
  const pixazoKey = req.apiKeys?.pixazoKey;
  if (!pixazoKey) {
    res.status(401).json({ error: { message: 'Pixazo API key missing.' } });
    return null;
  }
  return pixazoKey;
};
