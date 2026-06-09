// Curated allowlist of coding models the Code Studio can TRULY recommend.
//
// The live catalog lists hundreds of models, many of which are weak coders, download-only, or
// effectively dead on the hosted API — pinning one of those is a big reason "a lot of models don't
// work". So the studio's coding-model picker shows only this hand-picked set of reputable,
// broadly-available coders (matched by id pattern so it tracks version bumps), AND only those the
// catalog still marks API-callable. Power users who want anything else can still pin it from the
// full ModelLibrary page ("Use in Studio") — this only curates the in-studio picker.

/** Id patterns (normalized lowercase) for coders we recommend. Intentionally version-agnostic. */
export const STUDIO_CODER_ALLOWLIST: RegExp[] = [
  /anthropic\/claude.*(sonnet|opus|haiku)/, // Claude — top-tier coders
  /openai\/(gpt-5|gpt-4\.1|gpt-4o|o3|o4-mini|o1)/, // GPT-4o/4.1/o-series
  /google\/gemini-(1\.5|2\.0|2\.5|exp).*(pro|flash)/, // Gemini Pro/Flash
  /deepseek\/(deepseek-(chat|coder|r1|v3)|deepseek-v3)/, // DeepSeek V3 / R1 / Coder
  /qwen.*(coder|qwen-?2\.5|qwen3|qwq)/, // Qwen2.5-Coder & friends
  /(meta-llama|meta)\/llama-3\.[1-3].*(70b|405b|90b)/, // Llama 3.x large
  /mistral.*(codestral|large|devstral)/, // Codestral / Mistral Large
  /x-ai\/grok/, // Grok
  /moonshot.*kimi|kimi-k2/, // Kimi (strong long-context coder)
  /z-ai\/glm-4|thudm\/glm/, // GLM-4
  /nvidia\/(llama-3\.[1-3]|nemotron)/, // NVIDIA-hosted strong coders
];

/** True when a model id is one of the curated, recommendable coders. */
export const isAllowlistedCoder = (id: string | undefined | null): boolean => {
  if (!id) return false;
  const s = id.toLowerCase();
  return STUDIO_CODER_ALLOWLIST.some((re) => re.test(s));
};

/**
 * Filter a coder list to the curated, API-callable set. Falls back to the callable list if the
 * curated filter would empty the picker (e.g. a catalog whose ids don't match) so the user is
 * never locked out of choosing a model.
 */
export const curateCoders = <T extends { id: string; apiCallable?: boolean }>(coders: T[]): T[] => {
  const callable = coders.filter((m) => m.apiCallable !== false); // hide download-only / dead models
  const curated = callable.filter((m) => isAllowlistedCoder(m.id));
  return curated.length >= 3 ? curated : callable;
};
