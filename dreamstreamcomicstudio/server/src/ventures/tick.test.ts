import { describe, it, expect } from 'vitest';
import { runTick, selectNextGoal, type TickGoal, type TickIO, type TickEmit } from './tick.js';
import type { CheckpointKind } from './checkpoints.js';
import type { VenturePauseReason } from './repository.js';
import type { VentureBudget, VentureSpendSnapshot, ProposedSpend } from './budget.js';

interface FakeState {
  gate: { enabled: boolean; killed: boolean };
  goals: TickGoal[];
  budget: { budget: VentureBudget; spend: VentureSpendSnapshot } | null;
  approvals: Set<CheckpointKind>;
  failures: Map<string, number>;
  actResult: { ok: boolean; error?: string; costUsd?: number };
  events: TickEmit[];
  spends: ProposedSpend[];
  pauses: VenturePauseReason[];
  checkpoints: Array<{ kind: CheckpointKind; goalId?: string }>;
}

const zeroSpend: VentureSpendSnapshot = { usdToday: 0, usdTotal: 0, tokensUsed: 0, containerMinutesUsed: 0 };

const makeIO = (overrides: Partial<FakeState> = {}): { io: TickIO; state: FakeState } => {
  const state: FakeState = {
    gate: { enabled: true, killed: false },
    goals: [{ id: 'g1', status: 'proposed', priority: 100 }],
    budget: { budget: { usdPerDay: 5, usdTotal: 50 }, spend: zeroSpend },
    approvals: new Set<CheckpointKind>(),
    failures: new Map<string, number>(),
    actResult: { ok: true, costUsd: 0.01 },
    events: [],
    spends: [],
    pauses: [],
    checkpoints: [],
    ...overrides
  };
  const io: TickIO = {
    gate: () => state.gate,
    loadGoals: async () => state.goals,
    loadBudgetState: async () => state.budget,
    isCheckpointApproved: async (k) => state.approvals.has(k),
    estimateSpend: () => ({ usd: 0.01 }),
    act: async () => state.actResult,
    markGoal: async (goalId, status) => {
      const g = state.goals.find((x) => x.id === goalId);
      if (g) g.status = status;
    },
    recordFailure: async (goalId) => {
      const n = (state.failures.get(goalId) || 0) + 1;
      state.failures.set(goalId, n);
      return n;
    },
    recordSpend: async (spend) => {
      state.spends.push(spend);
    },
    raiseCheckpoint: async (kind, _title, goalId) => {
      state.checkpoints.push({ kind, goalId });
    },
    pauseVenture: async (reason) => {
      state.pauses.push(reason);
    },
    emit: async (ev) => {
      state.events.push(ev);
    }
  };
  return { io, state };
};

const kinds = (s: FakeState) => s.events.map((e) => e.kind);

describe('selectNextGoal', () => {
  it('picks the lowest-priority actionable goal', () => {
    const goals: TickGoal[] = [
      { id: 'b', status: 'proposed', priority: 50 },
      { id: 'a', status: 'queued', priority: 10 },
      { id: 'done', status: 'shipped', priority: 1 }
    ];
    expect(selectNextGoal(goals)?.id).toBe('a');
  });
  it('ignores non-actionable goals', () => {
    expect(selectNextGoal([{ id: 'x', status: 'shipped', priority: 1 }])).toBeNull();
    expect(selectNextGoal([{ id: 'x', status: 'blocked', priority: 1 }])).toBeNull();
  });
});

describe('runTick', () => {
  it('advances a goal to shipped and records spend', async () => {
    const { io, state } = makeIO();
    const r = await runTick(io);
    expect(r.outcome).toBe('advanced');
    expect(state.goals[0].status).toBe('shipped');
    expect(state.spends).toHaveLength(1);
    expect(kinds(state)).toContain('goal.shipped');
  });

  it('halts when the kill switch is engaged', async () => {
    const { io, state } = makeIO({ gate: { enabled: true, killed: true } });
    const r = await runTick(io);
    expect(r.outcome).toBe('halted');
    expect(state.goals[0].status).toBe('proposed'); // untouched
  });

  it('returns no-goal when the backlog is empty/done', async () => {
    const { io } = makeIO({ goals: [{ id: 'g1', status: 'shipped', priority: 1 }] });
    expect((await runTick(io)).outcome).toBe('no-goal');
  });

  it('pauses on a budget breach before acting', async () => {
    const { io, state } = makeIO({
      budget: { budget: { usdPerDay: 5, usdTotal: 50 }, spend: { ...zeroSpend, usdToday: 4.999 } }
    });
    const r = await runTick(io);
    expect(r.outcome).toBe('budget');
    expect(state.pauses).toContain('budget');
    expect(state.spends).toHaveLength(0); // never spent
    expect(state.goals[0].status).toBe('proposed'); // not shipped
  });

  it('gates a production deploy until approved, then proceeds', async () => {
    const { io, state } = makeIO({ goals: [{ id: 'g1', status: 'proposed', priority: 1, action: 'deploy_production' }] });
    const gated = await runTick(io);
    expect(gated.outcome).toBe('gated');
    expect(state.checkpoints[0]?.kind).toBe('prod_deploy');
    expect(state.goals[0].status).toBe('proposed'); // still selectable

    state.approvals.add('prod_deploy');
    const after = await runTick(io);
    expect(after.outcome).toBe('advanced');
    expect(state.goals[0].status).toBe('shipped');
  });

  it('detects no-progress and pauses as stuck after repeated failures', async () => {
    const { io, state } = makeIO({ actResult: { ok: false, error: 'build failed' } });
    const first = await runTick(io, { maxAttemptsPerGoal: 2 });
    expect(first.outcome).toBe('advanced'); // retry
    expect(state.goals[0].status).toBe('queued');

    const second = await runTick(io, { maxAttemptsPerGoal: 2 });
    expect(second.outcome).toBe('stuck');
    expect(state.goals[0].status).toBe('blocked');
    expect(state.pauses).toContain('stuck');
  });

  it('emits a tick.started then goal.selected trace', async () => {
    const { io, state } = makeIO();
    await runTick(io);
    expect(kinds(state)[0]).toBe('tick.started');
    expect(kinds(state)).toContain('goal.selected');
  });
});
