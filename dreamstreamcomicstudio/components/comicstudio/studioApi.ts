// HTTP + SSE client for Comic Studio (v4) — `/api/comic/*` (server/src/routes/comic.ts).
//
// Every call goes through services/apiClient (auth token, BYOK provider keys, source
// governance headers), and every failure surfaces as a StudioApiError whose `message`
// is safe to show the user verbatim. The stream reader adds what a long-lived studio
// stream needs on top of readSSEStream: tolerant event parsing (unknown/malformed events
// are skipped), a 45 s idle watchdog (any byte — including the server's 15 s keep-alive
// comments — resets it), early-close detection, and caller cancellation.

import { del, get, patch as apiPatch, post, postStream } from '../../services/apiClient';
import { buildApiUrl } from '../../services/clientConfig';
import { readSSEStream } from '../../services/sse';
import { REDRAW_SCOPES, normalizeDoc, type ComicDoc, type QualityTier, type RedrawScope, type RefAsset, type RefLabel, type RefOwner, type RenderTarget } from '../../shared/comic/doc';
import { STREAM_EVENT_NAMES, type StreamRequest, type StudioEvent } from '../../shared/comic/events';
import { getImageModel, type ImageModelSpec, type TierPreset } from '../../shared/comic/models';
import type { DocOp, StudioAction } from '../../shared/comic/ops';
import type { StudioActOutcome } from './types';
import { DEFAULT_CAPS, sanitizeStudioUsage, type StudioCaps } from '../../shared/comic/capabilities';
import { anchorKindsOf } from '../../shared/comic/anchors';
import { MAX_ALTERNATIVES } from '../../shared/comic/limits';
import { CONTENT_RATINGS, type ContentRating } from '../../shared/comic/safety';
import { refOwnerKey } from '../../shared/comic/refs';
import type { LibraryIndex, LibraryKind, LibraryQuote, LibraryRunView } from '../../shared/comic/library';
import { SLUG_RE } from '../../shared/comic/publication';
import type { VersionRow } from '../../shared/comic/history/types';
import type {
  PublicComicPayload,
  PublicPublicationInfo,
  ReaderLanguage,
  PublicationOwnerView,
  PublicationSettingsPatch,
  PublishRequest,
  ShareChannel
} from '../../shared/comic/publication';

/** No bytes for this long (the server heartbeats every 15 s) ⇒ the connection is dead. */
export const STREAM_IDLE_TIMEOUT_MS = 45_000;
/** Paths per /urls request. */
const SIGN_BATCH = 100;

// ── Errors ───────────────────────────────────────────────────────────────────

export type StudioApiErrorKind =
  | 'billing'
  | 'auth'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'bad_request'
  | 'rate_limit'
  | 'network'
  | 'connection_lost'
  | 'server'
  | 'not_available'
  | 'aborted'
  // v5 server codes (contract §12.9): each maps to calm, honest copy.
  /** 422 CONTENT_POLICY / SAFETY_BLOCKED: past this comic's rating — nothing was changed. */
  | 'content_policy'
  /** 429 COOLDOWN: a short safety break on new drawings and uploads (reading/editing still work). */
  | 'cooldown'
  /** 409 LIMIT: a count limit (refs, pages, editions, doc size). */
  | 'limit'
  /** 422 NOT_READY / LANG_INCOMPLETE: something has to be finished first. */
  | 'not_ready';

export class StudioApiError extends Error {
  readonly kind: StudioApiErrorKind;
  /** HTTP status (0 = never reached the server). */
  readonly status: number;
  /** Whether "Try again" is a sensible next step. */
  readonly retryable: boolean;
  /** Raw server/transport message, for logs. Never shown to the user. */
  readonly detail?: string;
  /** Server error code (`CONTENT_POLICY`, `COOLDOWN`, `LIMIT`, `NOT_READY`, …) when it sent one. */
  readonly code?: string;

  constructor(kind: StudioApiErrorKind, message: string, opts: { status?: number; retryable?: boolean; detail?: string; code?: string } = {}) {
    super(message);
    this.name = 'StudioApiError';
    this.kind = kind;
    this.status = opts.status ?? 0;
    this.retryable = opts.retryable ?? false;
    if (opts.detail) this.detail = opts.detail;
    if (opts.code) this.code = opts.code;
  }
}

export const isAbortError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; kind?: string };
  return e.name === 'AbortError' || e.kind === 'aborted';
};

const abortError = () => new StudioApiError('aborted', 'Cancelled.');

const connectionLost = () =>
  new StudioApiError('connection_lost', 'Connection lost — the studio stopped responding. Resyncing your comic…', {
    retryable: true
  });

interface ErrorLike {
  status?: unknown;
  message?: unknown;
  name?: unknown;
  code?: unknown;
  details?: unknown;
}

/** Bare HTTP status texts apiClient falls back to when the body had no message. */
const STATUS_TEXT_RE =
  /^(bad request|unauthorized|payment required|forbidden|not found|conflict|unprocessable (entity|content)|too many requests|internal server error|not implemented|bad gateway|service unavailable|gateway timeout)$/i;
/** Text that reads like a stack, a driver/transport error or markup — never shown to a user. */
const TECHNICAL_RE =
  /(\b(TypeError|ReferenceError|SyntaxError|RangeError|AbortError|DOMException|Exception|ECONN[A-Z]+|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|fetch failed|Failed to fetch|NetworkError|Load failed|status code|Unexpected token|violates|constraint|stack trace|undefined|NaN|postgres|PGRST\w*|supabase|jwt|bearer|is not a function|is not defined|Cannot read propert(y|ies)|JSON)\b|\bError:|<\/?[a-z!][^>]*>|[{}]|\n\s+at\s)/i;

/**
 * True when a server message is calm, human copy the studio may show verbatim (the studio
 * routes send user-safe `userMessage`s). Bare codes, status texts, stack-ish or driver text,
 * markup and very long strings are not — the caller shows its own copy instead.
 */
export const isFriendlyMessage = (text: unknown): text is string => {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 4 || t.length > 280) return false;
  if (/^[A-Z0-9_.:-]+$/.test(t)) return false; // a bare code ("NOT_AVAILABLE")
  if (STATUS_TEXT_RE.test(t)) return false;
  return !TECHNICAL_RE.test(t);
};

const CODE_RE = /^[A-Z][A-Z0-9_]{1,40}$/;

/** The server's error code: apiClient keeps the JSON body in `details` (`{error:{message, code}}`). */
export const errorCodeOf = (err: unknown): string | undefined => {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as ErrorLike;
  const pick = (v: unknown) => (typeof v === 'string' && CODE_RE.test(v) ? v : undefined);
  const details = e.details && typeof e.details === 'object' ? (e.details as { code?: unknown; error?: { code?: unknown } }) : undefined;
  return pick(e.code) ?? pick(details?.error?.code) ?? pick(details?.code);
};

interface CodeCopy {
  kind: StudioApiErrorKind;
  /** Calm fallback when the server's own text isn't fit to show. */
  message: string;
  retryable: boolean;
}

