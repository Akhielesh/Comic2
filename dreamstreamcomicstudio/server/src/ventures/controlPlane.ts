// A1 control-plane persistence: goals (backlog/roadmap), runs (loop sessions), and
// connections (BYO provider accounts). Same conventions as repository.ts — service-role
// writes, every query scoped by user_id. Tables: server/sql/ventures_control_plane.sql.

import { getSupabaseAdmin } from '../services/supabase.js';

// ---------------------------------------------------------------------------------------
// Goals (backlog / roadmap)
// ---------------------------------------------------------------------------------------
export type GoalKind = 'epic' | 'feature' | 'task' | 'fix' | 'chore';
export type GoalStatus = 'proposed' | 'queued' | 'in_progress' | 'verifying' | 'shipped' | 'failed' | 'blocked';

export interface GoalRow {
  id: string;
  ventureId: string;
  title: string;
  detail: string | null;
  kind: GoalKind;
  status: GoalStatus;
  priority: number;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

const mapGoal = (g: any): GoalRow => ({
  id: g.id,
  ventureId: g.venture_id,
  title: g.title,
  detail: g.detail ?? null,
  kind: g.kind,
  status: g.status,
  priority: g.priority,
  projectId: g.project_id ?? null,
  createdAt: g.created_at,
  updatedAt: g.updated_at
});

export const createGoal = async (input: {
  userId: string;
  ventureId: string;
  title: string;
  detail?: string;
  kind?: GoalKind;
  priority?: number;
}): Promise<{ id: string }> => {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('venture_goals')
    .insert({
      venture_id: input.ventureId,
      user_id: input.userId,
      title: input.title,
      detail: input.detail ?? null,
      kind: input.kind ?? 'feature',
      status: 'proposed',
      priority: input.priority ?? 100
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`createGoal failed: ${error?.message || 'no row'}`);
  return { id: data.id };
};

/** Bulk-insert a roadmap of goals (intake → roadmap). Returns inserted ids in order. */
export const createGoals = async (input: {
  userId: string;
  ventureId: string;
  goals: Array<{ title: string; detail?: string; kind?: GoalKind; priority?: number }>;
}): Promise<string[]> => {
  if (!input.goals.length) return [];
  const admin = getSupabaseAdmin();
  const rows = input.goals.map((g, i) => ({
    venture_id: input.ventureId,
    user_id: input.userId,
    title: g.title,
    detail: g.detail ?? null,
    kind: g.kind ?? 'feature',
    status: 'proposed',
    priority: g.priority ?? 100 + i
  }));
  const { data, error } = await admin.from('venture_goals').insert(rows).select('id');
  if (error) throw new Error(`createGoals failed: ${error.message}`);
  return (data || []).map((d: any) => d.id);
};

export const listGoals = async (
  userId: string,
  ventureId: string,
  status?: GoalStatus
): Promise<GoalRow[]> => {
  const admin = getSupabaseAdmin();
  let q = admin
    .from('venture_goals')
    .select('id, venture_id, title, detail, kind, status, priority, project_id, created_at, updated_at')
    .eq('user_id', userId)
    .eq('venture_id', ventureId);
  if (status) q = q.eq('status', status);
  const { data } = await q.order('priority', { ascending: true }).order('created_at', { ascending: true }).limit(500);
  return (data || []).map(mapGoal);
};

export const updateGoal = async (
  userId: string,
  goalId: string,
  patch: { status?: GoalStatus; priority?: number; projectId?: string; result?: Record<string, unknown> }
): Promise<boolean> => {
  const admin = getSupabaseAdmin();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.status !== undefined) update.status = patch.status;
  if (patch.priority !== undefined) update.priority = patch.priority;
  if (patch.projectId !== undefined) update.project_id = patch.projectId;
  if (patch.result !== undefined) update.result = patch.result;
  const { data } = await admin
    .from('venture_goals')
    .update(update)
    .eq('id', goalId)
    .eq('user_id', userId)
    .select('id');
  return Array.isArray(data) && data.length > 0;
};

// ---------------------------------------------------------------------------------------
// Runs (one autonomous loop session)
// ---------------------------------------------------------------------------------------
export interface RunRow {
  id: string;
  ventureId: string;
  status: string;
  ticks: number;
  costUsd: number;
  startedAt: string;
  endedAt: string | null;
}

const mapRun = (r: any): RunRow => ({
  id: r.id,
  ventureId: r.venture_id,
  status: r.status,
  ticks: r.ticks,
  costUsd: Number(r.cost_usd) || 0,
  startedAt: r.started_at,
  endedAt: r.ended_at ?? null
});

export const createRun = async (input: { userId: string; ventureId: string }): Promise<{ id: string }> => {
  const admin = getSupabaseAdmin();
  const { data, error } = await admin
    .from('venture_runs')
    .insert({ venture_id: input.ventureId, user_id: input.userId, status: 'running' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`createRun failed: ${error?.message || 'no row'}`);
  return { id: data.id };
};

export const endRun = async (
  userId: string,
  runId: string,
  status: 'completed' | 'failed' | 'paused',
  pauseReason?: string
): Promise<boolean> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('venture_runs')
    .update({ status, pause_reason: pauseReason ?? null, ended_at: new Date().toISOString() })
    .eq('id', runId)
    .eq('user_id', userId)
    .select('id');
  return Array.isArray(data) && data.length > 0;
};

export const getActiveRun = async (userId: string, ventureId: string): Promise<RunRow | null> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('venture_runs')
    .select('id, venture_id, status, ticks, cost_usd, started_at, ended_at')
    .eq('user_id', userId)
    .eq('venture_id', ventureId)
    .is('ended_at', null)
    .order('started_at', { ascending: false })
    .maybeSingle();
  return data ? mapRun(data) : null;
};

