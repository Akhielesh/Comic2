// The storage paths a public classic comic shows to anyone: the reader's cover and panel art, and the style preview
// its Library and profile cards fall back to. Nothing else.
//
// A signed-out reader of a public classic comic needs signed URLs for exactly these paths. Never a character's
// reference photos or the cover template (author uploads, possibly of real people, used only as AI references), item
// art, image tags or an old render from a panel's history. (A Page Studio page is stored as a URL and never signed
// here.) Checking a path means reading every public project of its owner, and one reader asks for a whole comic's
// panels at once. So the answer is kept per owner for a short while: one query per owner per TTL, shared by
// concurrent requests, never cached when it fails. A comic unpublished or taken down meanwhile stops authorizing new
// URLs within the TTL (a URL already signed lives for its own lifetime, as for every signed image).

import type { SupabaseClient } from '@supabase/supabase-js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Owner ids as storage writes them: lower-case canonical UUIDs. Any other spelling can never match a stored path. */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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
  // Generated style samples: a Library or profile card shows one when the comic has no cover or panel art yet.
  if (Array.isArray(state.styleVariants)) for (const variant of state.styleVariants) if (isRecord(variant)) add(variant.imageId);
  return paths;
};

/**
 * The states of an owner's public projects, without force-private (moderated) ones, whatever is_public says
 * (service role; tolerates databases without the moderation column).
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

/** Publicly shown paths of an owner's public, not force-private projects. */
export const loadPublicReaderPaths = async (supabaseAdmin: SupabaseClient, ownerId: string): Promise<Set<string>> => {
  const paths = new Set<string>();
  for (const state of await loadPublicProjectStates(supabaseAdmin, ownerId)) for (const path of readerPathsOfState(state)) paths.add(path);
  return paths;
};

export interface PublicReaderPathCache {
  /**
   * The owner's public comics show `imagePath`: as stored, with the extension the client adds to an id stored without
   * one, or as the tmp-lane twin (`u/<owner>/tmp/<file>`) of a legacy `<owner>/<file>` path, which the image proxy
   * already signs in its place. An owner id not spelled as storage writes it is refused without a query.
   */
  shows: (ownerId: string, imagePath: string) => Promise<boolean>;
  clear: () => void;
}

export const createPublicReaderPathCache = (
  load: (ownerId: string) => Promise<Set<string>>,
  { ttlMs = 60_000, maxOwners = 500, now = Date.now }: { ttlMs?: number; maxOwners?: number; now?: () => number } = {}
): PublicReaderPathCache => {
  const entries = new Map<string, { at: number; paths: Promise<Set<string>> }>();

  const pathsOf = (ownerId: string): Promise<Set<string>> => {
    const hit = entries.get(ownerId);
    if (hit && now() - hit.at < ttlMs) {
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
      const forms = [imagePath, stem(imagePath)];
      const tmpFile = imagePath.startsWith(`u/${ownerId}/tmp/`) ? imagePath.slice(`u/${ownerId}/tmp/`.length) : null;
      if (tmpFile && !tmpFile.includes('/')) forms.push(`${ownerId}/${tmpFile}`, stem(`${ownerId}/${tmpFile}`));
      const paths = await pathsOf(ownerId);
      return forms.some((form) => form !== null && paths.has(form));
    },
    clear: () => entries.clear()
  };
};