/**
 * Server codes → kind + honest fallback copy (contract §12.9). The server's text wins when it is
 * friendly (it is more specific: "Maya can hold 12 photos — remove one to add more.").
 */
export const STUDIO_ERROR_COPY: Readonly<Record<string, CodeCopy>> = {
  CONTENT_POLICY: {
    kind: 'content_policy',
    message: "That goes past what this comic allows, so nothing was changed. Try different wording — bold action and spooky moments are fine.",
    retryable: false
  },
  SAFETY_BLOCKED: {
    kind: 'content_policy',
    message: 'A page needs a safety fix before this can go ahead. Redraw it a little safer or remove it, then try again.',
    retryable: false
  },
  COOLDOWN: {
    kind: 'cooldown',
    message: "Let's take a short break from new drawings and uploads. You can keep reading and editing — it opens again in a few minutes.",
    retryable: true
  },
  LIMIT: {
    kind: 'limit',
    message: 'This comic is at its limit for that. Remove something first, then try again.',
    retryable: false
  },
  NOT_READY: {
    kind: 'not_ready',
    message: "That isn't ready yet — finish what it needs first, then try again.",
    retryable: false
  },
  LANG_INCOMPLETE: {
    kind: 'not_ready',
    message: "A language edition isn't finished yet. Review its translation, then try again.",
    retryable: false
  },
  RATE_LIMIT: {
    kind: 'rate_limit',
    message: 'Lots of requests at once — give it a few seconds and try again.',
    retryable: true
  },
  CONFLICT: {
    kind: 'conflict',
    message: "That's busy right now — try again once the current drawing finishes.",
    retryable: true
  },
  NOT_AVAILABLE: {
    kind: 'not_available',
    message: "That isn't available yet.",
    retryable: false
  },
  // Restricted accounts (contract §7, P1-ROUTES) — the server always sends its own calm text for those
  // ("Your account is limited right now, so …"), which wins. This is only the fallback for a FORBIDDEN
  // with no usable text, and FORBIDDEN also covers other 403s (not your comic, admins only, an origin
  // check), so it claims nothing about a review or moderation.
  FORBIDDEN: {
    kind: 'forbidden',
    message: "Your account can't do that right now. You can keep reading and editing your comic.",
    retryable: false
  }
};

/** The message to show for a coded server refusal (stream `error` events and HTTP errors). */
export const friendlyErrorMessage = (code: string | undefined, message: unknown, fallback = 'Something went wrong in the studio.'): string => {
  if (isFriendlyMessage(message)) return message.trim();
  const copy = code ? STUDIO_ERROR_COPY[code] : undefined;
  return copy ? copy.message : fallback;
};

/**
 * Map any thrown error (apiClient ApiError, fetch TypeError, our own) to a StudioApiError
 * with a friendly message. Server-provided messages are kept for 4xx answers (the studio
 * routes send user-safe text); transport and 5xx failures get our own wording.
 */
export const toStudioApiError = (err: unknown, context: 'project' | 'public' | 'generic' = 'generic'): StudioApiError => {
  if (err instanceof StudioApiError) return err;
  if (isAbortError(err)) return abortError();
  const e = (err && typeof err === 'object' ? err : {}) as ErrorLike;
  const status = typeof e.status === 'number' ? e.status : undefined;
  const raw = typeof e.message === 'string' ? e.message.trim() : '';
  // Only calm, human server text is ever shown; status texts, codes and stack-ish text are not.
  const serverSaid = isFriendlyMessage(raw) ? raw : '';
  const code = errorCodeOf(err);

  // A coded refusal (contract §12.9) maps by code; 401/404 keep their context-specific copy.
  const coded = code && status !== 401 && status !== 404 ? STUDIO_ERROR_COPY[code] : undefined;
  if (coded) {
    return new StudioApiError(coded.kind, serverSaid || coded.message, { status: status ?? 0, retryable: coded.retryable, detail: raw, code });
  }
  const withCode = code ? { code } : {};

  switch (status) {
    case undefined:
      // No HTTP status: a client/transport exception, never server copy — don't show its text.
      return new StudioApiError('network', 'Something went wrong talking to the studio. Try again in a moment.', { retryable: true, detail: raw });
    case 0:
      return new StudioApiError(
        'network',
        "Couldn't reach the studio server. It may be waking up — check your connection and try again in a moment.",
        { status: 0, retryable: true, detail: raw }
      );
    case 401:
      return new StudioApiError('auth', 'Your session expired — sign in again to keep working on this comic.', { status, detail: raw });
    case 402:
      return new StudioApiError(
        'billing',
        serverSaid || "You're out of studio credit for now. Top up, or connect your own Gemini or OpenRouter key in Settings → API keys.",
        { status, detail: raw, ...withCode }
      );
    case 403:
      return new StudioApiError('forbidden', serverSaid || "You don't have access to do that with this comic.", { status, detail: raw, ...withCode });
    case 404:
      return new StudioApiError(
        'not_found',
        context === 'public'
          ? "This comic isn't published, or its creator made it private."
          : context === 'project'
            ? "This comic doesn't exist or you don't have access to it."
            : serverSaid || "That wasn't found — it may have been deleted.",
        { status, detail: raw }
      );
    case 409:
      return new StudioApiError('conflict', serverSaid || 'That changed in the meantime — refresh and try again.', { status, retryable: true, detail: raw, ...withCode });
    case 429:
      return new StudioApiError('rate_limit', 'Too many requests in a short time. Give it a few seconds and try again.', {
        status,
        retryable: true,
        detail: raw
      });
    case 501:
      return new StudioApiError('not_available', serverSaid && !/not.?implemented|not_available/i.test(serverSaid) ? serverSaid : "That isn't available yet.", {
        status,
        detail: raw,
        ...withCode
      });
    default:
      if (status >= 500) {
        return new StudioApiError(
          'server',
          status === 502 || status === 503
            ? 'The studio server is starting up or briefly unavailable. Try again in a moment.'
            : 'The studio server hit a problem. Try again in a moment.',
          { status, retryable: true, detail: raw }
        );
      }
      return new StudioApiError('bad_request', serverSaid || "The studio couldn't do that — nothing was changed.", { status, detail: raw, ...withCode });
  }
};

// ── Response validation ──────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const asUrls = (v: unknown): Record<string, string> => {
  if (!isObject(v)) return {};
  const out: Record<string, string> = {};
  for (const [path, url] of Object.entries(v)) if (typeof url === 'string' && url) out[path] = url;
  return out;
};

const asDoc = (v: unknown): ComicDoc => {
  if (!isObject(v) || typeof v.id !== 'string' || !v.id) {
    throw new StudioApiError('server', 'The studio sent back an unreadable comic. Try reloading.', { status: 200 });
  }
  return normalizeDoc(v as Partial<ComicDoc> & { id: string });
};

const projectPath = (id: string) => `/api/comic/projects/${encodeURIComponent(id)}`;

