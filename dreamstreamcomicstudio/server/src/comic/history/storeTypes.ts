// Comic History — the store contract (versions plan §3.2; package H0 types; H1 builds the Supabase store and the
// in-memory fake on exactly this interface). Every call is scoped by project AND user (§12): the tables are
// server-only (RLS on, no policies), every RPC re-checks projects.user_id, and a foreign or missing id behaves
// exactly like a missing one (the routes answer the same 404).

import type { AlternativeRow, HistoryActor, HistoryCodec, HistoryKind, ChangeItem, Manifest, VersionRow, VersionStats, VersionThumb } from '../../../../shared/comic/history/types.js';
import type { HistoryScope } from './hooks.js';

/** One content-addressed chunk: `hash` = sha256(content) hex, first 32 characters (verified by the DB and on read). */
export interface ChunkInput {
  hash: string;
  /** Section kind ('page', 'art', 'char', 'edp', …; ≤ 24 chars). */
  kind: string;
  /** The exact canonical text (shared/comic/history/sections.ts sectionContent). */
  content: string;
  /** Image GC roots in this chunk (string leaves with '/', ≤ 512 chars, never data:/http(s):/blob:; ≤ 400). */
  paths: string[];
}

/** A version row to write (the RPC adds id, created_at, bytes_new). */
export interface VersionInput {
  kind: HistoryKind;
  actor: HistoryActor;
  label: string;
  name?: string;
  note?: string;
  pinned?: boolean;
  /** Epoch ms (before_restore: now + 30 days). */
  keepUntil?: number;
  rev: number;
  /** Epoch ms: when this content last changed. */
  contentAt: number;
  manifest: Manifest;
  rootHash: string;
  /** Every chunk hash the manifest references. */
  chunks: string[];
  changes?: ChangeItem[];
  thumbs?: VersionThumb[];
  stats?: Partial<VersionStats>;
  parentId?: string;
  undoId?: string;
  alternativeId?: string | null;
  modelId?: string;
  publishedRev?: number;
  codec?: HistoryCodec;
  legacyRef?: { snapshotId?: string; snapshotHash?: string; reason?: string; projectId?: string };
}

/** Thinning and budget policy passed to the put RPC (HISTORY_LIMITS by default). */
export interface HistoryPolicy {
  unpinnedRows: number;
  bytesPerComic: number;
}

/** What comic_history_put answers. */
export interface PutResult {
  id: string;
  /** An equal root on the line's newest row: nothing new was written (its id is returned). */
  deduped: boolean;
  thinned: number;
  /** Rows thinned because the comic went over its byte budget (the recorder posts a notice: never silent). */
  budgetThinned: number;
  gcChunks: number;
  bytesNew: number;
}

export interface HistoryListFilter {
  /** Cursor from the previous page (opaque). */
  cursor?: string;
  limit?: number;
  kinds?: HistoryKind[];
  actor?: HistoryActor;
  /** Only rows whose changes touch this page. */
  pageId?: string;
  /** The line to list (absent = the active one). */
  alternativeId?: string | null;
}

export interface HistoryListPage {
  rows: VersionRow[];
  next?: string;
}

/** A verified version: its row, manifest and every chunk body it references (parsed JSON, hash re-checked). */
export interface StoredVersion {
  row: VersionRow;
  manifest: Manifest;
  /** hash → parsed body. */
  bodies: Map<string, unknown>;
}

/**
 * The history store (H1: Supabase RPCs + store.fake.ts). Every method takes the owner scope first. Errors are
 * StudioError: NOT_FOUND for a foreign/missing id (same as missing), FORBIDDEN never leaks existence,
 * CONFLICT for a concurrent write, NOT_AVAILABLE when the tables are not applied yet.
 */
export interface HistoryStore {
  /** The subset of `hashes` this comic does not store yet (upload only those). */
  missing(scope: HistoryScope, hashes: string[]): Promise<string[]>;
  /** One transaction: lock, ownership, chunks, presence check, dedupe, insert, thin, GC (§3.2 comic_history_put). */
  put(scope: HistoryScope, version: VersionInput, chunks: ChunkInput[], policy?: Partial<HistoryPolicy>): Promise<PutResult>;
  /** The newest row of a line (null: no history yet). */
  head(scope: HistoryScope, alternativeId?: string | null): Promise<VersionRow | null>;
  list(scope: HistoryScope, filter?: HistoryListFilter): Promise<HistoryListPage>;
  /** A version with every chunk loaded and re-verified (null when missing, foreign or corrupt). */
  get(scope: HistoryScope, versionId: string): Promise<StoredVersion | null>;
  /** Verified bodies of these chunks (compare loads only the changed ones). */
  chunks(scope: HistoryScope, hashes: string[]): Promise<Map<string, unknown>>;
  label(scope: HistoryScope, versionId: string, patch: { name?: string | null; note?: string | null; pinned?: boolean }): Promise<VersionRow | null>;
  /** Named rows only; never the newest row or an alternative's head. */
  delete(scope: HistoryScope, versionId: string): Promise<boolean>;
  /** Remove a storage path from every chunk's `paths` of this comic (a forgotten reference photo; V-4). */
  forgetPath(scope: HistoryScope, path: string): Promise<number>;
  // Alternatives (H7; Decision V-1: inside one comic, at most MAX_ALTERNATIVES).
  alternatives(scope: HistoryScope): Promise<AlternativeRow[]>;
  createAlternative(scope: HistoryScope, input: { name: string; fromVersionId?: string; headVersionId: string }): Promise<AlternativeRow>;
  updateAlternative(scope: HistoryScope, id: string, patch: { name?: string; active?: boolean }): Promise<AlternativeRow | null>;
  removeAlternative(scope: HistoryScope, id: string): Promise<boolean>;
  setHead(scope: HistoryScope, alternativeId: string | null, versionId: string): Promise<void>;
}
