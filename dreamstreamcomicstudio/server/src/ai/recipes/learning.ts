// The self-improvement loop. This is the payoff of the whole subsystem: a completed
// run can be reflected on, scored, and — if it represents a repeatable workflow —
// distilled into a reusable Recipe plus durable learnings. Re-running and refining
// those recipes is how the agents and models "improve themselves" over time, instead
// of every good run evaporating when the conversation ends.
//
// Implementation: drive the built-in `self-retrospective` recipe through the normal
// runner (so the meta-step is itself a recipe — eat our own dog food), then sanitize
// any proposed recipe through the same validator everything else uses.

import { runRecipe } from './runRecipe.js';
import { sanitizeRecipe } from './validate.js';
import { getBuiltinRecipe } from './library.js';
import type { Recipe } from './schema.js';
import type { AIProviderId } from '../providers/types.js';
import type { ApiUsage, ChatClientContext } from '../../../../apiTypes.js';

export interface DistillParams {
  goal: string;
  transcript: string;
  provider: AIProviderId;
  apiKey: string;
  model: string;
  clientContext?: ChatClientContext;
  fallbackModel?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface DistillResult {
  /** 0–1 self-assessed success of the original run. */
  score?: number;
  justification?: string;
  /** Durable, reusable lessons for next time. */
  learnings: string[];
  /** A reusable recipe distilled from the run (sanitized), when the run was repeatable. */
  proposedRecipe?: Recipe;
  usage: ApiUsage;
  /** The raw structured output (for debugging / fallback display). */
  raw?: unknown;
}

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 12) : [];

/**
 * Reflect on a completed run and distill a score + learnings + an optional reusable
 * recipe. Best-effort and never throws: a failed reflection just returns empty
 * learnings, so the self-improvement step can run opportunistically after any task.
 */
export const distillRecipe = async (params: DistillParams): Promise<DistillResult> => {
  const recipe = getBuiltinRecipe('self-retrospective');
  if (!recipe) return { learnings: [], usage: {} };

  try {
    const res = await runRecipe({
      recipe,
      values: { goal: params.goal, transcript: params.transcript.slice(0, 12000) },
      provider: params.provider,
      apiKey: params.apiKey,
      model: params.model,
      clientContext: params.clientContext,
      fallbackModel: params.fallbackModel,
      timeoutMs: params.timeoutMs,
      signal: params.signal
    });

    const structured = (res.structured || {}) as Record<string, unknown>;
    const learnings = asStringArray(structured.learnings);
    const score = typeof structured.score === 'number' ? Math.max(0, Math.min(1, structured.score)) : undefined;
    const justification = typeof structured.justification === 'string' ? structured.justification.slice(0, 600) : undefined;

    // Distilled recipe → through the same sanitizer as everything else. The model
    // returns a loose shape; sanitizeRecipe enforces the real contract (title +
    // instructions/prompt, allowlisted tools, capped lengths) or drops it.
    let proposedRecipe: Recipe | undefined;
    const proposed = structured.proposedRecipe;
    if (proposed && typeof proposed === 'object') {
      const safe = sanitizeRecipe(proposed);
      if (safe) proposedRecipe = safe;
    }

    return { score, justification, learnings, proposedRecipe, usage: res.usage, raw: structured };
  } catch {
    return { learnings: [], usage: {} };
  }
};
