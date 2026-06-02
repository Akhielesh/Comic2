// Built-in check: model_pricing_snapshots is up-to-date and clean.
//
// Asserts:
//   1) the most recent snapshot is within the freshness window (default 24h),
//   2) no rows are stuck in REVIEW_REQUIRED status (which means dailyPricingSync
//      detected a delta > 35% and a human should look).

import crypto from 'node:crypto';
import type { CheckImpl, RawFinding } from '../types.js';

const fp = (parts: string[]) => crypto.createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 16);

const FRESHNESS_HOURS_DEFAULT = 24;

export const pricingFreshness: CheckImpl = {
  builtinId: 'pricing_freshness',
  description: 'Live pricing catalog is < freshnessHours old and free of REVIEW_REQUIRED rows.',
  kind: 'deterministic',
  target: 'pricing_freshness',
  severity: 'med',
  async run(record, ctx) {
    const findings: RawFinding[] = [];
    const freshnessHours = Number((record.config as Record<string, unknown>)?.freshnessHours ?? FRESHNESS_HOURS_DEFAULT);

    // 1) newest snapshot's effective_from must be within freshnessHours.
    const { data: newest, error: newestErr } = await ctx.admin
      .from('model_pricing_snapshots')
      .select('provider, model_id, effective_from, status')
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (newestErr) {
      ctx.log('Could not query model_pricing_snapshots', { error: newestErr.message });
    } else if (!newest) {
      findings.push({
        fingerprint: fp(['pricing_freshness', 'empty']),
        title: 'No rows in model_pricing_snapshots at all',
        detail: { evidence: 'Catalog table empty. dailyPricingSync has never produced a snapshot.' },
        severity: 'high',
        confidence: 1
      });
    } else {
      const newestMs = new Date(String(newest.effective_from)).getTime();
      const ageHours = (Date.now() - newestMs) / 3_600_000;
      if (ageHours > freshnessHours) {
        findings.push({
          fingerprint: fp(['pricing_freshness', 'stale', String(Math.floor(ageHours))]),
          title: `Newest pricing snapshot is ${ageHours.toFixed(1)}h old (> ${freshnessHours}h)`,
          detail: {
            newest: newest,
            ageHours,
            threshold: freshnessHours,
            evidence: 'dailyPricingSync has not produced a fresh row in the freshness window.',
            suggestedFix: 'Run `npm run pricing:sync` or fix the nightly GitHub Action (daily-pricing-check.yml).'
          },
          severity: 'med',
          confidence: 1
        });
      }
    }

    // 2) REVIEW_REQUIRED rows — surface every distinct (provider, model_id) once.
    const { data: pending, error: pendingErr } = await ctx.admin
      .from('model_pricing_snapshots')
      .select('provider, model_id, status, effective_from')
      .eq('status', 'REVIEW_REQUIRED');

    if (pendingErr) {
      ctx.log('Could not query REVIEW_REQUIRED rows', { error: pendingErr.message });
    } else if (pending && pending.length) {
      for (const row of pending) {
        findings.push({
          fingerprint: fp(['pricing_freshness', 'review_required', String(row.provider), String(row.model_id)]),
          title: `Pricing for ${row.provider}/${row.model_id} is REVIEW_REQUIRED`,
          detail: {
            provider: row.provider,
            modelId: row.model_id,
            effectiveFrom: row.effective_from,
            evidence:
              'dailyPricingSync detected a delta > 35% on this row and flagged it for human review.',
            suggestedFix:
              'Open the latest pricing source PR / changelog, confirm or reject the delta, and clear the status.'
          },
          severity: 'high',
          confidence: 1
        });
      }
    }
    return findings;
  }
};
