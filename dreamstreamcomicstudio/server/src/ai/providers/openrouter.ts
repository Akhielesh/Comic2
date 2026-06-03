// OpenRouter provider — the single upstream for text + image generation.
//
// Text:  POST /chat/completions (OpenAI-compatible).
// Image: POST /chat/completions with `modalities: ["image","text"]`; generated
//        images come back in choices[0].message.images[] as data URLs.
// Models: GET /models (public catalog; auth optional).
//
// NOTE: This module is written against OpenRouter's documented API but cannot be
// runtime-verified inside the build sandbox (no outbound network to openrouter.ai).
// Validate end-to-end with a real OPENROUTER_API_KEY in a networked environment.

import {
  OPENROUTER_BASE_URL,
  OPENROUTER_APP_URL,
  OPENROUTER_APP_TITLE,
  OPENROUTER_REQUEST_TIMEOUT_MS,
  REASONING_EFFORT
} from '../../config.js';
import { withRetry } from '../utils.js';
import { coerceJson, coerceJsonOrNull } from '../jsonCoerce.js';
import { classifyModel, hasFreeSuffix } from '../../../../shared/pricing.js';
import type {
  AIProvider,
  CatalogModel,
  GenerateImageRequest,
  GenerateImageResult,
  GenerateTextRequest,
  GenerateTextResult,
  MessagePart,
  ProviderContext,
  ProviderUsage
} from './types.js';

const JSON_REPAIR_INSTRUCTION =
  'Your previous reply was not valid JSON. Reply again with ONLY valid, minified JSON that matches the requested structure — no prose, no explanation, no markdown code fences.';

// Reasoning/thinking model families (id-based), kept in sync with the client capability index.
const REASONING_MODEL_RE = /(?:^|[/:_-])(?:o1|o3|o4-mini|r1|qwq|deepseek-r1?|magistral|phi-4-reasoning|grok-3-mini)(?:[:_-]|$)|reasoning|thinking/i;

const buildHeaders = (ctx?: ProviderContext): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'HTTP-Referer': OPENROUTER_APP_URL,
    'X-Title': OPENROUTER_APP_TITLE
  };
  if (ctx?.apiKey) headers['Authorization'] = `Bearer ${ctx.apiKey}`;
  return headers;
};

const openRouterFetch = async <T = any>(
  path: string,
  init: { method?: string; body?: string },
  timeoutMs: number,
  ctx?: ProviderContext
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}${path}`, {
      method: init.method || 'GET',
      headers: buildHeaders(ctx),
      body: init.body,
      signal: controller.signal
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`OpenRouter ${path} failed: ${res.status} ${res.statusText} ${errBody.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
};

const parseUsage = (data: any): ProviderUsage => {
  const usage = data?.usage || {};
  return {
    promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined,
    completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined,
    totalTokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : undefined,
    costUsd: typeof usage.cost === 'number' ? usage.cost : undefined
  };
};

/** OpenRouter content can be a plain string or an array of parts. Flatten to text. */
const extractText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (part && typeof part.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }
  return '';
};

/** Pull generated image data URLs from an OpenRouter chat response. */
const extractImages = (data: any): string[] => {
  const message = data?.choices?.[0]?.message;
  const urls: string[] = [];
  // Preferred: message.images[] = [{ type:'image_url', image_url:{ url } }]
  const images = message?.images;
  if (Array.isArray(images)) {
    for (const img of images) {
      const url = img?.image_url?.url || img?.url;
      if (typeof url === 'string' && url) urls.push(url);
    }
  }
  // Fallback: image parts embedded in message.content[]
  if (urls.length === 0 && Array.isArray(message?.content)) {
    for (const part of message.content) {
      const url = part?.image_url?.url;
      if (typeof url === 'string' && url) urls.push(url);
    }
  }
  return urls;
};

