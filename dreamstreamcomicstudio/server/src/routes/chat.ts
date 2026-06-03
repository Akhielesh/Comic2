import { Router } from 'express';
import type { ChatRequest, ChatResponse, ChatClientContext } from '../../../apiTypes.js';
import { runChat, type ChatReasoningLevel } from '../ai/chat.js';
import { pickTextModel, TEXT_FALLBACK } from '../ai/autoRouter.js';
import { NVIDIA_TEXT_MODEL, TEXT_REQUEST_TIMEOUT_MS } from '../config.js';
import type { AIProviderId, ChatMessage, MessagePart } from '../ai/providers/types.js';
import { assertModelAllowedForUser } from '../services/modelAccessPolicy.js';
import { sanitizeAssistantContext } from '../ai/assistantPolicy.js';
import { resolveTools, KNOWN_TOOL_NAMES, type ChatTool } from '../ai/tools/registry.js';
import { buildMcpTools } from '../ai/tools/mcpClient.js';
import { unfurlUrl } from '../ai/tools/unfurl.js';
import {
  attachBillingToPayload,
  formatLimitErrorResponse,
  releaseReservedOperation,
  reserveForOperation,
  settleReservedOperation
} from '../services/usageEnforcer.js';

export const chatRouter = Router();

const MAX_HISTORY = 40;
const MAX_TEXT_CHARS = 24_000;
const MAX_ATTACHMENTS = 6;

const REASONING_LEVELS: ChatReasoningLevel[] = ['none', 'low', 'medium', 'high'];
const isReasoningLevel = (value: unknown): value is ChatReasoningLevel =>
  typeof value === 'string' && (REASONING_LEVELS as string[]).includes(value);

/** Sanitize an inbound message into a provider ChatMessage (text + optional image parts). */
const sanitizeMessage = (raw: unknown): ChatMessage | null => {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const role = record.role === 'assistant' ? 'assistant' : record.role === 'user' ? 'user' : null;
  if (!role) return null;

  // Plain string content.
  if (typeof record.content === 'string') {
    const text = record.content.trim().slice(0, MAX_TEXT_CHARS);
    if (!text) return null;
    return { role, content: text };
  }

  // Multimodal parts: text + image_url (data URL or public URL) for vision models.
  if (Array.isArray(record.content)) {
    const parts: MessagePart[] = [];
    let images = 0;
    for (const part of record.content) {
      if (!part || typeof part !== 'object') continue;
      const p = part as Record<string, unknown>;
      if (p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
        parts.push({ type: 'text', text: p.text.trim().slice(0, MAX_TEXT_CHARS) });
      } else if (
        p.type === 'image_url' &&
        p.image_url &&
        typeof (p.image_url as Record<string, unknown>).url === 'string' &&
        images < MAX_ATTACHMENTS
      ) {
        images += 1;
        parts.push({ type: 'image_url', image_url: { url: (p.image_url as { url: string }).url } });
      }
    }
    if (parts.length === 0) return null;
    return { role, content: parts };
  }

  return null;
};

// Validate + clamp the client-supplied runtime context. Everything is optional and
// bounded; coordinates are coarsened to ~1km so we never store/forward precise
// location, and strings are length-capped to keep the system prompt tidy.
const sanitizeClientContext = (raw: unknown): ChatClientContext | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
  const ctx: ChatClientContext = {};
  if (typeof r.now === 'string' && !Number.isNaN(Date.parse(r.now))) ctx.now = new Date(r.now).toISOString();
  ctx.timezone = str(r.timezone, 64);
  ctx.locale = str(r.locale, 32);
  if (r.units === 'metric' || r.units === 'imperial') ctx.units = r.units;
  if (r.location && typeof r.location === 'object') {
    const l = r.location as Record<string, unknown>;
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    const lat = num(l.lat);
    const lng = num(l.lng);
    const location: NonNullable<ChatClientContext['location']> = {
      city: str(l.city, 80),
      region: str(l.region, 80),
      country: str(l.country, 4)?.toUpperCase(),
      // Coarsen to 2 decimals (~1.1km) — enough for weather/news, never precise.
      lat: typeof lat === 'number' ? Math.round(lat * 100) / 100 : undefined,
      lng: typeof lng === 'number' ? Math.round(lng * 100) / 100 : undefined,
      approximate: true
    };
    if (location.city || location.region || location.country || typeof location.lat === 'number') {
      ctx.location = location;
    }
  }
  const hasAny = Object.values(ctx).some((v) => v !== undefined);
  return hasAny ? ctx : undefined;
};

type ResolvedProvider = { provider: AIProviderId; apiKey: string };

const resolveChatProvider = (req: any, requestedSource?: string): ResolvedProvider | null => {
  const source = String(requestedSource || req.header('X-Text-Source') || '').trim().toLowerCase();
  const openRouterKey = req.apiKeys?.openRouterKey as string | undefined;
  const nvidiaKey = req.apiKeys?.nvidiaKey as string | undefined;

  if (source === 'nvidia' && nvidiaKey) return { provider: 'nvidia', apiKey: nvidiaKey };
  if (source === 'openrouter' && openRouterKey) return { provider: 'openrouter', apiKey: openRouterKey };
  if (openRouterKey) return { provider: 'openrouter', apiKey: openRouterKey };
  if (nvidiaKey) return { provider: 'nvidia', apiKey: nvidiaKey };
  return null;
};

