// Persistence for publications (server/sql/comic_publications.sql). Service role only: the
// owner's identity always comes from the verified JWT (ctx.userId), never from a body, and
// every read/write is scoped by (project_id, user_id). Readers never touch these tables; the
// edge reads live rows through the anon SECURITY DEFINER RPCs.
//
// Two implementations: Supabase (production) and memory (tests, local tooling). The memory
// store also models the RPCs (`rpcPayload`) and the projects mirror so tests can assert the
// read-only contract end to end.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ComicDoc } from '../../../../shared/comic/doc.js';
import { SLUG_RE } from '../../../../shared/comic/publication.js';
import { isContentRating, type ContentRating } from '../../../../shared/comic/safety.js';
import { logger } from '../../lib/logger.js';
import { getSupabaseAdmin } from '../../services/supabase.js';
import { StudioError } from '../types.js';
import type { PublicationRow, PublicationStore, StatsRow } from './index.js';

/** The richer store the publication module uses (PublicationStore + projects mirror + public read). */
export interface PublicationBackend extends PublicationStore {
  /** A live + PUBLIC publication of a project that is not force-private (legacy /public/:id). */
  getLivePublic(projectId: string): Promise<PublicationRow | null>;
  /** Owner-scoped project facts: exists for this user, moderation hold. */
  projectFlags(projectId: string, userId: string): Promise<{ exists: boolean; forcedPrivate: boolean }>;
  /**
   * Mirror visibility onto the listing row (service role; the DB guard refuses everyone else):
   * is_public, state.shareSlug, state.publicCover, state.coverImageId (= publicCover while
   * public), state.publishedAt (first publish kept). While public, `listing` (the PUBLISHED
   * title/logline) becomes the row's name and state.overview, so the gallery shows what passed
   * the publish gate — never a later, unreviewed edit of the live doc. `contentRating` mirrors the
   * frozen publish-time rating to projects.content_rating (the gallery's "Kids-friendly" filter).
   */
  mirrorProject(args: MirrorArgs): Promise<void>;
  /** Public @username (never email or real name), only for showCreator. */
  publicUsername(userId: string): Promise<string | undefined>;
  /** pub/<key>/ prefixes older than a day with no live/suspended row (weekly sweep). */
  orphanKeys(limit: number): Promise<string[]>;
  /**
   * The publication row of a project, whoever owns it (service role). Moderation maintenance only
   * (removePublicationObjects) — never reachable from a client request. Optional for test doubles.
   */
  getByProject?(projectId: string): Promise<PublicationRow | null>;
  /**
   * Asset keys of publications suspended before `olderThanMs` (most recent first, ≤ limit): the sweep
   * takes their pub/ copies down if the takedown at hold time did not. Optional for test doubles.
   */
  suspendedKeys?(limit: number, olderThanMs: number): Promise<string[]>;
}

/** The published listing text (source language) a public gallery row shows. */
export interface PublishedListing {
  name: string;
  overview: string;
}

export interface MirrorArgs {
  projectId: string;
  userId: string;
  isPublic: boolean;
  shareSlug: string | null;
  publicCover: string | null;
  publishedAt: number | null;
  /** Written only while public (name + state.overview); private rows keep the owner's live text. */
  listing?: PublishedListing;
  /**
   * projects.content_rating (comic_safety.sql; service role only — a DB guard keeps clients out):
   * the publish gate's rating on publish, null on unpublish, undefined = leave it as it is.
   */
  contentRating?: ContentRating | null;
}

