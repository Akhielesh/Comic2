// Comic History — the Supabase store (versions plan §3.2, §12; package H1). Implements HistoryStore (storeTypes.ts)
// over server/sql/comic_history.sql.
//
// Private by construction: every read filters by project_id AND user_id; every write is a SECURITY DEFINER RPC that
// takes the per-comic lock and re-checks projects.user_id (the service role may only SELECT the tables). A foreign or
// missing id behaves exactly like a missing one: reads answer null / empty, writes answer NOT_FOUND — never a hint
// that something exists in another comic.
//
// Integrity: the database verifies every chunk hash on insert; get() and chunks() re-verify on read and treat a chunk
// whose content no longer hashes to its key as missing (the version "can't be opened"; nothing else breaks).
//
// Times on the wire are epoch ms; the tables hold timestamptz. Ids are uuids (anything else is simply not found).

import type { SupabaseClient } from '@supabase/supabase-js';
import { HISTORY_LIMITS, MAX_ALTERNATIVES } from '../../../../shared/comic/limits.js';
import {
  HISTORY_KINDS,
  type AlternativeRow,
  type ChangeItem,
  type HistoryActor,
  type HistoryCodec,
  type HistoryKind,
  type Manifest,
  type VersionRow,
  type VersionStats,
  type VersionThumb
} from '../../../../shared/comic/history/types.js';
import { logger } from '../../lib/logger.js';
import { getSupabaseAdmin } from '../../services/supabase.js';
import { jsonbSafe } from '../store.js';
import { StudioError } from '../types.js';
import { CHUNK_CONTENT_MAX_BYTES, MANIFEST_MAX_BYTES, isHistoryHash, manifestHashes, parseVerifiedChunk } from './hash.js';
import { HISTORY_NOT_AVAILABLE_MESSAGE, type HistoryScope } from './hooks.js';
import type {
  ChunkInput,
  HistoryListFilter,
  HistoryListPage,
  HistoryPolicy,
  HistoryStore,
  PutResult,
  StoredVersion,
  VersionInput
} from './storeTypes.js';

// ── What both stores return: the declared storeTypes shapes with their optional fields always filled ─────────────

/** A row as the store reads it: VersionRow plus its root hash (the recorder compares roots without loading chunks). */
export interface StoredVersionRow extends VersionRow {
  rootHash: string;
}

/** head(): the line's newest row with its manifest (diffManifests without any chunk load); the declared head() row
 *  (storeTypes.ts) with rootHash and manifest always present. */
export interface HeadVersionRow extends StoredVersionRow {
  manifest: Manifest;
}

/** put() input. Kept for existing imports: VersionInput itself now declares `createdAt` (codec 'legacy' only; kept as
 *  created_at, never later than now; ignored for every other row). */
export type HistoryVersionInput = VersionInput;

/** put() answer. Kept for existing imports: PutResult itself now declares `alreadyNamed` and `name` (a named save of
 *  an unchanged moment already saved under a name is never renamed: the caller says "This moment is already saved as
 *  'Draft 1'"). */
export type HistoryPutResult = PutResult;

/** get(): a verified version with each chunk's GC roots always filled (StoredVersion.paths). A path the version's
 *  bodies mention but no chunk's `paths` lists was forgotten (V-4: a removed reference photo): restores and signing
 *  must skip it. */
export interface StoredVersionWithPaths extends StoredVersion {
  row: StoredVersionRow;
  /** hash → that chunk's `paths`. */
  paths: Map<string, string[]>;
}

/**
 * The chunks get() loads and verifies: a v5 row's manifest hashes; a classic-editor row (codec 'legacy', chunked per
 * top-level projects.state key: no v5 manifest shape) its `chunks` column. null when they cannot be read.
 */
export const versionHashes = (codec: HistoryCodec, manifest: Manifest, chunks: unknown): string[] | null => {
  if (codec === 'legacy') {
    const list = Array.isArray(chunks) ? chunks.filter((h): h is string => typeof h === 'string') : [];
    return list.length && list.every(isHistoryHash) ? [...new Set(list)].sort() : null;
  }
  try {
    const hashes = manifestHashes(manifest);
    return hashes.length && hashes.every(isHistoryHash) ? hashes : null;
  } catch {
    return null;
  }
};

/** Every GC root of a verified version (the union of its chunks' `paths`). */
export const versionPaths = (version: StoredVersion): Set<string> => {
  const paths = version.paths;
  return new Set(paths ? [...paths.values()].flat() : []);
};

// ── Errors ───────────────────────────────────────────────────────────────────

/** What the RPCs raise (comic_history.sql header) and the fake throws the same way. */
export type HistoryErrorToken =
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'MISSING_CHUNKS'
  | 'LIMIT:named'
  | 'LIMIT:saves_per_hour'
  | 'LIMIT:alternatives'
  | 'REFUSED:newest'
  | 'REFUSED:head'
  | 'REFUSED:not_named'
  | 'REFUSED:classic'
  | 'REFUSED:active'
  | 'INVALID'
  | 'TOO_LARGE'
  | 'HASH';