const QUALITY_TIERS: ReadonlySet<string> = new Set<QualityTier>(['draft', 'standard', 'pro']);

/**
 * `caps` from a project response (contract §3.3), merged over DEFAULT_CAPS field by field so a
 * partial or older server answer still yields a complete, typed object. Absent ⇒ undefined.
 */
export const asCaps = (v: unknown): StudioCaps | undefined => {
  if (!isObject(v)) return undefined;
  const caps: StudioCaps = { ...DEFAULT_CAPS, qualityTiers: [...DEFAULT_CAPS.qualityTiers] };
  if (v.plan === 'free' || v.plan === 'paid' || v.plan === 'admin') caps.plan = v.plan;
  if (typeof v.byok === 'boolean') caps.byok = v.byok;
  if (Array.isArray(v.qualityTiers)) {
    const tiers = v.qualityTiers.filter((t): t is QualityTier => typeof t === 'string' && QUALITY_TIERS.has(t));
    if (tiers.length) caps.qualityTiers = [...new Set(tiers)];
  }
  if (typeof v.modelOverride === 'boolean') caps.modelOverride = v.modelOverride;
  if (typeof v.maxPages === 'number' && Number.isFinite(v.maxPages) && v.maxPages > 0) caps.maxPages = Math.min(Math.floor(v.maxPages), DEFAULT_CAPS.maxPages);
  if (v.defaultMode === 'easy' || v.defaultMode === 'pro') caps.defaultMode = v.defaultMode;
  if (typeof v.proEditor === 'boolean') caps.proEditor = v.proEditor;
  if (typeof v.customFonts === 'boolean') caps.customFonts = v.customFonts;
  if (typeof v.ratingCeiling === 'string' && (CONTENT_RATINGS as readonly string[]).includes(v.ratingCeiling)) caps.ratingCeiling = v.ratingCeiling as ContentRating;
  if (typeof v.admin === 'boolean') caps.admin = v.admin;
  // Optional fields: absent on the wire = off / unknown, so they are copied only when well formed.
  const usage = sanitizeStudioUsage(v.usage);
  if (usage) caps.usage = usage;
  if (v.history === true) caps.history = true;
  if (typeof v.maxAlternatives === 'number' && Number.isFinite(v.maxAlternatives) && v.maxAlternatives >= 1) {
    caps.maxAlternatives = Math.min(Math.floor(v.maxAlternatives), MAX_ALTERNATIVES);
  }
  if (isObject(v.anchorKinds)) {
    const k = v.anchorKinds;
    caps.anchorKinds = anchorKindsOf({ places: k.places === true, props: k.props === true, styleKey: k.styleKey === true, sheetV2: k.sheetV2 === true });
  }
  return caps;
};

export interface StudioProjectResponse {
  doc: ComicDoc;
  urls: Record<string, string>;
  /** Present once the server sends capabilities (P1-ROUTES); callers fall back to DEFAULT_CAPS. */
  caps?: StudioCaps;
}

// ── Projects ─────────────────────────────────────────────────────────────────

export async function createStudioProject(input: {
  title?: string;
  importFromProjectId?: string;
}): Promise<StudioProjectResponse & { projectId: string }> {
  try {
    const res = await post<typeof input, { projectId?: unknown; doc?: unknown; urls?: unknown; caps?: unknown }>('/api/comic/projects', input);
    const doc = asDoc(res?.doc);
    const projectId = typeof res?.projectId === 'string' && res.projectId ? res.projectId : doc.id;
    const caps = asCaps(res?.caps);
    return { projectId, doc, urls: asUrls(res?.urls), ...(caps ? { caps } : {}) };
  } catch (err) {
    throw toStudioApiError(err, 'generic');
  }
}

export async function loadStudioProject(id: string, opts: { signal?: AbortSignal } = {}): Promise<StudioProjectResponse> {
  try {
    const res = await get<{ doc?: unknown; urls?: unknown; caps?: unknown }>(projectPath(id), { signal: opts.signal });
    const caps = asCaps(res?.caps);
    return { doc: asDoc(res?.doc), urls: asUrls(res?.urls), ...(caps ? { caps } : {}) };
  } catch (err) {
    throw toStudioApiError(err, 'project');
  }
}

/** GET /api/comic/public/:id as the legacy `/?view=read&id=` reader reads it (contract §14.1, as amended). */
export interface PublicComicByIdResult {
  doc: ComicDoc;
  urls: Record<string, string>;
  /** The reader languages (source first). Empty when an older server sent none. */
  languages: ReaderLanguage[];
  /** Set when `?lang=` named a published edition (the doc is localized). */
  lang?: string;
  /** A live publication (non-owners): the reader can replaceState to `/c/<publication.slug>`. */
  publication?: PublicPublicationInfo;
  /** The owner's sanitized private preview (no publication; never shared). */
  preview?: true;
}

const LANG_CODE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

const asReaderLanguages = (v: unknown): ReaderLanguage[] => {
  if (!Array.isArray(v)) return [];
  const out: ReaderLanguage[] = [];
  for (const l of v.slice(0, 64)) {
    if (!isObject(l) || typeof l.code !== 'string' || !LANG_CODE_RE.test(l.code)) continue;
    const text = (x: unknown) => (typeof x === 'string' ? x.slice(0, 80) : '');
    out.push({ code: l.code, endonym: text(l.endonym) || l.code, english: text(l.english) || l.code, complete: l.complete === true, isSource: l.isSource === true });
  }
  return out;
};

/** A publication block only when it carries a well-formed slug (a link must never be built from junk). */
const asPublicPublication = (v: unknown): PublicPublicationInfo | undefined =>
  isObject(v) && typeof v.slug === 'string' && SLUG_RE.test(v.slug) && (v.visibility === 'public' || v.visibility === 'unlisted')
    ? (v as unknown as PublicPublicationInfo)
    : undefined;

/**
 * Published comic for the public reader. Works logged out (the token is optional). Keeps the
 * amended fields: `languages`, `lang`, and either `publication` (anyone else: the live, public
 * publication — the legacy reader can move to /c/<slug>) or `preview: true` (the owner).
 */
export async function loadPublicComic(id: string, opts: { signal?: AbortSignal; lang?: string } = {}): Promise<PublicComicByIdResult> {
  try {
    const q = opts.lang && LANG_CODE_RE.test(opts.lang) ? `?lang=${encodeURIComponent(opts.lang)}` : '';
    const res = await get<{ doc?: unknown; urls?: unknown; languages?: unknown; lang?: unknown; publication?: unknown; preview?: unknown }>(
      `/api/comic/public/${encodeURIComponent(id)}${q}`,
      { signal: opts.signal }
    );
    const publication = res?.preview === true ? undefined : asPublicPublication(res?.publication);
    const lang = typeof res?.lang === 'string' && LANG_CODE_RE.test(res.lang) ? res.lang : undefined;
    return {
      doc: asDoc(res?.doc),
      urls: asUrls(res?.urls),
      languages: asReaderLanguages(res?.languages),
      ...(lang ? { lang } : {}),
      ...(publication ? { publication } : {}),
      ...(res?.preview === true ? { preview: true as const } : {})
    };
  } catch (err) {
    throw toStudioApiError(err, 'public');
  }
}