/** Thrown by upsert when the slug (or asset key) collides; the caller mints a new one and retries. */
export class SlugTakenError extends Error {
  constructor() {
    super('slug taken');
    this.name = 'SlugTakenError';
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ms = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const t = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
};
const iso = (v: number | null | undefined): string | null => (typeof v === 'number' && Number.isFinite(v) ? new Date(v).toISOString() : null);
type PgError = { code?: string; message?: string };
const pgCode = (err: unknown): string => String((err as PgError)?.code || '').toUpperCase();
const isMissingTable = (err: unknown) => pgCode(err) === '42P01' || pgCode(err) === 'PGRST205' || pgCode(err) === 'PGRST202';
const isInvalidId = (err: unknown) => pgCode(err) === '22P02';
/** An update naming a column the database doesn't have yet (Postgres 42703, PostgREST PGRST204). */
const isMissingColumn = (err: unknown) => pgCode(err) === '42703' || pgCode(err) === 'PGRST204';

/** The projects.content_rating value to write: a known rating, null to clear, undefined to leave alone. */
const ratingColumn = (r: ContentRating | null | undefined): ContentRating | null | undefined =>
  r === null ? null : r === undefined ? undefined : isContentRating(r) ? r : undefined;

const unavailable = (err: unknown, action: string): StudioError => {
  logger.error('comic_publication_store_error', {
    action,
    code: pgCode(err),
    message: (err as PgError)?.message,
    hint: isMissingTable(err) ? 'apply server/sql/comic_publications.sql' : undefined
  });
  return new StudioError('NOT_AVAILABLE', isMissingTable(err) ? "Publishing isn't set up on this server yet." : "Couldn't reach publishing right now. Please try again.", {
    status: 503,
    retryable: !isMissingTable(err),
    cause: err
  });
};

// ── Row mapping ──────────────────────────────────────────────────────────────

const COLUMNS =
  'id, project_id, user_id, status, visibility, slug, asset_key, languages, default_lang, start_page, allow_download, allow_embed, show_creator, snapshot, card, published_rev, safety, views_count, first_published_at, published_at, unpublished_at, updated_at';

export function rowFromDb(r: Record<string, unknown>): PublicationRow {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    userId: String(r.user_id),
    status: (r.status === 'live' || r.status === 'suspended' ? r.status : 'unpublished') as PublicationRow['status'],
    visibility: r.visibility === 'public' ? 'public' : 'unlisted',
    slug: typeof r.slug === 'string' ? r.slug : null,
    assetKey: typeof r.asset_key === 'string' ? r.asset_key : null,
    languages: Array.isArray(r.languages) ? r.languages.filter((l): l is string => typeof l === 'string') : [],
    defaultLang: typeof r.default_lang === 'string' ? r.default_lang : null,
    startPage: typeof r.start_page === 'number' ? r.start_page : null,
    allowDownload: r.allow_download !== false,
    allowEmbed: r.allow_embed !== false,
    showCreator: r.show_creator === true,
    snapshot: isRecord(r.snapshot) ? (r.snapshot as unknown as ComicDoc) : null,
    card: (isRecord(r.card) ? r.card : {}) as PublicationRow['card'],
    publishedRev: typeof r.published_rev === 'number' ? r.published_rev : 0,
    safety: isRecord(r.safety) ? r.safety : {},
    viewsCount: typeof r.views_count === 'number' ? r.views_count : Number(r.views_count) || 0,
    firstPublishedAt: ms(r.first_published_at),
    publishedAt: ms(r.published_at),
    unpublishedAt: ms(r.unpublished_at),
    updatedAt: ms(r.updated_at) ?? Date.now()
  };
}

export function rowToDb(row: PublicationRow): Record<string, unknown> {
  return {
    project_id: row.projectId,
    user_id: row.userId,
    status: row.status,
    visibility: row.visibility,
    slug: row.slug,
    asset_key: row.assetKey,
    languages: row.languages,
    default_lang: row.defaultLang ?? null,
    start_page: row.startPage ?? null,
    allow_download: row.allowDownload,
    allow_embed: row.allowEmbed,
    show_creator: row.showCreator,
    snapshot: row.snapshot,
    card: row.card,
    published_rev: row.publishedRev,
    safety: row.safety,
    first_published_at: iso(row.firstPublishedAt),
    published_at: iso(row.publishedAt),
    unpublished_at: iso(row.unpublishedAt),
    updated_at: iso(row.updatedAt ?? Date.now())
  };
}

const statsFromDb = (r: Record<string, unknown>): StatsRow => ({
  day: String(r.day),
  views: Number(r.views) || 0,
  uniques: Number(r.uniques) || 0,
  completes: Number(r.completes) || 0,
  byChannel: isRecord(r.by_channel) ? Object.fromEntries(Object.entries(r.by_channel).map(([k, v]) => [k, Number(v) || 0])) : {}
});

const dayIso = (t: number) => new Date(t).toISOString().slice(0, 10);

// ── Supabase ─────────────────────────────────────────────────────────────────

