// Durable persistence for Autopilot ventures (Supabase). Epic A1 control-plane backbone.
// Mirrors services/studioRepository.ts: writes use the service role (bypasses RLS) and EVERY
// query is scoped to userId so a venture can never be read or mutated across tenants.
// The pure governance logic (budget/checkpoints/events) lives in the sibling modules; this
// module only persists + retrieves. Tables come from server/sql/ventures_foundation.sql.

import { getSupabaseAdmin } from '../services/supabase.js';
import {
  VENTURES_DEFAULT_USD_PER_DAY,
  VENTURES_DEFAULT_USD_TOTAL
} from '../config.js';
import type { VentureBudget, VentureSpendSnapshot } from './budget.js';
import {
  resolveCheckpoint,
  type CheckpointKind,
  type CheckpointResolution,
  type CheckpointStatus
} from './checkpoints.js';
import { buildVentureEvent, type VentureEventInput } from './events.js';

export type VentureStatus = 'draft' | 'roadmap_pending' | 'active' | 'paused' | 'archived';
export type VenturePauseReason = 'budget' | 'checkpoint' | 'kill' | 'stuck' | 'manual';

export interface VentureRow {
  id: string;
  name: string;
  summary: string | null;
  scope: string | null;
  status: VentureStatus;
  pauseReason: VenturePauseReason | null;
  deployUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------------------
// Ventures
// ---------------------------------------------------------------------------------------
export const createVenture = async (input: {
  userId: string;
  name: string;
  summary?: string;
  scope?: string;
}): Promise<{ id: string }> => {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('ventures')
    .insert({
      user_id: input.userId,
      name: input.name,
      summary: input.summary ?? null,
      scope: input.scope ?? null,
      status: 'draft'
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`createVenture failed: ${error?.message || 'no row'}`);
  return { id: data.id };
};

const mapVenture = (v: any): VentureRow => ({
  id: v.id,
  name: v.name,
  summary: v.summary ?? null,
  scope: v.scope ?? null,
  status: v.status,
  pauseReason: v.pause_reason ?? null,
  deployUrl: v.deploy_url ?? null,
  createdAt: v.created_at,
  updatedAt: v.updated_at
});

export const getVenture = async (userId: string, ventureId: string): Promise<VentureRow | null> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('ventures')
    .select('id, name, summary, scope, status, pause_reason, deploy_url, created_at, updated_at')
    .eq('id', ventureId)
    .eq('user_id', userId)
    .maybeSingle();
  return data ? mapVenture(data) : null;
};

export const listVentures = async (userId: string): Promise<VentureRow[]> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('ventures')
    .select('id, name, summary, scope, status, pause_reason, deploy_url, created_at, updated_at')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(100);
  return (data || []).map(mapVenture);
};

export const setVentureStatus = async (
  userId: string,
  ventureId: string,
  status: VentureStatus,
  pauseReason: VenturePauseReason | null = null
): Promise<boolean> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('ventures')
    .update({ status, pause_reason: pauseReason, updated_at: new Date().toISOString() })
    .eq('id', ventureId)
    .eq('user_id', userId)
    .select('id');
  return Array.isArray(data) && data.length > 0;
};

// ---------------------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------------------
export interface VentureBudgetState {
  budget: VentureBudget;
  spend: VentureSpendSnapshot;
}

const mapBudget = (b: any): VentureBudgetState => ({
  budget: {
    usdPerDay: b.usd_per_day,
    usdTotal: b.usd_total,
    maxTokens: b.max_tokens,
    maxContainerMinutes: b.max_container_minutes
  },
  spend: {
    usdToday: Number(b.spent_usd_today) || 0,
    usdTotal: Number(b.spent_usd_total) || 0,
    tokensUsed: Number(b.tokens_used) || 0,
    containerMinutesUsed: Number(b.container_minutes_used) || 0
  }
});

/** Read a venture's budget + running spend; null if no budget row exists yet. */
export const getBudget = async (userId: string, ventureId: string): Promise<VentureBudgetState | null> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('venture_budgets')
    .select(
      'usd_per_day, usd_total, max_tokens, max_container_minutes, spent_usd_today, spent_usd_total, tokens_used, container_minutes_used, day_anchor'
    )
    .eq('venture_id', ventureId)
    .eq('user_id', userId)
    .maybeSingle();
  return data ? mapBudget(data) : null;
};

/** Set (create or replace) a venture's budget caps. Uses defaults when a cap is omitted. */
export const upsertBudget = async (input: {
  userId: string;
  ventureId: string;
  usdPerDay?: number | null;
  usdTotal?: number | null;
  maxTokens?: number | null;
  maxContainerMinutes?: number | null;
}): Promise<void> => {
  const admin = getSupabaseAdmin();
  await admin.from('venture_budgets').upsert(
    {
      venture_id: input.ventureId,
      user_id: input.userId,
      usd_per_day: input.usdPerDay === undefined ? VENTURES_DEFAULT_USD_PER_DAY : input.usdPerDay,
      usd_total: input.usdTotal === undefined ? VENTURES_DEFAULT_USD_TOTAL : input.usdTotal,
      max_tokens: input.maxTokens ?? null,
      max_container_minutes: input.maxContainerMinutes ?? null,
      updated_at: new Date().toISOString()
    },
    { onConflict: 'venture_id' }
  );
};