/** Ask the server to stop the current director turn and any not-yet-started renders. */
export async function cancelStudio(id: string): Promise<void> {
  try {
    await post<Record<string, never>, unknown>(`${projectPath(id)}/cancel`, {});
  } catch (err) {
    throw toStudioApiError(err, 'project');
  }
}

/** Fresh signed URLs for storage paths the doc references (missing paths are omitted). */
export async function signStudioUrls(id: string, paths: string[]): Promise<Record<string, string>> {
  const unique = [...new Set(paths.filter((p) => typeof p === 'string' && p))];
  if (!unique.length) return {};
  const out: Record<string, string> = {};
  try {
    for (let i = 0; i < unique.length; i += SIGN_BATCH) {
      const res = await post<{ paths: string[] }, { urls?: unknown }>(`${projectPath(id)}/urls`, { paths: unique.slice(i, i + SIGN_BATCH) });
      Object.assign(out, asUrls(res?.urls));
    }
  } catch (err) {
    throw toStudioApiError(err, 'project');
  }
  return out;
}

// ── Image model change (models.md §3.4 item 7, §3.6 C) ───────────────────────

export type ChangeImageModelAction = Extract<StudioAction, { type: 'change_image_model' }>;

export interface ChangeImageModelInput {
  /** A registry id (a route id resolves to its registry id; anything else is refused here). */
  modelId: string;
  redraw: RedrawScope;
  /** The redraw quote the user saw in the confirm (the server re-quotes on drift > 15% + $0.01). 0 for 'none'. */
  quotedUsd: number;
}

/**
 * The `change_image_model` action exactly as the confirm sends it: `ack: true` (the user confirmed the
 * "consistency can be affected" dialog), a registry id, a known redraw scope and a finite, non-negative quote
 * (rounded to 4 decimals; 'none' always quotes 0). Throws a calm StudioApiError for anything else, so a malformed
 * switch never reaches the server. Only ModelChangeConfirm builds it — nothing switches a model without the confirm.
 */
export const buildChangeImageModelAction = (input: ChangeImageModelInput): ChangeImageModelAction => {
  const spec = typeof input?.modelId === 'string' ? getImageModel(input.modelId) : undefined;
  if (!spec) throw new StudioApiError('bad_request', "That model isn't available in Comic Studio — nothing was changed.");
  if (!REDRAW_SCOPES.includes(input.redraw)) throw new StudioApiError('bad_request', 'Choose what should happen to the drawn images — nothing was changed.');
  const quote = input.redraw === 'none' ? 0 : input.quotedUsd;
  if (typeof quote !== 'number' || !Number.isFinite(quote) || quote < 0) {
    throw new StudioApiError('bad_request', "This redraw can't be priced yet — nothing was changed.");
  }
  return { type: 'change_image_model', modelId: spec.id, redraw: input.redraw, quotedUsd: Math.round(quote * 10000) / 10000, ack: true };
};

/**
 * Switch the comic's image model through the controller's `act` (the action streams like every other one, so its
 * notice, gate or re-quote lands in the conversation). Resolves the action's outcome; rejects only when the input
 * is invalid (buildChangeImageModelAction).
 */
export async function changeImageModel(
  act: (action: StudioAction) => Promise<StudioActOutcome | void>,
  input: ChangeImageModelInput
): Promise<StudioActOutcome | void> {
  return act(buildChangeImageModelAction(input));
}

export async function getStudioModels(): Promise<{ models: ImageModelSpec[]; tiers: Record<QualityTier, TierPreset> }> {
  try {
    const res = await get<{ models?: unknown; tiers?: unknown }>('/api/comic/models');
    return {
      models: Array.isArray(res?.models) ? (res.models as ImageModelSpec[]) : [],
      tiers: (isObject(res?.tiers) ? res.tiers : {}) as Record<QualityTier, TierPreset>
    };
  } catch (err) {
    throw toStudioApiError(err, 'generic');
  }
}

// ── Stream ───────────────────────────────────────────────────────────────────

const EVENT_NAMES = new Set<string>(STREAM_EVENT_NAMES);

/**
 * The `done` event as this client reads it: exactly the shared shape (shared/comic/events.ts), whose optional
 * `beforeVersionId` names the moment a `history_restore` stream saved just before the restore (versions plan §6.1
 * step 8), so the restore toast's Undo needs no lookup. An older server simply never sends it.
 */
export type StudioDoneEvent = Extract<StudioEvent, { type: 'done' }>;

/**
 * Parse one SSE block into a StudioEvent. The data is the event JSON; its `type` wins,
 * else the SSE `event:` name is used. Returns null for unknown or malformed events so a
 * newer server never breaks an older client.
 */
export const parseStudioEvent = (eventName: string, data: string): StudioEvent | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const type = typeof parsed.type === 'string' && EVENT_NAMES.has(parsed.type) ? parsed.type : eventName;
  if (!EVENT_NAMES.has(type)) return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

  switch (type) {
    case 'hello': {
      const rev = num(parsed.rev);
      return rev === undefined ? null : { type: 'hello', rev, turnId: str(parsed.turnId) || '' };
    }
    case 'ops': {
      const rev = num(parsed.rev);
      if (rev === undefined || !Array.isArray(parsed.ops)) return null;
      const ops = parsed.ops.filter((op) => isObject(op) && typeof op.op === 'string');
      // origin: who caused the batch (the undo stack takes 'director' batches); label: undo text.
      const origin = parsed.origin === 'user' || parsed.origin === 'director' || parsed.origin === 'job' ? parsed.origin : undefined;
      const label = str(parsed.label)?.trim().slice(0, 120);
      return {
        type: 'ops',
        rev,
        ops: ops as unknown as Extract<StudioEvent, { type: 'ops' }>['ops'],
        ...(origin ? { origin } : {}),
        ...(label ? { label } : {})
      };
    }
    case 'delta': {
      const msgId = str(parsed.msgId);
      const text = str(parsed.text);
      return msgId && text !== undefined ? { type: 'delta', msgId, text } : null;
    }
    case 'activity': {
      const id = str(parsed.id);
      const phase = parsed.phase === 'end' ? 'end' : parsed.phase === 'start' ? 'start' : undefined;
      if (!id || !phase) return null;
      const cost = parsed.cost === 'free' || parsed.cost === 'text' || parsed.cost === 'image' ? parsed.cost : undefined;
      return {
        type: 'activity',
        id,
        label: str(parsed.label) || '',
        phase,
        ...(typeof parsed.ok === 'boolean' ? { ok: parsed.ok } : {}),
        ...(cost ? { cost } : {})
      };
    }
    case 'urls':
      return { type: 'urls', urls: asUrls(parsed.urls) };
    case 'error': {
      // Coded refusals get calm copy; a raw/technical message never reaches the UI.
      const code = str(parsed.code) && CODE_RE.test(str(parsed.code)!) ? str(parsed.code) : undefined;
      return {
        type: 'error',
        message: friendlyErrorMessage(code, str(parsed.message)),
        ...(code ? { code } : {})
      };
    }
    case 'done': {
      const saved = num(parsed.savedUsd);
      // Comic History: only a non-empty string id passes (anything else is dropped, never coerced).
      const before = str(parsed.beforeVersionId);
      const done: StudioDoneEvent = {
        type: 'done',
        rev: num(parsed.rev) ?? -1,
        spentUsd: num(parsed.spentUsd) ?? 0,
        ...(saved !== undefined && saved > 0 ? { savedUsd: saved } : {}),
        ...(before ? { beforeVersionId: before } : {})
      };
      return done;
    }
    // --- history: a moment was saved. Only a plain object that names its moment (a non-empty string id: the panel merges
    //     live rows by id) passes; the reducer stores it as lastHistoryVersion (an open History panel updates live) and
    //     resyncs after a restore or a switch. Never sent while COMIC_HISTORY is off. ---
    case 'history':
      return isObject(parsed.version) && str(parsed.version.id) ? { type: 'history', version: parsed.version as unknown as VersionRow } : null;
    default:
      return null;
  }
};

