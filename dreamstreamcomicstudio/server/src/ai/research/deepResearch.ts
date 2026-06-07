// Deep Research engine — a real iterative, citation-grounded research pipeline.
//
// The old "deep research" was a single shallow swarm pass: two agents each did one
// runChat over the bare goal, so the brief read like a quick web summary. This engine
// does what a researcher actually does:
//   1. PLAN   — decompose the topic into specific, non-overlapping sub-questions.
//   2. GATHER — run a focused web search per sub-question IN PARALLEL, collecting real
//               sources (title/url/snippet).
//   3. GAP    — (exhaustive) re-search any sub-question that came back thin.
//   4. GROUND — number every unique source, then synthesize a structured brief that
//               cites those sources inline as [n] — the answer is grounded in fetched
//               evidence, never free-written from memory and dressed up as "researched".
//
// Progress is reported as a SwarmTraceArtifact (one step per sub-question) so the
// existing live-trace UI shows the investigation executing. Honest by construction:
// if no sources can be retrieved, it says so instead of fabricating a brief.

import { runChat } from '../chat.js';
import { webSearch } from '../tools/search.js';
import { coerceJsonOrNull } from '../jsonCoerce.js';
import { pickTextModel, TEXT_FALLBACK } from '../autoRouter.js';
import { composePersona } from '../persona.js';
import type { ChatMessage, AIProviderId } from '../providers/types.js';
import type {
  ApiUsage,
  ChatCitation,
  ChatToolEvent,
  CapabilityNotice,
  SwarmTraceArtifact,
  SwarmAgentRun
} from '../../../../apiTypes.js';

export type ResearchDepth = 'quick' | 'standard' | 'exhaustive';

export interface DeepResearchParams {
  topic: string;
  audience?: string;
  depth?: ResearchDepth;
  provider: AIProviderId;
  apiKey: string;
  /** Synthesis model (the user's chosen model). Planning/searching are model-light. */
  model: string;
  priorMessages?: ChatMessage[];
  /** Durable user memory/persona to thread into synthesis. */
  systemPrompt?: string;
  fallbackModel?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onDelta?: (delta: { content?: string; reasoning?: string }) => void;
  onProgress?: (trace: SwarmTraceArtifact) => void;
}

export interface DeepResearchResult {
  text: string;
  model: string;
  citations?: ChatCitation[];
  toolEvents?: ChatToolEvent[];
  usage: ApiUsage;
  notices?: CapabilityNotice[];
  trace: SwarmTraceArtifact;
}

const DEPTH: Record<ResearchDepth, { questions: number; perQuery: number; gap: boolean; synthTokens: number }> = {
  quick: { questions: 3, perQuery: 5, gap: false, synthTokens: 3000 },
  standard: { questions: 5, perQuery: 6, gap: false, synthTokens: 4000 },
  exhaustive: { questions: 8, perQuery: 6, gap: true, synthTokens: 6000 }
};

const PLANNER = `You are a meticulous research lead planning a deep-research investigation. Decompose the user's TOPIC into the most information-rich, NON-overlapping sub-questions a researcher must answer to produce a rigorous, decision-ready brief. Across the set, cover (only those that fit the topic): core facts/definitions, current state & latest developments, key players/options, hard evidence/data/numbers, comparisons & trade-offs, risks/criticisms/controversies, and outlook. Each sub-question must be SPECIFIC and independently searchable (a good web query). Return ONLY a JSON array of strings — the questions — and nothing else.`;

const SYNTH = composePersona(
  `You are a senior research analyst writing a rigorous, decision-ready RESEARCH BRIEF grounded ONLY in the numbered EVIDENCE provided.
Rules:
- Cite sources inline as [n] (the evidence numbers) immediately after the claim they support. Every non-obvious factual claim, figure or quote needs a citation.
- Structure the brief with GitHub-flavored Markdown: a tight one-paragraph **Bottom line** first; then **Key findings** as sections with clear headings and crisp prose/bullets; then **Risks & open questions**; then a **Sources** section as a numbered Markdown list in the form "[n] Title — URL".
- Synthesize and RECONCILE across sources; prefer the most reputable and most recent, and when sources conflict say so explicitly.
- Be specific and quantitative wherever the evidence allows, and include dates. If the evidence does not cover something important, say so plainly — NEVER invent facts, numbers, sources or citation numbers beyond the evidence.
- Lead with signal; no filler, no "as an AI" preamble, no restating the question.`
);

const mergeUsage = (parts: ApiUsage[]): ApiUsage => {
  const out: ApiUsage = {};
  const keys: (keyof ApiUsage)[] = [
    'promptTokens',
    'candidatesTokens',
    'totalTokens',
    'estimatedTokens',
    'promptChars',
    'providerCostUsd'
  ];
  for (const key of keys) {
    let sum = 0;
    let any = false;
    for (const p of parts) {
      const v = p[key];
      if (typeof v === 'number') {
        sum += v;
        any = true;
      }
    }
    if (any) (out as Record<string, number>)[key as string] = sum;
  }
  return out;
};