/** User-facing words (plain; never a git word). */
export const HISTORY_STORE_MESSAGES: Readonly<Record<HistoryErrorToken, string>> = {
  FORBIDDEN: "That moment isn't in this comic's history.",
  NOT_FOUND: "That moment isn't in this comic's history.",
  MISSING_CHUNKS: "History couldn't save this moment just now. Nothing in your comic changed.",
  'LIMIT:named': `This comic already has ${HISTORY_LIMITS.namedRows} saved versions. Remove one to save another.`,
  'LIMIT:saves_per_hour': "You've saved a lot of versions in the last hour. Try again in a little while — History keeps saving automatically meanwhile.",
  'LIMIT:alternatives': `You can try up to ${MAX_ALTERNATIVES} versions of a comic at once, counting the original. Remove one to start another.`,
  'REFUSED:newest': "The latest moment can't be removed.",
  'REFUSED:head': "This moment is where a version you're trying is kept, so it can't be removed.",
  'REFUSED:not_named': 'Only versions you saved or named can be removed. Automatic moments are tidied up for you.',
  'REFUSED:classic': "Snapshots from the classic editor are kept safely, so they can't be removed.",
  'REFUSED:active': "Switch to another version before removing this one.",
  INVALID: "History couldn't read that request. Nothing in your comic changed.",
  TOO_LARGE: "This comic is too large to save in History right now. Nothing in your comic changed.",
  HASH: "History couldn't save this moment just now. Nothing in your comic changed."
};

/** The StudioError for a history store refusal (shared by the Supabase store and the fake). */
export const historyStoreError = (token: HistoryErrorToken, cause?: unknown): StudioError => {
  const message = HISTORY_STORE_MESSAGES[token];
  switch (token) {
    case 'FORBIDDEN':
    case 'NOT_FOUND':
      return new StudioError('NOT_FOUND', message, { status: 404, cause });
    case 'MISSING_CHUNKS':
      return new StudioError('CONFLICT', message, { status: 409, retryable: true, cause });
    case 'LIMIT:saves_per_hour':
      return new StudioError('LIMIT', message, { status: 429, retryable: true, cause });
    case 'LIMIT:named':
    case 'LIMIT:alternatives':
    case 'TOO_LARGE':
      return new StudioError('LIMIT', message, { status: 409, cause });
    case 'REFUSED:newest':
    case 'REFUSED:head':
    case 'REFUSED:not_named':
    case 'REFUSED:classic':
    case 'REFUSED:active':
      return new StudioError('CONFLICT', message, { status: 409, cause });
    case 'INVALID':
      return new StudioError('BAD_REQUEST', message, { status: 400, cause });
    default:
      return new StudioError('INTERNAL', message, { status: 500, cause });
  }
};

type PgError = { code?: string; message?: string; details?: string; hint?: string };
const pgCode = (err: unknown): string => String((err as PgError)?.code || '').toUpperCase();
const pgMessage = (err: unknown): string => String((err as PgError)?.message || '');

const TOKENS: HistoryErrorToken[] = [
  'MISSING_CHUNKS', 'LIMIT:named', 'LIMIT:saves_per_hour', 'LIMIT:alternatives', 'REFUSED:newest', 'REFUSED:head',
  'REFUSED:not_named', 'REFUSED:classic', 'REFUSED:active', 'FORBIDDEN', 'NOT_FOUND', 'INVALID'
];

/** A database / PostgREST error as a StudioError (and one log line). */
export const mapHistoryDbError = (err: unknown, action: string): StudioError => {
  if (err instanceof StudioError) return err;
  const code = pgCode(err);
  const message = pgMessage(err);
  const token = TOKENS.find((t) => message.includes(`COMIC_HISTORY_${t}`));
  if (token) return historyStoreError(token, err);
  const missing = code === '42P01' || code === 'PGRST205' || code === '42883' || code === 'PGRST202';
  logger.error('comic_history_store_error', { action, code, message: message.slice(0, 300), hint: missing ? 'apply server/sql/comic_history.sql' : undefined });
  if (missing) return new StudioError('NOT_AVAILABLE', HISTORY_NOT_AVAILABLE_MESSAGE, { status: 503, cause: err });
  if (code === '22000') return historyStoreError('HASH', err);
  if (code === '40001' || code === '40P01' || code === '55P03') {
    return new StudioError('CONFLICT', HISTORY_STORE_MESSAGES.MISSING_CHUNKS, { status: 409, retryable: true, cause: err });
  }
  return new StudioError('INTERNAL', "History isn't reachable right now. Nothing in your comic changed.", { status: 503, retryable: true, cause: err });
};

// ── Shapes ───────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const toMs = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
};
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : undefined);

