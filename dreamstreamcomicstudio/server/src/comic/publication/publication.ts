// Owner publication operations (sharing.md §4, contract §12.7): publish / update / regenerate
// / unpublish, readiness, the owner view, and the legacy public read by project id.
//
// Invariants (owner addendum "read-only + very strong security"):
//  - every operation is owner-scoped: ctx.userId comes from the verified JWT, the session is
//    loaded owner-scoped, and the publication row is read/written by (project_id, user_id);
//  - readers only ever see the frozen, allow-listed snapshot and opaque pub/<assetKey>/ copies;
//    later edits never go live until the owner republishes (which re-runs the safety gate);
//  - the safety gate (runPublishGate) runs for BOTH visibilities over the doc itself (its text check
//    reads shared publishableText(), which covers every author text the snapshot publishes);
//    unchecked content is never published (fail closed: 503 with an honest message), only pages
//    the gate PASSED go out, blocked pages need explicit consent;
//  - the gate's rating (G / PG / PG-13) is frozen in the row's safety.rating at publish time and
//    is what readers, the gallery mirror (projects.content_rating) and the preview card show;
//  - regenerate and unpublish kill the old slug the moment the row commits (the edge does no
//    caching) and delete the old pub/ objects; publishing again after an unpublish mints a NEW slug;
//  - projects.is_public is mirrored by the service role only;
//  - only art the SERVER wrote to a lane clients can't rewrite is ever copied to pub/ (isServerArt,
//    S6): pages or a cover using an outside image are refused before any safety check is paid for;
//  - a moderation hold takes the pub/ copies down (removePublicationObjects, L11); republishing a
//    suspended row after the hold is lifted copies everything again under a fresh asset key.

import crypto from 'node:crypto';
import { newId, versionsOf, type AssetRef, type Card, type ComicDoc, type Msg, type RenderState, type SafetyBlocker } from '../../../../shared/comic/doc.js';
import type { DocOp } from '../../../../shared/comic/ops.js';
import { editionReadiness } from '../../../../shared/comic/i18n.js';
import { languageSpec, sameLanguage } from '../../../../shared/comic/languages.js';
import {
  ASSET_KEY_RE,
  PUBLISH_DEFAULTS,
  SLUG_RE,
  type PublicationMirror,
  type PublicationOwnerView,
  type PublicationSettingsPatch,
  type PublicComicPayload,
  type PublishReadiness,
  type PublishRequest,
  type ShareCard
} from '../../../../shared/comic/publication.js';
import { effectiveRating, isContentRating, safetyStatusOf, type ContentRating, type SafetyStatus } from '../../../../shared/comic/safety.js';
import { comicShareUrl } from '../../../../services/productHost.js';
import { logger } from '../../lib/logger.js';
import { runPublishGate, type PublishGateResult } from '../safety/index.js';
import { PUBLIC_BUCKET } from '../storagePaths.js';
import { StudioError, type AssetStore, type StudioContext, type StudioErrorCode } from '../types.js';
import type { PublicationRow, SnapshotPlan, StatsRow } from './index.js';
import { newAssetKey, newSlug } from './ids.js';
import { ogHash, renderOgCard, dominantColor, type OgRenderInput } from './ogImage.js';
import {
  buildShareCard,
  buildSnapshot,
  cleanText,
  contentFingerprint,
  copiesFor,
  coverUrlOf,
  drawnPages,
  hasPublishableArt,
  isServerArt,
  kindLabelOf,
  languagesLabel,
  localizedText,
  ogPath,
  OG_PATH_RE,
  planSnapshot,
  snapshotPaths,
  withServerVariants
} from './snapshot.js';
import { createSupabasePublicationStore, SlugTakenError, type PublicationBackend, type PublishedListing } from './store.js';

// ── Dependencies (injectable for tests) ──────────────────────────────────────

export interface PublicationDeps {
  store: PublicationBackend;
  gate: typeof runPublishGate;
  now: () => number;
  /** Public object URL of a pub/ path (Supabase public bucket). */
  publicUrl: (path: string) => string;
  renderOg: (input: OgRenderInput) => Promise<{ jpeg: Buffer; w: 1200; h: 630; themeColor: string }>;
  newSlug: () => string;
  newAssetKey: () => string;
  /**
   * Asset store for maintenance without a StudioContext (moderation takedowns, the orphan sweep's
   * callers). Only `removePrefix` is used, and it refuses anything but a whole pub/<key>/ folder.
   */
  assets: () => Promise<Pick<AssetStore, 'removePrefix'>>;
}

let lazyAssets: Pick<AssetStore, 'removePrefix'> | null = null;
const defaultAssets = async (): Promise<Pick<AssetStore, 'removePrefix'>> => {
  if (!lazyAssets) {
    const { createSupabaseAssetStore } = await import('../assets.js');
    lazyAssets = createSupabaseAssetStore();
  }
  return lazyAssets;
};

const supabaseOrigin = (): string => (process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '').replace(/\/+$/, '');

/** Public URL of an object in the public bucket; each path segment encoded. */
export const publicObjectUrl = (path: string, origin = supabaseOrigin(), bucket = PUBLIC_BUCKET): string =>
  `${origin}/storage/v1/object/public/${encodeURIComponent(bucket)}/${path.split('/').map(encodeURIComponent).join('/')}`;

let overrides: Partial<PublicationDeps> = {};
let defaultStore: PublicationBackend | null = null;

const deps = (): PublicationDeps => ({
  store: overrides.store || (defaultStore ??= createSupabasePublicationStore()),
  gate: overrides.gate || runPublishGate,
  now: overrides.now || (() => Date.now()),
  publicUrl: overrides.publicUrl || ((p) => publicObjectUrl(p)),
  renderOg: overrides.renderOg || renderOgCard,
  newSlug: overrides.newSlug || newSlug,
  newAssetKey: overrides.newAssetKey || newAssetKey,
  assets: overrides.assets || defaultAssets
});

/** Test hook: swap dependencies; returns a restore function. */
export function configurePublication(next: Partial<PublicationDeps>): () => void {
  const prev = overrides;
  overrides = { ...overrides, ...next };
  return () => {
    overrides = prev;
  };
}

// ── Errors ───────────────────────────────────────────────────────────────────

/**
 * The public API code of a refusal (the route sends it as `error.code`). A safety check that could
 * not run is 'NOT_AVAILABLE' (contract §12.6: needs_check → 503 NOT_AVAILABLE, which the client
 * treats as retryable); 'SAFETY_UNAVAILABLE' is kept only so older callers still type-check.
 */
export type PublishErrorReason = 'BAD_REQUEST' | 'NOT_FOUND' | 'NOT_READY' | 'SAFETY_BLOCKED' | 'LANG_INCOMPLETE' | 'CONFLICT' | 'NOT_AVAILABLE' | 'SAFETY_UNAVAILABLE' | 'FORBIDDEN';

/** A StudioError that carries the public API code and machine-readable details. */
export class PublishError extends StudioError {
  readonly reason: PublishErrorReason;
  readonly details?: Record<string, unknown>;
  constructor(reason: PublishErrorReason, message: string, opts: { status: number; code: StudioErrorCode; details?: Record<string, unknown> }) {
    super(opts.code, message, { status: opts.status });
    this.reason = reason;
    if (opts.details) this.details = opts.details;
  }
}

const badRequest = (message: string) => new PublishError('BAD_REQUEST', message, { status: 400, code: 'BAD_REQUEST' });
const notFound = (message = "This comic isn't published.") => new PublishError('NOT_FOUND', message, { status: 404, code: 'NOT_FOUND' });

// ── Validation (strict allow-lists; unknown keys are refused) ────────────────

const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
const MAX_LANGUAGES = 12;
const REQUEST_KEYS = new Set(['visibility', 'languages', 'defaultLang', 'startPage', 'allowDownload', 'allowEmbed', 'showCreator', 'excludePageIds']);
const PATCH_KEYS = new Set(['visibility', 'defaultLang', 'startPage', 'allowDownload', 'allowEmbed', 'showCreator']);
const PAGE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const optBool = (v: unknown, key: string): boolean | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') throw badRequest(`“${key}” must be true or false.`);
  return v;
};
const optStartPage = (v: unknown): number | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 500) throw badRequest('“startPage” must be a page number from 1 to 500.');
  return v;
};
const optLang = (v: unknown, key: string): string | undefined => {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !LANG_RE.test(v)) throw badRequest(`“${key}” must be a language code like “en” or “hi”.`);
  return v;
};

