// Public (authenticated) DRS benchmark scores — the latest published bench run,
// distilled to one 0–100 score per model plus per-phase health (pass, TTFT, tok/s).
//
// Backend contract (parallel workstream; may not exist yet — resolves to `null` on
// 404/error so panels can degrade gracefully):
//   GET /api/models/bench-scores
//     → { runId: string | null, runAt: string | null,
//         scores: [{ model, source, score, phases: { [phase]: { pass, ttftMs, tokensPerSec } } }] }

import { get } from './apiClient';

export type BenchScoreSource = 'openrouter' | 'nvidia';

export interface BenchPhaseStat {
  pass: boolean | null;
  ttftMs: number | null;
  tokensPerSec: number | null;
}

export interface BenchScore {
  model: string;
  source: BenchScoreSource;
  /** 0–100 DRS score. */
  score: number;
  phases: Record<string, BenchPhaseStat>;
}

export interface BenchScores {
  runId: string | null;
  runAt: string | null;
  scores: BenchScore[];
}

const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

const parsePhases = (raw: unknown): Record<string, BenchPhaseStat> => {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, BenchPhaseStat> = {};
  for (const [phase, stat] of Object.entries(raw as Record<string, unknown>)) {
    if (!stat || typeof stat !== 'object') continue;
    const s = stat as Record<string, unknown>;
    out[phase] = {
      pass: boolOrNull(s.pass),
      ttftMs: numOrNull(s.ttftMs),
      tokensPerSec: numOrNull(s.tokensPerSec)
    };
  }
  return out;
};

/** Latest published bench scores, or null when the endpoint is missing/erroring. */
export const fetchBenchScores = async (options?: { signal?: AbortSignal }): Promise<BenchScores | null> => {
  try {
    const raw = await get<{ runId?: unknown; runAt?: unknown; scores?: unknown[] }>('/api/models/bench-scores', options);
    if (!raw || !Array.isArray(raw.scores)) return null;
    const scores: BenchScore[] = raw.scores
      .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === 'object')
      .filter((s) => typeof s.model === 'string' && s.model.length > 0)
      .map((s) => ({
        model: s.model as string,
        source: s.source === 'nvidia' ? 'nvidia' : 'openrouter',
        score: Math.max(0, Math.min(100, numOrNull(s.score) ?? 0)),
        phases: parsePhases(s.phases)
      }));
    return {
      runId: typeof raw.runId === 'string' ? raw.runId : null,
      runAt: typeof raw.runAt === 'string' ? raw.runAt : null,
      scores
    };
  } catch {
    return null;
  }
};
