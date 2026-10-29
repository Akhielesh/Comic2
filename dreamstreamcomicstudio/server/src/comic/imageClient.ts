// Image transport for Comic Studio (v4): one call = one image, on exactly the model the
// job asked for (docs/features/comic-studio-v4.md §4–§6.1).
//
// Routes:
//  - OpenRouter Unified Image API (POST /images) with ordered `input_references`. If the
//    endpoint is not available (404/405) we fall back once to the chat-completions image
//    path, which every chat-transport OpenRouter image model supports. An Images-API model
//    (registry `api.openrouter === 'images'`) never falls back: the chat path has neither its
//    quality pin nor its provider pin, so it fails honestly instead (models.md §3.6 H).
//  - Gemini direct via @google/genai generateContent, references INTERLEAVED with their
//    labels ("Image 2: CHARACTER SHEET: ARJUN") so the model can bind label → picture.
//
// Reliability rules (each was a real failure in the old studio):
//  - never switch models (a failed page must not silently come back in another style);
//    when a route is rate-limited or down, the SAME model may be retried once on the other
//    route — only between keys with the same payer (the user's own ↔ the user's own,
//    platform ↔ platform), never silently moving spend between the user and DreamStream,
//  - a 429 puts that route+model+key on a short shared cooldown so parallel jobs (three
//    style tests, a page batch) wait it out instead of piling more requests on,
//  - aspect ratio and resolution are request parameters, validated against the registry
//    (never prose), and parameters the model rejects are stripped,
//  - reference counts are capped at the model's limit,
//  - one retry with backoff on 429/5xx/network; one "Generate the image now." nudge when
//    the model answers with text instead of a picture; NO silent retry without
//    imageConfig (that is how pages used to come back square),
//  - every failure is a StudioError with an honest, user-safe message; it also carries
//    `imageFailure` (route, status, upstream provider, Retry-After — never a body or a key)
//    so the job runner can re-queue after Retry-After and say who refused.

import { createHash } from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { GEMINI_BASE_URL, OPENROUTER_APP_TITLE, OPENROUTER_APP_URL, OPENROUTER_BASE_URL } from '../config.js';
import { markSharedKeyCapped } from '../ai/providerCircuit.js';
import { logger } from '../lib/logger.js';
import { imagePriceUsd, nearestAspect, type ImageModelSpec, type ImageRoute } from '../../../shared/comic/models.js';
import type { AspectRatio, Resolution } from '../../../shared/comic/doc.js';
import type { OrImageEndpoint } from './models/catalog.js';
import {
  acquireRouteCall,
  isRoutePausedError,
  outcomeFromError,
  recordImageOutcome,
  routePausedError,
  routeState,
  type ModelHealthPort
} from './models/health.js';
import { mapEndpointPricing, variantToResolution } from './models/pricing.js';
import {
  StudioError,
  type ImageGenerator,
  type ImageReference,
  type ImageRequest,
  type ImageResult,
  type ResolvedKey,
  type StudioKeys
} from './types.js';
import { prefersGeminiDirect } from './keys.js';

// ── Request / result extras (types.ts ImageRequest / ImageResult gain these: wave note) ──

/** What the job runner may add to an ImageRequest. */
export interface ImageRequestExtras {
  /**
   * The route the money-safe preflight chose (reliability.md §2): the same model on the other route, used ONLY when
   * that route's key has the same payer as the primary's (pickAlternateRoute); anything else is ignored.
   */
  preferRoute?: ImageRoute;
  /** Images-API transport: the per-image provider price the run was quoted at (`provider.only` keeps endpoints ≤ it). */
  maxUsd?: number;
}

/** What the transport reports beyond ImageResult. */
export interface ImageResultExtras {
  /** The upstream provider that served the call (OpenRouter's `provider`), when reported. */
  providerName?: string;
  /** The model version the provider reported (OpenRouter `model`, Gemini `modelVersion`; models.md §2.5). */
  modelVersion?: string;
}

export type ImageRequestPlus = ImageRequest & ImageRequestExtras;
export type ImageResultPlus = ImageResult & ImageResultExtras;

// ── Dependencies (injectable for tests) ──────────────────────────────────────

/** The slice of the @google/genai client this module uses. */
export interface GeminiModelsLike {
  generateContent(params: Record<string, unknown>): Promise<unknown>;
}

export interface ImageClientDeps {
  fetch?: typeof fetch;
  createGemini?: (apiKey: string) => GeminiModelsLike;
  /** Abortable backoff sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  /**
   * OpenRouter's public endpoint list for an Images-API model (`/images/models/{id}/endpoints`: price lines, resolution
   * enums, reference caps). null = unknown (the request then pins nothing it cannot justify). Default: a cached, key-less
   * GET (6 h; a failure is not retried for 5 min).
   */
  imageEndpoints?: (openrouterModelId: string) => Promise<OrImageEndpoint[] | null>;
  /** The provider-health breaker (reliability.md §2). Default: the process-wide one in models/health.ts. */
  health?: Pick<ModelHealthPort, 'acquireRouteCall' | 'recordImageOutcome' | 'routeState'>;
}

const defaultCreateGemini = (apiKey: string): GeminiModelsLike =>
  new GoogleGenAI({ apiKey, httpOptions: { baseUrl: GEMINI_BASE_URL } }).models as unknown as GeminiModelsLike;

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(cancelled());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelled());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

// ── Errors ───────────────────────────────────────────────────────────────────

const cancelled = () => new StudioError('CANCELLED', 'Cancelled.', { status: 499 });

const ROUTE_LABEL: Record<ImageRoute, string> = { openrouter: 'OpenRouter', gemini: 'Gemini' };

/**
 * Who actually refused, from OpenRouter's error metadata. A 429 means very different things:
 * the model's upstream provider throttling everyone (nothing the user can change), a Google
 * key the user attached in OpenRouter → Integrations (their own quota), or OpenRouter's
 * own limit on the key. The owner once raised their OpenRouter limit for an upstream
 * throttle because all three looked like "busy".
 */
export interface ProviderErrorMeta {
  providerName?: string;
  /** OpenRouter routed through the user's own provider key (OpenRouter BYOK integration). */
  isByok?: boolean;
  errorType?: string;
}

/** Internal transport failure before classification. */
class ImageHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly retryAfterMs?: number,
    readonly meta?: ProviderErrorMeta
  ) {
    super(message);
    this.name = 'ImageHttpError';
  }
}

/** Downloading a generated image (a hosted URL) failed: its 404 says nothing about the model being served. */
class ImageDownloadError extends ImageHttpError {}

/** models.md §3.6 H reason for a 404 on the model call: the provider no longer serves this model. */
export const MODEL_GONE_REASON = 'the provider no longer serves it';
/** The H reason when an Images-API model's /images answered 404/405 (or is skipped after one): never sent to chat. */
export const IMAGES_API_GONE_REASON = "OpenRouter's image service doesn't offer it right now";

/**
 * The §3.6 H reason when the comic's model can't be drawn at all on this route (the provider no longer serves it,
 * no endpoint serves the resolution at the quoted price, the Images API is unavailable for an Images-API model).
 * Undefined for every other failure. Never a key, a body or a provider message.
 */
export const modelUnavailableReason = (err: unknown): string | undefined => {
  const reason = (err as { modelUnavailable?: unknown } | null)?.modelUnavailable;
  return typeof reason === 'string' && reason ? reason : undefined;
};

