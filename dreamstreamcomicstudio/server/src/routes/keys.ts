// BYOK key validation — POST /api/keys/validate
//
// The app stores provider keys client-side (localStorage), but until now NOTHING
// confirmed a key actually works: a typo'd, revoked, or out-of-credit key looked
// identical to a good one until a generation silently failed. This endpoint makes a
// cheap, read-only call to each provider so the UI can show a live valid/invalid badge
// (on add, on demand, and on a periodic re-check).
//
// The candidate key is read from the same provider header attachKeys() already resolves
// (X-Nvidia-Key / X-OpenRouter-Key / X-Gemini-Key / X-Pixazo-Key), so the client can
// validate ANY key — including one not yet saved or not the active one — by sending it
// in that header. Mounted before requireAuth (BYOK validation needs no app login).

import { Request, Response, Router } from 'express';
import { GEMINI_BASE_URL, NVIDIA_BASE_URL, ANTHROPIC_VERSION } from '../config.js';
import { fetchOpenRouterKeyStatus } from '../ai/providers/openrouter.js';
import { getProviderDef, isTextProvider, type ProviderDef } from '../../../shared/providers.js';

export const keysRouter = Router();

type ValidationStatus = 'valid' | 'invalid' | 'unsupported' | 'missing';

interface ValidationResult {
  provider: string;
  status: ValidationStatus;
  /** Convenience flag: true only for a confirmed-good key. */
  valid: boolean;
  message: string;
  detail?: Record<string, unknown>;
}

const VALIDATE_TIMEOUT_MS = 12_000;

// NB: no return annotation — let it infer the global fetch Response (the `Response` name in
// this module resolves to Express's type via the route imports).
const timedFetch = async (url: string, init: RequestInit) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const missing = (provider: string): ValidationResult => ({
  provider,
  status: 'missing',
  valid: false,
  message: 'No key provided to validate.'
});