export function createSupabasePublicationStore(opts: { admin?: () => SupabaseClient; now?: () => number } = {}): PublicationBackend {
  const admin = opts.admin || getSupabaseAdmin;
  const now = opts.now || (() => Date.now());

  return {
    async get(projectId, userId) {
      if (!projectId || !userId) return null;
      const { data, error } = await admin().from('comic_publications').select(COLUMNS).eq('project_id', projectId).eq('user_id', userId).maybeSingle();
      if (error) {
        if (isInvalidId(error)) return null;
        if (isMissingTable(error)) return null;
        throw unavailable(error, 'load');
      }
      return data ? rowFromDb(data as Record<string, unknown>) : null;
    },

    async upsert(row) {
      // Owner-scoped update first; insert only when this owner has no row. Never re-homes a row:
      // an insert that collides on project_id (someone else's row) is refused.
      const payload = rowToDb(row);
      const db = admin();
      const collision = (error: unknown) => pgCode(error) === '23505' && /slug|asset_key/i.test(`${(error as PgError).message || ''}`);
      const { data: hit, error } = await db.from('comic_publications').update(payload).eq('project_id', row.projectId).eq('user_id', row.userId).select('id');
      if (error) {
        if (collision(error)) throw new SlugTakenError();
        throw unavailable(error, 'save');
      }
      if (Array.isArray(hit) && hit.length > 0) return;
      const { error: insertError } = await db.from('comic_publications').insert(payload);
      if (insertError) {
        if (collision(insertError)) throw new SlugTakenError();
        if (pgCode(insertError) === '23505') throw new StudioError('FORBIDDEN', "You don't have access to this comic.", { status: 403, cause: insertError });
        throw unavailable(insertError, 'save');
      }
    },

    async stats(id, days) {
      if (!id) return [];
      const since = dayIso(now() - Math.max(1, days) * 86_400_000);
      const { data, error } = await admin()
        .from('comic_publication_stats')
        .select('day, views, uniques, completes, by_channel')
        .eq('publication_id', id)
        .gte('day', since)
        .order('day', { ascending: true });
      if (error) {
        logger.warn('comic_publication_stats_failed', { code: pgCode(error) });
        return [];
      }
      return (Array.isArray(data) ? data : []).map((r) => statsFromDb(r as Record<string, unknown>));
    },

    async getLivePublic(projectId) {
      if (!projectId) return null;
      const db = admin();
      const { data, error } = await db
        .from('comic_publications')
        .select(COLUMNS)
        .eq('project_id', projectId)
        .eq('status', 'live')
        .eq('visibility', 'public')
        .maybeSingle();
      if (error) {
        if (isInvalidId(error) || isMissingTable(error)) return null;
        throw unavailable(error, 'load');
      }
      if (!data) return null;
      const flags = await db.from('projects').select('is_forced_private').eq('id', projectId).maybeSingle();
      // Fail closed: a moderation lookup that errors serves nothing.
      if (flags.error && pgCode(flags.error) !== '42703') return null;
      if ((flags.data as { is_forced_private?: boolean } | null)?.is_forced_private === true) return null;
      return rowFromDb(data as Record<string, unknown>);
    },

    async projectFlags(projectId, userId) {
      const db = admin();
      const first = await db.from('projects').select('id, is_forced_private').eq('id', projectId).eq('user_id', userId).maybeSingle();
      if (first.error) {
        if (isInvalidId(first.error)) return { exists: false, forcedPrivate: false };
        if (pgCode(first.error) !== '42703') throw unavailable(first.error, 'load');
        const fallback = await db.from('projects').select('id').eq('id', projectId).eq('user_id', userId).maybeSingle();
        if (fallback.error) throw unavailable(fallback.error, 'load');
        return { exists: !!fallback.data, forcedPrivate: false };
      }
      const row = first.data as { is_forced_private?: boolean } | null;
      return { exists: !!row, forcedPrivate: row?.is_forced_private === true };
    },

    async mirrorProject({ projectId, userId, isPublic, shareSlug, publicCover, publishedAt, listing, contentRating }) {
      const db = admin();
      const { data, error } = await db.from('projects').select('state').eq('id', projectId).eq('user_id', userId).maybeSingle();
      if (error) throw unavailable(error, 'save');
      if (!data) throw new StudioError('NOT_FOUND', "That comic doesn't exist or you don't have access to it.", { status: 404 });
      const state = mirrorState(isRecord((data as { state?: unknown }).state) ? ((data as { state: Record<string, unknown> }).state) : {}, { isPublic, shareSlug, publicCover, publishedAt, listing });
      const patch: Record<string, unknown> = { is_public: isPublic, state };
      if (isPublic && listing) patch.name = listingName(listing.name);
      const rating = ratingColumn(contentRating);
      if (rating !== undefined) patch.content_rating = rating;
      let { error: updateError } = await db.from('projects').update(patch).eq('id', projectId).eq('user_id', userId);
      if (updateError && 'content_rating' in patch && isMissingColumn(updateError)) {
        // comic_safety.sql (which adds the column) isn't applied yet: mirror everything else; the
        // gallery then shows no rating, which its filter treats as "not kids-friendly".
        logger.warn('comic_publication_rating_column_missing', { code: pgCode(updateError), hint: 'apply server/sql/comic_safety.sql' });
        delete patch.content_rating;
        ({ error: updateError } = await db.from('projects').update(patch).eq('id', projectId).eq('user_id', userId));
      }
      if (updateError) throw unavailable(updateError, 'save');
    },

    async publicUsername(userId) {
      try {
        const { data } = await admin().from('profiles').select('username').eq('id', userId).maybeSingle();
        const name = (data as { username?: unknown } | null)?.username;
        return typeof name === 'string' && /^[A-Za-z0-9_.-]{2,40}$/.test(name) ? name : undefined;
      } catch {
        return undefined;
      }
    },

    async orphanKeys(limit) {
      const { data, error } = await admin().rpc('comic_publication_orphan_keys', { p_limit: limit });
      if (error) {
        logger.warn('comic_publication_orphan_scan_failed', { code: pgCode(error) });
        return [];
      }
      return (Array.isArray(data) ? data : []).map((k) => (typeof k === 'string' ? k : String((k as Record<string, unknown>)?.comic_publication_orphan_keys ?? ''))).filter((k) => /^[A-Za-z0-9]{22}$/.test(k));
    },

    async getByProject(projectId) {
      if (!projectId) return null;
      const { data, error } = await admin().from('comic_publications').select(COLUMNS).eq('project_id', projectId).maybeSingle();
      if (error) {
        if (isInvalidId(error) || isMissingTable(error)) return null;
        throw unavailable(error, 'load');
      }
      return data ? rowFromDb(data as Record<string, unknown>) : null;
    },

    async suspendedKeys(limit, olderThanMs) {
      const { data, error } = await admin()
        .from('comic_publications')
        .select('asset_key')
        .eq('status', 'suspended')
        .not('asset_key', 'is', null)
        .lt('updated_at', iso(olderThanMs))
        .order('updated_at', { ascending: false })
        .limit(Math.max(1, Math.min(limit, 1000)));
      if (error) {
        logger.warn('comic_publication_suspended_scan_failed', { code: pgCode(error) });
        return [];
      }
      return (Array.isArray(data) ? data : []).map((r) => String((r as Record<string, unknown>)?.asset_key ?? '')).filter((k) => /^[A-Za-z0-9]{22}$/.test(k));
    }
  };
}