/** A classified, non-retryable refusal that made no paid call: the job fails with H (never another model). */
const modelUnavailableError = (route: ImageRoute, nickname: string, reason: string, status = 422): StudioError =>
  Object.assign(
    new StudioError('PROVIDER_ERROR', `${nickname} can't be drawn right now: ${reason}.`, { status, retryable: false }),
    { imageFailure: { route } as ImageFailureInfo, modelUnavailable: reason, spentUsd: 0 }
  );

const SAFETY_FINISH = new Set([
  'SAFETY',
  'IMAGE_SAFETY',
  'PROHIBITED_CONTENT',
  'IMAGE_PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'CONTENT_FILTER',
  'RECITATION',
  'IMAGE_RECITATION'
]);
const SAFETY_TEXT_RE =
  /safety|content.?policy|moderation|flagged|prohibited|responsible ai|blocked|violat|not allowed to generate|cannot (?:generate|create) (?:this|that|images? of)/i;
const NETWORK_RE = /fetch failed|network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|other side closed|terminated/i;
const KEY_RE = /api key not valid|invalid api key|api_key_invalid|unauthorized|no auth credentials|user not found/i;

// A moderation rejection (e.g. OpenRouter 403 '…flagged for "violence". No credits were
// charged.') contains "credit(s)" but is NOT a capacity failure. It must never trip the
// shared-key breaker (which would degrade chat for every tenant) nor be reported as "at
// capacity". Only genuine credit/limit text counts — same narrow shape the text provider uses.
const MODERATION_RE = /flagged|moderation|content.?policy/i;
const CAPACITY_403_RE = /key limit|limit exceeded|total limit|quota|insufficient (?:credits|funds|balance)/i;
const isCapacityError = (status: number, message: string): boolean =>
  status === 402 || (status === 403 && !MODERATION_RE.test(message) && CAPACITY_403_RE.test(message));

