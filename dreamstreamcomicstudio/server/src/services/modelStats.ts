// DRS benchmark scores + privacy-first monthly model-usage analytics.
//
// Scores: one row per (source, model), overwritten by each finished bench run —
// "the latest DRS Benchmark Score" by construction. Readable by everyone
// (catalog reference data); written only by the server after a bench run.
//
// Usage analytics: aggregate MONTHLY counters per (month, product, source,
// model). Privacy-first by construction — no user ids, no sessions, no
// timestamps finer than the month bucket. Counters are bumped via a
// server-only SQL function and stored in Supabase (cloud, durable, organized).

import { getSupabaseAdmin } from './supabase.js';
import { logger } from '../lib/logger.js';

export interface ModelPhaseScore {
  pass: boolean | null;
  ttftMs: number | null;
  tokensPerSec: number | null;
}

export interface ModelBenchScore {
  source: string;
  model: string;
  score: number;
  phases: Record<string, ModelPhaseScore>;
  runId: string;
  computedAt: string;
}

export const persistModelScores = async (runId: string, scores: ModelBenchScore[]): Promise<void> => {
  if (!scores.length) return;
  try {
    const { error } = await getSupabaseAdmin().from('model_bench_scores').upsert(
      scores.map((s) => ({
        source: s.source,
        model: s.model,
        run_id: runId,
        score: s.score,
        phases: s.phases,
        computed_at: s.computedAt
      })),
      { onConflict: 'source,model' }
    );
    if (error) throw new Error(error.message);
    scoreCache = null; // next catalog read picks up fresh scores
  } catch (err) {
    logger.warn('model_scores_persist_failed', { runId, message: (err as Error)?.message });
  }
};

export const listModelScores = async (): Promise<{ runId: string | null; runAt: string | null; scores: ModelBenchScore[] }> => {
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('model_bench_scores')
      .select('source, model, run_id, score, phases, computed_at')
      .order('score', { ascending: false })
      .limit(1000);
    if (error) throw new Error(error.message);
    const rows = (data || []) as Array<Record<string, unknown>>;
    const scores = rows.map((r) => ({
      source: String(r.source),
      model: String(r.model),
      score: Number(r.score) || 0,
      phases: (r.phases || {}) as Record<string, ModelPhaseScore>,
      runId: String(r.run_id),
      computedAt: String(r.computed_at)
    }));
    const latest = scores[0];
    return { runId: latest?.runId ?? null, runAt: latest?.computedAt ?? null, scores };
  } catch (err) {
    logger.warn('model_scores_read_failed', { message: (err as Error)?.message });
    return { runId: null, runAt: null, scores: [] };
  }
};

// Small cache so attaching drsScore to the (hot, public) catalog endpoint costs
// one DB read every few minutes, not per request.
let scoreCache: { map: Map<string, number>; at: number } | null = null;
const SCORE_CACHE_TTL_MS = 5 * 60_000;

export const loadScoreMap = async (): Promise<Map<string, number>> => {
  if (scoreCache && Date.now() - scoreCache.at < SCORE_CACHE_TTL_MS) return scoreCache.map;
  const { scores } = await listModelScores();
  const map = new Map(scores.map((s) => [s.model, s.score]));
  scoreCache = { map, at: Date.now() };
  return map;
};

// ── Monthly usage (aggregate-only) ──────────────────────────────────────────────
const monthKey = (): string => new Date().toISOString().slice(0, 7); // 'YYYY-MM'

/** Fire-and-forget aggregate counter bump. Never throws into a request path. */
export const recordModelUsage = (product: string, source: string, model: string): void => {
  if (!model) return;
  void getSupabaseAdmin()
    .rpc('bump_model_usage', { p_month: monthKey(), p_product: product, p_source: source, p_model: model })
    .then(({ error }) => {
      if (error) logger.warn('model_usage_bump_failed', { message: error.message });
    });
};

export const listMonthlyUsage = async (
  months: number
): Promise<Array<{ month: string; product: string; source: string; model: string; requests: number }>> => {
  const span = Math.min(Math.max(months, 1), 24);
  const since = new Date();
  since.setUTCMonth(since.getUTCMonth() - (span - 1));
  const sinceKey = since.toISOString().slice(0, 7);
  try {
    const { data, error } = await getSupabaseAdmin()
      .from('model_usage_monthly')
      .select('month, product, source, model, requests')
      .gte('month', sinceKey)
      .order('month', { ascending: true })
      .limit(5000);
    if (error) throw new Error(error.message);
    return ((data || []) as Array<Record<string, unknown>>).map((r) => ({
      month: String(r.month),
      product: String(r.product),
      source: String(r.source),
      model: String(r.model),
      requests: Number(r.requests) || 0
    }));
  } catch (err) {
    logger.warn('model_usage_read_failed', { message: (err as Error)?.message });
    return [];
  }
};
