import { Request, Response, NextFunction } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    apiKeys?: {
      geminiKey?: string | null;
      /** True when the Gemini key came from the end-user (header or account store), not the platform. */
      geminiByok?: boolean;
      pixazoKey?: string | null;
      /** True when the Pixazo key came from the end-user (header or account store), not the platform. */
      pixazoByok?: boolean;
      /** Resolved OpenRouter key (BYOK header or platform env). */
      openRouterKey?: string | null;
      /** True when the OpenRouter key came from the end-user (BYOK), not the platform. */
      openRouterByok?: boolean;
      /** Resolved NVIDIA Build key (BYOK header or platform env). Sent as X-Nvidia-Key to
       *  avoid colliding with the Supabase Authorization header. */
      nvidiaKey?: string | null;
      /** True when the NVIDIA key came from the end-user (BYOK), not the platform. */
      nvidiaByok?: boolean;
      /** Resolved Ideogram key (BYOK header or platform env). */
      ideogramKey?: string | null;
      /** True when the Ideogram key came from the end-user (BYOK), not the platform. */
      ideogramByok?: boolean;
    };
  }
}

// Central source governance: when the client sends `X-Allowed-Sources`, any provider
// NOT in that allow-list is treated as disabled — its key (BYOK *and* platform) is
// dropped here so no route can use it, accidentally or otherwise.
const parseAllowedSources = (header?: string): Set<string> | null => {
  if (typeof header !== 'string' || !header.trim()) return null;
  return new Set(header.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
};

/** Providers a request may use under its `X-Allowed-Sources` governance header. */
export const allowedProviderFilter = (req: Request): ((provider: string) => boolean) => {
  const allowed = parseAllowedSources(req.header('X-Allowed-Sources'));
  return (provider: string) => !allowed || allowed.has(provider);
};

export const attachKeys = (req: Request, _res: Response, next: NextFunction) => {
  const allow = allowedProviderFilter(req);

  const geminiHeaderKey = allow('gemini') ? (req.header('X-Gemini-Key') || null) : null;
  const geminiKey = allow('gemini') ? (geminiHeaderKey || process.env.GEMINI_API_KEY || null) : null;
  const pixazoHeaderKey = allow('pixazo') ? (req.header('X-Pixazo-Key') || req.header('X-Flux-Key') || null) : null;
  const pixazoKey = allow('pixazo')
    ? (pixazoHeaderKey
      || process.env.PIXAZO_API_KEY
      || process.env.PIXAZO_SUBSCRIPTION_KEY
      || process.env.FLUX_API_KEY
      || null)
    : null;
  const openRouterHeaderKey = allow('openrouter') ? (req.header('X-OpenRouter-Key') || null) : null;
  const openRouterKey = allow('openrouter') ? (openRouterHeaderKey || process.env.OPENROUTER_API_KEY || null) : null;
  const nvidiaHeaderKey = allow('nvidia') ? (req.header('X-Nvidia-Key') || null) : null;
  const nvidiaKey = allow('nvidia') ? (nvidiaHeaderKey || process.env.NVIDIA_API_KEY || null) : null;
  const ideogramHeaderKey = allow('ideogram') ? (req.header('X-Ideogram-Key') || null) : null;
  const ideogramKey = allow('ideogram') ? (ideogramHeaderKey || process.env.IDEOGRAM_API_KEY || null) : null;
  req.apiKeys = {
    geminiKey,
    geminiByok: Boolean(geminiHeaderKey),
    pixazoKey,
    pixazoByok: Boolean(pixazoHeaderKey),
    openRouterKey,
    openRouterByok: Boolean(openRouterHeaderKey),
    nvidiaKey,
    nvidiaByok: Boolean(nvidiaHeaderKey),
    ideogramKey,
    ideogramByok: Boolean(ideogramHeaderKey)
  };
  next();
};

export const requireNvidiaKey = (req: Request, res: Response): string | null => {
  const nvidiaKey = req.apiKeys?.nvidiaKey;
  if (!nvidiaKey) {
    res.status(401).json({
      error: {
        message: 'NVIDIA Build API key missing. Add your nvapi- key in Settings → API Configuration (free tier at build.nvidia.com).',
        code: 'NVIDIA_KEY_MISSING'
      }
    });
    return null;
  }
  return nvidiaKey;
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

export const requireIdeogramKey = (req: Request, res: Response): string | null => {
  const ideogramKey = req.apiKeys?.ideogramKey;
  if (!ideogramKey) {
    res.status(401).json({
      error: {
        message: 'Ideogram API key missing. Add your key in Settings → API Configuration (manage keys at ideogram.ai/manage-api).',
        code: 'IDEOGRAM_KEY_MISSING'
      }
    });
    return null;
  }
  return ideogramKey;
};
