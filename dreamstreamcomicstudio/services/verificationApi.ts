// Thin client for /api/admin/verification.

import { get, post } from './apiClient';
import { buildApiUrl } from './clientConfig';
import { supabase } from './supabase';

export type VerificationCheck = {
  id: string;
  name: string;
  description: string | null;
  target_feature: string;
  kind: 'deterministic' | 'ai_council';
  config: Record<string, unknown>;
  schedule: string | null;
  enabled: boolean;
  auto_fix_enabled: boolean;
  severity_floor: 'low' | 'med' | 'high' | 'critical';
  created_at: string;
  updated_at: string;
};

export type VerificationRun = {
  id: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  trigger: 'schedule' | 'manual' | 'ci' | 'webhook';
  summary: Record<string, unknown> | null;
  started_at: string;
  finished_at: string | null;
};

export type VerificationFinding = {
  id: string;
  run_id: string;
  check_id: string;
  fingerprint: string;
  title: string;
  detail: Record<string, unknown>;
  severity: 'low' | 'med' | 'high' | 'critical';
  confidence: number;
  council_votes: Record<string, unknown> | null;
  status: 'open' | 'confirmed' | 'dismissed' | 'fixing' | 'resolved' | 'wontfix';
  github_issue_number: number | null;
  github_pr_number: number | null;
  fix_attempts: number;
  created_at: string;
  resolved_at: string | null;
};

export type VerificationBuiltin = {
  id: string;
  description: string;
  kind: 'deterministic' | 'ai_council';
  target: string;
  severity: 'low' | 'med' | 'high' | 'critical';
};

export type VerificationHealth = {
  open_findings: number;
  critical_open: number;
  runs_last_24h: number;
};

export const fetchBuiltins = () =>
  get<{ builtins: VerificationBuiltin[] }>('/api/admin/verification/builtins');

export const fetchChecks = () =>
  get<{ checks: VerificationCheck[] }>('/api/admin/verification/checks');

export const createCheck = (input: {
  name: string;
  description?: string;
  target_feature: string;
  kind: 'deterministic' | 'ai_council';
  config: Record<string, unknown>;
  schedule?: string | null;
  enabled?: boolean;
  auto_fix_enabled?: boolean;
  severity_floor?: 'low' | 'med' | 'high' | 'critical';
}) => post<typeof input, { check: VerificationCheck }>('/api/admin/verification/checks', input);

export const patchCheck = async (id: string, patch: Partial<VerificationCheck>) => {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(buildApiUrl(`/api/admin/verification/checks/${id}`), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {})
    },
    body: JSON.stringify(patch)
  });
  if (!res.ok) throw new Error((await res.json())?.error?.message || `${res.status}`);
  return (await res.json()) as { check: VerificationCheck };
};

export const deleteCheck = async (id: string) => {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(buildApiUrl(`/api/admin/verification/checks/${id}`), {
    method: 'DELETE',
    headers: { ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {}) }
  });
  if (!res.ok) throw new Error((await res.json())?.error?.message || `${res.status}`);
  return (await res.json()) as { ok: boolean };
};

export const runCheckNow = (id: string) =>
  post<Record<string, never>, { result: { runId: string; status: string; findings: number; duplicates: number } }>(
    `/api/admin/verification/checks/${id}/run`,
    {}
  );

export const fetchRuns = (checkId: string, limit = 20) =>
  get<{ runs: VerificationRun[] }>(`/api/admin/verification/checks/${checkId}/runs?limit=${limit}`);

export const fetchFindings = (filters?: { status?: string; check_id?: string; severity?: string; limit?: number }) => {
  const qs = new URLSearchParams();
  if (filters?.status) qs.set('status', filters.status);
  if (filters?.check_id) qs.set('check_id', filters.check_id);
  if (filters?.severity) qs.set('severity', filters.severity);
  if (filters?.limit) qs.set('limit', String(filters.limit));
  const tail = qs.toString();
  return get<{ findings: VerificationFinding[] }>(`/api/admin/verification/findings${tail ? `?${tail}` : ''}`);
};

export const patchFinding = async (id: string, status: VerificationFinding['status']) => {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(buildApiUrl(`/api/admin/verification/findings/${id}`), {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...(session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {})
    },
    body: JSON.stringify({ status })
  });
  if (!res.ok) throw new Error((await res.json())?.error?.message || `${res.status}`);
  return (await res.json()) as { finding: VerificationFinding };
};

export const fetchHealth = () =>
  get<VerificationHealth>('/api/admin/verification/health');
