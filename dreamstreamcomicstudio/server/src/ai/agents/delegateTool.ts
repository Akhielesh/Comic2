// Exposes task delegation as a regular chat tool, so ANY chat model can fan a request
// out to a few parallel backend helper agents (gather → verify → aggregate) mid-turn —
// WITHOUT the user activating the swarm. The model supplies the specific sub-tasks; the
// engine runs them concurrently, cross-verifies, and returns one synthesized, sourced
// answer plus a trace. Separate module (not tools/registry.ts) so the registry never
// imports the engine.

import type { ChatTool } from '../tools/registry.js';
import type { AIProviderId, ChatMessage } from '../providers/types.js';
import type { ChatClientContext } from '../../../../apiTypes.js';
import { runDelegation } from './delegate.js';

export interface DelegateToolContext {
  provider: AIProviderId;
  apiKey: string;
  /** Model used for the final aggregation (the caller's model). */
  model: string;
  /** Conversation so far, so helpers aren't context-blind on follow-ups. */
  messages?: ChatMessage[];
  systemPrompt?: string;
  clientContext?: ChatClientContext;
  fallbackModel?: string;
  timeoutMs?: number;
}

export const DELEGATE_TOOL_NAME = 'delegate_tasks';

export const makeDelegateTool = (ctx: DelegateToolContext): ChatTool => ({
  name: DELEGATE_TOOL_NAME,
  description:
    'Delegate a request to a few parallel backend helper agents, then return ONE cross-verified, sourced answer. Break the request into 2–4 SPECIFIC, INDEPENDENT sub-tasks; each helper gathers its part from live sources and cites it, the findings are automatically cross-checked for confidence and conflicts, and a final pass reconciles them. Use this when answering well needs several independent lookups, or when accuracy matters and claims should be verified across sources (e.g. "compare the specs/prices of A, B and C", "verify these three claims", "gather X, Y and Z and reconcile them"). For a single simple lookup, call the specific tool (web_search etc.) directly instead.',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'The overall request in one clear sentence (used to frame the final aggregated answer).' },
      subtasks: {
        type: 'array',
        items: { type: 'string' },
        description: '2–4 specific, independent sub-tasks to hand to the helper agents. Each should be self-contained and verifiable on its own.'
      }
    },
    required: ['goal', 'subtasks']
  },
  execute: async (args, signal) => {
    const goal = String(args?.goal || '').trim();
    const rawSubtasks = Array.isArray(args?.subtasks) ? args.subtasks : [];
    const subtasks = rawSubtasks.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 4);
    if (!goal && subtasks.length === 0) return { content: 'No goal or sub-tasks were provided to delegate.' };
    if (subtasks.length === 0) return { content: 'No sub-tasks were provided — break the request into 2–4 specific sub-tasks to delegate.' };
    try {
      const result = await runDelegation({
        provider: ctx.provider,
        apiKey: ctx.apiKey,
        model: ctx.model,
        goal: goal || subtasks.join('; '),
        subtasks,
        messages: ctx.messages,
        systemPrompt: ctx.systemPrompt,
        clientContext: ctx.clientContext,
        fallbackModel: ctx.fallbackModel,
        timeoutMs: ctx.timeoutMs,
        signal
      });
      const done = result.trace.agents.filter((a) => a.status === 'done').length;
      const content =
        `Delegated to ${result.trace.agents.length} helper agent(s) (${done} succeeded), cross-verified the findings, and aggregated them. ` +
        `PRESENT THE SYNTHESIZED ANSWER BELOW to the user, keeping its citations:\n\n${result.text || '(no answer)'}`;
      return { content, citations: result.citations, artifacts: result.artifacts, ...(result.notices?.length ? { notice: result.notices[0] } : {}) };
    } catch (err) {
      return {
        content: `Task delegation failed: ${(err as Error)?.message || 'unknown error'}.`,
        notice: { level: 'error', message: 'Task delegation is unavailable right now.' }
      };
    }
  }
});