// ---------------------------------------------------------------------------------------
// Connections (BYO provider accounts — references only, never raw secrets)
// ---------------------------------------------------------------------------------------
export type ConnectionProvider = 'cloudflare' | 'vercel' | 'railway' | 'supabase' | 'github';

export interface ConnectionRow {
  id: string;
  ventureId: string;
  provider: ConnectionProvider;
  status: string;
  scopes: string | null;
  createdAt: string;
  updatedAt: string;
}

const mapConnection = (c: any): ConnectionRow => ({
  id: c.id,
  ventureId: c.venture_id,
  provider: c.provider,
  status: c.status,
  scopes: c.scopes ?? null,
  createdAt: c.created_at,
  updatedAt: c.updated_at
});

export const listConnections = async (userId: string, ventureId: string): Promise<ConnectionRow[]> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('venture_connections')
    .select('id, venture_id, provider, status, scopes, created_at, updated_at')
    .eq('user_id', userId)
    .eq('venture_id', ventureId)
    .order('provider', { ascending: true });
  return (data || []).map(mapConnection);
};

export const upsertConnection = async (input: {
  userId: string;
  ventureId: string;
  provider: ConnectionProvider;
  nangoConnectionId?: string;
  scopes?: string;
  status?: string;
}): Promise<void> => {
  const admin = getSupabaseAdmin();
  await admin.from('venture_connections').upsert(
    {
      venture_id: input.ventureId,
      user_id: input.userId,
      provider: input.provider,
      nango_connection_id: input.nangoConnectionId ?? null,
      scopes: input.scopes ?? null,
      status: input.status ?? 'connected',
      updated_at: new Date().toISOString()
    },
    { onConflict: 'venture_id,provider' }
  );
};

// ---------------------------------------------------------------------------------------
// Scheduler support: list ACTIVE ventures across all users (service-role, used by the
// worker to fan out ticks). Not user-scoped — only the trusted worker calls this.
// ---------------------------------------------------------------------------------------
export const listActiveVentures = async (limit = 100): Promise<Array<{ id: string; userId: string }>> => {
  const admin = getSupabaseAdmin();
  const { data } = await admin
    .from('ventures')
    .select('id, user_id')
    .eq('status', 'active')
    .order('updated_at', { ascending: true })
    .limit(limit);
  return (data || []).map((v: any) => ({ id: v.id, userId: v.user_id }));
};

/** Link a studio_project to a venture (additive — sets the nullable venture_id column). */
export const linkProjectToVenture = async (
  userId: string,
  projectId: string,
  ventureId: string
): Promise<void> => {
  const admin = getSupabaseAdmin();
  await admin.from('studio_projects').update({ venture_id: ventureId }).eq('id', projectId).eq('user_id', userId);
};
