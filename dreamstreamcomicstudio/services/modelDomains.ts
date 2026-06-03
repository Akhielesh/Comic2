// Domain tagging — what is each model actually GOOD AT?
//
// The old experience only knew modality (text vs image) + a few capability flags, so asking it to
// "pick a model for coding" was hopeless. This layer derives a strength score (0–100) per real-world
// domain — coding, science, math, reasoning, writing, vision, etc. — by combining three signals:
//   1. Curated benchmarks  (HumanEval/SWE-bench → coding, GPQA → science, MATH → math …)  [strongest]
//   2. Live capability flags (vision, image generation, tool use, long context)
//   3. Light id heuristics  (a model literally named "…-coder" leans coding; "aya"/"qwen" → multilingual)
//
// Tags shown in the UI, the domain filters, and the (now domain-aware) Smart auto-pick all read here,
// so a coding task prefers coding-strong models and a physics question prefers GPQA-strong ones.

import type { CatalogModel } from './modelCatalog';
import { getCapabilities } from './modelCapabilities';
import { getModelBenchmarks, normalizeScore, type BenchmarkMetricId } from './modelBenchmarks';

export type DomainId =
  | 'coding'
  | 'science'
  | 'math'
  | 'reasoning'
  | 'writing'
  | 'knowledge'
  | 'vision'
  | 'image_gen'
  | 'multilingual'
  | 'agentic'
  | 'long_context';

export interface DomainMeta {
  id: DomainId;
  label: string;
  /** Plain-language blurb for the tooltip. */
  blurb: string;
  /** Tailwind tone classes for the tag chip. */
  tone: string;
  /** Lucide icon name (resolved in the component). */
  icon: string;
}

export const DOMAIN_META: Record<DomainId, DomainMeta> = {
  coding:       { id: 'coding', label: 'Coding', blurb: 'Writing, fixing and reasoning about code. Backed by HumanEval and SWE-bench (real GitHub bug fixes).', tone: 'bg-emerald-600 text-white', icon: 'Code2' },
  science:      { id: 'science', label: 'Science / Physics', blurb: 'PhD-level science reasoning (physics, chemistry, biology). Backed by GPQA Diamond.', tone: 'bg-cyan-600 text-white', icon: 'Atom' },
  math:         { id: 'math', label: 'Math', blurb: 'Step-by-step mathematical problem solving. Backed by the MATH benchmark.', tone: 'bg-violet-600 text-white', icon: 'Sigma' },
  reasoning:    { id: 'reasoning', label: 'Reasoning', blurb: 'Multi-step logical thinking and planning. Either an explicit "thinking" model or strong on hard reasoning benchmarks.', tone: 'bg-indigo-600 text-white', icon: 'Brain' },
  writing:      { id: 'writing', label: 'Writing', blurb: 'Natural, creative and in-character prose — story, dialogue and copy. Reflected by human-preference Arena rank.', tone: 'bg-rose-600 text-white', icon: 'PenLine' },
  knowledge:    { id: 'knowledge', label: 'General knowledge', blurb: 'Broad factual knowledge across 57 subjects. Backed by MMLU.', tone: 'bg-amber-600 text-white', icon: 'GraduationCap' },
  vision:       { id: 'vision', label: 'Vision', blurb: 'Can look at and understand images you send (read references, describe art, inspect panels).', tone: 'bg-sky-600 text-white', icon: 'Eye' },
  image_gen:    { id: 'image_gen', label: 'Image generation', blurb: 'Creates images from text (and reference images) — the model that actually draws your panels.', tone: 'bg-blue-600 text-white', icon: 'ImageIcon' },
  multilingual: { id: 'multilingual', label: 'Multilingual', blurb: 'Strong across many human languages, not just English.', tone: 'bg-teal-600 text-white', icon: 'Languages' },
  agentic:      { id: 'agentic', label: 'Agents / tools', blurb: 'Can call tools and functions (search, code, APIs) — the basis for autonomous agent workflows.', tone: 'bg-fuchsia-600 text-white', icon: 'Wrench' },
  long_context: { id: 'long_context', label: 'Long context', blurb: 'Can read very large inputs at once (long scripts, whole codebases) without forgetting the start.', tone: 'bg-slate-600 text-white', icon: 'ScrollText' }
};

