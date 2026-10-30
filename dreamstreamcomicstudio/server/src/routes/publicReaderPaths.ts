// The storage paths a public classic comic's reader shows: its cover and its panels' art. Nothing else.
//
// A signed-out reader of a public classic comic needs signed URLs for exactly these paths, and never for a
// character's reference photos, a style sheet or an old render from a panel's history. Checking a path means
// reading every public project of its owner, and one reader asks for a whole comic's panels at once. So the
// answer is kept per owner for a short while: one query per owner per TTL, shared by concurrent requests, never
// cached when it fails. A comic unpublished meanwhile stops authorizing new URLs within the TTL.

import type { SupabaseClient } from '@supabase/supabase-js';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const IMAGE_EXT = /\.(webp|png|jpe?g)$/i;

/** The paths a classic comic's reader shows. A Comic Studio v4 listing state never authorizes a storage path. */
export const readerPathsOfState = (state: unknown): string[] => {
  if (!isRecord(state) || state.studioVersion === 4) return [];
  const paths: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) paths.push(value.trim());
  };
  add(state.coverImageId);
  add(state.coverTemplateImageId);
  if (Array.isArray(state.panels)) for (const panel of state.panels) if (isRecord(panel)) add(panel.imageId);
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

/** Reader paths of an owner's public, not force-private projects. */
export const loadPublicReaderPaths = async (supabaseAdmin: SupabaseClient, ownerId: string): Promise<Set<string>> => {
  const paths = new Set<string>();
  for (const state of await loadPublicProjectStates(supabaseAdmin, ownerId)) for (const path of readerPathsOfState(state)) paths.add(path);
  return paths;
};

export interface PublicReaderPathCache {
  /**
   * The owner's public reader shows `imagePath`: as stored, with the extension the client adds to an id stored without
   * one, or as the tmp-lane twin (`u/<owner>/tmp/<file>`) of a legacy `<owner>/<file>` path, which the image proxy
   * already signs in its place.
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
    if (hit && now() - hit.at < ttlMs) return hit.paths;
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
      const paths = await pathsOf(ownerId);
      const forms = [imagePath, imagePath.replace(IMAGE_EXT, '')];
      const tmp = imagePath.match(/^u\/([0-9a-f-]{36})\/tmp\/([^/]+)$/i);
      if (tmp && tmp[1].toLowerCase() === ownerId.toLowerCase()) forms.push(`${ownerId}/${tmp[2]}`, `${ownerId}/${tmp[2].replace(IMAGE_EXT, '')}`);
      return forms.some((form) => paths.has(form));
    },
    clear: () => entries.clear()
  };
};
