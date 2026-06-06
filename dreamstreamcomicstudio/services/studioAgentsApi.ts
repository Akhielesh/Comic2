// Client for the multi-agent refinement route (POST /api/studio/agents). Streams a per-agent
// trace (plan → agent running/done/skipped/error → done) and a final result with the refined
// files. Automatically attaches the studio's chosen coding model/source/options + the user's
// selected agents and preferences.

import { postStream } from './apiClient';
import { readSSEStream } from './sse';
import { studioModelRequest, getStudioAgents, getStudioAgentPreferences } from './studioModelSelection';
import { resolveStudioAgentIds } from './studioAgents';

export type StudioAgentStatus = 'running' | 'done' | 'skipped' | 'error';

export interface StudioAgentPlan {
  model: string;
  source: string;
  agents: { id: string; name: string }[];
}

export interface StudioAgentStep {
  stage: 'agent';
  agentId: string;
  name: string;
  status: StudioAgentStatus;
  note?: string;
  changed?: string[];
  index: number;
  total: number;
}

export interface StudioAgentsResult {
  files: { path: string; content: string }[];
  trace: { id: string; name: string; status: 'done' | 'skipped' | 'error'; note?: string; changed: string[] }[];
}

export interface StudioAgentsPayload {
  files: { path: string; content: string }[];
  projectId?: string;
  title?: string;
  template?: string;
  /** Extra one-off preferences for this run (merged with the saved ones). */
  prompt?: string;
}

export interface StudioAgentsHandlers {
  onPlan?: (plan: StudioAgentPlan) => void;
  onAgent?: (step: StudioAgentStep) => void;
  onResult?: (result: StudioAgentsResult) => void;
  onError?: (message: string) => void;
}

/** POST the current app to the agent team and stream the refinement. Resolves when the stream ends. */
export const streamStudioAgents = async (
  payload: StudioAgentsPayload,
  handlers: StudioAgentsHandlers,
  signal?: AbortSignal
): Promise<void> => {
  const body = {
    ...studioModelRequest(),
    agents: resolveStudioAgentIds(getStudioAgents()),
    preferences: getStudioAgentPreferences(),
    ...payload
  };
  const res = await postStream('/api/studio/agents', body, { signal });
  await readSSEStream(res.body, ({ event, data }) => {
    let parsed: unknown;
    try { parsed = JSON.parse(data); } catch { return; }
    switch (event) {
      case 'plan':
        handlers.onPlan?.(parsed as StudioAgentPlan);
        break;
      case 'agent':
        handlers.onAgent?.(parsed as StudioAgentStep);
        break;
      case 'result':
        handlers.onResult?.(parsed as StudioAgentsResult);
        break;
      case 'error':
        handlers.onError?.((parsed as { message?: string })?.message || 'Agent refinement failed.');
        break;
      // 'done' is implicit before 'result'; no separate handler needed.
    }
  });
};