const ACTORS: readonly HistoryActor[] = ['you', 'ai', 'editor', 'system'];
const KINDS = new Set<string>(HISTORY_KINDS);

const statsOf = (v: unknown): VersionStats => {
  const s = isRecord(v) ? v : {};
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((y): y is string => typeof y === 'string') : []);
  const out: VersionStats = {
    pages: int(s.pages) ?? 0,
    drawn: int(s.drawn) ?? 0,
    lines: int(s.lines) ?? 0,
    langs: list(s.langs),
    models: list(s.models)
  };
  if (isRecord(s.spend) && typeof s.spend.usd === 'number') {
    out.spend = { usd: s.spend.usd, byok: s.spend.byok === true, estimated: s.spend.estimated === true };
  }
  return out;
};

/** A comic_versions row (PostgREST select or comic_history_row_json) as the wire VersionRow (+ rootHash). */
export const versionRowFromDb = (r: Record<string, unknown>): StoredVersionRow => {
  const row: StoredVersionRow = {
    id: String(r.id),
    kind: (KINDS.has(String(r.kind)) ? r.kind : 'edits') as HistoryKind,
    actor: (ACTORS.includes(r.actor as HistoryActor) ? r.actor : 'system') as HistoryActor,
    label: typeof r.label === 'string' ? r.label : '',
    pinned: r.pinned === true,
    rev: int(r.rev) ?? 0,
    contentAt: toMs(r.content_at) ?? 0,
    createdAt: toMs(r.created_at) ?? 0,
    alternativeId: str(r.alternative_id) ?? null,
    codec: (r.codec === 'legacy' ? 'legacy' : 'v5') as HistoryCodec,
    changes: Array.isArray(r.changes) ? (r.changes as ChangeItem[]) : [],
    thumbs: Array.isArray(r.thumbs) ? (r.thumbs as VersionThumb[]) : [],
    stats: statsOf(r.stats),
    rootHash: typeof r.root_hash === 'string' ? r.root_hash : ''
  };
  const name = str(r.name);
  if (name) row.name = name;
  const note = str(r.note);
  if (note) row.note = note;
  const keepUntil = toMs(r.keep_until);
  if (keepUntil !== undefined) row.keepUntil = keepUntil;
  const parentId = str(r.parent_id);
  if (parentId) row.parentId = parentId;
  const undoId = str(r.undo_id);
  if (undoId) row.undoId = undoId;
  const modelId = str(r.model_id);
  if (modelId) row.modelId = modelId;
  const publishedRev = int(r.published_rev);
  if (publishedRev !== undefined) row.publishedRev = publishedRev;
  if (isRecord(r.legacy_ref)) {
    const legacy: NonNullable<VersionRow['legacy']> = {};
    const snapshotId = str(r.legacy_ref.snapshotId);
    const reason = str(r.legacy_ref.reason);
    const projectId = str(r.legacy_ref.projectId);
    if (snapshotId) legacy.snapshotId = snapshotId;
    if (reason) legacy.reason = reason;
    if (projectId) legacy.projectId = projectId;
    row.legacy = legacy;
  }
  return row;
};

/** A comic_alternatives row as the wire AlternativeRow. */
export const alternativeRowFromDb = (r: Record<string, unknown>): AlternativeRow => {
  const row: AlternativeRow = {
    id: String(r.id),
    name: typeof r.name === 'string' ? r.name : '',
    active: r.is_active === true,
    createdAt: toMs(r.created_at) ?? 0,
    updatedAt: toMs(r.updated_at) ?? 0
  };
  const from = str(r.from_version_id);
  if (from) row.fromVersionId = from;
  const head = str(r.head_version_id);
  if (head) row.headVersionId = head;
  return row;
};

// ── Request shaping (shared with the fake, so both refuse and trim alike) ─────────────────────────────────────────

const LABEL_CHARS = HISTORY_LIMITS.labelChars;
const CHANGES_MAX_BYTES = 16_384;
/** comic_versions.changes / thumbs caps (HISTORY_LIMITS.changesPerRow / thumbsPerRow, and the column's byte check). */
export const trimChanges = (changes: ChangeItem[] | undefined): ChangeItem[] => {
  const out = Array.isArray(changes) ? changes.slice(0, HISTORY_LIMITS.changesPerRow) : [];
  while (out.length && Buffer.byteLength(JSON.stringify(out), 'utf8') > CHANGES_MAX_BYTES) out.pop();
  return out;
};

const policyOf = (policy?: Partial<HistoryPolicy>) => ({
  unpinnedRows: policy?.unpinnedRows ?? HISTORY_LIMITS.unpinnedRows,
  bytesPerComic: policy?.bytesPerComic ?? HISTORY_LIMITS.bytesPerComic,
  namedRows: HISTORY_LIMITS.namedRows,
  savesPerHour: HISTORY_LIMITS.savesPerHour,
  beforeRestoreDays: HISTORY_LIMITS.beforeRestoreDays,
  ...(policy || {})
});

