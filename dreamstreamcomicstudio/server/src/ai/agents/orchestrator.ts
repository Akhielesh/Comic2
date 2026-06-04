// The swarm orchestrator. Given a goal it: (1) PLANS — a planner model decomposes
// the goal into subtasks assigned to specialized agents; (2) DISPATCHES — each
// agent runs concurrently as a focused runChat call with its own persona + tools;
// (3) SYNTHESIZES — a lead agent merges every finding into one answer, streaming it.
//
// Progress is reported as a SwarmTraceArtifact so the client can show the plan
// executing live. Designed to run on free/open models by default (planner + agents
// use a free model; only synthesis uses the user's chosen model).

import { runChat } from '../chat.js';
import type { ChatMessage, AIProviderId } from '../providers/types.js';
import { resolveTools, type ToolContext } from '../tools/registry.js';
import { pickTextModel, TEXT_FALLBACK } from '../autoRouter.js';
import { coerceJsonOrNull } from '../jsonCoerce.js';
import { buildUsage } from '../usage.js';
import {
  AGENTS,
  agentCatalogForPlanner,
  sanitizePlan,
  selectAgentsHeuristic,
  type AgentDefinition
} from './registry.js';
import type {
  ChatArtifact,
  ChatClientContext,
  ChatCitation,
  ChatToolEvent,
  ChatToolImage,
  CapabilityNotice,
  SwarmTraceArtifact,
  SwarmAgentRun,
  ApiUsage
} from '../../../../apiTypes.js';

const PLANNER_PROMPT = `You are the planner for a swarm of specialized AI agents. Decompose the user's goal into the FEWEST focused subtasks needed (1 to 4) and assign each to the single most suitable agent.

Available agents:
{catalog}

Rules:
- Use only the agent ids listed above.
- Give each agent a clear, specific task instruction.
- Prefer fewer agents; a simple goal may need just one.
Return ONLY a JSON array, no prose:
[{"agent":"<id>","task":"<instruction>"}]`;

const SYNTH_SYSTEM = `You are the lead agent of a swarm. Specialized sub-agents have completed focused subtasks and their findings are provided to you. Synthesize them into ONE clear, accurate, well-structured answer that fully addresses the user's goal. Integrate and reconcile the findings, cite sources where given, prefer the most reliable information, and do not describe the orchestration process unless asked.`;

const MAX_AGENTS = 4;

export interface RunSwarmParams {
  provider: AIProviderId;
  apiKey: string;
  /** Model used for the final synthesis (the user's chosen model). */
  model: string;
  /** Full conversation; the last user message is the goal. */
  messages: ChatMessage[];
  systemPrompt?: string;
  clientContext?: ChatClientContext;
  fallbackModel?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** User-defined agents to add to the deployable pool for this run. */
  extraAgents?: AgentDefinition[];
  /** Stream the final synthesized answer. */
  onDelta?: (delta: { content?: string; reasoning?: string }) => void;
  /** Report plan/agent progress so the UI can render a live trace. */
  onProgress?: (trace: SwarmTraceArtifact) => void;
}

export interface RunSwarmResult {
  text: string;
  model: string;
  reasoning?: string;
  citations?: ChatCitation[];
  toolEvents?: ChatToolEvent[];
  images?: ChatToolImage[];
  artifacts: ChatArtifact[];
  notices?: CapabilityNotice[];
  usage: ApiUsage;
  trace: SwarmTraceArtifact;
}

const lastUserText = (messages: ChatMessage[]): string => {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) return last.content.map((p) => ('text' in p ? p.text : '')).join(' ');
  return '';
};

const dedupeCitations = (citations: ChatCitation[]): ChatCitation[] => {
  const seen = new Set<string>();
  const out: ChatCitation[] = [];
  for (const c of citations) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
};

// Combine token/cost usage across the planner, every agent and the synthesizer so
// billing settles on the swarm's true footprint, not just the final call.
const mergeUsage = (parts: ApiUsage[]): ApiUsage => {
  const out: ApiUsage = {};
  const addNum = (key: keyof ApiUsage) => {
    let sum = 0;
    let any = false;
    for (const p of parts) {
      const v = p[key];
      if (typeof v === 'number') { sum += v; any = true; }
    }
    if (any) (out as Record<string, number>)[key as string] = sum;
  };
  addNum('promptTokens');
  addNum('candidatesTokens');
  addNum('totalTokens');
  addNum('estimatedTokens');
  addNum('promptChars');
  addNum('providerCostUsd');
  return out;
};

const toolCtxFrom = (ctx?: ChatClientContext): ToolContext | undefined =>
  ctx
    ? { timezone: ctx.timezone, locale: ctx.locale, units: ctx.units, location: ctx.location }
    : undefined;

