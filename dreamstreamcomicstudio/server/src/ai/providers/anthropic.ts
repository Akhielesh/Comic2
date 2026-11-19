// Anthropic (Claude) provider — native Messages API.
//
// Anthropic does not speak the OpenAI `/chat/completions` shape, so this adapter maps
// our provider-agnostic ChatMessage[] (OpenAI-style: system/user/assistant/tool +
// tool_calls) to/from Anthropic's `/v1/messages` format (top-level `system`, content
// blocks, `tool_use` / `tool_result`). Streaming uses Anthropic's SSE event protocol.
//
// NOTE: written against Anthropic's documented API; not runtime-verified in the build
// sandbox. Validate with a real `sk-ant-` key.
//
// Calls made with a person's own key (ctx.byok) go only to the registry address
// (https://api.anthropic.com/v1, shared/providers.ts), never to an ANTHROPIC_BASE_URL override,
// and never follow a redirect. Failures carry status, vendor code and a redacted detail only
// (errors.ts vendorHttpError). generateText (never the stream) asks for a bounded thinking budget
// when the request sets reasoningEffort.

import { ANTHROPIC_BASE_URL, ANTHROPIC_REQUEST_TIMEOUT_MS, ANTHROPIC_VERSION, CHAT_STREAM_MAX_TOTAL_MS } from '../../config.js';
import { withRetry } from '../utils.js';
import { modelTimeoutError, vendorHttpError } from './errors.js';
import { coerceJson, coerceJsonOrNull } from '../jsonCoerce.js';
import { staticModelsFor } from './staticModels.js';
import { reasoningBudget } from './openrouter.js';
import { logger } from '../../lib/logger.js';
import { PROVIDER_REGISTRY } from '../../../../shared/providers.js';
import type {
  AIProvider,
  CatalogModel,
  ChatMessage,
  GenerateImageRequest,
  GenerateImageResult,
  GenerateTextRequest,
  GenerateTextResult,
  MessagePart,
  ProviderContext,
  ProviderUsage,
  ToolSpec
} from './types.js';

const DEFAULT_MAX_TOKENS = 4096;
/** Anthropic's smallest accepted thinking budget. */
const MIN_THINKING_BUDGET = 1024;
const OWN_KEY_BASE_URL = PROVIDER_REGISTRY.anthropic.baseUrl;
/** Own-key calls always go to the maker's fixed address; platform calls may use the override. */
const baseFor = (ctx?: ProviderContext): string => (ctx?.byok ? OWN_KEY_BASE_URL : ANTHROPIC_BASE_URL);
const JSON_REPAIR_INSTRUCTION =
  'Your previous reply was not valid JSON. Reply again with ONLY valid, minified JSON that matches the requested structure — no prose, no explanation, no markdown code fences.';

const buildHeaders = (ctx?: ProviderContext): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': ANTHROPIC_VERSION
  };
  if (ctx?.apiKey) headers['x-api-key'] = ctx.apiKey;
  return headers;
};