const num = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeCatalogModel = (raw: any): CatalogModel => {
  const id: string = String(raw?.id || '');
  const pricing = raw?.pricing || {};
  const promptPerToken = num(pricing.prompt);
  const completionPerToken = num(pricing.completion);
  const imagePerImage = num(pricing.image);
  const requestFlat = num(pricing.request);
  const inputModalities: string[] = Array.isArray(raw?.architecture?.input_modalities)
    ? raw.architecture.input_modalities
    : [];
  const outputModalities: string[] = Array.isArray(raw?.architecture?.output_modalities)
    ? raw.architecture.output_modalities
    : [];
  const supportedParameters: string[] = Array.isArray(raw?.supported_parameters)
    ? raw.supported_parameters
    : [];
  const supportsImageOutput = outputModalities.includes('image');
  // Did the upstream actually report pricing? `num()` coerces missing fields to 0,
  // which would otherwise read as "all axes free" → a false "Free" label. We only
  // trust an all-zero classification when at least one pricing field was present.
  const pricingReported = ['prompt', 'completion', 'image', 'request'].some(
    (k) => pricing[k] !== undefined && pricing[k] !== null && pricing[k] !== ''
  );
  // `isFree` is the strict classification from shared/pricing: a model whose id
  // ends `:free` OR whose four pricing axes are all zero. Token-billed image
  // models (imagePerImage=0 but completionPerToken>0) are NOT free — those bill
  // the caller's key per call. costClass exposes the full 4-way truth to the UI.
  let cls = classifyModel({
    modelId: id,
    pricing: { promptPerToken, completionPerToken, imagePerImage, requestFlat },
    supportsImageOutput
  });
  // Conservative guard: never advertise a model as free purely because its pricing
  // is unknown. Without reported pricing (and absent a `:free` id) treat it as paid,
  // so users are never billed under a wrong "Free" label.
  if (cls === 'free_verified' && !pricingReported && !hasFreeSuffix(id)) {
    cls = 'paid';
  }
  const isFree = cls === 'free_verified';

  return {
    id,
    name: String(raw?.name || id),
    source: 'openrouter',
    description: typeof raw?.description === 'string' ? raw.description : undefined,
    contextLength: typeof raw?.context_length === 'number' ? raw.context_length : undefined,
    inputModalities,
    outputModalities,
    supportedParameters,
    pricing: { promptPerToken, completionPerToken, imagePerImage, requestFlat },
    isFree,
    costClass: cls,
    supportsImageOutput,
    supportsImageInput: inputModalities.includes('image'),
    supportsJsonOutput:
      supportedParameters.includes('response_format') || supportedParameters.includes('structured_outputs')
  };
};

const generateTextOnce = async (
  req: GenerateTextRequest,
  ctx: ProviderContext
): Promise<GenerateTextResult> => {
  const wantsJson = Boolean(req.jsonSchema || req.jsonMode);
  const timeoutMs = req.timeoutMs ?? OPENROUTER_REQUEST_TIMEOUT_MS;

  const baseBody: Record<string, unknown> = {
    model: req.model,
    usage: { include: true }
  };
  if (typeof req.temperature === 'number') baseBody.temperature = req.temperature;
  if (typeof req.maxTokens === 'number') baseBody.max_tokens = req.maxTokens;
  if (req.jsonSchema) {
    baseBody.response_format = {
      type: 'json_schema',
      json_schema: {
        name: req.jsonSchema.name,
        strict: req.jsonSchema.strict ?? true,
        schema: req.jsonSchema.schema
      }
    };
  } else if (req.jsonMode) {
    baseBody.response_format = { type: 'json_object' };
  }

  // Engage step-by-step reasoning on reasoning-capable models. A per-request
  // `reasoningEffort` (set by the chat platform's reasoning control) wins; otherwise
  // fall back to the global REASONING_EFFORT default for known reasoning families.
  // Other models ignore the param; reasoning models benefit most on structured/planning calls.
  if (req.reasoningEffort) {
    baseBody.reasoning = { effort: req.reasoningEffort };
  } else if (REASONING_EFFORT !== 'off' && REASONING_MODEL_RE.test(req.model)) {
    baseBody.reasoning = { effort: REASONING_EFFORT };
  }

  // Live web search: OpenRouter's `web` plugin grounds the answer in current internet
  // results for any model. Citations come back inline in the response text.
  if (req.webSearch) {
    baseBody.plugins = [{ id: 'web', max_results: 5 }];
  }

  const run = async (messages: GenerateTextRequest['messages']) => {
    const data = await openRouterFetch<any>(
      '/chat/completions',
      { method: 'POST', body: JSON.stringify({ ...baseBody, messages }) },
      timeoutMs,
      ctx
    );
    return { data, text: extractText(data?.choices?.[0]?.message?.content) };
  };

  let { data, text } = await withRetry(() => run(req.messages), req.retries ?? 3, 1500, 'OpenRouter text');

  let json: unknown | undefined;
  if (wantsJson) {
    json = coerceJsonOrNull(text);
    if (json === null) {
      // One corrective round-trip before giving up.
      const repaired = await run([
        ...req.messages,
        { role: 'assistant', content: text },
        { role: 'user', content: JSON_REPAIR_INSTRUCTION }
      ]);
      data = repaired.data;
      text = repaired.text;
      json = coerceJson(text); // throws if still invalid
    }
  }

  return {
    text,
    json,
    model: String(data?.model || req.model),
    usage: parseUsage(data),
    raw: data
  };
};

