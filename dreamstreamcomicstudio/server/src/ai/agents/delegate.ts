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
import { buildUsage, spentUsageOf, withSpentUsage, type MeteredUsage } from '../usage.js';
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
  /**
   * Free-only (the client's X-Free-Only), as RunSwarmParams.noPaidRetry: no provider-level `fallbackModel`
   * is sent, every call's own retry stays free (`freeOnly` on the provider request), and the helpers run on
   * a verified-free model — the caller's own (already priced) model when none is free, never TEXT_FALLBACK.
   */
  noPaidRetry?: boolean;
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

// Combine token/cost usage across every helper and the aggregator so billing settles on the
// delegation's true footprint. The exact `providerCostUsd` is kept only when EVERY part reported
// one — a partial sum would be settled as if it were the whole bill; otherwise what was reported
// survives as `partialProviderCostUsd`, the floor the settle never goes below (ai/usage.ts).
const mergeUsage = (parts: ApiUsage[]): MeteredUsage => {
  const out: MeteredUsage = {};
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  for (const key of ['promptTokens', 'candidatesTokens', 'totalTokens', 'estimatedTokens', 'promptChars'] as const) {
    let sum = 0;
    let any = false;
    for (const p of parts) {
      const v = num(p[key]);
      if (v !== undefined) {
        sum += v;
        any = true;
      }
    }
    if (any) out[key] = sum;
  }
  let reported = 0;
  let complete = parts.length > 0;
  for (const p of parts) {
    const cost = num(p.providerCostUsd);
    if (cost !== undefined) {
      reported += cost;
      continue;
    }
    complete = false;
    const partial = num((p as MeteredUsage).partialProviderCostUsd);
    if (partial !== undefined) reported += partial;
  }
  const rounded = Math.round(reported * 1e9) / 1e9;
  if (complete) out.providerCostUsd = rounded;
  else if (rounded > 0) out.partialProviderCostUsd = rounded;
  return out;
};

/** Add what a failed call had already spent (ai/usage.ts spentUsageOf) to the run's usage parts. */
const pushSpent = (parts: ApiUsage[], err: unknown) => {
  const spent = spentUsageOf(err);
  if (spent) parts.push(spent);
};

/** True when a merged usage holds anything worth settling. */
const hasUsage = (u: MeteredUsage): boolean =>
  (u.providerCostUsd ?? 0) > 0 || (u.partialProviderCostUsd ?? 0) > 0 || (u.totalTokens ?? 0) > 0 || (u.estimatedTokens ?? 0) > 0;

/**
 * The delegation run. `usageParts` collects every part's usage (each helper, failed ones
 * included, and the aggregator) and is shared with the exported wrapper, so a throw after the
 * first model call still carries the spend to the chat turn's settle.
 */
const runDelegationWith = async (params: RunDelegationParams, usageParts: ApiUsage[]): Promise<RunDelegationResult> => {
  const priorMessages = params.messages?.slice(-12) ?? [];
  const userMemory = params.systemPrompt?.trim();
  const subtasks = params.subtasks.map((s) => s.trim()).filter(Boolean).slice(0, MAX_SUBTASKS);
  const freeOnly = params.noPaidRetry === true;
  const baseReq = {
    provider: params.provider,
    apiKey: params.apiKey,
    timeoutMs: params.timeoutMs,
    fallbackModel: freeOnly ? undefined : (params.fallbackModel ?? TEXT_FALLBACK),
    ...(freeOnly ? { noPaidRetry: true } : {}),
    signal: params.signal
  };
  // Helper agents run on a free model and are web-grounded (OpenRouter native search);
  // the user's chosen model is reserved for the aggregation so the final voice/quality holds.
  // Free-only never falls back to a paid pick: a verified-free model, else the caller's own model.
  const workerModel = freeOnly
    ? await pickTextModel({ costPref: 'free-only' }).catch(() => params.model)
    : await pickTextModel({ preferFree: true }).catch(() => TEXT_FALLBACK);
  const webGrounded = params.provider === 'openrouter';

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
        // What the failed helper had already spent still bills.
        pushSpent(usageParts, err);
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

/**
 * Run a delegation. `result.usage` sums every model call the run made (each helper, failed ones
 * included, and the aggregator). If the run throws after spending (the aggregation failed), the
 * error carries the merged spend (ai/usage.ts spentUsageOf), so the chat turn settles it instead
 * of releasing its hold over real spend.
 */
export const runDelegation = async (params: RunDelegationParams): Promise<RunDelegationResult> => {
  const usageParts: ApiUsage[] = [];
  try {
    return await runDelegationWith(params, usageParts);
  } catch (err) {
    pushSpent(usageParts, err);
    const spent = mergeUsage(usageParts);
    throw hasUsage(spent) ? withSpentUsage(err, spent) : err;
  }
};
