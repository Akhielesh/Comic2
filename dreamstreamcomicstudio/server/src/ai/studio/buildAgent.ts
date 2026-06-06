// Phase 4 — agentic build loop: the orchestrator.
//
// Drives PLAN → RUN → OBSERVE → FIX → repeat until the app runs cleanly, the iteration cap
// is hit, or we're stuck. The two side-effectful steps — RUN (launch/refresh the container
// via the control plane) and FIX (ask the model for minimal diffs) — are injected, so the
// control flow here is pure and unit-testable; the live route supplies the real `run`/`fix`.

import { buildObservation, type BuildObservation, type ObservationInput } from './observation.js';
import {
  initialGuardState,
  evaluateGuard,
  advanceGuardState,
  type GuardReason,
  type GuardState
} from './buildGuards.js';
import type { StudioFiles } from './studioFix.js';

/** What one container run yields — fed straight into `buildObservation`. */
export interface RunResult extends ObservationInput {
  previewUrl?: string;
}

export interface FixOutput {
  files: StudioFiles; // changed files (path → full content)
  note?: string;
  /** Guardrailed install command the agent wants the next run to use. */
  install?: string;
  /** Guardrailed dev/start command the agent wants the next run to use. */
  dev?: string;
}

export type BuildStage = 'plan' | 'run' | 'observe' | 'fix' | 'done' | 'stopped';

export interface BuildEvent {
  stage: BuildStage;
  iteration: number; // 0-based: which fix round we're on
  message: string;
  observation?: BuildObservation;
  previewUrl?: string;
}

export interface BuildAgentDeps {
  /**
   * Launch (or re-launch after a fix) the project; returns the observed signals. `opts` carries the
   * agent's current guardrailed install/dev commands so a fix can change how the app is built/run.
   */
  run: (files: StudioFiles, opts?: { install?: string; dev?: string }) => Promise<RunResult>;
  /** Ask the model for minimal fixes given the current files + observation. */
  fix: (files: StudioFiles, observation: BuildObservation) => Promise<FixOutput>;
  /** Optional live trace sink (SSE in the real route). */
  onEvent?: (event: BuildEvent) => void;
}

export interface BuildAgentResult {
  ok: boolean; // reached a clean, running build
  reason: GuardReason;
  iterations: number; // number of FIX rounds performed
  files: StudioFiles; // final file set
  observation: BuildObservation; // last observation
  previewUrl?: string;
  events: BuildEvent[];
}

export interface BuildAgentOptions {
  maxIterations?: number;
}

export const runBuildAgent = async (
  initialFiles: StudioFiles,
  deps: BuildAgentDeps,
  options: BuildAgentOptions = {}
): Promise<BuildAgentResult> => {
  let files: StudioFiles = { ...initialFiles };
  // Agent-controlled (guardrailed) build/run commands — a fix may change them between runs.
  let install: string | undefined;
  let dev: string | undefined;
  let state: GuardState = initialGuardState(options.maxIterations);
  const events: BuildEvent[] = [];
  const emit = (event: BuildEvent): void => {
    events.push(event);
    deps.onEvent?.(event);
  };

  emit({ stage: 'plan', iteration: 0, message: 'Planning the build…' });

  // Runs at least once (the initial build), then up to maxIterations fix rounds.
  for (;;) {
    emit({
      stage: 'run',
      iteration: state.iteration,
      message: state.iteration === 0 ? 'Building & launching…' : `Re-running after fix #${state.iteration}…`
    });
    const result = await deps.run(files, { install, dev });
    const observation = buildObservation(result);
    emit({
      stage: 'observe',
      iteration: state.iteration,
      message: observation.summary,
      observation,
      previewUrl: result.previewUrl
    });

    const decision = evaluateGuard(state, observation);
    if (!decision.proceed) {
      const ok = decision.reason === 'ok';
      emit({
        stage: ok ? 'done' : 'stopped',
        iteration: state.iteration,
        message: decision.message,
        observation,
        previewUrl: result.previewUrl
      });
      return {
        ok,
        reason: decision.reason,
        iterations: state.iteration,
        files,
        observation,
        previewUrl: result.previewUrl,
        events
      };
    }

    emit({ stage: 'fix', iteration: state.iteration + 1, message: `Fixing: ${observation.summary}`, observation });
    const fix = await deps.fix(files, observation);
    files = { ...files, ...fix.files };
    if (fix.install) install = fix.install; // agent changed how deps are installed
    if (fix.dev) dev = fix.dev; // agent changed how the app is started
    state = advanceGuardState(state, observation);
  }
};