export const runDeepResearch = async (p: DeepResearchParams): Promise<DeepResearchResult> => {
  const cfg = DEPTH[p.depth ?? 'standard'] ?? DEPTH.standard;
  const topic = p.topic.trim();
  const usageParts: ApiUsage[] = [];
  const toolEvents: ChatToolEvent[] = [];
  const workerModel = await pickTextModel({ preferFree: true }).catch(() => TEXT_FALLBACK);
  const baseReq = {
    provider: p.provider,
    apiKey: p.apiKey,
    fallbackModel: p.fallbackModel ?? TEXT_FALLBACK,
    timeoutMs: p.timeoutMs,
    signal: p.signal
  };

  // A swarm-trace-shaped progress object so the existing live-trace card renders the run.
  const steps: SwarmAgentRun[] = [];
  const trace = (): SwarmTraceArtifact => ({ goal: `Researching: ${topic}`, agents: steps.map((s) => ({ ...s })) });
  const emit = () => p.onProgress?.(trace());

  // 1) PLAN sub-questions.
  let questions: string[] = [];
  try {
    const planRes = await runChat({
      ...baseReq,
      model: workerModel,
      systemOverride: PLANNER,
      messages: [...(p.priorMessages || []), { role: 'user', content: `TOPIC: ${topic}\n\nProduce exactly ${cfg.questions} sub-questions.` }],
      temperature: 0.3,
      maxTokens: 700
    });
    usageParts.push(planRes.usage);
    const parsed = coerceJsonOrNull(planRes.text);
    if (Array.isArray(parsed)) {
      questions = parsed
        .filter((q): q is string => typeof q === 'string' && q.trim().length > 0)
        .map((q) => q.trim());
    }
  } catch {
    /* fall back to the bare topic below */
  }
  questions = questions.slice(0, cfg.questions);
  if (!questions.length) questions = [topic];

  for (const q of questions) steps.push({ id: `q${steps.length}`, name: 'Research', task: q, status: 'pending' });
  emit();

  // 2) GATHER (round 1) — one focused search per sub-question, in parallel.
  interface Finding {
    question: string;
    results: { title: string; url: string; snippet: string }[];
  }
  const gather = async (q: string, idx: number): Promise<Finding> => {
    steps[idx] = { ...steps[idx], status: 'running' };
    emit();
    const out = await webSearch(q, p.signal, cfg.perQuery).catch(
      () => ({ results: [] as { title: string; url: string; snippet: string }[], provider: 'none', tried: [], status: 'error' as const })
    );
    toolEvents.push({ tool: 'web_search', query: q, ok: out.status === 'ok', summary: `${out.results.length} sources` });
    steps[idx] = {
      ...steps[idx],
      status: 'done',
      summary: out.results.length ? `${out.results.length} sources` : 'no sources',
      ...(out.results.length ? {} : { flags: ['no_sources'] })
    };
    emit();
    return { question: q, results: out.results };
  };
  const findings = await Promise.all(questions.map((q, i) => gather(q, i)));

  // 3) GAP round (exhaustive) — re-search sub-questions that came back thin.
  if (cfg.gap) {
    const weak = findings.map((f, i) => ({ f, i })).filter(({ f }) => f.results.length < 2);
    await Promise.all(
      weak.map(async ({ f, i }) => {
        const refined = `${f.question} ${topic}`;
        const out = await webSearch(refined, p.signal, cfg.perQuery).catch(
          () => ({ results: [] as { title: string; url: string; snippet: string }[], provider: 'none', tried: [], status: 'error' as const })
        );
        toolEvents.push({ tool: 'web_search', query: refined, ok: out.status === 'ok', summary: `${out.results.length} sources (gap)` });
        if (out.results.length) findings[i] = { ...f, results: [...f.results, ...out.results] };
      })
    );
  }

  // Number every UNIQUE source (dedupe by url) so the brief can cite [n] stably.
  const byUrl = new Map<string, number>();
  const sources: { n: number; title: string; url: string }[] = [];
  const num = (r: { title: string; url: string }): number => {
    const existing = byUrl.get(r.url);
    if (existing) return existing;
    const n = sources.length + 1;
    byUrl.set(r.url, n);
    sources.push({ n, title: r.title || r.url, url: r.url });
    return n;
  };

  const evidence = findings
    .map((f) => {
      if (!f.results.length) return `Q: ${f.question}\n  (no sources found)`;
      const lines = f.results
        .map((r) => `  [${num(r)}] ${r.title} — ${r.url}\n      ${(r.snippet || '').replace(/\s+/g, ' ').slice(0, 320)}`)
        .join('\n');
      return `Q: ${f.question}\n${lines}`;
    })
    .join('\n\n');

  // Honest failure: no grounding → don't write a brief from memory and call it research.
  if (!sources.length) {
    return {
      text:
        `I couldn't retrieve live sources for **${topic}** right now — web search appears to be unavailable. ` +
        `Rather than write a brief from memory and present it as researched, I've stopped here. Please try again shortly.`,
      model: p.model,
      usage: mergeUsage(usageParts),
      notices: [{ tool: 'deep_research', level: 'error', message: 'Web search returned no sources — the research could not be grounded.' }],
      trace: trace()
    };
  }

  // 4) SYNTHESIZE — grounded, structured, streamed.
  const audience = p.audience || 'a busy executive';
  const synthUser =
    `TOPIC: ${topic}\nAUDIENCE: ${audience}\nDEPTH: ${p.depth ?? 'standard'}\n\n` +
    `NUMBERED EVIDENCE — cite these as [n]:\n${evidence}\n\n` +
    `Write the research brief now. Cite inline as [n] and end with the numbered **Sources** list.`;
  const synth = await runChat({
    ...baseReq,
    model: p.model,
    systemOverride: [SYNTH, p.systemPrompt?.trim()].filter(Boolean).join('\n\n'),
    messages: [...(p.priorMessages || []), { role: 'user', content: synthUser }],
    temperature: 0.4,
    maxTokens: cfg.synthTokens,
    onDelta: p.onDelta
  });
  usageParts.push(synth.usage);

  return {
    text: synth.text,
    model: synth.model || p.model,
    citations: sources.map((s) => ({ url: s.url, title: s.title })),
    toolEvents,
    usage: mergeUsage(usageParts),
    trace: trace()
  };
};
