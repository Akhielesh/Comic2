// The storage paths a public classic comic shows to anyone: the reader's cover, panel art and Page Studio pages, and
// the style preview its Library and profile cards fall back to. Nothing else.
//
// This is what the image proxy signs for a signed-out reader of a public classic comic. It never signs a character's
// reference photos or the cover template (author uploads, possibly of real people, used only as AI references), item
// or location art, image tags, a panel's older renders or a page's base image. That limits what the PROXY hands out;
// it is not a privacy boundary for those files on its own (the classic bucket serves objects by exact path, and a
// public row's state is readable with the anon key).
//
// Checking a path means reading every public project of its owner, and one reader asks for a whole comic's art at
// once. So the answer is kept per owner for a short while: one load per owner per TTL, shared by concurrent requests,
// never cached when it fails. A path the cached answer misses triggers one reload once that answer is a few seconds
// old, so a comic published or drawn a moment ago is not refused for a minute. A comic unpublished or taken down
// meanwhile stops authorizing new URLs for signed-out readers within the TTL (a URL already signed lives for its own
// lifetime, as for every signed image). Signed-in readers are checked live, against the same rule (showsIn over
// shownPathsOf), so this lag is the signed-out path's alone.

import type { SupabaseClient } from '@supabase/supabase-js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Owner ids as storage writes them: lower-case canonical UUIDs. Any other spelling can never match a stored path. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Ids longer than any storage path the app writes, or past this many per owner, are never kept (memory bound). */
export const MAX_PATH_LENGTH = 512;
export const MAX_PATHS_PER_OWNER = 5000;

/** `<dir>/<name>.<ext>` → `<dir>/<name>`: the extension the client adds to an id stored without one (never stacked). */
const stem = (path: string): string | null => path.match(/^(.*\/[^/.]+)\.(?:webp|png|jpg|jpeg)$/)?.[1] ?? null;

/** The paths a classic comic shows to anyone. A Comic Studio v4 listing state never authorizes a storage path. */
export const readerPathsOfState = (state: unknown): string[] => {
  if (!isRecord(state) || state.studioVersion === 4) return [];
  const paths: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) paths.push(value.trim());
  };
  add(state.coverImageId);
  if (Array.isArray(state.panels)) for (const panel of state.panels) if (isRecord(panel)) add(panel.imageId);
  // A Page Studio comic's pages: the reader shows each page's current art (never its base image or edits).
  if (isRecord(state.pageStudio) && Array.isArray(state.pageStudio.pages)) {
    for (const page of state.pageStudio.pages) if (isRecord(page)) add(page.imageId);
  }
  // Generated style samples: a Library or profile card shows one when the comic has no cover or panel art yet.
  if (Array.isArray(state.styleVariants)) for (const variant of state.styleVariants) if (isRecord(variant)) add(variant.imageId);
  return paths;
};

/**
 * The states of an owner's public projects, without force-private (moderated) ones, whatever is_public says
 * (service role; tolerates databases without the moderation column, and only that: any other error throws).
 */
export const loadPublicProjectStates = async (supabaseAdmin: SupabaseClient, ownerId: string): Promise<unknown[]> => {
  let rows: Array<{ state?: unknown; is_forced_private?: boolean | null }> = [];
  const first = await supabaseAdmin.from('projects').select('state, is_forced_private').eq('user_id', ownerId).eq('is_public', true);
  if (first.error) {
    if (String((first.error as { code?: string }).code || '') !== '42703') throw first.error;
    const fallback = await supabaseAdmin.from('projects').select('state').eq('user_id', ownerId).eq('is_public', true);
    if (fallback.error) throw fallback.error;
    rows = (fallback.data as typeof rows) || [];
  } else {
    rows = (first.data as typeof rows) || [];
  }
  return rows.filter((row) => row.is_forced_private !== true).map((row) => row.state);
};

/**
 * The shown paths of these (public, not force-private) states of one owner, as the proxy can be asked about them:
 * legacy `<owner>/<file>` ids and tmp-lane `u/<owner>/tmp/...` ids only (project-scoped and other paths have rules of
 * their own and never reach this check), each at most MAX_PATH_LENGTH long, at most MAX_PATHS_PER_OWNER of them.
 */
