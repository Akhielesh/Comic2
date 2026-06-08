// Platform audit-log writer (Epic F0). Append-only record of sensitive admin/security actions.
// buildAuditRecord is pure (unit-tested); recordAudit is best-effort (it must NEVER throw or
// block the action it's auditing). Reads happen only via a trusted admin (service-role) path.

import { getSupabaseAdmin } from '../services/supabase.js';

export interface AuditInput {
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
  at?: string;
}

export interface AuditRecord {
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: Record<string, unknown> | null;
  created_at: string;
}

export const buildAuditRecord = (input: AuditInput): AuditRecord => ({
  actor_id: input.actorId ?? null,
  action: input.action,
  target_type: input.targetType ?? null,
  target_id: input.targetId ?? null,
  detail: input.detail ?? null,
  created_at: input.at ?? new Date().toISOString()
});

/** Best-effort append — swallows all errors so auditing never breaks the audited action. */
export const recordAudit = async (input: AuditInput): Promise<void> => {
  try {
    await getSupabaseAdmin().from('audit_log').insert(buildAuditRecord(input));
  } catch {
    /* best-effort */
  }
};

/** Recent audit rows (admin/service-role read). */
export const listAudit = async (limit = 100): Promise<AuditRecord[]> => {
  try {
    const { data } = await getSupabaseAdmin()
      .from('audit_log')
      .select('actor_id, action, target_type, target_id, detail, created_at')
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(1, limit), 500));
    return (data || []) as AuditRecord[];
  } catch {
    return [];
  }
};
