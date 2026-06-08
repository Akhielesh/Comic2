// Repository-backed adapter that runs one real tick for a venture. Epic A2.
// Maps the durable Supabase repository to the TickIO interface and calls the pure runTick.
// The ACT step is a STUB here (always succeeds, zero cost) so we can prove the governed loop
// end-to-end against the real DB WITHOUT building/deploying anything; A4 replaces stubAct with
// the real build engine. Driven by the scheduler/worker (added next). Flag-gated upstream.

import { VENTURES_ENABLED } from '../config.js';
import { getKillSwitch } from './killSwitch.js';
import { runTick, type TickGoal, type TickIO, type TickResult } from './tick.js';
import {
  appendEvent,
  createCheckpoint,
  getBudget,
  isCheckpointApproved,
  recordSpend,
  setVentureStatus
} from './repository.js';
import { listGoals, updateGoal } from './controlPlane.js';

// In-process per-goal attempt counter for no-progress detection. The ACT stub never fails in
// A2, so this is effectively dormant; A4 will persist attempts durably on the goal/run.
const attemptCounts = new Map<string, number>();

export const runVentureTick = async (userId: string, ventureId: string): Promise<TickResult> => {
  const io: TickIO = {
    gate: () => ({ enabled: VENTURES_ENABLED, killed: getKillSwitch() }),

    loadGoals: async (): Promise<TickGoal[]> =>
      (await listGoals(userId, ventureId)).map((g) => ({
        id: g.id,
        status: g.status,
        priority: g.priority
        // action defaults to 'run_build' (no checkpoint); A4/A5 derive deploy actions.
      })),

    loadBudgetState: async () => {
      const b = await getBudget(userId, ventureId);
      return b ? { budget: b.budget, spend: b.spend } : null;
    },

    isCheckpointApproved: (kind) => isCheckpointApproved(userId, ventureId, kind),

    estimateSpend: () => ({ usd: 0 }), // A2 stub estimate; A4 estimates real token/compute cost

    act: async () => ({ ok: true, costUsd: 0 }), // STUB — A4 wires the real build loop

    markGoal: async (goalId, status) => {
      await updateGoal(userId, goalId, { status });
    },

    recordFailure: async (goalId) => {
      const n = (attemptCounts.get(goalId) || 0) + 1;
      attemptCounts.set(goalId, n);
      return n;
    },

    recordSpend: async (spend) => {
      await recordSpend({
        userId,
        ventureId,
        usd: spend.usd,
        tokens: spend.tokens,
        containerMinutes: spend.containerMinutes
      });
    },

    raiseCheckpoint: async (kind, title, goalId) => {
      await createCheckpoint({ userId, ventureId, kind, title, goalId });
    },

    pauseVenture: async (reason) => {
      await setVentureStatus(userId, ventureId, 'paused', reason);
    },

    emit: async (ev) => {
      await appendEvent({
        ventureId,
        userId,
        kind: ev.kind,
        level: ev.level,
        message: ev.message,
        costUsd: ev.costUsd,
        data: ev.goalId ? { goalId: ev.goalId } : undefined,
        source: 'engine'
      });
    }
  };

  return runTick(io);
};
