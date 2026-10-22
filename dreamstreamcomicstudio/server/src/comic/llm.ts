// Text LLM client for Comic Studio (v4): director turns, page-script planning, vision QC.
//
// A thin, opinionated wrapper over the existing provider layer (ai/gateway.ts):
//  - the model chain comes from textModels.ts (never from the client),
//  - OpenRouter gets the whole chain as its server-side `models` fallback list, Gemini
//    direct gets the next Google model as `fallbackModel`,
//  - structured output is requested with a strict JSON schema,
//  - per-role timeouts are passed explicitly. The OpenRouter provider honours
//    `timeoutMs` per call (it only defaults to OPENROUTER_REQUEST_TIMEOUT_MS when absent;
//    the 55s TEXT_REQUEST_TIMEOUT_MS cap applies to browser-facing routes, not here), so
//    a 150s writer call is not cut at 55s; streaming uses it as an idle window,
//  - every failure becomes a StudioError with a message that is safe to show verbatim.
//
// Neither provider accepts an AbortSignal, so cancellation races the call: the caller
// is released immediately and the late result is discarded (and never streamed).

import { getProvider as gatewayGetProvider } from '../ai/gateway.js';
import { reasoningBudget } from '../ai/providers/openrouter.js';
import type { AIProvider, ChatMessage, GenerateTextRequest, GenerateTextResult, JsonSchemaSpec } from '../ai/providers/types.js';
import { logger } from '../lib/logger.js';
import { StudioError, type LlmClient, type LlmRequest, type LlmResult, type StudioKeys, type TextRole } from './types.js';
import { resolveTextRoute, TEXT_ROLE_DEFAULTS, type TextRoute } from './textModels.js';

