// Model capability & product-fit taxonomy — the single source of truth shared by
// the client (model pickers), the server catalog (annotations + /api/models
// filters), the chat route (request-time validation) and the bench harness.
//
// Why this exists: the raw OpenRouter/NVIDIA catalogs mix general chat models
// with safety classifiers (llama-guard, content-safety), code-apply engines
// (relace, morph), routers, audio/music models and agentic deep-research
// models. Surfacing those in a chat/code/comic picker lets users select a model
// that can never work for the product they're in — bench run 6d0b89f2 showed
// exactly that failure mode at scale. Capability flags answer the other half:
// which models can see images, call tools, reason step-by-step, or hold a long
// context, so each product only offers (and each route only accepts) models
// that actually support its features.

export type ModelKind =
  | 'chat'              // general conversational / instruct model
  | 'safety-classifier' // llama-guard, content-safety… emit labels, not prose
  | 'code-apply'        // relace/morph-style diff-apply engines
  | 'request-router'    // meta-models that return routing JSON, not answers
  | 'deep-research'     // agentic, minutes-long research runs
  | 'media';            // audio/music/non-text generators

export interface ModelCapabilityInput {
  id: string;
  inputModalities?: string[];
  outputModalities?: string[];
  supportedParameters?: string[];
  contextLength?: number | null;
}

export interface ModelCapabilities {
  kind: ModelKind;
  /** Accepts image input (vision / reference images). */
  vision: boolean;
  /** Produces images (panel art, covers, illustrations). */
  imageOutput: boolean;
  /** Accepts OpenAI-style function tools — required for widgets/tool calling. */
  tools: boolean;
  /** Exposes step-by-step reasoning controls. */
  reasoning: boolean;
  /** Supports structured/JSON output (reliable pipelines). */
  json: boolean;
  /** Context window ≥ 32k tokens — comfortable for Code Studio projects. */
  longContext: boolean;
  /** Accepts the temperature sampler param (o-series & some media models reject it). */
  temperature: boolean;
}

const KIND_RULES: Array<{ re: RegExp; kind: ModelKind }> = [
  { re: /guard|content-safety|shieldgemma|prompt-?injection/i, kind: 'safety-classifier' },
  { re: /^relace\/|^morph\/morph|fast-apply/i, kind: 'code-apply' },
  { re: /bodybuilder/i, kind: 'request-router' },
  { re: /deep-research/i, kind: 'deep-research' },
  { re: /lyria|musicgen|suno|-tts\b|whisper/i, kind: 'media' }
];

export const LONG_CONTEXT_MIN_TOKENS = 32_000;

export const classifyModelKind = (model: ModelCapabilityInput): ModelKind => {
  const rule = KIND_RULES.find((r) => r.re.test(model.id));
  if (rule) return rule.kind;
  const out = model.outputModalities ?? ['text'];
  const input = model.inputModalities ?? ['text'];
  if (!out.includes('text') || !input.includes('text')) return 'media';
  return 'chat';
};

export const deriveModelCapabilities = (model: ModelCapabilityInput): ModelCapabilities => {
  const params = model.supportedParameters ?? [];
  const input = model.inputModalities ?? ['text'];
  const out = model.outputModalities ?? ['text'];
  return {
    kind: classifyModelKind(model),
    vision: input.includes('image'),
    imageOutput: out.includes('image'),
    tools: params.includes('tools') || params.includes('tool_choice'),
    reasoning: params.includes('reasoning') || params.includes('include_reasoning'),
    json: params.includes('response_format') || params.includes('structured_outputs'),
    longContext: (model.contextLength ?? 0) >= LONG_CONTEXT_MIN_TOKENS,
    temperature: params.length === 0 || params.includes('temperature')
  };
};

// ── Product requirement profiles ────────────────────────────────────────────────
// `required` gates the model out of the product entirely; `recommended` only
// affects ranking/labels so users still see (e.g.) tool-less chat models in
// Chat Studio — they just lose widget features, which the UI can explain.
export type CapabilityKey = Exclude<keyof ModelCapabilities, 'kind'>;

export interface ProductModelProfile {
  /** Model kinds usable in this product at all. */
  kinds: ModelKind[];
  required: CapabilityKey[];
  recommended: CapabilityKey[];
}

export const PRODUCT_MODEL_PROFILES: Record<string, ProductModelProfile> = {
  // Chat Studio: any honest chat model works; tools/vision/reasoning unlock
  // widgets, image attachments and the reasoning toggle respectively.
  chat_studio: { kinds: ['chat'], required: [], recommended: ['tools', 'json'] },
  // Code Studio (stream_studio): agentic builds need tool calling and benefit
  // from JSON mode + a long window for project context.
  stream_studio: { kinds: ['chat'], required: ['tools'], recommended: ['json', 'longContext'] },
  // Comic Studio text stages (script analysis / dialogue / QC) need reliable
  // structured output; panel art is gated separately via imageOutput.
  comic_studio: { kinds: ['chat'], required: [], recommended: ['json', 'vision'] }
};

export interface ProductFit {
  allowed: boolean;
  /** Human-readable reason when blocked (kind mismatch / missing capability). */
  blockedReason?: string;
  /** Recommended capabilities this model is missing (degrades features, not access). */
  missingRecommended: CapabilityKey[];
}

const CAPABILITY_LABELS: Record<CapabilityKey, string> = {
  vision: 'image input',
  imageOutput: 'image output',
  tools: 'tool calling',
  reasoning: 'step-by-step reasoning',
  json: 'structured JSON output',
  longContext: `a ${Math.round(LONG_CONTEXT_MIN_TOKENS / 1000)}k+ context window`,
  temperature: 'sampler controls'
};

const KIND_LABELS: Record<ModelKind, string> = {
  chat: 'general chat model',
  'safety-classifier': 'a safety classifier — it emits moderation labels, not conversation',
  'code-apply': 'a code-apply engine — it merges diffs, it does not chat',
  'request-router': 'a request-routing meta-model — it returns routing JSON, not answers',
  'deep-research': 'an agentic deep-research model — runs take minutes and ignore chat conventions',
  media: 'a media-generation model without text output'
};

export const productFitForModel = (model: ModelCapabilityInput, product: string): ProductFit => {
  const profile = PRODUCT_MODEL_PROFILES[product];
  if (!profile) return { allowed: true, missingRecommended: [] };
  const caps = deriveModelCapabilities(model);
  if (!profile.kinds.includes(caps.kind)) {
    return {
      allowed: false,
      blockedReason: `${model.id} is ${KIND_LABELS[caps.kind]}.`,
      missingRecommended: []
    };
  }
  const missingRequired = profile.required.filter((k) => !caps[k]);
  if (missingRequired.length) {
    return {
      allowed: false,
      blockedReason: `${model.id} lacks ${missingRequired.map((k) => CAPABILITY_LABELS[k]).join(', ')}, which this studio requires.`,
      missingRecommended: []
    };
  }
  return {
    allowed: true,
    missingRecommended: profile.recommended.filter((k) => !caps[k])
  };
};
