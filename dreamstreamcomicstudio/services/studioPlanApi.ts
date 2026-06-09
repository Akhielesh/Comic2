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

/** Ask the AI what (if anything) it needs to know before building. */
export const clarifyStudioApp = async (prompt: string, signal?: AbortSignal): Promise<StudioClarifyResult> =>
  post<{ prompt: string }, StudioClarifyResult>('/api/studio/clarify', { ...studioModelRequest(), prompt }, { signal, retry: PLAN_RETRY });

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