export interface LlmClientDeps {
  getProvider?: (id: string) => AIProvider;
  /** Backoff sleep (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

const PROVIDER_LABEL: Record<TextRoute['route'], string> = { openrouter: 'OpenRouter', gemini: 'Gemini' };

/** Backoff before the single transient retry. */
const RETRY_DELAY_MS = 1500;
const RATE_LIMIT_RETRY_DELAY_MS = 3000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const cancelledError = () => new StudioError('CANCELLED', 'Cancelled.', { status: 499 });

const isAbortLike = (err: unknown): boolean => {
  const name = String((err as { name?: string })?.name || '');
  return name === 'AbortError';
};

/** Release the caller as soon as `signal` aborts; the underlying call is left to settle. */
const raceAbort = <T>(work: Promise<T>, signal?: AbortSignal): Promise<T> => {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(cancelledError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
};

type TaggedProviderError = Error & { status?: number; statusCode?: number; publicCode?: string };

/** HTTP status of a provider failure: the tagged status, else the code in "... failed: 429 ...". */
const statusOf = (err: TaggedProviderError, message: string): number | undefined => {
  const tagged = Number(err?.status ?? err?.statusCode);
  const fromMessage = /\bfailed:\s*(\d{3})\b/i.exec(message)?.[1];
  // makeProviderError re-maps some statuses (402/403 cap → 503, 5xx → 502). The raw code
  // in the message is the more precise signal when both exist.
  if (fromMessage) return Number(fromMessage);
  return Number.isFinite(tagged) && tagged >= 100 ? tagged : undefined;
};

const SAFETY_RE = /content.?policy|safety|moderation|flagged|prohibited|responsible ai/i;
const NETWORK_RE = /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|other side closed|load failed/i;
const TIMEOUT_RE = /timed out|took too long|stopped responding|deadline/i;
const JSON_RE = /\bJSON\b|Empty response|no JSON/i;
/** Errors produced from an unparseable structured reply (see isTransient). */
const unreadableReplies = new WeakSet<StudioError>();
/** Errors that are a provider's safety refusal (tagged here; read with isProviderRefusal). */
const providerRefusals = new WeakSet<StudioError>();

/**
 * True when the provider refused the request on safety grounds (a SAFETY_BLOCKED StudioError,
 * tagged by toLlmStudioError). Callers answer with a deterministic, warm redirect instead of an
 * error — and never count it as a strike: providers over-block creative action and horror.
 */
export const isProviderRefusal = (err: unknown): boolean =>
  err instanceof StudioError && (providerRefusals.has(err) || err.code === 'SAFETY_BLOCKED');

const REFUSAL_TEXT_RE =
  /^(?:i['’]?m sorry|i am sorry|sorry|i apologi[sz]e|unfortunately)?[,.!\s—-]*(?:but\s+)?(?:i|we)\s*(?:can(?:not|['’]t)|won['’]?t|will not|am not able to|['’]m not able to|am unable to|['’]m unable to|must decline to)\s+(?:help|assist|create|make|do|generate|write|draw|comply|provide|fulfil|fulfill|continue|produce)\b/i;

/** What makes "I can't …" a refusal rather than a plan ("I can't draw yet — we need a plan first"). */
const REFUSAL_OBJECT_RE =
  /\b(?:help|assist)(?: you)? with (?:that|this|your request|such)\b|\b(?:help|assist|comply)\s*(?:[.!]|$)|\b(?:create|make|do|generate|write|draw|produce|provide|fulfil|fulfill|continue)\s+(?:that|this|such|content like|this kind of|that kind of|these|those)\b|\b(?:polic(?:y|ies)|guidelines?|inappropriate|not appropriate|harmful|explicit|sexual|graphic violence|unsafe|not allowed)\b/i;

/** A short written reply that is a refusal ("I'm sorry, but I can't help with that."), not a comic answer. */
export const looksLikeRefusal = (text: string): boolean => {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  return t.length > 0 && t.length <= 320 && REFUSAL_TEXT_RE.test(t) && REFUSAL_OBJECT_RE.test(t);
};

/**
 * Translate any provider/transport failure into a StudioError with a friendly,
 * user-safe message. Raw provider bodies are logged, never shown.
 */
export const toLlmStudioError = (
  err: unknown,
  ctx: { role: TextRole; route: TextRoute['route']; byok: boolean }
): StudioError => {
  if (err instanceof StudioError) return err;
  const e = (err || {}) as TaggedProviderError;
  const message = String(e.message || err || '');
  const label = TEXT_ROLE_DEFAULTS[ctx.role]?.label || 'AI';
  const provider = PROVIDER_LABEL[ctx.route];
  const status = statusOf(e, message);
  const code = e.publicCode;

  if (isAbortLike(err)) return cancelledError();
  if (code === 'MODEL_TIMEOUT' || TIMEOUT_RE.test(message) || status === 408 || status === 504) {
    return new StudioError('TIMEOUT', `The ${label} took too long to answer. Please try again.`, {
      status: 504,
      retryable: true,
      cause: err
    });
  }
  if (code === 'PROVIDER_CAPACITY' || status === 402 || (status === 403 && /limit|quota|credit|insufficient/i.test(message))) {
    return new StudioError(
      'PROVIDER_ERROR',
      ctx.byok
        ? `Your ${provider} key is out of credits or over its spending limit. Top it up (or raise the limit), then try again.`
        : 'The shared AI service is at capacity right now. Try again shortly, or add your own key in Settings → API keys.',
      { status: 503, retryable: false, cause: err }
    );
  }
  if (code === 'RATE_LIMITED' || status === 429 || /rate.?limit|too many requests|resource.?exhausted/i.test(message)) {
    return new StudioError('RATE_LIMIT', `The ${label} is busy right now (rate limited). Wait a moment and try again.`, {
      status: 429,
      retryable: true,
      cause: err
    });
  }
  if (status === 401 || (status === 403 && !SAFETY_RE.test(message)) || /api key not valid|invalid api key|unauthorized/i.test(message)) {
    return new StudioError(
      'PROVIDER_ERROR',
      ctx.byok
        ? `Your ${provider} key was rejected. Check it in Settings → API keys.`
        : 'The AI service rejected the platform key. Please try again later.',
      { status: 502, retryable: false, cause: err }
    );
  }
  if (code === 'MODEL_NOT_FOUND' || status === 404 || /no endpoints|not a valid model|unknown model|no such model/i.test(message)) {
    return new StudioError('PROVIDER_ERROR', `The ${label} model isn't available right now. Please try again in a few minutes.`, {
      status: 502,
      retryable: true,
      cause: err
    });
  }
  if (SAFETY_RE.test(message) && (status === undefined || status === 400 || status === 403)) {
    const refusal = new StudioError('SAFETY_BLOCKED', "The AI provider's safety filter blocked this request. Try rephrasing it.", {
      status: 422,
      retryable: false,
      cause: err
    });
    providerRefusals.add(refusal);
    return refusal;
  }
  if (JSON_RE.test(message) && (status === undefined || status < 400)) {
    const unreadable = new StudioError('PROVIDER_ERROR', `The ${label}'s reply couldn't be read. Please try again.`, {
      status: 502,
      retryable: true,
      cause: err
    });
    unreadableReplies.add(unreadable);
    return unreadable;
  }
  if ((status !== undefined && status >= 500) || code === 'BAD_GATEWAY' || NETWORK_RE.test(message)) {
    return new StudioError('PROVIDER_ERROR', 'The AI provider had a temporary problem. Please try again.', {
      status: 502,
      retryable: true,
      cause: err
    });
  }
  if (status === 400) {
    return new StudioError('PROVIDER_ERROR', `The AI provider rejected the ${label}'s request.`, {
      status: 502,
      retryable: false,
      cause: err
    });
  }
  return new StudioError('PROVIDER_ERROR', `The ${label} failed unexpectedly. Please try again.`, {
    status: 502,
    retryable: true,
    cause: err
  });
};

/** Transient failures worth exactly one more attempt (not timeouts — they already waited). */
const isTransient = (err: StudioError): boolean => {
  if (err.code === 'RATE_LIMIT') return true;
  // An unreadable JSON reply already had the provider's corrective round-trip; don't pay a third time.
  return err.code === 'PROVIDER_ERROR' && err.retryable && !unreadableReplies.has(err);
};

/**
 * True when the provider cut the reply off at the token cap (the reply came back empty or
 * truncated because mandatory reasoning spent max_tokens). generateTextOnce tags these with
 * publicCode 'TRUNCATED'; unlike a transient blip, retrying only helps with a bigger budget.
 */
const isTruncated = (err: unknown): boolean => (err as TaggedProviderError)?.publicCode === 'TRUNCATED';

/**
 * Gemini's OpenAI-compatible endpoint only gets `response_format: json_object` (no
 * schema), so the model must be told the shape explicitly.
 */
const withSchemaInstruction = (messages: ChatMessage[], schema: JsonSchemaSpec): ChatMessage[] => {
  const instruction: ChatMessage = {
    role: 'system',
    content:
      `Reply with ONLY a JSON object (no prose, no code fences) that validates against this JSON Schema named "${schema.name}":\n` +
      JSON.stringify(schema.schema)
  };
  const firstNonSystem = messages.findIndex((m) => m.role !== 'system');
  if (firstNonSystem <= 0) return firstNonSystem === 0 ? [instruction, ...messages] : [...messages, instruction];
  return [...messages.slice(0, firstNonSystem), instruction, ...messages.slice(firstNonSystem)];
};

const hasPayload = (result: GenerateTextResult, wantsJson: boolean): boolean => {
  if (wantsJson) return result.json !== undefined && result.json !== null;
  return Boolean((result.text || '').trim() || result.toolCalls?.length);
};

export function createLlmClient(keys: StudioKeys, deps: LlmClientDeps = {}): LlmClient {
  const getProvider = deps.getProvider || gatewayGetProvider;
  const sleep = deps.sleep || defaultSleep;

  const complete = async (req: LlmRequest): Promise<LlmResult> => {
    const route = resolveTextRoute(req.role, keys);
    if (!route) {
      throw new StudioError(
        'NO_TEXT_KEY',
        'Connect a Gemini or OpenRouter key in Settings → API keys so the studio can plan your comic.',
        { status: 400 }
      );
    }
    if (req.signal?.aborted) throw cancelledError();

    const defaults = TEXT_ROLE_DEFAULTS[req.role];
    const provider = getProvider(route.route);
    const wantsJson = Boolean(req.jsonSchema);
    const jsonSchema: JsonSchemaSpec | undefined = req.jsonSchema
      ? { ...req.jsonSchema, strict: req.jsonSchema.strict ?? true }
      : undefined;

    // Several configured models have mandatory reasoning (Sonnet 5.5 defaults to 'high', the
    // Gemini flash/argon models to 'medium') and the thinking tokens are drawn from max_tokens.
    // Bound the thinking to the role's effort (OpenRouter maps it to reasoning.max_tokens) AND
    // pad max_tokens by that budget so the visible JSON reply still fits — otherwise thinking
    // eats the whole cap and the reply comes back empty/truncated (Anthropic also requires
    // max_tokens > the reasoning budget). The ×1.5 leaves slack for the budget→thinkingLevel
    // rounding Gemini 3 does.
    const effort = defaults.reasoningEffort;
    const visibleMaxTokens = req.maxTokens ?? defaults.maxTokens;
    const genReq: GenerateTextRequest = {
      model: route.model,
      messages: route.route === 'gemini' && jsonSchema ? withSchemaInstruction(req.messages, jsonSchema) : req.messages,
      jsonSchema,
      tools: req.tools?.length ? req.tools : undefined,
      temperature: req.temperature ?? defaults.temperature,
      maxTokens: visibleMaxTokens + Math.ceil(reasoningBudget(effort) * 1.5),
      reasoningEffort: effort,
      timeoutMs: defaults.timeoutMs,
      // One provider-level attempt; the single transient retry below is classified properly
      // (the provider's own retry only recognises 429/503 by message text).
      retries: 1
    };
    if (route.route === 'openrouter') {
      if (route.models.length > 1) genReq.models = route.models;
    } else if (route.models[1]) {
      genReq.fallbackModel = route.models[1];
    }
    const ctx = { apiKey: route.key.key, byok: route.key.byok };
    const errCtx = { role: req.role, route: route.route, byok: route.key.byok };

    // Stream narration only for plain-text/tool turns: structured JSON needs the
    // provider's parse + repair path, which only the non-streaming call has.
    const canStream = Boolean(req.onDelta && !wantsJson && provider.generateTextStream);
    let streamedAny = false;
    const onDelta = (delta: { content?: string }) => {
      if (!delta.content || req.signal?.aborted) return;
      streamedAny = true;
      try {
        req.onDelta!(delta.content);
      } catch (err) {
        logger.warn('comic_llm_ondelta_failed', { message: (err as Error)?.message });
      }
    };

    const attempt = async (): Promise<GenerateTextResult> => {
      const work = canStream ? provider.generateTextStream!(genReq, ctx, onDelta) : provider.generateText(genReq, ctx);
      const result = await raceAbort(work, req.signal);
      if (!hasPayload(result, wantsJson)) {
        throw new StudioError(
          'PROVIDER_ERROR',
          `The ${defaults.label} returned an empty reply. Please try again.`,
          { status: 502, retryable: true, cause: new Error('Empty model reply') }
        );
      }
      return result;
    };

    const started = Date.now();
    let result: GenerateTextResult;
    try {
      try {
        result = await attempt();
      } catch (first) {
        const error = toLlmStudioError(first, errCtx);
        const truncated = isTruncated(first);
        // Never retry once text has streamed to the user (it would duplicate), or after cancel.
        if ((!isTransient(error) && !truncated) || streamedAny || req.signal?.aborted) throw error;
        logger.warn('comic_llm_retry', {
          role: req.role,
          route: route.route,
          model: route.model,
          code: truncated ? 'TRUNCATED' : error.code
        });
        if (truncated) {
          // Reasoning consumed the budget — give the visible reply more room rather than
          // sleeping (it is not a transient blip) and rather than a JSON repair (it won't help).
          genReq.maxTokens = (genReq.maxTokens ?? defaults.maxTokens) * 2;
        } else {
          await sleep(error.code === 'RATE_LIMIT' ? RATE_LIMIT_RETRY_DELAY_MS : RETRY_DELAY_MS);
        }
        if (req.signal?.aborted) throw cancelledError();
        result = await attempt();
      }
    } catch (err) {
      const error = toLlmStudioError(err, errCtx);
      if (error.code !== 'CANCELLED') {
        logger.warn('comic_llm_failed', {
          role: req.role,
          route: route.route,
          model: route.model,
          code: error.code,
          providerRefusal: isProviderRefusal(error),
          ms: Date.now() - started,
          detail: String(((error as { cause?: Error }).cause as Error | undefined)?.message || error.message).slice(0, 300)
        });
      }
      throw error;
    }

    return {
      text: result.text || '',
      json: wantsJson ? result.json : undefined,
      toolCalls: result.toolCalls?.length ? result.toolCalls : undefined,
      model: result.model || route.model,
      costUsd: typeof result.usage?.costUsd === 'number' ? result.usage.costUsd : undefined,
      promptTokens: result.usage?.promptTokens,
      completionTokens: result.usage?.completionTokens,
      byok: route.key.byok,
      provider: route.route
    };
  };

  return { complete };
}
