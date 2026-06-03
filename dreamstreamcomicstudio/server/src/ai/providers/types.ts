// Provider-agnostic AI interface.
//
// OpenRouter is the first (and currently only) implementation, but every route
// talks to this interface rather than a concrete vendor SDK. That keeps model
// choice and pricing in one control plane and avoids re-coupling to a single
// provider the way the legacy Gemini/Pixazo code did.

export type AIProviderId = 'openrouter' | 'nvidia';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type TextPart = { type: 'text'; text: string };
export type ImagePart = { type: 'image_url'; image_url: { url: string } };
export type MessagePart = TextPart | ImagePart;

/** OpenAI-compatible function-tool spec (what the model is told it can call). */
export type ToolSpec = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

/** A tool the model decided to call, returned in the completion. */
export type ToolCall = { id: string; name: string; arguments: string };

export type ChatMessage = {
  role: ChatRole;
  content: string | MessagePart[];
  /** Present on an assistant turn that requested tools (passed straight through to the API). */
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  /** Present on a tool-result message, linking it back to the assistant's tool_call. */
  tool_call_id?: string;
};

export type JsonSchemaSpec = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type GenerateTextRequest = {
  model: string;
  messages: ChatMessage[];
  /** When set, request structured JSON output (with prompt-based fallback + repair). */
  jsonSchema?: JsonSchemaSpec;
  /** Force a JSON object response even without a named schema. */
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  retries?: number;
  /** Reliable model to retry on if `model` is unavailable (404) or rate-limited (429). */
  fallbackModel?: string;
  /**
   * True when the caller is in strict free-only mode. The provider must NOT retry
   * on a paid `fallbackModel` if the primary call fails — it should surface the error
   * so the route can return a Block + explain response (HTTP 402 NO_FREE_MODEL_AVAILABLE).
   */
  freeOnly?: boolean;
  /**
   * Per-request reasoning effort for reasoning-capable models. Overrides the global
   * REASONING_EFFORT default so the chat platform can expose a per-conversation control.
   * Ignored by providers/models that don't support step-by-step reasoning.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /**
   * When true, enable the provider's live web-search augmentation (OpenRouter `web` plugin)
   * so the model can ground answers in current internet results. Ignored by providers
   * that don't support it.
   */
  webSearch?: boolean;
  /** Function tools the model may call (agentic loop). Provider returns `toolCalls` when used. */
  tools?: ToolSpec[];
};

export type ProviderUsage = {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Actual provider cost in USD when the provider reports it (OpenRouter `usage.cost`). */
  costUsd?: number;
};

export type GenerateTextResult = {
  text: string;
  /** Parsed JSON, present only when jsonSchema/jsonMode was requested. */
  json?: unknown;
  model: string;
  usage: ProviderUsage;
  /** Step-by-step reasoning trace, when the model exposes it (reasoning models). */
  reasoning?: string;
  /** Web citations gathered when web search was enabled (OpenRouter `web` plugin annotations). */
  citations?: { url: string; title?: string }[];
  /** Tool calls the model requested this turn (drives the agentic loop). */
  toolCalls?: ToolCall[];
  raw?: unknown;
};

export type GenerateImageRequest = {
  model: string;
  prompt: string;
  /** Reference/input images as data URLs or public URLs (drives character consistency). */
  referenceImages?: string[];
  /** Negative prompt / "no text" guard, appended to the prompt server-side. */
  negativePrompt?: string;
  timeoutMs?: number;
  retries?: number;
};

export type GenerateImageResult = {
  /** First generated image as a data URL (data:image/...;base64,...). */
  imageDataUrl: string;
  /** All generated images as data URLs. */
  images: string[];
  model: string;
  usage: ProviderUsage;
  raw?: unknown;
};

export type CatalogModelPricing = {
  /** USD per prompt (input) token. */
  promptPerToken: number;
  /** USD per completion (output) token. */
  completionPerToken: number;
  /** USD per generated image. */
  imagePerImage: number;
  /** Flat USD per request, if any. */
  requestFlat: number;
};

/**
 * 4-way cost classification. Replaces the old single `isFree` boolean across
 * the app. Lives in shared/pricing.ts so client + server agree on what "free"
 * means relative to which axis applies (token-billed image models are NOT free).
 */
export type CostClass =
  | 'free_verified'
  | 'zero_priced_token_billed'
  | 'per_image_only'
  | 'paid';

export type CatalogModel = {
  id: string;
  name: string;
  /** Which upstream source this model comes from (drives the Library "source" filter). */
  source: AIProviderId;
  description?: string;
  contextLength?: number;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  pricing: CatalogModelPricing;
  /** True when the model costs nothing to call (cls === 'free_verified'). */
  isFree: boolean;
  /** Multi-dimensional cost class — drives UI labels and free-only routing. */
  costClass: CostClass;
  /** Can produce images (panel art / covers). */
  supportsImageOutput: boolean;
  /** Accepts input images (reference images => character consistency). */
  supportsImageInput: boolean;
  /** Supports structured/JSON output (reliability of the planning pipeline). */
  supportsJsonOutput: boolean;
};

export type ProviderContext = {
  apiKey: string;
  /** True when the key is the end-user's (BYOK) rather than the platform key. */
  byok: boolean;
};

export interface AIProvider {
  id: AIProviderId;
  generateText(req: GenerateTextRequest, ctx: ProviderContext): Promise<GenerateTextResult>;
  /**
   * Streaming text generation. Calls `onDelta` with incremental content/reasoning as it
   * arrives and resolves with the fully-assembled result (text, toolCalls, usage…).
   * Optional — callers must fall back to generateText when absent.
   */
  generateTextStream?(
    req: GenerateTextRequest,
    ctx: ProviderContext,
    onDelta: (delta: { content?: string; reasoning?: string }) => void
  ): Promise<GenerateTextResult>;
  generateImage(req: GenerateImageRequest, ctx: ProviderContext): Promise<GenerateImageResult>;
  /** Lists models from the provider. Auth is optional for OpenRouter's public catalog. */
  listModels(ctx?: ProviderContext): Promise<CatalogModel[]>;
}