export interface DomainStrength {
  id: DomainId;
  /** 0–100. */
  strength: number;
  /** Where the score came from, for honest UI attribution. */
  basis: 'benchmark' | 'capability' | 'heuristic';
}

const MULTILINGUAL_RE = /qwen|aya|mistral|mixtral|gemma|llama|deepseek|command-r|nemotron/i;
const CODER_RE = /coder|code|codestral|deepseek-coder/i;

/** Average several benchmark metrics into a single 0–100 strength (ignoring missing ones). */
const bench = (scores: Partial<Record<BenchmarkMetricId, number>>, metrics: BenchmarkMetricId[]): number | null => {
  const vals = metrics.map((m) => (scores[m] != null ? normalizeScore(m, scores[m]!) : null)).filter((v): v is number => v != null);
  if (!vals.length) return null;
  return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
};

/**
 * Full domain-strength profile for a model. Returns every domain it has any strength in,
 * sorted strongest-first. Empty domains are omitted.
 */
export const getModelDomains = (model: CatalogModel): DomainStrength[] => {
  const caps = getCapabilities(model);
  const id = model.id.toLowerCase();
  const bm = getModelBenchmarks(model.id);
  const out: DomainStrength[] = [];
  const push = (domainId: DomainId, strength: number | null, basis: DomainStrength['basis']) => {
    if (strength != null && strength > 0) out.push({ id: domainId, strength: Math.min(100, Math.round(strength)), basis });
  };

  if (bm) {
    let coding = bench(bm.scores, ['humaneval', 'swebench']);
    if (coding != null && CODER_RE.test(id)) coding = Math.min(100, coding + 10); // purpose-built coder bonus
    push('coding', coding, 'benchmark');
    push('science', bench(bm.scores, ['gpqa']), 'benchmark');
    push('math', bench(bm.scores, ['math']), 'benchmark');
    push('knowledge', bench(bm.scores, ['mmlu']), 'benchmark');
    push('writing', bench(bm.scores, ['arena_elo']), 'benchmark');
    // Reasoning blends the explicit flag with hard-benchmark strength (GPQA + MATH).
    const reasonBench = bench(bm.scores, ['gpqa', 'math']);
    const reason = caps.reasoning ? Math.max(75, reasonBench ?? 0) : reasonBench != null ? Math.round(reasonBench * 0.7) : null;
    push('reasoning', reason, caps.reasoning ? 'capability' : 'benchmark');
  } else {
    // No benchmarks: fall back to capability-only signals so the model still tags sensibly.
    if (caps.reasoning) push('reasoning', 80, 'capability');
    if (CODER_RE.test(id)) push('coding', 70, 'heuristic');
  }

  // Capability-derived domains (independent of benchmarks).
  if (caps.imageOutput) push('image_gen', caps.multiImageRefs ? 92 : 78, 'capability');
  if (caps.imageInput && !caps.imageOutput) push('vision', 85, 'capability');
  if (caps.toolUse) push('agentic', 80, 'capability');
  if (caps.longContext) push('long_context', Math.min(100, 60 + Math.round((caps.contextLength - 200_000) / 20_000)), 'capability');
  else if (caps.contextLength >= 128_000) push('long_context', 55, 'capability');
  if (MULTILINGUAL_RE.test(id)) push('multilingual', 70, 'heuristic');

  return out.sort((a, b) => b.strength - a.strength);
};

/** The top domains for compact tag display (strength ≥ threshold), capped to `limit`. */
export const topDomains = (model: CatalogModel, limit = 3, threshold = 55): DomainStrength[] =>
  getModelDomains(model).filter((d) => d.strength >= threshold).slice(0, limit);

/** Single domain strength for a model (0 if none) — used by domain-aware auto-pick. */
export const domainStrength = (model: CatalogModel, domain: DomainId): number =>
  getModelDomains(model).find((d) => d.id === domain)?.strength ?? 0;

/** Domains exposed as Library filters, in display order. */
export const FILTERABLE_DOMAINS: DomainId[] = ['coding', 'science', 'math', 'reasoning', 'writing', 'vision', 'agentic', 'long_context'];
