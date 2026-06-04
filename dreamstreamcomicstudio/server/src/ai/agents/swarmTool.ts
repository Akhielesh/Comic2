// Exposes the agent swarm as a regular chat tool, so ANY chat model can delegate a
// complex, multi-domain task to the swarm mid-conversation (not only via the
// explicit "Swarm" mode). The model calls run_agent_swarm with a goal; the
// orchestrator plans, runs specialized agents in parallel, synthesizes, and the
// result (answer + cards + sources) flows back through the normal tool pipeline.
//
// Kept in its own module (not tools/registry.ts) so the tool registry never has to
// import the orchestrator — avoids an import cycle (orchestrator already imports the
// tool registry to resolve each agent's tools).

import type { ChatTool } from '../tools/registry.js';
import type { AIProviderId, ChatMessage } from '../providers/types.js';
import type { ChatClientContext } from '../../../../apiTypes.js';
import { runSwarm } from './orchestrator.js';
import type { AgentDefinition } from './registry.js';

export interface SwarmToolContext {
  provider: AIProviderId;
  apiKey: string;
  /** Model used for the swarm's final synthesis (the caller's model). */
  model: string;
  /** Conversation so far, so the swarm's agents aren't context-blind on follow-ups. */
  messages?: ChatMessage[];
  /** The user's durable memory/persona, passed through to the agents + synthesis. */
  systemPrompt?: string;
  clientContext?: ChatClientContext;
  /** User-defined agents to add to the deployable pool. */
  extraAgents?: AgentDefinition[];
  fallbackModel?: string;
  timeoutMs?: number;
}

export const SWARM_TOOL_NAME = 'run_agent_swarm';

export const makeSwarmTool = (ctx: SwarmToolContext): ChatTool => ({
  name: SWARM_TOOL_NAME,
  description:
    'Delegate a complex, broad, or multi-part task to a swarm of specialized agents (news, finance/markets, weather, tech, web research, local/places) that work in PARALLEL, then return one synthesized, sourced answer plus a per-agent breakdown. Use this for compound questions that span multiple domains or need several live lookups at once (e.g. "brief me on today\'s tech news, the market, and the weather in NYC"). For a single simple lookup, call the specific tool instead.',
  parameters: {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'The full task/goal to hand to the agent swarm, in one clear instruction.' }
    },
    required: ['goal']
  },
  execute: async (args, signal) => {
    const goal = String(args?.goal || '').trim();
    if (!goal) return { content: 'No goal was provided for the swarm.' };
    try {
      const result = await runSwarm({
        provider: ctx.provider,
        apiKey: ctx.apiKey,
        model: ctx.model,
        // Hand the swarm the real conversation + the model's distilled goal, so its
        // agents see prior turns and the user's memory (was goal-only — fully context-blind).
        messages: [...(ctx.messages ?? []), { role: 'user', content: goal }],
        systemPrompt: ctx.systemPrompt,
        clientContext: ctx.clientContext,
        extraAgents: ctx.extraAgents,
        fallbackModel: ctx.fallbackModel,
        timeoutMs: ctx.timeoutMs,
        signal
      });
      const agentList = result.trace.agents
        .map((a) => `${a.name} (${a.status})`)
        .join(', ');
      const content = `The agent swarm completed. Agents: ${agentList}.\n\nSynthesized result:\n${result.text || '(no answer)'}`;
      return { content, citations: result.citations, artifacts: result.artifacts };
    } catch (err) {
      return { content: `Agent swarm failed: ${(err as Error)?.message || 'unknown error'}.` };
    }
  }
});
