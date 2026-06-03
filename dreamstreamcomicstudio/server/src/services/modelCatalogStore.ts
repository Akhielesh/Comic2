// Public model catalog cache — persistence layer (see server/sql/model_catalog_cache.sql).
//
// Why this exists: OpenRouter's model list is public, but NVIDIA Build's /models needs an
// authenticated call. To show NVIDIA (and any future auth-gated source) on the PUBLIC,
// logged-out models page, we cache the public model METADATA returned by any successful
// authenticated fetch — a platform key (scheduled refresh) or a logged-in user's BYOK key.
//
// SECURITY: we persist only public model metadata (the same data on build.nvidia.com /
// openrouter.ai). We never store the API key, and listing models costs no generation credits.
//
// Everything degrades gracefully: if Supabase storage isn't configured, persist is a no-op
// and load returns [] (the live path still works for keyed callers).

import { getSupabaseAdmin, getSupabaseCapabilityStatus } from './supabase.js';
import type { AnnotatedModel } from '../ai/catalogAnnotations.js';

const TABLE = 'model_catalog_cache';

/** Upsert the public metadata of a source's models. Fire-and-forget; never throws. */
export const persistHarvestedModels = async (source: string, models: AnnotatedModel[]): Promise<void> => {
  if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) return;
  if (!models.length) return;
  try {
    const admin = getSupabaseAdmin();
    const seenAt = new Date().toISOString();
    const rows = models
      .filter((m) => m.id)
      .map((m) => ({
        source,
        model_id: m.id,
        payload: m,
        supports_image_output: Boolean(m.supportsImageOutput),
        is_free: Boolean(m.isFree),
        last_seen_at: seenAt
      }));
    const { error } = await admin.from(TABLE).upsert(rows, { onConflict: 'source,model_id' });
    if (error) console.warn('[catalog-cache] persist failed:', error.message);
  } catch (err) {
    console.warn('[catalog-cache] persist threw:', (err as Error)?.message);
  }
};

/** Load cached models for a source (or all). Returns [] when storage is off or empty. */
export const loadPersistedModels = async (source?: string): Promise<AnnotatedModel[]> => {
  if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) return [];
  try {
    const admin = getSupabaseAdmin();
    let query = admin.from(TABLE).select('payload');
    if (source) query = query.eq('source', source);
    const { data, error } = await query;
    if (error || !Array.isArray(data)) return [];
    return data
      .map((row: { payload?: unknown }) => row.payload as AnnotatedModel)
      .filter((m): m is AnnotatedModel => Boolean(m && (m as AnnotatedModel).id));
  } catch {
    return [];
  }
};
