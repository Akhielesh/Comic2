// The DECIDE gate — the deterministic heart of the Autopilot loop (no LLM, no DB, no network).
// Epic A0/A2. Composes every brake into ONE decision the loop consults before it ACTs:
//   1) global gate (VENTURES_ENABLED + kill switch)  → halted
//   2) scope guard (work must be within approved scope) → scope_change checkpoint
//   3) action checkpoint (irreversible/sensitive actions) → the required checkpoint
//   4) budget (the proposed spend must fit the caps)   → budget breach
// Checks run hardest-stop-first and short-circuit. See docs/studio/autopilot/spec/24-autonomous-engine.md.
//
// NOTE: the server tsconfig uses `strict: false`, so discriminated-union truthiness narrowing
// is unreliable — we cast the budget false-variant explicitly rather than rely on narrowing.

import {
  evaluateBudget,
  type BudgetBreachCode,
  type BudgetDecision,
  type ProposedSpend,
  type VentureBudget,
  type VentureSpendSnapshot
} from './budget.js';
import { checkpointForAction, type CheckpointKind, type EngineAction } from './checkpoints.js';
import { isVentureLoopAllowed, type LoopGateState } from './killSwitch.js';

export type DecideReason = 'halted' | 'scope' | 'checkpoint' | 'budget';

export type DecideOutcome =
  | { proceed: true }
  | { proceed: false; reason: 'halted'; message: string }
  | { proceed: false; reason: 'scope'; checkpoint: 'scope_change'; message: string }
  | { proceed: false; reason: 'checkpoint'; checkpoint: CheckpointKind; message: string }
  | { proceed: false; reason: 'budget'; code: BudgetBreachCode; message: string };

export interface DecideInput {
  /** Global gate state: { enabled: VENTURES_ENABLED, killed: kill switch }. */
  gate: LoopGateState;
  /** The action the engine wants to take this tick. */
  action: EngineAction;
  budget: VentureBudget;
  spend: VentureSpendSnapshot;
  /** Additional spend this action would incur (checked against the caps before it runs). */
  proposed?: ProposedSpend;
  /** Is the chosen goal within the venture's approved scope? Defaults to true. */
  inScope?: boolean;
  /** Whether a required checkpoint of a given kind is already approved (so the loop may proceed). */
  isCheckpointApproved?: (kind: CheckpointKind) => boolean;
}

export const decide = (input: DecideInput): DecideOutcome => {
  // 1. Global gate — Autopilot off or kill switch engaged. The hardest stop.
  if (!isVentureLoopAllowed(input.gate)) {
    return { proceed: false, reason: 'halted', message: 'Autopilot is disabled or the kill switch is engaged.' };
  }

  const isApproved = input.isCheckpointApproved ?? (() => false);

  // 2. Scope guard — out-of-scope work needs an explicit scope_change approval.
  if (input.inScope === false && !isApproved('scope_change')) {
    return {
      proceed: false,
      reason: 'scope',
      checkpoint: 'scope_change',
      message: 'This work is outside the approved roadmap scope and needs your approval.'
    };
  }

  // 3. Action checkpoint — irreversible/sensitive actions need their checkpoint approved.
  const required = checkpointForAction(input.action);
  if (required && !isApproved(required)) {
    return {
      proceed: false,
      reason: 'checkpoint',
      checkpoint: required,
      message: `This action requires "${required}" approval before it can run.`
    };
  }

  // 4. Budget — the proposed spend must fit within the caps.
  const budgetDecision: BudgetDecision = evaluateBudget(input.spend, input.budget, input.proposed);
  if (!budgetDecision.allowed) {
    const breach = budgetDecision as Extract<BudgetDecision, { allowed: false }>;
    return { proceed: false, reason: 'budget', code: breach.code, message: breach.message };
  }

  return { proceed: true };
};
