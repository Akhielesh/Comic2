import type { AgentActivityArtifact, AgentActivityEvent, AgentActivityStep } from '../../apiTypes';

/**
 * Fold one live `agent_step` SSE event into the running `agent_activity` artifact.
 *
 * Pure and order-independent: a `start` adds a `running` step; the matching `end`
 * settles it to `done`/`error`. Steps are matched by `(round, index, tool)` so the
 * several tools a single model round dispatches concurrently each settle on their own,
 * in whatever order they finish — without clobbering one another. An `end` that arrives
 * with no matching `start` (shouldn't happen, but be defensive) is recorded as already
 * settled rather than dropped.
 */
export const applyAgentStep = (
  prior: AgentActivityArtifact | undefined,
  event: AgentActivityEvent
): AgentActivityArtifact => {
  const steps: AgentActivityStep[] = [...(prior?.steps || [])];
  const id = `${event.iteration}:${event.index}:${event.tool}`;
  const i = steps.findIndex((st) => st.id === id);
  if (event.phase === 'start') {
    const step: AgentActivityStep = { id, tool: event.tool, query: event.query, status: 'running', round: event.iteration };
    if (i >= 0) steps[i] = step;
    else steps.push(step);
  } else if (i >= 0) {
    steps[i] = { ...steps[i], status: event.ok ? 'done' : 'error', summary: event.summary };
  } else {
    steps.push({
      id,
      tool: event.tool,
      query: event.query,
      status: event.ok ? 'done' : 'error',
      summary: event.summary,
      round: event.iteration
    });
  }
  return { steps, done: prior?.done ?? false };
};
