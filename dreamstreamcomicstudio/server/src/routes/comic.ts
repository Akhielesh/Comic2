// Comic Studio API — the conversational studio (v4 doc, v5 contract §14.1).
//
// Mounted at /api/comic (after requireAuth/attachAccountKeys) and /api/comic/public
// (before requireAuth, optionalAuth). Every /projects/:id route is owner-scoped: the user
// id comes from the verified JWT (req.user), never from the body, and a project the user
// does not own answers the same 404 as one that does not exist. One POST
// /projects/:id/stream request carries a user message (→ cooldown → safety screen → free
// intent router → Comic Director turn) or a direct action (→ job runner) and streams
// StudioEvents as SSE until the turn and every render it started have settled.
//
// Every refusal that happens before anything is persisted (401, 400, 404, BUSY, COOLDOWN,
// restricted, a blocked message) is logged as one structured `comic_stream_refused` line
// (codes and ids only — never user text, file names or secrets), so "it still fails"
// reports can be checked against the server log.

import { randomUUID } from 'node:crypto';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { DEFAULT_CAPS, sanitizeStudioUsage, withHistoryCaps, type StudioCaps, type StudioUsage } from '../../../shared/comic/capabilities.js';
import {
  CAST_KINDS,
  collectAssetPaths,
  createEmptyDoc,
  displayAssetPaths,
  newId,
  type AssetRef,
  type CastKind,
  type CastTier,
  type ComicDoc,
  type ComicKind,
  type Msg,
  type RefAsset,
  type RenderState
} from '../../../shared/comic/doc.js';
import { encodeStudioEvent, normalizeTimeZone, type AttachmentTarget, type StreamRequest, type StudioEvent, type StudioFocus } from '../../../shared/comic/events.js';
import { editionProgress, i18nOf, localizeDoc } from '../../../shared/comic/i18n.js';
import { languageSpec, sameLanguage } from '../../../shared/comic/languages.js';
import { DOC_LIMITS } from '../../../shared/comic/limits.js';
import { IMAGE_MODELS, TIER_PRESETS, resolveImageJob } from '../../../shared/comic/models.js';
import { applyOps, isSpendAction, NON_SPEND_ACTION_TYPES, SPEND_ACTION_TYPES, type DocOp, type StudioAction } from '../../../shared/comic/ops.js';
import type { PublicComicPayload } from '../../../shared/comic/publication.js';
import { REF_LIMITS } from '../../../shared/comic/refs.js';
import { effectiveRating, type ContentRating } from '../../../shared/comic/safety.js';
import { STYLE_PRESETS } from '../../../shared/comic/stylePresets.js';
import { logger } from '../lib/logger.js';
import { getAllowanceStatus } from '../services/platformAllowance.js';
import { consumeAllowanceNotices } from '../services/usageEnforcer.js';
import { checkQualityAccess, studioCapsFor, type StudioCapsDeps } from '../comic/access.js';
import { createSupabaseAssetStore, isOwnedAssetPath } from '../comic/assets.js';
import { createStudioContext, signAssetPaths, type OrchestratorContext, type StudioContextDeps } from '../comic/context.js';
import { costFormatterFor, governCard, governDollars, standardPageProviderUsd } from '../comic/costText.js';
import { recordOptionAnswer, runDirectorTurn, type OptionAnswerRef } from '../comic/director.js';
import { canFastPath, parseIntent, routeIntent } from '../comic/intents.js';
import { ASPECT_RATIOS, runAction, spendIsByok, suggestNextSteps } from '../comic/jobs.js';
import { studioKeysFromRequest } from '../comic/keys.js';
import { loadPublicByProjectId } from '../comic/publication/index.js';
import { applyAttachmentTargets, takeInbox } from '../comic/refs/index.js';
import {
  cooldownFor,
  isServableToOwner,
  requireActiveUser,
  respondBlocked,
  screenTurnInput,
  type ScreenResult
} from '../comic/safety/index.js';
import { CRISIS_LINE } from '../comic/safety/contentPolicy.js';
import { composeTurnReply } from '../comic/replies.js';
import { getStudioSession, peekStudioSession, scheduleVariantBackfill, type StudioSession } from '../comic/session.js';
import { createSupabaseDocStore, sanitizePublicDoc } from '../comic/store.js';
import { ANALYZE_SOURCE_MIN_CHARS, buildTurnToolset, createDirectorTurn } from '../comic/tools.js';
import { toolGroups } from '../comic/tools/index.js';
import { StudioError, type AssetStore, type DocStore } from '../comic/types.js';
// --- history (versions plan §3.3, §11; H0 seams). Only through the owner history route modules, never the history
//     engine modules directly: this file also holds the public reader router (§12). ---
import { historyRoutesEnabled, rememberTurnTimeZone } from './comicHistory.js';
import { legacyVersionImport, notifyImported, parseFromVersionId } from './comicLegacyHistory.js';

// ── Limits ───────────────────────────────────────────────────────────────────

export const MAX_MESSAGE_CHARS = 60_000;
/** Legacy data-URL items per message (old tabs; images + text files). */
export const MAX_ATTACHMENTS = 6;
/** `{inboxPath}` items per message (new composer, uploaded via POST /refs). */
export const MAX_INBOX_ATTACHMENTS = REF_LIMITS.perMessageImages;
/** Images per message, whichever way they arrive. */
export const MAX_MESSAGE_IMAGES = REF_LIMITS.perMessageImages;
/** A 10 MB file is ~13.4M base64 characters plus its data: header. */
export const MAX_ATTACHMENT_DATA_URL_CHARS = Math.ceil((10 * 1024 * 1024 * 4) / 3) + 256;
const MAX_TEXT_FILE_CHARS = 200_000;
const MAX_URL_PATHS = 500;
const MAX_PATH_CHARS = 512;
const HEARTBEAT_MS = 15_000;
const PROJECT_ID = /^[A-Za-z0-9-]{1,64}$/;
/** Ids minted by newId() and every other doc id (pages, lines, cast). */
const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;
const TEXT_MIME = /^(text\/|application\/(json|x-fountain|rtf))/i;
const TEXT_EXT = /\.(txt|md|markdown|fountain|fdx|json|csv|rtf)$/i;
const COMIC_KINDS: readonly ComicKind[] = ['comic', 'manga', 'webtoon', 'strip', 'storybook'];
const FOCUS_SURFACES: ReadonlyArray<NonNullable<StudioFocus['surface']>> = ['board', 'page_editor', 'reader', 'timeline'];

/** Every action a client may send (single source: shared/comic/ops.ts). */
export const STREAM_ACTION_TYPES: ReadonlySet<string> = new Set([...SPEND_ACTION_TYPES, ...NON_SPEND_ACTION_TYPES]);

// ── User-facing copy ─────────────────────────────────────────────────────────

export const BUSY_MESSAGE = "I'm still working on your last message — wait for it to finish, or press stop.";
export const HIDDEN_MESSAGE_TEXT = "[Message hidden — it didn't fit DreamStream's content rules]";
export const RESTRICTED_SPEND_MESSAGE =
  'Your account is limited right now, so new drawing and translation are paused. You can still read and edit your comic for free.';
const RESTRICTED_UPLOAD_MESSAGE = 'Your account is limited right now, so image uploads are paused. You can still read and edit your comic for free.';
const RESTRICTED_PUBLISH_MESSAGE = 'Your account is limited right now, so publishing is paused. You can still read and edit your comic.';
const PUBLIC_NOT_FOUND = { error: { message: "This comic isn't available.", code: 'NOT_FOUND' } } as const;

export const cooldownMessage = (until: number, now = Date.now()): string => {
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
  return `Let's take a short break — you can pick the story back up in ${minutes} min. Reading and editing your pages still work.`;
};

// ── Stop, scoped to what it says it stops ────────────────────────────────────

/**
 * Which abort controllers a Stop reaches, per session. A queued render (and a translation run)
 * captures the session's abort controller when its run starts, so every message request swaps in
 * a fresh controller for its turn: work an EARLIER request queued keeps the earlier controller.
 * - While a director turn is in flight (from its request's start, upload included, to the end of
 *   the turn), Stop is "Stop the director": it stops that turn and whatever the turn queued, and
 *   leaves the drawing an earlier request started alone (the composer unlocks once a reply lands,
 *   so a turn and an earlier turn's renders overlap).
 * - With no turn in flight, Stop is "Stop drawing": every queued render of the session stops
 *   (images already drawing finish and are kept).
 */
interface StopScope {
  /** Controllers of message requests whose director turn has not ended. */
  turns: Set<AbortController>;
  /** Controllers a later turn swapped out while work started under them may still run. */
  earlier: Set<AbortController>;
  /** Open stream requests. Each stays open until the work it started has settled, so at 0 nothing uses `earlier`. */
  open: number;
}
const stopScopes = new WeakMap<StudioSession, StopScope>();

const stopScopeOf = (session: StudioSession): StopScope => {
  let scope = stopScopes.get(session);
  if (!scope) {
    scope = { turns: new Set(), earlier: new Set(), open: 0 };
    stopScopes.set(session, scope);
  }
  return scope;
};

/**
 * Register one stream request with its session's Stop scope; a message that will run (`turn`) gets
 * its own controller. `endTurn` when the director turn is over (its renders stay reachable by
 * "Stop drawing"), `close` when the request ends; both are idempotent.
 */
function openStopScope(session: StudioSession, turn: boolean): { endTurn(): void; close(): void } {
  const scope = stopScopeOf(session);
  scope.open += 1;
  let mine: AbortController | null = null;
  if (turn) {
    const prior = session.abort;
    if (!prior.signal.aborted) scope.earlier.add(prior);
    mine = session.resetAbort();
    scope.turns.add(mine);
  }
  let closed = false;
  const endTurn = () => {
    if (mine) scope.turns.delete(mine);
    mine = null;
  };
  return {
    endTurn,
    close() {
      endTurn();
      if (closed) return;
      closed = true;
      scope.open = Math.max(0, scope.open - 1);
      if (!scope.open) scope.earlier.clear();
    }
  };
}

