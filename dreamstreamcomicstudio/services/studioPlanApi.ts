// Client for the Code Studio build-flow stages: CLARIFY (the AI asks smart questions) and PLAN
// (a reviewable build plan). Both attach the studio's chosen coding model/source/options so the
// flow uses Code Studio's own model, independent of comics/chat.

import { post } from './apiClient';
import { studioModelRequest } from './studioModelSelection';
import type { StudioClarifyResult, StudioBuildPlan, StudioAnswer } from '../apiTypes';

// Both stages are idempotent reads (they call a model and return; no persistent mutation), so it's
// safe to AUTO-RETRY them — this is what absorbs a Railway cold start instead of dumping the
// "Couldn't reach the AI server" error on the user the moment the backend is waking up.
const PLAN_RETRY = { attempts: 3 } as const;

/**
 * Ask the AI what (if anything) it needs to know before building. Pass `files` to clarify a change
 * to an EXISTING app (refine mode) — the AI then asks app-aware follow-ups, tuned to ask nothing for
 * clear changes so the user is never bombarded.
 */
export const clarifyStudioApp = async (
  prompt: string,
  opts?: { files?: { path: string; content: string }[]; signal?: AbortSignal }
): Promise<StudioClarifyResult> =>
  post<Record<string, unknown>, StudioClarifyResult>(
    '/api/studio/clarify',
    { ...studioModelRequest(), prompt, ...(opts?.files?.length ? { files: opts.files } : {}) },
    { signal: opts?.signal, retry: PLAN_RETRY }
  );

/** Turn the idea (+ answers) into a concrete, reviewable build plan. */
export const planStudioApp = async (
  prompt: string,
  answers: StudioAnswer[],
  signal?: AbortSignal
): Promise<StudioBuildPlan> => {
  const { plan } = await post<{ prompt: string; answers: StudioAnswer[] }, { plan: StudioBuildPlan }>(
    '/api/studio/plan',
    { ...studioModelRequest(), prompt, answers },
    { signal, retry: PLAN_RETRY }
  );
  return plan;
};