export const shownPathsOf = (states: unknown[], ownerId: string): Set<string> => {
  const paths = new Set<string>();
  const isLegacy = (path: string) => path.startsWith(`${ownerId}/`) && !path.slice(ownerId.length + 1).includes('/');
  for (const state of states) {
    for (const path of readerPathsOfState(state)) {
      if (path.length > MAX_PATH_LENGTH) continue;
      if (!isLegacy(path) && !path.startsWith(`u/${ownerId}/tmp/`)) continue;
      if (paths.has(path)) continue;
      if (paths.size >= MAX_PATHS_PER_OWNER) {
        console.warn(`[image-url] owner ${ownerId}: more than ${MAX_PATHS_PER_OWNER} shown images; the rest are not signed to signed-out readers`);
        return paths;
      }
      paths.add(path);
    }
  }
  return paths;
};

/** Publicly shown paths of an owner's public, not force-private projects (see shownPathsOf). */
export const loadPublicReaderPaths = async (supabaseAdmin: SupabaseClient, ownerId: string): Promise<Set<string>> =>
  shownPathsOf(await loadPublicProjectStates(supabaseAdmin, ownerId), ownerId);

/**
 * `paths` (an owner's shown paths) show `imagePath`: as stored, with the extension the client adds to an id stored
 * without one, or as the tmp-lane twin (`u/<owner>/tmp/<file>`) of a legacy `<owner>/<file>` path, which the image
 * proxy already signs in its place. An owner id not spelled as storage writes it never matches.
 */
export const showsIn = (paths: Set<string>, ownerId: string, imagePath: string): boolean => {
  if (!CANONICAL_UUID.test(ownerId)) return false;
  const forms = [imagePath, stem(imagePath)];
  const tmpFile = imagePath.startsWith(`u/${ownerId}/tmp/`) ? imagePath.slice(`u/${ownerId}/tmp/`.length) : null;
  if (tmpFile && !tmpFile.includes('/')) forms.push(`${ownerId}/${tmpFile}`, stem(`${ownerId}/${tmpFile}`));
  return forms.some((form) => form !== null && paths.has(form));
};

/** The production cache settings (system.ts uses them as they are). */
export const PUBLIC_READER_CACHE_DEFAULTS = { ttlMs: 60_000, refreshAfterMs: 5_000, maxOwners: 500 } as const;

export interface PublicReaderPathCache {
  /**
   * The owner's public comics show `imagePath` (see showsIn), from the cached answer. An owner id not spelled as
   * storage writes it is refused without a query. Rejects when the owner's projects cannot be read (callers fail
   * closed).
   */
  shows: (ownerId: string, imagePath: string) => Promise<boolean>;
  clear: () => void;
}

export const createPublicReaderPathCache = (
  load: (ownerId: string) => Promise<Set<string>>,
  {
    ttlMs = PUBLIC_READER_CACHE_DEFAULTS.ttlMs,
    refreshAfterMs = PUBLIC_READER_CACHE_DEFAULTS.refreshAfterMs,
    maxOwners = PUBLIC_READER_CACHE_DEFAULTS.maxOwners,
    now = Date.now
  }: { ttlMs?: number; refreshAfterMs?: number; maxOwners?: number; now?: () => number } = {}
): PublicReaderPathCache => {
  const entries = new Map<string, { at: number; paths: Promise<Set<string>> }>();

  /** The owner's paths, loaded at most `maxAgeMs` ago (one load shared by every concurrent caller). */
  const pathsOf = (ownerId: string, maxAgeMs: number): Promise<Set<string>> => {
    const hit = entries.get(ownerId);
    if (hit && now() - hit.at < maxAgeMs) {
      // Least recently used leaves first: an owner being read keeps its place.
      entries.delete(ownerId);
      entries.set(ownerId, hit);
      return hit.paths;
    }
    const entry = { at: now(), paths: load(ownerId) };
    entries.delete(ownerId);
    entries.set(ownerId, entry);
    entry.paths.catch(() => {
      if (entries.get(ownerId) === entry) entries.delete(ownerId);
    });
    while (entries.size > maxOwners) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    return entry.paths;
  };

  return {
    shows: async (ownerId, imagePath) => {
      if (!CANONICAL_UUID.test(ownerId)) return false;
      const matches = (paths: Set<string>) => showsIn(paths, ownerId, imagePath);
      const cached = pathsOf(ownerId, ttlMs);
      if (matches(await cached)) return true;
      // A miss on an answer more than a few seconds old: the comic may have been published or drawn since. Reload
      // once (shared with any concurrent miss); a fresh answer that misses is final.
      const fresh = pathsOf(ownerId, refreshAfterMs);
      return fresh !== cached && matches(await fresh);
    },
    clear: () => entries.clear()
  };
};