/** POST /projects/:id/cancel (and a `cancel` action): stop the director turn in flight, or else all drawing. */
function stopSessionWork(session: StudioSession): 'turn' | 'drawing' {
  const scope = stopScopeOf(session);
  if (scope.turns.size) {
    for (const c of scope.turns) c.abort();
    return 'turn';
  }
  for (const c of scope.earlier) c.abort();
  scope.earlier.clear();
  session.abort.abort();
  return 'drawing';
}

// ── Dependencies ─────────────────────────────────────────────────────────────

/** The safety seams the routes call (P1-SAFETY). Injectable for tests. */
export interface RouteSafetyDeps {
  cooldownFor: typeof cooldownFor;
  screenTurnInput: typeof screenTurnInput;
  respondBlocked: typeof respondBlocked;
}

export interface ComicRouterDeps {
  store?: DocStore;
  assets?: AssetStore;
  /** Per-request overrides for the context (keys, llm, images, billing). */
  contextDeps?: (req: Request) => StudioContextDeps;
  qualityAccess?: typeof checkQualityAccess;
  /** Caps lookups (plan, admin, account ceiling); tests inject fakes so nothing hits the network. */
  capsDeps?: StudioCapsDeps;
  /** Moderation gate on writes (default: the safety seam's requireActiveUser()). */
  requireActive?: RequestHandler;
  safety?: Partial<RouteSafetyDeps>;
  /** Free intent router (default: intents.routeIntent; no model call). */
  routeIntent?: typeof routeIntent;
  heartbeatMs?: number;
  /**
   * The user's usage snapshot for caps.usage (percentages only — never dollars). Default: the cached
   * usage status (platformAllowance), skipped when tests inject capsDeps; undefined = unknown.
   */
  usageFor?: (userId: string, caps: StudioCaps) => Promise<StudioUsage | undefined>;
  /** Phase-2 structural free edits without a model call (COMIC_FAST_INTENTS). Default: env flag, off. */
  fastIntents?: boolean;
  /** Session-load size-variant backfill (default on; tests switch it off). */
  backfillVariants?: boolean;
}

/** COMIC_FAST_INTENTS=true: "swap pages 2 and 3", "make the shouts red"… run their one free tool directly. */
const FAST_INTENTS_ENV = /^(1|true|on|yes)$/i.test(String(process.env.COMIC_FAST_INTENTS || ''));

/** caps.usage from the cached usage status (P1-LIMITS): governed share facts only, no dollars. */
const defaultUsageFor = async (userId: string, caps: StudioCaps): Promise<StudioUsage | undefined> => {
  if (!userId || caps.admin || caps.byok) return undefined;
  const status = await getAllowanceStatus(userId, { isAdmin: caps.admin });
  // Positively ungoverned (metering off, exempt row): prices in dollars, like the client's costDisplay.
  if (status.governed === false) return { governed: false, pctLeft: 100, exhausted: false, pctPerStandardPage: null };
  // The status couldn't be read: unknown (a governed user still never sees dollars).
  if (!status.enabled) return undefined;
  const pctPerStandardPage = status.governed && status.capUsd > 0 ? Math.round((standardPageProviderUsd() / status.capUsd) * 100 * 100) / 100 : null;
  return sanitizeStudioUsage({ governed: status.governed, pctLeft: status.pctLeft, exhausted: status.exhausted, pctPerStandardPage });
};

const lazy = <T>(make: () => T) => {
  let value: T | undefined;
  return () => (value ??= make());
};

const httpError = (res: Response, err: unknown, next: NextFunction) => {
  if (err instanceof StudioError) {
    res.status(err.status || 500).json({ error: { message: err.userMessage, code: err.code } });
    return;
  }
  next(err);
};

const handle =
  (fn: (req: Request, res: Response) => Promise<unknown>, onRefusal?: (req: Request, err: StudioError) => void) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch((err) => {
      if (onRefusal && err instanceof StudioError) {
        try {
          onRefusal(req, err);
        } catch {
          /* logging never changes the answer */
        }
      }
      httpError(res, err, next);
    });
  };

const requireUser = (req: Request): string => {
  const id = req.user?.id;
  if (!id) throw new StudioError('FORBIDDEN', 'Sign in to use the comic studio.', { status: 401 });
  return id;
};

const projectIdParam = (req: Request): string => {
  const id = String(req.params.id || '');
  if (!PROJECT_ID.test(id)) throw new StudioError('NOT_FOUND', "This comic doesn't exist or you don't have access to it.", { status: 404 });
  return id;
};

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** A project id safe to put in a log line (never echo arbitrary input). */
const loggableId = (raw: unknown): string => {
  const id = String(raw ?? '');
  return PROJECT_ID.test(id) ? id : 'invalid';
};

/**
 * Moderation state set by requireActiveUser() (P1-SAFETY): suspended accounts never get
 * here (403); `restricted` may read and edit but not spend, upload or publish.
 */
export const moderationOf = (res: Response): 'active' | 'restricted' =>
  (res.locals as Record<string, unknown>)?.moderationStatus === 'restricted' ? 'restricted' : 'active';

type RefusalStage = 'pre_stream' | 'stream';
interface RefusalLog {
  code: string;
  status?: number;
  kind?: 'message' | 'action';
  action?: string;
  [key: string]: unknown;
}

/** One structured line per refused request (ids and codes only). */
const logRefusal = (req: Request, stage: RefusalStage, fields: RefusalLog) => {
  logger.info('comic_stream_refused', {
    requestId: req.requestId,
    projectId: loggableId(req.params?.id),
    userId: req.user?.id || null,
    stage,
    ...fields
  });
};

/**
 * One structured line per refused non-stream studio request (create, open, sign, cancel):
 * the route PATTERN (never the raw URL), ids and codes only.
 */
const logRequestRefused = (req: Request, fields: { code: string; status?: number; [key: string]: unknown }) => {
  logger.info('comic_request_refused', {
    requestId: req.requestId,
    method: req.method,
    route: typeof req.route?.path === 'string' ? req.route.path : undefined,
    projectId: req.params?.id === undefined ? undefined : loggableId(req.params.id),
    userId: req.user?.id || null,
    ...fields
  });
};

/** kind/action of a raw body for logging (only validated, known names). */
const bodyShape = (body: unknown): Pick<RefusalLog, 'kind' | 'action'> => {
  if (!isObject(body)) return {};
  if (body.kind === 'message') return { kind: 'message' };
  if (body.kind === 'action') {
    const type = isObject(body.action) ? body.action.type : undefined;
    return { kind: 'action', ...(typeof type === 'string' && STREAM_ACTION_TYPES.has(type) ? { action: type } : {}) };
  }
  return {};
};

// ── Asset visibility for the owner ───────────────────────────────────────────

/**
 * Paths the owner may NOT be served (a `blocked` safety verdict): the asset, its variants
 * and its original. Walks the whole doc so every lane (pages, sheets, refs, archive, trash,
 * inbox, attachments, future fields) is covered by the one isServableToOwner rule.
 */
export function blockedAssetPaths(doc: ComicDoc): Set<string> {
  const blocked = new Set<string>();
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value as object)) return;
    seen.add(value as object);
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const obj = value as Record<string, unknown>;
    if (typeof obj.path === 'string' && obj.path && !isServableToOwner(obj as unknown as AssetRef)) {
      blocked.add(obj.path);
      if (Array.isArray(obj.variants)) obj.variants.forEach((v) => isObject(v) && typeof v.path === 'string' && blocked.add(v.path));
      if (isObject(obj.original) && typeof obj.original.path === 'string') blocked.add(obj.original.path);
    }
    for (const key of Object.keys(obj)) visit(obj[key]);
  };
  visit(doc);
  return blocked;
}

/** Filter paths down to the ones the owner may be served. */
export const servablePaths = (doc: ComicDoc, paths: string[]): string[] => {
  const blocked = blockedAssetPaths(doc);
  return blocked.size ? paths.filter((p) => !blocked.has(p)) : paths;
};

/** What the reader shows: current page and cover art (+ variants). Never history/refs/sheets. */
const readerAssetPaths = (doc: ComicDoc): string[] => {
  const out = new Set<string>();
  const add = (render?: RenderState) => {
    const a = render?.asset;
    if (!a?.path) return;
    out.add(a.path);
    a.variants?.forEach((v) => v?.path && out.add(v.path));
  };
  doc.pages.forEach((p) => add(p.render));
  add(doc.cover?.render);
  return [...out];
};

// ── Stream request validation ────────────────────────────────────────────────

type LegacyAttachment = { name: string; mimeType: string; dataUrl: string };
type InboxAttachment = { inboxPath: string };
type MessageRequest = Extract<StreamRequest, { kind: 'message' }>;

const isInboxItem = (a: LegacyAttachment | InboxAttachment): a is InboxAttachment => 'inboxPath' in a;

const mimeOfDataUrl = (dataUrl: string) => (/^data:([^;,]+)/i.exec(dataUrl)?.[1] || '').toLowerCase();

/** Focus is a hint: keep the valid parts, drop the rest (never fails a message). */
export function parseFocus(raw: unknown): StudioFocus | undefined {
  if (!isObject(raw)) return undefined;
  const out: StudioFocus = {};
  if (typeof raw.pageId === 'string' && DOC_ID.test(raw.pageId)) out.pageId = raw.pageId;
  if (Array.isArray(raw.lineIds)) {
    const ids = [...new Set(raw.lineIds.filter((id): id is string => typeof id === 'string' && DOC_ID.test(id)))].slice(0, DOC_LIMITS.lineIdsPerOp);
    if (ids.length) out.lineIds = ids;
  }
  if (typeof raw.panelN === 'number' && Number.isInteger(raw.panelN) && raw.panelN >= 1 && raw.panelN <= DOC_LIMITS.panelsPerPage) out.panelN = raw.panelN;
  if (typeof raw.surface === 'string' && (FOCUS_SURFACES as readonly string[]).includes(raw.surface)) out.surface = raw.surface as StudioFocus['surface'];
  return Object.keys(out).length ? out : undefined;
}

