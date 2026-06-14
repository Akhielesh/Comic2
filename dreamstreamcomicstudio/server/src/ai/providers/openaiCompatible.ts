// Generic OpenAI-compatible provider factory.
//
// Most modern providers (OpenAI, Google/Gemini via its OpenAI-compatible endpoint,
// DeepSeek, Z.AI/GLM, MiniMax, Tencent Hunyuan, xAI/Grok) speak the exact same
// `/chat/completions` wire protocol as OpenRouter and NVIDIA. Rather than copy the
// NVIDIA provider eight times, this factory produces a complete `AIProvider` from a
// small config (base URL + capabilities + curated catalog seed). Native tool-calling
// and SSE streaming are included, so the new sources behave like first-class providers
// in chat (not just the JSON-protocol fallback path).
//
// NOTE: written against each provider's documented OpenAI-compatible API; like the
// existing OpenRouter/NVIDIA providers it cannot be runtime-verified in the build
// sandbox (no outbound network). Validate end-to-end with a real key per provider.

import { CHAT_STREAM_MAX_TOTAL_MS } from '../../config.js';
import { withRetry } from '../utils.js';
import { modelTimeoutError } from './errors.js';
import { coerceJson, coerceJsonOrNull } from '../jsonCoerce.js';
import { staticModelsFor } from './staticModels.js';
import type {
  AIProvider,
  AIProviderId,
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

export interface OpenAICompatibleConfig {
  id: AIProviderId;
  /** API base URL (without trailing slash); `/chat/completions` etc. are appended. */
  baseUrl: string;
  timeoutMs: number;
  /** Path that lists models, or null when the provider has no public listing. */
  modelsPath: string | null;
  /** Extra headers some providers require. */
  extraHeaders?: Record<string, string>;
  /** Send `reasoning_effort` to reasoning-capable models (OpenAI / xAI style). */
  supportsReasoningEffort?: boolean;
  /** Pass native function tools (most do; set false to force the JSON-protocol fallback). */
  supportsTools?: boolean;
  /** Attempt OpenAI-style /images/generations for image requests. */
  supportsImages?: boolean;
  /** Human label for error messages. */
  label: string;
}

const VISION_HINT = /\b(vl|vlm|vision|multimodal|4o|4\.1|gpt-5|gemini|grok-[24]|claude|glm-4\.5v)\b/i;
const REASONING_HINT = /\b(o1|o3|o4|r1|reasoner|reasoning|thinking|grok-[34].*(mini|reasoning)|glm-4\.[56]|gpt-5)\b/i;

export const createOpenAICompatibleProvider = (cfg: OpenAICompatibleConfig): AIProvider => {
  const buildHeaders = (ctx?: ProviderContext): Record<string, string> => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(cfg.extraHeaders || {}) };
    if (ctx?.apiKey) headers['Authorization'] = `Bearer ${ctx.apiKey}`;
    return headers;
  };

  const doFetch = async <T = any>(
    path: string,
    init: { method?: string; body?: string },
    timeoutMs: number,
    ctx?: ProviderContext
  ): Promise<T> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl}${path}`, {
        method: init.method || 'GET',
        headers: buildHeaders(ctx),
        body: init.body,
        signal: controller.signal
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`${cfg.label} ${path} failed: ${res.status} ${res.statusText} ${errBody.slice(0, 500)}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      if (controller.signal.aborted) throw modelTimeoutError(timeoutMs);
      throw err;
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

  const extractText = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map((p: any) => (p && typeof p.text === 'string' ? p.text : '')).join('').trim();
    }
    return '';
  };

  const extractToolCalls = (data: any) => {
    const calls = data?.choices?.[0]?.message?.tool_calls;
    if (!Array.isArray(calls) || calls.length === 0) return undefined;
    const out = calls
      .map((c: any) => ({
        id: String(c?.id || ''),
        name: String(c?.function?.name || ''),
        arguments:
          typeof c?.function?.arguments === 'string'
            ? c.function.arguments
            : JSON.stringify(c?.function?.arguments || {})
      }))
      .filter((c: { name: string }) => Boolean(c.name));
    return out.length ? out : undefined;
  };

  const extractReasoning = (data: any): string | undefined => {
    const message = data?.choices?.[0]?.message;
    const reasoning = message?.reasoning ?? message?.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.trim()) return reasoning.trim();
    return undefined;
  };

  const buildBaseBody = (req: GenerateTextRequest): Record<string, unknown> => {
    const body: Record<string, unknown> = { model: req.model };
    if (typeof req.temperature === 'number') body.temperature = req.temperature;
    if (typeof req.maxTokens === 'number') body.max_tokens = req.maxTokens;
    if (req.jsonSchema || req.jsonMode) body.response_format = { type: 'json_object' };
    if (cfg.supportsReasoningEffort && req.reasoningEffort) body.reasoning_effort = req.reasoningEffort;
    if (cfg.supportsTools !== false && req.tools && req.tools.length) {
      body.tools = req.tools;
      body.tool_choice = 'auto';
    }
    return body;
  };

  const generateTextOnce = async (req: GenerateTextRequest, ctx: ProviderContext): Promise<GenerateTextResult> => {
    const wantsJson = Boolean(req.jsonSchema || req.jsonMode);
    const timeoutMs = req.timeoutMs ?? cfg.timeoutMs;
    const baseBody = buildBaseBody(req);

    const run = async (messages: GenerateTextRequest['messages']) => {
      const data = await doFetch<any>(
        '/chat/completions',
        { method: 'POST', body: JSON.stringify({ ...baseBody, messages }) },
        timeoutMs,
        ctx
      );
      return { data, text: extractText(data?.choices?.[0]?.message?.content) };
    };

    let { data, text } = await withRetry(() => run(req.messages), req.retries ?? 3, 1500, `${cfg.label} text`);

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
      reasoning: extractReasoning(data),
      toolCalls: extractToolCalls(data),
      raw: data
    };
  };

  const generateText = async (req: GenerateTextRequest, ctx: ProviderContext): Promise<GenerateTextResult> => {
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

  const generateTextStream = async (
    req: GenerateTextRequest,
    ctx: ProviderContext,
    onDelta: (delta: { content?: string; reasoning?: string }) => void
  ): Promise<GenerateTextResult> => {
    const idleMs = req.timeoutMs ?? cfg.timeoutMs;
    const overallDeadline = Date.now() + Math.max(CHAT_STREAM_MAX_TOTAL_MS, idleMs * 2);
    const controller = new AbortController();
    let idleTimedOut = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        controller.abort();
      }, idleMs);
    };

    let text = '';
    let reasoning = '';
    let model = req.model;
    let usage: ProviderUsage = {};
    let raw: any = null;
    const toolAcc = new Map<number, { id: string; name: string; args: string }>();

    const buildResult = (): GenerateTextResult => {
      const toolCalls = Array.from(toolAcc.values())
        .filter((t) => t.name)
        .map((t) => ({ id: t.id || `call_${t.name}`, name: t.name, arguments: t.args || '{}' }));
      return {
        text,
        model: String(model || req.model),
        usage,
        reasoning: reasoning || undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        raw
      };
    };

    armIdle();
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: buildHeaders(ctx),
        body: JSON.stringify({ ...buildBaseBody(req), messages: req.messages, stream: true, stream_options: { include_usage: true } }),
        signal: controller.signal
      });
      if (!res.ok || !res.body) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`${cfg.label} stream failed: ${res.status} ${res.statusText} ${errBody.slice(0, 300)}`);
      }

      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const handle = (payload: string) => {
        if (!payload || payload === '[DONE]') return;
        let chunk: any;
        try { chunk = JSON.parse(payload); } catch { return; }
        raw = chunk;
        if (chunk.model) model = chunk.model;
        if (chunk.usage) usage = parseUsage(chunk);
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        if (delta?.content) { text += delta.content; onDelta({ content: delta.content }); }
        const dr = delta?.reasoning ?? delta?.reasoning_content;
        if (typeof dr === 'string' && dr) { reasoning += dr; onDelta({ reasoning: dr }); }
        if (Array.isArray(delta?.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === 'number' ? tc.index : 0;
            const cur = toolAcc.get(idx) || { id: '', name: '', args: '' };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name = tc.function.name;
            if (typeof tc.function?.arguments === 'string') cur.args += tc.function.arguments;
            toolAcc.set(idx, cur);
          }
        }
      };

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle();
        if (Date.now() > overallDeadline) { idleTimedOut = true; controller.abort(); break; }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (t.startsWith('data:')) handle(t.slice(5).trim());
        }
      }
      const tail = buffer.trim();
      if (tail.startsWith('data:')) handle(tail.slice(5).trim());

      return buildResult();
    } catch (err) {
      if (idleTimedOut || controller.signal.aborted) {
        if (text.trim() || toolAcc.size > 0) return buildResult();
        throw new Error(`The model stopped responding (no output for ${Math.round(idleMs / 1000)}s). Please try again, or pick a faster model.`);
      }
      throw err;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }
  };

  const generateImage = async (req: GenerateImageRequest, ctx: ProviderContext): Promise<GenerateImageResult> => {
    if (!cfg.supportsImages) {
      throw new Error(`${cfg.label} is configured as a text provider — image generation isn’t available here.`);
    }
    const timeoutMs = req.timeoutMs ?? cfg.timeoutMs;
    const prompt = req.negativePrompt ? `${req.prompt}\n\n${req.negativePrompt}` : req.prompt;
    const data = await withRetry(
      () => doFetch<any>('/images/generations', { method: 'POST', body: JSON.stringify({ model: req.model, prompt, response_format: 'b64_json' }) }, timeoutMs, ctx),
      req.retries ?? 1,
      1500,
      `${cfg.label} image`
    );
    const b64: string | undefined = data?.data?.[0]?.b64_json || data?.data?.[0]?.url || data?.image;
    if (!b64) throw new Error(`${cfg.label} returned no image.`);
    const url = b64.startsWith('http') || b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`;
    return { imageDataUrl: url, images: [url], model: String(data?.model || req.model), usage: {}, raw: data };
  };

  // Live /models (when available + a key is present) merged ON TOP of the curated seed,
  // so newly-released ids appear while the seed guarantees rich info offline / keyless.
  const listModels = async (ctx?: ProviderContext): Promise<CatalogModel[]> => {
    const seed = staticModelsFor(cfg.id);
    const seedById = new Map(seed.map((m) => [m.id, m]));
    if (!cfg.modelsPath || !ctx?.apiKey) return seed;
    try {
      const data = await doFetch<any>(cfg.modelsPath, { method: 'GET' }, cfg.timeoutMs, ctx);
      const rows: any[] = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      const live: CatalogModel[] = [];
      for (const row of rows) {
        const id = String(row?.id || row?.name || '').trim();
        if (!id) continue;
        // Prefer the curated entry (rich pricing/caps) when ids match; otherwise synthesize
        // a minimal entry so the model is still selectable.
        if (seedById.has(id)) continue;
        live.push({
          id,
          name: String(row?.name || row?.display_name || id),
          source: cfg.id,
          description: typeof row?.description === 'string' ? row.description : undefined,
          contextLength: typeof row?.context_length === 'number' ? row.context_length : undefined,
          createdAt: typeof row?.created === 'number' ? row.created : undefined,
          inputModalities: VISION_HINT.test(id) ? ['text', 'image'] : ['text'],
          outputModalities: ['text'],
          supportedParameters: ['response_format'],
          // No public pricing on these list endpoints — leave axes at 0 but classify as
          // 'paid' so the model is never falsely advertised as free.
          pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 },
          isFree: false,
          costClass: 'paid',
          supportsImageOutput: false,
          supportsImageInput: VISION_HINT.test(id),
          supportsJsonOutput: true
        });
      }
      return [...seed, ...live];
    } catch {
      return seed;
    }
  };

  return {
    id: cfg.id,
    generateText,
    generateTextStream,
    generateImage,
    listModels
  };
};
