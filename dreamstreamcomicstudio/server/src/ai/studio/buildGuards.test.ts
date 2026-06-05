import { describe, expect, it } from 'vitest';
import {
  initialGuardState,
  evaluateGuard,
  advanceGuardState,
  DEFAULT_MAX_ITERATIONS,
  STUCK_REPEAT_LIMIT
} from './buildGuards.js';
import type { BuildObservation } from './observation.js';

const obs = (signature: string, ok = false): BuildObservation => ({
  phase: ok ? 'unknown' : 'dev',
  ok,
  errors: ok ? [] : [{ kind: 'missing_dependency', message: signature }],
  summary: ok ? 'clean' : signature,
  signature
});

describe('evaluateGuard', () => {
  it('stops with reason "ok" when the build is clean', () => {
    const d = evaluateGuard(initialGuardState(), obs('ok', true));
    expect(d).toMatchObject({ proceed: false, reason: 'ok' });
  });

  it('continues on a fresh, non-repeating error within the cap', () => {
    const d = evaluateGuard(initialGuardState(), obs('missing_dependency:react'));
    expect(d.proceed).toBe(true);
    expect(d.reason).toBe('continue');
  });

  it('stops at the iteration cap', () => {
    const state = { iteration: DEFAULT_MAX_ITERATIONS, maxIterations: DEFAULT_MAX_ITERATIONS, signatures: [] };
    const d = evaluateGuard(state, obs('type_error:foo'));
    expect(d).toMatchObject({ proceed: false, reason: 'max_iterations' });
  });

  it('detects "stuck" when the same signature recurs STUCK_REPEAT_LIMIT times', () => {
    const sig = 'missing_dependency:left-pad';
    // history already has the signature (limit - 1) times; the latest makes it `limit`.
    const state = {
      iteration: STUCK_REPEAT_LIMIT - 1,
      maxIterations: DEFAULT_MAX_ITERATIONS,
      signatures: Array(STUCK_REPEAT_LIMIT - 1).fill(sig)
    };
    const d = evaluateGuard(state, obs(sig));
    expect(d).toMatchObject({ proceed: false, reason: 'stuck', repeats: STUCK_REPEAT_LIMIT });
  });

  it('does NOT flag stuck when the error keeps changing', () => {
    const state = {
      iteration: 2,
      maxIterations: DEFAULT_MAX_ITERATIONS,
      signatures: ['missing_dependency:a', 'missing_dependency:b']
    };
    const d = evaluateGuard(state, obs('missing_dependency:c'));
    expect(d.proceed).toBe(true);
  });
});

describe('advanceGuardState', () => {
  it('appends the signature and bumps the iteration count immutably', () => {
    const s0 = initialGuardState();
    const s1 = advanceGuardState(s0, obs('type_error:x'));
    expect(s1.iteration).toBe(1);
    expect(s1.signatures).toEqual(['type_error:x']);
    expect(s0.iteration).toBe(0); // original untouched
    expect(s0.signatures).toEqual([]);
  });
});
