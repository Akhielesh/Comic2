import { Request, Response, NextFunction } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    apiKeys?: {
      geminiKey?: string | null;
      pixazoKey?: string | null;
    };
  }
}

export const attachKeys = (req: Request, _res: Response, next: NextFunction) => {
  const geminiKey = req.header('X-Gemini-Key') || process.env.GEMINI_API_KEY || null;
  const pixazoKey = req.header('X-Pixazo-Key') || process.env.PIXAZO_API_KEY || process.env.PIXAZO_SUBSCRIPTION_KEY || process.env.FLUX_API_KEY || null;
  req.apiKeys = { geminiKey, pixazoKey };
  next();
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