/** One quick-assign target (null = leave it to the director). Throws on a malformed entry. */
const parseTarget = (raw: unknown, bad: (m: string) => StudioError): AttachmentTarget => {
  if (raw === null || raw === undefined) return null;
  const fail = () => bad('A photo assignment could not be read — pick who it is again.');
  if (!isObject(raw)) throw fail();
  switch (raw.kind) {
    case 'character':
    case 'place':
      if (typeof raw.id !== 'string' || !DOC_ID.test(raw.id)) throw fail();
      return { kind: raw.kind, id: raw.id };
    case 'style':
      return { kind: 'style' };
    case 'inbox':
      return null;
    case 'new_character': {
      const name = typeof raw.name === 'string' ? raw.name.replace(/\s+/g, ' ').trim().slice(0, REF_LIMITS.nameChars) : '';
      if (!name) throw fail();
      const castKind = typeof raw.castKind === 'string' && (CAST_KINDS as readonly string[]).includes(raw.castKind) ? (raw.castKind as CastKind) : undefined;
      return { kind: 'new_character', name, ...(castKind ? { castKind } : {}) };
    }
    default:
      throw fail();
  }
};

/** Choice ids one option-card answer may name (cards carry a handful of choices). */
const MAX_ANSWER_CHOICES = 24;

/**
 * The option card a message answers (`card` on a message request; additive — OptionsCard names
 * the card and its picked choice ids, or `custom` for a typed answer). A hint like focus: the
 * valid parts are kept and anything malformed is dropped, never failing the message; the card
 * and its choices are checked against the doc when the answer is recorded (recordOptionAnswer).
 */
export function parseOptionAnswer(raw: unknown): OptionAnswerRef | undefined {
  if (!isObject(raw) || typeof raw.id !== 'string' || !DOC_ID.test(raw.id)) return undefined;
  const choiceIds = Array.isArray(raw.choiceIds)
    ? [...new Set(raw.choiceIds.filter((c): c is string => typeof c === 'string' && DOC_ID.test(c)))].slice(0, MAX_ANSWER_CHOICES)
    : [];
  const custom = typeof raw.custom === 'string' ? raw.custom.replace(/\s+/g, ' ').trim().slice(0, MAX_MESSAGE_CHARS) : '';
  if (!choiceIds.length && !custom) return undefined;
  return { id: raw.id, ...(choiceIds.length ? { choiceIds } : {}), ...(custom ? { custom } : {}) };
}

/** Validate the body of POST /stream. Throws BAD_REQUEST with a user-safe message. */
export function parseStreamRequest(body: unknown): StreamRequest {
  const bad = (message: string) => new StudioError('BAD_REQUEST', message, { status: 400 });
  if (!isObject(body)) throw bad('Send a message or an action.');
  if (body.kind === 'message') {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (text.length > MAX_MESSAGE_CHARS) throw bad(`That message is too long (max ${MAX_MESSAGE_CHARS.toLocaleString('en-US')} characters). Attach long scripts as a .txt file.`);
    const raw = body.attachments === undefined || body.attachments === null ? [] : body.attachments;
    if (!Array.isArray(raw)) throw bad('Attachments must be a list.');
    if (raw.length > MAX_ATTACHMENTS + MAX_INBOX_ATTACHMENTS) throw bad(`Send up to ${MAX_MESSAGE_IMAGES} images per message.`);
    const attachments: (LegacyAttachment | InboxAttachment)[] = [];
    const inboxSeen = new Set<string>();
    let legacy = 0;
    let images = 0;
    for (const a of raw) {
      if (isObject(a) && typeof a.inboxPath === 'string') {
        const path = a.inboxPath.trim();
        if (!path || path.length > MAX_PATH_CHARS || /[\u0000-\u001f]/.test(path)) throw bad('An attachment could not be read.');
        if (inboxSeen.has(path)) continue;
        inboxSeen.add(path);
        images += 1;
        attachments.push({ inboxPath: path });
        continue;
      }
      if (!isObject(a) || typeof a.dataUrl !== 'string' || !a.dataUrl.startsWith('data:')) throw bad('An attachment could not be read.');
      if (a.dataUrl.length > MAX_ATTACHMENT_DATA_URL_CHARS) throw bad('Each attachment must be 10 MB or smaller.');
      legacy += 1;
      const mimeType = (typeof a.mimeType === 'string' ? a.mimeType : '').slice(0, 120).toLowerCase();
      if ((mimeType || mimeOfDataUrl(a.dataUrl)).startsWith('image/')) images += 1;
      attachments.push({ name: (typeof a.name === 'string' ? a.name : 'attachment').slice(0, 200), mimeType, dataUrl: a.dataUrl });
    }
    if (legacy > MAX_ATTACHMENTS) throw bad(`Attach at most ${MAX_ATTACHMENTS} files per message.`);
    if (inboxSeen.size > MAX_INBOX_ATTACHMENTS || images > MAX_MESSAGE_IMAGES) throw bad(`Send up to ${MAX_MESSAGE_IMAGES} images per message.`);
    let attachmentTargets: AttachmentTarget[] | undefined;
    if (body.attachmentTargets !== undefined && body.attachmentTargets !== null) {
      if (!Array.isArray(body.attachmentTargets) || body.attachmentTargets.length > MAX_MESSAGE_IMAGES) throw bad('A photo assignment could not be read — pick who it is again.');
      attachmentTargets = body.attachmentTargets.map((t) => parseTarget(t, bad));
      if (!attachmentTargets.some(Boolean)) attachmentTargets = undefined;
    }
    const focus = parseFocus(body.focus);
    if (!text && !attachments.length) throw bad('Type a message or attach something.');
    // The sender's time zone (history's "this morning"): a hint — kept when Intl knows it, else dropped, never a 400.
    const tz = normalizeTimeZone(body.tz);
    return {
      kind: 'message',
      text,
      ...(attachments.length ? { attachments } : {}),
      ...(attachmentTargets ? { attachmentTargets } : {}),
      ...(focus ? { focus } : {}),
      ...(tz ? { tz } : {})
    };
  }
  if (body.kind === 'action') {
    const action = body.action;
    if (!isObject(action) || typeof action.type !== 'string') throw bad('Unknown action.');
    if (!STREAM_ACTION_TYPES.has(action.type)) throw bad(`Unknown action "${action.type.slice(0, 40)}".`);
    const tz = normalizeTimeZone(body.tz);
    return { kind: 'action', action: action as unknown as StudioAction, ...(tz ? { tz } : {}) };
  }
  throw bad('Send a message or an action.');
}

const decodeTextDataUrl = (dataUrl: string): string => {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new StudioError('BAD_REQUEST', 'A text attachment could not be read.', { status: 400 });
  const header = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  let text: string;
  try {
    text = /;base64$/i.test(header) ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload);
  } catch {
    throw new StudioError('BAD_REQUEST', 'A text attachment could not be read.', { status: 400 });
  }
  return text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').slice(0, MAX_TEXT_FILE_CHARS);
};

/** A legacy image data URL → bytes + mime (base64 only; images are never URL-encoded). */
const decodeImageDataUrl = (dataUrl: string, declared: string): { buffer: Buffer; mime: string } => {
  const m = /^data:([^;,]+)((?:;[^;,]*)*);base64,/i.exec(dataUrl);
  if (!m) throw new StudioError('BAD_REQUEST', 'An image attachment could not be read — attach it again.', { status: 400 });
  const buffer = Buffer.from(dataUrl.slice(m[0].length), 'base64');
  if (!buffer.byteLength) throw new StudioError('BAD_REQUEST', 'An image attachment could not be read — attach it again.', { status: 400 });
  return { buffer, mime: (m[1] || declared).toLowerCase() };
};

/** Does this message carry image bytes (legacy data URLs) that would be stored now? */
const hasLegacyImageUpload = (req: MessageRequest): boolean =>
  (req.attachments || []).some((a) => !isInboxItem(a) && (a.mimeType || mimeOfDataUrl(a.dataUrl)).startsWith('image/'));

interface PreparedMessage {
  text: string;
  /** Image attachments in the order the user sent them (inbox items + stored legacy images). */
  attachments: RefAsset[];
  /** Ops to commit with the turn (a long text/script becomes the source script). */
  ops: DocOp[];
  /** Inbox items consumed by this message: path → ref_remove op. */
  inboxOps: Map<string, DocOp>;
  /** Quick-assign targets aligned with `attachments` (applied after the safety screen). */
  targets?: AttachmentTarget[];
  focus?: StudioFocus;
  /** The long text saved as the source script, for the safety screen. */
  sourceText?: string;
  /** The option card this message answers, when the client names it (parseOptionAnswer). */
  answer?: OptionAnswerRef;
}

/** Message text longer than this is treated as a pasted script (saved to source.script). */
const LONG_MESSAGE_CHARS = 6000;

/**
 * Images: `{inboxPath}` items are taken from this project's inbox (a path that is not
 * there is a 400 — clients can never smuggle other paths); legacy data URLs are encoded
 * and stored in the PRIVATE ref lane (saveRef). Plain-text files are inlined when short or
 * saved as the source script when long. Everything that can fail validation is checked
 * before the first byte is stored, so a bad request persists nothing.
 */
