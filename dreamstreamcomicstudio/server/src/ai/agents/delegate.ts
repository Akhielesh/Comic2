// Lightweight task delegation — "backend helper agents without the swarm".
//
// The swarm orchestrator (orchestrator.ts) is powerful but heavy and gated behind an
// explicit toggle. This is the everyday version: ANY chat turn can hand a few SPECIFIC
// sub-tasks to parallel helper agents that each GATHER (web-grounded) and cite, the
// findings are cross-VERIFIED (reusing the deterministic verifier), and a final pass
// AGGREGATES them into one accurate, sourced answer. No specialized agent pool, no
// planner round-trip, no toggle — the calling model decides the sub-tasks, which makes
// delegation precise instead of a vague goal hand-off.

import { runChat } from '../chat.js';
import type { ChatMessage, AIProviderId } from '../providers/types.js';
import { pickTextModel, TEXT_FALLBACK } from '../autoRouter.js';
import { buildUsage } from '../usage.js';
import { composePersona, withAgentPersona } from '../persona.js';
import { verifyFindings, verificationBlock, type AgentFinding } from './verify.js';
import type {
  ChatArtifact,
  ChatClientContext,
  ChatCitation,
  CapabilityNotice,
  SwarmTraceArtifact,
  SwarmAgentRun,
  ApiUsage
} from '../../../../apiTypes.js';

// Each helper agent: focused, web-grounded, sourced, honest about gaps. One voice with
// the rest of the platform (withAgentPersona) so delegated work doesn't feel bolted-on.
const RESEARCHER_PROMPT = withAgentPersona(
  `You are a focused research helper handling ONE specific sub-task for a larger answer. Do exactly that sub-task and nothing else.
- Gather the facts from live sources and CITE them. Lead with the concrete finding (numbers, names, dates).
- Be concise — a tight, sourced paragraph or a short list, not an essay.
- If you genuinely cannot find it, say so plainly. NEVER invent facts, figures, or sources to fill the gap.`
);

// The aggregator reconciles every helper's finding into the single best answer, weighting
// by the verifier's confidence and explicitly labelling anything unverified.
const AGGREGATOR_PROMPT = composePersona(
  `You are aggregating the findings of several backend helper agents into ONE clear, accurate answer to the user's request. Integrate and RECONCILE the findings: where they corroborate, state it confidently with citations; where they conflict, surface the conflict and prefer the better-sourced side; weight findings by the verifier confidence you are given and explicitly label or drop anything low-confidence or unverified. Cite real sources. Do not describe the delegation process unless asked.`
);

const MAX_SUBTASKS = 4;

