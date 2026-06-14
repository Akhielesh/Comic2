// AI gateway façade + provider registry.
//
// Routes call the gateway instead of a concrete provider so the rest of the server
// never imports a vendor SDK directly. The `PROVIDERS` registry below is the single
// place providers are wired up — each is a drop-in `AIProvider`, so adding a BYOK
// source never touches route code. The canonical provider metadata (labels, base URLs,
// key env vars, links) lives in shared/providers.ts.

import {
  AI_PROVIDER,
  OPENROUTER_API_KEY,
  NVIDIA_API_KEY,
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_REQUEST_TIMEOUT_MS,
  ANTHROPIC_API_KEY,
  GEMINI_API_KEY,
  GEMINI_OPENAI_BASE_URL,
  GEMINI_REQUEST_TIMEOUT_MS,
  DEEPSEEK_API_KEY,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_REQUEST_TIMEOUT_MS,
  ZAI_API_KEY,
  ZAI_BASE_URL,
  ZAI_REQUEST_TIMEOUT_MS,
  MINIMAX_API_KEY,
  MINIMAX_BASE_URL,
  MINIMAX_REQUEST_TIMEOUT_MS,
  TENCENT_API_KEY,
  TENCENT_BASE_URL,
  TENCENT_REQUEST_TIMEOUT_MS,
  XAI_API_KEY,
  XAI_BASE_URL,
  XAI_REQUEST_TIMEOUT_MS
} from '../config.js';
import { openRouterProvider } from './providers/openrouter.js';
import { nvidiaProvider } from './providers/nvidia.js';
import { anthropicProvider } from './providers/anthropic.js';
import { createOpenAICompatibleProvider } from './providers/openaiCompatible.js';
import type { AIProvider, AIProviderId, ProviderContext } from './providers/types.js';

const openaiProvider = createOpenAICompatibleProvider({
  id: 'openai', label: 'OpenAI', baseUrl: OPENAI_BASE_URL, timeoutMs: OPENAI_REQUEST_TIMEOUT_MS,
  modelsPath: '/models', supportsReasoningEffort: true, supportsTools: true, supportsImages: true
});
const geminiProvider = createOpenAICompatibleProvider({
  id: 'gemini', label: 'Gemini', baseUrl: GEMINI_OPENAI_BASE_URL, timeoutMs: GEMINI_REQUEST_TIMEOUT_MS,
  modelsPath: '/models', supportsTools: true
});
const deepseekProvider = createOpenAICompatibleProvider({
  id: 'deepseek', label: 'DeepSeek', baseUrl: DEEPSEEK_BASE_URL, timeoutMs: DEEPSEEK_REQUEST_TIMEOUT_MS,
  modelsPath: '/models', supportsTools: true
});
const zaiProvider = createOpenAICompatibleProvider({
  id: 'zai', label: 'Z.AI', baseUrl: ZAI_BASE_URL, timeoutMs: ZAI_REQUEST_TIMEOUT_MS,
  modelsPath: null, supportsTools: true
});
const minimaxProvider = createOpenAICompatibleProvider({
  id: 'minimax', label: 'MiniMax', baseUrl: MINIMAX_BASE_URL, timeoutMs: MINIMAX_REQUEST_TIMEOUT_MS,
  modelsPath: null, supportsTools: true
});
const tencentProvider = createOpenAICompatibleProvider({
  id: 'tencent', label: 'Hunyuan', baseUrl: TENCENT_BASE_URL, timeoutMs: TENCENT_REQUEST_TIMEOUT_MS,
  modelsPath: '/models', supportsTools: true
});
const xaiProvider = createOpenAICompatibleProvider({
  id: 'xai', label: 'xAI', baseUrl: XAI_BASE_URL, timeoutMs: XAI_REQUEST_TIMEOUT_MS,
  modelsPath: '/models', supportsReasoningEffort: true, supportsTools: true, supportsImages: true
});

/** Registry of available providers, keyed by id. Add new providers here. */
const PROVIDERS: Record<string, AIProvider> = {
  openrouter: openRouterProvider,
  nvidia: nvidiaProvider,
  openai: openaiProvider,
  anthropic: anthropicProvider,
  gemini: geminiProvider,
  deepseek: deepseekProvider,
  zai: zaiProvider,
  minimax: minimaxProvider,
  tencent: tencentProvider,
  xai: xaiProvider
};

/** Platform (non-BYOK) key per provider, used when the user hasn't supplied their own. */
const PLATFORM_KEYS: Partial<Record<AIProviderId, string>> = {
  openrouter: OPENROUTER_API_KEY,
  nvidia: NVIDIA_API_KEY,
  openai: OPENAI_API_KEY,
  anthropic: ANTHROPIC_API_KEY,
  gemini: GEMINI_API_KEY,
  deepseek: DEEPSEEK_API_KEY,
  zai: ZAI_API_KEY,
  minimax: MINIMAX_API_KEY,
  tencent: TENCENT_API_KEY,
  xai: XAI_API_KEY
};

const platformKeyFor = (providerId?: string): string =>
  (providerId && PLATFORM_KEYS[providerId as AIProviderId]) || OPENROUTER_API_KEY;

// The platform's implicit default provider is the unified gateway (OpenRouter), or NVIDIA
// when explicitly selected. The direct BYOK providers (openai/anthropic/gemini/…) are chosen
// per-request by source — they must NEVER become the implicit default just because they were
// added to the registry. Without this guard, AI_PROVIDER's default ('gemini') would flip the
// default catalog + generation off OpenRouter the moment a 'gemini' provider was registered.
const DEFAULT_CAPABLE_PROVIDERS = new Set(['openrouter', 'nvidia']);

/** The provider id the platform runs by default (from AI_PROVIDER, fallback openrouter). */
export const defaultProviderId = (): string =>
  DEFAULT_CAPABLE_PROVIDERS.has(AI_PROVIDER) ? AI_PROVIDER : 'openrouter';

/** True when the unified OpenRouter path should handle the default generation flow. */
export const isOpenRouterEnabled = (): boolean => AI_PROVIDER === 'openrouter';

/**
 * Resolve a provider implementation.
 *
 * - Pass an explicit id to target a specific provider.
 * - Omit the id to use the platform's active provider.
 */
export const getProvider = (id?: string): AIProvider =>
  PROVIDERS[(id || defaultProviderId()).toLowerCase()] || openRouterProvider;

/**
 * Resolve the provider context (key + BYOK flag) for a request.
 *
 * - A user-supplied key (BYOK) always wins and bypasses platform billing.
 * - Otherwise the platform key funds the call and the request is metered to credits.
 */
export const resolveProviderContext = (userKey?: string | null, providerId?: string): ProviderContext => {
  const trimmed = (userKey || '').trim();
  if (trimmed) return { apiKey: trimmed, byok: true };
  return { apiKey: platformKeyFor(providerId), byok: false };
};
