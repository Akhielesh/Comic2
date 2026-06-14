// Curated, accurate-as-of-knowledge-cutoff model lists for the direct BYOK providers.
//
// WHY: most provider APIs either don't expose a public /models endpoint, or expose one
// that returns bare ids with no pricing/context/capabilities. To give the Model Library
// and chat picker rich, honest information (price, context, vision/reasoning) WITHOUT a
// live key, every direct provider ships a curated seed list here. When a key IS present,
// the live /models call (where available) is merged ON TOP and de-duplicated, so newly
// released ids still appear even if this list lags.
//
// Pricing is the published list price per 1M tokens (USD). These are reference figures —
// the provider's own billing is always authoritative.

import { classifyModel } from '../../../../shared/pricing.js';
import type { CatalogModel, AIProviderId } from './types.js';

type Seed = {
  id: string;
  name: string;
  /** Context window (tokens). */
  ctx: number;
  /** USD per 1M input tokens. */
  inM: number;
  /** USD per 1M output tokens. */
  outM: number;
  vision?: boolean;
  reasoning?: boolean;
  /** Defaults to true for text models (most support JSON / response_format). */
  json?: boolean;
  desc?: string;
  /** Approx. release date (drives "newest" sort). */
  created?: number;
};

const ts = (y: number, m: number, d = 1): number => Math.floor(Date.UTC(y, m - 1, d) / 1000);

const toModel = (source: AIProviderId, s: Seed): CatalogModel => {
  const pricing = {
    promptPerToken: s.inM / 1_000_000,
    completionPerToken: s.outM / 1_000_000,
    imagePerImage: 0,
    requestFlat: 0
  };
  const costClass = classifyModel({ modelId: s.id, pricing, supportsImageOutput: false });
  const supportedParameters: string[] = [];
  if (s.json !== false) supportedParameters.push('response_format');
  if (s.reasoning) supportedParameters.push('reasoning');
  return {
    id: s.id,
    name: s.name,
    source,
    description: s.desc,
    contextLength: s.ctx,
    createdAt: s.created,
    inputModalities: s.vision ? ['text', 'image'] : ['text'],
    outputModalities: ['text'],
    supportedParameters,
    pricing,
    isFree: costClass === 'free_verified',
    costClass,
    supportsImageOutput: false,
    supportsImageInput: Boolean(s.vision),
    supportsJsonOutput: s.json !== false
  };
};