/**
 * Re-expose a response body so every received chunk (heartbeats included) is reported,
 * and so aborting `signal` fails the pending read immediately — even on fetch
 * implementations that don't tear the body down on abort.
 */
const watchBody = (body: ReadableStream<Uint8Array>, onChunk: () => void, signal: AbortSignal): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  let finished = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const onAbort = () => {
        if (finished) return;
        finished = true;
        controller.error(signal.reason ?? abortError());
        reader.cancel().catch(() => undefined);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (finished) return;
        if (done) {
          finished = true;
          controller.close();
          return;
        }
        onChunk();
        controller.enqueue(value);
      } catch (err) {
        if (finished) return;
        finished = true;
        controller.error(err);
      }
    },
    cancel(reason) {
      finished = true;
      return reader.cancel(reason);
    }
  });
};

/**
 * Run one studio turn or action: POST the request and deliver every StudioEvent until
 * the server's `done`. Resolves after `done` (or an `error` event followed by close).
 * Rejects with StudioApiError: `aborted` when `signal` fires, `connection_lost` on 45 s
 * of silence or an early close, or the mapped HTTP error.
 */
export async function streamStudio(
  id: string,
  req: StreamRequest,
  onEvent: (e: StudioEvent) => void,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) throw abortError();
  const ctrl = new AbortController();
  let idleFired = false;
  let sawDone = false;
  let sawError = false;
  let responded = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      idleFired = true;
      ctrl.abort(connectionLost());
    }, STREAM_IDLE_TIMEOUT_MS);
  };
  const onCallerAbort = () => ctrl.abort(abortError());
  signal?.addEventListener('abort', onCallerAbort, { once: true });
  arm();

  try {
    const res = await postStream(`${projectPath(id)}/stream`, req, { signal: ctrl.signal });
    responded = true;
    arm();
    if (!res.body) throw connectionLost();
    await readSSEStream(watchBody(res.body, arm, ctrl.signal), (block) => {
      if (sawDone) return;
      const event = parseStudioEvent(block.event, block.data);
      if (!event) return;
      if (event.type === 'error') sawError = true;
      if (event.type === 'done') sawDone = true;
      try {
        onEvent(event);
      } catch (err) {
        // A consumer bug must not kill the stream (the doc would freeze mid-turn).
        console.error('[comicstudio] stream event handler failed', err);
      }
      // `done` is the last event — release the connection without waiting for the close.
      if (sawDone) ctrl.abort(abortError());
    });
    if (!sawDone && !sawError) throw connectionLost();
  } catch (err) {
    if (sawDone) return;
    if (idleFired) throw connectionLost();
    if (signal?.aborted) throw abortError();
    if (err instanceof StudioApiError) throw err;
    // The body broke after the server answered (proxy drop, network change, sleep).
    if (responded) throw connectionLost();
    throw toStudioApiError(err, 'project');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

// ── v5 endpoints (contract §14.1) ────────────────────────────────────────────
//
// Thin, typed wrappers for every endpoint the v5 client calls. Each feature package
// (P1-REFS, P1-I18N, P1-PUBLISH, P1-SAFETY, P1-LIBRARY, P1-STORAGE) fills in its server
// route; until then those routes answer 501 → StudioApiError kind 'not_available'.
// Owner calls go through apiClient (auth + BYOK headers). Public edge reads/writes use a
// bare fetch: no auth token, no provider keys, so nothing private reaches edge logs.

const enc = encodeURIComponent;

class HttpStatusError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
    if (code) this.code = code;
  }
}

/** `{error:{message, code}}` (or `{message, code}`) from a JSON error body. */
const errorFromBody = (body: unknown, status: number, statusText: string): HttpStatusError => {
  let message = statusText || '';
  let code: string | undefined;
  if (isObject(body)) {
    const src = isObject(body.error) ? body.error : body;
    if (typeof src.message === 'string' && src.message.trim()) message = src.message.trim();
    if (typeof src.code === 'string' && CODE_RE.test(src.code)) code = src.code;
  }
  return new HttpStatusError(message, status, code);
};

/** Server message + code from a JSON error body, else the status text. */
const errorFromResponse = async (res: Response): Promise<HttpStatusError> => {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  return errorFromBody(body, res.status, res.statusText);
};

/** fetch that maps a transport failure to status 0 and keeps aborts as aborts. */
const rawFetch = async (path: string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(buildApiUrl(path), init);
  } catch (err) {
    if (isAbortError(err) || init.signal?.aborted) throw abortError();
    throw new HttpStatusError(err instanceof Error ? err.message : 'network error', 0);
  }
};

/** Anonymous JSON request for the public edge routes (no credentials, no provider keys). */
const publicRequest = async <T>(path: string, init: RequestInit = {}): Promise<T | null> => {
  const res = await rawFetch(path, { credentials: 'omit', ...init });
  if (!res.ok) throw await errorFromResponse(res);
  if (res.status === 202 || res.status === 204) return null;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : null;
};

/** The signed-in user's bearer token (lazy: the reader and tests never load Supabase for this). */
const authHeader = async (): Promise<Record<string, string>> => {
  try {
    const { supabase } = await import('../../services/supabase');
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  } catch {
    return {};
  }
};

const call = async <T>(context: 'project' | 'public' | 'generic', fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (err) {
    throw toStudioApiError(err, context);
  }
};

const asOps = (v: unknown): DocOp[] => (Array.isArray(v) ? (v.filter((op) => isObject(op) && typeof op.op === 'string') as unknown as DocOp[]) : []);

// ── References (P1-REFS, routes/comicRefs.ts) ────────────────────────────────