/** A text-only reply that reads as a policy refusal rather than a glitch. */
export const looksLikeRefusal = (text: string): boolean =>
  SAFETY_TEXT_RE.test(text) && /can(?:'|no)?t|unable|won'?t|not able|refus/i.test(text);

const isSafetyFinish = (reason: unknown): boolean =>
  typeof reason === 'string' && SAFETY_FINISH.has(reason.trim().toUpperCase().replace(/[\s-]+/g, '_'));

export const safetyBlocked = (cause?: unknown) =>
  new StudioError(
    'SAFETY_BLOCKED',
    "The image model's safety filter declined this one. Try rewording the scene — less graphic violence or no real people's likeness usually helps.",
    { status: 422, retryable: false, cause }
  );

const noImage = (cause?: unknown) =>
  new StudioError('NO_IMAGE', 'The image model replied without a picture. Please try again.', {
    status: 502,
    retryable: true,
    cause
  });

// Our OWN client-side deadline fired after the request was dispatched — the provider very
// likely still generated (and billed) the image. `abandoned` tells the job runner to bill
// the registry price and NOT retry (a retry would pay for a second generation). A provider
// 408/504 (classifyImageError) is a different case and is NOT marked abandoned.
const timeoutError = (ms: number) =>
  Object.assign(
    new StudioError('TIMEOUT', `The image model took longer than ${Math.round(ms / 1000)}s and was stopped. Please try again.`, {
      status: 504,
      retryable: true
    }),
    { abandoned: true }
  );

// Keys and tokens: OpenRouter/Gemini key shapes, bearer values, and long mixed letter+digit runs.
const SECRET_LIKE_RE =
  /\b(?:sk-[A-Za-z0-9_-]{6,}|AIza[0-9A-Za-z_-]{10,}|Bearer\s+\S+|(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,})/g;

/**
 * What the provider itself said, short and safe to show: the transport prefix and JSON
 * wrapping are dropped, anything key-like is redacted. Without this the owner could only
 * see "busy" and had no way to tell an upstream capacity limit from their own quota.
 */
export const providerDetail = (message: string): string => {
  let text = String(message || '').replace(/^OpenRouter \/[\w/]+ \d{3}:\s*/, '');
  const quoted = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (quoted) text = quoted[1].replace(/\\(.)/g, '$1');
  text = text
    .replace(SECRET_LIKE_RE, '…')
    .replace(/[{}"\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Nothing beyond what our own message already says.
  if (!text || /^(?:rate limited|too many requests|provider returned error|image provider error)\.?$/i.test(text)) return '';
  return text.length > 180 ? `${text.slice(0, 179).trimEnd()}…` : text;
};

/**
 * Facts the job runner may keep about a failed image call: who answered, the HTTP status, the
 * upstream provider and the provider's Retry-After hint. Never the message body or any key.
 */
export interface ImageFailureInfo {
  route: ImageRoute;
  status?: number;
  providerName?: string;
  /** OpenRouter routed through the user's own provider key (Integrations). */
  isByok?: boolean;
  /** Provider's Retry-After, in ms (rate limits). */
  retryAfterMs?: number;
}

/** The failure facts attached to a StudioError thrown by the image generator (undefined otherwise). */
export const imageFailureInfo = (err: unknown): ImageFailureInfo | undefined => {
  const info = (err as { imageFailure?: unknown } | null)?.imageFailure;
  return info && typeof info === 'object' ? (info as ImageFailureInfo) : undefined;
};

/** "OpenRouter · 429 · upstream Google" — short, sanitized, safe to store and show. */
export const imageFailureDetail = (err: unknown): string | undefined => {
  const info = imageFailureInfo(err);
  if (!info) return undefined;
  const code = (err as { code?: unknown })?.code;
  const parts = [
    ROUTE_LABEL[info.route] || 'Image provider',
    Number.isFinite(info.status) && (info.status as number) > 0 ? String(info.status) : typeof code === 'string' ? code : '',
    info.providerName ? `upstream ${info.providerName.replace(/[^\w .()-]/g, '').slice(0, 40)}` : '',
    info.isByok ? 'your integration key' : ''
  ].filter(Boolean);
  return parts.join(' · ');
};

const withDetail = (base: string, provider: string, message: string): string => {
  const detail = providerDetail(message);
  return detail ? `${base} (${provider} said: ${detail.replace(/\.$/, '')}.)` : base;
};

const rateLimitMessage = (
  ctx: { route: ImageRoute; byok: boolean; model?: string },
  meta: ProviderErrorMeta | undefined,
  message: string
): string => {
  const model = ctx.model || 'This image model';
  if (ctx.route === 'openrouter') {
    if (meta?.isByok) {
      return `OpenRouter sent ${model} through the Google key in your OpenRouter Integrations, and that key is rate-limited. Wait a minute, or check that key's quota and billing in Google AI Studio.`;
    }
    if (meta?.providerName || /upstream/i.test(message)) {
      const upstream = meta?.providerName ? ` (${meta.providerName})` : '';
      return `${model} is being throttled by its provider${upstream} for everyone on OpenRouter right now — your key and limits are fine. Wait a minute or two and try again.`;
    }
  }
  return 'The image model is busy right now (rate limited). Wait a minute and try again.';
};

/** Map an HTTP / SDK / network failure to a StudioError. */
export const classifyImageError = (
  err: unknown,
  ctx: { route: ImageRoute; byok: boolean; model?: string }
): StudioError => {
  if (err instanceof StudioError) return err;
  const e = (err || {}) as { status?: unknown; code?: unknown; message?: unknown; name?: unknown; meta?: ProviderErrorMeta };
  const message = String(e.message || err || '');
  const status = Number(e.status);
  const provider = ROUTE_LABEL[ctx.route];

  if (e.name === 'AbortError') return cancelled();

  if (isCapacityError(status, message)) {
    return new StudioError(
      'PROVIDER_ERROR',
      ctx.byok
        ? `Your ${provider} key is out of credits or over its spending limit. Top it up (or raise the limit), then try again.`
        : 'The shared image service is at capacity right now. Try again later, or add your own key in Settings → API keys.',
      { status: 503, retryable: false, cause: err }
    );
  }
  // Gemini image models have no free tier: an unbilled project gets 429 RESOURCE_EXHAUSTED
  // "…free_tier_requests, limit: 0…". Retrying can never succeed, so say what to fix rather
  // than "busy, wait a minute" (which sends the client and job runner into dead retries).
  // A free-tier per-minute 429 carries a non-zero limit and stays a transient RATE_LIMIT.
  // The same "limit: 0" can come back through OpenRouter when the account routes Google
  // models through its own Google key (OpenRouter BYOK integration) on an unbilled project.
  if ((status === 429 || /resource.?exhausted/i.test(message)) && /\blimit:\s*0\b/i.test(message)) {
    return new StudioError(
      'PROVIDER_ERROR',
      !ctx.byok
        ? 'The shared image service is at capacity right now. Try again later, or add your own key in Settings → API keys.'
        : ctx.route === 'gemini'
          ? 'Your Gemini key has no image-generation quota (its Google Cloud project has no billing). Enable billing for that project in Google AI Studio, or add an OpenRouter key in Settings → API keys.'
          : 'OpenRouter is sending this model through a Google key with no image quota (its Google Cloud project has no billing). Enable billing for that project, or remove that Google key from your OpenRouter integrations.',
      { status: 503, retryable: false, cause: err }
    );
  }
  if (status === 429 || /resource.?exhausted|rate.?limit|too many requests/i.test(message)) {
    return new StudioError('RATE_LIMIT', withDetail(rateLimitMessage(ctx, e.meta, message), provider, message), {
      status: 429,
      retryable: true,
      cause: err
    });
  }
  if (status === 401 || (status === 403 && !SAFETY_TEXT_RE.test(message)) || KEY_RE.test(message)) {
    return new StudioError(
      'PROVIDER_ERROR',
      ctx.byok
        ? `Your ${provider} key was rejected. Check it in Settings → API keys.`
        : 'The image service rejected the platform key. Please try again later.',
      { status: 502, retryable: false, cause: err }
    );
  }
  if ((status === 400 || status === 403 || status === 422 || !Number.isFinite(status)) && SAFETY_TEXT_RE.test(message) && !NETWORK_RE.test(message)) {
    return safetyBlocked(err);
  }
  if (status === 404) {
    return new StudioError('PROVIDER_ERROR', `That image model isn't available on ${provider} right now. Please try again later.`, {
      status: 502,
      retryable: false,
      cause: err
    });
  }
  if (status === 408 || status === 504) {
    return new StudioError('TIMEOUT', 'The image provider timed out. Please try again.', { status: 504, retryable: true, cause: err });
  }
  if ((Number.isFinite(status) && status >= 500) || NETWORK_RE.test(message)) {
    return new StudioError('PROVIDER_ERROR', withDetail('The image provider had a temporary problem. Please try again.', provider, message), {
      status: 502,
      retryable: true,
      cause: err
    });
  }
  if (status === 400 || status === 422) {
    return new StudioError('PROVIDER_ERROR', withDetail('The image model rejected the request.', provider, message), {
      status: 502,
      retryable: false,
      cause: err
    });
  }
  return new StudioError('PROVIDER_ERROR', withDetail('The image model failed unexpectedly. Please try again.', provider, message), {
    status: 502,
    retryable: true,
    cause: err
  });
};

// ── Request preparation ──────────────────────────────────────────────────────

export interface PickedImageRoute {
  route: ImageRoute;
  model: string;
  key: ResolvedKey;
}

/** OpenRouter when it has a key AND serves the model, else Gemini direct, else NO_IMAGE_KEY. */
export const pickImageRoute = (spec: ImageModelSpec, keys: StudioKeys): PickedImageRoute => {
  // A user who brought their own Gemini key (and no BYOK OpenRouter key) should draw on
  // THEIR key, not the platform's — so when they prefer Gemini-direct and the model has a
  // Gemini route, take it ahead of the platform OpenRouter key. Models with no Gemini route
  // still fall through to OpenRouter below.
  if (prefersGeminiDirect(keys) && keys.gemini?.key && spec.routes.gemini) {
    return { route: 'gemini', model: spec.routes.gemini, key: keys.gemini };
  }
  if (keys.openrouter?.key && spec.routes.openrouter) {
    return { route: 'openrouter', model: spec.routes.openrouter, key: keys.openrouter };
  }
  if (keys.gemini?.key && spec.routes.gemini) {
    return { route: 'gemini', model: spec.routes.gemini, key: keys.gemini };
  }
  const reachable = keys.openrouter || keys.gemini;
  throw new StudioError(
    'NO_IMAGE_KEY',
    reachable
      ? `${spec.nickname} needs ${spec.routes.openrouter ? 'an OpenRouter' : 'a Gemini'} key. Add one in Settings → API keys.`
      : 'Connect a Gemini or OpenRouter key in Settings → API keys to draw images.',
    { status: 400 }
  );
};

/**
 * The SAME model on the other route, for a one-time fallback when the picked route is
 * rate-limited or down. Only between keys with the same payer: a BYOK request never moves
 * onto the platform's key (DreamStream would pay) and a platform request never moves onto
 * the user's key (the user would pay without asking). Null when there is no such route.
 */
export const pickAlternateRoute = (spec: ImageModelSpec, keys: StudioKeys, primary: PickedImageRoute): PickedImageRoute | null => {
  const route: ImageRoute = primary.route === 'openrouter' ? 'gemini' : 'openrouter';
  const model = spec.routes[route];
  const key = keys[route];
  if (!model || !key?.key || key.byok !== primary.key.byok) return null;
  return { route, model, key };
};

/** Parameter aliases across transports, so `spec.unsupported` can name either form. */
const PARAM_ALIASES: Record<string, string[]> = {
  resolution: ['resolution', 'image_size', 'imageSize'],
  image_size: ['resolution', 'image_size', 'imageSize'],
  imagesize: ['resolution', 'image_size', 'imageSize'],
  aspect_ratio: ['aspect_ratio', 'aspectRatio'],
  aspectratio: ['aspect_ratio', 'aspectRatio']
};

/** Remove parameters the model rejects (top level and inside image config objects). */
export const stripUnsupported = <T extends Record<string, unknown>>(body: T, unsupported: readonly string[] = []): T => {
  if (!unsupported.length) return body;
  const names = new Set<string>();
  for (const raw of unsupported) {
    const key = raw.trim();
    if (!key) continue;
    for (const alias of PARAM_ALIASES[key.toLowerCase()] || [key]) names.add(alias);
  }
  const clean = (obj: Record<string, unknown>) => {
    for (const name of names) delete obj[name];
    for (const nested of ['image_config', 'imageConfig']) {
      const inner = obj[nested];
      if (inner && typeof inner === 'object' && !Array.isArray(inner)) {
        clean(inner as Record<string, unknown>);
        if (!Object.keys(inner as Record<string, unknown>).length) delete obj[nested];
      }
    }
  };
  const copy = JSON.parse(JSON.stringify(body)) as T;
  clean(copy);
  return copy;
};

export interface PreparedImageRequest {
  aspect: AspectRatio;
  /** Undefined when the model takes no resolution parameter (or not this one). */
  resolution?: Resolution;
  references: ImageReference[];
  droppedReferences: number;
}

const DATA_URL_PREFIX_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;

const isUsableReference = (url: string): boolean => {
  const prefix = DATA_URL_PREFIX_RE.exec(url.slice(0, 80));
  if (prefix) return url.length > prefix[0].length;
  return /^https:\/\/\S+$/i.test(url);
};

/** Validate a request against the model's registry capabilities. */
export const prepareImageRequest = (req: ImageRequest): PreparedImageRequest => {
  const { spec } = req;
  if (!req.prompt || !req.prompt.trim()) {
    throw new StudioError('BAD_REQUEST', 'The image prompt is empty.', { status: 400 });
  }
  const aspect = spec.aspects.includes(req.aspect) ? req.aspect : nearestAspect(spec, req.aspect);
  const resolution = spec.resolutions.length && spec.resolutions.includes(req.resolution) ? req.resolution : undefined;
  const cap = Math.max(0, spec.refs.total);
  const references = (req.references || []).slice(0, cap);
  references.forEach((ref, i) => {
    const url = typeof ref?.dataUrl === 'string' ? ref.dataUrl : '';
    if (!isUsableReference(url)) {
      throw new StudioError('BAD_REQUEST', `Reference image ${i + 1} (${ref?.label || 'unlabeled'}) could not be read.`, {
        status: 400
      });
    }
  });
  return { aspect, resolution, references, droppedReferences: Math.max(0, (req.references || []).length - references.length) };
};

const parseDataUrl = (dataUrl: string): { mimeType: string; data: string } | null => {
  const comma = dataUrl.indexOf(',');
  if (!dataUrl.startsWith('data:') || comma < 0) return null;
  const header = dataUrl.slice(5, comma);
  if (!/;base64$/i.test(header)) return null;
  return { mimeType: header.replace(/;base64$/i, '') || 'image/png', data: dataUrl.slice(comma + 1) };
};

// ── Attempt plumbing ─────────────────────────────────────────────────────────

interface AttemptResult {
  dataUrl?: string;
  text?: string;
  /** The model (version) the provider reported. */
  model?: string;
  /** The upstream provider that served it (OpenRouter's top-level `provider`). */
  provider?: string;
  costUsd?: number;
  /** Provider said it refused on safety grounds. */
  blocked?: boolean;
  blockReason?: string;
}

/**
 * Run `fn` with a per-call deadline linked to the caller's signal. Distinguishes our
 * timeout (TIMEOUT) from a user cancel (CANCELLED); races the work so a transport that
 * ignores its signal can never hang the job.
 */
const withDeadline = async <T>(signal: AbortSignal | undefined, timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
  if (signal?.aborted) throw cancelled();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  let onDeadline: (() => void) | undefined;
  try {
    const work = fn(controller.signal);
    const deadline = new Promise<never>((_, reject) => {
      onDeadline = () => reject(timedOut ? timeoutError(timeoutMs) : cancelled());
      controller.signal.addEventListener('abort', onDeadline, { once: true });
    });
    work.catch(() => undefined);
    deadline.catch(() => undefined);
    return await Promise.race([work, deadline]);
  } catch (err) {
    if (timedOut) throw timeoutError(timeoutMs);
    if (signal?.aborted) throw cancelled();
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (onDeadline) controller.signal.removeEventListener('abort', onDeadline);
  }
};

/** Upstream error object embedded in a 200 response (OpenRouter surfaces some failures this way). */
const embeddedError = (error: { code?: unknown; message?: unknown }): ImageHttpError => {
  const code = Number(error?.code);
  return new ImageHttpError(Number.isFinite(code) && code >= 100 ? code : NaN, String(error?.message || 'Image provider error'));
};

const parseRetryAfterMs = (value: string | null): number | undefined => {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
};

type ErrorBody = {
  error?: { message?: unknown; metadata?: { raw?: unknown; provider_name?: unknown; is_byok?: unknown; error_type?: unknown } } | string;
  message?: unknown;
};

const readErrorMessage = (bodyText: string): string => {
  try {
    const parsed = JSON.parse(bodyText) as ErrorBody;
    const err = parsed?.error;
    if (typeof err === 'string') return err;
    // `raw` is the upstream provider's own body: a string, or an object we keep as JSON.
    const raw = err?.metadata?.raw;
    const rawText = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? JSON.stringify(raw) : '';
    const parts = [err?.message, rawText, parsed?.message].filter((p) => typeof p === 'string' && p) as string[];
    if (parts.length) return parts.join(' — ');
  } catch {
    /* not JSON */
  }
  return bodyText;
};

/** Provider / BYOK / error-type fields from an OpenRouter error body (see ProviderErrorMeta). */
const readErrorMeta = (bodyText: string): ProviderErrorMeta | undefined => {
  try {
    const err = (JSON.parse(bodyText) as ErrorBody)?.error;
    const meta = err && typeof err === 'object' ? err.metadata : undefined;
    if (!meta || typeof meta !== 'object') return undefined;
    const out: ProviderErrorMeta = {};
    if (typeof meta.provider_name === 'string' && meta.provider_name) out.providerName = meta.provider_name.slice(0, 60);
    if (typeof meta.is_byok === 'boolean') out.isByok = meta.is_byok;
    if (typeof meta.error_type === 'string' && meta.error_type) out.errorType = meta.error_type.slice(0, 60);
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
};

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('')
      .trim();
  }
  return '';
};

/** OpenRouter names the upstream that served a call in the top-level `provider` field. */
const providerOf = (payload: unknown): string | undefined => {
  const p = (payload as { provider?: unknown })?.provider;
  return typeof p === 'string' && p ? p.replace(/[^\w .()/-]/g, '').slice(0, 60) || undefined : undefined;
};

const costOf = (payload: unknown): number | undefined => {
  const cost = (payload as { usage?: { cost?: unknown } })?.usage?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
};

/** Max bytes accepted when an upstream returns an image URL instead of inline data. */
const MAX_REMOTE_IMAGE_BYTES = 40 * 1024 * 1024;

// ── Module state ─────────────────────────────────────────────────────────────

/** Models whose /images endpoint answered 404/405 recently → go straight to chat. */
const imagesApiUnavailableUntil = new Map<string, number>();
const IMAGES_API_RECHECK_MS = 15 * 60_000;

/**
 * Route+model+key → time until which the provider asked us to back off (429). Parallel
 * jobs of one run share a key, so the first 429 makes the others wait instead of each
 * burning its retries in the same second. Keyed by a hash, never the key itself.
 */
const rateLimitedUntil = new Map<string, number>();
const MAX_COOLDOWN_WAIT_MS = 20_000;
const cooldownKey = (picked: PickedImageRoute): string =>
  `${picked.route}|${picked.model}|${createHash('sha256').update(picked.key.key).digest('hex').slice(0, 16)}`;

/** Test hook. */
export const __resetImageClientForTests = (): void => {
  imagesApiUnavailableUntil.clear();
  rateLimitedUntil.clear();
  endpointCache.clear();
};

// ── Images-API transport (models.md §2.4 R3.4, §3.4 item 8) ─────────────────

/** OpenRouter's Images API for this model (registry `api.openrouter === 'images'`); everything else keeps today's path. */
export const usesImagesApi = (spec: ImageModelSpec): boolean => spec.api?.openrouter === 'images';

const ENDPOINTS_TTL_MS = 6 * 60 * 60_000;
const ENDPOINTS_RETRY_MS = 5 * 60_000;
const ENDPOINTS_TIMEOUT_MS = 4_000;
const endpointCache = new Map<string, { at: number; value: OrImageEndpoint[] | null }>();

/** Key-less, cached read of OpenRouter's public endpoint list for an Images-API model (never sends a key). */
const defaultImageEndpoints = async (openrouterModelId: string): Promise<OrImageEndpoint[] | null> => {
  const cached = endpointCache.get(openrouterModelId);
  const at = Date.now();
  if (cached && at - cached.at < (cached.value ? ENDPOINTS_TTL_MS : ENDPOINTS_RETRY_MS)) return cached.value;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENDPOINTS_TIMEOUT_MS);
  try {
    const id = openrouterModelId.split('/').map((p) => encodeURIComponent(p)).join('/');
    const res = await fetch(`${OPENROUTER_BASE_URL}/images/models/${id}/endpoints`, { method: 'GET', signal: controller.signal });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const body = (await res.json()) as { endpoints?: unknown; data?: { endpoints?: unknown } };
    const raw = Array.isArray(body?.endpoints) ? body.endpoints : body?.data?.endpoints;
    const value = Array.isArray(raw) ? (raw.filter((e) => e && typeof e === 'object') as OrImageEndpoint[]) : null;
    endpointCache.set(openrouterModelId, { at, value });
    return value;
  } catch (err) {
    logger.warn('comic_image_endpoints_unavailable', { model: openrouterModelId, message: String((err as Error)?.message || err).slice(0, 80) });
    endpointCache.set(openrouterModelId, { at, value: cached?.value ?? null });
    return cached?.value ?? null;
  } finally {
    clearTimeout(timer);
  }
};

const firstNumber = (...values: unknown[]): number | undefined => {
  for (const v of values) if (typeof v === 'number' && Number.isFinite(v) && v > 0) return Math.floor(v);
  return undefined;
};

/** OpenRouter's `input_references` cap as an endpoint or model lists it (tolerant of the documented shapes). */
export const openRouterReferenceCap = (params: Record<string, unknown> | undefined): number | undefined => {
  const p = params?.input_references as Record<string, unknown> | number | undefined;
  if (typeof p === 'number') return firstNumber(p);
  if (!p || typeof p !== 'object') return undefined;
  return firstNumber(p.max, p.max_items, p.maxItems, p.maximum, (p.items as Record<string, unknown> | undefined)?.max);
};

/** Resolutions an endpoint serves (its `resolution` enum); empty when it takes no resolution parameter. */
const endpointResolutionsOf = (ep: OrImageEndpoint): Resolution[] => {
  const values = (ep.supported_parameters?.resolution as { values?: unknown[] } | undefined)?.values;
  return Array.isArray(values) ? values.map(variantToResolution).filter((r): r is Resolution => !!r) : [];
};

/** How `provider.only` names an endpoint: its tag (e.g. google-vertex/us) when it has one, else its slug or name. */
const endpointRef = (ep: OrImageEndpoint): string | undefined => {
  const ref = ep.provider_tag || ep.provider_slug || ep.provider_name;
  return typeof ref === 'string' && ref ? ref.slice(0, 80) : undefined;
};

export interface ImagesApiPlan {
  /** Endpoints allowed to serve the call (absent = no endpoint data, so no restriction could be justified). */
  only?: string[];
  /**
   * Endpoint data exists but no endpoint both lists the resolution and costs no more than the quote: make NO call
   * (sending it unpinned could be served dearer than the quote). The §3.6 H reason, user-safe.
   */
  refuse?: string;
  /** The resolution to send (only if an allowed endpoint lists it). */
  resolution?: Resolution;
  /** min(OpenRouter's input_references cap, the vendor cap). */
  referenceCap: number;
}

/**
 * models.md §2.4 R3.4: the same model may fail over between ITS endpoints (`allow_fallbacks: true`, the model fixed),
 * but only to endpoints that list the requested resolution and cost no more than the quote; `resolution` is sent only
 * when such an endpoint lists it; references are capped at the lower of OpenRouter's and the vendor's limits. Pure.
 */
export const planImagesApi = (spec: ImageModelSpec, endpoints: OrImageEndpoint[] | null, want: Resolution | undefined, quoteUsd: number | undefined): ImagesApiPlan => {
  const vendorCap = Math.max(0, spec.refs.total);
  if (!endpoints?.length) return { ...(want ? { resolution: want } : {}), referenceCap: vendorCap };
  const res: Resolution = want ?? '1K';
  const serving = endpoints.filter((ep) => {
    const served = endpointResolutionsOf(ep);
    return !want || !served.length || served.includes(want);
  });
  const ceiling = typeof quoteUsd === 'number' && Number.isFinite(quoteUsd) && quoteUsd > 0 ? quoteUsd : imagePriceUsd(spec, res);
  const affordable = serving.filter((ep) => {
    const usd = mapEndpointPricing({ modelId: spec.routes.openrouter || spec.id, endpoints: [ep], spec }).price[res]?.usd;
    return typeof usd === 'number' && Number.isFinite(usd) && usd <= ceiling + 1e-9;
  });
  const allowed = affordable.filter((ep) => !!endpointRef(ep));
  const only = [...new Set(allowed.map(endpointRef).filter((r): r is string => !!r))];
  const caps = (allowed.length ? allowed : endpoints).map((ep) => openRouterReferenceCap(ep.supported_parameters)).filter((n): n is number => typeof n === 'number');
  const orCap = caps.length ? Math.min(...caps) : undefined;
  const referenceCap = orCap !== undefined ? Math.min(orCap, vendorCap) : vendorCap;
  if (!only.length) {
    const refuse = !serving.length && want ? `no provider serves ${want} for it` : `no provider serves ${want ?? 'it'} at the quoted price`;
    return { refuse, referenceCap };
  }
  const listsWant = !!want && allowed.some((ep) => endpointResolutionsOf(ep).includes(want));
  return { only, ...(want && listsWant ? { resolution: want } : {}), referenceCap };
};

// ── Factory ──────────────────────────────────────────────────────────────────

export function createImageGenerator(keys: StudioKeys, deps: ImageClientDeps = {}): ImageGenerator {
  const doFetch = deps.fetch || ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const createGemini = deps.createGemini || defaultCreateGemini;
  const sleep = deps.sleep || defaultSleep;
  const now = deps.now || (() => Date.now());
  const imageEndpoints = deps.imageEndpoints || defaultImageEndpoints;
  // Resolved per call, so a swapped process-wide port (tests) is the one used.
  const health = (): NonNullable<ImageClientDeps['health']> => deps.health || { acquireRouteCall, recordImageOutcome, routeState };
  /** Every provider answer is recorded (it also releases a half-open probe); recording never fails a call. */
  const record = (outcome: Parameters<typeof recordImageOutcome>[0]) => {
    try {
      health().recordImageOutcome(outcome);
    } catch (err) {
      logger.warn('comic_image_health_record_failed', { message: String((err as Error)?.message || err).slice(0, 120) });
    }
  };

  const openRouterHeaders = (key: ResolvedKey): Record<string, string> => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key.key}`,
    'HTTP-Referer': OPENROUTER_APP_URL,
    'X-Title': OPENROUTER_APP_TITLE
  });

  /** `json` is set when ok; `message`/`retryAfterMs` describe a non-2xx answer. */
  interface OpenRouterResponse {
    ok: boolean;
    status: number;
    json?: any;
    message?: string;
    retryAfterMs?: number;
    meta?: ProviderErrorMeta;
  }

  /** POST JSON to OpenRouter. Non-2xx answers come back as data so 404/405 can be handled. */
  const postOpenRouter = async (
    path: string,
    body: Record<string, unknown>,
    key: ResolvedKey,
    signal: AbortSignal
  ): Promise<OpenRouterResponse> => {
    const res = await doFetch(`${OPENROUTER_BASE_URL}${path}`, {
      method: 'POST',
      headers: openRouterHeaders(key),
      body: JSON.stringify(body),
      signal
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        message: readErrorMessage(text).slice(0, 600),
        retryAfterMs: parseRetryAfterMs(res.headers?.get?.('retry-after') ?? null),
        meta: readErrorMeta(text)
      };
    }
    return { ok: true, status: res.status, json: await res.json() };
  };

  const throwHttp = (res: OpenRouterResponse, key: ResolvedKey, path: string): never => {
    const message = `OpenRouter ${path} ${res.status}: ${res.message || ''}`;
    // Same circuit the text provider trips: a capped PLATFORM key should stop chat from
    // hammering it too. A BYOK key's limits never affect anyone else.
    if (!key.byok && isCapacityError(res.status, message)) markSharedKeyCapped();
    throw new ImageHttpError(res.status, message, res.retryAfterMs, res.meta);
  };

  /** Image URL → data URL (some providers return hosted URLs). */
  // The image was generated and billed (a 200 with usage/cost) — if DOWNLOADING or decoding
  // it then fails, the money is already spent, so tag the thrown error with `spentUsd` from
  // the response so the job runner records it instead of silently dropping the charge.
  const downloadPaid = async (download: () => Promise<string>, json: unknown): Promise<string> => {
    try {
      return await download();
    } catch (err) {
      const cost = costOf(json);
      if (typeof cost === 'number' && cost > 0) (err as { spentUsd?: number }).spentUsd = cost;
      throw err;
    }
  };

  const toDataUrl = async (url: string, signal: AbortSignal): Promise<string> => {
    if (url.startsWith('data:')) return url;
    const res = await doFetch(url, { signal });
    if (!res.ok) throw new ImageDownloadError(res.status, `Image download ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (!buffer.byteLength || buffer.byteLength > MAX_REMOTE_IMAGE_BYTES) throw new ImageHttpError(502, 'Image download had an invalid size');
    const type = (res.headers?.get?.('content-type') || 'image/png').split(';')[0].trim() || 'image/png';
    return `data:${type};base64,${buffer.toString('base64')}`;
  };

  const openRouterImagesApi = async (
    picked: PickedImageRoute,
    req: ImageRequestPlus,
    prepared: PreparedImageRequest,
    prompt: string
  ): Promise<AttemptResult | 'unavailable'> => {
    // models.md §3.4 item 8: an Images-API model gets the model FIXED (never a `models` list), its pinned quality,
    // `provider.allow_fallbacks: true` between ITS endpoints, limited by `provider.only` to the endpoints that list
    // the resolution and cost no more than the quote, and references capped at min(OpenRouter, vendor).
    const pinned = usesImagesApi(req.spec);
    const plan = pinned ? planImagesApi(req.spec, await imageEndpoints(picked.model).catch(() => null), prepared.resolution, req.maxUsd) : null;
    // No endpoint serves it within the quote: no call at all (never drawn above the quote, never another model).
    if (plan?.refuse) {
      logger.warn('comic_image_images_api_refused', { model: picked.model, resolution: prepared.resolution, reason: plan.refuse });
      throw modelUnavailableError(picked.route, req.spec.nickname, plan.refuse);
    }
    const references = plan ? prepared.references.slice(0, plan.referenceCap) : prepared.references;
    const resolution = plan ? plan.resolution : prepared.resolution;
    const body = stripUnsupported(
      {
        model: picked.model,
        prompt,
        aspect_ratio: prepared.aspect,
        ...(resolution ? { resolution } : {}),
        n: 1,
        ...(references.length ? { input_references: references.map((ref) => ({ type: 'image_url', image_url: { url: ref.dataUrl } })) } : {}),
        ...(pinned && req.spec.fixedQuality ? { quality: req.spec.fixedQuality } : {}),
        ...(pinned ? { provider: { allow_fallbacks: true, ...(plan?.only?.length ? { only: plan.only } : {}) } } : {})
      },
      req.spec.unsupported
    );
    return withDeadline(req.signal, req.spec.timeoutMs, async (signal) => {
      const res = await postOpenRouter('/images', body, picked.key, signal);
      if (!res.ok && (res.status === 404 || res.status === 405)) {
        imagesApiUnavailableUntil.set(picked.model, now() + IMAGES_API_RECHECK_MS);
        logger.warn('comic_image_images_api_unavailable', { model: picked.model, status: res.status });
        return 'unavailable' as const;
      }
      if (!res.ok) return throwHttp(res, picked.key, '/images');
      const json = res.json;
      if (json?.error) throw embeddedError(json.error);
      const item = Array.isArray(json?.data) ? json.data[0] : undefined;
      const finish = item?.native_finish_reason || item?.finish_reason || json?.finish_reason;
      const mediaType = String(item?.media_type || json?.media_type || 'image/png');
      let dataUrl: string | undefined;
      if (typeof item?.b64_json === 'string' && item.b64_json) dataUrl = `data:${mediaType};base64,${item.b64_json}`;
      else if (typeof item?.url === 'string' && item.url) dataUrl = await downloadPaid(() => toDataUrl(item.url as string, signal), json);
      return {
        dataUrl,
        model: typeof json?.model === 'string' ? json.model : undefined,
        provider: providerOf(json),
        costUsd: costOf(json),
        blocked: !dataUrl && isSafetyFinish(finish),
        blockReason: typeof finish === 'string' ? finish : undefined
      };
    });
  };

  const openRouterChat = async (
    picked: PickedImageRoute,
    req: ImageRequest,
    prepared: PreparedImageRequest,
    prompt: string
  ): Promise<AttemptResult> => {
    const imageConfig: Record<string, unknown> = { aspect_ratio: prepared.aspect };
    if (prepared.resolution) imageConfig.image_size = prepared.resolution;
    const body = stripUnsupported(
      {
        model: picked.model,
        modalities: ['image', 'text'],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              ...prepared.references.map((ref) => ({ type: 'image_url', image_url: { url: ref.dataUrl } }))
            ]
          }
        ],
        image_config: imageConfig,
        usage: { include: true }
      },
      req.spec.unsupported
    );
    return withDeadline(req.signal, req.spec.timeoutMs, async (signal) => {
      const res = await postOpenRouter('/chat/completions', body, picked.key, signal);
      if (!res.ok) return throwHttp(res, picked.key, '/chat/completions');
      const json = res.json;
      if (json?.error) throw embeddedError(json.error);
      const choice = json?.choices?.[0];
      if (choice?.error) throw embeddedError(choice.error);
      const message = choice?.message;
      const images: unknown[] = Array.isArray(message?.images) ? message.images : [];
      const first = images
        .map((img) => (img as { image_url?: { url?: unknown }; url?: unknown })?.image_url?.url ?? (img as { url?: unknown })?.url)
        .find((url): url is string => typeof url === 'string' && url.length > 0);
      const finish = choice?.native_finish_reason || choice?.finish_reason;
      const dataUrl = first ? await downloadPaid(() => toDataUrl(first, signal), json) : undefined;
      return {
        dataUrl,
        text: textOf(message?.content) || undefined,
        model: typeof json?.model === 'string' ? json.model : undefined,
        provider: providerOf(json),
        costUsd: costOf(json),
        blocked: !dataUrl && isSafetyFinish(finish),
        blockReason: typeof finish === 'string' ? finish : undefined
      };
    });
  };

  const openRouterAttempt = async (
    picked: PickedImageRoute,
    req: ImageRequestPlus,
    prepared: PreparedImageRequest,
    prompt: string
  ): Promise<AttemptResult> => {
    const skipUntil = imagesApiUnavailableUntil.get(picked.model) || 0;
    if (skipUntil <= now()) {
      const result = await openRouterImagesApi(picked, req, prepared, prompt);
      if (result !== 'unavailable') return result;
    }
    // An Images-API model never goes to chat: that path has no quality pin and no provider pin (§3.4 item 8).
    if (usesImagesApi(req.spec)) throw modelUnavailableError(picked.route, req.spec.nickname, IMAGES_API_GONE_REASON, 404);
    return openRouterChat(picked, req, prepared, prompt);
  };

  const geminiAttempt = async (
    picked: PickedImageRoute,
    req: ImageRequest,
    prepared: PreparedImageRequest,
    prompt: string
  ): Promise<AttemptResult> => {
    const parts: Record<string, unknown>[] = [{ text: prompt }];
    prepared.references.forEach((ref, i) => {
      const parsed = parseDataUrl(ref.dataUrl);
      if (!parsed) {
        throw new StudioError('BAD_REQUEST', `Reference image ${i + 1} (${ref.label}) must be inline image data.`, { status: 400 });
      }
      parts.push({ text: `Image ${i + 1}: ${ref.label}` });
      parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.data } });
    });
    const imageConfig: Record<string, unknown> = { aspectRatio: prepared.aspect };
    if (prepared.resolution) imageConfig.imageSize = prepared.resolution;
    const config = stripUnsupported({ responseModalities: ['IMAGE', 'TEXT'], imageConfig }, req.spec.unsupported);
    const models = createGemini(picked.key.key);

    const response = (await withDeadline(req.signal, req.spec.timeoutMs, (signal) =>
      models.generateContent({
        model: picked.model,
        contents: [{ role: 'user', parts }],
        config: { ...config, abortSignal: signal }
      })
    )) as {
      candidates?: { content?: { parts?: { text?: unknown; inlineData?: { data?: unknown; mimeType?: unknown }; thought?: unknown }[] }; finishReason?: unknown; finishMessage?: unknown }[];
      promptFeedback?: { blockReason?: unknown };
      modelVersion?: unknown;
    };

    const blockReason = response?.promptFeedback?.blockReason;
    const candidate = response?.candidates?.[0];
    const candidateParts = Array.isArray(candidate?.content?.parts) ? candidate!.content!.parts! : [];
    const imagePart = candidateParts.find((p) => typeof p?.inlineData?.data === 'string' && (p.inlineData.data as string).length > 0);
    const text = candidateParts
      .filter((p) => typeof p?.text === 'string' && !p?.thought)
      .map((p) => p.text as string)
      .join(' ')
      .trim();
    const dataUrl = imagePart
      ? `data:${typeof imagePart.inlineData!.mimeType === 'string' ? imagePart.inlineData!.mimeType : 'image/png'};base64,${imagePart.inlineData!.data}`
      : undefined;
    const finish = candidate?.finishReason;
    return {
      dataUrl,
      text: text || undefined,
      model: typeof response?.modelVersion === 'string' ? response.modelVersion : undefined,
      blocked: !dataUrl && (Boolean(blockReason) || isSafetyFinish(finish)),
      blockReason: String(blockReason || finish || '') || undefined
    };
  };

  /** Wait out a cooldown another job set on this route+model+key (bounded, abortable). */
  const waitForCooldown = async (picked: PickedImageRoute, signal?: AbortSignal): Promise<void> => {
    const wait = Math.min(MAX_COOLDOWN_WAIT_MS, (rateLimitedUntil.get(cooldownKey(picked)) || 0) - now());
    if (wait <= 0) return;
    logger.warn('comic_image_cooldown_wait', { route: picked.route, model: picked.model, ms: wait });
    try {
      await sleep(wait, signal);
    } catch {
      throw cancelled();
    }
  };

  /** One image on one route: transient retry, text-only nudge, honest classification. */
  const runOnRoute = async (picked: PickedImageRoute, req: ImageRequestPlus, prepared: PreparedImageRequest): Promise<ImageResultPlus> => {
    await waitForCooldown(picked, req.signal);
    const errCtx = { route: picked.route, byok: picked.key.byok, model: req.spec.nickname };
    const started = now();
    let prompt = req.prompt;
    let transientRetries = 1;
    let nudgeRetries = 1;
    let spent: number | undefined;
    let lastText: string | undefined;

    const fail = (error: StudioError): never => {
      // Money already spent on failed attempts is reported so the caller can record it.
      if (spent !== undefined) (error as StudioError & { spentUsd?: number }).spentUsd = spent;
      logger.warn('comic_image_failed', {
        route: picked.route,
        model: picked.model,
        code: error.code,
        ms: now() - started,
        detail: String(((error as { cause?: Error }).cause as Error | undefined)?.message || error.message).slice(0, 300)
      });
      throw error;
    };

    for (;;) {
      // reliability.md §2: ask the breaker before EVERY provider attempt (each retry and nudge too). A refused
      // attempt makes no call and costs nothing; the caller may still try the same model on a same-payer route.
      if (!health().acquireRouteCall(picked.route, picked.model).allowed) {
        const paused = routePausedError({ route: picked.route, model: picked.model, nickname: req.spec.nickname, reason: health().routeState(picked.route, picked.model).reason });
        if (spent) {
          paused.spentUsd = spent;
          // The refused retry sent nothing, but an earlier attempt on this route was paid: never say "nothing was charged".
          const text = `The image provider is busy with ${req.spec.nickname} on ${ROUTE_LABEL[picked.route]} right now, so the retry wasn't sent. The earlier attempt was charged.`;
          Object.assign(paused, { message: text, userMessage: text });
        }
        logger.warn('comic_image_route_paused', { route: picked.route, model: picked.model });
        throw paused;
      }
      let attempt: AttemptResult;
      try {
        attempt =
          picked.route === 'openrouter'
            ? await openRouterAttempt(picked, req, prepared, prompt)
            : await geminiAttempt(picked, req, prepared, prompt);
      } catch (err) {
        const error = classifyImageError(err, errCtx);
        // Carry forward money already spent on this attempt (e.g. a paid 200 whose image
        // failed to download) so a retry or the final failure still bills it.
        const priorSpend = (err as { spentUsd?: unknown })?.spentUsd;
        if (typeof priorSpend === 'number' && Number.isFinite(priorSpend) && priorSpend > 0) spent = (spent || 0) + priorSpend;
        if (error.code === 'CANCELLED') {
          if (spent) (error as { spentUsd?: number }).spentUsd = spent;
          throw error;
        }
        const transient = error.code === 'RATE_LIMIT' || (error.code === 'PROVIDER_ERROR' && error.retryable);
        const hinted = err instanceof ImageHttpError ? err.retryAfterMs : undefined;
        // Facts the job runner keeps (re-queue after Retry-After; a sanitized "who refused" line).
        if (!imageFailureInfo(error)) {
          const failure: ImageFailureInfo = { route: picked.route };
          const status = err instanceof ImageHttpError ? err.status : Number((err as { status?: unknown })?.status);
          if (Number.isFinite(status) && status > 0) failure.status = status;
          const meta = err instanceof ImageHttpError ? err.meta : undefined;
          if (meta?.providerName) failure.providerName = meta.providerName;
          if (meta?.isByok !== undefined) failure.isByok = meta.isByok;
          if (hinted !== undefined) failure.retryAfterMs = hinted;
          Object.assign(error, { imageFailure: failure });
        }
        // A 404 on the model call itself (not on downloading a picture) = the provider no longer serves it (§3.6 H).
        const answered = err instanceof ImageHttpError ? err.status : Number((err as { status?: unknown })?.status);
        if (answered === 404 && !(err instanceof ImageDownloadError) && !modelUnavailableReason(error)) Object.assign(error, { modelUnavailable: MODEL_GONE_REASON });
        // Every answer is recorded (key-scoped and our-side ones are not counted, but they release a probe).
        record(outcomeFromError(error, picked));
        if (error.code === 'RATE_LIMIT') {
          // Everyone on this route+model+key waits at least this long before their next call.
          const ck = cooldownKey(picked);
          const until = now() + Math.min(MAX_COOLDOWN_WAIT_MS, Math.max(4000, hinted ?? 4000));
          rateLimitedUntil.set(ck, Math.max(rateLimitedUntil.get(ck) || 0, until));
        }
        if (transient && transientRetries > 0 && !req.signal?.aborted) {
          transientRetries -= 1;
          const cooling = (rateLimitedUntil.get(cooldownKey(picked)) || 0) - now();
          const delay =
            error.code === 'RATE_LIMIT' ? Math.min(MAX_COOLDOWN_WAIT_MS, Math.max(4000, hinted ?? 4000, cooling)) : 2000;
          logger.warn('comic_image_retry', { route: picked.route, model: picked.model, code: error.code, delay });
          try {
            await sleep(delay, req.signal);
          } catch {
            throw cancelled();
          }
          continue;
        }
        return fail(error);
      }

      // The route answered (with or without a picture): the serving path works.
      record({ route: picked.route, model: picked.model, ok: true });
      if (typeof attempt.costUsd === 'number') spent = (spent || 0) + attempt.costUsd;
      if (attempt.dataUrl) {
        const out: ImageResultPlus = {
          dataUrl: attempt.dataUrl,
          model: picked.model,
          route: picked.route,
          byok: picked.key.byok,
          costUsd: spent,
          text: attempt.text || lastText,
          latencyMs: Math.max(0, now() - started),
          ...(attempt.provider ? { providerName: attempt.provider } : {}),
          ...(attempt.model ? { modelVersion: attempt.model.slice(0, 160) } : {})
        };
        return out;
      }
      // A structured block (finish reason / prompt feedback) is final — retrying the same
      // prompt would just pay for the same refusal.
      if (attempt.blocked) return fail(safetyBlocked(new Error(`blocked: ${attempt.blockReason || 'safety'}`)));
      lastText = attempt.text || lastText;
      if (nudgeRetries > 0 && !req.signal?.aborted) {
        nudgeRetries -= 1;
        prompt = `${req.prompt}\n\nGenerate the image now.`;
        logger.warn('comic_image_text_only_retry', { route: picked.route, model: picked.model, text: (attempt.text || '').slice(0, 160) });
        continue;
      }
      // Twice without a picture. A written refusal ("I can't create images of …") is a
      // safety block the user can act on; anything else is an honest "no image".
      if (attempt.text && looksLikeRefusal(attempt.text)) {
        return fail(safetyBlocked(new Error(`refusal: ${attempt.text.slice(0, 200)}`)));
      }
      return fail(noImage(new Error(`no image; text=${(attempt.text || '').slice(0, 200)}`)));
    }
  };

  return async (input: ImageRequest): Promise<ImageResult> => {
    const req = input as ImageRequestPlus;
    const primary = pickImageRoute(req.spec, keys);
    const prepared = prepareImageRequest(req);
    // The SAME model on the other route, only with a key of the same payer (never another model, never another payer).
    const sibling = pickAlternateRoute(req.spec, keys, primary);
    // Start on the sibling when the preflight said so, or when the breaker has the primary down and the sibling not.
    const startOnSibling =
      !!sibling &&
      (req.preferRoute === sibling.route ||
        (health().routeState(primary.route, primary.model).state === 'down' && health().routeState(sibling.route, sibling.model).state !== 'down'));
    const picked = startOnSibling ? sibling! : primary;
    const fallback = startOnSibling ? primary : sibling;
    if (prepared.droppedReferences) {
      logger.warn('comic_image_references_capped', {
        model: picked.model,
        cap: req.spec.refs.total,
        dropped: prepared.droppedReferences
      });
    }
    if (req.signal?.aborted) throw cancelled();

    try {
      return await runOnRoute(picked, req, prepared);
    } catch (err) {
      // Same model, other route: only for capacity/outage failures (a safety block, a bad
      // key or our own deadline would fail — or bill — the same way there), and only when
      // the other route draws on the same payer.
      const error = err as StudioError & { spentUsd?: number; abandoned?: boolean };
      const fallbackable =
        err instanceof StudioError &&
        !error.abandoned &&
        (error.code === 'RATE_LIMIT' || (error.code === 'PROVIDER_ERROR' && (error.retryable || isRoutePausedError(err))));
      const alt = fallbackable && !req.signal?.aborted ? fallback : null;
      if (!alt) throw err;
      logger.warn('comic_image_route_fallback', { from: picked.route, to: alt.route, model: req.spec.id, code: error.code });
      const primarySpent = typeof error.spentUsd === 'number' && error.spentUsd > 0 ? error.spentUsd : 0;
      try {
        const result = await runOnRoute(alt, req, prepared);
        return primarySpent ? { ...result, costUsd: (result.costUsd || 0) + primarySpent } : result;
      } catch (altErr) {
        // Report the preferred route's failure (what the user's setup said), and carry any
        // money spent on either route so the job still bills it.
        const altSpent = (altErr as { spentUsd?: unknown })?.spentUsd;
        const total = primarySpent + (typeof altSpent === 'number' && altSpent > 0 ? altSpent : 0);
        logger.warn('comic_image_route_fallback_failed', {
          to: alt.route,
          model: req.spec.id,
          code: (altErr as StudioError)?.code
        });
        // The first route was only paused (no call was made): the answer the user needs is the one the other route gave.
        const reported = isRoutePausedError(err) && altErr instanceof StudioError ? (altErr as StudioError & { spentUsd?: number }) : error;
        if (total > 0) reported.spentUsd = total;
        throw reported;
      }
    }
  };
}
