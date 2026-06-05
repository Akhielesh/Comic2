// Pure cost-safety caps for the Studio (no DB, no network) — unit-testable.
//
// Studio compute is OUR Cloudflare cost (not a model-token cost), so it doesn't go
// through the token-based usageEnforcer; instead the control plane enforces these simple
// per-user caps and records each run in `studio_runs` for metering. Limits come from env
// (see config.ts STUDIO_*). Idle-sleep + max-session are enforced by the Worker itself.

export interface StudioCapLimits {
  /** Max concurrently-live preview containers per user. */
  maxConcurrentPerUser: number;
  /** Max total awake minutes per user per day. */
  dailyBuildMinutes: number;
}

export interface StudioUsageSnapshot {
  /** The user's currently-live runs (studio_runs with ended_at IS NULL). */
  activeRuns: number;
  /** The user's total awake seconds today. */
  dailyAwakeSeconds: number;
}

export interface CapDecision {
  allowed: boolean;
  code?: 'STUDIO_TOO_MANY_CONCURRENT' | 'STUDIO_DAILY_LIMIT';
  message?: string;
}

export const evaluateLaunchAllowed = (
  usage: StudioUsageSnapshot,
  limits: StudioCapLimits
): CapDecision => {
  if (usage.activeRuns >= limits.maxConcurrentPerUser) {
    return {
      allowed: false,
      code: 'STUDIO_TOO_MANY_CONCURRENT',
      message: `You already have ${usage.activeRuns} live preview${usage.activeRuns === 1 ? '' : 's'} running. Stop one before starting another (limit ${limits.maxConcurrentPerUser}).`
    };
  }
  if (usage.dailyAwakeSeconds >= limits.dailyBuildMinutes * 60) {
    return {
      allowed: false,
      code: 'STUDIO_DAILY_LIMIT',
      message: `You've reached today's live-preview limit (${limits.dailyBuildMinutes} min). It resets tomorrow.`
    };
  }
  return { allowed: true };
};