const anthropicFetch = async <T = any>(
  path: string,
  init: { method?: string; body?: string },
  timeoutMs: number,
  ctx?: ProviderContext
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseFor(ctx)}${path}`, {
      method: init.method || 'GET',
      headers: buildHeaders(ctx),
      body: init.body,
      signal: controller.signal,
      // A redirect could carry the x-api-key header somewhere else: refuse it.
      redirect: 'error'
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw vendorHttpError('Anthropic', path, res.status, res.statusText, errBody);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (controller.signal.aborted) throw modelTimeoutError(timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

const parseUsage = (usage: any): ProviderUsage => ({
  promptTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined,
  completionTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined,
  totalTokens:
    typeof usage?.input_tokens === 'number' && typeof usage?.output_tokens === 'number'
      ? usage.input_tokens + usage.output_tokens
      : undefined
});

/** Map a data:/http image URL to an Anthropic image source block. */
const imageSource = (url: string): Record<string, unknown> | null => {
  if (url.startsWith('data:')) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(url);
    if (!m) return null;
    return { type: 'base64', media_type: m[1], data: m[2] };
  }
  if (/^https?:\/\//i.test(url)) return { type: 'url', url };
  return null;
};

const partsToBlocks = (content: string | MessagePart[]): Record<string, unknown>[] => {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const blocks: Record<string, unknown>[] = [];
  for (const part of content) {
    if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url') {
      const src = imageSource(part.image_url.url);
      if (src) blocks.push({ type: 'image', source: src });
    }
  }
  return blocks;
};

/** Convert our OpenAI-style messages to Anthropic { system, messages }. Exported for tests. */
export const toAnthropic = (messages: ChatMessage[]): { system?: string; messages: Record<string, unknown>[] } => {
  const systemParts: string[] = [];
  const turns: { role: 'user' | 'assistant'; blocks: Record<string, unknown>[] }[] = [];

  const push = (role: 'user' | 'assistant', blocks: Record<string, unknown>[]) => {
    if (blocks.length === 0) return;
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.blocks.push(...blocks);
    else turns.push({ role, blocks });
  };

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = typeof msg.content === 'string' ? msg.content : partsToBlocks(msg.content).map((b: any) => b.text || '').join('');
      if (text.trim()) systemParts.push(text);
      continue;
    }
    if (msg.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: msg.tool_call_id || '', content: typeof msg.content === 'string' ? msg.content : '' }]);
      continue;
    }
    if (msg.role === 'assistant') {
      const blocks = partsToBlocks(msg.content);
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let input: unknown = {};
          try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
      }
      push('assistant', blocks);
      continue;
    }
    // user
    push('user', partsToBlocks(msg.content));
  }

  // Anthropic requires the first message to be from the user.
  while (turns.length && turns[0].role !== 'user') turns.shift();

  return {
    system: systemParts.length ? systemParts.join('\n\n') : undefined,
    messages: turns.map((t) => ({ role: t.role, content: t.blocks }))
  };
};

const toAnthropicTools = (tools?: ToolSpec[]) =>
  tools && tools.length
    ? tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }))
    : undefined;

/** The thinking budget for an effort: the shared reasoning budget, never below Anthropic's minimum. */
export const thinkingBudget = (effort: 'low' | 'medium' | 'high'): number => Math.max(MIN_THINKING_BUDGET, reasoningBudget(effort));

const buildBody = (req: GenerateTextRequest, opts: { thinking?: boolean } = {}): Record<string, unknown> => {
  const { system, messages } = toAnthropic(req.messages);
  const maxTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS;
  const body: Record<string, unknown> = { model: req.model, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  if (opts.thinking && req.reasoningEffort) {
    const budget = thinkingBudget(req.reasoningEffort);
    body.thinking = { type: 'enabled', budget_tokens: budget };
    // Thinking counts against max_tokens, which must exceed the budget. A caller that sized
    // max_tokens for the visible reply only (comic/llm.ts pads it already) keeps that room.
    if (maxTokens <= budget) body.max_tokens = maxTokens + budget;
    // Anthropic accepts no temperature other than the default while thinking.
  } else if (typeof req.temperature === 'number') {
    body.temperature = req.temperature;
  }
  const tools = toAnthropicTools(req.tools);
  if (tools) { body.tools = tools; body.tool_choice = { type: 'auto' }; }
  return body;
};

/** A 400 that names thinking: the model or the request shape refused the thinking settings. */
const refusedThinking = (err: unknown): boolean => {
  const e = err as { status?: number; message?: string } | undefined;
  return e?.status === 400 && /thinking/i.test(String(e?.message || ''));
};

const extractTextBlocks = (content: any[]): { text: string; toolCalls?: { id: string; name: string; arguments: string }[]; reasoning?: string } => {
  let text = '';
  let reasoning = '';
  const toolCalls: { id: string; name: string; arguments: string }[] = [];
  for (const block of content || []) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text;
    else if (block?.type === 'thinking' && typeof block.thinking === 'string') reasoning += block.thinking;
    else if (block?.type === 'tool_use') {
      toolCalls.push({ id: String(block.id || ''), name: String(block.name || ''), arguments: JSON.stringify(block.input ?? {}) });
    }
  }
  return { text: text.trim(), toolCalls: toolCalls.length ? toolCalls : undefined, reasoning: reasoning.trim() || undefined };
};

const generateTextOnce = async (req: GenerateTextRequest, ctx: ProviderContext): Promise<GenerateTextResult> => {
  const wantsJson = Boolean(req.jsonSchema || req.jsonMode);
  const timeoutMs = req.timeoutMs ?? ANTHROPIC_REQUEST_TIMEOUT_MS;

  // Thinking stays on for every round of this call until the vendor refuses it once.
  let thinking = Boolean(req.reasoningEffort);
  const send = (messages: ChatMessage[]) =>
    anthropicFetch<any>('/messages', { method: 'POST', body: JSON.stringify(buildBody({ ...req, messages }, { thinking })) }, timeoutMs, ctx);

  const run = async (messages: ChatMessage[]) => {
    let data: any;
    try {
      data = await send(messages);
    } catch (err) {
      if (!thinking || !refusedThinking(err)) throw err;
      // One retry of this call without thinking; the reason stays out of the log (no body).
      thinking = false;
      logger.info('anthropic_thinking_retry', { model: req.model });
      data = await send(messages);
    }
    return { data, parsed: extractTextBlocks(data?.content) };
  };

  let { data, parsed } = await withRetry(() => run(req.messages), req.retries ?? 3, 1500, 'Anthropic text');
  let text = parsed.text;

  let json: unknown | undefined;
  if (wantsJson) {
    json = coerceJsonOrNull(text);
    if (json === null) {
      const repaired = await run([...req.messages, { role: 'assistant', content: text }, { role: 'user', content: JSON_REPAIR_INSTRUCTION }]);
      data = repaired.data;
      parsed = repaired.parsed;
      text = parsed.text;
      json = coerceJson(text);
    }
  }

  return {
    text,
    json,
    model: String(data?.model || req.model),
    usage: parseUsage(data?.usage),
    reasoning: parsed.reasoning,
    toolCalls: parsed.toolCalls,
    raw: data
  };
};

const generateText = async (req: GenerateTextRequest, ctx: ProviderContext): Promise<GenerateTextResult> => {
  try {
    return await generateTextOnce(req, ctx);
  } catch (err) {
    const msg = String((err as Error)?.message || '');
    const retriable = /\b404\b|\b429\b|\b529\b|overloaded|rate.?limit/i.test(msg);
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
  const idleMs = req.timeoutMs ?? ANTHROPIC_REQUEST_TIMEOUT_MS;
  const overallDeadline = Date.now() + Math.max(CHAT_STREAM_MAX_TOTAL_MS, idleMs * 2);
  const controller = new AbortController();
  let idleTimedOut = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { idleTimedOut = true; controller.abort(); }, idleMs);
  };

  let text = '';
  let reasoning = '';
  let model = req.model;
  let usage: ProviderUsage = {};
  // tool_use blocks stream their JSON input as partial_json deltas, keyed by block index.
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();

  const buildResult = (): GenerateTextResult => {
    const toolCalls = Array.from(toolAcc.values())
      .filter((t) => t.name)
      .map((t) => ({ id: t.id || `call_${t.name}`, name: t.name, arguments: t.args || '{}' }));
    return { text, model, usage, reasoning: reasoning || undefined, toolCalls: toolCalls.length ? toolCalls : undefined };
  };

  armIdle();
  try {
    // Never thinking here: Chat streaming keeps its request shape (and its temperature).
    const res = await fetch(`${baseFor(ctx)}/messages`, {
      method: 'POST',
      headers: buildHeaders(ctx),
      body: JSON.stringify({ ...buildBody(req), stream: true }),
      signal: controller.signal,
      redirect: 'error'
    });
    if (!res.ok || !res.body) {
      const errBody = await res.text().catch(() => '');
      throw vendorHttpError('Anthropic', 'stream', res.status, res.statusText, errBody);
    }

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const handle = (payload: string) => {
      let evt: any;
      try { evt = JSON.parse(payload); } catch { return; }
      const type = evt?.type;
      if (type === 'message_start' && evt.message?.model) model = evt.message.model;
      if (type === 'message_start' && evt.message?.usage) usage = parseUsage(evt.message.usage);
      if (type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
        toolAcc.set(evt.index ?? 0, { id: String(evt.content_block.id || ''), name: String(evt.content_block.name || ''), args: '' });
      }
      if (type === 'content_block_delta') {
        const d = evt.delta || {};
        if (d.type === 'text_delta' && d.text) { text += d.text; onDelta({ content: d.text }); }
        else if (d.type === 'thinking_delta' && d.thinking) { reasoning += d.thinking; onDelta({ reasoning: d.thinking }); }
        else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          const cur = toolAcc.get(evt.index ?? 0);
          if (cur) cur.args += d.partial_json;
        }
      }
      if (type === 'message_delta' && evt.usage) usage = { ...usage, ...parseUsage({ input_tokens: usage.promptTokens, output_tokens: evt.usage.output_tokens }) };
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

const generateImage = async (): Promise<GenerateImageResult> => {
  throw new Error('Anthropic does not provide an image-generation API. Use an image provider (OpenRouter/NVIDIA/Gemini).');
};

const listModels = async (ctx?: ProviderContext): Promise<CatalogModel[]> => {
  const seed = staticModelsFor('anthropic');
  const seedById = new Map(seed.map((m) => [m.id, m]));
  if (!ctx?.apiKey) return seed;
  try {
    const live = new Map<string, CatalogModel>();
    let after: string | undefined;
    const cursors = new Set<string>();
    do {
      const path = `/models?limit=100${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
      const data = await anthropicFetch<any>(path, { method: 'GET' }, Math.min(ANTHROPIC_REQUEST_TIMEOUT_MS, 8_000), ctx);
      const rows: any[] = Array.isArray(data?.data) ? data.data : [];
      for (const row of rows) {
        const id = String(row?.id || '').trim();
        if (!id) continue;
        const curated = seedById.get(id);
        const created = row?.created_at ? Math.floor(Date.parse(row.created_at) / 1000) : undefined;
        live.set(id, curated ? { ...curated, catalogOrigin: 'live' } : {
          id,
          name: String(row?.display_name || id),
          source: 'anthropic',
          catalogOrigin: 'live',
          pricingKnown: false,
          pricingOrigin: 'unknown',
          createdAt: Number.isFinite(created) ? created : undefined,
          inputModalities: ['text', 'image'],
          outputModalities: ['text'],
          supportedParameters: ['reasoning'],
          pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 },
          isFree: false,
          costClass: 'paid',
          supportsImageOutput: false,
          supportsImageInput: true,
          supportsJsonOutput: true
        });
      }
      if (!data?.has_more) break;
      const next = typeof data?.last_id === 'string' ? data.last_id : rows.at(-1)?.id;
      // Repeated/missing cursors mean an incomplete listing, not a fresh catalog.
      if (!next || cursors.has(next)) throw new Error('Incomplete model listing');
      cursors.add(next);
      after = next;
    } while (cursors.size < 20);
    if (cursors.size >= 20) throw new Error('Model listing exceeded page budget');
    return live.size ? [...live.values()] : seed;
  } catch {
    return seed;
  }
};

export const anthropicProvider: AIProvider = {
  id: 'anthropic',
  generateText,
  generateTextStream,
  generateImage,
  listModels
};