/** projects.name of a public listing: the published title, collapsed and clamped (≤ 200). */
export const listingName = (title: string): string => (String(title || '').replace(/\s+/g, ' ').trim() || 'Untitled comic').slice(0, 200);

/** The listing-state mirror for a visibility change (pure; shared by both stores). */
export function mirrorState(
  existing: Record<string, unknown>,
  m: { isPublic: boolean; shareSlug: string | null; publicCover: string | null; publishedAt: number | null; listing?: PublishedListing }
): Record<string, unknown> {
  const state: Record<string, unknown> = { ...existing };
  if (m.shareSlug && SLUG_RE.test(m.shareSlug)) state.shareSlug = m.shareSlug;
  else delete state.shareSlug;
  if (m.publicCover && m.publicCover.startsWith('pub/')) state.publicCover = m.publicCover;
  else delete state.publicCover;
  if (m.isPublic) {
    // The gallery cover is the opaque published copy, never a live draft path.
    if (m.publicCover && m.publicCover.startsWith('pub/')) state.coverImageId = m.publicCover;
    else delete state.coverImageId;
    state.stylePrompt = '';
    // The gallery blurb is the PUBLISHED logline (it passed the gate), never a later live edit.
    if (m.listing) state.overview = String(m.listing.overview || '').slice(0, 600);
  } else if (typeof state.coverImageId === 'string' && state.coverImageId.startsWith('pub/')) {
    // Leaving public: drop the published cover; the doc mirror restores the owner's own cover on its next save.
    delete state.coverImageId;
  }
  if (m.publishedAt && !(typeof state.publishedAt === 'number' || typeof state.publishedAt === 'string')) state.publishedAt = m.publishedAt;
  return state;
}

// ── Memory (tests) ───────────────────────────────────────────────────────────

export interface MemoryProject {
  userId: string;
  isPublic: boolean;
  forcedPrivate: boolean;
  state: Record<string, unknown>;
  name?: string;
  /** projects.content_rating (server-written mirror of the publish-time rating). */
  contentRating?: ContentRating | null;
}

export interface MemoryPublicationStore extends PublicationBackend {
  readonly rows: Map<string, PublicationRow>;
  readonly projects: Map<string, MemoryProject>;
  readonly statsRows: Map<string, StatsRow[]>;
  /** What the anon RPC comic_public_payload returns for a slug (null = the canonical 404). */
  rpcPayload(slug: string): { publication: Record<string, unknown>; doc: ComicDoc | null } | null;
  /** Moderation hold (the DB trigger suspends the live publication). */
  forcePrivate(projectId: string): void;
  seedProject(projectId: string, userId: string): void;
  upserts: number;
}