const SEEDS: Partial<Record<AIProviderId, Seed[]>> = {
  openai: [
    { id: 'gpt-5', name: 'GPT-5', ctx: 400_000, inM: 1.25, outM: 10, vision: true, reasoning: true, created: ts(2025, 8, 7), desc: 'OpenAI flagship — strongest reasoning, coding and agentic work.' },
    { id: 'gpt-5-mini', name: 'GPT-5 mini', ctx: 400_000, inM: 0.25, outM: 2, vision: true, reasoning: true, created: ts(2025, 8, 7), desc: 'Faster, cheaper GPT-5 for everyday tasks.' },
    { id: 'gpt-5-nano', name: 'GPT-5 nano', ctx: 400_000, inM: 0.05, outM: 0.4, vision: true, created: ts(2025, 8, 7), desc: 'Lowest-latency GPT-5 tier for high-volume work.' },
    { id: 'gpt-4.1', name: 'GPT-4.1', ctx: 1_000_000, inM: 2, outM: 8, vision: true, created: ts(2025, 4, 14), desc: '1M-token context, excellent instruction following.' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 mini', ctx: 1_000_000, inM: 0.4, outM: 1.6, vision: true, created: ts(2025, 4, 14) },
    { id: 'gpt-4o', name: 'GPT-4o', ctx: 128_000, inM: 2.5, outM: 10, vision: true, created: ts(2024, 5, 13), desc: 'Omni multimodal model — text + vision.' },
    { id: 'gpt-4o-mini', name: 'GPT-4o mini', ctx: 128_000, inM: 0.15, outM: 0.6, vision: true, created: ts(2024, 7, 18) },
    { id: 'o4-mini', name: 'o4-mini', ctx: 200_000, inM: 1.1, outM: 4.4, vision: true, reasoning: true, created: ts(2025, 4, 16), desc: 'Cost-efficient o-series reasoning model.' },
    { id: 'o3', name: 'o3', ctx: 200_000, inM: 2, outM: 8, vision: true, reasoning: true, created: ts(2025, 4, 16), desc: 'Deep reasoning for hard math, science and code.' }
  ],
  anthropic: [
    { id: 'claude-opus-4-1-20250805', name: 'Claude Opus 4.1', ctx: 200_000, inM: 15, outM: 75, vision: true, reasoning: true, created: ts(2025, 8, 5), desc: 'Anthropic’s most capable model for complex, long-horizon work.' },
    { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', ctx: 200_000, inM: 3, outM: 15, vision: true, reasoning: true, created: ts(2025, 9, 29), desc: 'Best balance of intelligence, speed and price — great for coding + agents.' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', ctx: 200_000, inM: 1, outM: 5, vision: true, reasoning: true, created: ts(2025, 10, 1), desc: 'Fast, low-cost Claude with near-frontier quality.' },
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', ctx: 200_000, inM: 15, outM: 75, vision: true, reasoning: true, created: ts(2025, 5, 14) },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', ctx: 200_000, inM: 3, outM: 15, vision: true, reasoning: true, created: ts(2025, 5, 14) },
    { id: 'claude-3-7-sonnet-20250219', name: 'Claude 3.7 Sonnet', ctx: 200_000, inM: 3, outM: 15, vision: true, reasoning: true, created: ts(2025, 2, 19) },
    { id: 'claude-3-5-haiku-20241022', name: 'Claude 3.5 Haiku', ctx: 200_000, inM: 0.8, outM: 4, vision: true, created: ts(2024, 10, 22) }
  ],
  gemini: [
    { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', ctx: 1_048_576, inM: 1.25, outM: 10, vision: true, reasoning: true, created: ts(2025, 3, 25), desc: 'Google’s flagship — 1M+ context, strong reasoning and multimodal.' },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', ctx: 1_048_576, inM: 0.3, outM: 2.5, vision: true, reasoning: true, created: ts(2025, 6, 17), desc: 'Fast, cheap, 1M context — the everyday workhorse.' },
    { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', ctx: 1_048_576, inM: 0.1, outM: 0.4, vision: true, created: ts(2025, 7, 22) },
    { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', ctx: 1_048_576, inM: 0.1, outM: 0.4, vision: true, created: ts(2025, 2, 5) }
  ],
  deepseek: [
    { id: 'deepseek-chat', name: 'DeepSeek-V3.2 (chat)', ctx: 131_072, inM: 0.28, outM: 0.42, created: ts(2025, 9, 29), desc: 'General chat/coding model — very low cost, strong quality.' },
    { id: 'deepseek-reasoner', name: 'DeepSeek-R1 (reasoner)', ctx: 131_072, inM: 0.55, outM: 2.19, reasoning: true, created: ts(2025, 5, 28), desc: 'Open reasoning model with visible thinking.' }
  ],
  zai: [
    { id: 'glm-4.6', name: 'GLM-4.6', ctx: 200_000, inM: 0.6, outM: 2.2, reasoning: true, created: ts(2025, 9, 30), desc: 'Z.AI flagship — excellent coding and agentic tool use.' },
    { id: 'glm-4.5', name: 'GLM-4.5', ctx: 131_072, inM: 0.6, outM: 2.2, reasoning: true, created: ts(2025, 7, 28) },
    { id: 'glm-4.5-air', name: 'GLM-4.5-Air', ctx: 131_072, inM: 0.2, outM: 1.1, reasoning: true, created: ts(2025, 7, 28), desc: 'Lighter, cheaper GLM-4.5 for high throughput.' },
    { id: 'glm-4.5v', name: 'GLM-4.5V', ctx: 65_536, inM: 0.6, outM: 1.8, vision: true, created: ts(2025, 8, 11), desc: 'Vision-language model in the GLM family.' }
  ],
  minimax: [
    { id: 'MiniMax-M2', name: 'MiniMax-M2', ctx: 204_800, inM: 0.3, outM: 1.2, reasoning: true, created: ts(2025, 10, 27), desc: 'Agent- and code-focused MoE model, long context.' },
    { id: 'MiniMax-Text-01', name: 'MiniMax-Text-01', ctx: 1_000_000, inM: 0.2, outM: 1.1, created: ts(2025, 1, 15), desc: 'Ultra-long-context text model (up to ~1M tokens).' }
  ],
  tencent: [
    { id: 'hunyuan-turbos-latest', name: 'Hunyuan TurboS', ctx: 256_000, inM: 0.11, outM: 0.42, created: ts(2025, 5, 1), desc: 'Tencent’s fast general-purpose Hunyuan model.' },
    { id: 'hunyuan-t1-latest', name: 'Hunyuan T1', ctx: 64_000, inM: 0.14, outM: 0.55, reasoning: true, created: ts(2025, 3, 21), desc: 'Hunyuan reasoning model.' },
    { id: 'hunyuan-large', name: 'Hunyuan Large', ctx: 32_000, inM: 0.14, outM: 0.55, created: ts(2024, 11, 5) }
  ],
  xai: [
    { id: 'grok-4', name: 'Grok 4', ctx: 256_000, inM: 3, outM: 15, vision: true, reasoning: true, created: ts(2025, 7, 9), desc: 'xAI flagship — reasoning, tools and live search.' },
    { id: 'grok-4-fast-reasoning', name: 'Grok 4 Fast (reasoning)', ctx: 2_000_000, inM: 0.2, outM: 0.5, reasoning: true, created: ts(2025, 9, 19), desc: '2M context, very cheap fast reasoning.' },
    { id: 'grok-3', name: 'Grok 3', ctx: 131_072, inM: 3, outM: 15, created: ts(2025, 2, 17) },
    { id: 'grok-3-mini', name: 'Grok 3 mini', ctx: 131_072, inM: 0.3, outM: 0.5, reasoning: true, created: ts(2025, 2, 17) }
  ]
};

/** Curated catalog seed for a direct provider (empty for openrouter/nvidia, which list live). */
export const staticModelsFor = (provider: AIProviderId): CatalogModel[] => {
  const seeds = SEEDS[provider];
  if (!seeds) return [];
  return seeds.map((s) => toModel(provider, s));
};

/** All providers that ship a curated seed list. */
export const PROVIDERS_WITH_STATIC_MODELS = Object.keys(SEEDS) as AIProviderId[];
