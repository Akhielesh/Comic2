// CLI runner for the verification system.
//
// Usage:
//   npm run verify:run                          (run all enabled checks)
//   npm run verify:run -- --check <id>          (run one check by uuid)
//   npm run verify:run:check                    (exit non-zero if any finding)
//
// Designed to be called both from the nightly GitHub Action and from a developer's
// shell. Mirrors the dailyPricingSync / dailyBillingReconciliation script shape so
// the existing CI patterns just work.

import './preferModelTestKey.js'; // MUST stay first: bills this run to the model-test key, not the user-serving one
import { getSupabaseAdmin } from '../services/supabase.js';
import { runCheck } from '../verification/runner.js';
import { listBuiltins } from '../verification/registry.js';
import type { CheckRecord, Severity, TargetFeature, CheckKind } from '../verification/types.js';

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const valueOf = (flag: string): string | undefined => {
  const idx = argv.indexOf(flag);
  return idx >= 0 && idx + 1 < argv.length ? argv[idx + 1] : undefined;
};
const isCheckMode = has('--check');
const onlyId = valueOf('--id');
const builtinId = valueOf('--builtin');

const log = (message: string, meta?: unknown) => {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), message, meta }) + '\n');
};

const loadChecks = async (): Promise<CheckRecord[]> => {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('verification_checks')
    .select('id, name, description, target_feature, kind, config, schedule, enabled, auto_fix_enabled, severity_floor')
    .eq('enabled', true);
  if (error) throw new Error(`Failed to load checks: ${error.message}`);
  return (data || []).map((row: Record<string, unknown>) => ({
    id: String(row.id),
    name: String(row.name),
    description: row.description ? String(row.description) : undefined,
    target_feature: String(row.target_feature) as TargetFeature,
    kind: String(row.kind) as CheckKind,
    config: (row.config as Record<string, unknown>) || {},
    schedule: row.schedule ? String(row.schedule) : null,
    enabled: Boolean(row.enabled),
    auto_fix_enabled: Boolean(row.auto_fix_enabled),
    severity_floor: String(row.severity_floor) as Severity
  }));
};

const builtinAsRecord = (id: string): CheckRecord | undefined => {
  const impl = listBuiltins().find((b) => b.builtinId === id);
  if (!impl) return undefined;
  return {
    id: `builtin:${impl.builtinId}`,
    name: impl.builtinId,
    description: impl.description,
    target_feature: impl.target,
    kind: impl.kind,
    config: { builtin: impl.builtinId },
    schedule: null,
    enabled: true,
    auto_fix_enabled: false,
    severity_floor: impl.severity
  };
};

const main = async () => {
  let records: CheckRecord[];

  if (builtinId) {
    // Smoke-run a single built-in without needing a DB row — useful for CI.
    const rec = builtinAsRecord(builtinId);
    if (!rec) {
      log(`No built-in check with id "${builtinId}". Available:`, {
        builtins: listBuiltins().map((b) => b.builtinId)
      });
      process.exit(2);
    }
    records = [rec];
  } else if (onlyId) {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('verification_checks')
      .select('id, name, description, target_feature, kind, config, schedule, enabled, auto_fix_enabled, severity_floor')
      .eq('id', onlyId)
      .single();
    if (error || !data) {
      log(`No check found with id ${onlyId}`, { error: error?.message });
      process.exit(2);
    }
    records = [data as unknown as CheckRecord];
  } else {
    records = await loadChecks();
    if (records.length === 0) {
      log('No enabled checks in verification_checks. Smoke-running all built-ins.');
      records = listBuiltins().map((b) => builtinAsRecord(b.builtinId)!);
    }
  }

  const admin = getSupabaseAdmin();
  const summary: { id: string; name: string; status: string; findings: number; duplicates: number }[] = [];
  for (const record of records) {
    log(`▶ ${record.name}`);
    try {
      // Built-ins-without-a-DB-row branch — runner.ts expects a real id for run/findings
      // inserts, so we skip DB persistence in --builtin smoke mode and just execute.
      if (record.id.startsWith('builtin:')) {
        const impl = listBuiltins().find((b) => b.builtinId === record.config.builtin);
        if (!impl) continue;
        const findings = await impl.run(record, { admin, log });
        summary.push({
          id: record.id,
          name: record.name,
          status: findings.length ? 'failed' : 'passed',
          findings: findings.length,
          duplicates: 0
        });
        if (findings.length) log(`  ${findings.length} finding(s)`, { findings });
        continue;
      }
      const res = await runCheck(admin, record, { trigger: 'ci', onLog: (m, meta) => log(`  ${m}`, meta) });
      summary.push({ id: record.id, name: record.name, status: res.status, findings: res.findings, duplicates: res.duplicates });
    } catch (err) {
      summary.push({ id: record.id, name: record.name, status: 'error', findings: 0, duplicates: 0 });
      log(`  Errored: ${(err as Error).message}`);
    }
  }

  log('── verification summary ──', { summary });
  const anyFinding = summary.some((s) => s.status !== 'passed');
  if (isCheckMode && anyFinding) process.exit(1);
  process.exit(0);
};

main().catch((err) => {
  log(`fatal: ${(err as Error).message}`, { stack: (err as Error).stack });
  process.exit(2);
});