const cloneJson = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function createMemoryPublicationStore(): MemoryPublicationStore {
  const rows = new Map<string, PublicationRow>();
  const projects = new Map<string, MemoryProject>();
  const statsRows = new Map<string, StatsRow[]>();
  let ids = 0;
  const store: MemoryPublicationStore = {
    rows,
    projects,
    statsRows,
    upserts: 0,
    seedProject(projectId, userId) {
      if (!projects.has(projectId)) projects.set(projectId, { userId, isPublic: false, forcedPrivate: false, state: {} });
    },
    forcePrivate(projectId) {
      const p = projects.get(projectId);
      if (p) {
        p.forcedPrivate = true;
        p.isPublic = false;
      }
      const row = rows.get(projectId);
      if (row && row.status === 'live') rows.set(projectId, { ...row, status: 'suspended', updatedAt: Date.now() });
    },
    async get(projectId, userId) {
      const row = rows.get(projectId);
      return row && row.userId === userId ? cloneJson(row) : null;
    },
    async upsert(row) {
      for (const [pid, other] of rows) {
        if (pid === row.projectId) continue;
        if ((row.slug && other.slug === row.slug) || (row.assetKey && other.assetKey === row.assetKey)) throw new SlugTakenError();
      }
      const prev = rows.get(row.projectId);
      if (prev && prev.userId !== row.userId) throw new StudioError('FORBIDDEN', 'not yours', { status: 403 });
      if (row.status === 'live' && (!row.slug || !row.assetKey || !row.snapshot)) throw new Error('comic_publications_live_complete');
      if (row.slug && !SLUG_RE.test(row.slug)) throw new Error('comic_publications_slug_shape');
      ids += 1;
      rows.set(row.projectId, cloneJson({ ...row, id: prev?.id || row.id || `pub-${ids}` }));
      store.upserts += 1;
    },
    async stats(id, days) {
      return cloneJson((statsRows.get(id) || []).slice(-Math.max(1, days)));
    },
    async getLivePublic(projectId) {
      const row = rows.get(projectId);
      const project = projects.get(projectId);
      if (!row || row.status !== 'live' || row.visibility !== 'public' || project?.forcedPrivate) return null;
      return cloneJson(row);
    },
    async projectFlags(projectId, userId) {
      const p = projects.get(projectId);
      return { exists: !!p && p.userId === userId, forcedPrivate: !!p?.forcedPrivate };
    },
    async mirrorProject({ projectId, userId, isPublic, shareSlug, publicCover, publishedAt, listing, contentRating }) {
      const p = projects.get(projectId);
      if (!p || p.userId !== userId) throw new StudioError('NOT_FOUND', 'missing', { status: 404 });
      p.isPublic = isPublic && !p.forcedPrivate;
      p.state = mirrorState(p.state, { isPublic, shareSlug, publicCover, publishedAt, listing });
      if (isPublic && listing) p.name = listingName(listing.name);
      const rating = ratingColumn(contentRating);
      if (rating !== undefined) p.contentRating = rating;
    },
    async publicUsername() {
      return 'maya_draws';
    },
    async orphanKeys() {
      return [];
    },
    async getByProject(projectId) {
      const row = rows.get(projectId);
      return row ? cloneJson(row) : null;
    },
    async suspendedKeys(limit, olderThanMs) {
      return [...rows.values()]
        .filter((r) => r.status === 'suspended' && r.assetKey && (r.updatedAt ?? 0) < olderThanMs)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        .slice(0, Math.max(1, limit))
        .map((r) => r.assetKey!);
    },
    rpcPayload(slug) {
      if (!SLUG_RE.test(slug)) return null;
      for (const row of rows.values()) {
        if (row.slug !== slug || row.status !== 'live' || projects.get(row.projectId)?.forcedPrivate) continue;
        return {
          publication: {
            slug: row.slug,
            visibility: row.visibility,
            languages: row.languages,
            defaultLang: row.defaultLang,
            startPage: row.startPage,
            allowDownload: row.allowDownload,
            allowEmbed: row.allowEmbed,
            publishedAt: row.publishedAt,
            updatedAt: row.updatedAt,
            assetKey: row.assetKey,
            card: row.card,
            // Same rule as the SQL: only a known rating, frozen in safety.rating (older rows: no key).
            ...(isContentRating(row.safety?.rating) ? { rating: row.safety.rating } : {})
          },
          doc: cloneJson(row.snapshot)
        };
      }
      return null;
    }
  };
  return store;
}
