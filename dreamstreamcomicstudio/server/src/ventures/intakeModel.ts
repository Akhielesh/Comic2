// The model call behind Autopilot intake (idea → roadmap). It used to borrow Code Studio's
// stage closure; Code Studio is retired (ADR 0005), so the few lines intake needs live here.
// Same behaviour as before: the caller's resolved keys/allowance (req.apiKeys) pay for it, an
// explicit `source` wins when its key is present, else OpenRouter, then NVIDIA; the model is a
// user-pinned id or the strongest coder for that provider.

import { NVIDIA_TEXT_MODEL, VENTURES_INTAKE_TIMEOUT_MS } from '../config.js';
import type { AIProviderId } from '../ai/providers/types.js';
import { pickCodingModel, TEXT_FALLBACK } from '../ai/autoRouter.js';
import { runChat } from '../ai/chat.js';

export interface IntakeKeys {
  openRouterKey?: string | null;
  nvidiaKey?: string | null;
}

export interface IntakeModelPrefs {
  source?: string;
  model?: string;
  costPref?: string;
}

type CostPref = 'free' | 'cheap' | 'quality';

/** Pure: pick the provider + key, honoring an explicit `source`. Null when no key exists. */
export const resolveIntakeProvider = (
  keys: IntakeKeys | undefined,
  requestedSource?: string
): { provider: AIProviderId; apiKey: string } | null => {
  const source = String(requestedSource || '').trim().toLowerCase();
  const openRouterKey = keys?.openRouterKey || undefined;
  const nvidiaKey = keys?.nvidiaKey || undefined;
  if (source === 'nvidia' && nvidiaKey) return { provider: 'nvidia', apiKey: nvidiaKey };
  if (source === 'openrouter' && openRouterKey) return { provider: 'openrouter', apiKey: openRouterKey };
  if (openRouterKey) return { provider: 'openrouter', apiKey: openRouterKey };
  if (nvidiaKey) return { provider: 'nvidia', apiKey: nvidiaKey };
  return null;
};

// Default to the strongest coder ('quality'); an explicit 'free'/'cheap' is still honored.
const normCostPref = (p?: string): CostPref => (p === 'cheap' || p === 'free' || p === 'quality' ? p : 'quality');

/** A user-pinned model id wins; otherwise auto-pick the strongest coder for the provider. */
export const resolveIntakeModel = async (
  provider: AIProviderId,
  requestedModel?: string,
  costPref?: string
): Promise<string> => {
  const pinned = typeof requestedModel === 'string' ? requestedModel.trim() : '';
  if (pinned) return pinned;
  const pref = normCostPref(costPref);
  if (provider === 'nvidia') {
    try {
      return await pickCodingModel({ costPref: pref, filter: (m) => m.source === 'nvidia' });
    } catch {
      return NVIDIA_TEXT_MODEL;
    }
  }
  try {
    return await pickCodingModel({ costPref: pref });
  } catch {
    return TEXT_FALLBACK;
  }
};

/** A `complete(prompt)` closure for runIntake, or null when the caller has no model key. */
export const intakeComplete = async (
  keys: IntakeKeys | undefined,
  prefs: IntakeModelPrefs,
  maxTokens: number
): Promise<((prompt: string) => Promise<string>) | null> => {
  const resolved = resolveIntakeProvider(keys, prefs.source);
  if (!resolved) return null;
  const model = await resolveIntakeModel(resolved.provider, prefs.model, prefs.costPref);
  return async (prompt: string): Promise<string> => {
    const result = await runChat({
      provider: resolved.provider,
      apiKey: resolved.apiKey,
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      maxTokens,
      fallbackModel: resolved.provider === 'openrouter' ? TEXT_FALLBACK : undefined,
      timeoutMs: VENTURES_INTAKE_TIMEOUT_MS
    });
    return result.text || '';
  };
};
