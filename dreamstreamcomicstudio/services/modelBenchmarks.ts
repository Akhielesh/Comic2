// Curated benchmark dataset for AI models.
//
// There is no clean, free, real-time public API for LLM leaderboards, so this is a hand-curated
// snapshot aggregated from public sources (LMArena, official model cards, Papers-with-Code,
// vendor releases). Every entry carries its SOURCE and an `asOf` date so the UI can attribute it
// honestly — these are point-in-time, approximate figures meant for orientation, not contracts.
// Update them by editing this file (kept deliberately simple, one entry per model family).
//
// Matching is by family regex against the model id, so every concrete variant on OpenRouter /
// NVIDIA that belongs to a known family inherits the family's numbers. Unknown models simply
// return no benchmarks (the UI degrades gracefully).

import type { GlossaryEntry } from './modelGlossary';
import { GLOSSARY } from './modelGlossary';

export type BenchmarkMetricId =
  | 'arena_elo'
  | 'mmlu'
  | 'gpqa'
  | 'humaneval'
  | 'swebench'
  | 'math';

export interface BenchmarkMetric {
  id: BenchmarkMetricId;
  label: string;
  /** Short axis the metric belongs to, for grouping in the UI. */
  category: 'overall' | 'knowledge' | 'science' | 'coding' | 'math';
  /** Glossary key for the hover explanation. */
  glossary: keyof typeof GLOSSARY;
  /** Value at/above which a model is considered top-tier — used to normalise bars to 0–100. */
  topReference: number;
  /** A floor below which models are considered weak — bars normalise between floor and top. */
  floor: number;
  /** Unit suffix for display ('%', 'Elo', ''). */
  unit: string;
}

export const BENCHMARK_METRICS: Record<BenchmarkMetricId, BenchmarkMetric> = {
  arena_elo: { id: 'arena_elo', label: 'Arena Elo', category: 'overall', glossary: 'arena_elo', topReference: 1450, floor: 1000, unit: '' },
  mmlu:      { id: 'mmlu', label: 'MMLU', category: 'knowledge', glossary: 'mmlu', topReference: 92, floor: 55, unit: '%' },
  gpqa:      { id: 'gpqa', label: 'GPQA (science)', category: 'science', glossary: 'gpqa', topReference: 85, floor: 25, unit: '%' },
  humaneval: { id: 'humaneval', label: 'HumanEval (code)', category: 'coding', glossary: 'humaneval', topReference: 96, floor: 40, unit: '%' },
  swebench:  { id: 'swebench', label: 'SWE-bench (real code)', category: 'coding', glossary: 'swebench', topReference: 70, floor: 2, unit: '%' },
  math:      { id: 'math', label: 'MATH', category: 'math', glossary: 'math', topReference: 96, floor: 20, unit: '%' }
};

export interface BenchmarkRecord {
  /** Family matcher against the model id (case-insensitive). First match wins, so order matters. */
  match: RegExp;
  /** Human family label shown in the UI. */
  family: string;
  scores: Partial<Record<BenchmarkMetricId, number>>;
  /** Where these numbers came from, shown to the user. */
  source: string;
  sourceUrl: string;
  /** Point-in-time the snapshot reflects. */
  asOf: string;
}

