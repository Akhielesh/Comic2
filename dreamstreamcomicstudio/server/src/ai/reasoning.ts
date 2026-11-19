// Reasoning (thinking) token budgets, shared by every adapter and by comic/llm.ts.
//
// Bound the thinking budget so chat stays responsive. Unbounded `effort: 'high'` was
// running 55-109s in production (the model rambling in its thinking phase). A capped
// reasoning token budget keeps small/medium turns fast (they finish well under the
// ceiling) while still allowing meaningful reasoning; genuinely deep work uses the agent
// swarm, whose depth comes from running many agents rather than one giant reasoning call.
// (Env-overridable via REASONING_BUDGET_* if a deployment wants more headroom.)
//
// Callers that must also size max_tokens around the thinking budget (reasoning tokens count
// against max_tokens, and Anthropic's budget form requires max_tokens > budget) reuse these
// exact numbers instead of hard-coding a second copy. It lives on its own so no provider
// adapter has to load another adapter to read it.

export type ReasoningEffort = 'low' | 'medium' | 'high';

export const reasoningBudget = (effort: ReasoningEffort): number => {
  const defaults = { low: 1024, medium: 2048, high: 4096 };
  const raw = Number(process.env[`REASONING_BUDGET_${effort.toUpperCase()}`]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : defaults[effort];
};