export interface RefUploadParams {
  /** Where the image goes; `{kind:'inbox'}` for composer drafts. */
  to: RefOwner;
  label?: RefLabel;
  /** Original filename (the server sanitizes it to ≤ 80 chars). */
  name?: string;
  /** sha256(original bytes), first 16 hex — exact-duplicate hint (the server re-checks). */
  hash?: string;
  /** 0-based insert position (0 = main ref). */
  index?: number;
}

export interface RefUploadResponse {
  ref?: RefAsset;
  /** Already on this owner: the existing path (HTTP 200, nothing stored). */
  duplicateOf?: string;
  notice?: { kind: 'near_duplicate'; of: string };
  rev?: number;
  ops: DocOp[];
  urls: Record<string, string>;
}

/** Parse a refs upload answer (201 `{ref, rev, ops, urls, notice?}` · 200 `{duplicateOf}`). */
const asRefUploadResponse = (raw: unknown): RefUploadResponse => {
  const body = isObject(raw) ? raw : {};
  const ref = isObject(body.ref) && typeof body.ref.path === 'string' ? (body.ref as unknown as RefAsset) : undefined;
  const notice =
    isObject(body.notice) && body.notice.kind === 'near_duplicate' && typeof body.notice.of === 'string'
      ? { kind: 'near_duplicate' as const, of: body.notice.of }
      : undefined;
  return {
    ...(ref ? { ref } : {}),
    ...(typeof body.duplicateOf === 'string' && body.duplicateOf ? { duplicateOf: body.duplicateOf } : {}),
    ...(notice ? { notice } : {}),
    ...(typeof body.rev === 'number' && Number.isFinite(body.rev) ? { rev: body.rev } : {}),
    ops: asOps(body.ops),
    urls: asUrls(body.urls)
  };
};

const refUploadPath = (id: string, params: RefUploadParams): string => {
  const q = new URLSearchParams({ to: refOwnerKey(params.to) });
  if (params.label) q.set('label', params.label);
  if (params.name) q.set('name', params.name);
  if (params.hash && /^[0-9a-f]{16}$/.test(params.hash)) q.set('hash', params.hash);
  if (typeof params.index === 'number' && Number.isInteger(params.index) && params.index >= 0) q.set('index', String(params.index));
  return `${projectPath(id)}/refs?${q.toString()}`;
};

/** Upload progress is reported up to this fraction; the rest is the server's safety check. */
export const UPLOAD_SENT_FRACTION = 0.95;
/** A stuck upload gives up after this long (phones on bad networks). */
export const UPLOAD_TIMEOUT_MS = 120_000;

export interface RefUploadTransportOptions {
  signal?: AbortSignal;
  /** 0..1. Bytes sent map to 0..0.95; 1 once the server has checked and stored the image. Uses XHR. */
  onProgress?: (fraction: number) => void;
  /** Injected XMLHttpRequest (tests). */
  XHR?: typeof XMLHttpRequest;
}

/** XHR transport: real upload progress, abort via the signal, the user's bearer token, no provider keys. */
const xhrUpload = (path: string, file: Blob, headers: Record<string, string>, opts: RefUploadTransportOptions, Ctor: typeof XMLHttpRequest): Promise<unknown> =>
  new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }
    const xhr = new Ctor();
    let settled = false;
    const onAbort = () => xhr.abort();
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    xhr.open('POST', buildApiUrl(path));
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (xhr.upload && opts.onProgress) {
      xhr.upload.onprogress = (e: ProgressEvent) => {
        if (e.lengthComputable && e.total > 0) opts.onProgress?.(Math.min(UPLOAD_SENT_FRACTION, (e.loaded / e.total) * UPLOAD_SENT_FRACTION));
      };
    }
    xhr.onload = () =>
      finish(() => {
        const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
        let body: unknown;
        try {
          body = text ? JSON.parse(text) : undefined;
        } catch {
          body = undefined;
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body);
        else reject(errorFromBody(body, xhr.status, xhr.statusText || ''));
      });
    xhr.onerror = () => finish(() => reject(new HttpStatusError('network error', 0)));
    xhr.ontimeout = () => finish(() => reject(new HttpStatusError('upload timed out', 0)));
    xhr.onabort = () => finish(() => reject(abortError()));
    xhr.send(file);
  });

/**
 * POST /projects/:id/refs — raw image body (≤ 10 MB after the client downscale).
 * 201 {ref, rev, ops, urls, notice?} · 200 {duplicateOf} · 409 LIMIT · 415 · 422 CONTENT_POLICY · 429 COOLDOWN.
 * With `onProgress` (and an XMLHttpRequest) it uploads via XHR for real progress; otherwise fetch.
 * Either way the signal aborts it, and failures are StudioApiErrors with calm copy.
 */
export async function uploadStudioRef(id: string, file: Blob, params: RefUploadParams, opts: RefUploadTransportOptions = {}): Promise<RefUploadResponse> {
  return call('project', async () => {
    const path = refUploadPath(id, params);
    const headers = { 'Content-Type': file.type || 'application/octet-stream', ...(await authHeader()) };
    const Ctor = opts.XHR || (opts.onProgress && typeof XMLHttpRequest !== 'undefined' ? XMLHttpRequest : undefined);
    if (Ctor) {
      const body = await xhrUpload(path, file, headers, opts, Ctor);
      opts.onProgress?.(1);
      return asRefUploadResponse(body);
    }
    const res = await rawFetch(path, { method: 'POST', headers, body: file, signal: opts.signal });
    if (!res.ok) throw await errorFromResponse(res);
    const out = asRefUploadResponse(await res.json().catch(() => ({})));
    opts.onProgress?.(1);
    return out;
  });
}

/** DELETE /projects/:id/refs?owner=inbox&path= — drop an unsent composer upload (commits ref_remove). */
export async function deleteInboxRef(id: string, path: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
  await call('project', () => del<unknown>(`${projectPath(id)}/refs?owner=inbox&path=${enc(path)}`, opts));
}

// ── Translations (P1-I18N, routes/comicI18n.ts) ──────────────────────────────

export interface TranslationQuote {
  perLanguage: Array<{ lang: string; lines: number; free: number; upToDate: boolean; usd: number; seconds: number }>;
  usd: number;
  byok: boolean;
}

/**
 * GET /projects/:id/translation-quote?langs= — the client never duplicates the price tables.
 * Optional scope (the `translate` SpendAction's pageIds / lineIds / force, P2-AMEND): sent as
 * `pageIds=`, `lineIds=` and `force=1`; a server that does not read them yet quotes the whole edition
 * (an over-quote, never an under-quote — the spend is re-gated server-side either way).
 */
