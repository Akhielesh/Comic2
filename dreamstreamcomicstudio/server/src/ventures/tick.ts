// The Autopilot tick — one governed pass of the loop (SENSE→ORIENT→DECIDE→ACT→VERIFY→SHIP→
// REFLECT). Epic A2. Written with dependency injection (TickIO) so the governed loop is fully
// unit-testable WITHOUT a DB/LLM/container: tests drive it with in-memory fakes to prove it
// advances a backlog and stops on kill/budget/checkpoint/stuck. The repository-backed adapter
// lives in tickRunner.ts; the scheduler that calls it lives in queue.ts/scheduler.ts.
//
// In A2 the ACT step is a STUB (io.act); A4 wires it to the real build engine. Nothing here
// builds or deploys anything yet — this proves the *governance + durability* first.

import {
  evaluateBudget, // re-exported convenience not needed here, kept implicit via decide
  type ProposedSpend,
  type VentureBudget,
  type VentureSpendSnapshot
} from './budget.js';
import { checkpointForAction, type CheckpointKind, type EngineAction } from './checkpoints.js';
import { decide } from './decide.js';
import { isVentureLoopAllowed, type LoopGateState } from './killSwitch.js';
import type { GoalStatus } from './controlPlane.js';
import type { VenturePauseReason } from './repository.js';
import type { VentureEventKind, VentureEventLevel } from './events.js';

void evaluateBudget; // referenced for documentation completeness; decide does the evaluation

export interface TickGoal {
  id: string;
  status: GoalStatus;
  priority: number;
  /** The engine action this goal performs; defaults to an in-sandbox build (no checkpoint). */
  action?: EngineAction;
  /** Optional goal text the ACT step uses to build (ignored by the pure decision logic). */
  title?: string;
  detail?: string | null;
}

export interface TickEmit {
  kind: VentureEventKind;
  level?: VentureEventLevel;
  message?: string;
  goalId?: string;
  costUsd?: number;
}

/** Everything a tick needs from the outside world. The repository adapter implements this. */
export interface TickIO {
  gate(): LoopGateState;
  loadGoals(): Promise<TickGoal[]>;
  loadBudgetState(): Promise<{ budget: VentureBudget; spend: VentureSpendSnapshot } | null>;
  isCheckpointApproved(kind: CheckpointKind): Promise<boolean>;
  /** Pre-action cost estimate for the chosen goal (checked against the budget before acting). */
  estimateSpend(goal: TickGoal): ProposedSpend;
  /** ACT — STUB in A2; the real build loop in A4. Returns ok + optional measured cost. */
  act(goal: TickGoal): Promise<{ ok: boolean; error?: string; costUsd?: number }>;
  markGoal(goalId: string, status: GoalStatus): Promise<void>;
  /** Record a failed attempt; returns the new attempt count for no-progress detection. */
  recordFailure(goalId: string): Promise<number>;
  recordSpend(spend: ProposedSpend): Promise<void>;
  raiseCheckpoint(kind: CheckpointKind, title: string, goalId?: string): Promise<void>;
  pauseVenture(reason: VenturePauseReason): Promise<void>;
  emit(ev: TickEmit): Promise<void>;
}

export interface TickOptions {
  /** Stop and pause as 'stuck' after this many consecutive failures on one goal. */
  maxAttemptsPerGoal?: number;
}

export type TickOutcome = 'halted' | 'no-goal' | 'gated' | 'budget' | 'stuck' | 'advanced';

export interface TickResult {
  outcome: TickOutcome;
  goalId?: string;
  reason?: string;
}

const ACTIONABLE: readonly GoalStatus[] = ['proposed', 'queued', 'in_progress'];
const ZERO_SPEND: VentureSpendSnapshot = { usdToday: 0, usdTotal: 0, tokensUsed: 0, containerMinutesUsed: 0 };

/** Pure: pick the highest-priority actionable goal (lowest priority number wins; stable). */
export const selectNextGoal = (goals: TickGoal[]): TickGoal | null => {
  const actionable = goals.filter((g) => ACTIONABLE.includes(g.status));
  if (actionable.length === 0) return null;
  return actionable.slice().sort((a, b) => a.priority - b.priority)[0];
};