/**
 * Generate text, retrying on a reliable fallback model when the chosen model is
 * unavailable (404 "No endpoints") or rate-limited (429) — common for free models.
 */
const generateText = async (
  req: GenerateTextRequest,
  ctx: ProviderContext
): Promise<GenerateTextResult> => {
  try {
    return await generateTextOnce(req, ctx);
  } catch (err) {
    const msg = String((err as Error)?.message || '');
    const retriable = /\b404\b|\b429\b|no endpoints|rate.?limit/i.test(msg);
    // Under free-only mode we deliberately do NOT retry on a paid fallbackModel —
    // that would defeat the whole point. Surface the error so the route can return
    // a Block + explain response instead of charging the caller's key.
    if (!req.freeOnly && req.fallbackModel && req.fallbackModel !== req.model && retriable) {
      return await generateTextOnce({ ...req, model: req.fallbackModel, fallbackModel: undefined }, ctx);
    }
    throw err;
  }
};

const generateImage = async (
  req: GenerateImageRequest,
  ctx: ProviderContext
): Promise<GenerateImageResult> => {
  const timeoutMs = req.timeoutMs ?? OPENROUTER_REQUEST_TIMEOUT_MS;
  const promptText = req.negativePrompt ? `${req.prompt}\n\n${req.negativePrompt}` : req.prompt;

  const content: MessagePart[] = [{ type: 'text', text: promptText }];
  for (const url of req.referenceImages || []) {
    if (url) content.push({ type: 'image_url', image_url: { url } });
  }

  const body = {
    model: req.model,
    messages: [{ role: 'user', content }],
    modalities: ['image', 'text'],
    usage: { include: true }
  };

  const data = await withRetry(
    () =>
      openRouterFetch<any>('/chat/completions', { method: 'POST', body: JSON.stringify(body) }, timeoutMs, ctx),
    req.retries ?? 2,
    1500,
    'OpenRouter image'
  );

  const images = extractImages(data);
  if (images.length === 0) {
    throw new Error('OpenRouter returned no image. Confirm the model supports image output.');
  }

  return {
    imageDataUrl: images[0],
    images,
    model: String(data?.model || req.model),
    usage: parseUsage(data),
    raw: data
  };
};

/**
 * Live, authoritative key status from OpenRouter (GET /api/v1/key). Returns the real
 * usage/limit/is_free_tier — the source of truth for the verification + usage display.
 * Never throws: returns null on failure so the UI degrades gracefully.
 */
export const fetchOpenRouterKeyStatus = async (apiKey: string): Promise<Record<string, unknown> | null> => {
  if (!apiKey) return null;
  try {
    const data = await openRouterFetch<any>('/key', { method: 'GET' }, OPENROUTER_REQUEST_TIMEOUT_MS, { apiKey, byok: true });
    return (data && typeof data === 'object' && data.data) ? data.data : data ?? null;
  } catch {
    return null;
  }
};

const listModels = async (ctx?: ProviderContext): Promise<CatalogModel[]> => {
  const data = await openRouterFetch<any>('/models', { method: 'GET' }, OPENROUTER_REQUEST_TIMEOUT_MS, ctx);
  const rows: any[] = Array.isArray(data?.data) ? data.data : [];
  return rows.map(normalizeCatalogModel).filter((model) => Boolean(model.id));
};

export const openRouterProvider: AIProvider = {
  id: 'openrouter',
  generateText,
  generateImage,
  listModels
};
