// Migrated artwork retains the exact keys used by history, model references and publication fingerprints.
// Only the service-owned cutover record chooses its physical location.
import type { SupabaseClient } from '@supabase/supabase-js';
import { legacyArtScope } from '../../../shared/comic/imagePaths.js';
export { legacyArtScope } from '../../../shared/comic/imagePaths.js';
import { StudioError } from './types.js';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp('^' + UUID + '$', 'i');
const SCOPE_BATCH = 128;
const CACHE_LIMIT = 512;
const CACHE_MS = 60_000;
type Scope = { owner: string; project: string };
type Locations = Map<string, string>;
type Cache = {
  active: Map<string, { owner: string; until: number }>;
  pending: Map<string, Promise<Locations>>;
};

const unavailable = () =>
  new StudioError('NOT_AVAILABLE', 'Artwork storage could not be verified. Please try again.', { status: 503, retryable: true });
const caches = new WeakMap<SupabaseClient, Cache>();

async function loadOwners(db: SupabaseClient, ids: string[], cache: Cache): Promise<Locations> {
  try {
    const { data, error } = await db.rpc('comic_private_art_scopes', { p_project_ids: ids }).abortSignal(AbortSignal.timeout(5000));
    if (error || !Array.isArray(data)) throw unavailable();
    const owners: Locations = new Map();
    for (const row of data) {
      if (!row || !ids.includes(row.project_id) || !UUID_RE.test(row.owner_id) || owners.has(row.project_id)) throw unavailable();
      owners.set(row.project_id, row.owner_id);
    }
    for (const [project, owner] of owners) cache.active.set(project, { owner, until: Date.now() + CACHE_MS });
    while (cache.active.size > CACHE_LIMIT) cache.active.delete(cache.active.keys().next().value!);
    return owners;
  } catch {
    throw unavailable();
  }
}

/** One query per batch of distinct project IDs, coalesced across concurrent requests. A negative result is never cached. */
export async function migratedArtPaths(admin: () => SupabaseClient, paths: readonly string[]): Promise<Set<string>> {
  const scoped = new Map<string, Scope>();
  for (const path of paths) {
    const scope = legacyArtScope(path);
    if (scope) scoped.set(path, scope);
  }
  const result = new Set<string>();
  if (!scoped.size) return result;
  const db = admin();
  let cache = caches.get(db);
  if (!cache) {
    cache = { active: new Map(), pending: new Map() };
    caches.set(db, cache);
  }
  const owners: Locations = new Map();
  const pending = new Set<Promise<Locations>>();
  const missing: string[] = [];
  for (const project of new Set([...scoped.values()].map((scope) => scope.project))) {
    const cached = cache.active.get(project);
    if (cached && cached.until > Date.now()) {
      owners.set(project, cached.owner);
      continue;
    }
    cache.active.delete(project);
    const ongoing = cache.pending.get(project);
    if (ongoing) pending.add(ongoing);
    else missing.push(project);
  }
  for (let i = 0; i < missing.length; i += SCOPE_BATCH) {
    const ids = missing.slice(i, i + SCOPE_BATCH);
    const batch = loadOwners(db, ids, cache);
    for (const id of ids) if (cache.pending.size < CACHE_LIMIT) cache.pending.set(id, batch);
    try {
      for (const [project, owner] of await batch) owners.set(project, owner);
    } finally {
      for (const id of ids) if (cache.pending.get(id) === batch) cache.pending.delete(id);
    }
  }
  for (const values of await Promise.all(pending)) for (const [project, owner] of values) owners.set(project, owner);
  for (const [path, scope] of scoped) {
    const activeOwner = owners.get(scope.project);
    if (activeOwner && activeOwner !== scope.owner) throw unavailable();
    if (activeOwner) result.add(path);
  }
  return result;
}