async function prepareMessage(req: MessageRequest, ctx: OrchestratorContext): Promise<PreparedMessage> {
  let text = req.text;
  const ops: DocOp[] = [];
  const notes: string[] = [];
  let sourceText: string | undefined;
  // A pasted script lives in source.script, not in the conversation: the doc keeps up to
  // 160 messages, and storing 60k-char pastes in each would bloat every save and session.
  if (text.length > LONG_MESSAGE_CHARS) {
    const words = (text.match(/\S+/g) || []).length;
    ops.push({ op: 'source', patch: { script: text, updatedAt: Date.now() } });
    sourceText = text;
    text = `${text.slice(0, 400).trimEnd()}…\n\n[Pasted ${words.toLocaleString('en-US')} words — saved as the source script. Call save_source (no text) to read it.]`;
  }
  const items = req.attachments || [];

  // 1. Validate everything (no storage yet).
  const inboxPaths = items.filter(isInboxItem).map((a) => a.inboxPath);
  const taken = inboxPaths.length ? await takeInbox(ctx, inboxPaths) : { attachments: [] as RefAsset[], ops: [] as DocOp[] };
  const fromInbox = new Map(taken.attachments.map((r) => [r.path, r]));
  const inboxOps = new Map<string, DocOp>();
  for (const op of taken.ops) if (op.op === 'ref_remove') inboxOps.set(op.path, op);
  type Planned = { kind: 'inbox'; ref: RefAsset } | { kind: 'image'; buffer: Buffer; mime: string } | { kind: 'text'; name: string; content: string };
  const planned: Planned[] = [];
  for (const a of items) {
    if (isInboxItem(a)) {
      const ref = fromInbox.get(a.inboxPath);
      if (ref) planned.push({ kind: 'inbox', ref });
      continue;
    }
    const mime = a.mimeType || mimeOfDataUrl(a.dataUrl);
    if (mime.startsWith('image/')) {
      planned.push({ kind: 'image', ...decodeImageDataUrl(a.dataUrl, mime) });
      continue;
    }
    if (TEXT_MIME.test(mime) || TEXT_EXT.test(a.name)) {
      planned.push({ kind: 'text', name: a.name, content: decodeTextDataUrl(a.dataUrl).trim() });
      continue;
    }
    throw new StudioError('BAD_REQUEST', `“${a.name}” isn't supported — attach images or plain-text files (.txt, .md).`, { status: 400 });
  }
  const encoded = await Promise.all(
    planned.map((p) => (p.kind === 'image' ? ctx.assets.encodeUploadBuffer(p.buffer, p.mime) : Promise.resolve(null)))
  );

  // 2. Store legacy images privately and assemble the attachments in the user's order.
  const attachments: RefAsset[] = [];
  for (let i = 0; i < planned.length; i += 1) {
    const p = planned[i];
    if (p.kind === 'inbox') attachments.push(p.ref);
    else if (p.kind === 'image') {
      const ref = await ctx.assets.saveRef({ userId: ctx.userId, projectId: ctx.projectId, encoded: encoded[i]! });
      // Free: the dHash (near-duplicate detection) and the quality flags (blur/dark) that ref ranking reads.
      const measured = await ctx.assets.measureRef(encoded[i]!.buffer).catch((err) => {
        logger.warn('comic_legacy_ref_measure_failed', { projectId: ctx.projectId, message: (err as Error)?.message });
        return null;
      });
      attachments.push(measured ? { ...ref, ...(measured.dhash ? { dhash: measured.dhash } : {}), ...(measured.quality ? { quality: measured.quality } : {}) } : ref);
    }
    else if (p.content) {
      if (p.content.length >= ANALYZE_SOURCE_MIN_CHARS) {
        const words = (p.content.match(/\S+/g) || []).length;
        ops.push({ op: 'source', patch: { script: p.content, updatedAt: Date.now() } });
        sourceText = p.content;
        notes.push(`[Attached “${p.name}” — ${words.toLocaleString('en-US')} words, saved as the source script. Call save_source (no text) to read it.]`);
      } else {
        notes.push(`[Attached “${p.name}”]\n${p.content}`);
      }
    }
  }
  if (notes.length) text = [text, ...notes].filter(Boolean).join('\n\n');
  return {
    text,
    attachments,
    ops,
    inboxOps,
    ...(req.attachmentTargets ? { targets: req.attachmentTargets } : {}),
    ...(req.focus ? { focus: req.focus } : {}),
    ...(sourceText ? { sourceText } : {})
  };
}

/** Requests that spend or upload (refused during a safety cooldown). Reading and free edits stay allowed. */
export const isCostlyRequest = (request: StreamRequest): boolean => {
  if (request.kind === 'message') return true;
  const action = request.action;
  if (isSpendAction(action)) return true;
  if (action.type === 'approve_gate' || action.type === 'plan_pages') return true;
  return action.type === 'relayout_balloons' && !!action.useVision;
};

/** Why a restricted account may not run this request, or null when it may (read/edit). */
export const restrictedRefusal = (request: StreamRequest): string | null => {
  if (request.kind === 'message') return hasLegacyImageUpload(request) ? RESTRICTED_UPLOAD_MESSAGE : null;
  const action = request.action;
  if (isSpendAction(action) || action.type === 'approve_gate') return RESTRICTED_SPEND_MESSAGE;
  // The legacy paid re-check alias (it becomes a recheck_page spend) is a spend too.
  if (action.type === 'relayout_balloons' && action.useVision) return RESTRICTED_SPEND_MESSAGE;
  // regenerate_link re-publishes under a new slug (POST /publication/regenerate is refused too).
  if (action.type === 'publish' || action.type === 'update_publication' || action.type === 'regenerate_link') return RESTRICTED_PUBLISH_MESSAGE;
  return null;
};

/** The screen is fail-open for the owner's private turn (decisions-final #10); a crash is logged, never silent. */
const ALLOW: ScreenResult = { decision: 'allow', categories: [], strike: 0, blockedAttachmentPaths: [] };

// ── Free text inside actions (S15) ──────────────────────────────────────────

/** jobs.ts `clean`: whitespace collapsed, trimmed, bounded — exactly what the job hands its prompt. */
const flatText = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
/** jobs.ts bounds for user text in actions (edit instruction, plan instructions, style directions). */
const ACTION_TEXT_LIMITS = { instruction: 2000, instructions: 8000, directionName: 60, directionSpec: 1500 } as const;
/**
 * Style directions screened per request. jobs.ts draws the first 4 valid ones; every valid entry up to
 * this (larger) bound is screened, so a raised job limit or padding can never slip one past the screen.
 */
const MAX_SCREENED_DIRECTIONS = 8;

/**
 * The user-authored free text an action would hand to a writer or image prompt — with the same bounds
 * and validity rules the job uses — or '' when it carries none. Style directions that repeat an option
 * the doc already holds (server-written text: the writer's, or an earlier screened request) are skipped,
 * so a retry is never screened (or struck) for our own words. Pure.
 */
export function actionInputText(doc: ComicDoc, action: StudioAction): string {
  if (!isObject(action)) return '';
  const a = action as Record<string, unknown>;
  if (a.type === 'edit_page') return flatText(a.instruction, ACTION_TEXT_LIMITS.instruction);
  if (a.type === 'plan_pages') return flatText(a.instructions, ACTION_TEXT_LIMITS.instructions);
  if (a.type === 'render_style_options') {
    const known = new Set(
      (doc?.style?.options || []).map((o) => `${flatText(o?.name, ACTION_TEXT_LIMITS.directionName)}\u0000${flatText(o?.spec, ACTION_TEXT_LIMITS.directionSpec)}`)
    );
    return (Array.isArray(a.directions) ? a.directions : [])
      .filter(isObject)
      .map((d) => ({ name: flatText(d.name, ACTION_TEXT_LIMITS.directionName), spec: flatText(d.spec, ACTION_TEXT_LIMITS.directionSpec) }))
      .filter((d) => d.name && d.spec)
      .slice(0, MAX_SCREENED_DIRECTIONS)
      .filter((d) => !known.has(`${d.name}\u0000${d.spec}`))
      .map((d) => `${d.name}: ${d.spec}`)
      .join('\n\n');
  }
  return '';
}

export const ACTION_BLOCKED_MESSAGE = "That change doesn't fit DreamStream's content rules — nothing was drawn or spent. Try different wording.";

// ── Legacy import ────────────────────────────────────────────────────────────

const str = (v: unknown, max = 2000) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** Owned storage paths from a legacy entity (its main image + references). */
const legacyRefs = (entity: Record<string, unknown>, userId: string, max = 3): AssetRef[] => {
  const paths = [entity.imageId, ...(Array.isArray(entity.referenceImageIds) ? entity.referenceImageIds : [])]
    .filter((p): p is string => typeof p === 'string' && !!p && isOwnedAssetPath(p, userId));
  return [...new Set(paths)].slice(0, max).map((path) => ({ path, source: 'upload' as const, at: Date.now() }));
};

/**
 * Map a classic (pre-v4) project's state onto doc ops: script, title, characters (look
 * from the structured details), locations, style prompt and aspect. Pure.
 */
export function legacyImportOps(
  legacy: { name: string; state: Record<string, unknown> },
  userId: string
): { ops: DocOp[]; summary: { title: string; words: number; cast: string[]; places: number; style: boolean } } {
  const state = legacy.state || {};
  const ops: DocOp[] = [];
  const title = str(legacy.name, 200) || str(state.title, 200) || 'Untitled comic';
  const brief: Record<string, unknown> = { title };
  const overview = str(state.overview, 4000);
  if (overview) brief[overview.length <= 300 ? 'logline' : 'premise'] = overview;
  ops.push({ op: 'brief', patch: brief });

  const script = typeof state.script === 'string' ? state.script.trim().slice(0, 200_000) : '';
  if (script) ops.push({ op: 'source', patch: { script, updatedAt: Date.now() } });

  const cast: string[] = [];
  const characters = Array.isArray(state.characters) ? state.characters.filter(isObject) : [];
  characters.slice(0, 24).forEach((c, i) => {
    const name = str(c.name, 80);
    if (!name) return;
    const s = isObject(c.structured) ? c.structured : {};
    const description = str(c.description, 600);
    const traits = str(s.physicalTraits, 400);
    const summary = [description, traits && !description.toLowerCase().includes(traits.toLowerCase()) ? traits : ''].filter(Boolean).join('. ').slice(0, 600);
    const marks = [str(s.distinguishingFeatures, 300), str(s.mustKeep, 200)].filter(Boolean).join('; ');
    const tier: CastTier = c.castTier === 'lead' || c.castTier === 'support' || c.castTier === 'extra' ? c.castTier : i === 0 ? 'lead' : 'support';
    const look = {
      summary,
      ...(str(s.ageBand, 80) ? { age: str(s.ageBand, 80) } : {}),
      ...(str(s.genderPresentation, 80) ? { gender: str(s.genderPresentation, 80) } : {}),
      ...(str(s.outfit, 300) ? { outfit: str(s.outfit, 300) } : {}),
      ...(str(s.colorPalette, 200) ? { palette: str(s.colorPalette, 200) } : {}),
      ...(marks ? { marks } : {})
    };
    const personality = str(s.personality, 1000) || str(c.bio, 1000);
    ops.push({
      op: 'character',
      id: newId('c'),
      patch: {
        name,
        tier,
        look,
        refs: legacyRefs(c, userId),
        ...(str(s.role, 200) ? { role: str(s.role, 200) } : {}),
        ...(personality ? { personality } : {})
      }
    });
    cast.push(name.toUpperCase());
  });

  const locations = Array.isArray(state.locations) ? state.locations.filter(isObject) : [];
  let places = 0;
  for (const l of locations.slice(0, 16)) {
    const name = str(l.name, 80);
    if (!name) continue;
    const s = isObject(l.structured) ? l.structured : {};
    const look = [str(l.description, 800), str(s.landmarks, 200), str(s.lighting, 160), str(s.eraMood, 160), str(s.palette, 160)].filter(Boolean).join('. ').slice(0, 1500);
    ops.push({ op: 'place', id: newId('pl'), patch: { name, look, refs: legacyRefs(l, userId, 2) } });
    places += 1;
  }

  const stylePrompt = str(state.stylePrompt, 2000);
  const styleRefs = typeof state.styleImageId === 'string' && isOwnedAssetPath(state.styleImageId, userId)
    ? [{ path: state.styleImageId, source: 'upload' as const, at: Date.now() }]
    : [];
  if (stylePrompt || styleRefs.length) {
    ops.push({
      op: 'style',
      patch: {
        status: stylePrompt ? 'drafted' : 'empty',
        ...(stylePrompt ? { spec: stylePrompt, name: str(state.styleCategory, 80) || 'Imported style' } : {}),
        refs: styleRefs
      }
    });
  }
  const aspect = typeof state.styleAspectRatio === 'string' ? state.styleAspectRatio : '';
  const pageModel = resolveImageJob('page', 'standard').spec;
  if ((ASPECT_RATIOS as string[]).includes(aspect) && pageModel.aspects.includes(aspect as never)) {
    ops.push({ op: 'format', patch: { pageAspect: aspect as never } });
  }
  return { ops, summary: { title, words: (script.match(/\S+/g) || []).length, cast, places, style: !!stylePrompt } };
}