/** Validate a PublishRequest body (unknown keys → 400). */
export function parsePublishRequest(body: unknown): PublishRequest {
  if (!isRecord(body)) throw badRequest('Send a publish request.');
  for (const key of Object.keys(body)) if (!REQUEST_KEYS.has(key)) throw badRequest(`Unknown field “${key.slice(0, 40)}”.`);
  if (body.visibility !== 'unlisted' && body.visibility !== 'public') throw badRequest('Choose who can see it: “unlisted” or “public”.');
  const req: PublishRequest = { visibility: body.visibility };
  if (body.languages !== undefined) {
    if (!Array.isArray(body.languages) || !body.languages.length || body.languages.length > MAX_LANGUAGES) throw badRequest(`Pick 1 to ${MAX_LANGUAGES} languages.`);
    const langs: string[] = [];
    for (const l of body.languages) {
      const lang = optLang(l, 'languages');
      if (lang && !langs.some((x) => sameLanguage(x, lang))) langs.push(lang);
    }
    req.languages = langs;
  }
  const defaultLang = optLang(body.defaultLang, 'defaultLang');
  if (defaultLang) req.defaultLang = defaultLang;
  const startPage = optStartPage(body.startPage);
  if (startPage !== undefined) req.startPage = startPage;
  const allowDownload = optBool(body.allowDownload, 'allowDownload');
  if (allowDownload !== undefined) req.allowDownload = allowDownload;
  const allowEmbed = optBool(body.allowEmbed, 'allowEmbed');
  if (allowEmbed !== undefined) req.allowEmbed = allowEmbed;
  const showCreator = optBool(body.showCreator, 'showCreator');
  if (showCreator !== undefined) req.showCreator = showCreator;
  if (body.excludePageIds !== undefined) {
    if (!Array.isArray(body.excludePageIds) || body.excludePageIds.length > 500 || !body.excludePageIds.every((id) => typeof id === 'string' && PAGE_ID_RE.test(id))) {
      throw badRequest('“excludePageIds” must be a list of page ids.');
    }
    req.excludePageIds = [...new Set(body.excludePageIds as string[])];
  }
  return req;
}

