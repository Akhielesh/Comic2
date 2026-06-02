// Built-in check: persisted ESTIMATES (when present) approximate the BILLED amount.
//
// This is the loop-closer for "Preview shows X cents, Review says Y dollars" — if the
// estimate and the billed actual diverge beyond tolerance over recent events, file
// a finding that points at the model/stage so the estimator can be corrected.
//
// In the current schema generation_cost_events doesn't yet carry an estimate column;
// when it doesn't, this check is a no-op (a harmless pass), so it can ship today and
// start firing once the estimate field is added in a follow-up.

import crypto from 'node:crypto';
import type { CheckImpl, RawFinding } from '../types.js';

const fp = (parts: string[]) => crypto.createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 16);

const TOLERANCE_PCT_DEFAULT = 25; // ±25% per row (per call)
const RECENT_LIMIT_DEFAULT = 500;

export const costReconciliation: CheckImpl = {
  builtinId: 'cost_reconciliation',
  description: 'Persisted estimate per generation is within tolerance of the billed actual.',
  kind: 'deterministic',
  target: 'cost_reconciliation',
  severity: 'med',
  async run(record, ctx) {
    const findings: RawFinding[] = [];
    const cfg = record.config as Record<string, unknown>;
    const tolerancePct = Number(cfg?.tolerancePct ?? TOLERANCE_PCT_DEFAULT);
    const limit = Math.max(1, Number(cfg?.recentLimit ?? RECENT_LIMIT_DEFAULT));

    const { data: events, error } = await ctx.admin
      .from('generation_cost_events')
      .select('id, model, stage, cost, estimated_cost, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error) {
      ctx.log('Could not query generation_cost_events', { error: error.message });
      return findings;
    }
    const rows = events || [];
    const withEstimate = rows.filter((r: any) => typeof r.estimated_cost === 'number' && typeof r.cost === 'number');
    if (withEstimate.length === 0) {
      // No rows carry an estimate yet — no signal. Treat as pass.
      ctx.log('No rows with estimated_cost yet; cost reconciliation is a no-op for now', { sampled: rows.length });
      return findings;
    }

    type Bucket = { model: string; stage: string; total: number; estTotal: number; rows: number; worstRatio: number };
    const buckets = new Map<string, Bucket>();
    for (const r of withEstimate as any[]) {
      const model = String(r.model || 'unknown');
      const stage = String(r.stage || 'unknown');
      const key = `${model}|${stage}`;
      const billed = Number(r.cost) || 0;
      const estimate = Number(r.estimated_cost) || 0;
      const ratio = billed > 0 ? Math.abs(estimate - billed) / billed : 0;
      const b = buckets.get(key) || { model, stage, total: 0, estTotal: 0, rows: 0, worstRatio: 0 };
      b.total += billed;
      b.estTotal += estimate;
      b.rows += 1;
      b.worstRatio = Math.max(b.worstRatio, ratio);
      buckets.set(key, b);
    }
    for (const b of buckets.values()) {
      if (b.rows < 10) continue; // require some signal before filing.
      const drift = b.total > 0 ? Math.abs(b.estTotal - b.total) / b.total : 0;
      if (drift * 100 > tolerancePct) {
        findings.push({
          fingerprint: fp(['cost_reconciliation', b.model, b.stage]),
          title: `Estimate drifts from billed by ${(drift * 100).toFixed(1)}% on ${b.model} / ${b.stage}`,
          detail: {
            model: b.model,
            stage: b.stage,
            rows: b.rows,
            billedTotal: b.total,
            estimatedTotal: b.estTotal,
            driftPct: drift * 100,
            tolerancePct,
            evidence: 'Per-row estimate differs from billed cost beyond tolerance across recent events.',
            suggestedFix:
              'Inspect shared/pricing.estimateUsd inputs in the relevant route — usually wrong token split or stale pricing axes.'
          },
          severity: 'med',
          confidence: 0.9
        });
      }
    }
    return findings;
  }
};