/** Re-encodes at once (sharp work is also slot-limited inside the asset store). */
const IMPORT_REF_CONCURRENCY = 3;
/** Users with a classic import running in this process (one at a time each; see POST /projects). */
const importingUsers = new Set<string>();
/** Total time the import may spend re-encoding classic photos; anything not done by then is dropped. */
export const IMPORT_REF_BUDGET_MS = 20_000;
const IMPORTABLE_MIME = /^image\/(png|jpe?g|webp|gif|avif)$/i;

/**
 * Classic photos live in client-writable storage (the legacy <uid>/<file> lane, u/<uid>/tmp/…, or
 * another project's lane), so their bytes can be swapped, or be animated, after any check. Bring each
 * one over through the server upload pipeline instead — magic bytes, pixel limits, first frame only,
 * EXIF-upright static WebP — into THIS comic's private ref lane (no client storage policies), and point
 * the ops at the new copy (S6). Each unique path is re-encoded once and shared; a photo that can't be
 * read or re-encoded in time is dropped, never failing the import. Returns the rewritten ops, the new
 * private copies and how many photos were kept/dropped (counts only are logged — never paths or names).
 */
export async function rehomeLegacyRefs(
  ops: DocOp[],
  args: { userId: string; projectId: string; assets: AssetStore; budgetMs?: number; now?: () => number }
): Promise<{ ops: DocOp[]; kept: number; dropped: number; stored: string[] }> {
  const listOf = (op: DocOp): AssetRef[] | null => {
    if (op.op !== 'character' && op.op !== 'place' && op.op !== 'style') return null;
    const refs = (op.patch as { refs?: unknown } | undefined)?.refs;
    return Array.isArray(refs) ? (refs as AssetRef[]) : null;
  };
  const paths = [...new Set(ops.flatMap((op) => (listOf(op) || []).map((r) => r?.path).filter((p): p is string => typeof p === 'string' && !!p)))];
  if (!paths.length) return { ops, kept: 0, dropped: 0, stored: [] };

  const now = args.now || (() => Date.now());
  const deadline = now() + (args.budgetMs ?? IMPORT_REF_BUDGET_MS);
  const moved = new Map<string, RefAsset>();
  // Every object a saved copy wrote: the original and its size variants (saveRef may write _w480/_w1080).
  const objectsOf = (r: RefAsset): string[] => [
    r.path,
    ...(Array.isArray(r.variants) ? r.variants.map((v) => v?.path).filter((p): p is string => typeof p === 'string' && !!p) : [])
  ];
  let expired = false;
  const rehome = async (path: string): Promise<void> => {
    // Only the caller's own objects are ever read with the server key (legacyRefs filters too).
    if (!isOwnedAssetPath(path, args.userId)) return;
    try {
      const { mime, buffer } = decodeImageDataUrl(await args.assets.loadDataUrl(path), 'image/png');
      // The declared type is only storage metadata; the encoder sniffs the real bytes either way.
      const encoded = await args.assets.encodeUploadBuffer(buffer, IMPORTABLE_MIME.test(mime) ? mime : 'image/png');
      const saved = await args.assets.saveRef({ userId: args.userId, projectId: args.projectId, encoded });
      if (expired) {
        // Finished after the import moved on: nothing will point at it (its variants neither).
        void args.assets.remove(objectsOf(saved)).catch(() => undefined);
        return;
      }
      moved.set(path, { ...saved, source: 'upload', at: saved.at || now() });
    } catch {
      /* unreadable, too small, not an image, storage down: dropped (counted below) */
    }
  };
  const queue = paths.slice();
  const worker = async () => {
    while (queue.length && !expired && now() < deadline) await rehome(queue.shift()!);
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(Array.from({ length: Math.min(IMPORT_REF_CONCURRENCY, paths.length) }, worker)),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, deadline - now()));
      timer.unref?.();
    })
  ]);
  if (timer) clearTimeout(timer);
  expired = true;

  const rewritten = ops.map((op) => {
    const refs = listOf(op);
    if (!refs) return op;
    const next: RefAsset[] = [];
    for (const r of refs) {
      const copy = typeof r?.path === 'string' ? moved.get(r.path) : undefined;
      if (copy && !next.some((n) => n.path === copy.path)) next.push({ ...copy });
    }
    return { ...op, patch: { ...((op as { patch?: object }).patch || {}), refs: next } } as DocOp;
  });
  return { ops: rewritten, kept: moved.size, dropped: paths.length - moved.size, stored: [...moved.values()].flatMap(objectsOf) };
}

const importWelcome = (summary: ReturnType<typeof legacyImportOps>['summary'], doc: ComicDoc, droppedPhotos = 0): Msg => {
  const parts: string[] = [];
  if (summary.words) parts.push(`the script (${summary.words.toLocaleString('en-US')} words)`);
  if (summary.cast.length) {
    const names = summary.cast.slice(0, 4).join(', ') + (summary.cast.length > 4 ? ` +${summary.cast.length - 4}` : '');
    parts.push(`${summary.cast.length} character${summary.cast.length === 1 ? '' : 's'} (${names})`);
  }
  if (summary.places) parts.push(`${summary.places} location${summary.places === 1 ? '' : 's'}`);
  if (summary.style) parts.push('your style');
  const what = parts.length ? parts.join(', ').replace(/, ([^,]*)$/, ' and $1') : 'the title';
  const dropped =
    droppedPhotos > 0
      ? `${droppedPhotos} reference photo${droppedPhotos === 1 ? '' : 's'} couldn’t be brought over — you can add ${droppedPhotos === 1 ? 'it' : 'them'} again in Media. `
      : '';
  return {
    id: newId('msg'),
    role: 'assistant',
    text:
      `I brought “${summary.title}” into the new studio: ${what}. The new studio draws each page as one image with your characters on model. ` +
      dropped +
      (summary.words ? 'Want me to read the script and plan the pages, or change anything first?' : 'Tell me what the comic is about and I’ll plan it with you.'),
    at: Date.now(),
    suggestions: summary.words ? ['Read the script and plan the pages', ...suggestNextSteps(doc).slice(0, 2)] : suggestNextSteps(doc)
  };
};


// ── Reader languages ─────────────────────────────────────────────────────────

export interface ReaderLanguage {
  code: string;
  endonym: string;
  english: string;
  complete: boolean;
  isSource: boolean;
}

const languageEntry = (doc: ComicDoc, code: string, isSource: boolean): ReaderLanguage => {
  const spec = languageSpec(code);
  let complete = true;
  if (!isSource) {
    const p = editionProgress(doc, code);
    complete = p.missing + p.stale + p.staleEdited === 0;
  }
  return { code, endonym: spec?.endonym || code, english: spec?.english || code, complete, isSource };
};

/** The languages a reader can switch between: the source first, then the editions present in `doc`. */
export const readerLanguages = (doc: ComicDoc, allow?: readonly string[]): ReaderLanguage[] => {
  const source = doc.format.language;
  const editions = Object.keys(i18nOf(doc).editions).filter((code) => !sameLanguage(code, source) && (!allow || allow.includes(code)));
  return [languageEntry(doc, source, true), ...editions.map((code) => languageEntry(doc, code, false))];
};

/** `?lang=` as a known edition of this doc (the source language ⇒ undefined: nothing to localize). */
const pickLang = (raw: unknown, languages: ReaderLanguage[]): string | undefined => {
  if (typeof raw !== 'string' || !raw || raw.length > 20) return undefined;
  const hit = languages.find((l) => !l.isSource && sameLanguage(l.code, raw));
  return hit?.code;
};

/** Owner preview: art the owner may not be served is withheld (placeholder), never signed. */
const withholdBlocked = (doc: ComicDoc, blocked: Set<string>): ComicDoc => {
  if (!blocked.size) return doc;
  const strip = (render: RenderState): RenderState => {
    if (!render?.asset?.path || !blocked.has(render.asset.path)) return render;
    const { asset: _asset, ...rest } = render;
    return { ...rest, withheld: 'safety' };
  };
  return { ...doc, pages: doc.pages.map((p) => ({ ...p, render: strip(p.render) })), cover: { ...doc.cover, render: strip(doc.cover.render) } };
};

// ── Routers ──────────────────────────────────────────────────────────────────