type PreparedChat = {
  resolved: ResolvedProvider;
  messages: ChatMessage[];
  model: string;
  requestedModel: string;
  reasoningLevel: ChatReasoningLevel;
  webSearch: boolean;
  systemPrompt?: string;
  dreamstreamContextJson?: string;
  tools: ChatTool[];
  clientContext?: ChatClientContext;
};

type PrepResult = { error: { status: number; body: unknown } } | { prepared: PreparedChat };

// Shared request validation + resolution for both the JSON and streaming handlers.
const prepareChat = async (req: any): Promise<PrepResult> => {
  const body = (req.body || {}) as Partial<ChatRequest> & { source?: string };

  const resolved = resolveChatProvider(req, body.source);
  if (!resolved) {
    return {
      error: {
        status: 503,
        body: {
          error: {
            message:
              'Chat needs an OpenRouter or NVIDIA key. Add one in Settings → API Configuration, or configure a platform key on the server.',
            code: 'MISSING_CHAT_API_KEY'
          }
        }
      }
    };
  }

  const incoming = Array.isArray(body.messages) ? body.messages : [];
  const messages = incoming.map(sanitizeMessage).filter((m): m is ChatMessage => m !== null).slice(-MAX_HISTORY);

  if (messages.length === 0) {
    return { error: { status: 400, body: { error: { message: 'At least one message is required.' } } } };
  }
  if (messages[messages.length - 1].role !== 'user') {
    return { error: { status: 400, body: { error: { message: 'The last message must be from the user.' } } } };
  }

  const requestedModel = (typeof body.model === 'string' ? body.model.trim() : '') || (req.header('X-Text-Model') || '').trim();
  let model = requestedModel || (resolved.provider === 'nvidia' ? NVIDIA_TEXT_MODEL : await pickTextModel({ preferFree: true }));
  if (resolved.provider === 'nvidia' && !model.includes('/')) model = NVIDIA_TEXT_MODEL;

  if (resolved.provider === 'openrouter' && req.user?.id) {
    try {
      const access = await assertModelAllowedForUser({ userId: req.user.id, scope: 'text', requestedModel: model });
      if (access?.effectiveModel) model = access.effectiveModel;
    } catch {
      /* keep requested model */
    }
  }

  const reasoningLevel = isReasoningLevel(body.reasoningLevel) ? body.reasoningLevel : 'none';
  const webSearch = Boolean(body.webSearch) && resolved.provider === 'openrouter';
  const systemPrompt =
    typeof body.systemPrompt === 'string' && body.systemPrompt.trim() ? body.systemPrompt.trim().slice(0, 8000) : undefined;

  let dreamstreamContextJson: string | undefined;
  if (body.dreamstreamContext && req.user?.id) {
    const safe = sanitizeAssistantContext(body.dreamstreamContext, { isAuthenticated: true });
    const raw = JSON.stringify(safe);
    dreamstreamContextJson = raw.length > 12_000 ? `${raw.slice(0, 12_000)}…` : raw;
  }

  const clientContext = sanitizeClientContext(body.clientContext);

  const requestedToolNames = Array.isArray(body.tools)
    ? body.tools.filter((t): t is string => typeof t === 'string' && KNOWN_TOOL_NAMES.includes(t))
    : [];
  const toolContext = clientContext
    ? {
        timezone: clientContext.timezone,
        locale: clientContext.locale,
        units: clientContext.units,
        location: clientContext.location
      }
    : undefined;
  const builtinTools =
    resolved.provider === 'openrouter' ? resolveTools(requestedToolNames, toolContext) : [];

  // Custom MCP servers (OpenRouter only): list their tools and wrap them. Best-effort —
  // a broken/blocked server is skipped rather than failing the chat.
  let mcpTools: ChatTool[] = [];
  if (resolved.provider === 'openrouter' && Array.isArray(body.mcpServers) && body.mcpServers.length) {
    const servers = body.mcpServers
      .filter((s) => s && typeof s.url === 'string' && typeof s.id === 'string')
      .slice(0, 6);
    mcpTools = await buildMcpTools(servers);
  }

  return {
    prepared: { resolved, messages, model, requestedModel, reasoningLevel, webSearch, systemPrompt, dreamstreamContextJson, tools: [...builtinTools, ...mcpTools], clientContext }
  };
};

const buildPayload = (p: PreparedChat, result: Awaited<ReturnType<typeof runChat>>): ChatResponse => ({
  text: result.text,
  model: result.model,
  source: p.resolved.provider,
  requestedModel: p.requestedModel || result.model,
  reasoningLevel: p.reasoningLevel,
  webSearch: p.webSearch,
  reasoning: result.reasoning,
  citations: result.citations,
  toolEvents: result.toolEvents,
  images: result.images,
  artifacts: result.artifacts,
  usage: result.usage
});

