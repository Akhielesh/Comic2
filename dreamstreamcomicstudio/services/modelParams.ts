// Curated model SIZE / parameter dataset.
//
// The live catalog doesn't carry parameter counts, and most closed models (GPT-4o, Claude,
// Gemini, Grok) never disclose them — so this maps known open-weight families to their published
// sizes. Matched by family regex against the model id (most-specific first), mirroring
// modelBenchmarks. Figures are the makers' published numbers; MoE models list total + active
// params. Unknown / undisclosed models simply return null and the UI omits the size.

export interface ModelSizeInfo {
  family: string;
  /** Display string, e.g. "671B (MoE · 37B active)", "405B", "8B". */
  params: string;
  arch: 'dense' | 'moe' | 'unknown';
}

interface SizeRecord {
  match: RegExp;
  info: ModelSizeInfo;
}

// Ordered most-specific → most-general.
const MODEL_SIZES: SizeRecord[] = [
  // DeepSeek (MoE 671B / 37B active across V3/V3.1/V3.2/R1)
  { match: /deepseek.*(v3|r1|chat|reasoner)/i, info: { family: 'DeepSeek V3 / R1', params: '671B (MoE · 37B active)', arch: 'moe' } },

  // Qwen
  { match: /qwen3.*coder|qwen-3.*coder/i, info: { family: 'Qwen3-Coder', params: '480B (MoE · 35B active)', arch: 'moe' } },
  { match: /qwen3.*235|qwen-3.*235/i, info: { family: 'Qwen3 235B', params: '235B (MoE · 22B active)', arch: 'moe' } },
  { match: /qwen3|qwen-3/i, info: { family: 'Qwen3', params: 'MoE / dense variants', arch: 'moe' } },
  { match: /qwen.*2\.5.*coder|qwen2\.5-coder/i, info: { family: 'Qwen2.5-Coder', params: '0.5B–32B variants', arch: 'dense' } },
  { match: /qwen.*2\.5|qwen2\.5/i, info: { family: 'Qwen2.5', params: '0.5B–72B variants', arch: 'dense' } },
  { match: /qwq/i, info: { family: 'QwQ', params: '32B', arch: 'dense' } },

  // Meta Llama
  { match: /llama[\s_-]?4[\s_-]?maverick/i, info: { family: 'Llama 4 Maverick', params: '400B (MoE · 17B active)', arch: 'moe' } },
  { match: /llama[\s_-]?4[\s_-]?scout/i, info: { family: 'Llama 4 Scout', params: '109B (MoE · 17B active)', arch: 'moe' } },
  { match: /llama[\s_-]?4(?![\d.])/i, info: { family: 'Llama 4', params: 'MoE (17B active)', arch: 'moe' } },
  { match: /llama.*3\.1.*405|llama-3\.1-405/i, info: { family: 'Llama 3.1 405B', params: '405B', arch: 'dense' } },
  { match: /llama.*3\.3|llama-3\.3/i, info: { family: 'Llama 3.3 70B', params: '70B', arch: 'dense' } },
  { match: /llama.*3.*70|llama-3.*70/i, info: { family: 'Llama 3 70B', params: '70B', arch: 'dense' } },
  { match: /llama.*3.*8|llama-3.*8/i, info: { family: 'Llama 3 8B', params: '8B', arch: 'dense' } },

  // Z.ai / Zhipu GLM
  { match: /glm-4\.6|glm-4-6/i, info: { family: 'GLM-4.6', params: '357B (MoE · 32B active)', arch: 'moe' } },
  { match: /glm-4\.5|glm-4-5/i, info: { family: 'GLM-4.5', params: '355B (MoE · 32B active)', arch: 'moe' } },

  // Moonshot / MiniMax / gpt-oss
  { match: /kimi.*k2|kimi-k2/i, info: { family: 'Kimi K2', params: '1T (MoE · 32B active)', arch: 'moe' } },
  { match: /minimax/i, info: { family: 'MiniMax M2', params: '230B (MoE · ~10B active)', arch: 'moe' } },
  { match: /gpt-oss.*120|gpt-oss/i, info: { family: 'GPT-OSS', params: '120B / 20B (MoE)', arch: 'moe' } },

  // Mistral
  { match: /mixtral.*8x22|mixtral-8x22/i, info: { family: 'Mixtral 8x22B', params: '141B (MoE · 39B active)', arch: 'moe' } },
  { match: /mixtral/i, info: { family: 'Mixtral 8x7B', params: '47B (MoE · 13B active)', arch: 'moe' } },
  { match: /mistral.*large/i, info: { family: 'Mistral Large', params: '123B', arch: 'dense' } },
  { match: /codestral/i, info: { family: 'Codestral', params: '22B', arch: 'dense' } },
  { match: /devstral/i, info: { family: 'Devstral', params: '24B', arch: 'dense' } },
  { match: /ministral/i, info: { family: 'Ministral', params: '3B / 8B', arch: 'dense' } },

  // Google / Microsoft / NVIDIA open
  { match: /gemma.*2.*27|gemma-2-27/i, info: { family: 'Gemma 2 27B', params: '27B', arch: 'dense' } },
  { match: /gemma/i, info: { family: 'Gemma', params: '2B / 9B / 27B variants', arch: 'dense' } },
  { match: /phi-4|phi4/i, info: { family: 'Phi-4', params: '14B', arch: 'dense' } },
  { match: /nemotron.*ultra|nemotron.*253/i, info: { family: 'Nemotron Ultra', params: '253B', arch: 'dense' } },
  { match: /nemotron/i, info: { family: 'Nemotron', params: '49B–70B variants', arch: 'dense' } },

  // Image open weights
  { match: /qwen-image|qwen.*image/i, info: { family: 'Qwen-Image', params: '20B (MMDiT)', arch: 'dense' } },
  { match: /flux/i, info: { family: 'FLUX.1', params: '12B', arch: 'dense' } },
];

/** Published size for a model id, or null when undisclosed / unknown (closed models). */
export const getModelSize = (modelId: string): ModelSizeInfo | null => {
  const id = (modelId || '').toLowerCase();
  return MODEL_SIZES.find((r) => r.match.test(id))?.info ?? null;
};