/** Run one governed tick. Crash-safe by construction: each step is an awaited IO call and the
 *  durable state (goal status, events, spend, pause) lives behind the IO, so a restart re-reads
 *  it and continues. */
export const runTick = async (io: TickIO, options: TickOptions = {}): Promise<TickResult> => {
  const maxAttempts = options.maxAttemptsPerGoal ?? 3;

  // Global gate first — Autopilot off or kill switch engaged.
  if (!isVentureLoopAllowed(io.gate())) {
    await io.emit({ kind: 'tick.completed', message: 'halted: disabled or kill switch engaged' });
    return { outcome: 'halted' };
  }

  await io.emit({ kind: 'tick.started' });

  // SENSE/ORIENT — pick the next goal from the backlog.
  const goal = selectNextGoal(await io.loadGoals());
  if (!goal) {
    await io.emit({ kind: 'tick.completed', message: 'no actionable goal' });
    return { outcome: 'no-goal' };
  }
  await io.emit({ kind: 'goal.selected', goalId: goal.id });

  const action: EngineAction = goal.action ?? 'run_build';
  const proposed = io.estimateSpend(goal);
  const budgetState = await io.loadBudgetState();

  // Pre-resolve the approvals DECIDE may need (its predicate is synchronous).
  const approved = new Set<CheckpointKind>();
  if (await io.isCheckpointApproved('scope_change')) approved.add('scope_change');
  const requiredKind = checkpointForAction(action);
  if (requiredKind && (await io.isCheckpointApproved(requiredKind))) approved.add(requiredKind);

  // DECIDE — the composed brake.
  const decision = decide({
    gate: io.gate(),
    action,
    budget: budgetState?.budget ?? {},
    spend: budgetState?.spend ?? ZERO_SPEND,
    proposed,
    inScope: true,
    isCheckpointApproved: (k) => approved.has(k)
  });

  if (!decision.proceed) {
    const d = decision as Exclude<typeof decision, { proceed: true }>;
    if (d.reason === 'budget') {
      await io.pauseVenture('budget');
      await io.emit({ kind: 'budget.exceeded', level: 'warn', message: d.message, goalId: goal.id });
      return { outcome: 'budget', goalId: goal.id, reason: d.code };
    }
    if (d.reason === 'scope' || d.reason === 'checkpoint') {
      await io.raiseCheckpoint(d.checkpoint, `Approval needed: ${d.checkpoint}`, goal.id);
      await io.emit({ kind: 'checkpoint.raised', message: d.message, goalId: goal.id });
      return { outcome: 'gated', goalId: goal.id, reason: d.checkpoint };
    }
    // reason === 'halted' (shouldn't reach here — gate already checked)
    return { outcome: 'halted', goalId: goal.id };
  }

  // ACT (stub in A2) → VERIFY/SHIP (real in A4/A5) → REFLECT.
  await io.markGoal(goal.id, 'in_progress');
  const result = await io.act(goal);

  if (result.ok) {
    await io.recordSpend({
      usd: result.costUsd ?? proposed.usd,
      tokens: proposed.tokens,
      containerMinutes: proposed.containerMinutes
    });
    await io.markGoal(goal.id, 'shipped');
    await io.emit({ kind: 'goal.shipped', goalId: goal.id, costUsd: result.costUsd });
    return { outcome: 'advanced', goalId: goal.id };
  }

  // Failure → no-progress detection.
  const attempts = await io.recordFailure(goal.id);
  if (attempts >= maxAttempts) {
    await io.markGoal(goal.id, 'blocked');
    await io.pauseVenture('stuck');
    await io.emit({
      kind: 'goal.failed',
      level: 'error',
      message: `stuck after ${attempts} attempts: ${result.error || 'unknown error'}`,
      goalId: goal.id
    });
    return { outcome: 'stuck', goalId: goal.id };
  }

  await io.markGoal(goal.id, 'queued'); // leave it for a retry next tick
  await io.emit({
    kind: 'goal.failed',
    level: 'warn',
    message: `attempt ${attempts} failed: ${result.error || 'unknown error'}`,
    goalId: goal.id
  });
  return { outcome: 'advanced', goalId: goal.id, reason: 'retry' };
};
