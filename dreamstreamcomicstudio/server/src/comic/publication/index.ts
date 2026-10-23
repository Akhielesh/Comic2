// Frozen publications (contract §12.7, sharing.md §4). Owned by P1-PUBLISH.
//
// Module map (all in this folder):
//   ids.ts          newSlug / newAssetKey (CSPRNG base62, unbiased)
//   snapshot.ts     the §9.3 allow-list snapshot, the publish plan, the ShareCard, fingerprints
//   ogImage.ts      the 1200×630 preview card (sharp + Pango + vendored OFL fonts, $0)
//   store.ts        comic_publications persistence (Supabase service role + memory fake)
//   publication.ts  owner operations (publish/update/regenerate/unpublish), readiness, views
//
// Readers never reach this module for /c/<slug>: the edge (Pages Function + dreamstream-api
// Worker) reads live rows through the anon RPCs, so a share link never wakes the container.

import type { AspectRatio, ComicDoc } from '../../../../shared/comic/doc.js';
import type {
  PublicComicPayload,
  PublicationOwnerView,
  PublicationSettingsPatch,
  PublicationStatus,
  PublishReadiness,
  PublishRequest,
  ShareCard
} from '../../../../shared/comic/publication.js';
import type { StudioContext } from '../types.js';
import { renderOgCard } from './ogImage.js';
import * as ops from './publication.js';
import { buildSnapshot } from './snapshot.js';

// ── Rows and inputs ──────────────────────────────────────────────────────────

/** One `comic_publications` row (server/sql/comic_publications.sql). Times are epoch ms. */
export interface PublicationRow {
  id?: string;
  projectId: string;
  userId: string;
  status: PublicationStatus;
  visibility: 'unlisted' | 'public';
  slug: string | null;
  assetKey: string | null;
  languages: string[];
  defaultLang?: string | null;
  startPage?: number | null;
  allowDownload: boolean;
  allowEmbed: boolean;
  showCreator: boolean;
  /** Allow-listed public snapshot (buildPublicSnapshot); null unless live/suspended. */
  snapshot: ComicDoc | null;
  card: ShareCard | Record<string, never>;
  publishedRev: number;
  /**
   * PublishGateResult summary + `contentHash` (the "changes since publishing" fingerprint).
   * `rating` (G / PG / PG-13) is the rating the gate verified the snapshot under, frozen at publish
   * time; the anon RPCs and payloadOf expose it as PublicPublicationInfo.rating.
   */
  safety: Record<string, unknown>;
  viewsCount?: number;
  firstPublishedAt?: number | null;
  publishedAt?: number | null;
  unpublishedAt?: number | null;
  updatedAt?: number;
}

/** One day of `comic_publication_stats`. */
export interface StatsRow {
  day: string;
  views: number;
  uniques: number;
  completes: number;
  byChannel: Record<string, number>;
}

/** What a snapshot contains: the cleared pages, the cover, the editions, and live path → pub/ path. */
export interface SnapshotPlan {
  assetKey: string;
  pageIds: string[];
  includeCover: boolean;
  languages: string[];
  defaultLang?: string;
  /** Live asset path → its opaque copy under pub/<assetKey>/ (variants included). */
  paths: Record<string, string>;
  /** Snapshot `id` (the publication id — never the project id). */
  publicationId?: string;
  /** Snapshot createdAt/updatedAt (published_at, epoch ms). */
  publishedAt?: number;
  /** Snapshot `rev` (published_rev). */
  rev?: number;
}

/** OG image input (sharing.md §6). */
export interface OgInput {
  title: string;
  subtitle: string;
  kindLabel: string;
  pageCount: number;
  lang: string;
  coverBuf: Buffer | null;
  fallbackPageBuf: Buffer | null;
  themeColor?: string;
  showMark: true;
  aspect?: AspectRatio;
}

export interface PublicationStore {
  get(projectId: string, userId: string): Promise<PublicationRow | null>;
  upsert(row: PublicationRow): Promise<void>;
  stats(id: string, days: number): Promise<StatsRow[]>;
}

// ── Owner operations ─────────────────────────────────────────────────────────

export async function getPublicationView(ctx: StudioContext): Promise<PublicationOwnerView> {
  return ops.getPublicationView(ctx);
}

export async function getReadiness(ctx: StudioContext, doc: ComicDoc, req?: PublishRequest): Promise<PublishReadiness> {
  return ops.getReadiness(ctx, doc, req);
}

/** Publish or update (runs under the session lock). */
export async function publish(ctx: StudioContext, req: PublishRequest): Promise<PublicationOwnerView> {
  return ops.publish(ctx, req);
}

export async function updatePublication(ctx: StudioContext, patch: PublicationSettingsPatch): Promise<PublicationOwnerView> {
  return ops.updatePublication(ctx, patch);
}

export async function regenerateLink(ctx: StudioContext): Promise<PublicationOwnerView> {
  return ops.regenerateLink(ctx);
}

/** Re-publishing later mints a NEW slug. */
export async function unpublish(ctx: StudioContext): Promise<PublicationOwnerView> {
  return ops.unpublish(ctx);
}

// ── Public side ──────────────────────────────────────────────────────────────

/** The §9.3 allow-list snapshot (exact key sets; no u/ paths, no project id). */
export function buildPublicSnapshot(doc: ComicDoc, plan: SnapshotPlan): ComicDoc {
  return buildSnapshot(doc, plan);
}

/** Legacy /api/comic/public/:id: only a live + PUBLIC publication (never unlisted). */
export async function loadPublicByProjectId(projectId: string): Promise<PublicComicPayload | null> {
  return ops.loadPublicByProjectId(projectId);
}

// ── Moderation ───────────────────────────────────────────────────────────────

/**
 * Takedown after a moderation hold or suspension (L11): deletes the pub/<key>/ copies (pages, cover,
 * share images) of a publication that is no longer live, so direct bucket URLs stop answering too.
 * Best effort and logged; never throws. Re-publishing after the hold is lifted copies everything
 * again under a fresh key. The weekly orphan sweep also removes the copies of publications suspended
 * longer than its grace period, in case this call failed.
 */
export async function removePublicationObjects(projectId: string): Promise<void> {
  return ops.removePublicationObjects(projectId);
}

/** 1200×630 OG card (sharp + Pango, $0). */
export async function renderOgImage(input: OgInput): Promise<{ jpeg: Buffer; w: 1200; h: 630; themeColor: string }> {
  return renderOgCard(input);
}

// ── Identifiers (real) ───────────────────────────────────────────────────────

export { newAssetKey, newSlug } from './ids.js';

// ── Extras for routes, actions, tools and tests ──────────────────────────────

export {
  cardPatchOps,
  configurePublication,
  maybeSweepOrphans,
  parsePublishRequest,
  parseSettingsPatch,
  payloadOf,
  publicationRatingOf,
  publicObjectUrl,
  publishWithOutcome,
  PublishError,
  OUTSIDE_IMAGE_STATUS,
  sweepOrphanPublications,
  type PublicationDeps,
  type PublishErrorReason,
  type PublishOutcome
} from './publication.js';
export { contentFingerprint, isServerArt, planSnapshot, snapshotPaths } from './snapshot.js';
export { escPango, ogHash, ratingMeta, scriptsCovered } from './ogImage.js';
export { createMemoryPublicationStore, createSupabasePublicationStore, type MemoryPublicationStore, type PublicationBackend } from './store.js';
