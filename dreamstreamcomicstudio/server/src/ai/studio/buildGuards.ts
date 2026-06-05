// Phase 4 — agentic build loop: the guard rails.
//
// The OBSERVE→FIX loop must terminate. These guards decide, after each observation,
// whether to iterate again, stop because the build is clean, stop because we hit the
// iteration cap, or stop because we're stuck (the same error keeps recurring — fixing it
// isn't working, so bail and ask the user rather than burn budget). Pure + deterministic.

import type { BuildObservation } from './observation.js';

export const DEFAULT_MAX_ITERATIONS = 5;
// Same error signature this many times in a row → we're stuck, stop and ask the user.
export const STUCK_REPEAT_LIMIT = 3;

export interface GuardState {
  /** Number of FIX attempts already made (0 before the first fix). */
  iteration: number;
  /** Cap on FIX attempts. */
  maxIterations: number;
  /** Signatures of prior observations, oldest → newest (not incl. the latest). */
  signatures: string[];
}

export type GuardReason = 'ok' | 'max_iterations' | 'stuck' | 'continue';

export interface GuardDecision {
  proceed: boolean; // true = run another FIX iteration
  reason: GuardReason;
  message: string;
  /** When stuck, how many consecutive repeats of the dominant signature we saw. */
  repeats?: number;
}

export const initialGuardState = (maxIterations = DEFAULT_MAX_ITERATIONS): GuardState => ({
  iteration: 0,
  maxIterations,
  signatures: []
});

/** Count how many times `sig` repeats consecutively at the end of `history`. */
const trailingStreak = (history: string[], sig: string): number => {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] === sig) streak++;
    else break;
  }
  return streak;
};

/**
 * Decide whether to run another FIX iteration given the current state and the latest
 * observation. Does not mutate state — call `advanceGuardState` to record the step.
 */
export const evaluateGuard = (state: GuardState, latest: BuildObservation): GuardDecision => {
  if (latest.ok) {
    return { proceed: false, reason: 'ok', message: 'Build is clean — app is running.' };
  }
  if (state.iteration >= state.maxIterations) {
    return {
      proceed: false,
      reason: 'max_iterations',
      message: `Reached the ${state.maxIterations}-iteration cap without a clean build. Last issue: ${latest.summary}`
    };
  }
  const streak = trailingStreak([...state.signatures, latest.signature], latest.signature);
  if (streak >= STUCK_REPEAT_LIMIT) {
    return {
      proceed: false,
      reason: 'stuck',
      repeats: streak,
      message: `Stuck: "${latest.signature}" recurred ${streak}× despite fixes. Stopping to ask you. (${latest.summary})`
    };
  }
  return {
    proceed: true,
    reason: 'continue',
    message: `Attempt ${state.iteration + 1}/${state.maxIterations}: ${latest.summary}`
  };
};

/** Record an iteration: append the signature and bump the counter. Returns a new state. */
export const advanceGuardState = (state: GuardState, latest: BuildObservation): GuardState => ({
  iteration: state.iteration + 1,
  maxIterations: state.maxIterations,
  signatures: [...state.signatures, latest.signature]
});
