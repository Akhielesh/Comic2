// Worker-side LLM completion using PLATFORM keys (Epic A4). The ventures worker is a background
// process with no per-request BYOK, so it resolves a provider from the platform env keys
// (OPENROUTER_API_KEY / NVIDIA_API_KEY) and auto-picks a coding model. Returns null when no
// platform key is configured (the tick then reports a clean failure rather than crashing).
// Mirrors the studio's resolveStudioProvider + runChat wiring.

import { NVIDIA_API_KEY, OPENROUTER_API_KEY, STUDIO_REQUEST_TIMEOUT_MS } from '../config.js';
import { runChat } from '../ai/chat.js';
import { pickCodingModel, TEXT_FALLBACK } from '../ai/autoRouter.js';
import type { AIProviderId } from '../ai/providers/types.js';

export interface PlatformComplete {
  complete: (prompt: string) => Promise<string>;
  provider: AIProviderId;
  model: string;
}

/** Build a platform-key `complete(prompt)` for the worker, or null if no platform key is set. */
export const getPlatformComplete = async (maxTokens = 4000): Promise<PlatformComplete | null> => {
  let provider: AIProviderId;
  let apiKey: string;
  if (OPENROUTER_API_KEY) {
    provider = 'openrouter';
    apiKey = OPENROUTER_API_KEY;
  } else if (NVIDIA_API_KEY) {
    provider = 'nvidia';
    apiKey = NVIDIA_API_KEY;
  } else {
    return null;
  }

  const model = await pickCodingModel().catch(() => TEXT_FALLBACK);

  const complete = async (prompt: string): Promise<string> => {
    const result = await runChat({
      provider,
      apiKey,
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      maxTokens,
      fallbackModel: provider === 'openrouter' ? TEXT_FALLBACK : undefined,
      timeoutMs: STUDIO_REQUEST_TIMEOUT_MS
    });
    return result.text;
  };

  return { complete, provider, model };
};