export function createComicRouter(deps: ComicRouterDeps = {}): Router {
  const router = Router();
  const store = lazy(() => deps.store || createSupabaseDocStore());
  const assets = lazy(() => deps.assets || createSupabaseAssetStore());
  const heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  const moderationGate = deps.requireActive ?? requireActiveUser();
  /**
   * The moderation gate, plus one structured line when it answers the request itself
   * (suspended → 403) so the refusal leaves a trace like every other one.
   */
  const requireActive: RequestHandler = (req, res, next) => {
    let passed = false;
    const streamRoute = req.params?.id !== undefined;
    res.once('finish', () => {
      if (passed || res.statusCode < 400) return;
      const fields = { code: res.statusCode === 403 ? 'FORBIDDEN' : 'MODERATION', status: res.statusCode, reason: 'moderation' };
      if (streamRoute) logRefusal(req, 'pre_stream', { ...fields, ...bodyShape(req.body) });
      else logRequestRefused(req, fields);
    });
    moderationGate(req, res, (err?: unknown) => {
      passed = true;
      next(err as Parameters<NextFunction>[0]);
    });
  };
  /** Owner-route handler: a StudioError refusal (401/400/404/…) leaves one structured log line. */
  const owned = (fn: (req: Request, res: Response) => Promise<unknown>) =>
    handle(fn, (req, err) => {
      if (err.code !== 'CANCELLED') logRequestRefused(req, { code: err.code, status: err.status });
    });
  const safety: RouteSafetyDeps = {
    cooldownFor: deps.safety?.cooldownFor ?? cooldownFor,
    screenTurnInput: deps.safety?.screenTurnInput ?? screenTurnInput,
    respondBlocked: deps.safety?.respondBlocked ?? respondBlocked
  };
  const intentFor = deps.routeIntent ?? routeIntent;

  const sessionFor = async (req: Request): Promise<StudioSession> => getStudioSession(projectIdParam(req), requireUser(req), store());

  const keysFor = (req: Request) => {
    const contextDeps = deps.contextDeps?.(req) || {};
    const keys = contextDeps.keys || studioKeysFromRequest(req);
    return { contextDeps, keys, byok: spendIsByok(keys) };
  };

  const usageFor = deps.usageFor ?? (deps.capsDeps ? undefined : defaultUsageFor);
  const capsFor = async (req: Request, byok: boolean): Promise<StudioCaps> => {
    let caps: StudioCaps;
    try {
      caps = await studioCapsFor(req, { byok }, deps.capsDeps);
    } catch (err) {
      // studioCapsFor never throws by design; this is the belt to its braces.
      logger.warn('comic_caps_failed', { userId: req.user?.id, message: (err as Error)?.message });
      caps = { ...DEFAULT_CAPS, byok };
    }
    // Comic History (server env COMIC_HISTORY): off adds nothing to the caps.
    caps = withHistoryCaps(caps, historyRoutesEnabled());
    // Usage left (percentages only): the header meter and every price the server words for this user.
    const usage = usageFor && req.user?.id ? await usageFor(req.user.id, caps).catch(() => undefined) : undefined;
    return usage ? { ...caps, usage } : caps;
  };
  const fastIntents = deps.fastIntents ?? FAST_INTENTS_ENV;
  const backfill = deps.backfillVariants ?? true;

  /** Sign what the studio shows right away: displayAssetPaths, minus anything blocked. */
  const signDisplay = (doc: ComicDoc) => signAssetPaths(assets(), servablePaths(doc, displayAssetPaths(doc)), { projectId: doc.id, via: 'display' });

  router.get('/models', (_req, res) => {
    res.json({ models: IMAGE_MODELS, tiers: TIER_PRESETS, presets: STYLE_PRESETS });
  });

  router.post(
    '/projects',
    requireActive,
    owned(async (req, res) => {
      const userId = requireUser(req);
      const body = isObject(req.body) ? req.body : {};
      const projectId = randomUUID();
      let doc = createEmptyDoc(projectId, str(body.title, 200) || 'Untitled comic');
      /** Private copies made for an import: removed again if the comic is never created. */
      let importedPaths: string[] = [];
      const importFrom = typeof body.importFromProjectId === 'string' ? body.importFromProjectId.trim() : '';
      // "Open in the new studio" from one classic snapshot kept on the server (history H6; only while it is on).
      const fromVersionId = importFrom && historyRoutesEnabled() ? parseFromVersionId(body.fromVersionId) : undefined;
      if (importFrom) {
        if (!PROJECT_ID.test(importFrom)) throw new StudioError('NOT_FOUND', "That project doesn't exist or you don't have access to it.", { status: 404 });
        // One classic import per user at a time: each can re-encode up to ~105 photos through the
        // process-wide image slots, so parallel imports must never multiply that work (the UI already
        // sends one at a time; this holds for forged or multi-tab requests too).
        if (importingUsers.has(userId)) {
          throw new StudioError('CONFLICT', 'Another story is still being brought into the new studio — try again in a moment.', { status: 409 });
        }
        importingUsers.add(userId);
        try {
          const legacy = fromVersionId ? await legacyVersionImport(userId, importFrom, fromVersionId) : await store().loadLegacyState(importFrom, userId);
          if (!legacy) throw new StudioError('NOT_FOUND', "That project doesn't exist or you don't have access to it.", { status: 404 });
          if (legacy.state?.studioVersion === 4) throw new StudioError('BAD_REQUEST', 'That comic is already in the new studio.', { status: 400 });
          const { ops: mapped, summary } = legacyImportOps(legacy, userId);
          // Classic photos are client-writable objects: re-encode each into this comic's private ref lane (S6).
          const rehomed = await rehomeLegacyRefs(mapped, { userId, projectId, assets: assets() });
          if (rehomed.kept || rehomed.dropped) logger.info('comic_import_refs', { projectId, kept: rehomed.kept, dropped: rehomed.dropped });
          const ops = rehomed.ops;
          importedPaths = rehomed.stored;
          if (str(body.title, 200)) ops.push({ op: 'brief', patch: { title: str(body.title, 200) } });
          doc = applyOps(doc, ops);
          doc = applyOps(doc, [{ op: 'message', msg: importWelcome({ ...summary, title: doc.brief.title }, doc, rehomed.dropped) }]);
        } finally {
          importingUsers.delete(userId);
        }
      }
      // A storybook starts with its free title and "The End" plates (timeline §2: create only).
      const kind = typeof body.kind === 'string' && (COMIC_KINDS as readonly string[]).includes(body.kind) ? (body.kind as ComicKind) : undefined;
      if (kind) {
        const kindOps: DocOp[] = [{ op: 'format', patch: { kind } }];
        if (kind === 'storybook') kindOps.push({ op: 'book', patch: { titlePage: true, endPage: true } });
        doc = applyOps(doc, kindOps);
      }
      const { byok } = keysFor(req);
      const created = store()
        .create({ projectId, userId, doc })
        .catch((err: unknown) => {
          if (importedPaths.length) void assets().remove(importedPaths).catch(() => undefined);
          throw err;
        });
      const [caps] = await Promise.all([capsFor(req, byok), created]);
      // Comic History: the new comic's "Brought into the new studio" moment links its classic project (H6). Never throws.
      if (importFrom) notifyImported({ projectId, userId, doc, fromProjectId: importFrom, ...(fromVersionId ? { fromVersionId } : {}) });
      logger.info('comic_project_created', { projectId, imported: !!importFrom, ...(kind ? { kind } : {}) });
      res.set('Cache-Control', 'private, no-store');
      res.status(201).json({ projectId, doc, urls: await signDisplay(doc), caps });
    })
  );

  router.get(
    '/projects/:id',
    owned(async (req, res) => {
      const session = await sessionFor(req);
      const { byok } = keysFor(req);
      const [caps, urls] = await Promise.all([capsFor(req, byok), signDisplay(session.doc)]);
      // Older images get their 480w/1080w variants in the background (≤ 40, one at a time; once per session).
      if (backfill) {
        void scheduleVariantBackfill(session, assets(), {
          onUrls: async (paths) => {
            const signed = await signAssetPaths(assets(), servablePaths(session.doc, paths), { projectId: session.projectId, via: 'variants' });
            if (Object.keys(signed).length) session.emit({ type: 'urls', urls: signed });
          }
        });
      }
      res.set('Cache-Control', 'private, no-store');
      res.json({ doc: session.doc, urls, caps });
    })
  );

  router.post(
    '/projects/:id/cancel',
    owned(async (req, res) => {
      const session = await sessionFor(req);
      const stopped = stopSessionWork(session);
      logger.info('comic_stop', { requestId: req.requestId, projectId: session.projectId, stopped });
      res.json({ ok: true });
    })
  );

  router.post(
    '/projects/:id/urls',
    owned(async (req, res) => {
      const session = await sessionFor(req);
      const raw = isObject(req.body) && Array.isArray(req.body.paths) ? req.body.paths : null;
      if (!raw) throw new StudioError('BAD_REQUEST', 'Send the paths to sign.', { status: 400 });
      // Allow-list: every path the doc references (history, archive and trash included), minus
      // anything with a blocked verdict. Foreign paths are silently absent from the answer.
      const allowed = new Set(servablePaths(session.doc, collectAssetPaths(session.doc)));
      const paths = [...new Set(raw.slice(0, MAX_URL_PATHS * 4).filter((p): p is string => typeof p === 'string' && allowed.has(p)))].slice(0, MAX_URL_PATHS);
      res.set('Cache-Control', 'private, no-store');
      res.json({ urls: await signAssetPaths(assets(), paths, { projectId: session.projectId, via: 'urls' }) });
    })
  );

  router.post('/projects/:id/stream', requireActive, (req, res, next) => {
    void stream(req, res).catch((err) => {
      if (res.headersSent) {
        logger.error('comic_stream_unhandled', { requestId: req.requestId, projectId: loggableId(req.params.id), message: (err as Error)?.message });
        if (!res.writableEnded) res.end();
        return;
      }
      if (err instanceof StudioError) logRefusal(req, 'pre_stream', { code: err.code, status: err.status, ...bodyShape(req.body) });
      httpError(res, err, next);
    });
  });

  async function stream(req: Request, res: Response) {
    const userId = requireUser(req);
    const request = parseStreamRequest(req.body);
    const session = await sessionFor(req);
    const shape: Pick<RefusalLog, 'kind' | 'action'> =
      request.kind === 'message' ? { kind: 'message' } : { kind: 'action', action: request.action.type };
    const restricted = moderationOf(res) === 'restricted';

    // A Stop from an earlier turn no longer applies to this request: clear it BEFORE any
    // upload, so a Stop pressed from now on — during the upload or during the turn — cancels
    // THIS request instead of being undone later. The turn signal is per request so a Stop that
    // lands mid-upload is honored once the stream opens (below). A message that will run gets
    // its own Stop scope (openStopScope, below): Stop during its turn leaves earlier drawing alone.
    // A dropped connection is NOT a Stop: a phone's network blip or an app switch closes the
    // socket, but the user still wants their answer. The turn finishes and commits its reply
    // (bounded by the director's tool rounds and the model timeout), the client's resync picks
    // it up, and only the writes to the dead socket are skipped (`send` checks the socket).
    if (session.abort.signal.aborted) session.resetAbort();
    const turnAbort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) logger.info('comic_stream_client_gone', { requestId: req.requestId, projectId: session.projectId, ...shape });
    });

    // Refusals that persist nothing: busy → cooldown → restricted account.
    let refusal: { code: string; message: string } | null = null;
    if (request.kind === 'message' && session.turnRunning) refusal = { code: 'BUSY', message: BUSY_MESSAGE };
    // From here to the end of the request (every path closes it): a message that will run is a
    // director turn in flight for Stop, under its own controller (see StopScope).
    const stops = openStopScope(session, request.kind === 'message' && !refusal);
    const sessionSignal = session.abort.signal;
    if (!refusal && isCostlyRequest(request)) {
      const cooldown = await safety.cooldownFor(userId).catch((err) => {
        logger.warn('comic_cooldown_lookup_failed', { userId, message: (err as Error)?.message });
        return null;
      });
      if (cooldown && cooldown.until > Date.now()) refusal = { code: 'COOLDOWN', message: cooldownMessage(cooldown.until) };
    }
    if (!refusal && restricted) {
      const message = restrictedRefusal(request);
      if (message) refusal = { code: 'FORBIDDEN', message };
    }

    let ctx: OrchestratorContext | null = null;
    let prepared: PreparedMessage | null = null;
    if (!refusal) {
      try {
        const { contextDeps, keys, byok } = keysFor(req);
        const [caps, access] = await Promise.all([
          capsFor(req, byok),
          (deps.qualityAccess || checkQualityAccess)(req, 'pro', byok).catch(() => ({ ok: true as const }))
        ]);
        const rating: ContentRating = effectiveRating(session.doc, caps.ratingCeiling).rating;
        ctx = createStudioContext({
          req,
          session,
          signalFrom: turnAbort.signal,
          deps: { ...contextDeps, keys, assets: contextDeps.assets || assets() },
          caps,
          rating,
          ...(access.ok === false ? { qualityDenied: access.message } : {}),
          ...(restricted ? { spendBlocked: RESTRICTED_SPEND_MESSAGE } : {})
        });
        // History's director tools resolve "this morning" in the sender's zone (turnTimeZone of the history hooks).
        rememberTurnTimeZone(ctx, request.tz);
        // Attachments are validated (and legacy images stored) before the stream opens, so a
        // bad file or a stale inbox path is a plain 400 with nothing persisted.
        if (request.kind === 'message') {
          prepared = await prepareMessage(request, ctx);
          const answer = parseOptionAnswer(isObject(req.body) ? req.body.card : undefined);
          if (answer) prepared.answer = answer;
        }
      } catch (err) {
        stops.close();
        throw err;
      }
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const send = (event: StudioEvent) => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(`event: ${event.type}\ndata: ${encodeStudioEvent(event)}\n\n`);
      } catch {
        /* socket already closed */
      }
    };
    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(': keep-alive\n\n');
      } catch {
        /* socket already closed */
      }
    }, heartbeatMs);
    heartbeat.unref?.();

    send({ type: 'hello', rev: session.doc.rev, turnId: newId('turn') });
    const unsubscribe = session.subscribe(send);

    // The director loop and the queued renders stop only when the user presses Stop (closing the
    // tab stops nothing, see above). A Stop that landed during the upload already aborted
    // turnAbort's source signal above, so honor it now instead of resetting it; otherwise listen
    // for a Stop during the turn.
    const onSessionAbort = () => turnAbort.abort();
    if (sessionSignal.aborted) turnAbort.abort();
    else sessionSignal.addEventListener('abort', onSessionAbort, { once: true });

    const startSpend = session.doc.spend.totalUsd;
    const startEntries = new Set(session.doc.spend.entries.map((e) => e.id));
    try {
      if (refusal || !ctx) {
        logRefusal(req, 'stream', { code: refusal?.code || 'INTERNAL', ...shape });
        send({ type: 'error', message: refusal?.message || 'Something went wrong. Please try again.', code: refusal?.code || 'INTERNAL' });
        return;
      }
      const turnCtx = ctx;
      try {
        if (request.kind === 'message') {
          try {
            await session.runExclusive(() => runMessage(req, turnCtx, prepared!, shape));
          } finally {
            // The turn is over (its reply is in): from now on Stop is "Stop drawing" for its renders.
            stops.endTurn();
          }
        } else {
          let action = request.action;
          // Free text a user typed into an action (edit instruction, plan notes, style directions) goes
          // through the SAME screen as a chat message — prefilter, capped classifier, strikes, cooldown,
          // restriction — before anything is gated, queued or spent (S15). Director-issued actions come
          // from already-screened messages and never pass through here.
          const inputText = actionInputText(session.doc, action);
          if (inputText) {
            let screened: ScreenResult;
            try {
              screened = await safety.screenTurnInput(turnCtx, {
                text: inputText,
                attachments: [],
                rating: turnCtx.rating ?? effectiveRating(session.doc, turnCtx.caps?.ratingCeiling).rating
              });
            } catch (err) {
              if (err instanceof StudioError && err.code === 'CANCELLED') throw err;
              logger.warn('comic_screen_failed_open', { requestId: req.requestId, projectId: session.projectId, action: action.type, message: (err as Error)?.message });
              screened = ALLOW;
            }
            if (screened.decision === 'block') {
              logRefusal(req, 'stream', { code: 'CONTENT_POLICY', status: 422, ...shape, categories: screened.categories, strike: screened.strike });
              const crisis = typeof screened.note === 'string' && screened.note.includes(CRISIS_LINE) ? ` ${CRISIS_LINE}` : '';
              throw new StudioError('CONTENT_POLICY', `${ACTION_BLOCKED_MESSAGE}${crisis}`, { status: 422 });
            }
            // An adapt verdict draws the edit as the safer take (softened wording + the safe-take line).
            if (screened.decision === 'adapt' && action.type === 'edit_page') action = { ...action, safe: true };
          }
          const runnable = action;
          // A `cancel` action is the same Stop as POST /cancel (scoped; see StopScope).
          if (runnable.type === 'cancel') stopSessionWork(session);
          // A click on a spend button IS the confirmation; the budget cap still applies.
          const run = () =>
            runAction(turnCtx, runnable, {
              confirmed: isSpendAction(runnable) || runnable.type === 'approve_gate',
              ...(turnCtx.caps ? { caps: turnCtx.caps } : {}),
              // A UI click: its edits undo as the user's own (contract §7 ops origin).
              origin: 'user'
            });
          if (runnable.type === 'plan_pages') await session.runExclusive(run);
          else await run();
        }
      } catch (err) {
        const error = err instanceof StudioError ? err : null;
        if (!error) logger.error('comic_stream_failed', { requestId: req.requestId, projectId: session.projectId, message: (err as Error)?.message });
        else if (error.code !== 'CANCELLED') logger.info('comic_stream_error', { requestId: req.requestId, projectId: session.projectId, userId, code: error.code, status: error.status, ...shape });
        if (error?.code !== 'CANCELLED') {
          // Every error event carries a code (the client tailors its copy: COOLDOWN, CONTENT_POLICY, LIMIT…).
          send({ type: 'error', message: error?.userMessage || 'Something went wrong. Please try again.', code: error?.code ?? 'INTERNAL' });
        }
      }
      // Keep the stream open until every render this request started has settled.
      await turnCtx.settled();
      const notices = consumeAllowanceNotices(req);
      if (notices.length) {
        // Never an empty assistant bubble (G7): the notice IS the message.
        const text = notices.map((n) => String(n.message || '').trim()).filter(Boolean).join(' ');
        if (text) session.commit([{ op: 'message', msg: { id: newId('msg'), role: 'assistant', text, at: Date.now() } }]);
      }
    } finally {
      sessionSignal.removeEventListener('abort', onSessionAbort);
      stops.close();
      await session.flush();
      // What software saved this request (free reuse instead of a paid redraw): the "Saved by software" toast.
      const savedUsd = round4(session.doc.spend.entries.reduce((sum, e) => (startEntries.has(e.id) ? sum : sum + (e.savedUsd || 0)), 0));
      send({ type: 'done', rev: session.doc.rev, spentUsd: round4(Math.max(0, session.doc.spend.totalUsd - startSpend)), ...(savedUsd > 0 ? { savedUsd } : {}) });
      unsubscribe();
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  }

  /**
   * One user message, under the session lock: safety screen → (blocked: deterministic reply,
   * no model call) → quick-assign → free intent router (no model call) → director.
   */
  async function runMessage(req: Request, ctx: OrchestratorContext, prepared: PreparedMessage, shape: Pick<RefusalLog, 'kind' | 'action'>) {
    const session = ctx.session;
    const rating = ctx.rating ?? effectiveRating(session.doc, ctx.caps?.ratingCeiling).rating;
    let screened: ScreenResult;
    try {
      screened = await safety.screenTurnInput(ctx, {
        text: prepared.text,
        attachments: prepared.attachments,
        rating,
        ...(prepared.sourceText ? { sourceText: prepared.sourceText } : {})
      });
    } catch (err) {
      if (err instanceof StudioError && err.code === 'CANCELLED') throw err;
      logger.warn('comic_screen_failed_open', { requestId: req.requestId, projectId: ctx.projectId, message: (err as Error)?.message });
      screened = ALLOW;
    }
    const blockedPaths = new Set(screened.blockedAttachmentPaths || []);
    const inboxRemovals = (keep: (path: string) => boolean) => [...prepared.inboxOps.entries()].filter(([path]) => keep(path)).map(([, op]) => op);

    if (screened.decision === 'block') {
      // Nothing of the message is kept: hidden text, no attachments, no source script. Blocked
      // inbox images leave the inbox (the safety module holds them); the rest stay to resend.
      const userMsgId = newId('msg');
      session.commit([
        ...inboxRemovals((path) => blockedPaths.has(path)),
        { op: 'message', msg: { id: userMsgId, role: 'user', text: HIDDEN_MESSAGE_TEXT, at: Date.now() } }
      ]);
      logRefusal(req, 'stream', { code: 'CONTENT_POLICY', status: 422, ...shape, categories: screened.categories, strike: screened.strike });
      await safety.respondBlocked(ctx, { userMsgId }, screened);
      return;
    }

    // A tapped option is recorded on its card before the message is routed, so the free paths
    // (intent router, fast intents) record it as well as the director (DIR-8).
    try {
      recordOptionAnswer(session, prepared.text, prepared.answer);
    } catch (err) {
      logger.warn('comic_answer_record_failed', { requestId: req.requestId, projectId: ctx.projectId, message: (err as Error)?.message });
    }

    const attachments = prepared.attachments.filter((a) => !blockedPaths.has(a.path));
    const ops: DocOp[] = [...inboxRemovals(() => true), ...prepared.ops];
    let text = prepared.text;
    if (prepared.targets?.length) {
      // targets[i] belongs to the i-th image as sent; a blocked image is never assigned.
      const aligned = prepared.attachments.map((a, i) => (blockedPaths.has(a.path) ? null : prepared.targets![i] ?? null));
      const assigned = await applyAttachmentTargets(ctx, prepared.attachments, aligned);
      ops.push(...assigned.ops);
      if (assigned.note) text = [text, `[Photos assigned: ${assigned.note}]`].filter(Boolean).join('\n\n');
    }
    if (blockedPaths.size) text = [text, `[${blockedPaths.size === 1 ? 'One image was' : `${blockedPaths.size} images were`} removed — it didn't fit the content rules.]`].filter(Boolean).join('\n\n');
    if (ops.length) session.commit(ops);

    // Free, read-only answers ("show me the pages", "what's left?") — no model call, $0.
    // Skipped when the screen left a note for the director (adapt / IP steering).
    if (!attachments.length && screened.decision === 'allow' && !screened.note && text) {
      const cost = costFormatterFor(ctx);
      let routed: ReturnType<typeof routeIntent> = null;
      try {
        routed = intentFor(session.doc, text, { byok: spendIsByok(ctx.keys), cost });
      } catch (err) {
        logger.warn('comic_intent_failed', { requestId: req.requestId, projectId: ctx.projectId, message: (err as Error)?.message });
      }
      // A routed answer must say something (never an empty bubble); otherwise the director answers.
      if (routed && typeof routed.reply === 'string' && routed.reply.trim()) {
        const at = Date.now();
        const user: Msg = { id: newId('msg'), role: 'user', text, at };
        const reply: Msg = {
          id: newId('msg'),
          role: 'assistant',
          text: governDollars(routed.reply, cost.view),
          at: at + 1,
          ...(routed.cards.length ? { cards: routed.cards } : {}),
          ...(routed.nextSteps.length ? { nextSteps: routed.nextSteps } : {})
        };
        session.commit([
          { op: 'message', msg: user },
          { op: 'message', msg: reply }
        ]);
        logger.info('comic_intent_routed', { requestId: req.requestId, projectId: ctx.projectId, kind: routed.kind });
        return;
      }
      // Phase 2 (COMIC_FAST_INTENTS): an unambiguous structural edit runs its one FREE tool, no model call.
      if (fastIntents && (await runFastIntent(req, ctx, text))) return;
    }

    await runDirectorTurn(ctx, {
      text,
      attachments,
      sourceSaved: prepared.ops.some((o) => o.op === 'source'),
      ...(prepared.focus ? { focus: prepared.focus } : {}),
      ...(screened.note ? { safetyNote: screened.note } : {}),
      optionAnswerHandled: true
    });
  }

  /**
   * "swap pages 2 and 3", "make the shouts red", "delete page 4"… (intents.parseIntent, confidence ≥ 0.95,
   * no open gate): the matching free tool from this turn's toolset runs directly, the reply is composed by
   * software (composeTurnReply) and carries an Undo chip. Any doubt — no such tool, a tool error, a paid
   * tool — returns false BEFORE anything is committed, and the director answers instead.
   */
  async function runFastIntent(req: Request, ctx: OrchestratorContext, text: string): Promise<boolean> {
    const session = ctx.session;
    const before = session.doc;
    const parsed = parseIntent(text, before);
    if (!canFastPath(parsed, { enabled: true, attachments: 0, gateOpen: before.gate?.status === 'open' })) return false;
    const rating = ctx.rating ?? effectiveRating(before, ctx.caps?.ratingCeiling).rating;
    const turn = createDirectorTurn({ userText: text, rating, startedAt: Date.now(), runs: [], bgErrors: [] });
    const tool = buildTurnToolset(ctx, turn, toolGroups()).tools.find((t) => t.spec.function.name === parsed.tool);
    if (!tool || tool.cost !== 'free') return false;
    let output: string;
    let committed = 0;
    const unsubscribe = session.subscribe((e) => {
      if (e.type === 'ops') committed += e.ops.length;
    });
    try {
      output = await tool.execute(parsed.args);
    } catch (err) {
      logger.warn('comic_fast_intent_failed', { requestId: req.requestId, projectId: ctx.projectId, tool: parsed.tool, message: (err as Error)?.message });
      return false;
    } finally {
      unsubscribe();
    }
    const ok = !/^(Error|Refused)\b/.test(output);
    if (!ok && !committed) return false; // the director explains it better
    turn.log.push({ tool: parsed.tool, ok, cost: tool.cost, result: output.slice(0, 400), ops: committed });
    const after = session.doc;
    const at = Date.now();
    const view = costFormatterFor(ctx).view;
    const replyText = governDollars(composeTurnReply({ before, after, turn, userText: text }), view);
    const steps = [...(committed ? [{ label: 'Undo', client: { type: 'undo' as const } }] : []), ...turn.nextSteps].slice(0, DOC_LIMITS.nextSteps);
    session.commit([
      { op: 'message', msg: { id: newId('msg'), role: 'user', text, at } },
      {
        op: 'message',
        msg: {
          id: newId('msg'),
          role: 'assistant',
          text: replyText,
          at: at + 1,
          ...(turn.cards.length ? { cards: turn.cards.map((c) => governCard(c, view)) } : {}),
          ...(steps.length ? { nextSteps: steps } : {})
        }
      }
    ]);
    logger.info('comic_fast_intent', { requestId: req.requestId, projectId: ctx.projectId, tool: parsed.tool, ops: committed });
    return true;
  }

  return router;
}

