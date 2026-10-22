// Frozen publications (contract §12.7, sharing.md §4). Wave-0 stub by P0-B; owned in wave 1
// by P1-PUBLISH, which replaces every function IN PLACE (same names, same signatures).
//
// Stub behaviour: every publication operation throws StudioError NOT_AVAILABLE (501);
// loadPublicByProjectId → null (the legacy /public/:id path serves nothing new).
// newSlug/newAssetKey are REAL already (pure crypto; their shape is part of the contract).

import crypto from 'node:crypto';
import type { AspectRatio, ComicDoc } from '../../../../shared/comic/doc.js';
import {
  ASSET_KEY_RE,
  SLUG_LENGTH,
  SLUG_RE,
  type PublicComicPayload,
  type PublicationOwnerView,
  type PublicationSettingsPatch,
  type PublicationStatus,
  type PublishReadiness,
  type PublishRequest,
  type ShareCard
} from '../../../../shared/comic/publication.js';
import { notAvailableError } from '../extensions.js';
import type { StudioContext } from '../types.js';

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
  /** PublishGateResult summary. */
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

const PUBLISHING_UNAVAILABLE = "Publishing from the studio isn't available yet.";

// ── Owner operations ─────────────────────────────────────────────────────────

export async function getPublicationView(_ctx: StudioContext): Promise<PublicationOwnerView> {
  throw notAvailableError(PUBLISHING_UNAVAILABLE);
}

export async function getReadiness(_ctx: StudioContext, _doc: ComicDoc, _req?: PublishRequest): Promise<PublishReadiness> {
  throw notAvailableError(PUBLISHING_UNAVAILABLE);
}

/** Publish or update (runs under the session lock). */
export async function publish(_ctx: StudioContext, _req: PublishRequest): Promise<PublicationOwnerView> {
  throw notAvailableError(PUBLISHING_UNAVAILABLE);
}

export async function updatePublication(_ctx: StudioContext, _patch: PublicationSettingsPatch): Promise<PublicationOwnerView> {
  throw notAvailableError(PUBLISHING_UNAVAILABLE);
}

export async function regenerateLink(_ctx: StudioContext): Promise<PublicationOwnerView> {
  throw notAvailableError(PUBLISHING_UNAVAILABLE);
}

/** Re-publishing later mints a NEW slug. */
export async function unpublish(_ctx: StudioContext): Promise<PublicationOwnerView> {
  throw notAvailableError(PUBLISHING_UNAVAILABLE);
}

// ── Public side ──────────────────────────────────────────────────────────────

/** The §9.3 allow-list snapshot (exact key sets; no u/ paths, no project id). */
export function buildPublicSnapshot(_doc: ComicDoc, _plan: SnapshotPlan): ComicDoc {
  throw notAvailableError(PUBLISHING_UNAVAILABLE);
}

/** Legacy /api/comic/public/:id: only a live + PUBLIC publication (never unlisted). */
export async function loadPublicByProjectId(_projectId: string): Promise<PublicComicPayload | null> {
  return null;
}

/** 1200×630 OG card (sharp + Pango, $0). */
export async function renderOgImage(_input: OgInput): Promise<{ jpeg: Buffer; w: 1200; h: 630; themeColor: string }> {
  throw notAvailableError(PUBLISHING_UNAVAILABLE);
}

// ── Identifiers (real) ───────────────────────────────────────────────────────

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Unbiased base62: bytes ≥ 248 (= 4 × 62) are rejected so every symbol is equally likely. */
const randomBase62 = (length: number): string => {
  let out = '';
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte >= 248) continue;
      out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
};

/** Public share slug: 17 × base62 ≈ 101 bits (matches SLUG_RE). */
export function newSlug(): string {
  const slug = randomBase62(SLUG_LENGTH);
  if (!SLUG_RE.test(slug)) throw new Error('newSlug: shape mismatch');
  return slug;
}

/** Storage key for pub/<key>/: 22 × base62 ≈ 131 bits (matches ASSET_KEY_RE). */
export function newAssetKey(): string {
  const key = randomBase62(22);
  if (!ASSET_KEY_RE.test(key)) throw new Error('newAssetKey: shape mismatch');
  return key;
}
