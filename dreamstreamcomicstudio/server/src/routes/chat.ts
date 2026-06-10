import { Router } from 'express';
import type { ChatRequest, ChatResponse, ChatClientContext } from '../../../apiTypes.js';
import { REFRESHABLE_TOOLS } from '../../../apiTypes.js';
import { runChat, isStudyIntent, isTrivialChat, type ChatReasoningLevel, type ChatAttachmentInput } from '../ai/chat.js';
import { runSwarm } from '../ai/agents/orchestrator.js';
import { makeSwarmTool, SWARM_TOOL_NAME } from '../ai/agents/swarmTool.js';
import { makeDelegateTool } from '../ai/agents/delegateTool.js';
import { makeDeepResearchTool } from '../ai/research/deepResearchTool.js';
import { resolveClientGeo, clientIpFromReq } from '../ai/clientGeo.js';
import { makeImageTool, imageGenAvailable, type ImageKeys } from '../ai/tools/imageGen.js';
import { sanitizeCustomAgents } from '../ai/agents/registry.js';
import type { AgentDefinition } from '../ai/agents/registry.js';
import { loadCustomAgentDefinitions } from '../services/customAgents.js';
import { pickTextModel, pickTextModelChain, markModelDown, TEXT_FALLBACK } from '../ai/autoRouter.js';
import { NVIDIA_TEXT_MODEL, OPENROUTER_TEXT_MODEL, TEXT_REQUEST_TIMEOUT_MS, JSON_TOOL_PROTOCOL_ENABLED } from '../config.js';
import type { AIProviderId, ChatMessage, MessagePart } from '../ai/providers/types.js';
import { assertModelAllowedForUser } from '../services/modelAccessPolicy.js';
import { sanitizeAssistantContext } from '../ai/assistantPolicy.js';
import { resolveTools, type ChatTool } from '../ai/tools/registry.js';
import { selectRelevantTools, ROUTABLE_TOOL_NAMES } from '../../../toolCatalog.js';
import { buildMcpTools } from '../ai/tools/mcpClient.js';
import { enabledMcpConfigs } from '../services/mcpRegistry.js';
import { ALWAYS_ON_STUDIO_MCP_SERVERS, envDesignMcpServers, externalMcpEnabled } from '../ai/studio/designSystem.js';
import { applyGuardrails } from '../ai/guardrails.js';
import type { CapabilityNotice, McpServerConfig } from '../../../apiTypes.js';
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

  // Honor an EXPLICITLY requested source — never silently reroute to a different
  // provider. Sending e.g. an NVIDIA model id to OpenRouter just 404s and then
  // falls back to an unrelated model, which is exactly what made "source selection"
  // feel broken. If the requested source has no usable key, fail clearly instead.
  if (source === 'nvidia') return nvidiaKey ? { provider: 'nvidia', apiKey: nvidiaKey } : null;
  if (source === 'openrouter') return openRouterKey ? { provider: 'openrouter', apiKey: openRouterKey } : null;

  // No specific source requested: use whatever key is available (auto).
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
  /** OpenRouter server-side fallback chain (≤3) so dead/rate-limited models don't yield empty. */
  fallbackModels?: string[];
  dreamstreamContextJson?: string;
  tools: ChatTool[];
  clientContext?: ChatClientContext;
  customAgents: AgentDefinition[];
  /** Files attached to the current turn — surfaced to the model so it can read them. */
  attachments: ChatAttachmentInput[];
};

type PrepResult = { error: { status: number; body: unknown } } | { prepared: PreparedChat };