/** Validate a settings patch (no languages or content; unknown keys → 400). */
export function parseSettingsPatch(body: unknown): PublicationSettingsPatch {
  if (!isRecord(body)) throw badRequest('Send the settings to change.');
  for (const key of Object.keys(body)) if (!PATCH_KEYS.has(key)) throw badRequest(`Unknown field “${key.slice(0, 40)}”.`);
  const patch: PublicationSettingsPatch = {};
  if (body.visibility !== undefined) {
    if (body.visibility !== 'unlisted' && body.visibility !== 'public') throw badRequest('Choose “unlisted” or “public”.');
    patch.visibility = body.visibility;
  }
  const defaultLang = optLang(body.defaultLang, 'defaultLang');
  if (defaultLang) patch.defaultLang = defaultLang;
  const startPage = optStartPage(body.startPage);
  if (startPage !== undefined) patch.startPage = startPage;
  for (const key of ['allowDownload', 'allowEmbed', 'showCreator'] as const) {
    const v = optBool(body[key], key);
    if (v !== undefined) patch[key] = v;
  }
  if (!Object.keys(patch).length) throw badRequest('Nothing to change.');
  return patch;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Per-user write budget for publish/update/regenerate/unpublish (contract §14.3: 10/min, 60/day).
// The REST routes also sit behind comicPublishRateLimit; this one covers the stream actions too.
const WRITE_WINDOWS = [
  { ms: 60_000, max: 10 },
  { ms: 24 * 60 * 60_000, max: 60 }
];
const writeLog = new Map<string, number[]>();
const MAX_TRACKED_USERS = 5000;

/** Throws RATE_LIMIT (429) when this user has published too often; records the attempt otherwise. */
export function takePublishBudget(userId: string, now = Date.now()): void {
  const day = WRITE_WINDOWS[WRITE_WINDOWS.length - 1].ms;
  const recent = (writeLog.get(userId) || []).filter((t) => now - t < day);
  for (const w of WRITE_WINDOWS) {
    if (recent.filter((t) => now - t < w.ms).length >= w.max) {
      throw new StudioError('RATE_LIMIT', w.ms <= 60_000 ? 'That was a lot of publishing in a minute — wait a moment and try again.' : "You've reached today's publishing limit. Try again tomorrow.", {
        status: 429,
        retryable: true
      });
    }
  }
  recent.push(now);
  writeLog.delete(userId);
  if (writeLog.size >= MAX_TRACKED_USERS) {
    const oldest = writeLog.keys().next().value as string | undefined;
    if (oldest !== undefined) writeLog.delete(oldest);
  }
  writeLog.set(userId, recent);
}

/** Test hook. */
export function __resetPublishBudget(): void {
  writeLog.clear();
}

/** Run under the project's session lock (serializes with director turns and other publishes). */
async function withLock<T>(ctx: StudioContext, fn: () => Promise<T>): Promise<T> {
  const s = ctx.session as StudioContext['session'] & { runExclusive?: <R>(work: () => Promise<R>) => Promise<R> };
  return typeof s.runExclusive === 'function' ? s.runExclusive(fn) : fn();
}

const ratingOf = (ctx: StudioContext, doc: ComicDoc): ContentRating => ctx.rating ?? effectiveRating(doc, ctx.caps?.ratingCeiling).rating;

const isLiveish = (row: PublicationRow | null): row is PublicationRow & { slug: string; assetKey: string } =>
  !!row && (row.status === 'live' || row.status === 'suspended') && !!row.slug && SLUG_RE.test(row.slug) && !!row.assetKey && ASSET_KEY_RE.test(row.assetKey);

/**
 * The rating a publication was safety-checked under, frozen in safety.rating at publish time.
 * Undefined for rows published before ratings were recorded (or a malformed value): readers and
 * the gallery treat that as unknown, never as kids-friendly. Same rule as the anon RPCs.
 */
export const publicationRatingOf = (row: Pick<PublicationRow, 'safety'> | null | undefined): ContentRating | undefined => {
  const r = row?.safety?.rating;
  return isContentRating(r) ? r : undefined;
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

const bufferOf = async (ctx: StudioContext, path: string | undefined): Promise<Buffer | null> => {
  if (!path) return null;
  try {
    const dataUrl = await ctx.assets.loadDataUrl(path);
    const comma = dataUrl.indexOf(',');
    return comma > 0 ? Buffer.from(dataUrl.slice(comma + 1), 'base64') : null;
  } catch {
    return null;
  }
};

/** The 1080 variant (else the original) of a live asset: what the OG renderer reads. */
const previewPathOf = (live?: AssetRef): string | undefined => {
  if (!live) return undefined;
  // Same rule as the copies (S6): a variant counts only at its deterministic server path.
  const asset = withServerVariants(live);
  return ((asset.variants || []).find((v) => v.w === 1080) || (asset.variants || []).slice(-1)[0] || asset).path;
};

const pubPathsOfCard = (card: ShareCard | Record<string, never> | undefined): string[] =>
  isRecord(card) && isRecord((card as unknown as ShareCard).og) ? Object.values((card as unknown as ShareCard).og).map((o) => o?.path).filter((p): p is string => typeof p === 'string') : [];

const mirrorOf = (row: PublicationRow): PublicationMirror | null =>
  isLiveish(row)
    ? {
        visibility: row.visibility,
        status: row.status === 'suspended' ? 'suspended' : 'live',
        slug: row.slug,
        publishedRev: row.publishedRev,
        publishedAt: row.publishedAt ?? row.updatedAt ?? 0,
        languages: [...row.languages]
      }
    : null;

/** The doc mirror op, only when it differs from what the doc holds. */
const mirrorOps = (doc: ComicDoc, row: PublicationRow | null): DocOp[] => {
  const value = row ? mirrorOf(row) : null;
  const current = doc.publication ?? null;
  return JSON.stringify(current) === JSON.stringify(value) ? [] : [{ op: 'publication', value }];
};

/**
 * The owner's preview of the link card: a ROOT-RELATIVE /og/… URL, so the Share sheet's preview
 * (and "share image") load same-origin on whichever host the studio runs (apex today, the comics
 * host later) — the /og/ Pages Function serves every host.
 */
const ogUrlOf = (card: ShareCard | Record<string, never>, lang?: string): string | undefined => {
  const og = isRecord(card) && isRecord((card as unknown as ShareCard).og) ? (card as unknown as ShareCard).og : undefined;
  if (!og) return undefined;
  const entry = (lang && og[lang]) || Object.values(og)[0];
  return entry && OG_PATH_RE.test(entry.path) ? `/og/${entry.path.slice('pub/'.length)}` : undefined;
};

// ── Readiness ────────────────────────────────────────────────────────────────

const STATUS_WORD: Record<string, string> = { none: 'not drawn yet', queued: 'waiting to draw', rendering: 'drawing now', failed: "didn't draw", stale: 'out of date' };

/** Readiness word for drawn art that isn't server-made (isServerArt): it can't be published as it is. */
export const OUTSIDE_IMAGE_STATUS = 'uses an image from outside the studio — redraw it or upload the image again';

/** The honest refusal when drawn pages or the cover use an image the server didn't make (S6). */
function outsideImageError(pages: number[], cover: boolean): PublishError {
  const list = pages.sort((a, b) => a - b).join(', ');
  const one = pages.length === 1;
  const message = pages.length
    ? `Page ${list} ${one ? 'uses an image' : 'use images'} brought in from outside the studio, so ${one ? 'it' : 'they'} can't be published as ${one ? 'it is' : 'they are'}. Publish without ${one ? 'it' : 'them'}, or redraw ${one ? 'it' : 'them'} (or upload the image again in Media) first.`
    : "The cover uses an image brought in from outside the studio, so it can't be published as it is. Redraw the cover (or upload the image again in Media and use it as the cover) first.";
  return new PublishError('NOT_READY', message, { status: 422, code: 'NOT_READY', details: { outsideImages: { pages, cover } } });
}

/** The published languages: the source first, always (readers always get the original), then the requested editions. */
const withSource = (source: string, requested: readonly string[]): string[] => [source, ...requested.filter((l) => !sameLanguage(l, source))];

/** Live readiness from the doc (no network, no spend): drives the sheet and the publish card. */
export async function getReadiness(ctx: StudioContext, doc: ComicDoc, req?: PublishRequest): Promise<PublishReadiness> {
  const rating = ratingOf(ctx, doc);
  const exclude = new Set(req?.excludePageIds || []);
  const pages = (doc.pages || []).filter((p) => !exclude.has(p.id));
  const missing: PublishReadiness['missing'] = [];
  if (!hasPublishableArt(doc.cover?.render)) missing.push({ kind: 'cover', status: STATUS_WORD[doc.cover?.render?.status || 'none'] || 'not drawn yet' });
  else if (!isServerArt(doc.cover.render.asset)) missing.push({ kind: 'cover', status: OUTSIDE_IMAGE_STATUS });
  for (const p of pages) if (!hasPublishableArt(p.render) || p.render.status !== 'ready') {
    if (p.render.status === 'stale' && hasPublishableArt(p.render)) continue;
    missing.push({ kind: 'page', n: p.n, status: STATUS_WORD[p.render.status] || p.render.status });
  }
  // Drawn art the publish would refuse (S6): never ok:true while publishing says no.
  for (const p of pages) if (hasPublishableArt(p.render) && !isServerArt(p.render.asset)) missing.push({ kind: 'page', n: p.n, status: OUTSIDE_IMAGE_STATUS });
  const stalePages = pages.filter((p) => p.render.status === 'stale').map((p) => p.n);
  const drawn = pages.filter((p) => hasPublishableArt(p.render));

  const blockedPages: number[] = [];
  const reasons = new Set<string>();
  let unchecked = false;
  const look = (status: SafetyStatus, categories?: string[], n?: number) => {
    if (status === 'blocked' || status === 'over_rating') {
      if (typeof n === 'number') blockedPages.push(n);
      (categories || []).forEach((c) => reasons.add(c));
      if (status === 'over_rating') reasons.add(`over ${rating}`);
    } else if (status !== 'pass') unchecked = true;
  };
  for (const p of drawn) look(safetyStatusOf(p.render.asset?.safety, rating), p.render.asset?.safety?.categories, p.n);
  if (hasPublishableArt(doc.cover?.render)) look(safetyStatusOf(doc.cover.render.asset?.safety, rating), doc.cover.render.asset?.safety?.categories);

  const source = doc.format?.language || 'en';
  const wanted = withSource(source, req?.languages?.length ? req.languages : doc.publication?.languages?.length ? doc.publication.languages : [source]);
  // Every edition the doc holds is listed (the Share sheet offers a finished translation that is not
  // published yet); only the requested ones decide `ok`.
  const listed: string[] = [];
  for (const lang of [...wanted, ...Object.keys(doc.i18n?.editions || {})]) if (!listed.some((l) => sameLanguage(l, lang))) listed.push(lang);
  const languages = listed.map((lang) => {
    const r = editionReadiness(doc, lang);
    return { lang, publishable: r.publishable, blocking: r.issues.filter((i) => i.blocking).map((i) => i.text), requested: wanted.some((w) => sameLanguage(w, lang)) };
  });
  const safetyStatus: PublishReadiness['safety']['status'] = blockedPages.length ? 'blocked' : unchecked ? 'needs_check' : 'cleared';
  return {
    ok: drawn.length > 0 && missing.length === 0 && stalePages.length === 0 && safetyStatus !== 'blocked' && languages.every((l) => !l.requested || l.publishable),
    drawnPages: drawn.length,
    plannedPages: pages.length,
    missing,
    stalePages,
    safety: { status: safetyStatus, blockedPages, reasons: [...reasons] },
    languages
  };
}

// ── Owner view ───────────────────────────────────────────────────────────────

function summarizeStats(row: PublicationRow, days: StatsRow[], now: number): PublicationOwnerView['stats'] {
  const since7 = new Date(now - 7 * 86_400_000).toISOString().slice(0, 10);
  const recent = days.filter((d) => d.day >= since7);
  const byChannel7d: Record<string, number> = {};
  for (const d of recent) for (const [k, v] of Object.entries(d.byChannel || {})) byChannel7d[k] = (byChannel7d[k] || 0) + (Number(v) || 0);
  return {
    views: row.viewsCount || 0,
    uniques7d: recent.reduce((s, d) => s + d.uniques, 0),
    completes7d: recent.reduce((s, d) => s + d.completes, 0),
    byChannel7d,
    daily: days.slice(-14).map((d) => ({ day: d.day, views: d.views }))
  };
}

async function buildView(ctx: StudioContext, doc: ComicDoc, row: PublicationRow | null, opts: { stats?: boolean; req?: PublishRequest } = {}): Promise<PublicationOwnerView> {
  const d = deps();
  const readiness = await getReadiness(ctx, doc, opts.req ?? (row && row.languages.length ? { visibility: row.visibility, languages: row.languages } : undefined));
  const live = isLiveish(row);
  // The frozen label is reader-visible: when the comic's rating has changed since publishing (the
  // owner picked another rating, the audience changed, or the account ceiling moved), republishing
  // would re-check and relabel it, so the published version is "behind". Rows without a recorded
  // rating never trip this (nothing to compare).
  const publishedRating = live ? publicationRatingOf(row) : undefined;
  const view: PublicationOwnerView = {
    visibility: live ? row.visibility : 'private',
    status: row ? row.status : null,
    languages: row?.languages?.length ? [...row.languages] : [doc.format?.language || 'en'],
    allowDownload: row ? row.allowDownload : PUBLISH_DEFAULTS.allowDownload,
    allowEmbed: row ? row.allowEmbed : PUBLISH_DEFAULTS.allowEmbed,
    showCreator: row ? row.showCreator : PUBLISH_DEFAULTS.showCreator,
    publishedRev: live ? row.publishedRev : 0,
    docRev: doc.rev,
    behind: live
      ? contentFingerprint(doc, row.languages) !== String(row.safety?.contentHash || '') || (!!publishedRating && publishedRating !== ratingOf(ctx, doc))
      : false,
    readiness
  };
  if (live) {
    view.slug = row.slug;
    view.url = comicShareUrl(row.slug);
    // A suspended link's copies are taken down (removePublicationObjects): no broken preview image.
    const og = row.status === 'live' ? ogUrlOf(row.card, row.defaultLang || row.languages[0]) : undefined;
    if (og) view.ogImageUrl = og;
    if (row.publishedAt) view.publishedAt = row.publishedAt;
    if (row.startPage !== undefined) view.startPage = row.startPage ?? null;
    if (publishedRating) view.rating = publishedRating;
    // The frozen card: what chat apps show for the link (the sheet's preview mock must not show live, unpublished text).
    const card = isRecord(row.card) && (row.card as unknown as ShareCard).v === 1 ? (row.card as unknown as ShareCard) : null;
    if (card) {
      const text = (isRecord(card.i18n) && card.i18n[row.defaultLang || row.languages[0]]) || { title: card.title, description: card.description };
      view.card = { title: String(text.title ?? card.title ?? ''), description: String(text.description ?? card.description ?? '') };
      // A suspended link's copies are taken down: no broken cover either.
      if (row.status === 'live' && typeof card.coverUrl === 'string' && /^https:\/\//.test(card.coverUrl)) view.card.coverUrl = card.coverUrl;
    }
    // The consented exclusions that still apply, so an Update from the sheet can resend them (a blocked
    // verdict stays blocked). Only pages publishing would still refuse: blocked now (readiness is computed
    // without the exclusion) or still an outside image. A page redrawn since drops out, and the gate decides
    // on the redraw (a blocked redraw gets "Publish without page N" again) instead of staying out forever.
    const stillOut = new Set(
      (doc.pages || []).filter((p) => readiness.safety.blockedPages.includes(p.n) || (hasPublishableArt(p.render) && !isServerArt(p.render.asset))).map((p) => p.id)
    );
    const excluded = Array.isArray(row.safety?.excludedPageIds)
      ? (row.safety.excludedPageIds as unknown[]).filter((id): id is string => typeof id === 'string' && PAGE_ID_RE.test(id) && stillOut.has(id))
      : [];
    if (excluded.length) view.excludedPageIds = excluded;
  }
  if (row?.defaultLang) view.defaultLang = row.defaultLang;
  if (row?.firstPublishedAt) view.firstPublishedAt = row.firstPublishedAt;
  if (row?.status === 'suspended') view.suspendedReason = 'Our team paused this link while it is reviewed. Readers see “This link isn’t active”.';
  if (opts.stats && row?.id) {
    try {
      const days = await d.store.stats(row.id, 14);
      // No reads recorded yet: leave stats out so the sheet says "stats appear once people open
      // your link" instead of a wall of zeros that looks like nobody read it.
      if (days.length || (row.viewsCount || 0) > 0) view.stats = summarizeStats(row, days, d.now());
    } catch {
      /* stats are optional */
    }
  }
  return view;
}

/** GET /publication: the owner's view (readiness computed live; stats for the last 14 days). */
export async function getPublicationView(ctx: StudioContext): Promise<PublicationOwnerView> {
  const row = await deps().store.get(ctx.projectId, ctx.userId);
  return buildView(ctx, ctx.session.doc, row, { stats: true });
}

// ── Gate interpretation ──────────────────────────────────────────────────────

const BAD: ReadonlySet<SafetyStatus> = new Set(['blocked', 'over_rating']);

interface GateDecision {
  pageIds: string[];
  includeCover: boolean;
  blockers: SafetyBlocker[];
}

/** Turn a gate result into the pages that may go out, or throw the honest refusal. */
export function interpretGate(doc: ComicDoc, gate: PublishGateResult, pageIds: string[], includeCover: boolean, exclude: Set<string>): GateDecision {
  const byId = new Map(doc.pages.map((p) => [p.id, p]));
  const blockers: SafetyBlocker[] = [];
  if (BAD.has(gate.text?.status)) {
    throw new PublishError('SAFETY_BLOCKED', "Some of the comic's words don't fit the content rules, so it can't be published yet. Edit the flagged text and try again.", {
      status: 422,
      code: 'SAFETY_BLOCKED',
      details: { text: true, reasons: gate.text.reasons || [] }
    });
  }
  const blockedPages: number[] = [];
  const reasons = new Set<string>();
  const out: string[] = [];
  // Only text the gate checked AND passed is published; anything else fails closed below.
  let unsure = gate.text?.status !== 'pass';
  for (const id of pageIds) {
    const verdict = gate.pages?.[id];
    const status: SafetyStatus = verdict?.status ?? 'unchecked';
    if (BAD.has(status)) {
      blockers.push({ target: { kind: 'page', id }, status: status as SafetyBlocker['status'], categories: [], ...(verdict?.reasons?.[0] ? { note: verdict.reasons[0].slice(0, 140) } : {}) });
      if (!exclude.has(id)) {
        blockedPages.push(byId.get(id)?.n ?? 0);
        (verdict?.reasons || []).forEach((r) => reasons.add(r));
      }
      continue;
    }
    // Only a page the gate PASSED goes out; anything else it could not vouch for (unchecked,
    // pending, or a status this code does not know) fails closed as "could not check".
    if (status === 'pass') out.push(id);
    else unsure = true;
  }
  if (blockedPages.length) {
    const list = blockedPages.sort((a, b) => a - b).join(', ');
    throw new PublishError('SAFETY_BLOCKED', `Page ${list} ${blockedPages.length === 1 ? "doesn't" : "don't"} fit the content rules. Publish without ${blockedPages.length === 1 ? 'it' : 'them'}, or redraw ${blockedPages.length === 1 ? 'it' : 'them'} first.`, {
      status: 422,
      code: 'SAFETY_BLOCKED',
      details: { blockedPages, reasons: [...reasons], blockers }
    });
  }
  let cover = includeCover;
  if (includeCover) {
    const status: SafetyStatus = gate.cover?.status ?? 'unchecked';
    if (BAD.has(status)) {
      cover = false; // a blocked cover is simply left out; the preview falls back to page 1
      blockers.push({ target: { kind: 'cover' }, status: status as SafetyBlocker['status'], categories: [] });
    } else if (status !== 'pass') unsure = true;
  }
  if (unsure || gate.status === 'needs_check') {
    throw new PublishError('NOT_AVAILABLE', "Safety checks are unavailable right now, so nothing was published — your comic stays private. Try again in a few minutes.", {
      status: 503,
      code: 'NOT_AVAILABLE'
    });
  }
  if (!out.length) throw new PublishError('NOT_READY', 'There are no pages left to publish.', { status: 422, code: 'NOT_READY' });
  return { pageIds: out, includeCover: cover, blockers };
}

// ── Publish ──────────────────────────────────────────────────────────────────

export interface PublishOutcome {
  view: PublicationOwnerView;
  blockers: SafetyBlocker[];
  firstTime: boolean;
}

/** Copy every planned object that the previous snapshot doesn't already hold; returns the plan minus failed variants. */
async function copyPlanned(ctx: StudioContext, plan: SnapshotPlan, have: Set<string>): Promise<{ plan: SnapshotPlan; copied: string[] }> {
  const copied: string[] = [];
  const failedOriginals: string[] = [];
  const paths = { ...plan.paths };
  const originals = new Set<string>();
  // Originals are the entries whose target has no -w480/-w1080 suffix.
  for (const [src, dst] of Object.entries(paths)) if (!/-w(480|1080)\.webp$/.test(dst)) originals.add(src);
  await mapLimit(Object.entries(plan.paths), 4, async ([src, dst]) => {
    if (have.has(dst)) return;
    try {
      await ctx.assets.copyObject(src, dst);
      copied.push(dst);
    } catch (err) {
      if (originals.has(src)) failedOriginals.push(src);
      else delete paths[src]; // a missing downscale only costs bandwidth: readers fall back to the full image
      logger.warn('comic_publish_copy_failed', { projectId: ctx.projectId, variant: !originals.has(src), message: (err as Error)?.message });
    }
  });
  if (failedOriginals.length) {
    if (copied.length) await ctx.assets.remove(copied).catch(() => undefined);
    throw new StudioError('NOT_AVAILABLE', "Couldn't copy your pages for publishing right now. Nothing was published — please try again.", { status: 503, retryable: true });
  }
  return { plan: { ...plan, paths }, copied };
}

/** Give assets without downscales their 480/1080 variants (P1-STORAGE), best-effort. */
async function withVariants(ctx: StudioContext, doc: ComicDoc, pageIds: string[], includeCover: boolean): Promise<ComicDoc> {
  const want = new Set(pageIds);
  const targets: { asset: AssetRef; set: (a: AssetRef) => void }[] = [];
  const pages = doc.pages.map((p) => ({ ...p, render: { ...p.render } }));
  for (const p of pages) if (want.has(p.id) && p.render.asset && !(p.render.asset.variants || []).length) targets.push({ asset: p.render.asset, set: (a) => (p.render.asset = a) });
  const cover = { ...doc.cover, render: { ...doc.cover.render } };
  if (includeCover && cover.render.asset && !(cover.render.asset.variants || []).length) targets.push({ asset: cover.render.asset, set: (a) => (cover.render.asset = a) });
  if (!targets.length) return doc;
  await mapLimit(targets, 2, async (t) => {
    try {
      const variants = await ctx.assets.ensureVariants(t.asset);
      if (variants?.length) t.set({ ...t.asset, variants });
    } catch {
      /* stub or failure: publish without downscales */
    }
  });
  return { ...doc, pages, cover };
}

async function buildOg(
  ctx: StudioContext,
  doc: ComicDoc,
  snapshot: ComicDoc,
  plan: SnapshotPlan,
  languages: string[],
  previous: ShareCard | null,
  rating?: ContentRating
): Promise<{ og: ShareCard['og']; themeColor?: string; written: string[] }> {
  const d = deps();
  const og: ShareCard['og'] = {};
  const written: string[] = [];
  const pageCount = snapshot.pages.length;
  const coverAsset = plan.includeCover ? doc.cover.render.asset : undefined;
  const firstPage = doc.pages.find((p) => p.id === plan.pageIds[0])?.render.asset;
  const coverPath = previewPathOf(coverAsset) || previewPathOf(firstPage);
  const kind = kindLabelOf(doc.format.kind);
  const langsLabel = languagesLabel(languages);
  const source = localizedText(doc, doc.format.language, pageCount);
  let coverBuf: Buffer | null | undefined;
  let themeColor = previous?.themeColor;
  for (const lang of languages) {
    const text = localizedText(doc, lang, pageCount);
    const base = { title: text.title, subtitle: text.description, kindLabel: kind, pageCount, lang, showMark: true as const, languagesLabel: langsLabel, fallbackTitle: source.title, ...(rating ? { rating } : {}) };
    const hash = ogHash({ ...base, coverPath });
    const path = ogPath(plan.assetKey, lang, hash);
    const alt = cleanText(`Cover of ${text.title}, a ${kind.toLowerCase()}`, 200);
    if (previous?.og?.[lang]?.path === path) {
      og[lang] = { path, w: 1200, h: 630, alt };
      continue;
    }
    try {
      if (coverBuf === undefined) coverBuf = await bufferOf(ctx, coverPath);
      if (!themeColor) themeColor = await dominantColor(coverBuf);
      const out = await d.renderOg({ ...base, coverBuf, fallbackPageBuf: null, ...(themeColor ? { themeColor } : {}) });
      await ctx.assets.putObject(path, out.jpeg, 'image/jpeg', '31536000');
      written.push(path);
      og[lang] = { path, w: 1200, h: 630, alt };
      themeColor = out.themeColor || themeColor;
    } catch (err) {
      // The preview image is a nicety: the link still previews with the cover image.
      logger.warn('comic_og_render_failed', { projectId: ctx.projectId, lang, message: (err as Error)?.message });
    }
  }
  return { og, ...(themeColor ? { themeColor } : {}), written };
}

const HELD_MESSAGE = 'This comic is paused by DreamStream moderation, so it can’t be published right now. You can still read and edit it.';

/**
 * A moderation hold that landed while this write was in flight (L11). The projects trigger only
 * suspends a row that is live when the hold commits, and the hold's takedown
 * (removePublicationObjects) runs right after it — both usually long before a publish that was
 * mid-check writes its row. Without this, that write leaves a LIVE row on a held comic: its fresh
 * copies are never taken down (no sweep touches a live row), an update's snapshot points at the
 * copies the takedown just deleted, and lifting the hold would serve it again as is. So the hold is
 * read again after every write that leaves the row live: when it is on, the row is suspended, its
 * copies (and `alsoKeys`, e.g. regenerate's old key) are removed, and the owner gets the same honest
 * 403 as a publish refused up front. A failed read is logged and the write stands (the trigger and
 * the takedown cover every other ordering); a failed suspension keeps the copies (never a live row
 * pointing at deleted objects).
 */
async function refuseIfHeldMeanwhile(ctx: StudioContext, row: PublicationRow, alsoKeys: string[] = []): Promise<void> {
  const d = deps();
  let held: boolean;
  try {
    held = (await d.store.projectFlags(ctx.projectId, ctx.userId)).forcedPrivate;
  } catch (err) {
    logger.warn('comic_publication_hold_recheck_failed', { projectId: ctx.projectId, message: (err as Error)?.message });
    return;
  }
  if (!held) return;
  const suspended: PublicationRow = { ...row, status: 'suspended', updatedAt: d.now() };
  let takenDown = false;
  try {
    await d.store.upsert(suspended);
    takenDown = true;
  } catch (err) {
    logger.warn('comic_publication_hold_suspend_failed', { projectId: ctx.projectId, message: (err as Error)?.message });
  }
  if (takenDown) {
    for (const key of new Set([row.assetKey, ...alsoKeys])) {
      if (!key || !ASSET_KEY_RE.test(key)) continue;
      await ctx.assets.removePrefix(`pub/${key}/`).catch((err) => logger.warn('comic_publication_takedown_failed', { projectId: ctx.projectId, message: (err as Error)?.message }));
    }
    const ops = mirrorOps(ctx.session.doc, suspended);
    if (ops.length) ctx.session.commit(ops, { origin: 'job', label: 'Paused by moderation' });
  }
  logger.info('comic_publication_hold_raced', { projectId: ctx.projectId, takenDown });
  throw new PublishError('FORBIDDEN', HELD_MESSAGE, { status: 403, code: 'FORBIDDEN' });
}

/** Publish or update. Throws PublishError with an honest message on every refusal; nothing changes on a refusal. */
export async function publishWithOutcome(ctx: StudioContext, rawReq: PublishRequest): Promise<PublishOutcome> {
  const req = parsePublishRequest(rawReq);
  takePublishBudget(ctx.userId, deps().now());
  return withLock(ctx, async () => {
    const d = deps();
    const doc = ctx.session.doc;
    const flags = await d.store.projectFlags(ctx.projectId, ctx.userId);
    if (!flags.exists) throw new PublishError('NOT_FOUND', "That comic doesn't exist or you don't have access to it.", { status: 404, code: 'NOT_FOUND' });
    if (flags.forcedPrivate) throw new PublishError('FORBIDDEN', HELD_MESSAGE, { status: 403, code: 'FORBIDDEN' });
    const existing = await d.store.get(ctx.projectId, ctx.userId);
    const live = isLiveish(existing) ? existing : null;
    // A row suspended by a moderation hold (now lifted) keeps its link, but its pub/ copies may have
    // been taken down (removePublicationObjects): everything is copied again under a fresh key.
    const fresh = !live || live.status === 'suspended';

    // Languages: the source is always published, first (i18n.md §11.1: readers always get the original;
    // sharing.md: languages[0] is the source), then each requested edition must be publishable.
    const source = doc.format?.language || 'en';
    const languages = withSource(source, req.languages?.length ? req.languages : live?.languages?.length ? live.languages : [source]);
    const incomplete = languages
      .map((lang) => ({ lang, r: editionReadiness(doc, lang) }))
      .filter((x) => !x.r.publishable)
      .map((x) => ({ lang: x.lang, name: languageSpec(x.lang)?.english || x.lang, blocking: x.r.issues.filter((i) => i.blocking).map((i) => i.text) }));
    if (incomplete.length) {
      throw new PublishError('LANG_INCOMPLETE', `${incomplete.map((x) => x.name).join(', ')} ${incomplete.length === 1 ? "isn't" : "aren't"} ready to publish yet: ${incomplete[0].blocking[0] || 'translation not finished'}`, {
        status: 422,
        code: 'NOT_READY',
        details: { languages: incomplete }
      });
    }
    // The edition readers start in: the request's, else the live one, else the first. A request that names
    // editions but not the original ("publish it in Hindi") gets the original added above, yet its default
    // stays among the editions it named (the live default if it is one of them, else the first named).
    const named = req.languages?.length && !req.languages.some((l) => sameLanguage(l, source)) ? req.languages : null;
    const pool = named ? languages.filter((l) => named.some((n) => sameLanguage(n, l))) : languages;
    const defaultLang =
      (req.defaultLang && languages.find((l) => sameLanguage(l, req.defaultLang))) ||
      (live?.defaultLang && pool.find((l) => sameLanguage(l, live.defaultLang!))) ||
      pool[0] ||
      languages[0];

    // Pages: drawn and not excluded; nothing mid-render.
    const exclude = new Set(req.excludePageIds || []);
    const busy = (doc.pages || []).filter((p) => !exclude.has(p.id) && (p.render.status === 'queued' || p.render.status === 'rendering'));
    if (busy.length || doc.cover?.render?.status === 'rendering' || doc.cover?.render?.status === 'queued') {
      const what = busy.length ? `Page ${busy.map((p) => p.n).join(', ')} ${busy.length === 1 ? 'is' : 'are'}` : 'The cover is';
      throw new PublishError('CONFLICT', `${what} still drawing — publish when ${busy.length === 1 || !busy.length ? 'it’s' : 'they’re'} done.`, { status: 409, code: 'CONFLICT' });
    }
    const candidates = drawnPages(doc).filter((p) => !exclude.has(p.id));
    if (!candidates.length) throw new PublishError('NOT_READY', 'Draw at least one page before publishing.', { status: 422, code: 'NOT_READY' });
    const wantCover = hasPublishableArt(doc.cover?.render);

    // The publication boundary (S6), before any platform-paid check: only art the server wrote to
    // a lane no client can rewrite is ever copied to pub/. Excluded pages are already left out.
    const outsidePages = candidates.filter((p) => !isServerArt(p.render.asset)).map((p) => p.n);
    const outsideCover = wantCover && !isServerArt(doc.cover.render.asset);
    if (outsidePages.length || outsideCover) throw outsideImageError(outsidePages, outsideCover);

    // Safety gate (both visibilities; platform-paid). It reads the doc itself: its text check is
    // shared publishableText(), which covers every author text the snapshot publishes (titles,
    // logline, tagline, cast names, lines, chapter titles, blurb, credits, dedication, style name
    // and the published translations), so no helper doc is needed.
    const gate = await d.gate(ctx, doc, { pageIds: candidates.map((p) => p.id), includeCover: wantCover, languages });
    const decision = interpretGate(doc, gate, candidates.map((p) => p.id), wantCover, exclude);
    // The rating the gate verified this snapshot under, frozen with the row (unknown → none).
    const rating = isContentRating(gate.rating) ? gate.rating : undefined;

    // Identity: keep the live link on an update; a NEW slug + key after an unpublish.
    const now = d.now();
    const assetKey = fresh ? d.newAssetKey() : live!.assetKey;
    const publicationId = existing?.id || crypto.randomUUID();
    const prepared = await withVariants(ctx, doc, decision.pageIds, decision.includeCover);
    const basePlan = planSnapshot(prepared, { assetKey, pageIds: decision.pageIds, includeCover: decision.includeCover, languages, defaultLang });
    const prevSnapshotPaths = live?.snapshot ? snapshotPaths(live.snapshot) : [];
    const prevOg = live ? pubPathsOfCard(live.card) : [];
    const have = new Set(fresh ? [] : prevSnapshotPaths);
    const { plan: copiedPlan, copied } = await copyPlanned(ctx, basePlan, have);
    const plan: SnapshotPlan = { ...copiedPlan, publicationId, publishedAt: now, rev: doc.rev };
    const snapshot = buildSnapshot(prepared, plan);

    const previousCard = !fresh && isRecord(live!.card) && (live!.card as unknown as ShareCard).v === 1 ? (live!.card as unknown as ShareCard) : null;
    const { og, themeColor, written } = await buildOg(ctx, prepared, snapshot, plan, languages, previousCard, rating);
    const showCreator = req.showCreator ?? existing?.showCreator ?? PUBLISH_DEFAULTS.showCreator;
    const creator = showCreator ? await d.store.publicUsername(ctx.userId) : undefined;
    const card = buildShareCard({ doc: prepared, snapshot, languages, publicUrl: d.publicUrl, og, ...(themeColor ? { themeColor } : {}), ...(creator ? { creator } : {}) });

    const startPage = req.startPage !== undefined ? req.startPage : live?.startPage ?? null;
    const row: PublicationRow = {
      id: publicationId,
      projectId: ctx.projectId,
      userId: ctx.userId,
      status: 'live',
      visibility: req.visibility,
      slug: live ? live.slug : d.newSlug(),
      assetKey,
      languages,
      defaultLang,
      startPage: typeof startPage === 'number' ? Math.min(startPage, Math.max(1, snapshot.pages.length)) : null,
      allowDownload: req.allowDownload ?? existing?.allowDownload ?? PUBLISH_DEFAULTS.allowDownload,
      allowEmbed: req.allowEmbed ?? existing?.allowEmbed ?? PUBLISH_DEFAULTS.allowEmbed,
      showCreator,
      snapshot,
      card,
      publishedRev: doc.rev,
      // The owner can read this row: no dollars in it (S5). The gate's platform cost is recorded
      // server-only (comic_safety_events / generation_cost_events).
      safety: {
        status: gate.status,
        ...(rating ? { rating } : {}),
        checkedHash: gate.checkedHash,
        excludedPageIds: [...exclude].filter((id) => doc.pages.some((p) => p.id === id)),
        contentHash: contentFingerprint(doc, languages)
      },
      firstPublishedAt: existing?.firstPublishedAt ?? now,
      publishedAt: now,
      unpublishedAt: null,
      updatedAt: now
    };
    try {
      for (let attempt = 0; ; attempt += 1) {
        try {
          await d.store.upsert(row);
          break;
        } catch (err) {
          if (!(err instanceof SlugTakenError) || live || attempt >= 3) throw err;
          row.slug = d.newSlug(); // a 101-bit collision: mint again
        }
      }
    } catch (err) {
      // Nothing went live: remove what this attempt copied/wrote (a brand-new key only owns them).
      const mine = [...copied, ...written];
      if (mine.length) await ctx.assets.remove(mine).catch(() => undefined);
      throw err;
    }
    // A hold that landed during the checks and copies above: suspend, take down, refuse (L11).
    await refuseIfHeldMeanwhile(ctx, row, live && live.assetKey !== assetKey ? [live.assetKey] : []);

    // Listing mirror (service role). The row is the truth; a failed mirror is logged, not fatal.
    await ctx.session.flush().catch(() => undefined);
    const publicCover = coverUrlPath(snapshot);
    try {
      await d.store.mirrorProject({ projectId: ctx.projectId, userId: ctx.userId, isPublic: row.visibility === 'public', shareSlug: row.slug, publicCover, publishedAt: now, listing: listingOf(snapshot), contentRating: rating ?? null });
    } catch (err) {
      logger.warn('comic_publication_mirror_failed', { projectId: ctx.projectId, message: (err as Error)?.message });
    }

    // Objects the new snapshot no longer references (same key only).
    if (live && !fresh) {
      const keep = new Set([...snapshotPaths(snapshot), ...pubPathsOfCard(card)]);
      const stale = [...prevSnapshotPaths, ...prevOg].filter((p) => p.startsWith(`pub/${assetKey}/`) && !keep.has(p));
      if (stale.length) await ctx.assets.remove(stale).catch((err) => logger.warn('comic_publish_cleanup_failed', { projectId: ctx.projectId, message: (err as Error)?.message }));
    } else if (live && live.assetKey !== assetKey) {
      // A republished suspension: whatever is left under the old key goes (the takedown may have run already).
      await ctx.assets.removePrefix(`pub/${live.assetKey}/`).catch((err) => logger.warn('comic_publish_cleanup_failed', { projectId: ctx.projectId, message: (err as Error)?.message }));
    }

    const ops = mirrorOps(ctx.session.doc, row);
    if (ops.length) ctx.session.commit(ops, { origin: 'job', label: 'Publish' });
    logger.info('comic_published', { projectId: ctx.projectId, visibility: row.visibility, pages: snapshot.pages.length, languages: languages.length, update: !!live });
    void maybeSweepOrphans(ctx.assets);
    return { view: await buildView(ctx, ctx.session.doc, row, { stats: false }), blockers: decision.blockers, firstTime: !live };
  });
}

/** What a PUBLIC gallery row shows: the published (gated) source-language title and logline. */
function listingOf(snapshot: ComicDoc | null): PublishedListing | undefined {
  if (!snapshot) return undefined;
  return {
    name: cleanText(snapshot.brief?.title || snapshot.cover?.title || 'Untitled comic', 200) || 'Untitled comic',
    overview: cleanText(snapshot.brief?.logline || '', 600)
  };
}

/** The gallery thumbnail: the opaque 1080 copy of the cover (else page 1). */
function coverUrlPath(snapshot: ComicDoc): string | null {
  const asset = snapshot.cover?.render?.asset || snapshot.pages?.[0]?.render?.asset;
  if (!asset) return null;
  return ((asset.variants || []).find((v) => v.w === 1080) || asset).path;
}

/** Publish or update (contract §12.7). */
export async function publish(ctx: StudioContext, req: PublishRequest): Promise<PublicationOwnerView> {
  return (await publishWithOutcome(ctx, req)).view;
}

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * The live doc with each published page's (and the cover's) render pointed back at the asset its
 * snapshot copy was made from — the current asset, an earlier version in render.history, or an
 * archived one — found by the copy's deterministic path (copiesFor). A settings change is gated on
 * what readers see, not on art drawn since (that stays private until Update). A published version
 * no longer anywhere in the doc leaves the current render in place. Never committed.
 */
function publishedArtDoc(doc: ComicDoc, row: PublicationRow & { assetKey: string }): ComicDoc {
  const snapshot = row.snapshot;
  if (!snapshot) return doc;
  const sourceOf = (render: RenderState | undefined, slot: 'cover' | 'page', targetKey: string, copy: AssetRef | undefined): AssetRef | undefined => {
    if (!render || !copy?.path) return undefined;
    const candidates: AssetRef[] = [...versionsOf(render), ...(doc.archive || []).filter((a) => a.targetKey === targetKey)];
    return candidates.find((a) => typeof a.path === 'string' && copiesFor(row.assetKey, slot, a)[a.path] === copy.path);
  };
  const swap = (render: RenderState, published: AssetRef | undefined): RenderState => (published && published.path !== render.asset?.path ? { ...render, status: 'ready', asset: published } : render);
  const copies = new Map((snapshot.pages || []).map((p) => [p.id, p.render?.asset]));
  const pages = doc.pages.map((p) => {
    const render = swap(p.render, sourceOf(p.render, 'page', `page:${p.id}`, copies.get(p.id)));
    return render === p.render ? p : { ...p, render };
  });
  const coverRender = swap(doc.cover.render, sourceOf(doc.cover?.render, 'cover', 'cover', snapshot.cover?.render?.asset));
  const cover = coverRender === doc.cover.render ? doc.cover : { ...doc.cover, render: coverRender };
  return pages.some((p, i) => p !== doc.pages[i]) || cover !== doc.cover ? { ...doc, pages, cover } : doc;
}

export async function updatePublication(ctx: StudioContext, rawPatch: PublicationSettingsPatch): Promise<PublicationOwnerView> {
  const patch = parseSettingsPatch(rawPatch);
  takePublishBudget(ctx.userId, deps().now());
  return withLock(ctx, async () => {
    const d = deps();
    const row = await d.store.get(ctx.projectId, ctx.userId);
    if (!row || row.status !== 'live' || !isLiveish(row)) throw notFound();
    const next: PublicationRow = { ...row, updatedAt: d.now() };
    const doc = ctx.session.doc;
    if (patch.visibility && patch.visibility !== row.visibility) {
      if (patch.visibility === 'public') {
        const flags = await d.store.projectFlags(ctx.projectId, ctx.userId);
        if (!flags.exists) throw notFound("That comic doesn't exist or you don't have access to it.");
        if (flags.forcedPrivate) {
          throw new PublishError('FORBIDDEN', 'This comic is paused by DreamStream moderation, so it can’t go public right now.', { status: 403, code: 'FORBIDDEN' });
        }
        // Going to the public gallery re-runs the gate (it may hold public-only rules) — over the art
        // readers see (the published versions), not renders drawn since, which stay private until Update.
        const gateDoc = publishedArtDoc(doc, row);
        const pageIds = (row.snapshot?.pages || []).map((p) => p.id).filter((id) => gateDoc.pages.some((p) => p.id === id));
        const gate = await d.gate(ctx, gateDoc, { pageIds, includeCover: !!row.snapshot?.cover?.render?.asset, languages: row.languages });
        if (pageIds.length) interpretGate(gateDoc, gate, pageIds, false, new Set());
        else if (BAD.has(gate.text?.status)) {
          // Same honest refusal as a publish: the words, not an outage, are the problem.
          throw new PublishError('SAFETY_BLOCKED', "Some of the comic's words don't fit the content rules, so it can't go public yet. Edit the flagged text and try again.", {
            status: 422,
            code: 'SAFETY_BLOCKED',
            details: { text: true, reasons: gate.text.reasons || [] }
          });
        } else if (gate.status !== 'cleared') throw new PublishError('NOT_AVAILABLE', 'Safety checks are unavailable right now. Try again in a few minutes.', { status: 503, code: 'NOT_AVAILABLE' });
      }
      next.visibility = patch.visibility;
    }
    if (patch.defaultLang !== undefined) {
      const match = row.languages.find((l) => sameLanguage(l, patch.defaultLang));
      if (!match) throw badRequest('The default language must be one of the published languages.');
      next.defaultLang = match;
    }
    if (patch.startPage !== undefined) {
      const pages = row.snapshot?.pages?.length || 0;
      if (patch.startPage !== null && patch.startPage > pages) throw badRequest(`The published comic has ${pages} ${pages === 1 ? 'page' : 'pages'}.`);
      next.startPage = patch.startPage;
    }
    if (patch.allowDownload !== undefined) next.allowDownload = patch.allowDownload;
    if (patch.allowEmbed !== undefined) next.allowEmbed = patch.allowEmbed;
    if (patch.showCreator !== undefined && patch.showCreator !== row.showCreator) {
      next.showCreator = patch.showCreator;
      const card = { ...(row.card as ShareCard) };
      if (patch.showCreator) {
        const name = await d.store.publicUsername(ctx.userId);
        if (name) card.creator = cleanText(name, 40);
      } else delete card.creator;
      next.card = card;
    }
    await d.store.upsert(next);
    // The row was read live before the (possibly slow) gate: a hold that landed meanwhile is honoured (L11).
    await refuseIfHeldMeanwhile(ctx, next);
    if (next.visibility !== row.visibility) {
      await ctx.session.flush().catch(() => undefined);
      await d.store.mirrorProject({
        projectId: ctx.projectId,
        userId: ctx.userId,
        isPublic: next.visibility === 'public',
        shareSlug: next.slug,
        publicCover: next.snapshot ? coverUrlPath(next.snapshot) : null,
        publishedAt: next.publishedAt ?? null,
        listing: listingOf(next.snapshot),
        // The snapshot did not change, so neither does its frozen rating (heals rows mirrored before ratings).
        ...(publicationRatingOf(next) ? { contentRating: publicationRatingOf(next) } : {})
      });
    }
    const ops = mirrorOps(ctx.session.doc, next);
    if (ops.length) ctx.session.commit(ops, { origin: 'job', label: 'Publication settings' });
    return buildView(ctx, ctx.session.doc, next, { stats: false });
  });
}

// ── Regenerate / unpublish ───────────────────────────────────────────────────

const rekey = <T>(value: T, from: string, to: string): T => JSON.parse(JSON.stringify(value).split(`pub/${from}/`).join(`pub/${to}/`)) as T;

/** New slug AND new asset prefix; the old link 404s as soon as the row commits; old objects are deleted. */
export async function regenerateLink(ctx: StudioContext): Promise<PublicationOwnerView> {
  takePublishBudget(ctx.userId, deps().now());
  return withLock(ctx, async () => {
    const d = deps();
    const row = await d.store.get(ctx.projectId, ctx.userId);
    if (!row || row.status !== 'live' || !isLiveish(row) || !row.snapshot) throw notFound();
    const oldKey = row.assetKey;
    const newKey = d.newAssetKey();
    const objects = [...snapshotPaths(row.snapshot), ...pubPathsOfCard(row.card)].filter((p) => p.startsWith(`pub/${oldKey}/`));
    const copied: string[] = [];
    try {
      await mapLimit(objects, 4, async (p) => {
        const dst = `pub/${newKey}/${p.slice(`pub/${oldKey}/`.length)}`;
        await ctx.assets.copyObject(p, dst);
        copied.push(dst);
      });
    } catch (err) {
      if (copied.length) await ctx.assets.remove(copied).catch(() => undefined);
      logger.warn('comic_regenerate_copy_failed', { projectId: ctx.projectId, message: (err as Error)?.message });
      throw new StudioError('NOT_AVAILABLE', "Couldn't make a new link right now. Your current link still works — please try again.", { status: 503, retryable: true });
    }
    const card = rekey(row.card as ShareCard, oldKey, newKey);
    if (row.snapshot) {
      const fresh = coverUrlOf(rekey(row.snapshot, oldKey, newKey), d.publicUrl);
      if (fresh) card.coverUrl = fresh;
    }
    const next: PublicationRow = { ...row, slug: d.newSlug(), assetKey: newKey, snapshot: rekey(row.snapshot, oldKey, newKey), card, updatedAt: d.now() };
    for (let attempt = 0; ; attempt += 1) {
      try {
        await d.store.upsert(next);
        break;
      } catch (err) {
        if (!(err instanceof SlugTakenError) || attempt >= 3) {
          await ctx.assets.remove(copied).catch(() => undefined);
          throw err;
        }
        next.slug = d.newSlug();
      }
    }
    // A hold that landed while the copies were made: suspend, take both keys down, refuse (L11).
    await refuseIfHeldMeanwhile(ctx, next, [oldKey]);
    await ctx.session.flush().catch(() => undefined);
    try {
      const keptRating = publicationRatingOf(next);
      await d.store.mirrorProject({ projectId: ctx.projectId, userId: ctx.userId, isPublic: next.visibility === 'public', shareSlug: next.slug, publicCover: next.snapshot ? coverUrlPath(next.snapshot) : null, publishedAt: next.publishedAt ?? null, listing: listingOf(next.snapshot), ...(keptRating ? { contentRating: keptRating } : {}) });
    } catch (err) {
      logger.warn('comic_publication_mirror_failed', { projectId: ctx.projectId, message: (err as Error)?.message });
    }
    await ctx.assets.removePrefix(`pub/${oldKey}/`).catch((err) => logger.warn('comic_regenerate_cleanup_failed', { projectId: ctx.projectId, message: (err as Error)?.message }));
    const ops = mirrorOps(ctx.session.doc, next);
    if (ops.length) ctx.session.commit(ops, { origin: 'job', label: 'New share link' });
    logger.info('comic_publication_regenerated', { projectId: ctx.projectId });
    void maybeSweepOrphans(ctx.assets);
    return buildView(ctx, ctx.session.doc, next, { stats: false });
  });
}

/** Idempotent. The slug dies, the snapshot and copies are deleted; stats are kept. Re-publishing mints a NEW slug. */
export async function unpublish(ctx: StudioContext): Promise<PublicationOwnerView> {
  return withLock(ctx, async () => {
    const d = deps();
    const row = await d.store.get(ctx.projectId, ctx.userId);
    let next = row;
    if (row && row.status !== 'unpublished') {
      const oldKey = row.assetKey;
      next = { ...row, status: 'unpublished', slug: null, assetKey: null, snapshot: null, card: {}, unpublishedAt: d.now(), updatedAt: d.now() };
      await d.store.upsert(next);
      await ctx.session.flush().catch(() => undefined);
      try {
        await d.store.mirrorProject({ projectId: ctx.projectId, userId: ctx.userId, isPublic: false, shareSlug: null, publicCover: null, publishedAt: null, contentRating: null });
      } catch (err) {
        logger.warn('comic_publication_mirror_failed', { projectId: ctx.projectId, message: (err as Error)?.message });
      }
      if (oldKey && ASSET_KEY_RE.test(oldKey)) {
        await ctx.assets.removePrefix(`pub/${oldKey}/`).catch((err) => logger.warn('comic_unpublish_cleanup_failed', { projectId: ctx.projectId, message: (err as Error)?.message }));
      }
      logger.info('comic_unpublished', { projectId: ctx.projectId });
      void maybeSweepOrphans(ctx.assets);
    }
    const ops = mirrorOps(ctx.session.doc, null);
    if (ops.length) ctx.session.commit(ops, { origin: 'job', label: 'Unpublish' });
    return buildView(ctx, ctx.session.doc, next, { stats: false });
  });
}

// ── Public side ──────────────────────────────────────────────────────────────

/** The reader payload of a live row: `urls` maps every snapshot path to its public object URL. */
export function payloadOf(row: PublicationRow, publicUrl = deps().publicUrl): PublicComicPayload | null {
  if (!isLiveish(row) || row.status !== 'live' || !row.snapshot) return null;
  const prefix = `pub/${row.assetKey}/`;
  const urls: Record<string, string> = {};
  for (const p of snapshotPaths(row.snapshot)) if (p.startsWith(prefix)) urls[p] = publicUrl(p);
  return {
    publication: {
      slug: row.slug,
      visibility: row.visibility,
      languages: [...row.languages],
      ...(row.defaultLang ? { defaultLang: row.defaultLang } : {}),
      startPage: row.startPage ?? null,
      allowDownload: row.allowDownload,
      allowEmbed: row.allowEmbed,
      publishedAt: row.publishedAt ?? 0,
      updatedAt: row.updatedAt ?? 0,
      card: row.card as ShareCard,
      ...(publicationRatingOf(row) ? { rating: publicationRatingOf(row) } : {})
    },
    doc: row.snapshot,
    urls
  };
}

/** Legacy /api/comic/public/:id: only a live + PUBLIC publication (never unlisted, never force-private). */
export async function loadPublicByProjectId(projectId: string): Promise<PublicComicPayload | null> {
  if (!projectId || !/^[A-Za-z0-9-]{1,64}$/.test(projectId)) return null;
  const row = await deps().store.getLivePublic(projectId);
  if (!row || row.visibility !== 'public') return null;
  return payloadOf(row);
}

// ── Maintenance ──────────────────────────────────────────────────────────────

/** How long a pub/ prefix is left alone before a sweep may remove it (same day-long grace as the orphan scan). */
export const SWEEP_GRACE_MS = 24 * 3_600_000;

/**
 * Takedown (L11): remove the pub/<key>/ copies of a publication that is no longer live. A moderation
 * hold suspends the row (DB trigger) so the slug stops resolving at once, but the opaque copies stayed
 * reachable by direct bucket URL; this deletes them. Called by the safety module after a hold or
 * suspension; best effort and logged — it never throws. A LIVE row's copies are never touched unless
 * the project is under a moderation hold (a publish that raced the hold): that row is suspended first,
 * so it can never point at deleted copies. Re-publishing after the hold is lifted copies everything
 * again under a fresh key (publishWithOutcome).
 */
export async function removePublicationObjects(projectId: string): Promise<void> {
  if (typeof projectId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(projectId)) return;
  const d = deps();
  try {
    const row = d.store.getByProject ? await d.store.getByProject(projectId) : null;
    if (!row?.assetKey || !ASSET_KEY_RE.test(row.assetKey)) return;
    if (row.status === 'live') {
      const flags = await d.store.projectFlags(projectId, row.userId);
      if (!flags.forcedPrivate) {
        logger.warn('comic_publication_takedown_skipped_live', { projectId });
        return;
      }
      await d.store.upsert({ ...row, status: 'suspended', updatedAt: d.now() });
    }
    const removed = await (await d.assets()).removePrefix(`pub/${row.assetKey}/`);
    logger.info('comic_publication_objects_removed', { projectId, removed, status: row.status === 'live' ? 'suspended' : row.status });
  } catch (err) {
    logger.warn('comic_publication_takedown_failed', { projectId, message: (err as Error)?.message });
  }
}

/**
 * Weekly sweep: delete pub/<key>/ prefixes that no live/suspended publication owns, and the copies
 * of publications suspended for longer than the grace period (a takedown that failed or never ran).
 * Returns objects removed.
 */
export async function sweepOrphanPublications(assets: { removePrefix(prefix: string): Promise<number> }, limit = 100): Promise<number> {
  const d = deps();
  const orphans = await d.store.orphanKeys(limit);
  const suspended = d.store.suspendedKeys ? await d.store.suspendedKeys(limit, d.now() - SWEEP_GRACE_MS).catch(() => [] as string[]) : [];
  const keys = [...new Set([...orphans, ...suspended])];
  let removed = 0;
  for (const key of keys) {
    if (!ASSET_KEY_RE.test(key)) continue;
    removed += await assets.removePrefix(`pub/${key}/`).catch(() => 0);
  }
  if (keys.length) logger.info('comic_publication_orphans_swept', { keys: keys.length, suspended: suspended.length, removed });
  return removed;
}

/** How often the opportunistic sweep may run per process. */
export const ORPHAN_SWEEP_EVERY_MS = 24 * 3_600_000;
let lastSweepAt = 0;
let sweeping: Promise<number> | null = null;

/**
 * Schedules the orphan sweep WITHOUT a timer (CLAUDE.md: nothing may keep the container awake): it
 * piggybacks on an owner's publication write — publish, new link, unpublish — at most once per
 * ORPHAN_SWEEP_EVERY_MS per process and never two at once. Fire-and-forget: it never delays or
 * fails the owner's request. Returns the running sweep, or null when it was not due.
 */
export function maybeSweepOrphans(assets: { removePrefix(prefix: string): Promise<number> }, now = deps().now()): Promise<number> | null {
  if (sweeping || (lastSweepAt && now - lastSweepAt < ORPHAN_SWEEP_EVERY_MS)) return null;
  lastSweepAt = now;
  const run = sweepOrphanPublications(assets)
    .catch((err) => {
      logger.warn('comic_publication_orphan_sweep_failed', { message: (err as Error)?.message });
      return 0;
    })
    .finally(() => {
      sweeping = null;
    });
  sweeping = run;
  return run;
}

/** Test hook: forget when the last opportunistic sweep ran. */
export function __resetOrphanSweep(): void {
  lastSweepAt = 0;
  sweeping = null;
}

// ── Conversation helpers (the publish card) ──────────────────────────────────

/** Ops that patch one card inside its message (no-op when the card is gone). */
export function cardPatchOps(doc: ComicDoc, cardId: string | undefined, patch: Partial<Extract<Card, { type: 'publish' }>>): DocOp[] {
  if (!cardId) return [];
  const msg = (doc.conversation || []).find((m) => (m.cards || []).some((c) => c.id === cardId && c.type === 'publish'));
  if (!msg) return [];
  const cards = (msg.cards || []).map((c) => (c.id === cardId && c.type === 'publish' ? ({ ...c, ...patch } as Card) : c));
  return [{ op: 'message_patch', id: msg.id, patch: { cards } }];
}

export const assistantNotice = (text: string, tone: 'success' | 'info' | 'warn' | 'error' = 'info', extraCards: Card[] = []): Msg => ({
  id: newId('msg'),
  role: 'assistant',
  text,
  at: Date.now(),
  cards: [{ type: 'notice', id: newId('card'), tone, text }, ...extraCards]
});

export { ogUrlOf, isLiveish };
