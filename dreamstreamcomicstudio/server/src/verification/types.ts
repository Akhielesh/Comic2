// Verification system — core types.

import type { SupabaseClient } from '@supabase/supabase-js';

export type Severity = 'low' | 'med' | 'high' | 'critical';

export type CheckKind = 'deterministic' | 'ai_council';

export type TargetFeature =
  | 'pricing'
  | 'free_labeling'
  | 'autorouter'
  | 'cost_reconciliation'
  | 'pricing_freshness'
  | 'capability_tags'
  | 'continuity'
  | 'moderation'
  | 'multi_provider_cost'
  | 'custom';

export interface CheckRecord {
  id: string;
  name: string;
  description?: string;
  target_feature: TargetFeature;
  kind: CheckKind;
  config: Record<string, unknown>;
  schedule?: string | null;
  enabled: boolean;
  auto_fix_enabled: boolean;
  severity_floor: Severity;
}

/** What a check returns from its run() — one or more findings (none = passed). */
export interface RawFinding {
  /** Deterministic key so duplicate findings dedupe via verification_findings.fingerprint. */
  fingerprint: string;
  title: string;
  detail: Record<string, unknown>;
  severity: Severity;
  /** 0..1 — checks are deterministic (1) or council-weighted. */
  confidence: number;
  council_votes?: Record<string, unknown>;
}

export interface CheckContext {
  /** Service-role Supabase client (full access, used for runs/findings + reads of live data). */
  admin: SupabaseClient;
  /** Server base URL (for checks that hit /api/* — e.g. invariant probes). */
  baseUrl?: string;
  /** Logger that writes to stdout / the runs.summary log. */
  log: (message: string, meta?: Record<string, unknown>) => void;
}

export interface CheckImpl {
  /** Stable id matching the verification_checks.config.builtin field for built-ins. */
  builtinId: string;
  /** Human description shown in the dashboard. */
  description: string;
  kind: CheckKind;
  target: TargetFeature;
  /** Default severity floor for auto-fix. */
  severity: Severity;
  run: (record: CheckRecord, ctx: CheckContext) => Promise<RawFinding[]>;
}