// Shared request validation + resolution for both the JSON and streaming handlers.
// Exported so sibling routes (e.g. /api/recipes) resolve provider, model, billing
// context and user memory identically instead of duplicating that logic.
export const prepareChat = async (req: any): Promise<PrepResult> => {
  const body = (req.body || {}) as Partial<ChatRequest> & { source?: string };

  const resolved = resolveChatProvider(req, body.source);
  if (!resolved) {
    // Source-aware message: if the user pinned a source we couldn't honor, say so
    // explicitly rather than the generic "needs a key" (which hid the real cause).
    const requestedSource = String(body.source || req.header('X-Text-Source') || '').trim().toLowerCase();
    const sourceLabel = requestedSource === 'nvidia' ? 'NVIDIA' : requestedSource === 'openrouter' ? 'OpenRouter' : '';
    const message = sourceLabel
      ? `You selected ${sourceLabel} as the source, but no active ${sourceLabel} key is available (it may be missing, or ${sourceLabel} is turned off under Sources). Add a ${sourceLabel} key in Settings → API Configuration, or switch the source.`
      : 'Chat needs an OpenRouter or NVIDIA key. Add one in Settings → API Configuration, or configure a platform key on the server.';
    return {
      error: {
        status: 503,
        body: {
          error: { message, code: 'MISSING_CHAT_API_KEY' }
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

  // The latest user message, flattened to text — drives web-search gating, tool routing
  // and study-intent detection below, so it's computed once here.
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  const lastUserText =
    typeof lastUserMessage?.content === 'string'
      ? lastUserMessage.content
      : Array.isArray(lastUserMessage?.content)
        ? lastUserMessage!.content.map((p) => ('text' in p ? p.text : '')).join(' ')
        : '';

  const requestedModel = (typeof body.model === 'string' ? body.model.trim() : '') || (req.header('X-Text-Model') || '').trim();
  // Free-only is a user choice (header). When ON we use the cooldown-aware FREE chain (slower
  // but free). When OFF (the default) the chat leads with a FAST, capable, cheap model rather
  // than a free one — free models are 10-30x slower (9-22s vs ~1s) and frequently 429/404,
  // which is why chats felt slow and "stuck on gpt-4o-mini". gemini-2.5-flash answers in ~0.7s.
  const freeOnly = (req.header('X-Free-Only') || '').toLowerCase() === 'true';
  let model = requestedModel || (resolved.provider === 'nvidia'
    ? NVIDIA_TEXT_MODEL
    : freeOnly
      ? await pickTextModel({ preferFree: true, prefer: (m) => (m.supportedParameters || []).includes('tools') })
      : OPENROUTER_TEXT_MODEL);
  if (resolved.provider === 'nvidia' && !model.includes('/')) model = NVIDIA_TEXT_MODEL;

  if (resolved.provider === 'openrouter' && req.user?.id) {
    try {
      const access = await assertModelAllowedForUser({ userId: req.user.id, scope: 'text', requestedModel: model });
      // Only adopt the policy's effective model if it's a provider-valid (namespaced)
      // OpenRouter id. The legacy plan policy can emit BARE Gemini ids (e.g.
      // 'gemini-2.5-flash') which 404 on OpenRouter and then silently fall back to
      // gpt-4o-mini — so the user never runs the model they think they picked. Never
      // coerce onto a bare id here. (Unifying the model decider is a separate workstream.)
      if (access?.effectiveModel && access.effectiveModel.includes('/')) {
        model = access.effectiveModel;
      }
    } catch {
      /* keep requested model */
    }
  }

  // Build a SERVER-SIDE fallback chain (≤3) so a dead/rate-limited free model never yields
  // "no response": OpenRouter routes to the first available model in the list. The primary
  // is first; the cheap paid TEXT_FALLBACK is the guaranteed last resort. This is the fix
  // for free models being 404 (retired) / 429 (rate-limited), which left chats empty.
  let fallbackModels: string[] | undefined;
  if (resolved.provider === 'openrouter') {
    if (requestedModel) {
      // Pinned model: keep it primary; add the cheap paid net (unless free-only).
      fallbackModels = freeOnly || model === TEXT_FALLBACK ? [model] : [model, TEXT_FALLBACK];
    } else if (freeOnly) {
      // Free-only: cooldown-aware FREE chain (a free model that just failed is skipped so we
      // don't re-pay its ~15-20s fallback latency).
      const chain = await pickTextModelChain({
        preferFree: true,
        prefer: (m) => (m.supportedParameters || []).includes('tools'),
        freeOnly: true,
        max: 2
      }).catch(() => [model]);
      fallbackModels = chain.length ? chain : [model];
      model = fallbackModels[0] || model;
    } else {
      // Default: FAST. Lead with the quick capable model, gpt-4o-mini as the reliable net.
      fallbackModels = Array.from(new Set([OPENROUTER_TEXT_MODEL, TEXT_FALLBACK]));
      model = fallbackModels[0];
    }
  }

  const reasoningLevel = isReasoningLevel(body.reasoningLevel) ? body.reasoningLevel : 'none';
  // Internet access is a backend default, not a user toggle: OpenRouter chats get live web
  // grounding. BUT skip the always-on web plugin on trivial/conversational turns (greetings,
  // thanks, bare arithmetic) — that reflexive search round-trip fires on EVERY message and is
  // the single biggest reason the SIMPLEST chats felt slow ("hi" shouldn't trigger a search).
  // The web_search TOOL stays on the table, so any real question still grounds live on demand.
  const webSearch = resolved.provider === 'openrouter' && !isTrivialChat(lastUserText);
  const systemPrompt =
    typeof body.systemPrompt === 'string' && body.systemPrompt.trim() ? body.systemPrompt.trim().slice(0, 8000) : undefined;

  let dreamstreamContextJson: string | undefined;
  if (body.dreamstreamContext && req.user?.id) {
    const safe = sanitizeAssistantContext(body.dreamstreamContext, { isAuthenticated: true });
    const raw = JSON.stringify(safe);
    dreamstreamContextJson = raw.length > 12_000 ? `${raw.slice(0, 12_000)}…` : raw;
  }

  let clientContext = sanitizeClientContext(body.clientContext);
  // The browser only shares precise location after an explicit permission grant (rare), so
  // when no location came through, derive a COARSE one from the request IP. This is what makes
  // "weather", "near me" and "local news" resolve to the USER instead of the whole world.
  if (!clientContext?.location) {
    const geo = await resolveClientGeo(clientIpFromReq(req)).catch(() => null);
    if (geo && (geo.city || geo.country)) {
      clientContext = {
        ...(clientContext || {}),
        location: {
          city: geo.city,
          region: geo.region,
          country: geo.country,
          lat: geo.lat,
          lng: geo.lng,
          approximate: true
        }
      };
    }
  }
  const requestCustomAgents = sanitizeCustomAgents(body.customAgents);

  // Files attached to the CURRENT user turn (images, CSV/JSON/text) for tools like
  // run_python. Cap to 6 items; each must be a base64 data URI under ~16MB encoded.
  const MAX_ATTACHMENTS = 6;
  const MAX_DATA_URI_LEN = 16_000_000;
  const attachments = Array.isArray(body.attachments)
    ? body.attachments
        .filter(
          (a): a is { name: string; mimeType: string; dataUri: string } =>
            !!a &&
            typeof a === 'object' &&
            typeof (a as { name?: unknown }).name === 'string' &&
            typeof (a as { mimeType?: unknown }).mimeType === 'string' &&
            typeof (a as { dataUri?: unknown }).dataUri === 'string' &&
            (a as { dataUri: string }).dataUri.startsWith('data:') &&
            (a as { dataUri: string }).dataUri.length <= MAX_DATA_URI_LEN
        )
        .slice(0, MAX_ATTACHMENTS)
        .map((a) => ({ name: a.name.slice(0, 200), mimeType: a.mimeType.slice(0, 120), dataUri: a.dataUri }))
    : [];

  const toolContext =
    clientContext || attachments.length
      ? {
          timezone: clientContext?.timezone,
          locale: clientContext?.locale,
          units: clientContext?.units,
          location: clientContext?.location,
          ...(attachments.length ? { attachments } : {})
        }
      : undefined;

  // Tools are a BACKEND DEFAULT, not a user setting: the model always has the full
  // free-API tool suite available (OpenRouter only — NVIDIA can't tool-call). The
  // user never enables/sees individual tools. To avoid handing the model dozens of
  // specs at once, smart-route to the handful most relevant to THIS message by
  // keyword scoring; web_search is always retained as the internet backstop.
  // (`lastUserText` is computed once near the top of prepareChat.)
  const MAX_MODEL_TOOLS = 20;
  // OpenRouter gets native function-calling; other providers get the same tools through
  // the JSON protocol when it's enabled (Phase 10). Either way, smart-route to the most
  // relevant handful for this message rather than handing over the whole suite.
  const toolsEnabledForProvider = resolved.provider === 'openrouter' || JSON_TOOL_PROTOCOL_ENABLED;
  let routedToolNames = toolsEnabledForProvider
    ? selectRelevantTools(lastUserText, ROUTABLE_TOOL_NAMES, MAX_MODEL_TOOLS)
    : [];
  // On study/exam intent, guarantee the core learning tools are on the table so the
  // EXAM/STUDY guidance can actually deliver practice (quiz/flashcards/guide) even when
  // the message didn't literally say "quiz" (e.g. "explain how recursion works for my exam").
  if (toolsEnabledForProvider && isStudyIntent(lastUserText)) {
    // The full study toolkit: practice (quiz/flashcards), a written guide, a downloadable
    // study pack (bundle), and a relevant image for visual concepts.
    routedToolNames = Array.from(
      new Set(['generate_quiz', 'generate_flashcards', 'generate_document', 'generate_bundle', 'image_search', ...routedToolNames])
    ).slice(0, MAX_MODEL_TOOLS);
  }
  // When the user attached files, force run_python onto the table so the model can
  // actually read/convert/process them with real code (its keywords may not match).
  if (toolsEnabledForProvider && attachments.length) {
    routedToolNames = Array.from(new Set(['run_python', ...routedToolNames])).slice(0, MAX_MODEL_TOOLS);
  }
  const builtinTools = toolsEnabledForProvider ? resolveTools(routedToolNames, toolContext) : [];

  // The agent-swarm meta-tool needs provider credentials, so it's built here (not in
  // resolveTools) and appended when the user enabled the Swarm toggle. OpenRouter only.
  const swarmRequested =
    Array.isArray(body.tools) && body.tools.some((t) => t === SWARM_TOOL_NAME);

  // Merge the user's saved library agents (Phase 9) into the deployable pool — but only
  // when the swarm is actually reachable this turn (the swarm tool is enabled, or this is
  // the /swarm route), so ordinary chats don't pay for a DB lookup. Request-scoped agents
  // win on an id collision.
  const swarmReachable =
    resolved.provider === 'openrouter' && (swarmRequested || req.path.endsWith('/swarm'));
  const savedAgents =
    swarmReachable && req.user?.id ? await loadCustomAgentDefinitions(req.user.id) : [];
  const requestAgentIds = new Set(requestCustomAgents.map((a) => a.id));
  const customAgents = [...requestCustomAgents, ...savedAgents.filter((a) => !requestAgentIds.has(a.id))];

  const metaTools: ChatTool[] = [];
  if (resolved.provider === 'openrouter' && swarmRequested) {
    metaTools.push(
      makeSwarmTool({
        provider: resolved.provider,
        apiKey: resolved.apiKey,
        model,
        messages,
        systemPrompt,
        clientContext,
        extraAgents: customAgents,
        fallbackModel: TEXT_FALLBACK,
        timeoutMs: TEXT_REQUEST_TIMEOUT_MS
      })
    );
  }
  // BYOK image generation: built with the user's OWN image-account keys (gemini/ideogram/flux),
  // appended when the user enabled the generate_image tool and a key is configured. Provider-agnostic
  // (uses its own image keys, not the chat model's provider).
  const imageKeys = (req as { apiKeys?: ImageKeys }).apiKeys || {};
  const imageRequested = Array.isArray(body.tools) && body.tools.some((t) => t === 'generate_image');
  if (imageRequested && imageGenAvailable(imageKeys)) metaTools.push(makeImageTool(imageKeys));

  // Deep research is a HEAVY tool (multi-search + page reads + 2 model calls), so it is
  // offered only when the user's message actually signals a research intent — not on every
  // chat (always-on, the model over-invoked it and turned ordinary turns into multi-minute
  // runs). A natural-language "research X thoroughly / deep dive on Y" still triggers it;
  // the /research slash command runs the engine directly regardless.
  const researchIntent =
    /\b(deep[\s-]?research|deep[\s-]?dive|thorough(ly)?|comprehensive|in[\s-]?depth|investigate|dossier|literature review|white\s?paper|sourced\s+(report|brief|analysis)|research\s+(report|brief|paper|on|about|into))\b/i.test(
      lastUserText
    );
  if (resolved.provider === 'openrouter' && researchIntent) {
    metaTools.push(
      makeDeepResearchTool({
        provider: resolved.provider,
        apiKey: resolved.apiKey,
        model,
        messages,
        systemPrompt,
        clientContext,
        fallbackModel: TEXT_FALLBACK,
        timeoutMs: TEXT_REQUEST_TIMEOUT_MS
      })
    );
  }

  // Task delegation (gather → verify → aggregate via parallel helper agents) is offered
  // AUTOMATICALLY when the message looks like it needs several independent lookups or
  // cross-verification — no swarm toggle required (that's the user-facing ask: "let the
  // agent delegate without activating swarm"). Skipped when the user already turned the
  // heavier swarm on (that's the explicit, broader path). OpenRouter only (helpers are
  // web-grounded). Intent-gated so ordinary single-answer turns don't pay for it.
  const delegationIntent =
    /\b(verify|cross[\s-]?check|fact[\s-]?check|double[\s-]?check|confirm (whether|if|that)|is it true|gather|compile|aggregate|cross[\s-]?reference|reconcile|each of (these|them|the)|for each|multiple sources|several (sources|claims|things|items)|compare\b[^.?!]*\b(and|vs\.?|versus)\b)/i;
  if (resolved.provider === 'openrouter' && !swarmRequested && delegationIntent.test(lastUserText)) {
    metaTools.push(
      makeDelegateTool({
        provider: resolved.provider,
        apiKey: resolved.apiKey,
        model,
        messages,
        systemPrompt,
        clientContext,
        fallbackModel: TEXT_FALLBACK,
        timeoutMs: TEXT_REQUEST_TIMEOUT_MS
      })
    );
  }

  // NOTE: recipes are invoked by the USER via `/` slash-commands (see the chat
  // composer command palette), not pushed at the model on every turn. Forcing
  // run_recipe/save_recipe onto every chat both (a) added object-typed tool params
  // that stricter models reject — breaking the whole completion — and (b) wasn't the
  // UX we want. The /api/recipes/run endpoint backs the slash-commands directly.

  // Custom MCP servers (OpenRouter only): list their tools and wrap them. Best-effort —
  // a broken/blocked server is skipped rather than failing the chat. Sources are the
  // request body (legacy/localStorage clients) AND the user's server-side registry
  // (Phase 10), merged + deduped by url so saved servers sync across devices.
  let mcpTools: ChatTool[] = [];
  if (resolved.provider === 'openrouter') {
    const requestServers = Array.isArray(body.mcpServers)
      ? body.mcpServers.filter((s) => s && typeof s.url === 'string' && typeof s.id === 'string')
      : [];
    const savedServers = req.user?.id ? await enabledMcpConfigs(req.user.id).catch(() => []) : [];
    // DreamStream chat gets the SAME always-on reference MCPs (Context7, DeepWiki) and any
    // operator self-hosted design/connector MCPs as the Code Studio, plus the user's own servers.
    // Operator-set servers are trusted (may use http/internal hosts); user servers stay strict.
    const byUrl = new Map<string, McpServerConfig & { trusted?: boolean }>();
    // Inject the curated defaults only when the user is already using tools (some tool enabled, or
    // an MCP server configured), so plain conversations are unaffected. User servers behave as before.
    const userUsingTools = routedToolNames.length > 0 || savedServers.length > 0 || requestServers.length > 0;
    if (userUsingTools) {
      // Always-on reference MCPs are third-party; skip them when external MCP is disabled (privacy).
      if (externalMcpEnabled()) for (const s of ALWAYS_ON_STUDIO_MCP_SERVERS) byUrl.set(s.url, s as McpServerConfig);
      for (const s of envDesignMcpServers()) byUrl.set(s.url, s as McpServerConfig & { trusted?: boolean });
    }
    for (const s of [...savedServers, ...requestServers]) byUrl.set(s.url, s as McpServerConfig);
    const servers = [...byUrl.values()].slice(0, 10);
    if (servers.length) mcpTools = await buildMcpTools(servers);
  }

  return {
    prepared: { resolved, messages, model, requestedModel, reasoningLevel, webSearch, systemPrompt, fallbackModels, dreamstreamContextJson, tools: [...builtinTools, ...metaTools, ...mcpTools], clientContext, customAgents, attachments }
  };
};

// Output guardrail pass (Phase 11): scan the finished answer for leaked secrets,
// figures stated without a tool call, and missing citations; merge any findings into
// the response notices (which the UI already renders) and the capability audit log.
const withGuardrailNotices = (result: {
  text: string;
  toolEvents?: { tool: string }[];
  citations?: { url: string }[];
  notices?: CapabilityNotice[];
}): CapabilityNotice[] | undefined => {
  const guardNotices = applyGuardrails({
    text: result.text || '',
    toolRan: (result.toolEvents?.length || 0) > 0,
    citationCount: result.citations?.length || 0
  });
  const merged = [...(result.notices || []), ...guardNotices];
  return merged.length ? merged : undefined;
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
  notices: withGuardrailNotices(result),
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
  attachments: p.attachments,
  fallbackModel: p.resolved.provider === 'openrouter' ? TEXT_FALLBACK : undefined,
  fallbackModels: p.fallbackModels,
  timeoutMs: TEXT_REQUEST_TIMEOUT_MS
});

// Prompt enhancer: rewrite a user's rough draft into a clearer, more specific
// prompt WITHOUT changing their intent. Returns the improved text for the user to
// accept or discard — it never auto-sends. Uses a fast free model and no tools.
const ENHANCE_SYSTEM_PROMPT = `You are a prompt-improvement assistant. The user gives you a rough draft of a message they want to send to an AI assistant. Rewrite it so the AI understands exactly what they want.

Rules:
- PRESERVE the user's original intent and meaning. Do NOT add new requirements, constraints, or facts they didn't imply.
- Make it clearer and more specific: clarify the goal, the desired output/format, and any obvious missing context, but only where it genuinely helps.
- Keep it concise and natural — a better-phrased request, not an essay. Match the user's language.
- If the draft is already clear, make only minimal improvements.
- Return ONLY the improved prompt text. No preamble, no quotes, no explanation, no markdown headings.`;

chatRouter.post('/enhance', async (req, res, next) => {
  try {
    const body = (req.body || {}) as { text?: string; source?: string };
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 4000) : '';
    if (!text) return res.status(400).json({ error: { message: 'text is required' } });

    const resolved = resolveChatProvider(req, body.source);
    if (!resolved) {
      return res.status(503).json({
        error: { message: 'Enhancing needs an OpenRouter or NVIDIA key.', code: 'MISSING_CHAT_API_KEY' }
      });
    }
    // Utility calls (enhance/memory) must be RELIABLE, not free-but-flaky — use the fast
    // default model with the paid net so they don't silently fail when free models 429.
    const model = resolved.provider === 'nvidia' ? NVIDIA_TEXT_MODEL : OPENROUTER_TEXT_MODEL;

    const result = await runChat({
      provider: resolved.provider,
      apiKey: resolved.apiKey,
      model,
      messages: [{ role: 'user', content: `Improve this prompt:\n\n${text}` }],
      systemOverride: ENHANCE_SYSTEM_PROMPT,
      temperature: 0.4,
      maxTokens: 600,
      fallbackModel: resolved.provider === 'openrouter' ? TEXT_FALLBACK : undefined,
      fallbackModels: resolved.provider === 'openrouter' ? [OPENROUTER_TEXT_MODEL, TEXT_FALLBACK] : undefined,
      timeoutMs: TEXT_REQUEST_TIMEOUT_MS
    });
    const enhanced = (result.text || '').trim();
    res.json({ enhanced: enhanced || text, model: result.model });
  } catch (err) {
    next(err);
  }
});

// Auto-memory: distill durable facts about the user from a recent exchange and
// merge them into their long-term memory, so future chats are personalized without
// the user hand-writing notes. Conservative by design — facts only, no transient
// chatter, no sensitive data unless clearly volunteered.
const MEMORY_SYSTEM_PROMPT = `You maintain a concise long-term memory of durable facts about a user, used to personalize an AI assistant across chats. You are given the EXISTING MEMORY and a RECENT CONVERSATION. Output the UPDATED memory.

Rules:
- Keep only durable, reusable facts: name, location/timezone, language, occupation, ongoing projects, stable preferences (tools, formats, topics/interests they follow), recurring goals, constraints.
- EXCLUDE one-off questions, the assistant's answers, and anything sensitive (health, finances, credentials, beliefs) UNLESS the user explicitly asks to be remembered for it.
- Merge new facts into the existing memory; drop anything contradicted or clearly outdated; deduplicate.
- Be brief: a flat list of short bullet lines starting with "- ", at most 12 bullets.
- If the conversation reveals nothing new and durable, return the existing memory unchanged.
- Return ONLY the memory bullet lines. No preamble, no headings, no explanation.`;

const MAX_MEMORY_CHARS = 1500;

chatRouter.post('/memory', async (req, res, next) => {
  try {
    const body = (req.body || {}) as { messages?: unknown; memory?: string; source?: string };
    const existing = typeof body.memory === 'string' ? body.memory.trim().slice(0, MAX_MEMORY_CHARS) : '';
    const incoming = Array.isArray(body.messages) ? body.messages : [];
    const turns = incoming
      .map(sanitizeMessage)
      .filter((m): m is ChatMessage => m !== null)
      .slice(-8);
    if (turns.length === 0) return res.json({ memory: existing });

    const resolved = resolveChatProvider(req, body.source);
    if (!resolved) return res.json({ memory: existing }); // silent no-op without a key

    const transcript = turns
      .map((t) => {
        const text = typeof t.content === 'string'
          ? t.content
          : Array.isArray(t.content)
            ? t.content.map((p) => ('text' in p ? p.text : '')).join(' ')
            : '';
        return `${t.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
      })
      .join('\n')
      .slice(0, 6000);

    // Reliable model for memory distillation — a flaky free model that 429s or returns
    // garbage is exactly why memory "felt terrible".
    const model = resolved.provider === 'nvidia' ? NVIDIA_TEXT_MODEL : OPENROUTER_TEXT_MODEL;
    const result = await runChat({
      provider: resolved.provider,
      apiKey: resolved.apiKey,
      model,
      messages: [{ role: 'user', content: `EXISTING MEMORY:\n${existing || '(none)'}\n\nRECENT CONVERSATION:\n${transcript}` }],
      systemOverride: MEMORY_SYSTEM_PROMPT,
      temperature: 0.2,
      maxTokens: 500,
      fallbackModel: resolved.provider === 'openrouter' ? TEXT_FALLBACK : undefined,
      fallbackModels: resolved.provider === 'openrouter' ? [OPENROUTER_TEXT_MODEL, TEXT_FALLBACK] : undefined,
      timeoutMs: TEXT_REQUEST_TIMEOUT_MS
    });
    const updated = (result.text || '').trim().slice(0, MAX_MEMORY_CHARS);
    res.json({ memory: updated || existing });
  } catch (err) {
    next(err);
  }
});

// Proactive follow-ups: after an answer, suggest the few things THIS user is most
// likely to actually want next — so the assistant feels helpful and forward-looking
// instead of waiting passively. Deliberately context-disciplined: it must NOT invent a
// persona, profession or scenario the conversation doesn't support (the user flagged
// "fake context" — e.g. assuming a 10-year job search for a student — as a real harm).
const FOLLOWUPS_SYSTEM_PROMPT = `You generate short follow-up suggestions for a chat user: the next things THIS user is genuinely likely to ask, based ONLY on the conversation so far.

You are given the recent conversation. Output 3 suggestions as a JSON array of strings.

Rules:
- Phrase each in the FIRST PERSON, exactly as the user would type it to the assistant ("Show me a worked example", "Turn this into steps I can follow", "Make it shorter").
- Make them SPECIFIC to what was just discussed — reference the actual topic. A good suggestion moves the user forward: go deeper, see an example, apply it, compare options, visualize it, practice it, or get a downloadable resource.
- Stay strictly RELEVANT to this conversation and this user. NEVER invent a different persona, profession, age, or life situation the conversation doesn't clearly support (do not assume a job hunt, years of experience, a company, or interests that were never shown). If the context is thin, keep the suggestions close to the literal topic.
- Each under ~8 words. No numbering, no markdown, no surrounding quotes inside the strings.
- If there's no useful follow-up (a plain greeting, a goodbye, or the request is fully resolved), return [].
- Return ONLY the JSON array, nothing else.`;

// Best-effort parse of a model's JSON-array reply into ≤3 short suggestion strings.
const parseFollowUps = (raw: string): string[] => {
  const text = (raw || '').trim();
  if (!text) return [];
  let arr: unknown;
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      arr = JSON.parse(text.slice(start, end + 1));
    } catch {
      arr = undefined;
    }
  }
  // Fallback: a bulleted/numbered list instead of JSON.
  const items = Array.isArray(arr)
    ? arr
    : text.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim());
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const s = String(item || '').replace(/^["']|["']$/g, '').trim().slice(0, 100);
    if (!s || s.length < 3) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= 3) break;
  }
  return out;
};

chatRouter.post('/followups', async (req, res, next) => {
  try {
    const body = (req.body || {}) as { messages?: unknown; source?: string };
    const incoming = Array.isArray(body.messages) ? body.messages : [];
    const turns = incoming
      .map(sanitizeMessage)
      .filter((m): m is ChatMessage => m !== null)
      .slice(-6);
    // Need at least one assistant answer to suggest follow-ups for.
    if (turns.length === 0 || !turns.some((t) => t.role === 'assistant')) {
      return res.json({ suggestions: [] });
    }

    const resolved = resolveChatProvider(req, body.source);
    if (!resolved) return res.json({ suggestions: [] }); // silent no-op without a key

    const transcript = turns
      .map((t) => {
        const text =
          typeof t.content === 'string'
            ? t.content
            : Array.isArray(t.content)
              ? t.content.map((p) => ('text' in p ? p.text : '')).join(' ')
              : '';
        return `${t.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
      })
      .join('\n')
      .slice(0, 6000);

    // Fast, reliable model + no tools — this runs after every answer, so it must be cheap.
    const model = resolved.provider === 'nvidia' ? NVIDIA_TEXT_MODEL : OPENROUTER_TEXT_MODEL;
    const result = await runChat({
      provider: resolved.provider,
      apiKey: resolved.apiKey,
      model,
      messages: [{ role: 'user', content: `Conversation so far:\n${transcript}\n\nSuggest the follow-ups.` }],
      systemOverride: FOLLOWUPS_SYSTEM_PROMPT,
      temperature: 0.5,
      maxTokens: 200,
      fallbackModel: resolved.provider === 'openrouter' ? TEXT_FALLBACK : undefined,
      fallbackModels: resolved.provider === 'openrouter' ? [OPENROUTER_TEXT_MODEL, TEXT_FALLBACK] : undefined,
      timeoutMs: TEXT_REQUEST_TIMEOUT_MS
    });
    res.json({ suggestions: parseFollowUps(result.text || ''), model: result.model });
  } catch (err) {
    next(err);
  }
});

// Live widget refresh: re-execute the single whitelisted tool call that produced an
// artifact (its `origin`), so the client updates the widget in place with fresh data.
// No model round-trip, no billing reservation — these are keyless data tools.
const REFRESHABLE = new Set<string>(REFRESHABLE_TOOLS);
chatRouter.post('/tool-refresh', async (req, res) => {
  const body = (req.body ?? {}) as { tool?: unknown; args?: unknown; clientContext?: unknown };
  const tool = typeof body.tool === 'string' ? body.tool : '';
  if (!REFRESHABLE.has(tool)) {
    return res.status(400).json({ error: { message: 'This widget cannot be refreshed.' } });
  }
  const args =
    body.args && typeof body.args === 'object' && !Array.isArray(body.args)
      ? (body.args as Record<string, unknown>)
      : {};
  let clientContext = sanitizeClientContext(body.clientContext);
  if (!clientContext?.location) {
    const geo = await resolveClientGeo(clientIpFromReq(req)).catch(() => null);
    if (geo && (geo.city || geo.country)) {
      clientContext = {
        ...(clientContext || {}),
        location: { city: geo.city, region: geo.region, country: geo.country, lat: geo.lat, lng: geo.lng, approximate: true }
      };
    }
  }
  const impl = resolveTools([tool], {
    timezone: clientContext?.timezone,
    locale: clientContext?.locale,
    units: clientContext?.units,
    location: clientContext?.location
  })[0];
  if (!impl) return res.status(400).json({ error: { message: 'Tool unavailable.' } });
  try {
    const signal = AbortSignal.timeout(20_000);
    const out = await impl.execute(args, signal);
    res.json({
      artifacts: (out.artifacts ?? []).map((a) => ({ ...a, origin: { tool, args } })),
      asOf: new Date().toISOString()
    });
  } catch (err) {
    res.status(502).json({ error: { message: (err as Error)?.message || 'Refresh failed.' } });
  }
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
      if (p.resolved.provider === 'openrouter' && result.model && p.model && result.model !== p.model) {
        markModelDown(p.model);
      }
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

  // SSE keep-alive. A tool-grounded turn (web search → weather/places → synthesis) can run
  // 20–60s before the first token, during which the stream sends NO bytes. Mobile carriers,
  // the Railway/Cloudflare edge and other proxies drop an idle streaming connection after
  // ~30s — the browser then surfaces the cut as a bare "network error" and the whole turn
  // fails. A periodic comment line (ignored by the SSE parser) keeps the connection hot
  // until real output flows. Cleared in `finally` so it never outlives the response.
  const heartbeat = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      /* socket already closed */
    }
  }, 15_000);

  try {
    const result = await runChat({
      ...runChatParams(p),
      onDelta: (d) => {
        if (d.content) send('delta', { content: d.content });
        else if (d.reasoning) send('reasoning', { reasoning: d.reasoning });
      },
      // Tell the client to drop the previous turn's streamed pre-tool narration before
      // the next turn streams, so multi-step answers don't accumulate preamble on screen.
      onReset: () => send('reset', {})
    });

    // Adaptive speed: if the served model differs from the (free) primary we led the chain
    // with, that primary is currently unavailable/rate-limited — cool it down so the next
    // requests skip it and respond fast instead of re-paying its fallback latency.
    if (p.resolved.provider === 'openrouter' && result.model && p.model && result.model !== p.model) {
      markModelDown(p.model);
    }

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
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// Agent swarm (SSE). Plans → runs specialized agents in parallel → synthesizes.
// Mirrors /stream for billing + transport, but emits `trace` events so the client
// can render the plan executing live. OpenRouter-only (agents need tool calling).
chatRouter.post('/swarm', async (req, res) => {
  const prep = await prepareChat(req);
  if ('error' in prep) return res.status(prep.error.status).json(prep.error.body);
  const p = prep.prepared;

  if (p.resolved.provider !== 'openrouter') {
    return res.status(400).json({
      error: { message: 'The agent swarm requires an OpenRouter key (agents use tool calling).', code: 'SWARM_REQUIRES_OPENROUTER' }
    });
  }

  const reserve = req.user?.id
    ? await reserveForOperation({
        req,
        operation: 'chat.completion',
        fallbackModel: p.model,
        provider: p.resolved.provider,
        stage: 'chat',
        metadata: { route: req.path, historyLength: p.messages.length, model: p.model, swarm: true }
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

  // Keep-alive: the swarm's plan + parallel-agent phase can be quiet for a while before the
  // first trace/token; without periodic bytes an idle proxy drops the stream (see /stream).
  const heartbeat = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      /* socket already closed */
    }
  }, 15_000);

  try {
    const result = await runSwarm({
      provider: p.resolved.provider,
      apiKey: p.resolved.apiKey,
      model: p.model,
      messages: p.messages,
      systemPrompt: p.systemPrompt,
      clientContext: p.clientContext,
      extraAgents: p.customAgents,
      fallbackModel: TEXT_FALLBACK,
      timeoutMs: TEXT_REQUEST_TIMEOUT_MS,
      onDelta: (d) => {
        if (d.content) send('delta', { content: d.content });
        else if (d.reasoning) send('reasoning', { reasoning: d.reasoning });
      },
      onProgress: (trace) => send('trace', trace)
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
            metadata: { route: req.path, historyLength: p.messages.length, swarm: true }
          })
        : null;

    const payload: ChatResponse = {
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
      notices: withGuardrailNotices(result),
      usage: result.usage
    };
    const finalPayload =
      reserve && reserve.allowed
        ? attachBillingToPayload(payload as unknown as Record<string, unknown>, reserve.reservation, settled)
        : payload;
    send('final', finalPayload);
  } catch (error) {
    if (reserve && reserve.allowed) {
      await releaseReservedOperation({
        req,
        operation: 'chat.completion',
        provider: p.resolved.provider,
        model: p.model,
        reason: (error as Error)?.message || 'swarm_request_failed',
        metadata: { route: req.path, historyLength: p.messages.length, swarm: true }
      });
    }
    send('error', { message: (error as Error)?.message || 'The swarm failed.' });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});
