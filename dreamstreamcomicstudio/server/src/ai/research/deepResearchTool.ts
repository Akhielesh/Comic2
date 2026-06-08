// Exposes the deep-research engine as a regular chat tool, so ANY chat turn can trigger a
// real, citation-grounded investigation from natural language ("research X", "deep dive on
// Y", "a thorough sourced report on Z") — not only via the /research slash command. The
// model calls deep_research with a topic; the engine plans → searches → reads → synthesizes,
// and the brief + research-report card + sources flow back through the normal tool pipeline.
//
// Separate module (not tools/registry.ts) so the registry never imports the engine.

import type { ChatTool } from '../tools/types.js';
import type { AIProviderId, ChatMessage } from '../providers/types.js';
import type { ChatClientContext } from '../../../../apiTypes.js';
import { runDeepResearch, type ResearchDepth } from './deepResearch.js';

export interface DeepResearchToolContext {
  provider: AIProviderId;
  apiKey: string;
  /** Model used for the final synthesis (the caller's model). */
  model: string;
  /** Conversation so far, so research isn't context-blind on follow-ups. */
  messages?: ChatMessage[];
  /** The user's durable memory/persona, threaded into synthesis. */
  systemPrompt?: string;
  clientContext?: ChatClientContext;
  fallbackModel?: string;
  timeoutMs?: number;
}

export const DEEP_RESEARCH_TOOL_NAME = 'deep_research';

export const makeDeepResearchTool = (ctx: DeepResearchToolContext): ChatTool => ({
  name: DEEP_RESEARCH_TOOL_NAME,
  description:
    'Run a THOROUGH, multi-step, citation-grounded research investigation on a topic. It decomposes the topic into sub-questions, searches the web for each, READS the top source pages, and returns a sourced brief plus a research-report card. Use this whenever the user wants depth or rigor — "research X", "deep dive / deep research on Y", "a thorough, well-sourced report/brief on Z", "investigate ...". For a single quick fact, use web_search instead, not this.',
  parameters: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: 'The subject to research, as a clear topic or question.' },
      depth: {
        type: 'string',
        enum: ['quick', 'standard', 'exhaustive'],
        description: 'How deep to go. Default "standard"; use "exhaustive" when the user wants a comprehensive dossier.'
      }
    },
    required: ['topic']
  },
  execute: async (args, signal) => {
    const topic = String(args?.topic || '').trim();
    if (!topic) return { content: 'No research topic was provided.' };
    const depthRaw = String(args?.depth || 'standard');
    const depth: ResearchDepth = depthRaw === 'quick' || depthRaw === 'exhaustive' ? depthRaw : 'standard';
    try {
      const res = await runDeepResearch({
        topic,
        depth,
        provider: ctx.provider,
        apiKey: ctx.apiKey,
        model: ctx.model,
        priorMessages: ctx.messages,
        systemPrompt: ctx.systemPrompt,
        fallbackModel: ctx.fallbackModel,
        timeoutMs: ctx.timeoutMs,
        signal
      });
      const content =
        `Deep research complete (${res.report.sourceCount} sources, ${res.report.readCount} read in full). ` +
        `PRESENT THE BRIEF BELOW TO THE USER essentially verbatim — keep its structure and the [n] citations, ` +
        `do not shorten or re-summarize it (the research-report card and sources are already attached):\n\n${res.text}`;
      return {
        content,
        citations: res.citations,
        artifacts: [
          { type: 'research_report', data: res.report },
          { type: 'swarm_trace', data: res.trace }
        ],
        ...(res.notices?.length ? { notice: res.notices[0] } : {})
      };
    } catch (err) {
      return {
        content: `Deep research failed: ${(err as Error)?.message || 'unknown error'}.`,
        notice: { level: 'error', message: 'Deep research is unavailable right now.' }
      };
    }
  }
});
