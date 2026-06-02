// Runs a check, persists the run + any findings, dedupes by fingerprint.
//
// A finding is "open" until resolved. If a finding with the same fingerprint is
// already open/confirmed/fixing, we DO NOT insert a duplicate — we log it on the
// existing finding's run history (via summary) so the dashboard shows the latest
// run without filing the bug twice. This is the core anti-spam invariant.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getBuiltin } from './registry.js';
import type { CheckContext, CheckRecord, RawFinding, Severity } from './types.js';

export interface RunOptions {
  trigger: 'schedule' | 'manual' | 'ci' | 'webhook';
  baseUrl?: string;
  /** Console-style log per run — captured into verification_runs.summary.logs. */
  onLog?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface RunResult {
  runId: string;
  status: 'passed' | 'failed' | 'error';
  findings: number;
  duplicates: number;
}

const SEVERITY_ORDER: Severity[] = ['low', 'med', 'high', 'critical'];

const ensureChecker = (record: CheckRecord) => {
  const builtinId = String((record.config as Record<string, unknown>)?.builtin || record.target_feature);
  const impl = getBuiltin(builtinId);
  if (!impl) {
    throw new Error(`Verification: no built-in check with id "${builtinId}". target_feature=${record.target_feature}`);
  }
  return impl;
};

const isAboveFloor = (sev: Severity, floor: Severity): boolean =>
  SEVERITY_ORDER.indexOf(sev) >= SEVERITY_ORDER.indexOf(floor);

export const runCheck = async (
  admin: SupabaseClient,
  record: CheckRecord,
  opts: RunOptions
): Promise<RunResult> => {
  const logs: { ts: string; message: string; meta?: unknown }[] = [];
  const log = (message: string, meta?: Record<string, unknown>) => {
    logs.push({ ts: new Date().toISOString(), message, meta });
    opts.onLog?.(message, meta);
  };

  // 1) Create the run row up front so it shows "running" in the dashboard.
  const { data: runRow, error: runErr } = await admin
    .from('verification_runs')
    .insert({ check_id: record.id, trigger: opts.trigger, status: 'running' })
    .select('id')
    .single();
  if (runErr || !runRow) {
    throw new Error(`Failed to create verification_runs row: ${runErr?.message || 'unknown error'}`);
  }
  const runId = String(runRow.id);

  let status: 'passed' | 'failed' | 'error' = 'passed';
  let findings: RawFinding[] = [];
  let inserted = 0;
  let duplicates = 0;
  let errorMessage: string | undefined;

  try {
    const impl = ensureChecker(record);
    const ctx: CheckContext = { admin, baseUrl: opts.baseUrl, log };
    log(`Running ${record.name} (${impl.builtinId})`);
    findings = await impl.run(record, ctx);
    log(`Check produced ${findings.length} finding(s)`);

    // 2) Persist findings, deduped by fingerprint via the partial unique index on
    //    (fingerprint) WHERE status in ('open','confirmed','fixing'). When a dup hits,
    //    upsert.onConflict points at fingerprint and we ignore.
    for (const f of findings) {
      if (!isAboveFloor(f.severity, record.severity_floor)) {
        log(`Skipping finding below severity floor`, {
          fingerprint: f.fingerprint,
          severity: f.severity,
          floor: record.severity_floor
        });
        continue;
      }
      const { data: existing } = await admin
        .from('verification_findings')
        .select('id, status')
        .eq('fingerprint', f.fingerprint)
        .in('status', ['open', 'confirmed', 'fixing'])
        .maybeSingle();
      if (existing) {
        duplicates++;
        log('Duplicate finding — already open', { fingerprint: f.fingerprint, existing: existing.id });
        continue;
      }
      const { error: insErr } = await admin.from('verification_findings').insert({
        run_id: runId,
        check_id: record.id,
        fingerprint: f.fingerprint,
        title: f.title,
        detail: f.detail,
        severity: f.severity,
        confidence: f.confidence,
        council_votes: f.council_votes ?? null,
        status: 'open'
      });
      if (insErr) {
        log('Failed to persist finding', { fingerprint: f.fingerprint, error: insErr.message });
        continue;
      }
      inserted++;
    }
    status = inserted > 0 ? 'failed' : 'passed';
  } catch (err) {
    status = 'error';
    errorMessage = (err as Error)?.message || String(err);
    log('Check threw', { error: errorMessage });
  }

  // 3) Finalise the run row with summary.
  await admin
    .from('verification_runs')
    .update({
      status,
      finished_at: new Date().toISOString(),
      summary: {
        logs,
        findings_total: findings.length,
        findings_inserted: inserted,
        findings_duplicated: duplicates,
        error: errorMessage
      }
    })
    .eq('id', runId);

  return { runId, status, findings: inserted, duplicates };
};