/** Epoch ms the database accepts as a time (1970..2286); anything else is no time at all. */
export const isEpochMs = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e13;

/**
 * Validate and normalize a put (both stores): hashes, kinds, sizes and caps. Throws INVALID / TOO_LARGE; never
 * modifies the caller's objects. The chunk list is deduped by hash. `createdAt` survives only on a classic snapshot.
 */
export const preparePut = (version: VersionInput, chunks: ChunkInput[]): { version: VersionInput; chunks: ChunkInput[] } => {
  if (!isRecord(version) || !KINDS.has(version.kind) || !ACTORS.includes(version.actor) || !isHistoryHash(version.rootHash) || !isRecord(version.manifest)) {
    throw historyStoreError('INVALID');
  }
  const codec: HistoryCodec = version.codec === 'legacy' ? 'legacy' : 'v5';
  const hashes = [...new Set([...(Array.isArray(version.chunks) ? version.chunks : []), ...(codec === 'v5' ? manifestHashes(version.manifest) : [])])];
  if (!hashes.length || !hashes.every(isHistoryHash)) throw historyStoreError('INVALID');
  if (Buffer.byteLength(JSON.stringify(version.manifest), 'utf8') > MANIFEST_MAX_BYTES) throw historyStoreError('TOO_LARGE');
  const maxBytes = codec === 'legacy' ? 4 * CHUNK_CONTENT_MAX_BYTES : CHUNK_CONTENT_MAX_BYTES;
  const seen = new Set<string>();
  const outChunks: ChunkInput[] = [];
  for (const c of Array.isArray(chunks) ? chunks : []) {
    if (!isRecord(c) || !isHistoryHash(c.hash) || typeof c.content !== 'string') throw historyStoreError('INVALID');
    if (seen.has(c.hash)) continue;
    seen.add(c.hash);
    if (Buffer.byteLength(c.content, 'utf8') > maxBytes) throw historyStoreError('TOO_LARGE');
    outChunks.push({
      hash: c.hash,
      kind: String(c.kind || 'chunk').slice(0, 24),
      content: c.content,
      paths: Array.isArray(c.paths) ? c.paths.filter((p): p is string => typeof p === 'string') : []
    });
  }
  const name = typeof version.name === 'string' ? version.name.trim().slice(0, HISTORY_LIMITS.nameChars) : '';
  const note = typeof version.note === 'string' ? version.note.trim().slice(0, HISTORY_LIMITS.noteChars) : '';
  const out: VersionInput = {
    ...version,
    codec,
    label: String(version.label ?? '').slice(0, LABEL_CHARS),
    name: name || undefined,
    note: note || undefined,
    rev: Number.isFinite(version.rev) ? Math.max(0, Math.trunc(version.rev)) : 0,
    contentAt: Number.isFinite(version.contentAt) ? version.contentAt : Date.now(),
    chunks: hashes.sort(),
    changes: trimChanges(version.changes),
    thumbs: Array.isArray(version.thumbs) ? version.thumbs.slice(0, HISTORY_LIMITS.thumbsPerRow) : []
  };
  for (const k of ['parentId', 'undoId'] as const) if (out[k] !== undefined && !isUuid(out[k])) delete out[k];
  if (out.publishedRev !== undefined) {
    if (Number.isFinite(out.publishedRev)) out.publishedRev = Math.trunc(out.publishedRev);
    else delete out.publishedRev;
  }
  if (out.keepUntil !== undefined && !Number.isFinite(out.keepUntil)) delete out.keepUntil;
  if (codec !== 'legacy' || !isEpochMs(out.createdAt)) delete out.createdAt;
  if (out.alternativeId !== undefined && out.alternativeId !== null && !isUuid(out.alternativeId)) throw historyStoreError('NOT_FOUND');
  return { version: out, chunks: outChunks };
};

// ── Cursor ───────────────────────────────────────────────────────────────────

const ISO_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

/** An opaque list cursor: the last row's (content_at, id). */
export const encodeHistoryCursor = (contentAt: string, id: string): string => Buffer.from(JSON.stringify([contentAt, id]), 'utf8').toString('base64url');
export const decodeHistoryCursor = (cursor: unknown): { contentAt: string; id: string } | null => {
  if (typeof cursor !== 'string' || !cursor || cursor.length > 200) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && ISO_RE.test(v[0]) && typeof v[1] === 'string' && v[1].length <= 64) {
      return { contentAt: v[0], id: v[1] };
    }
  } catch {
    /* not a cursor */
  }
  return null;
};

export const HISTORY_LIST_DEFAULT = 50;
export const HISTORY_LIST_MAX = 200;
export const listLimitOf = (limit: unknown): number =>
  typeof limit === 'number' && Number.isFinite(limit) ? Math.min(HISTORY_LIST_MAX, Math.max(1, Math.trunc(limit))) : HISTORY_LIST_DEFAULT;

