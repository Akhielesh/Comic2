// NVIDIA Build (NIM) provider — an OpenAI-compatible TEXT/LLM source.
//
// Text:   POST /chat/completions (OpenAI-compatible).
// Models: GET /models (OpenAI-style { data: [{ id }] }; requires a key — NVIDIA's catalog
//         is NOT public the way OpenRouter's is).
// Auth:   Authorization: Bearer nvapi-...
// Base:   https://integrate.api.nvidia.com/v1  (NVIDIA_BASE_URL)
//
// Scope: NVIDIA Build is integrated as a TEXT source. Its image-generation models use
// non-chat request schemas, so image output is intentionally NOT routed here — covers stay
// on OpenRouter/Gemini/Flux. Free tier per NVIDIA: ~1,000 credits (up to 5,000), 40 req/min.
//
// NOTE: like the OpenRouter provider, this is written against NVIDIA's documented
// OpenAI-compatible API but cannot be runtime-verified in the build sandbox (no outbound
// network). Validate end-to-end with a real `nvapi-` key in a networked environment.

import { NVIDIA_BASE_URL, NVIDIA_REQUEST_TIMEOUT_MS } from '../../config.js';
import { withRetry } from '../utils.js';
import { coerceJson, coerceJsonOrNull } from '../jsonCoerce.js';
import type {
  AIProvider,
  CatalogModel,
  GenerateImageRequest,
  GenerateImageResult,
  GenerateTextRequest,
  GenerateTextResult,
  ProviderContext,
  ProviderUsage
} from './types.js';

const JSON_REPAIR_INSTRUCTION =
  'Your previous reply was not valid JSON. Reply again with ONLY valid, minified JSON that matches the requested structure — no prose, no explanation, no markdown code fences.';

const buildHeaders = (ctx?: ProviderContext): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ctx?.apiKey) headers['Authorization'] = `Bearer ${ctx.apiKey}`;
  return headers;
};

