// Repository-backed adapter that runs one real tick for a venture. Epic A2 + A4.
// Maps the durable Supabase repository to the TickIO interface and calls the pure runTick.
// The ACT step now performs a REAL build (A4): it generates/iterates the venture's app via the
// existing studio generator (pure-LLM, no Cloudflare worker needed) using a platform model key,
// then saves it as a versioned studio_project linked to the venture. Deploy/run (worker) is A5.
// Everything is flag-gated upstream (VENTURES_ENABLED) and budget-checked by the DECIDE gate
// BEFORE this ACT runs, so a venture can never exceed its cap.

import { VENTURES_ENABLED, VENTURES_BUILD_COST_ESTIMATE_USD } from '../config.js';
import { getKillSwitch } from './killSwitch.js';
import { runTick, type TickGoal, type TickIO, type TickResult } from './tick.js';
import {
  appendEvent,
  createCheckpoint,
  getBudget,
  getVenture,
  isCheckpointApproved,
  recordSpend,
  setVentureStatus
} from './repository.js';
import { listGoals, updateGoal, linkProjectToVenture } from './controlPlane.js';
import { classifyGoalAction } from './goalAction.js';
import { getPlatformComplete } from './platformComplete.js';
import { buildGoalGenerateInput } from './build.js';
import { runGenerate } from '../ai/studio/studioGenerate.js';
import { getProjectWithFiles, saveProject } from '../services/studioRepository.js';

// In-process per-goal attempt counter for no-progress detection. A4 keeps this lightweight;
// F5 will persist attempts durably on the goal/run.
const attemptCounts = new Map<string, number>();

export const runVentureTick = async (userId: string, ventureId: string): Promise<TickResult> => {
  const io: TickIO = {
    gate: () => ({ enabled: VENTURES_ENABLED, killed: getKillSwitch() }),

    loadGoals: async (): Promise<TickGoal[]> =>
      (await listGoals(userId, ventureId)).map((g) => ({
        id: g.id,
        status: g.status,
        priority: g.priority,
        title: g.title,
        detail: g.detail,
        // Classify so risky actions (prod deploy, destructive, publish) route through a checkpoint.
        action: classifyGoalAction({ title: g.title, detail: g.detail ?? undefined, kind: g.kind })
      })),

    loadBudgetState: async () => {
      const b = await getBudget(userId, ventureId);
      return b ? { budget: b.budget, spend: b.spend } : null;
    },

    isCheckpointApproved: (kind) => isCheckpointApproved(userId, ventureId, kind),

    estimateSpend: () => ({ usd: VENTURES_BUILD_COST_ESTIMATE_USD }),

    // ACT — real pure-LLM build (A4). Generate/iterate the venture's app for this goal and
    // persist it as a versioned project. Returns ok=false on any failure (→ retry / stuck).
    act: async (goal) => {
      const pc = await getPlatformComplete(4000);
      if (!pc) {
        return { ok: false, error: 'No platform model key configured (set OPENROUTER_API_KEY or NVIDIA_API_KEY).' };
      }
      const venture = await getVenture(userId, ventureId);
      const projectId = `v_${ventureId}`;
      const existing = await getProjectWithFiles(userId, projectId);
      const input = buildGoalGenerateInput(
        {
          ventureName: venture?.name,
          ventureSummary: venture?.summary ?? null,
          ventureScope: venture?.scope ?? null,
          goalTitle: goal.title || 'Build the next increment',
          goalDetail: goal.detail ?? null
        },
        existing?.files?.map((f) => ({ path: f.path, content: f.content }))
      );
      const artifact = await runGenerate(pc.complete, input);
      if (!artifact || !artifact.files.length) {
        return { ok: false, error: 'The build produced no usable files.' };
      }
      await saveProject({
        userId,
        projectId,
        name: venture?.name || artifact.title,
        template: artifact.template,
        files: artifact.files.map((f) => ({ path: f.path, content: f.content, language: f.language })),
        versionLabel: `goal: ${(goal.title || '').slice(0, 60)}`,
        createdBy: 'agent'
      });
      await linkProjectToVenture(userId, projectId, ventureId).catch(() => {});
      await updateGoal(userId, goal.id, { projectId });
      return { ok: true, costUsd: VENTURES_BUILD_COST_ESTIMATE_USD };
    },

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
