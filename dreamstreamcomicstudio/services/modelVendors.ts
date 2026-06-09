// Canonical AI VENDOR / family derivation for the model catalog.
//
// The catalog's `source` is the upstream gateway (OpenRouter / NVIDIA), NOT the company that
// makes the model. Users think in vendors — "show me Anthropic / OpenAI / Gemini / DeepSeek /
// Z.AI / Ideogram" — so we derive the vendor from the model-id org slug (the part before the
// first "/", e.g. `anthropic/claude-sonnet-4` → Anthropic) and map known slugs to a canonical
// vendor with a display label + brand-ish badge colour. Pure + dependency-free (only needs an id).

export interface VendorMeta {
  /** Canonical vendor id used for filtering. */
  id: string;
  label: string;
  /** Tailwind badge classes. */
  color: string;
  /** Id-prefix slugs that map to this vendor. */
  aliases: string[];
  /** Optional homepage / model hub for the "more info" links. */
  url?: string;
}

export const VENDOR_META: VendorMeta[] = [
  { id: 'anthropic', label: 'Anthropic', color: 'bg-orange-500 text-white', aliases: ['anthropic'], url: 'https://www.anthropic.com/claude' },
  { id: 'openai', label: 'OpenAI', color: 'bg-emerald-600 text-white', aliases: ['openai', 'o1', 'gpt'], url: 'https://platform.openai.com/docs/models' },
  { id: 'google', label: 'Google · Gemini', color: 'bg-blue-500 text-white', aliases: ['google', 'google-vertex', 'gemini'], url: 'https://ai.google.dev/gemini-api/docs/models' },
  { id: 'deepseek', label: 'DeepSeek', color: 'bg-indigo-600 text-white', aliases: ['deepseek'], url: 'https://api-docs.deepseek.com/quick_start/pricing' },
  { id: 'zai', label: 'Z.AI · GLM', color: 'bg-rose-600 text-white', aliases: ['z-ai', 'zai', 'zhipu', 'zhipuai', 'thudm'], url: 'https://z.ai' },
  { id: 'xai', label: 'xAI · Grok', color: 'bg-slate-900 text-white', aliases: ['x-ai', 'xai'], url: 'https://docs.x.ai/docs/models' },
  { id: 'meta', label: 'Meta · Llama', color: 'bg-blue-700 text-white', aliases: ['meta-llama', 'meta', 'llama'], url: 'https://www.llama.com' },
  { id: 'mistral', label: 'Mistral', color: 'bg-amber-500 text-black', aliases: ['mistralai', 'mistral'], url: 'https://docs.mistral.ai/getting-started/models/models_overview' },
  { id: 'qwen', label: 'Qwen · Alibaba', color: 'bg-purple-600 text-white', aliases: ['qwen', 'alibaba'], url: 'https://qwenlm.github.io' },
  { id: 'moonshot', label: 'Moonshot · Kimi', color: 'bg-slate-700 text-white', aliases: ['moonshotai', 'moonshot'], url: 'https://platform.moonshot.ai' },
  { id: 'ideogram', label: 'Ideogram', color: 'bg-fuchsia-600 text-white', aliases: ['ideogram'], url: 'https://about.ideogram.ai' },
  { id: 'black-forest-labs', label: 'Black Forest · Flux', color: 'bg-black text-white', aliases: ['black-forest-labs', 'flux', 'pixazo'], url: 'https://blackforestlabs.ai' },
  { id: 'stability', label: 'Stability AI', color: 'bg-teal-600 text-white', aliases: ['stabilityai', 'stability'], url: 'https://stability.ai' },
  { id: 'cohere', label: 'Cohere', color: 'bg-pink-600 text-white', aliases: ['cohere'], url: 'https://docs.cohere.com/docs/models' },
  { id: 'perplexity', label: 'Perplexity', color: 'bg-cyan-600 text-white', aliases: ['perplexity'], url: 'https://docs.perplexity.ai' },
  { id: 'microsoft', label: 'Microsoft · Phi', color: 'bg-sky-600 text-white', aliases: ['microsoft'], url: 'https://azure.microsoft.com/products/ai-services' },
  { id: 'amazon', label: 'Amazon · Nova', color: 'bg-yellow-600 text-black', aliases: ['amazon'], url: 'https://aws.amazon.com/ai/generative-ai/nova' },
  { id: 'nvidia', label: 'NVIDIA', color: 'bg-green-600 text-white', aliases: ['nvidia'], url: 'https://build.nvidia.com' },
  { id: 'nous', label: 'Nous Research', color: 'bg-violet-600 text-white', aliases: ['nousresearch', 'nous'], url: 'https://nousresearch.com' },
];

const OTHER: VendorMeta = { id: 'other', label: 'Other', color: 'bg-slate-500 text-white', aliases: [] };

const ALIAS_TO_VENDOR = new Map<string, VendorMeta>();
for (const vendor of VENDOR_META) {
  for (const alias of vendor.aliases) ALIAS_TO_VENDOR.set(alias.toLowerCase(), vendor);
}

/** The org slug = the part of the model id before the first "/" (or the whole id if none). */
export const vendorSlug = (model: { id: string }): string => {
  const slash = model.id.indexOf('/');
  return (slash > 0 ? model.id.slice(0, slash) : model.id).toLowerCase();
};

/** Resolve a model to its canonical vendor (falls back to "Other"). */
export const getModelVendor = (model: { id: string }): VendorMeta => {
  const slug = vendorSlug(model);
  if (ALIAS_TO_VENDOR.has(slug)) return ALIAS_TO_VENDOR.get(slug)!;
  // Some ids embed the vendor without a slash (e.g. "gpt-4o-mini"); try a loose contains match.
  for (const vendor of VENDOR_META) {
    if (vendor.aliases.some((alias) => slug.startsWith(alias))) return vendor;
  }
  return OTHER;
};

export const getModelVendorId = (model: { id: string }): string => getModelVendor(model).id;

/** Vendors actually present in a model list, with counts, most-common first (for filter chips). */
export const availableVendors = (models: { id: string }[]): { vendor: VendorMeta; count: number }[] => {
  const counts = new Map<string, number>();
  for (const model of models) {
    const id = getModelVendorId(model);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const byId = new Map<string, VendorMeta>([...VENDOR_META, OTHER].map((v) => [v.id, v]));
  return [...counts.entries()]
    .map(([id, count]) => ({ vendor: byId.get(id) || OTHER, count }))
    .sort((a, b) => b.count - a.count);
};