// NVIDIA Build: GET /models requires auth, so a 200 proves the key works (and tells us how
// many models it can reach); 401/403 means invalid/revoked/out-of-credits.
const validateNvidia = async (key: string): Promise<ValidationResult> => {
  try {
    const res = await timedFetch(`${NVIDIA_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const count = Array.isArray(data?.data) ? data.data.length : undefined;
      return {
        provider: 'nvidia',
        status: 'valid',
        valid: true,
        message: count != null ? `Valid — ${count} models reachable.` : 'Valid NVIDIA Build key.',
        detail: count != null ? { modelCount: count } : undefined
      };
    }
    if (res.status === 401 || res.status === 403) {
      return {
        provider: 'nvidia',
        status: 'invalid',
        valid: false,
        message: 'Rejected by NVIDIA (auth failed) — key is invalid, revoked, or out of credits.'
      };
    }
    return { provider: 'nvidia', status: 'invalid', valid: false, message: `NVIDIA returned ${res.status}.` };
  } catch (err) {
    return {
      provider: 'nvidia',
      status: 'invalid',
      valid: false,
      message: `Could not reach NVIDIA Build: ${(err as Error)?.message || 'network error'}.`
    };
  }
};

// OpenRouter: GET /api/v1/key returns the real account/usage payload for a good key,
// and null on rejection or network failure.
const validateOpenRouter = async (key: string): Promise<ValidationResult> => {
  const status = await fetchOpenRouterKeyStatus(key);
  if (status) {
    return {
      provider: 'openrouter',
      status: 'valid',
      valid: true,
      message: 'Valid OpenRouter key.',
      detail: status
    };
  }
  return {
    provider: 'openrouter',
    status: 'invalid',
    valid: false,
    message: 'OpenRouter rejected this key (or it could not be reached).'
  };
};

// Gemini: the public models list 400/401/403s on a bad key, 200s on a good one.
const validateGemini = async (key: string): Promise<ValidationResult> => {
  try {
    const res = await timedFetch(`${GEMINI_BASE_URL}/v1beta/models?key=${encodeURIComponent(key)}`, {
      method: 'GET'
    });
    if (res.ok) return { provider: 'gemini', status: 'valid', valid: true, message: 'Valid Gemini key.' };
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { provider: 'gemini', status: 'invalid', valid: false, message: 'Google rejected this Gemini key.' };
    }
    return { provider: 'gemini', status: 'invalid', valid: false, message: `Gemini returned ${res.status}.` };
  } catch (err) {
    return {
      provider: 'gemini',
      status: 'invalid',
      valid: false,
      message: `Could not reach Google: ${(err as Error)?.message || 'network error'}.`
    };
  }
};

// Generic validator for the direct providers: a cheap, read-only GET on the provider's
// model-list endpoint. 200 proves the key works; 401/403 proves it's invalid/revoked.
// Providers with no public listing (modelsPath null, e.g. Z.AI / MiniMax) are stored but
// reported 'unsupported' (can't be live-checked) — same honest treatment as Pixazo.
const validateDirectProvider = async (def: ProviderDef, key: string): Promise<ValidationResult> => {
  if (!def.modelsPath) {
    return {
      provider: def.id,
      status: 'unsupported',
      valid: false,
      message: `Stored — ${def.label} has no public model-list endpoint, so the key can’t be live-checked here.`
    };
  }
  const baseUrl = process.env[def.baseUrlEnv] || def.baseUrl;
  const headers: Record<string, string> =
    def.api === 'anthropic'
      ? { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }
      : { Authorization: `Bearer ${key}` };
  try {
    const res = await timedFetch(`${baseUrl}${def.modelsPath}`, { headers });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      const count = Array.isArray((data as any)?.data) ? (data as any).data.length : undefined;
      return {
        provider: def.id,
        status: 'valid',
        valid: true,
        message: count != null ? `Valid — ${count} models reachable.` : `Valid ${def.label} key.`,
        detail: count != null ? { modelCount: count } : undefined
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { provider: def.id, status: 'invalid', valid: false, message: `Rejected by ${def.label} (auth failed) — key is invalid, revoked, or out of credits.` };
    }
    return { provider: def.id, status: 'invalid', valid: false, message: `${def.label} returned ${res.status}.` };
  } catch (err) {
    return { provider: def.id, status: 'invalid', valid: false, message: `Could not reach ${def.label}: ${(err as Error)?.message || 'network error'}.` };
  }
};

keysRouter.post('/validate', async (req: Request, res: Response) => {
  const provider = String(req.body?.provider || '').trim().toLowerCase();
  const keys = req.apiKeys || {};

  let result: ValidationResult;
  switch (provider) {
    case 'nvidia':
      result = keys.nvidiaKey ? await validateNvidia(keys.nvidiaKey) : missing('nvidia');
      break;
    case 'openrouter':
      result = keys.openRouterKey ? await validateOpenRouter(keys.openRouterKey) : missing('openrouter');
      break;
    case 'gemini':
      result = keys.geminiKey ? await validateGemini(keys.geminiKey) : missing('gemini');
      break;
    case 'pixazo':
      // Pixazo/Flux has no documented key-introspection endpoint, so we can't live-check it.
      result = {
        provider: 'pixazo',
        status: keys.pixazoKey ? 'unsupported' : 'missing',
        valid: false,
        message: keys.pixazoKey
          ? 'Stored — Pixazo has no validation endpoint, so it can’t be live-checked.'
          : 'No Pixazo key provided.'
      };
      break;
    default: {
      // Direct providers (openai, anthropic, deepseek, zai, minimax, tencent, xai).
      const def = isTextProvider(provider) ? getProviderDef(provider) : undefined;
      if (!def) return res.status(400).json({ error: { message: `Unknown provider "${provider}".` } });
      const key = req.apiKeys?.providerKeys?.[def.id]?.key;
      result = key ? await validateDirectProvider(def, key) : missing(def.id);
      break;
    }
  }

  res.json(result);
});