// ── The Supabase store ───────────────────────────────────────────────────────

/** Row columns read for lists (no manifest: it is 1–5 KB and only head/get need it). */
export const VERSION_ROW_COLUMNS =
  'id,kind,actor,label,name,note,pinned,keep_until,rev,content_at,created_at,parent_id,undo_id,alternative_id,model_id,published_rev,codec,changes,thumbs,stats,legacy_ref,root_hash';
const ALTERNATIVE_COLUMNS = 'id,name,from_version_id,head_version_id,is_active,created_at,updated_at,removed_at';
/** Hashes per `in (…)` filter (keeps the request URL small). */
const HASH_BATCH = 120;

/** A timestamptz from PostgREST as microseconds since the epoch (list merges order exactly as the database does). */
const tsMicros = (v: unknown): number => {
  const text = String(v ?? '');
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) return -Infinity;
  const frac = /T\d{2}:\d{2}:\d{2}\.(\d{1,6})/.exec(text)?.[1] ?? '';
  return Math.floor(ms / 1000) * 1_000_000 + Number(frac.padEnd(6, '0') || 0);
};
/** content_at desc, id desc (the list order). */
const newestRowFirst = (a: Record<string, unknown>, b: Record<string, unknown>): number =>
  tsMicros(b.content_at) - tsMicros(a.content_at) || (String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0);

/** The rows of a comic's list: one line's own rows, or (for "Original") also the rows of removed lines. */
type ListPart = { kind: 'line'; line: string | null } | { kind: 'removed'; live: string[] };

export interface SupabaseHistoryStoreOptions {
  /** The service-role client (default: getSupabaseAdmin). */
  admin?: () => SupabaseClient;
  /** Lines allowed per comic, counting "Original" (default MAX_ALTERNATIVES; StudioCaps.maxAlternatives). */
  maxAlternatives?: number;
}

