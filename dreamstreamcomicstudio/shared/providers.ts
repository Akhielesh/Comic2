// Canonical AI PROVIDER registry — the single source of truth for every text model
// source the app can talk to directly (BYOK).
//
// A "provider" here is an upstream that actually serves model calls (OpenRouter,
// NVIDIA, OpenAI, Anthropic, Google/Gemini, DeepSeek, Z.AI, MiniMax, Tencent Hunyuan,
// xAI). This is distinct from a "vendor" (the model maker, derived from a model-id
// slug — see services/modelVendors.ts): the SAME model (e.g. Claude) can be reached
// through several providers, which is exactly the "pick a model, then choose who
// serves it" experience.
//
// Both the browser bundle and the Node server import this file (like shared/pricing.ts),
// so it MUST stay dependency-free — pure data + types only.

/** Every provider that can serve TEXT chat models (a "model source"). */
export const TEXT_PROVIDER_IDS = [
  'openrouter',
  'nvidia',
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
  'zai',
  'minimax',
  'tencent',
  'xai'
] as const;

export type ProviderId = (typeof TEXT_PROVIDER_IDS)[number];

/** Wire protocol the provider speaks. */
export type ProviderApi = 'openai' | 'anthropic';

export interface ProviderDef {
  id: ProviderId;
  /** Full display label, e.g. "Google · Gemini". */
  label: string;
  /** Short badge label, e.g. "Gemini". */
  short: string;
  /** One-line description shown in the API settings. */
  blurb: string;
  /** Request header the BYOK key is sent in (must not collide with reserved headers). */
  header: string;
  /** Env var holding the platform key on the server. */
  keyEnv: string;
  /** Env var that overrides the base URL on the server. */
  baseUrlEnv: string;
  /** Default API base URL (OpenAI-compatible `/chat/completions` lives directly under it). */
  baseUrl: string;
  /** Where the user creates an API key (deep link). */
  keysUrl: string;
  /** Billing / "add funds" page (deep link) — null when the provider has a free tier only. */
  fundsUrl: string | null;
  /** Models reference / docs (deep link). */
  docsUrl: string;
  /** Wire protocol: 'openai' (chat/completions) or 'anthropic' (messages). */
  api: ProviderApi;
  /** Path (relative to baseUrl) that lists models, or null when there is no public listing. */
  modelsPath: string | null;
  /** Typical key prefix, used only for a soft client-side format hint. */
  keyPrefix?: string;
  /** True when the provider reports a per-call USD cost (only OpenRouter does today). */
  reportsCost?: boolean;
  /** Tailwind badge classes for the provider chip (brand-ish, theme-invariant). */
  badge: string;
  /** Accent hex for small brand dots / rings (theme-invariant). */
  accent: string;
  /** Free tier available without adding funds (drives the "free tier" hint). */
  freeTier?: boolean;
  /** Sort weight for settings/listing (lower = first). */
  order: number;
}