export const runSwarm = async (params: RunSwarmParams): Promise<RunSwarmResult> => {
  const goal = lastUserText(params.messages).trim();
  const toolCtx = toolCtxFrom(params.clientContext);
  const baseReq = {
    provider: params.provider,
    apiKey: params.apiKey,
    timeoutMs: params.timeoutMs,
    fallbackModel: params.fallbackModel ?? TEXT_FALLBACK,
    signal: params.signal
  };

  // Deployable pool = built-in agents + any user-defined custom agents for this run.
  const pool: Record<string, AgentDefinition> = { ...AGENTS };
  for (const a of params.extraAgents || []) pool[a.id] = a;

  // Planner + agents run on a free model by default (the swarm is meant to run on
  // open/free models); synthesis uses the user's chosen model.
  const workerModel = await pickTextModel({ preferFree: true }).catch(() => TEXT_FALLBACK);

  // 1) PLAN
  const usageParts: ApiUsage[] = [];
  let plan: { agent: string; task: string }[] = [];
  try {
    const planRes = await runChat({
      ...baseReq,
      model: workerModel,
      messages: [{ role: 'user', content: `Goal: ${goal}` }],
      systemOverride: PLANNER_PROMPT.replace('{catalog}', agentCatalogForPlanner(pool)),
      temperature: 0.2,
      maxTokens: 500
    });
    usageParts.push(planRes.usage);
    plan = sanitizePlan(coerceJsonOrNull(planRes.text), goal, pool);
  } catch {
    /* fall back to heuristic below */
  }
  if (!plan.length) plan = selectAgentsHeuristic(goal);
  plan = plan.slice(0, MAX_AGENTS);

  const agents: SwarmAgentRun[] = plan.map((p) => {
    const def = pool[p.agent];
    return { id: def.id, name: def.name, task: p.task, status: 'pending' as const };
  });
  const trace: SwarmTraceArtifact = { goal, agents };
  const emit = () => params.onProgress?.({ goal, agents: agents.map((a) => ({ ...a })) });
  emit();

  // 2) DISPATCH — run every agent concurrently.
  const agentArtifacts: ChatArtifact[] = [];
  const citations: ChatCitation[] = [];
  const toolEvents: ChatToolEvent[] = [];
  const images: ChatToolImage[] = [];
  const notices: CapabilityNotice[] = [];

  const findings = await Promise.all(
    plan.map(async (p, i) => {
      const def = pool[p.agent];
      agents[i].status = 'running';
      emit();
      try {
        const r = await runChat({
          ...baseReq,
          model: workerModel,
          messages: [{ role: 'user', content: p.task }],
          systemOverride: def.systemPrompt,
          clientContext: params.clientContext,
          tools: resolveTools(def.toolNames, toolCtx),
          temperature: 0.4,
          maxTokens: 1400
        });
        usageParts.push(r.usage);
        if (r.artifacts) agentArtifacts.push(...r.artifacts);
        if (r.citations) citations.push(...r.citations);
        if (r.toolEvents) toolEvents.push(...r.toolEvents);
        if (r.notices) notices.push(...r.notices);
        if (r.images) images.push(...r.images);
        agents[i] = {
          ...agents[i],
          status: 'done',
          summary: (r.text || '').slice(0, 400),
          toolEvents: r.toolEvents
        };
        emit();
        return { name: def.name, task: p.task, text: r.text || '' };
      } catch (err) {
        agents[i] = { ...agents[i], status: 'error', summary: (err as Error)?.message || 'agent failed' };
        emit();
        return { name: def.name, task: p.task, text: '' };
      }
    })
  );

  // 3) SYNTHESIZE — merge all findings into one streamed answer.
  const findingsBlock = findings
    .map((f) => `### ${f.name} — task: ${f.task}\n${f.text || '(no result)'}`)
    .join('\n\n');
  const synthInput = `User goal: ${goal}\n\nFindings from the specialized agents:\n\n${findingsBlock}\n\nNow write the single best answer for the user.`;
  const synthMessages: ChatMessage[] = [
    ...params.messages.slice(0, -1),
    { role: 'user', content: synthInput }
  ];
  const synthSystem = [SYNTH_SYSTEM, params.systemPrompt?.trim()].filter(Boolean).join('\n\n');

  const synthRes = await runChat({
    ...baseReq,
    model: params.model,
    messages: synthMessages,
    systemPrompt: synthSystem,
    clientContext: params.clientContext,
    temperature: 0.5,
    maxTokens: 3072,
    onDelta: params.onDelta
  });
  usageParts.push(synthRes.usage);
  if (synthRes.citations) citations.push(...synthRes.citations);
  if (synthRes.notices) notices.push(...synthRes.notices);

  const finalTrace: SwarmTraceArtifact = { goal, agents: agents.map((a) => ({ ...a })) };
  const mergedCitations = dedupeCitations(citations);

  return {
    text: synthRes.text,
    model: synthRes.model || params.model,
    reasoning: synthRes.reasoning,
    citations: mergedCitations.length ? mergedCitations : undefined,
    toolEvents: toolEvents.length ? toolEvents : undefined,
    images: images.length ? images : undefined,
    artifacts: [{ type: 'swarm_trace', data: finalTrace }, ...agentArtifacts],
    notices: notices.length ? notices : undefined,
    usage: mergeUsage(usageParts),
    trace: finalTrace
  };
};
