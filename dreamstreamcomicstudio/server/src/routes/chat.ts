import { Router } from 'express';
import type { ChatRequest, ChatResponse } from '../../../apiTypes.js';
import { runChat, type ChatReasoningLevel } from '../ai/chat.js';
import { pickTextModel, TEXT_FALLBACK } from '../ai/autoRouter.js';
import { NVIDIA_TEXT_MODEL, TEXT_REQUEST_TIMEOUT_MS } from '../config.js';
import type { AIProviderId, ChatMessage, MessagePart } from '../ai/providers/types.js';
import { assertModelAllowedForUser } from '../services/modelAccessPolicy.js';
import { sanitizeAssistantContext } from '../ai/assistantPolicy.js';
import { resolveTools, KNOWN_TOOL_NAMES } from '../ai/tools/registry.js';
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

chatRouter.post('/', async (req, res, next) => {
  try {
    const body = (req.body || {}) as Partial<ChatRequest> & { source?: string };

    const resolved = resolveChatProvider(req, body.source);
    if (!resolved) {
      return res.status(503).json({
        error: {
          message:
            'Chat needs an OpenRouter or NVIDIA key. Add one in Settings → API Configuration, or configure a platform key on the server.',
          code: 'MISSING_CHAT_API_KEY'
        }
      });
    }

    const incoming = Array.isArray(body.messages) ? body.messages : [];
    const messages = incoming
      .map(sanitizeMessage)
      .filter((m): m is ChatMessage => m !== null)
      .slice(-MAX_HISTORY);

    if (messages.length === 0) {
      return res.status(400).json({ error: { message: 'At least one message is required.' } });
    }
    if (messages[messages.length - 1].role !== 'user') {
      return res.status(400).json({ error: { message: 'The last message must be from the user.' } });
    }

    // Resolve the model: explicit body/header pick wins; otherwise an auto-picked free model
    // (OpenRouter) or the NVIDIA default. Store-the-library means the client may send any id.
    const requestedModel = (typeof body.model === 'string' ? body.model.trim() : '') || (req.header('X-Text-Model') || '').trim();
    let model =
      requestedModel ||
      (resolved.provider === 'nvidia' ? NVIDIA_TEXT_MODEL : await pickTextModel({ preferFree: true }));

    if (resolved.provider === 'nvidia' && !model.includes('/')) {
      model = NVIDIA_TEXT_MODEL;
    }

    // Respect plan-tier model access for the platform (OpenRouter) path. Never hard-fail
    // chat over access policy — fall back to the requested id if the check errors.
    if (resolved.provider === 'openrouter' && req.user?.id) {
      try {
        const access = await assertModelAllowedForUser({
          userId: req.user.id,
          scope: 'text',
          requestedModel: model
        });
        if (access?.effectiveModel) model = access.effectiveModel;
      } catch {
        /* keep requested model */
      }
    }

    const reasoningLevel = isReasoningLevel(body.reasoningLevel) ? body.reasoningLevel : 'none';
    const webSearch = Boolean(body.webSearch) && resolved.provider === 'openrouter';
    const systemPrompt =
      typeof body.systemPrompt === 'string' && body.systemPrompt.trim()
        ? body.systemPrompt.trim().slice(0, 8000)
        : undefined;

    // DreamStream connector: only honoured when the client sent context (toggle on) AND the
    // request is authenticated. Re-sanitized through the assistant allowlist so nothing
    // beyond the safe, user-owned fields can reach the model.
    let dreamstreamContextJson: string | undefined;
    if (body.dreamstreamContext && req.user?.id) {
      const safe = sanitizeAssistantContext(body.dreamstreamContext, { isAuthenticated: true });
      const raw = JSON.stringify(safe);
      dreamstreamContextJson = raw.length > 12_000 ? `${raw.slice(0, 12_000)}…` : raw;
    }

    // Agentic tools (DuckDuckGo etc.) — allowlisted, OpenRouter only.
    const requestedToolNames = Array.isArray(body.tools)
      ? body.tools.filter((t): t is string => typeof t === 'string' && KNOWN_TOOL_NAMES.includes(t))
      : [];
    const tools = resolved.provider === 'openrouter' ? resolveTools(requestedToolNames) : [];

    const reserve = req.user?.id
      ? await reserveForOperation({
          req,
          operation: 'chat.completion',
          fallbackModel: model,
          provider: resolved.provider,
          stage: 'chat',
          metadata: { route: req.path, historyLength: messages.length, model }
        })
      : null;

    if (reserve && 'details' in reserve) {
      return res.status(402).json({ error: formatLimitErrorResponse(reserve.details) });
    }

    try {
      const result = await runChat({
        provider: resolved.provider,
        apiKey: resolved.apiKey,
        model,
        messages,
        systemPrompt,
        reasoningLevel,
        webSearch,
        dreamstreamContextJson,
        tools,
        fallbackModel: resolved.provider === 'openrouter' ? TEXT_FALLBACK : undefined,
        timeoutMs: TEXT_REQUEST_TIMEOUT_MS
      });

      const settled =
        reserve && reserve.allowed
          ? await settleReservedOperation({
              req,
              operation: 'chat.completion',
              provider: resolved.provider,
              model: result.model,
              seed: {
                provider: resolved.provider,
                model: result.model,
                operation: 'chat.completion',
                stage: 'chat',
                byok: reserve.reservation.byokBypass
              },
              usage: result.usage,
              metadata: { route: req.path, historyLength: messages.length }
            })
          : null;

      const payload: ChatResponse = {
        text: result.text,
        model: result.model,
        source: resolved.provider,
        reasoningLevel,
        webSearch,
        reasoning: result.reasoning,
        citations: result.citations,
        toolEvents: result.toolEvents,
        images: result.images,
        usage: result.usage
      };

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
          provider: resolved.provider,
          model,
          reason: (error as Error)?.message || 'chat_request_failed',
          metadata: { route: req.path, historyLength: messages.length }
        });
      }
      throw error;
    }
  } catch (err) {
    next(err);
  }
});