export async function getTranslationQuote(
  id: string,
  langs: string[],
  opts: { signal?: AbortSignal; pageIds?: string[]; lineIds?: string[]; force?: boolean } = {}
): Promise<TranslationQuote> {
  return call('project', async () => {
    const list = [...new Set(langs.filter((l) => typeof l === 'string' && l))];
    const ids = (v: string[] | undefined, max: number) => [...new Set((v || []).filter((x) => typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x)))].slice(0, max);
    const pageIds = ids(opts.pageIds, 200);
    const lineIds = ids(opts.lineIds, 200);
    const scope = `${pageIds.length ? `&pageIds=${enc(pageIds.join(','))}` : ''}${lineIds.length ? `&lineIds=${enc(lineIds.join(','))}` : ''}${opts.force ? '&force=1' : ''}`;
    const res = await get<Partial<TranslationQuote>>(`${projectPath(id)}/translation-quote?langs=${enc(list.join(','))}${scope}`, opts.signal ? { signal: opts.signal } : {});
    return {
      perLanguage: Array.isArray(res?.perLanguage) ? res.perLanguage : [],
      usd: typeof res?.usd === 'number' && Number.isFinite(res.usd) ? res.usd : 0,
      byok: !!res?.byok
    };
  });
}

// ── Publication (P1-PUBLISH, routes/comicPublication.ts) ─────────────────────
// Errors: 404 (not owner), 409 (busy), 422 NOT_READY / SAFETY_BLOCKED / LANG_INCOMPLETE.

const asPublication = (v: unknown): PublicationOwnerView | null => {
  const view = isObject(v) && isObject(v.publication) ? v.publication : v;
  return isObject(view) && typeof view.visibility === 'string' ? (view as unknown as PublicationOwnerView) : null;
};

/** GET /projects/:id/publication — the owner's view (null when the server has none). */
export async function getPublication(id: string, opts: { signal?: AbortSignal } = {}): Promise<PublicationOwnerView | null> {
  return call('project', async () => asPublication(await get<unknown>(`${projectPath(id)}/publication`, opts)));
}

/** POST /projects/:id/publication — publish (a re-publish after an unpublish gets a NEW slug). */
export async function publishComic(id: string, request: PublishRequest, opts: { signal?: AbortSignal } = {}): Promise<PublicationOwnerView | null> {
  return call('project', async () => asPublication(await post<PublishRequest, unknown>(`${projectPath(id)}/publication`, request, opts)));
}

/** PATCH /projects/:id/publication — visibility, default language, start page, download/embed/creator. */
export async function updatePublication(id: string, patch: PublicationSettingsPatch, opts: { signal?: AbortSignal } = {}): Promise<PublicationOwnerView | null> {
  return call('project', async () => asPublication(await apiPatch<PublicationSettingsPatch, unknown>(`${projectPath(id)}/publication`, patch, opts)));
}

/** DELETE /projects/:id/publication — unpublish (the link 404s immediately). */
export async function unpublishComic(id: string, opts: { signal?: AbortSignal } = {}): Promise<PublicationOwnerView | null> {
  return call('project', async () => asPublication(await del<unknown>(`${projectPath(id)}/publication`, opts)));
}

/** POST /projects/:id/publication/regenerate — a new slug; the old link stops working. */
export async function regeneratePublicationLink(id: string, opts: { signal?: AbortSignal } = {}): Promise<PublicationOwnerView | null> {
  return call('project', async () => asPublication(await post<Record<string, never>, unknown>(`${projectPath(id)}/publication/regenerate`, {}, opts)));
}

// ── Safety (P1-SAFETY, routes/comicSafety.ts + routes/moderation.ts) ─────────

/** POST /projects/:id/safety-review {target, note?} — appeal (same as the `safety_recheck` action). 5/day. */
export async function requestSafetyReview(id: string, body: { target: RenderTarget; note?: string }, opts: { signal?: AbortSignal } = {}): Promise<void> {
  await call('project', () => post<typeof body, unknown>(`${projectPath(id)}/safety-review`, body, opts));
}

export type ReportReason = 'sexual' | 'violent' | 'hateful' | 'self_harm' | 'real_person' | 'copyright' | 'other';

/**
 * POST /api/comic/public/s/:slug/report — always 202 (even for an unknown slug). Works logged out;
 * a signed-in reader's bearer token is sent (optionalAuth reads it), so their report counts as one
 * signed-in reporter (weight 1) instead of an anonymous one (0.5). Still no cookies or provider keys.
 */
export async function reportPublicComic(
  slug: string,
  body: { reason: ReportReason; pageN?: number; note?: string; turnstileToken?: string },
  opts: { signal?: AbortSignal } = {}
): Promise<void> {
  await call('public', async () =>
    publicRequest<unknown>(`/api/comic/public/s/${enc(slug)}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify(body),
      signal: opts.signal
    })
  );
}

export interface ComicCaseFilter {
  status?: 'open' | 'resolved';
  kind?: 'report' | 'appeal' | 'auto';
}

/** GET /api/moderation/comic-cases — moderator queue (shape owned by P1-SAFETY). */
export async function listComicCases<T = unknown>(filter: ComicCaseFilter = {}, opts: { signal?: AbortSignal } = {}): Promise<T[]> {
  return call('generic', async () => {
    const q = new URLSearchParams();
    if (filter.status) q.set('status', filter.status);
    if (filter.kind) q.set('kind', filter.kind);
    const res = await get<{ cases?: unknown } | unknown[]>(`/api/moderation/comic-cases${q.toString() ? `?${q}` : ''}`, opts);
    const list = Array.isArray(res) ? res : isObject(res) && Array.isArray(res.cases) ? res.cases : [];
    return list as T[];
  });
}

/** GET /api/moderation/comic-cases/:id/asset — a 5-minute signed URL (audited). */
export async function getComicCaseAsset(caseId: string, opts: { signal?: AbortSignal } = {}): Promise<{ url: string } | null> {
  return call('generic', async () => {
    const res = await get<{ url?: unknown }>(`/api/moderation/comic-cases/${enc(caseId)}/asset`, opts);
    return typeof res?.url === 'string' && res.url ? { url: res.url } : null;
  });
}

/** POST /api/moderation/comic-cases/:id/resolve. */
export async function resolveComicCase(
  caseId: string,
  body: { action: 'dismiss' | 'withhold' | 'restore' | 'force_private'; assessed?: ContentRating | 'X'; reason: string },
  opts: { signal?: AbortSignal } = {}
): Promise<void> {
  await call('generic', () => post<typeof body, unknown>(`/api/moderation/comic-cases/${enc(caseId)}/resolve`, body, opts));
}

// ── Public reader (P1-PUBLISH edge: api-proxy/src/publicComic.ts) ────────────

/** GET /api/comic/public/s/:slug — the frozen snapshot `{publication, doc, urls}`. One canonical 404. */
export async function loadPublicComicBySlug(slug: string, opts: { signal?: AbortSignal } = {}): Promise<PublicComicPayload> {
  return call('public', async () => {
    const res = await publicRequest<{ publication?: unknown; doc?: unknown; urls?: unknown }>(`/api/comic/public/s/${enc(slug)}`, {
      headers: { Accept: 'application/json' },
      signal: opts.signal
    });
    if (!res || !isObject(res.publication) || typeof res.publication.slug !== 'string') {
      throw new StudioApiError('server', 'The comic link sent back something unreadable. Try reloading.', { status: 200 });
    }
    return { publication: res.publication as unknown as PublicComicPayload['publication'], doc: asDoc(res.doc), urls: asUrls(res.urls) };
  });
}

export type PublicEventType = 'view' | 'complete' | 'share';

/**
 * POST /api/comic/public/s/:slug/event (always 204). Fire-and-forget: never throws, never
 * retries, and uses `keepalive` so a "complete" sent while the tab closes still lands.
 */
export async function trackPublicEvent(slug: string, event: { type: PublicEventType; channel?: ShareChannel; lang?: string }): Promise<void> {
  if (!slug) return;
  const body: Record<string, string> = { type: event.type };
  if (event.channel) body.channel = event.channel;
  if (event.lang) body.lang = event.lang.slice(0, 35);
  try {
    await rawFetch(`/api/comic/public/s/${enc(slug)}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      keepalive: true
    });
  } catch {
    /* analytics must never break reading */
  }
}