// ── Public reader ────────────────────────────────────────────────────────────

export interface ComicPublicRouterDeps {
  store?: DocStore;
  assets?: AssetStore;
  /** Live + PUBLIC publication snapshot by project id (P1-PUBLISH); never unlisted. */
  loadPublicByProjectId?: (projectId: string) => Promise<PublicComicPayload | null>;
}

/**
 * GET /api/comic/public/:id (legacy `?view=read&id=` links).
 * - The owner (verified JWT) previews the live doc, sanitized, `private, no-store`; `?lang`
 *   localizes it (drafts included — it is their own comic).
 * - Everyone else gets ONLY a live + public publication snapshot (`loadPublicByProjectId`),
 *   plus `publication.slug` so old clients can replaceState to `/c/<slug>`. Unlisted,
 *   private, unpublished, suspended, unknown and malformed ids all answer the same 404 body,
 *   after the same lookups, so the status and timing reveal nothing.
 */
export function createComicPublicRouter(deps: ComicPublicRouterDeps = {}): Router {
  const router = Router();
  const store = lazy(() => deps.store || createSupabaseDocStore());
  const assets = lazy(() => deps.assets || createSupabaseAssetStore());
  const loadPublic = deps.loadPublicByProjectId ?? loadPublicByProjectId;

  const notFound = (res: Response) => {
    res.status(404).set('Cache-Control', 'no-store').json(PUBLIC_NOT_FOUND);
  };

  router.get(
    '/:id',
    handle(async (req, res) => {
      res.vary('Authorization');
      const raw = String(req.params.id || '');
      const id = PROJECT_ID.test(raw) ? raw : '';
      const viewer = req.user?.id;

      // Owner check first for every signed-in viewer (same lookups whether or not the project exists).
      let own: ComicDoc | null = null;
      if (viewer && id) {
        const live = peekStudioSession(id);
        own =
          live && live.userId === viewer && !live.isGone
            ? live.doc
            : await store()
                .load(id, viewer)
                .catch((err) => {
                  logger.warn('comic_public_owner_lookup_failed', { projectId: id, message: (err as Error)?.message });
                  return null;
                });
      }

      if (own) {
        const languages = readerLanguages(own);
        const lang = pickLang(req.query.lang, languages);
        const blocked = blockedAssetPaths(own);
        const clean = withholdBlocked(sanitizePublicDoc(lang ? localizeDoc(own, lang) : own), blocked);
        const urls = await signAssetPaths(assets(), readerAssetPaths(clean).filter((p) => !blocked.has(p)), { projectId: id, via: 'owner_preview' });
        res.set('Cache-Control', 'private, no-store');
        res.json({ doc: clean, urls, languages, preview: true, ...(lang ? { lang } : {}) });
        return;
      }

      const payload = id
        ? await loadPublic(id).catch((err) => {
            logger.warn('comic_public_load_failed', { projectId: id, message: (err as Error)?.message });
            return null;
          })
        : null;
      if (!payload || payload.publication?.visibility !== 'public') {
        notFound(res);
        return;
      }
      const languages = readerLanguages(payload.doc, payload.publication.languages);
      const lang = pickLang(req.query.lang, languages);
      // no-store like the edge /s/:slug read: an unpublish or a made-private comic must stop
      // being served at once (a browser cache would keep it for the max-age).
      res.set('Cache-Control', 'no-store');
      res.json({
        doc: lang ? localizeDoc(payload.doc, lang) : payload.doc,
        urls: payload.urls,
        publication: payload.publication,
        languages,
        ...(lang ? { lang } : {})
      });
    })
  );

  return router;
}

/** Authenticated studio API (mount at /api/comic after requireAuth). */
export const comicRouter = createComicRouter();
/** Public reader API (mount at /api/comic/public before requireAuth, with optionalAuth). */
export const comicPublicRouter = createComicPublicRouter();