const nvidiaFetch = async <T = any>(
  path: string,
  init: { method?: string; body?: string },
  timeoutMs: number,
  ctx?: ProviderContext
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${NVIDIA_BASE_URL}${path}`, {
      method: init.method || 'GET',
      headers: buildHeaders(ctx),
      body: init.body,
      signal: controller.signal
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`NVIDIA ${path} failed: ${res.status} ${res.statusText} ${errBody.slice(0, 500)}`);
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
    // NVIDIA Build is credit-based and does not report a per-call USD cost.
    costUsd: typeof usage.cost === 'number' ? usage.cost : undefined
  };
};

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

const VISION_HINT = /\b(vl|vlm|vila|neva|vision|llava)\b/i;

// NVIDIA's /models returns mostly bare ids (e.g. "meta/llama-3.3-70b-instruct"). Turn that
// into a readable label so the catalog doesn't look "basic".
const prettifyId = (id: string): string => {
  const tail = id.includes('/') ? id.slice(id.indexOf('/') + 1) : id;
  return tail
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => (/\d/.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
};

const generateTextOnce = async (
  req: GenerateTextRequest,
  ctx: ProviderContext
): Promise<GenerateTextResult> => {
  const wantsJson = Boolean(req.jsonSchema || req.jsonMode);
  const timeoutMs = req.timeoutMs ?? NVIDIA_REQUEST_TIMEOUT_MS;

  const baseBody: Record<string, unknown> = { model: req.model };
  if (typeof req.temperature === 'number') baseBody.temperature = req.temperature;
  if (typeof req.maxTokens === 'number') baseBody.max_tokens = req.maxTokens;
  // NVIDIA NIMs vary in strict json_schema support; request a plain JSON object and rely on
  // the coerce/repair pass below, which is more portable across the catalog.
  if (wantsJson) baseBody.response_format = { type: 'json_object' };

  const run = async (messages: GenerateTextRequest['messages']) => {
    const data = await nvidiaFetch<any>(
      '/chat/completions',
      { method: 'POST', body: JSON.stringify({ ...baseBody, messages }) },
      timeoutMs,
      ctx
    );
    return { data, text: extractText(data?.choices?.[0]?.message?.content) };
  };

  let { data, text } = await withRetry(() => run(req.messages), req.retries ?? 3, 1500, 'NVIDIA text');

  let json: unknown | undefined;
  if (wantsJson) {
    json = coerceJsonOrNull(text);
    if (json === null) {
      const repaired = await run([
        ...req.messages,
        { role: 'assistant', content: text },
        { role: 'user', content: JSON_REPAIR_INSTRUCTION }
      ]);
      data = repaired.data;
      text = repaired.text;
      json = coerceJson(text);
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

const generateText = async (
  req: GenerateTextRequest,
  ctx: ProviderContext
): Promise<GenerateTextResult> => {
  try {
    return await generateTextOnce(req, ctx);
  } catch (err) {
    const msg = String((err as Error)?.message || '');
    const retriable = /\b404\b|\b429\b|\b503\b|rate.?limit/i.test(msg);
    if (req.fallbackModel && req.fallbackModel !== req.model && retriable) {
      return await generateTextOnce({ ...req, model: req.fallbackModel, fallbackModel: undefined }, ctx);
    }
    throw err;
  }
};

// NVIDIA hosts free image models (FLUX, SDXL, …) via an OpenAI-compatible
// /v1/images/generations endpoint (returns data[].b64_json; native FLUX returns
// artifacts[].base64). We target the OpenAI-compatible shape with a base64 fallback.
const generateImage = async (
  req: GenerateImageRequest,
  ctx: ProviderContext
): Promise<GenerateImageResult> => {
  const timeoutMs = req.timeoutMs ?? NVIDIA_REQUEST_TIMEOUT_MS;
  const prompt = req.negativePrompt ? `${req.prompt}\n\n${req.negativePrompt}` : req.prompt;
  const body = { model: req.model, prompt, response_format: 'b64_json' };
  const data = await withRetry(
    () => nvidiaFetch<any>('/images/generations', { method: 'POST', body: JSON.stringify(body) }, timeoutMs, ctx),
    req.retries ?? 1,
    1500,
    'NVIDIA image'
  );
  const b64: string | undefined = data?.data?.[0]?.b64_json || data?.artifacts?.[0]?.base64 || data?.image;
  if (!b64) {
    throw new Error('NVIDIA returned no image. Confirm the model is an image-generation model.');
  }
  const url = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;
  return { imageDataUrl: url, images: [url], model: String(data?.model || req.model), usage: {}, raw: data };
};

const IMAGE_HINT = /\b(flux|sdxl|stable[-_]?diffusion|sd3|sd-3|sana|kandinsky|playground|consistency|imagen|stable[-_]?image|stablediffusion)\b/i;
const IMAGE_EDIT_HINT = /\b(kontext|canny|depth|inpaint|redux|edit)\b/i;

const normalizeCatalogModel = (raw: any): CatalogModel => {
  const id = String(raw?.id || '');
  const isImage = IMAGE_HINT.test(id);
  const isVision = VISION_HINT.test(id);
  const isEdit = isImage && IMAGE_EDIT_HINT.test(id);
  return {
    id,
    name: String(raw?.name || raw?.display_name || prettifyId(id)),
    source: 'nvidia',
    description: typeof raw?.description === 'string' ? raw.description : undefined,
    contextLength: typeof raw?.context_length === 'number' ? raw.context_length : undefined,
    inputModalities: isImage ? (isEdit ? ['text', 'image'] : ['text']) : (isVision ? ['text', 'image'] : ['text']),
    outputModalities: isImage ? ['image'] : ['text'],
    supportedParameters: isImage ? [] : ['response_format'],
    // NVIDIA Build models are credit-based with no per-call pricing in the catalog.
    pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 },
    // Free to call under the NVIDIA Build free tier (subject to its own credit/rate caps).
    isFree: true,
    supportsImageOutput: isImage,
    supportsImageInput: isEdit || isVision,
    supportsJsonOutput: !isImage
  };
};

const listModels = async (ctx?: ProviderContext): Promise<CatalogModel[]> => {
  if (!ctx?.apiKey) return []; // NVIDIA's /models requires auth; no key => no NVIDIA catalog.
  const data = await nvidiaFetch<any>('/models', { method: 'GET' }, NVIDIA_REQUEST_TIMEOUT_MS, ctx);
  const rows: any[] = Array.isArray(data?.data) ? data.data : [];
  return rows.map(normalizeCatalogModel).filter((model) => Boolean(model.id));
};

export const nvidiaProvider: AIProvider = {
  id: 'nvidia',
  generateText,
  generateImage,
  listModels
};