/** GET /api/comic/oembed?url= — only `https://dreamstreamstudio.ai/c/<slug>` URLs. */
export async function getComicOEmbed(url: string, opts: { signal?: AbortSignal } = {}): Promise<Record<string, unknown> | null> {
  return call('public', () => publicRequest<Record<string, unknown>>(`/api/comic/oembed?url=${enc(url)}`, { signal: opts.signal }));
}

// ── Platform library (P1-LIBRARY, routes/comicLibrary.ts) ────────────────────

/** GET /api/comic/public/library — published library assets (never fails the UI: errors → empty index). */
export async function getPublicLibrary(opts: { signal?: AbortSignal } = {}): Promise<LibraryIndex> {
  try {
    const res = await publicRequest<Partial<LibraryIndex>>('/api/comic/public/library', { signal: opts.signal });
    return {
      manifestVersion: typeof res?.manifestVersion === 'number' ? res.manifestVersion : 0,
      generatedAt: typeof res?.generatedAt === 'number' ? res.generatedAt : 0,
      assets: Array.isArray(res?.assets) ? res.assets : []
    };
  } catch (err) {
    if (isAbortError(err)) throw abortError();
    return { manifestVersion: 0, generatedAt: 0, assets: [] };
  }
}

export interface LibraryBuildRequest {
  ids?: string[];
  kinds?: LibraryKind[];
  force?: boolean;
  includeOptional?: boolean;
  /** Default $5, hard max $25 (the server clamps). */
  budgetUsd?: number;
  maxRetries?: 0 | 1 | 2;
}

export interface LibraryManifestView {
  manifestVersion: number;
  entries: Array<Record<string, unknown> & { id: string }>;
  platformKey: boolean;
}

const LIB_ADMIN = '/api/comic/admin/library';

/** GET …/admin/library/manifest */
export async function getLibraryManifest(opts: { signal?: AbortSignal } = {}): Promise<LibraryManifestView> {
  return call('generic', async () => {
    const res = await get<Partial<LibraryManifestView>>(`${LIB_ADMIN}/manifest`, opts);
    return {
      manifestVersion: typeof res?.manifestVersion === 'number' ? res.manifestVersion : 0,
      entries: Array.isArray(res?.entries) ? res.entries : [],
      platformKey: !!res?.platformKey
    };
  });
}

/** POST …/admin/library/quote — a dry-run quote; spends nothing. */
export async function quoteLibraryBuild(body: LibraryBuildRequest = {}, opts: { signal?: AbortSignal } = {}): Promise<LibraryQuote> {
  return call('generic', async () => {
    const res = await post<LibraryBuildRequest, { quote?: LibraryQuote } & Partial<LibraryQuote>>(`${LIB_ADMIN}/quote`, body, opts);
    return (isObject(res?.quote) ? res.quote : res) as LibraryQuote;
  });
}

/** POST …/admin/library/runs — start a client-driven run (409 when one is already running). */
export async function startLibraryRun(body: LibraryBuildRequest = {}, opts: { signal?: AbortSignal } = {}): Promise<LibraryRunView> {
  return call('generic', () => post<LibraryBuildRequest, LibraryRunView>(`${LIB_ADMIN}/runs`, body, opts));
}

/** POST …/admin/library/runs/:id/step {n ≤ 3} — advances at most n assets synchronously. */
export async function stepLibraryRun(runId: string, n = 1, opts: { signal?: AbortSignal } = {}): Promise<LibraryRunView> {
  const step = Math.max(1, Math.min(3, Math.floor(Number.isFinite(n) ? n : 1)));
  return call('generic', () => post<{ n: number }, LibraryRunView>(`${LIB_ADMIN}/runs/${enc(runId)}/step`, { n: step }, opts));
}

/** POST …/admin/library/runs/:id/cancel */
export async function cancelLibraryRun(runId: string, opts: { signal?: AbortSignal } = {}): Promise<void> {
  await call('generic', () => post<Record<string, never>, unknown>(`${LIB_ADMIN}/runs/${enc(runId)}/cancel`, {}, opts));
}

/** POST …/admin/library/assets/:id/{publish,reject,regenerate} */
export async function reviewLibraryAsset(
  assetId: string,
  action: 'publish' | 'reject' | 'regenerate',
  body: { rev?: number; note?: string; budgetUsd?: number } = {},
  opts: { signal?: AbortSignal } = {}
): Promise<unknown> {
  return call('generic', () => post<typeof body, unknown>(`${LIB_ADMIN}/assets/${enc(assetId)}/${action}`, body, opts));
}

/** POST …/admin/library/assets/purge-candidates {dryRun?} */
export async function purgeLibraryCandidates(body: { dryRun?: boolean } = {}, opts: { signal?: AbortSignal } = {}): Promise<{ objects: number; bytes: number }> {
  return call('generic', async () => {
    const res = await post<typeof body, { objects?: unknown; bytes?: unknown }>(`${LIB_ADMIN}/assets/purge-candidates`, body, opts);
    return { objects: typeof res?.objects === 'number' ? res.objects : 0, bytes: typeof res?.bytes === 'number' ? res.bytes : 0 };
  });
}

// ── Storage admin (P1-STORAGE, routes/comicStorageAdmin.ts) ──────────────────

export interface MigrateRefsResult {
  dryRun: boolean;
  projects: number;
  moved: number;
  remaining: number;
  errors?: string[];
}

/** POST /api/comic/admin/storage/migrate-refs {dryRun, projectId?, limit ≤ 10} — client-driven batches. */
export async function migrateLegacyRefs(
  body: { dryRun: boolean; projectId?: string; limit?: number },
  opts: { signal?: AbortSignal } = {}
): Promise<MigrateRefsResult> {
  const limit = typeof body.limit === 'number' ? Math.max(1, Math.min(10, Math.floor(body.limit))) : undefined;
  return call('generic', () =>
    post<typeof body, MigrateRefsResult>('/api/comic/admin/storage/migrate-refs', { ...body, ...(limit !== undefined ? { limit } : {}) }, opts)
  );
}