export interface RunDelegationParams {
  provider: AIProviderId;
  apiKey: string;
  /** Model used for the final aggregation (the caller's model). */
  model: string;
  /** The overall request, for the aggregator's framing. */
  goal: string;
  /** The specific, independent sub-tasks to delegate (1–4). */
  subtasks: string[];
  /** Prior conversation so helpers/aggregator aren't context-blind on follow-ups. */
  messages?: ChatMessage[];
  systemPrompt?: string;
  clientContext?: ChatClientContext;
  fallbackModel?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface RunDelegationResult {
  text: string;
  model: string;
  citations?: ChatCitation[];
  artifacts: ChatArtifact[];
  notices?: CapabilityNotice[];
  usage: ApiUsage;
  trace: SwarmTraceArtifact;
}

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

const mergeUsage = (parts: ApiUsage[]): ApiUsage => {
  const out: ApiUsage = {};
  const keys: (keyof ApiUsage)[] = ['promptTokens', 'candidatesTokens', 'totalTokens', 'estimatedTokens', 'promptChars', 'providerCostUsd'];
  for (const key of keys) {
    let sum = 0;
    let any = false;
    for (const p of parts) {
      const v = p[key];
      if (typeof v === 'number') { sum += v; any = true; }
    }
    if (any) (out as Record<string, number>)[key as string] = sum;
  }
  return out;
};

export const runDelegation = async (params: RunDelegationParams): Promise<RunDelegationResult> => {
  const priorMessages = params.messages?.slice(-12) ?? [];
  const userMemory = params.systemPrompt?.trim();
  const subtasks = params.subtasks.map((s) => s.trim()).filter(Boolean).slice(0, MAX_SUBTASKS);
  const baseReq = {
    provider: params.provider,
    apiKey: params.apiKey,
    timeoutMs: params.timeoutMs,
    fallbackModel: params.fallbackModel ?? TEXT_FALLBACK,
    signal: params.signal
  };
  // Helper agents run on a free model and are web-grounded (OpenRouter native search);
  // the user's chosen model is reserved for the aggregation so the final voice/quality holds.
  const workerModel = await pickTextModel({ preferFree: true }).catch(() => TEXT_FALLBACK);
  const webGrounded = params.provider === 'openrouter';

  const usageParts: ApiUsage[] = [];
  const citations: ChatCitation[] = [];
  const notices: CapabilityNotice[] = [];

  // GATHER — every sub-task in parallel.
  const findings: AgentFinding[] = await Promise.all(
    subtasks.map(async (task, i): Promise<AgentFinding> => {
      const id = `d${i + 1}`;
      const name = `Helper ${i + 1}`;
      try {
        const r = await runChat({
          ...baseReq,
          model: workerModel,
          messages: [...priorMessages, { role: 'user', content: task }],
          systemOverride: userMemory ? `${RESEARCHER_PROMPT}\n\nUser context / preferences:\n${userMemory}` : RESEARCHER_PROMPT,
          clientContext: params.clientContext,
          webSearch: webGrounded,
          temperature: 0.3,
          maxTokens: 900
        });
        usageParts.push(r.usage);
        if (r.citations) citations.push(...r.citations);
        if (r.notices) notices.push(...r.notices);
        return { id, name, task, text: r.text || '', citations: r.citations || [], status: 'done' };
      } catch (err) {
        notices.push({ tool: 'delegate_tasks', level: 'warn', message: `Helper ${i + 1} failed: ${(err as Error)?.message || 'unknown error'}` });
        return { id, name, task, text: '', citations: [], status: 'error' };
      }
    })
  );

  // VERIFY — deterministic confidence/flags per finding (reused from the swarm verifier).
  const verification = verifyFindings(findings);
  const agents: SwarmAgentRun[] = findings.map((f) => {
    const a = verification.assessments.find((x) => x.id === f.id);
    return {
      id: f.id,
      name: f.name,
      task: f.task,
      status: f.status,
      summary: (f.text || '').slice(0, 400),
      confidence: a?.confidence,
      flags: a?.flags
    };
  });
  const trace: SwarmTraceArtifact = { goal: params.goal, agents };

  // AGGREGATE — reconcile every finding into one answer, weighted by the verifier.
  const findingsBlock = findings
    .map((f) => {
      const sources = (f.citations || [])
        .slice(0, 8)
        .map((c, i) => `  [${i + 1}] ${c.title ? `${c.title} — ` : ''}${c.url}`)
        .join('\n');
      return `### ${f.name} — sub-task: ${f.task}\n${f.text || '(no result)'}` + (sources ? `\nSources gathered:\n${sources}` : '');
    })
    .join('\n\n');
  const synthInput =
    `User request: ${params.goal}\n\nFindings from the helper agents:\n\n${findingsBlock}\n\n` +
    `${verificationBlock(findings, verification)}\n\nNow write the single best, accurate answer for the user.`;

  const synthRes = await runChat({
    ...baseReq,
    model: params.model,
    messages: [...priorMessages, { role: 'user', content: synthInput }],
    systemPrompt: userMemory,
    systemOverride: AGGREGATOR_PROMPT,
    clientContext: params.clientContext,
    temperature: 0.5,
    maxTokens: 2048
  });
  usageParts.push(synthRes.usage);
  if (synthRes.citations) citations.push(...synthRes.citations);
  if (synthRes.notices) notices.push(...synthRes.notices);

  const merged = dedupeCitations(citations);
  return {
    text: synthRes.text,
    model: synthRes.model || params.model,
    citations: merged.length ? merged : undefined,
    artifacts: [{ type: 'swarm_trace', data: trace }],
    notices: notices.length ? notices : undefined,
    usage: usageParts.length ? mergeUsage(usageParts) : buildUsage(params.goal, synthRes.text, undefined),
    trace
  };
};
