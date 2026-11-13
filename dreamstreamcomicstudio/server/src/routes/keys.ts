// BYOK key validation — POST /api/keys/validate
//
// The app stores provider keys client-side (localStorage), but until now NOTHING
// confirmed a key actually works: a typo'd, revoked, or out-of-credit key looked
// identical to a good one until a generation silently failed. This endpoint makes a
// cheap, read-only call to each provider so the UI can show a live valid/invalid badge
// (on add, on an explicit check, and when a stored verdict is over a day old on open).
//
// The candidate key is read from the same provider header attachKeys() already resolves
// (X-Nvidia-Key / X-OpenRouter-Key / X-Gemini-Key / X-Pixazo-Key / X-Ideogram-Key), so the
// client can validate ANY of its keys — including one not yet saved or not the active one —
// by sending it in that header.
//
// Security: this route only ever checks a key the CALLER owns — the one sent in the
// provider header, or the signed-in user's own account key (attachAccountKeys). The
// platform env key that attachKeys falls back to is never validated (callerKeyFor), so the
// route can neither confirm nor describe it. Mounted after requireAuth + attachAccountKeys
// (Settings → API Configuration is a signed-in page), and the response carries only
// { provider, status, valid, message } — never a provider's raw account record (usage,
// limits, credits). Messages are fixed text: a network error's own text (internal hosts,
// IPs, a configured base URL) is logged on the server and never sent back, and an unknown
// provider name is never echoed.

import { Request, Response, Router } from 'express';
import { GEMINI_BASE_URL, NVIDIA_BASE_URL, OPENROUTER_BASE_URL, ANTHROPIC_VERSION } from '../config.js';
import { logger } from '../lib/logger.js';
import { getProviderDef, isTextProvider, type ProviderDef, type ProviderId } from '../../../shared/providers.js';

export const keysRouter = Router();

/**
 * `unavailable` is NOT a verdict on the key: the provider could not be reached, or answered
 * with an error that says nothing about the key (5xx, 429, …). The client shows it without
 * storing it, so a passing outage never marks a good key Invalid.
 */
type ValidationStatus = 'valid' | 'invalid' | 'unsupported' | 'missing' | 'unavailable';

interface ValidationResult {
  provider: string;
  status: ValidationStatus;
  /** Convenience flag: true only for a confirmed-good key. */
  valid: boolean;
  message: string;
}

/**
 * The key this request may validate for `provider`: the one the caller sent in the provider
 * header, or the signed-in user's own account key — both marked BYOK by attachKeys /
 * attachAccountKeys. A platform env fallback (BYOK false) is never returned, so with no
 * caller key the answer is `missing` even when the server has a key for that provider.
 */
export const callerKeyFor = (req: Request, provider: ProviderId | 'pixazo' | 'ideogram' | 'sarvam'): string | null => {
  const k = req.apiKeys;
  if (!k) return null;
  switch (provider) {
    case 'openrouter':
      return k.openRouterByok ? k.openRouterKey || null : null;
    case 'nvidia':
      return k.nvidiaByok ? k.nvidiaKey || null : null;
    case 'gemini':
      return k.geminiByok ? k.geminiKey || null : null;
    case 'pixazo':
      return k.pixazoByok ? k.pixazoKey || null : null;
    case 'ideogram':
      return k.ideogramByok ? k.ideogramKey || null : null;
    case 'sarvam':
      return k.sarvamByok ? k.sarvamKey || null : null;
    default: {
      const entry = k.providerKeys?.[provider];
      return entry?.byok ? entry.key || null : null;
    }
  }
};

/** Only these fields ever leave this route (no raw provider account records). */
const publicResult = (r: ValidationResult): ValidationResult => ({
  provider: r.provider,
  status: r.status,
  valid: r.valid,
  message: r.message
});

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

// The provider could not be reached (DNS, refused, timeout, a malformed configured base URL).
// The error's own text can name internal hosts, IPs or the configured URL, so it goes to the
// server log only; the caller gets fixed text.
const unreachable = (provider: string, name: string, err: unknown): ValidationResult => {
  const e = err as (Error & { cause?: { code?: string } }) | undefined;
  logger.warn('key_validate_unreachable', { provider, error: e?.name, code: e?.cause?.code, message: e?.message });
  return { provider, status: 'unavailable', valid: false, message: `Could not reach ${name} right now.` };
};

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
        message: count != null ? `Valid — ${count} models reachable.` : 'Valid NVIDIA Build key.'
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
    return { provider: 'nvidia', status: 'unavailable', valid: false, message: `NVIDIA returned ${res.status}.` };
  } catch (err) {
    return unreachable('nvidia', 'NVIDIA Build', err);
  }
};