export const PROVIDER_REGISTRY: Record<ProviderId, ProviderDef> = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    short: 'OpenRouter',
    blurb: 'Unified gateway for hundreds of text + image models. The easiest single key — recommended.',
    header: 'X-OpenRouter-Key',
    keyEnv: 'OPENROUTER_API_KEY',
    baseUrlEnv: 'OPENROUTER_BASE_URL',
    baseUrl: 'https://openrouter.ai/api/v1',
    keysUrl: 'https://openrouter.ai/keys',
    fundsUrl: 'https://openrouter.ai/settings/credits',
    docsUrl: 'https://openrouter.ai/models',
    api: 'openai',
    modelsPath: '/models',
    keyPrefix: 'sk-or-',
    reportsCost: true,
    badge: 'bg-indigo-500/10 text-indigo-500',
    accent: '#6366f1',
    freeTier: true,
    order: 0
  },
  nvidia: {
    id: 'nvidia',
    label: 'NVIDIA Build',
    short: 'NVIDIA',
    blurb: 'Generous free tier for open LLMs (Llama, Qwen, DeepSeek…). Uses an nvapi- key.',
    header: 'X-Nvidia-Key',
    keyEnv: 'NVIDIA_API_KEY',
    baseUrlEnv: 'NVIDIA_BASE_URL',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    keysUrl: 'https://build.nvidia.com/settings/api-keys',
    fundsUrl: null,
    docsUrl: 'https://build.nvidia.com/models',
    api: 'openai',
    modelsPath: '/models',
    keyPrefix: 'nvapi-',
    badge: 'bg-green-500/10 text-green-600',
    accent: '#76b900',
    freeTier: true,
    order: 1
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    short: 'OpenAI',
    blurb: 'GPT-5, GPT-4.1, o-series reasoning and more — straight from OpenAI.',
    header: 'X-OpenAI-Key',
    keyEnv: 'OPENAI_API_KEY',
    baseUrlEnv: 'OPENAI_BASE_URL',
    baseUrl: 'https://api.openai.com/v1',
    keysUrl: 'https://platform.openai.com/api-keys',
    fundsUrl: 'https://platform.openai.com/settings/organization/billing/overview',
    docsUrl: 'https://platform.openai.com/docs/models',
    api: 'openai',
    modelsPath: '/models',
    keyPrefix: 'sk-',
    badge: 'bg-emerald-600/10 text-emerald-600',
    accent: '#10a37f',
    order: 2
  },
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    short: 'Anthropic',
    blurb: 'Claude Opus, Sonnet and Haiku via Anthropic’s native Messages API.',
    header: 'X-Anthropic-Key',
    keyEnv: 'ANTHROPIC_API_KEY',
    baseUrlEnv: 'ANTHROPIC_BASE_URL',
    baseUrl: 'https://api.anthropic.com/v1',
    keysUrl: 'https://console.anthropic.com/settings/keys',
    fundsUrl: 'https://console.anthropic.com/settings/billing',
    docsUrl: 'https://docs.anthropic.com/en/docs/about-claude/models',
    api: 'anthropic',
    modelsPath: '/models',
    keyPrefix: 'sk-ant-',
    badge: 'bg-orange-500/10 text-orange-600',
    accent: '#d97757',
    order: 3
  },
  gemini: {
    id: 'gemini',
    label: 'Google · Gemini',
    short: 'Gemini',
    blurb: 'Gemini 2.5 Pro/Flash from Google AI Studio. Free tier available; one key powers text + image.',
    header: 'X-Gemini-Key',
    keyEnv: 'GEMINI_API_KEY',
    baseUrlEnv: 'GEMINI_OPENAI_BASE_URL',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keysUrl: 'https://aistudio.google.com/app/apikey',
    fundsUrl: 'https://aistudio.google.com/app/plan_information',
    docsUrl: 'https://ai.google.dev/gemini-api/docs/models',
    api: 'openai',
    modelsPath: '/models',
    badge: 'bg-blue-500/10 text-blue-500',
    accent: '#4285f4',
    freeTier: true,
    order: 4
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    short: 'DeepSeek',
    blurb: 'DeepSeek-V3 chat and DeepSeek-R1 reasoning at very low cost.',
    header: 'X-DeepSeek-Key',
    keyEnv: 'DEEPSEEK_API_KEY',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    baseUrl: 'https://api.deepseek.com',
    keysUrl: 'https://platform.deepseek.com/api_keys',
    fundsUrl: 'https://platform.deepseek.com/top_up',
    docsUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    api: 'openai',
    modelsPath: '/models',
    keyPrefix: 'sk-',
    badge: 'bg-blue-600/10 text-blue-600',
    accent: '#4d6bfe',
    order: 5
  },
  zai: {
    id: 'zai',
    label: 'Z.AI · GLM',
    short: 'Z.AI',
    blurb: 'GLM-4.6 and the GLM family from Z.AI (Zhipu), strong at coding and agents.',
    header: 'X-ZAI-Key',
    keyEnv: 'ZAI_API_KEY',
    baseUrlEnv: 'ZAI_BASE_URL',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    keysUrl: 'https://z.ai/manage-apikey/apikey-list',
    fundsUrl: 'https://z.ai/manage-apikey/apikey-list',
    docsUrl: 'https://docs.z.ai/guides/llm/glm-4.6',
    api: 'openai',
    modelsPath: null,
    badge: 'bg-rose-600/10 text-rose-600',
    accent: '#e11d48',
    order: 6
  },
  minimax: {
    id: 'minimax',
    label: 'MiniMax',
    short: 'MiniMax',
    blurb: 'MiniMax-M2 and the MiniMax text models — long-context, agent-friendly.',
    header: 'X-MiniMax-Key',
    keyEnv: 'MINIMAX_API_KEY',
    baseUrlEnv: 'MINIMAX_BASE_URL',
    baseUrl: 'https://api.minimax.io/v1',
    keysUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key',
    fundsUrl: 'https://platform.minimax.io/user-center/payment',
    docsUrl: 'https://platform.minimax.io/docs/api-reference/text-chatcompletion-v2',
    api: 'openai',
    modelsPath: null,
    badge: 'bg-red-500/10 text-red-500',
    accent: '#ef4444',
    order: 7
  },
  tencent: {
    id: 'tencent',
    label: 'Tencent · Hunyuan',
    short: 'Hunyuan',
    blurb: 'Tencent Hunyuan models via the OpenAI-compatible endpoint.',
    header: 'X-Tencent-Key',
    keyEnv: 'TENCENT_API_KEY',
    baseUrlEnv: 'TENCENT_BASE_URL',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    keysUrl: 'https://console.cloud.tencent.com/hunyuan/api-key',
    fundsUrl: 'https://console.cloud.tencent.com/expense/recharge',
    docsUrl: 'https://www.tencentcloud.com/document/product/1729',
    api: 'openai',
    modelsPath: '/models',
    badge: 'bg-sky-600/10 text-sky-600',
    accent: '#0ea5e9',
    order: 8
  },
  xai: {
    id: 'xai',
    label: 'xAI · Grok',
    short: 'Grok',
    blurb: 'Grok 4 and the Grok family from xAI, with live-search and vision.',
    header: 'X-XAI-Key',
    keyEnv: 'XAI_API_KEY',
    baseUrlEnv: 'XAI_BASE_URL',
    baseUrl: 'https://api.x.ai/v1',
    keysUrl: 'https://console.x.ai',
    fundsUrl: 'https://console.x.ai',
    docsUrl: 'https://docs.x.ai/docs/models',
    api: 'openai',
    modelsPath: '/models',
    keyPrefix: 'xai-',
    badge: 'bg-slate-800/10 text-slate-700',
    accent: '#111827',
    order: 9
  }
};

/** Providers in display order (settings, pickers). */
export const PROVIDERS_ORDERED: ProviderDef[] = TEXT_PROVIDER_IDS
  .map((id) => PROVIDER_REGISTRY[id])
  .sort((a, b) => a.order - b.order);

export const getProviderDef = (id: string): ProviderDef | undefined =>
  (PROVIDER_REGISTRY as Record<string, ProviderDef>)[id];

export const isTextProvider = (id: string): id is ProviderId =>
  Object.prototype.hasOwnProperty.call(PROVIDER_REGISTRY, id);

/** Friendly display label for a provider/source id (falls back to the raw id). */
export const providerLabel = (id?: string | null): string => {
  if (!id) return '';
  return getProviderDef(id)?.label ?? String(id);
};

/** Short badge label for a provider/source id. */
export const providerShortLabel = (id?: string | null): string => {
  if (!id) return '';
  return getProviderDef(id)?.short ?? String(id);
};