/**
 * Increment running spend after an action (the REFLECT step). Resets the daily counter when
 * the day rolls over. Read-modify-write; F2 will add optimistic-concurrency hardening.
 */
export const recordSpend = async (input: {
  userId: string;
  ventureId: string;
  usd?: number;
  tokens?: number;
  containerMinutes?: number;
}): Promise<void> => {
  // Atomic increment (F2): a single UPDATE via the increment_venture_spend function avoids the
  // read-modify-write race where two concurrent ticks lose a spend update. Daily reset is inline.
  const admin = getSupabaseAdmin();
  await admin.rpc('increment_venture_spend', {
    p_venture_id: input.ventureId,
    p_user_id: input.userId,
    p_usd: Math.max(0, input.usd ?? 0),
    p_tokens: Math.max(0, input.tokens ?? 0),
    p_minutes: Math.max(0, input.containerMinutes ?? 0)
  });
};

// ---------------------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------------------
export interface CheckpointRow {
  id: string;
  ventureId: string;
  kind: CheckpointKind;
  status: CheckpointStatus;
  title: string;
  detail: string | null;
  goalId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

const mapCheckpoint = (c: any): CheckpointRow => ({
  id: c.id,
  ventureId: c.venture_id,
  kind: c.kind,
  status: c.status,
  title: c.title,
  detail: c.detail ?? null,
  goalId: c.goal_id ?? null,
  createdAt: c.created_at,
  resolvedAt: c.resolved_at ?? null
});

export const createCheckpoint = async (input: {
  userId: string;
  ventureId: string;
  kind: CheckpointKind;
  title: string;
  detail?: string;
  goalId?: string;
  expiresAt?: string;
}): Promise<{ id: string }> => {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('venture_checkpoints')
    .insert({
      venture_id: input.ventureId,
      user_id: input.userId,
      kind: input.kind,
      status: 'open',
      title: input.title,
      detail: input.detail ?? null,
      goal_id: input.goalId ?? null,
      expires_at: input.expiresAt ?? null
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`createCheckpoint failed: ${error?.message || 'no row'}`);
  return { id: data.id };
};

export const listOpenCheckpoints = async (userId: string, ventureId?: string): Promise<CheckpointRow[]> => {
  const admin = getSupabaseAdmin();
  let q = admin
    .from('venture_checkpoints')
    .select('id, venture_id, kind, status, title, detail, goal_id, created_at, resolved_at')
    .eq('user_id', userId)
    .eq('status', 'open');
  if (ventureId) q = q.eq('venture_id', ventureId);
  const { data } = await q.order('created_at', { ascending: false }).limit(100);
  return (data || []).map(mapCheckpoint);
};

/** Is there an approved checkpoint of this kind for the venture? Feeds the DECIDE gate. */
export const isCheckpointApproved = async (
  userId: string,
  ventureId: string,
  kind: CheckpointKind
): Promise<boolean> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('venture_checkpoints')
    .select('id')
    .eq('user_id', userId)
    .eq('venture_id', ventureId)
    .eq('kind', kind)
    .eq('status', 'approved')
    .limit(1);
  return Array.isArray(data) && data.length > 0;
};

/**
 * Resolve an open checkpoint (approve/deny/expire). Validates the transition with the pure
 * resolveCheckpoint() before persisting. Returns false if not found or already resolved.
 */
export const resolveCheckpointRow = async (
  userId: string,
  checkpointId: string,
  resolution: CheckpointResolution
): Promise<boolean> => {
  const admin = getSupabaseAdmin();
  const { data: current } = await admin
    .from('venture_checkpoints')
    .select('status')
    .eq('id', checkpointId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!current) return false;

  let resolved;
  try {
    resolved = resolveCheckpoint(current.status as CheckpointStatus, resolution);
  } catch {
    return false; // invalid transition (already resolved)
  }

  const { data } = await admin
    .from('venture_checkpoints')
    .update({
      status: resolved.status,
      resolved_by: resolved.resolvedBy,
      resolved_at: resolved.resolvedAt
    })
    .eq('id', checkpointId)
    .eq('user_id', userId)
    .eq('status', 'open') // guard against a concurrent resolve
    .select('id');
  return Array.isArray(data) && data.length > 0;
};

// ---------------------------------------------------------------------------------------
// Events (append-only audit trail)
// ---------------------------------------------------------------------------------------
export const appendEvent = async (input: VentureEventInput): Promise<void> => {
  const admin = getSupabaseAdmin();
  const record = buildVentureEvent(input);
  await admin.from('venture_events').insert(record);
};

export interface VentureEventRow {
  id: string;
  kind: string;
  level: string;
  message: string | null;
  data: Record<string, unknown> | null;
  costUsd: number | null;
  model: string | null;
  source: string;
  createdAt: string;
}

export const listEvents = async (
  userId: string,
  ventureId: string,
  limit = 100
): Promise<VentureEventRow[]> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('venture_events')
    .select('id, kind, level, message, data, cost_usd, model, source, created_at')
    .eq('user_id', userId)
    .eq('venture_id', ventureId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(1, limit), 500));
  return (data || []).map((e: any) => ({
    id: e.id,
    kind: e.kind,
    level: e.level,
    message: e.message ?? null,
    data: e.data ?? null,
    costUsd: e.cost_usd ?? null,
    model: e.model ?? null,
    source: e.source,
    createdAt: e.created_at
  }));
};