// OpenRouter: GET /api/v1/key answers 200 for a good key and 401/403 for a bad one. Only the
// HTTP status is used — the body (the key's account record: usage, limits, credits) is never
// read, let alone passed through to the response.
const validateOpenRouter = async (key: string): Promise<ValidationResult> => {
  try {
    const res = await timedFetch(`${OPENROUTER_BASE_URL}/key`, {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (res.ok) {
      return { provider: 'openrouter', status: 'valid', valid: true, message: 'Valid OpenRouter key.' };
    }
    if (res.status === 401 || res.status === 403) {
      return { provider: 'openrouter', status: 'invalid', valid: false, message: 'OpenRouter rejected this key.' };
    }
    return { provider: 'openrouter', status: 'unavailable', valid: false, message: `OpenRouter returned ${res.status}.` };
  } catch (err) {
    return unreachable('openrouter', 'OpenRouter', err);
  }
};

// Gemini: the public models list 400/401/403s on a bad key, 200s on a good one. The key
// goes in the x-goog-api-key header, never the URL (URLs end up in proxy/access logs).
const validateGemini = async (key: string): Promise<ValidationResult> => {
  try {
    const res = await timedFetch(`${GEMINI_BASE_URL}/v1beta/models`, {
      method: 'GET',
      headers: { 'x-goog-api-key': key }
    });
    if (res.ok) return { provider: 'gemini', status: 'valid', valid: true, message: 'Valid Gemini key.' };
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { provider: 'gemini', status: 'invalid', valid: false, message: 'Google rejected this Gemini key.' };
    }
    return { provider: 'gemini', status: 'unavailable', valid: false, message: `Gemini returned ${res.status}.` };
  } catch (err) {
    return unreachable('gemini', 'Google', err);
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
        message: count != null ? `Valid — ${count} models reachable.` : `Valid ${def.label} key.`
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { provider: def.id, status: 'invalid', valid: false, message: `Rejected by ${def.label} (auth failed) — key is invalid, revoked, or out of credits.` };
    }
    return { provider: def.id, status: 'unavailable', valid: false, message: `${def.label} returned ${res.status}.` };
  } catch (err) {
    return unreachable(def.id, def.label, err);
  }
};

keysRouter.post('/validate', async (req: Request, res: Response) => {
  const provider = String(req.body?.provider || '').trim().toLowerCase();

  let result: ValidationResult;
  switch (provider) {
    case 'nvidia': {
      const key = callerKeyFor(req, 'nvidia');
      result = key ? await validateNvidia(key) : missing('nvidia');
      break;
    }
    case 'openrouter': {
      const key = callerKeyFor(req, 'openrouter');
      result = key ? await validateOpenRouter(key) : missing('openrouter');
      break;
    }
    case 'gemini': {
      const key = callerKeyFor(req, 'gemini');
      result = key ? await validateGemini(key) : missing('gemini');
      break;
    }
    case 'pixazo': {
      // Pixazo/Flux has no documented key-introspection endpoint, so we can't live-check it.
      const key = callerKeyFor(req, 'pixazo');
      result = {
        provider: 'pixazo',
        status: key ? 'unsupported' : 'missing',
        valid: false,
        message: key
          ? 'Stored — Pixazo has no validation endpoint, so it can’t be live-checked.'
          : 'No Pixazo key provided.'
      };
      break;
    }
    case 'ideogram': {
      // Ideogram has no documented key-introspection endpoint either — same honest treatment.
      const key = callerKeyFor(req, 'ideogram');
      result = {
        provider: 'ideogram',
        status: key ? 'unsupported' : 'missing',
        valid: false,
        message: key
          ? 'Stored — Ideogram has no validation endpoint, so it can’t be live-checked.'
          : 'No Ideogram key provided.'
      };
      break;
    }
    case 'sarvam': {
      const key = callerKeyFor(req, 'sarvam');
      result = key ? { provider, status: 'unsupported', valid: false, message: 'Stored. Use it on a translation to verify it with Sarvam AI.' } : missing(provider);
      break;
    }
    default: {
      // Direct providers (openai, anthropic, deepseek, zai, minimax, tencent, xai).
      const def = isTextProvider(provider) ? getProviderDef(provider) : undefined;
      // Never echo the caller's input back.
      if (!def) return res.status(400).json({ error: { message: 'Unknown provider.' } });
      const key = callerKeyFor(req, def.id);
      result = key ? await validateDirectProvider(def, key) : missing(def.id);
      break;
    }
  }

  res.json(publicResult(result));
});