export function createSupabaseHistoryStore(opts: SupabaseHistoryStoreOptions = {}): HistoryStore {
  const admin = opts.admin || getSupabaseAdmin;
  const maxAlternatives = opts.maxAlternatives ?? MAX_ALTERNATIVES;

  /** Both ids must be uuids: anything else is simply not found (no query, no oracle). */
  const scoped = (scope: HistoryScope): boolean => !!scope && isUuid(scope.projectId) && isUuid(scope.userId);

  const rpc = async <T>(name: string, args: Record<string, unknown>, action: string): Promise<T> => {
    const { data, error } = await admin().rpc(name, args);
    if (error) throw mapHistoryDbError(error, action);
    return data as T;
  };

  const activeLine = async (scope: HistoryScope): Promise<string | null> => {
    const { data, error } = await admin()
      .from('comic_alternatives')
      .select('id')
      .eq('project_id', scope.projectId)
      .eq('user_id', scope.userId)
      .eq('is_active', true)
      .is('removed_at', null)
      .limit(1);
    if (error) throw mapHistoryDbError(error, 'read the active line');
    return Array.isArray(data) && data[0] ? String((data[0] as { id: unknown }).id) : null;
  };
  /**
   * undefined = the line you're on; null = "Original"; an id must be a line still being tried. A removed or unknown
   * line is not found (null): a stale tab can never switch to, or read as current, a line that was removed.
   */
  const resolveLine = async (scope: HistoryScope, alternativeId: string | null | undefined): Promise<{ line: string | null } | null> => {
    if (alternativeId === undefined) return { line: await activeLine(scope) };
    if (alternativeId === null) return { line: null };
    if (!isUuid(alternativeId)) return null;
    const { data, error } = await admin()
      .from('comic_alternatives')
      .select('id')
      .eq('id', alternativeId)
      .eq('project_id', scope.projectId)
      .eq('user_id', scope.userId)
      .is('removed_at', null)
      .limit(1);
    if (error) throw mapHistoryDbError(error, 'read the versions you are trying');
    return Array.isArray(data) && data[0] ? { line: alternativeId } : null;
  };
  /** The comic's lines: the ones still being tried, and the removed ones. */
  const linesOf = async (scope: HistoryScope): Promise<{ live: string[]; removed: string[] }> => {
    const { data, error } = await admin()
      .from('comic_alternatives')
      .select('id,removed_at')
      .eq('project_id', scope.projectId)
      .eq('user_id', scope.userId);
    if (error) throw mapHistoryDbError(error, 'read the versions you are trying');
    const out = { live: [] as string[], removed: [] as string[] };
    for (const r of (Array.isArray(data) ? data : []) as { id: unknown; removed_at: unknown }[]) {
      if (isUuid(r.id)) (r.removed_at ? out.removed : out.live).push(r.id);
    }
    return out;
  };

  const chunkRows = async (scope: HistoryScope, hashes: string[]): Promise<{ hash: string; content: unknown; paths: unknown }[]> => {
    const wanted = [...new Set(hashes.filter(isHistoryHash))];
    const out: { hash: string; content: unknown; paths: unknown }[] = [];
    for (let i = 0; i < wanted.length; i += HASH_BATCH) {
      const { data, error } = await admin()
        .from('comic_version_chunks')
        .select('hash,content,paths')
        .eq('project_id', scope.projectId)
        .eq('user_id', scope.userId)
        .in('hash', wanted.slice(i, i + HASH_BATCH));
      if (error) throw mapHistoryDbError(error, 'read history');
      if (Array.isArray(data)) out.push(...(data as { hash: string; content: unknown; paths: unknown }[]));
    }
    return out;
  };

  /** Verified bodies (and paths) of these chunks; a corrupt one is logged and left out. */
  const verified = async (scope: HistoryScope, hashes: string[]) => {
    const bodies = new Map<string, unknown>();
    const paths = new Map<string, string[]>();
    for (const r of await chunkRows(scope, hashes)) {
      const body = parseVerifiedChunk(r.hash, r.content);
      if (body === undefined) {
        logger.error('comic_history_chunk_corrupt', { projectId: scope.projectId, hash: r.hash });
        continue;
      }
      bodies.set(r.hash, body);
      paths.set(r.hash, Array.isArray(r.paths) ? (r.paths as unknown[]).filter((p): p is string => typeof p === 'string') : []);
    }
    return { bodies, paths };
  };

  const store: HistoryStore = {
    async missing(scope, hashes) {
      const wanted = [...new Set((Array.isArray(hashes) ? hashes : []).filter(isHistoryHash))];
      if (!scoped(scope) || !wanted.length) return wanted;
      const have = new Set<string>();
      for (let i = 0; i < wanted.length; i += HASH_BATCH) {
        const { data, error } = await admin()
          .from('comic_version_chunks')
          .select('hash')
          .eq('project_id', scope.projectId)
          .eq('user_id', scope.userId)
          .in('hash', wanted.slice(i, i + HASH_BATCH));
        if (error) throw mapHistoryDbError(error, 'read history');
        for (const r of (data as { hash: string }[] | null) || []) have.add(r.hash);
      }
      return wanted.filter((h) => !have.has(h));
    },

    async put(scope, version, chunks, policy) {
      if (!scoped(scope)) throw historyStoreError('NOT_FOUND');
      const prepared = preparePut(version, chunks);
      const v = prepared.version;
      const pVersion = jsonbSafe({
        kind: v.kind,
        actor: v.actor,
        label: v.label,
        name: v.name,
        note: v.note,
        pinned: v.pinned,
        keepUntil: v.keepUntil,
        rev: v.rev,
        contentAt: v.contentAt,
        manifest: v.manifest,
        rootHash: v.rootHash,
        chunks: v.chunks,
        changes: v.changes,
        thumbs: v.thumbs,
        stats: v.stats ?? {},
        parentId: v.parentId,
        undoId: v.undoId,
        alternativeId: v.alternativeId ?? undefined,
        modelId: v.modelId,
        publishedRev: v.publishedRev,
        codec: v.codec,
        legacyRef: v.legacyRef,
        createdAt: v.createdAt
      });
      const data = await rpc<Record<string, unknown> | null>(
        'comic_history_put',
        { p_project: scope.projectId, p_user: scope.userId, p_version: pVersion, p_chunks: prepared.chunks, p_policy: policyOf(policy) },
        'save a moment'
      );
      if (!isRecord(data) || typeof data.id !== 'string') throw mapHistoryDbError({ code: 'XX000', message: 'comic_history_put returned nothing' }, 'save a moment');
      const result: PutResult = {
        id: data.id,
        deduped: data.deduped === true,
        thinned: int(data.thinned) ?? 0,
        budgetThinned: int(data.budgetThinned) ?? 0,
        gcChunks: int(data.gcChunks) ?? 0,
        bytesNew: int(data.bytesNew) ?? 0
      };
      if (data.alreadyNamed === true && typeof data.name === 'string') {
        result.alreadyNamed = true;
        result.name = data.name;
      }
      return result;
    },

    async head(scope, alternativeId) {
      if (!scoped(scope)) return null;
      const resolved = await resolveLine(scope, alternativeId);
      if (!resolved) return null;
      const line = resolved.line;
      if (line !== null && !isUuid(line)) return null;
      // "Original"'s head is its own newest row: rows of a removed line keep their alternative_id and never count.
      let q = admin()
        .from('comic_versions')
        .select(`${VERSION_ROW_COLUMNS},manifest`)
        .eq('project_id', scope.projectId)
        .eq('user_id', scope.userId);
      q = line === null ? q.is('alternative_id', null) : q.eq('alternative_id', line);
      const { data, error } = await q.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(1);
      if (error) throw mapHistoryDbError(error, 'read history');
      const r = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
      if (!r) return null;
      const row: HeadVersionRow = { ...versionRowFromDb(r), manifest: r.manifest as Manifest };
      return row;
    },

    // "Original"'s list also carries the rows of removed lines (their named saves are kept forever, so they must stay
    // reachable); each keeps its alternativeId, which tells the timeline it came from a removed line. head(null) and
    // the put's dedupe never see them.
    async list(scope, filter: HistoryListFilter = {}) {
      if (!scoped(scope)) return { rows: [] };
      const kinds = (filter.kinds || []).filter((k) => KINDS.has(k));
      if (filter.kinds && !kinds.length) return { rows: [] };
      if (filter.actor && !ACTORS.includes(filter.actor)) return { rows: [] };
      const resolved = await resolveLine(scope, filter.alternativeId);
      if (!resolved) return { rows: [] };
      const line = resolved.line;
      if (line !== null && !isUuid(line)) return { rows: [] };
      const limit = listLimitOf(filter.limit);
      const cursor = decodeHistoryCursor(filter.cursor);
      const part = async (which: ListPart): Promise<Record<string, unknown>[]> => {
        let q = admin().from('comic_versions').select(VERSION_ROW_COLUMNS).eq('project_id', scope.projectId).eq('user_id', scope.userId);
        if (which.kind === 'line') q = which.line === null ? q.is('alternative_id', null) : q.eq('alternative_id', which.line);
        else {
          q = q.not('alternative_id', 'is', null);
          if (which.live.length) q = q.not('alternative_id', 'in', `(${which.live.join(',')})`);
        }
        if (kinds.length) q = q.in('kind', kinds);
        if (filter.actor) q = q.eq('actor', filter.actor);
        // A JSON string: postgrest-js would turn a JS array into a Postgres array literal, which jsonb rejects.
        if (typeof filter.pageId === 'string' && filter.pageId) q = q.contains('changes', JSON.stringify([{ pageIds: [filter.pageId] }]));
        // Keyset on (content_at, id); the timestamp is quoted (PostgREST reserves '.' and ':' inside or()).
        if (cursor && isUuid(cursor.id)) q = q.or(`content_at.lt."${cursor.contentAt}",and(content_at.eq."${cursor.contentAt}",id.lt.${cursor.id})`);
        const { data, error } = await q.order('content_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1);
        if (error) throw mapHistoryDbError(error, 'read history');
        return (Array.isArray(data) ? data : []) as Record<string, unknown>[];
      };
      const [own, lines] = await Promise.all([part({ kind: 'line', line }), line === null ? linesOf(scope) : Promise.resolve(null)]);
      // Both parts are keyset pages in the same order: their merge's first `limit` rows are the union's.
      const raw = lines && lines.removed.length ? [...own, ...(await part({ kind: 'removed', live: lines.live }))].sort(newestRowFirst) : own;
      const page = raw.slice(0, limit);
      const last = page[page.length - 1];
      const out: HistoryListPage = { rows: page.map(versionRowFromDb) };
      if (raw.length > limit && last) out.next = encodeHistoryCursor(String(last.content_at), String(last.id));
      return out;
    },

    async get(scope, versionId) {
      if (!scoped(scope) || !isUuid(versionId)) return null;
      const { data, error } = await admin()
        .from('comic_versions')
        .select(`${VERSION_ROW_COLUMNS},manifest,chunks`)
        .eq('id', versionId)
        .eq('project_id', scope.projectId)
        .eq('user_id', scope.userId)
        .maybeSingle();
      if (error) throw mapHistoryDbError(error, 'read history');
      if (!isRecord(data) || !isRecord(data.manifest)) return null;
      const manifest = data.manifest as unknown as Manifest;
      const hashes = versionHashes(data.codec === 'legacy' ? 'legacy' : 'v5', manifest, data.chunks);
      if (!hashes) return null;
      const { bodies, paths } = await verified(scope, hashes);
      if (hashes.some((h) => !bodies.has(h))) {
        logger.warn('comic_history_version_incomplete', { projectId: scope.projectId, versionId, missing: hashes.filter((h) => !bodies.has(h)).length });
        return null;
      }
      const out: StoredVersionWithPaths = { row: versionRowFromDb(data), manifest, bodies, paths };
      return out;
    },

    async chunks(scope, hashes) {
      if (!scoped(scope)) return new Map();
      return (await verified(scope, Array.isArray(hashes) ? hashes : [])).bodies;
    },

    async label(scope, versionId, patch) {
      if (!scoped(scope) || !isUuid(versionId)) return null;
      const text = (v: string | null | undefined) => (v === undefined ? null : v === null ? '' : String(v));
      try {
        const data = await rpc<Record<string, unknown> | null>(
          'comic_history_label',
          {
            p_project: scope.projectId,
            p_user: scope.userId,
            p_version: versionId,
            p_name: text(patch?.name),
            p_note: text(patch?.note),
            p_pinned: typeof patch?.pinned === 'boolean' ? patch.pinned : null,
            p_max_named: HISTORY_LIMITS.namedRows
          },
          'name a moment'
        );
        return isRecord(data) ? versionRowFromDb(data) : null;
      } catch (err) {
        if (err instanceof StudioError && err.code === 'NOT_FOUND') return null;
        throw err;
      }
    },

    async delete(scope, versionId) {
      if (!scoped(scope) || !isUuid(versionId)) return false;
      try {
        return (await rpc<boolean>('comic_history_delete', { p_project: scope.projectId, p_user: scope.userId, p_version: versionId }, 'remove a version')) === true;
      } catch (err) {
        if (err instanceof StudioError && err.code === 'NOT_FOUND') return false;
        throw err;
      }
    },

    async forgetPath(scope, path) {
      if (!scoped(scope) || typeof path !== 'string' || !path.trim()) return 0;
      try {
        return int(await rpc<number>('comic_history_forget_path', { p_project: scope.projectId, p_user: scope.userId, p_path: path }, 'forget a photo')) ?? 0;
      } catch (err) {
        if (err instanceof StudioError && err.code === 'NOT_FOUND') return 0;
        throw err;
      }
    },

    async alternatives(scope) {
      if (!scoped(scope)) return [];
      const { data, error } = await admin()
        .from('comic_alternatives')
        .select(ALTERNATIVE_COLUMNS)
        .eq('project_id', scope.projectId)
        .eq('user_id', scope.userId)
        .is('removed_at', null)
        .order('created_at', { ascending: true });
      if (error) throw mapHistoryDbError(error, 'read the versions you are trying');
      return ((Array.isArray(data) ? data : []) as Record<string, unknown>[]).map(alternativeRowFromDb);
    },

    async createAlternative(scope, input) {
      if (!scoped(scope) || !isUuid(input?.headVersionId)) throw historyStoreError('NOT_FOUND');
      const name = String(input.name ?? '').trim().slice(0, 60);
      if (!name) throw historyStoreError('INVALID');
      const data = await rpc<Record<string, unknown> | null>(
        'comic_history_alternative_create',
        {
          p_project: scope.projectId,
          p_user: scope.userId,
          p_name: name,
          p_from: isUuid(input.fromVersionId) ? input.fromVersionId : null,
          p_head: input.headVersionId,
          p_max: maxAlternatives
        },
        'start a version'
      );
      if (!isRecord(data)) throw historyStoreError('NOT_FOUND');
      return alternativeRowFromDb(data);
    },

    async updateAlternative(scope, id, patch) {
      if (!scoped(scope) || !isUuid(id)) return null;
      const name = typeof patch?.name === 'string' ? patch.name.trim().slice(0, 60) : undefined;
      if (name === '') throw historyStoreError('INVALID');
      try {
        const data = await rpc<Record<string, unknown> | null>(
          'comic_history_alternative_update',
          { p_project: scope.projectId, p_user: scope.userId, p_id: id, p_name: name ?? null, p_active: typeof patch?.active === 'boolean' ? patch.active : null },
          'update a version'
        );
        return isRecord(data) ? alternativeRowFromDb(data) : null;
      } catch (err) {
        if (err instanceof StudioError && err.code === 'NOT_FOUND') return null;
        throw err;
      }
    },

    async removeAlternative(scope, id) {
      if (!scoped(scope) || !isUuid(id)) return false;
      try {
        return (await rpc<boolean>('comic_history_alternative_remove', { p_project: scope.projectId, p_user: scope.userId, p_id: id }, 'remove a version')) === true;
      } catch (err) {
        if (err instanceof StudioError && err.code === 'NOT_FOUND') return false;
        throw err;
      }
    },

    async setHead(scope, alternativeId, versionId) {
      if (!scoped(scope) || !isUuid(versionId) || (alternativeId !== null && !isUuid(alternativeId))) throw historyStoreError('NOT_FOUND');
      const ok = await rpc<boolean>(
        'comic_history_set_head',
        { p_project: scope.projectId, p_user: scope.userId, p_alternative: alternativeId, p_version: versionId },
        'keep a version'
      );
      if (ok !== true) throw historyStoreError('NOT_FOUND');
    }
  };
  return store;
}

// ── The process-wide store ───────────────────────────────────────────────────

let shared: HistoryStore | null = null;

/** The server's history store (Supabase, service role), created on first use. H2/H3/H7 take it from here. */
export const getHistoryStore = (): HistoryStore => (shared ??= createSupabaseHistoryStore());

/** Tests: swap in the fake (createFakeHistoryStore) or reset to the default with null. */
export const __setHistoryStoreForTests = (store: HistoryStore | null): void => {
  shared = store;
};
