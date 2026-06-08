// Pure checkpoint logic for Autopilot's human-in-the-loop gate (no DB, no network). Epic A0.
// Six checkpoint kinds ALWAYS require human approval regardless of autonomy level
// (docs/studio/autopilot/00-MASTER-PLAN.md §8). The DECIDE gate calls checkpointForAction()
// for any intended action; if it returns a kind, the loop raises a checkpoint and pauses
// that goal until the checkpoint is resolved (approved).

export type CheckpointKind =
  | 'roadmap_approval'
  | 'prod_deploy'
  | 'spend_money'
  | 'destructive'
  | 'external_publish'
  | 'scope_change';

export const CHECKPOINT_KINDS: readonly CheckpointKind[] = [
  'roadmap_approval',
  'prod_deploy',
  'spend_money',
  'destructive',
  'external_publish',
  'scope_change'
] as const;

export type CheckpointStatus = 'open' | 'approved' | 'denied' | 'expired';

/** An action the engine wants to take, mapped to the checkpoint it requires (or none). */
export type EngineAction =
  | 'write_files' // in-sandbox build edit → no checkpoint
  | 'run_build' // in-sandbox install/dev → no checkpoint
  | 'deploy_preview' // managed preview → no checkpoint
  | 'deploy_production' // → prod_deploy
  | 'spend_money' // paid resource / domain / paid API beyond budget → spend_money
  | 'delete_resource' // drop a DB/resource/deployment → destructive
  | 'publish_external' // public-facing publish under the user's brand → external_publish
  | 'change_scope' // work outside the approved roadmap → scope_change
  | 'approve_roadmap'; // initial roadmap sign-off → roadmap_approval

const ACTION_CHECKPOINT: Record<EngineAction, CheckpointKind | null> = {
  write_files: null,
  run_build: null,
  deploy_preview: null,
  deploy_production: 'prod_deploy',
  spend_money: 'spend_money',
  delete_resource: 'destructive',
  publish_external: 'external_publish',
  change_scope: 'scope_change',
  approve_roadmap: 'roadmap_approval'
};

/** The checkpoint kind an action requires, or null if it may proceed autonomously. */
export const checkpointForAction = (action: EngineAction): CheckpointKind | null =>
  ACTION_CHECKPOINT[action] ?? null;

export const requiresCheckpoint = (action: EngineAction): boolean =>
  checkpointForAction(action) !== null;

const TERMINAL: readonly CheckpointStatus[] = ['approved', 'denied', 'expired'];
export const isTerminal = (status: CheckpointStatus): boolean => TERMINAL.includes(status);

/** Only an OPEN checkpoint may move to a terminal state. */
export const canTransition = (from: CheckpointStatus, to: CheckpointStatus): boolean =>
  from === 'open' && (to === 'approved' || to === 'denied' || to === 'expired');

export interface CheckpointResolution {
  to: Extract<CheckpointStatus, 'approved' | 'denied' | 'expired'>;
  resolvedBy?: string; // user id; omit for automatic expiry
  at?: string; // ISO timestamp; defaults to now
}

export interface ResolvedCheckpoint {
  status: CheckpointStatus;
  resolvedBy: string | null;
  resolvedAt: string;
}

/** Pure: compute resolved fields for a checkpoint, or throw on an invalid transition. */
export const resolveCheckpoint = (
  current: CheckpointStatus,
  resolution: CheckpointResolution
): ResolvedCheckpoint => {
  if (!canTransition(current, resolution.to)) {
    throw new Error(`Invalid checkpoint transition: ${current} → ${resolution.to}`);
  }
  return {
    status: resolution.to,
    resolvedBy: resolution.resolvedBy ?? null,
    resolvedAt: resolution.at ?? new Date().toISOString()
  };
};

/** Whether the engine may proceed past a checkpoint of this status (only when approved). */
export const isCleared = (status: CheckpointStatus): boolean => status === 'approved';
