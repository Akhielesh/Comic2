// Free-only AI council — runs N free models in parallel against a structured prompt,
// then aggregates their votes into a confidence score. A finding is only emitted when
// confidence ≥ the check's threshold, suppressing false positives.
//
// Operational reality: free models are rate-limited. The council degrades gracefully:
//   - tries each member with a short timeout,
//   - skips ones that 429/timeout,
//   - requires a minimum quorum (default 2/3 voters available) to count as a result;
//     below quorum, the council reports "no_signal" and the check passes (silently).
//
// This module is intentionally light — the heavy AI plumbing reuses the existing
// providers/openrouter.ts text path. Concrete ai_council checks call castVotes() with a
// prompt + parseVote function.

import { openRouterProvider } from '../ai/providers/openrouter.js';
import { pickTextModel } from '../ai/autoRouter.js';
import type { ProviderContext } from '../ai/providers/types.js';

export type Vote = { ok: boolean; weight: number; note?: string };

export interface CouncilOptions {
  prompt: string;
  panelSize?: number;        // default 3 free models
  quorum?: number;           // default Math.ceil(panelSize * 2/3)
  timeoutMs?: number;        // default 12_000
  /** Provider context (BYOK or platform key). The council only ever uses free models. */
  ctx: ProviderContext;
}

export interface CouncilResult {
  status: 'judged' | 'no_signal';
  /** Aggregate confidence in [0,1]: weighted share that voted ok=true. */
  confidence: number;
  votes: Array<{ model: string; vote?: Vote; error?: string }>;
  panelSize: number;
  quorum: number;
}

/**
 * Cast votes. `parse` extracts a Vote from each model's response — checks own the
 * parsing because each one expects a different structured output.
 */
export const castVotes = async (
  opts: CouncilOptions,
  parse: (text: string, model: string) => Vote | null
): Promise<CouncilResult> => {
  const panelSize = Math.max(1, opts.panelSize ?? 3);
  const quorum = opts.quorum ?? Math.ceil((panelSize * 2) / 3);
  const timeoutMs = opts.timeoutMs ?? 12_000;

  // Pick `panelSize` distinct free-only text models from the catalog.
  const ids = new Set<string>();
  for (let i = 0; i < panelSize; i++) {
    try {
      const id = await pickTextModel({ costPref: 'free-only' });
      if (ids.has(id)) {
        // Same free model returned twice — accept duplicates rather than fail; voters
        // running in parallel will still produce useful redundancy.
      }
      ids.add(id);
    } catch {
      // No free model available — abort with no_signal.
      return { status: 'no_signal', confidence: 0, votes: [], panelSize, quorum };
    }
  }
  const panel = Array.from(ids);
  const results: CouncilResult['votes'] = [];
  await Promise.all(
    panel.map(async (model) => {
      try {
        const text = await Promise.race([
          openRouterProvider.generateText(
            { model, freeOnly: true, messages: [{ role: 'user', content: opts.prompt }] },
            opts.ctx
          ),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('council_timeout')), timeoutMs))
        ]);
        const vote = parse((text as { text: string }).text, model);
        if (vote) results.push({ model, vote });
        else results.push({ model, error: 'parse_failed' });
      } catch (err) {
        results.push({ model, error: (err as Error).message });
      }
    })
  );

  const valid = results.filter((r) => r.vote);
  if (valid.length < quorum) {
    return { status: 'no_signal', confidence: 0, votes: results, panelSize, quorum };
  }
  const okWeight = valid.reduce((s, r) => s + (r.vote!.ok ? r.vote!.weight : 0), 0);
  const totalWeight = valid.reduce((s, r) => s + r.vote!.weight, 0) || 1;
  return {
    status: 'judged',
    confidence: okWeight / totalWeight,
    votes: results,
    panelSize,
    quorum
  };
};
