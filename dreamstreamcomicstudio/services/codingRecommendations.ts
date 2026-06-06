// Curated "best coding models" shortlist for Code Studio.
//
// The Library/leaderboard ranks the LIVE catalog objectively (see modelDomains coding score),
// but users also asked a simpler question: "just tell me the best open/free coders I can use
// from OpenRouter + NVIDIA." This is that hand-curated, source-attributed answer — a small,
// honest shortlist we can surface as "Recommended" chips in the leaderboard and the Code Studio
// settings, and use to bias the studio's free-first auto-pick toward proven coders.
//
// Numbers are SWE-bench Verified (real GitHub bug-fixing) point-in-time figures from public
// leaderboards (swebench.com, llm-stats.com, vendor cards). They are approximate and meant for
// orientation — verify at the source links in modelBenchmarks.ts / modelLinks.ts.

import type { ModelSource } from './modelCatalog';

export type CodingTier = 'flagship' | 'strong' | 'lightweight';

export interface CodingPick {
  /** Stable key for UI lists. */
  key: string;
  /** Human label. */
  label: string;
  /** Family/vendor for grouping. */
  vendor: string;
  /** Matches concrete catalog ids (any source, with/without :free) by family. */
  match: RegExp;
  /** Representative OpenRouter id (best-effort; the live catalog is the source of truth). */
  openrouterId?: string;
  /** Representative NVIDIA Build id (best-effort). */
  nvidiaId?: string;
  /** Sources that typically host this family. */
  sources: ModelSource[];
  /** True when a genuinely-free variant is commonly available (e.g. an OpenRouter :free or NVIDIA free tier). */
  hasFreeVariant: boolean;
  tier: CodingTier;
  /** Approx context window (K tokens) for the headline variant. */
  contextK: number;
  /** Approx SWE-bench Verified %, for orientation. */
  swebench?: number;
  /** One-line "why pick this" for the UI. */
  blurb: string;
}

