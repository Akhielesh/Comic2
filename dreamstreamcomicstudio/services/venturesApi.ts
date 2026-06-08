// Client for the Autopilot control plane (/api/ventures/*). Epic A8.
// Mirrors services/studioApi.ts. The whole surface is flag-gated + admin-only on the server
// until GA; calls throw ApiError with code VENTURES_DISABLED when the caller can't use it yet.

import { get, post, put, patch } from './apiClient';

export type VentureStatus = 'draft' | 'roadmap_pending' | 'active' | 'paused' | 'archived';

export interface Venture {
  id: string;
  name: string;
  summary: string | null;
  scope: string | null;
  status: VentureStatus;
  pauseReason: string | null;
  deployUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BudgetState {
  budget: {
    usdPerDay?: number | null;
    usdTotal?: number | null;
    maxTokens?: number | null;
    maxContainerMinutes?: number | null;
  };
  spend: { usdToday: number; usdTotal: number; tokensUsed: number; containerMinutesUsed: number };
}

export interface Checkpoint {
  id: string;
  ventureId: string;
  kind: string;
  status: string;
  title: string;
  detail: string | null;
  goalId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface Goal {
  id: string;
  ventureId: string;
  title: string;
  detail: string | null;
  kind: string;
  status: string;
  priority: number;
  projectId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VentureEvent {
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

export interface RoadmapDraft {
  name: string;
  summary: string;
  scope: string;
  goals: Array<{ title: string; detail?: string; kind: string; priority: number }>;
}

export interface VentureDetail {
  venture: Venture;
  budget: BudgetState | null;
  budgetAlert: 'ok' | 'warn' | 'exceeded';
  openCheckpoints: Checkpoint[];
}

export const listVentures = async (): Promise<Venture[]> =>
  (await get<{ ventures: Venture[] }>('/api/ventures')).ventures;

export const getVenture = async (id: string): Promise<VentureDetail> =>
  get<VentureDetail>(`/api/ventures/${encodeURIComponent(id)}`);

/** Draft a venture from an idea (creates a draft venture + roadmap + approval checkpoint). */
export const createIntake = async (
  idea: string,
  opts?: { source?: string; model?: string; costPref?: string }
): Promise<{ id: string; roadmap: RoadmapDraft }> =>
  post<{ idea: string; source?: string; model?: string; costPref?: string }, { id: string; roadmap: RoadmapDraft }>(
    '/api/ventures/intake',
    { idea, ...opts }
  );

export const approveRoadmap = async (id: string): Promise<{ ok: boolean; status: string; approved: number }> =>
  post<Record<string, never>, { ok: boolean; status: string; approved: number }>(
    `/api/ventures/${encodeURIComponent(id)}/approve-roadmap`,
    {}
  );

export const setVentureStatus = async (
  id: string,
  status: 'active' | 'paused' | 'archived'
): Promise<{ ok: boolean; status: string }> =>
  patch<{ status: string }, { ok: boolean; status: string }>(`/api/ventures/${encodeURIComponent(id)}/status`, { status });

export const listGoals = async (id: string): Promise<Goal[]> =>
  (await get<{ goals: Goal[] }>(`/api/ventures/${encodeURIComponent(id)}/goals`)).goals;

export const createGoal = async (
  id: string,
  goal: { title: string; detail?: string; kind?: string; priority?: number }
): Promise<{ id: string }> =>
  post<typeof goal, { id: string }>(`/api/ventures/${encodeURIComponent(id)}/goals`, goal);

export const putBudget = async (
  id: string,
  budget: { usdPerDay?: number | null; usdTotal?: number | null; maxTokens?: number | null; maxContainerMinutes?: number | null }
): Promise<{ ok: boolean }> =>
  put<typeof budget, { ok: boolean }>(`/api/ventures/${encodeURIComponent(id)}/budget`, budget);

export const listCheckpoints = async (id: string): Promise<Checkpoint[]> =>
  (await get<{ checkpoints: Checkpoint[] }>(`/api/ventures/${encodeURIComponent(id)}/checkpoints`)).checkpoints;

export const resolveCheckpoint = async (
  id: string,
  checkpointId: string,
  decision: 'approve' | 'deny'
): Promise<{ ok: boolean; status: string }> =>
  post<{ decision: string }, { ok: boolean; status: string }>(
    `/api/ventures/${encodeURIComponent(id)}/checkpoints/${encodeURIComponent(checkpointId)}/resolve`,
    { decision }
  );

export const listEvents = async (id: string, limit = 100): Promise<VentureEvent[]> =>
  (await get<{ events: VentureEvent[] }>(`/api/ventures/${encodeURIComponent(id)}/events?limit=${limit}`)).events;

export const getKillSwitch = async (): Promise<boolean> =>
  (await get<{ killed: boolean }>('/api/ventures/admin/kill')).killed;

export const setKillSwitch = async (on: boolean): Promise<boolean> =>
  (await post<{ on: boolean }, { killed: boolean }>('/api/ventures/admin/kill', { on })).killed;