// Ordered most-specific → most-general so e.g. "qwen-2.5-coder" matches before generic "qwen".
// Numbers are public, widely-reported figures rounded for orientation. Verify at the source link.
export const MODEL_BENCHMARKS: BenchmarkRecord[] = [
  // ── OpenAI ────────────────────────────────────────────────────────────────
  { match: /o3-mini|o4-mini/i, family: 'OpenAI o3/o4-mini (reasoning)',
    scores: { arena_elo: 1325, mmlu: 86, gpqa: 77, humaneval: 95, swebench: 49, math: 95 },
    source: 'OpenAI model card', sourceUrl: 'https://openai.com/index/openai-o3-mini/', asOf: '2025-Q1' },
  { match: /\bo3\b|o1-pro|\bo1\b/i, family: 'OpenAI o1/o3 (reasoning)',
    scores: { arena_elo: 1350, mmlu: 91, gpqa: 83, humaneval: 96, swebench: 71, math: 96 },
    source: 'OpenAI o3 announcement', sourceUrl: 'https://openai.com/index/introducing-o3-and-o4-mini/', asOf: '2025-Q2' },
  { match: /gpt-4\.1/i, family: 'GPT-4.1',
    scores: { arena_elo: 1370, mmlu: 90, gpqa: 67, humaneval: 94, swebench: 55, math: 87 },
    source: 'OpenAI GPT-4.1 release', sourceUrl: 'https://openai.com/index/gpt-4-1/', asOf: '2025-Q2' },
  { match: /gpt-4o/i, family: 'GPT-4o',
    scores: { arena_elo: 1340, mmlu: 88, gpqa: 54, humaneval: 90, swebench: 33, math: 76 },
    source: 'LMArena + OpenAI', sourceUrl: 'https://lmarena.ai/leaderboard', asOf: '2025-Q1' },
  { match: /gpt-4o-mini|gpt-4\.1-mini/i, family: 'GPT-4o mini',
    scores: { arena_elo: 1270, mmlu: 82, gpqa: 40, humaneval: 87, swebench: 20, math: 70 },
    source: 'OpenAI', sourceUrl: 'https://openai.com/index/gpt-4o-mini-advancing-cost-efficient-intelligence/', asOf: '2024-Q3' },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  { match: /claude.*opus|opus.*4|claude-3-opus/i, family: 'Claude Opus',
    scores: { arena_elo: 1380, mmlu: 89, gpqa: 74, humaneval: 95, swebench: 72, math: 90 },
    source: 'Anthropic model card', sourceUrl: 'https://www.anthropic.com/news', asOf: '2025-Q2' },
  { match: /claude.*3\.7|claude-3-7|claude.*sonnet.*4|sonnet-4/i, family: 'Claude 3.7 / Sonnet 4',
    scores: { arena_elo: 1370, mmlu: 89, gpqa: 78, humaneval: 94, swebench: 70, math: 82 },
    source: 'Anthropic Claude 3.7 Sonnet', sourceUrl: 'https://www.anthropic.com/news/claude-3-7-sonnet', asOf: '2025-Q1' },
  { match: /claude.*3\.5|claude-3-5|claude.*sonnet/i, family: 'Claude 3.5 Sonnet',
    scores: { arena_elo: 1300, mmlu: 88, gpqa: 65, humaneval: 92, swebench: 49, math: 78 },
    source: 'Anthropic + LMArena', sourceUrl: 'https://www.anthropic.com/news/claude-3-5-sonnet', asOf: '2024-Q4' },
  { match: /claude.*haiku/i, family: 'Claude Haiku',
    scores: { arena_elo: 1240, mmlu: 81, gpqa: 41, humaneval: 88, swebench: 40, math: 69 },
    source: 'Anthropic', sourceUrl: 'https://www.anthropic.com/news/3-5-models-and-computer-use', asOf: '2024-Q4' },

  // ── Google ────────────────────────────────────────────────────────────────
  { match: /gemini.*2\.5.*pro|gemini-2-5-pro|gemini-3.*pro|gemini-2\.5-pro/i, family: 'Gemini 2.5 Pro',
    scores: { arena_elo: 1440, mmlu: 92, gpqa: 84, humaneval: 95, swebench: 64, math: 92 },
    source: 'Google DeepMind', sourceUrl: 'https://blog.google/technology/google-deepmind/gemini-model-thinking-updates-march-2025/', asOf: '2025-Q2' },
  { match: /gemini.*2\.5.*flash|gemini-2\.5-flash|gemini-2-5-flash/i, family: 'Gemini 2.5 Flash',
    scores: { arena_elo: 1390, mmlu: 88, gpqa: 78, humaneval: 92, swebench: 48, math: 88 },
    source: 'Google DeepMind', sourceUrl: 'https://deepmind.google/technologies/gemini/flash/', asOf: '2025-Q2' },
  { match: /gemini.*2\.0.*flash|gemini-2-0-flash|gemini-2\.0-flash/i, family: 'Gemini 2.0 Flash',
    scores: { arena_elo: 1355, mmlu: 83, gpqa: 62, humaneval: 89, swebench: 34, math: 80 },
    source: 'Google DeepMind', sourceUrl: 'https://blog.google/technology/google-deepmind/google-gemini-ai-update-december-2024/', asOf: '2025-Q1' },
  { match: /gemini.*1\.5.*pro|gemini-1\.5-pro/i, family: 'Gemini 1.5 Pro',
    scores: { arena_elo: 1300, mmlu: 86, gpqa: 59, humaneval: 84, swebench: 19, math: 68 },
    source: 'Google', sourceUrl: 'https://blog.google/technology/ai/google-gemini-next-generation-model-february-2024/', asOf: '2024-Q4' },

  // ── DeepSeek ──────────────────────────────────────────────────────────────
  { match: /deepseek.*r1|deepseek-r1/i, family: 'DeepSeek-R1 (reasoning)',
    scores: { arena_elo: 1360, mmlu: 90, gpqa: 71, humaneval: 96, swebench: 49, math: 95 },
    source: 'DeepSeek-R1 paper', sourceUrl: 'https://github.com/deepseek-ai/DeepSeek-R1', asOf: '2025-Q1' },
  { match: /deepseek.*v3|deepseek-v3|deepseek-chat/i, family: 'DeepSeek-V3',
    scores: { arena_elo: 1320, mmlu: 88, gpqa: 59, humaneval: 92, swebench: 42, math: 90 },
    source: 'DeepSeek-V3 paper', sourceUrl: 'https://github.com/deepseek-ai/DeepSeek-V3', asOf: '2025-Q1' },
  { match: /deepseek/i, family: 'DeepSeek',
    scores: { arena_elo: 1300, mmlu: 86, gpqa: 53, humaneval: 90, swebench: 35, math: 86 },
    source: 'DeepSeek', sourceUrl: 'https://www.deepseek.com/', asOf: '2025-Q1' },

  // ── Meta Llama ────────────────────────────────────────────────────────────
  { match: /llama.*4|llama-4/i, family: 'Llama 4',
    scores: { arena_elo: 1340, mmlu: 86, gpqa: 60, humaneval: 90, swebench: 30, math: 78 },
    source: 'Meta Llama 4', sourceUrl: 'https://ai.meta.com/blog/llama-4-multimodal-intelligence/', asOf: '2025-Q2' },
  { match: /llama.*3\.3|llama-3\.3|llama-3-3/i, family: 'Llama 3.3 70B',
    scores: { arena_elo: 1255, mmlu: 86, gpqa: 50, humaneval: 88, swebench: 25, math: 77 },
    source: 'Meta Llama 3.3', sourceUrl: 'https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct', asOf: '2024-Q4' },
  { match: /llama.*3\.1.*405|llama-3\.1-405/i, family: 'Llama 3.1 405B',
    scores: { arena_elo: 1270, mmlu: 88, gpqa: 51, humaneval: 89, swebench: 28, math: 74 },
    source: 'Meta Llama 3.1', sourceUrl: 'https://ai.meta.com/blog/meta-llama-3-1/', asOf: '2024-Q3' },
  { match: /llama.*3\.1|llama-3\.1|llama-3-1/i, family: 'Llama 3.1 (70B/8B)',
    scores: { arena_elo: 1210, mmlu: 83, gpqa: 41, humaneval: 80, swebench: 14, math: 68 },
    source: 'Meta Llama 3.1', sourceUrl: 'https://ai.meta.com/blog/meta-llama-3-1/', asOf: '2024-Q3' },
  { match: /llama/i, family: 'Llama',
    scores: { arena_elo: 1180, mmlu: 80, gpqa: 36, humaneval: 75, swebench: 10, math: 55 },
    source: 'Meta', sourceUrl: 'https://ai.meta.com/llama/', asOf: '2024-Q3' },

  // ── Qwen / Alibaba ────────────────────────────────────────────────────────
  { match: /qwen.*coder|qwen2\.5-coder|qwen-2\.5-coder/i, family: 'Qwen2.5-Coder',
    scores: { arena_elo: 1270, mmlu: 80, gpqa: 42, humaneval: 92, swebench: 38, math: 75 },
    source: 'Qwen2.5-Coder', sourceUrl: 'https://qwenlm.github.io/blog/qwen2.5-coder-family/', asOf: '2024-Q4' },
  { match: /qwq|qwen.*qwq/i, family: 'QwQ (reasoning)',
    scores: { arena_elo: 1290, mmlu: 84, gpqa: 65, humaneval: 88, swebench: 40, math: 90 },
    source: 'Qwen QwQ', sourceUrl: 'https://qwenlm.github.io/blog/qwq-32b-preview/', asOf: '2025-Q1' },
  { match: /qwen.*2\.5|qwen2\.5|qwen-2\.5/i, family: 'Qwen2.5',
    scores: { arena_elo: 1260, mmlu: 85, gpqa: 49, humaneval: 86, swebench: 24, math: 83 },
    source: 'Qwen2.5', sourceUrl: 'https://qwenlm.github.io/blog/qwen2.5/', asOf: '2024-Q4' },
  { match: /qwen/i, family: 'Qwen',
    scores: { arena_elo: 1230, mmlu: 82, gpqa: 44, humaneval: 82, swebench: 18, math: 78 },
    source: 'Qwen', sourceUrl: 'https://qwenlm.github.io/', asOf: '2024-Q4' },

  // ── Mistral ───────────────────────────────────────────────────────────────
  { match: /mistral.*large|mistral-large/i, family: 'Mistral Large',
    scores: { arena_elo: 1250, mmlu: 84, gpqa: 48, humaneval: 85, swebench: 20, math: 72 },
    source: 'Mistral AI', sourceUrl: 'https://mistral.ai/news/mistral-large-2407/', asOf: '2024-Q4' },
  { match: /mixtral/i, family: 'Mixtral (MoE)',
    scores: { arena_elo: 1190, mmlu: 78, gpqa: 35, humaneval: 75, swebench: 8, math: 50 },
    source: 'Mistral AI', sourceUrl: 'https://mistral.ai/news/mixtral-of-experts/', asOf: '2024-Q2' },
  { match: /mistral|magistral|ministral/i, family: 'Mistral',
    scores: { arena_elo: 1170, mmlu: 75, gpqa: 33, humaneval: 72, swebench: 7, math: 52 },
    source: 'Mistral AI', sourceUrl: 'https://mistral.ai/', asOf: '2024-Q4' },

  // ── Others ────────────────────────────────────────────────────────────────
  { match: /grok-3|grok3/i, family: 'Grok 3',
    scores: { arena_elo: 1400, mmlu: 90, gpqa: 75, humaneval: 93, swebench: 45, math: 93 },
    source: 'xAI Grok 3', sourceUrl: 'https://x.ai/news/grok-3', asOf: '2025-Q1' },
  { match: /gemma.*2|gemma-2/i, family: 'Gemma 2',
    scores: { arena_elo: 1190, mmlu: 75, gpqa: 33, humaneval: 70, swebench: 5, math: 48 },
    source: 'Google Gemma 2', sourceUrl: 'https://blog.google/technology/developers/google-gemma-2/', asOf: '2024-Q3' },
  { match: /phi-4|phi4/i, family: 'Phi-4',
    scores: { arena_elo: 1200, mmlu: 85, gpqa: 56, humaneval: 83, swebench: 12, math: 80 },
    source: 'Microsoft Phi-4', sourceUrl: 'https://www.microsoft.com/en-us/research/blog/phi-4/', asOf: '2025-Q1' },
  { match: /nemotron/i, family: 'NVIDIA Nemotron',
    scores: { arena_elo: 1270, mmlu: 85, gpqa: 50, humaneval: 86, swebench: 22, math: 80 },
    source: 'NVIDIA Nemotron', sourceUrl: 'https://build.nvidia.com/', asOf: '2025-Q1' }
];