// Best-first. Flagship = frontier-class open coders; strong = very capable; lightweight = fast/cheap.
export const CODING_RECOMMENDATIONS: CodingPick[] = [
  {
    key: 'qwen3-coder',
    label: 'Qwen3-Coder 480B',
    vendor: 'Alibaba Qwen',
    match: /qwen3.*coder|qwen-3.*coder/i,
    openrouterId: 'qwen/qwen3-coder',
    nvidiaId: 'qwen/qwen3-coder-480b-a35b-instruct',
    sources: ['openrouter', 'nvidia'],
    hasFreeVariant: true,
    tier: 'flagship',
    contextK: 262,
    swebench: 67,
    blurb: 'Purpose-built open agentic coder — huge context, state-of-the-art open code generation. The default pick for building apps.'
  },
  {
    key: 'deepseek-v3',
    label: 'DeepSeek V3.1 / V3.2',
    vendor: 'DeepSeek',
    match: /deepseek.*v3\.[12]|deepseek-v3\.[12]|deepseek.*terminus|deepseek-chat/i,
    openrouterId: 'deepseek/deepseek-chat-v3.1',
    nvidiaId: 'deepseek-ai/deepseek-v3.1',
    sources: ['openrouter', 'nvidia'],
    hasFreeVariant: true,
    tier: 'flagship',
    contextK: 164,
    swebench: 67,
    blurb: 'Reasoning-heavy open MoE that excels at complex, multi-file changes. Free variants are widely available.'
  },
  {
    key: 'glm-4.6',
    label: 'GLM-4.6',
    vendor: 'Z.ai (Zhipu)',
    match: /glm-4\.6|glm-4\.5|glm.*4\.[56]/i,
    openrouterId: 'z-ai/glm-4.6',
    sources: ['openrouter'],
    hasFreeVariant: true,
    tier: 'flagship',
    contextK: 200,
    swebench: 68,
    blurb: 'Strongest all-round open coder for long-horizon agentic engineering. GLM-4.5-Air has a free tier.'
  },
  {
    key: 'minimax-m2',
    label: 'MiniMax M2',
    vendor: 'MiniMax',
    match: /minimax/i,
    openrouterId: 'minimax/minimax-m2',
    nvidiaId: 'minimaxai/minimax-m2',
    sources: ['openrouter', 'nvidia'],
    hasFreeVariant: true,
    tier: 'flagship',
    contextK: 200,
    swebench: 69,
    blurb: 'Efficient open coder that competes with paid frontier models on real SWE-bench tasks.'
  },
  {
    key: 'kimi-k2',
    label: 'Kimi K2',
    vendor: 'Moonshot AI',
    match: /kimi.*k2|kimi-k2|moonshot/i,
    openrouterId: 'moonshotai/kimi-k2',
    nvidiaId: 'moonshotai/kimi-k2-instruct',
    sources: ['openrouter', 'nvidia'],
    hasFreeVariant: true,
    tier: 'strong',
    contextK: 128,
    swebench: 66,
    blurb: 'Open trillion-param MoE with excellent tool use — great for agentic, function-calling builds.'
  },
  {
    key: 'gpt-oss-120b',
    label: 'GPT-OSS 120B',
    vendor: 'OpenAI (open-weight)',
    match: /gpt-oss/i,
    openrouterId: 'openai/gpt-oss-120b',
    nvidiaId: 'openai/gpt-oss-120b',
    sources: ['openrouter', 'nvidia'],
    hasFreeVariant: true,
    tier: 'strong',
    contextK: 131,
    swebench: 55,
    blurb: "OpenAI's open-weight model — strong reasoning/math, solid coding, and a generous free tier."
  },
  {
    key: 'deepseek-r1',
    label: 'DeepSeek R1',
    vendor: 'DeepSeek',
    match: /deepseek.*r1|deepseek-r1/i,
    openrouterId: 'deepseek/deepseek-r1',
    nvidiaId: 'deepseek-ai/deepseek-r1',
    sources: ['openrouter', 'nvidia'],
    hasFreeVariant: true,
    tier: 'strong',
    contextK: 128,
    swebench: 57,
    blurb: 'Open reasoning model that shows its full chain-of-thought — useful for debugging tricky logic.'
  },
  {
    key: 'devstral',
    label: 'Devstral',
    vendor: 'Mistral',
    match: /devstral/i,
    openrouterId: 'mistralai/devstral-small',
    sources: ['openrouter'],
    hasFreeVariant: true,
    tier: 'strong',
    contextK: 128,
    swebench: 53,
    blurb: 'Agentic coder tuned for tool-driven workflows (Aider/Cline-style). Light enough to run cheaply.'
  },
  {
    key: 'qwen25-coder',
    label: 'Qwen2.5-Coder 32B',
    vendor: 'Alibaba Qwen',
    match: /qwen.*coder|qwen2\.5-coder/i,
    openrouterId: 'qwen/qwen-2.5-coder-32b-instruct',
    sources: ['openrouter', 'nvidia'],
    hasFreeVariant: true,
    tier: 'lightweight',
    contextK: 128,
    swebench: 38,
    blurb: 'Fast, reliable open coder with a free tier — a great low-cost default for smaller apps.'
  },
  {
    key: 'llama-3.3-70b',
    label: 'Llama 3.3 70B',
    vendor: 'Meta',
    match: /llama.*3\.3|llama-3\.3/i,
    openrouterId: 'meta-llama/llama-3.3-70b-instruct',
    nvidiaId: 'meta/llama-3.3-70b-instruct',
    sources: ['openrouter', 'nvidia'],
    hasFreeVariant: true,
    tier: 'lightweight',
    contextK: 131,
    swebench: 25,
    blurb: 'Dependable open generalist with broad free availability — fine for straightforward UI/code tasks.'
  },
  {
    key: 'nemotron',
    label: 'Llama Nemotron / Mistral Nemotron',
    vendor: 'NVIDIA',
    match: /nemotron/i,
    nvidiaId: 'nvidia/llama-3.3-nemotron-super-49b-v1',
    sources: ['nvidia'],
    hasFreeVariant: true,
    tier: 'lightweight',
    contextK: 128,
    swebench: 22,
    blurb: "NVIDIA's instruction/function-calling tuned models — free on NVIDIA Build, good for agentic tooling."
  }
];

/** The recommended-coder entry matching a concrete model id, or null. */
export const recommendedCodingMatch = (modelId: string): CodingPick | null => {
  const id = (modelId || '').toLowerCase();
  return CODING_RECOMMENDATIONS.find((p) => p.match.test(id)) ?? null;
};

/** True when a concrete model id belongs to a curated recommended coding family. */
export const isRecommendedCoder = (modelId: string): boolean => recommendedCodingMatch(modelId) != null;

export const TIER_LABEL: Record<CodingTier, string> = {
  flagship: 'Flagship',
  strong: 'Strong',
  lightweight: 'Lightweight'
};