const runChatParams = (p: PreparedChat) => ({
  provider: p.resolved.provider,
  apiKey: p.resolved.apiKey,
  model: p.model,
  messages: p.messages,
  systemPrompt: p.systemPrompt,
  reasoningLevel: p.reasoningLevel,
  webSearch: p.webSearch,
  dreamstreamContextJson: p.dreamstreamContextJson,
  tools: p.tools,
  clientContext: p.clientContext,
  fallbackModel: p.resolved.provider === 'openrouter' ? TEXT_FALLBACK : undefined,
  timeoutMs: TEXT_REQUEST_TIMEOUT_MS
});

// Link unfurl for source hover-cards (OG/meta preview). SSRF-guarded + cached.
chatRouter.get('/unfurl', async (req, res) => {
  const url = String(req.query.url || '');
  if (!url) return res.status(400).json({ error: { message: 'url is required' } });
  try {
    const data = await unfurlUrl(url);
    res.json(data);
  } catch (err) {
    res.status(200).json({ url, error: (err as Error)?.message || 'unfurl failed' });
  }
});

chatRouter.post('/', async (req, res, next) => {
  try {
    const prep = await prepareChat(req);
    if ('error' in prep) return res.status(prep.error.status).json(prep.error.body);
    const p = prep.prepared;

    const reserve = req.user?.id
      ? await reserveForOperation({
          req,
          operation: 'chat.completion',
          fallbackModel: p.model,
          provider: p.resolved.provider,
          stage: 'chat',
          metadata: { route: req.path, historyLength: p.messages.length, model: p.model }
        })
      : null;
    if (reserve && 'details' in reserve) {
      return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });
    }

    try {
      const result = await runChat(runChatParams(p));
      const settled =
        reserve && reserve.allowed
          ? await settleReservedOperation({
              req,
              operation: 'chat.completion',
              provider: p.resolved.provider,
              model: result.model,
              seed: { provider: p.resolved.provider, model: result.model, operation: 'chat.completion', stage: 'chat', byok: reserve.reservation.byokBypass },
              usage: result.usage,
              metadata: { route: req.path, historyLength: p.messages.length }
            })
          : null;

      const payload = buildPayload(p, result);
      res.json(
        reserve && reserve.allowed
          ? attachBillingToPayload(payload as unknown as Record<string, unknown>, reserve.reservation, settled)
          : payload
      );
    } catch (error) {
      if (reserve && reserve.allowed) {
        await releaseReservedOperation({
          req,
          operation: 'chat.completion',
          provider: p.resolved.provider,
          model: p.model,
          reason: (error as Error)?.message || 'chat_request_failed',
          metadata: { route: req.path, historyLength: p.messages.length }
        });
      }
      throw error;
    }
  } catch (err) {
    next(err);
  }
});

// Streaming variant — Server-Sent Events. Emits `meta`, `delta`/`reasoning`,
// then a `final` event carrying the full ChatResponse (with billing), or `error`.
chatRouter.post('/stream', async (req, res) => {
  const prep = await prepareChat(req);
  if ('error' in prep) return res.status(prep.error.status).json(prep.error.body);
  const p = prep.prepared;

  const reserve = req.user?.id
    ? await reserveForOperation({
        req,
        operation: 'chat.completion',
        fallbackModel: p.model,
        provider: p.resolved.provider,
        stage: 'chat',
        metadata: { route: req.path, historyLength: p.messages.length, model: p.model }
      })
    : null;
  if (reserve && 'details' in reserve) {
    return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  send('meta', { model: p.model, requestedModel: p.requestedModel || p.model, source: p.resolved.provider });

  try {
    const result = await runChat({
      ...runChatParams(p),
      onDelta: (d) => {
        if (d.content) send('delta', { content: d.content });
        else if (d.reasoning) send('reasoning', { reasoning: d.reasoning });
      }
    });

    const settled =
      reserve && reserve.allowed
        ? await settleReservedOperation({
            req,
            operation: 'chat.completion',
            provider: p.resolved.provider,
            model: result.model,
            seed: { provider: p.resolved.provider, model: result.model, operation: 'chat.completion', stage: 'chat', byok: reserve.reservation.byokBypass },
            usage: result.usage,
            metadata: { route: req.path, historyLength: p.messages.length }
          })
        : null;

    const payload = buildPayload(p, result);
    const finalPayload =
      reserve && reserve.allowed
        ? attachBillingToPayload(payload as unknown as Record<string, unknown>, reserve.reservation, settled)
        : payload;
    send('final', finalPayload);
    res.end();
  } catch (error) {
    if (reserve && reserve.allowed) {
      await releaseReservedOperation({
        req,
        operation: 'chat.completion',
        provider: p.resolved.provider,
        model: p.model,
        reason: (error as Error)?.message || 'chat_request_failed',
        metadata: { route: req.path, historyLength: p.messages.length }
      });
    }
    send('error', { message: (error as Error)?.message || 'The request failed.' });
    res.end();
  }
});