export interface ModelBenchmarks {
  family: string;
  scores: Partial<Record<BenchmarkMetricId, number>>;
  source: string;
  sourceUrl: string;
  asOf: string;
}

/** Look up the benchmark snapshot for a model id by family, or null if we have none. */
export const getModelBenchmarks = (modelId: string): ModelBenchmarks | null => {
  const id = modelId.toLowerCase();
  const rec = MODEL_BENCHMARKS.find((r) => r.match.test(id));
  if (!rec) return null;
  return { family: rec.family, scores: rec.scores, source: rec.source, sourceUrl: rec.sourceUrl, asOf: rec.asOf };
};

/** Normalise a raw benchmark value to a 0–100 bar height, clamped, using the metric's floor/top. */
export const normalizeScore = (metric: BenchmarkMetricId, value: number): number => {
  const m = BENCHMARK_METRICS[metric];
  if (!m) return 0;
  const pct = ((value - m.floor) / (m.topReference - m.floor)) * 100;
  return Math.max(2, Math.min(100, Math.round(pct)));
};

/** Format a benchmark value for display, with its unit. */
export const formatScore = (metric: BenchmarkMetricId, value: number): string => {
  const m = BENCHMARK_METRICS[metric];
  if (!m) return String(value);
  return m.unit === '%' ? `${value}%` : m.unit ? `${value} ${m.unit}` : String(value);
};

export type { GlossaryEntry };
