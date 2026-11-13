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

import { createHash } from 'node:crypto';
import { getSupabaseAdmin, getSupabaseCapabilityStatus } from './supabase.js';
import type { AnnotatedModel } from '../ai/catalogAnnotations.js';

const TABLE = 'model_catalog_cache';

/**
 * An unchanged list is not upserted again within this window (EGRESS-DB E4): the hourly refresh and every keyed
 * catalog request re-wrote thousands of identical rows (the largest database-time item).
 */
export const PERSIST_UNCHANGED_WINDOW_MS = 6 * 60 * 60_000;
const lastPersisted = new Map<string, { hash: string; at: number }>();

/** What a persisted row must keep current: each model's id, pricing, context length and modalities. */
export const catalogContentHash = (models: AnnotatedModel[]): string => {
  const rows = models
    .filter((m) => m && m.id)
    .map((m) => [m.id, m.pricing ?? null, m.contextLength ?? null, m.inputModalities ?? [], m.outputModalities ?? []] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex');
};

/** Forget what this process persisted (tests). */
export const resetPersistMemo = (): void => lastPersisted.clear();

/** Upsert the public metadata of a source's models. Fire-and-forget; never throws. */
export const persistHarvestedModels = async (source: string, models: AnnotatedModel[]): Promise<void> => {
  if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) return;
  if (!models.length) return;
  const hash = catalogContentHash(models);
  const previous = lastPersisted.get(source);
  if (previous && previous.hash === hash && Date.now() - previous.at < PERSIST_UNCHANGED_WINDOW_MS) return;
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
    else lastPersisted.set(source, { hash, at: Date.now() });
  } catch (err) {
    console.warn('[catalog-cache] persist threw:', (err as Error)?.message);
  }
};

/** Load cached models for a source (or all). Returns [] when storage is off or empty. */
export const loadPersistedModels = async (source?: string): Promise<AnnotatedModel[]> => {
  if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) return [];
  try {
    const admin = getSupabaseAdmin();
    // Supabase caps each response. Read every page so large catalogs are not silently cut off.
    type Row = { source?: string; payload?: unknown; api_callable?: boolean | null; last_seen_at?: string };
    const rows: Row[] = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      let query = admin.from(TABLE).select('source, payload, api_callable, last_seen_at')
        .order('source').order('model_id').range(offset, offset + pageSize - 1);
      if (source) query = query.eq('source', source);
      const { data, error } = await query;
      if (error || !Array.isArray(data)) return [];
      rows.push(...data);
      if (data.length < pageSize) break;
    }
    // This is a union of account-scoped discoveries, not an authoritative retirement list.
    // A later harvest can come from a different key with a smaller entitlement set. Keep
    // every model and expose its observation time; absence from another key is not removal.
    return rows
      .map((row): AnnotatedModel | null => {
        const model = row.payload as AnnotatedModel;
        if (!model?.id) return null;
        const checkedAt = Date.parse(row.last_seen_at || '');
        return {
          ...model,
          catalogOrigin: 'cached' as const,
          // Older NVIDIA snapshots predate explicit price provenance. Listing access
          // proves neither a free allowance nor a current per-call price.
          ...(model.source === 'nvidia' && model.pricingKnown === undefined ? { pricingKnown: false, pricingOrigin: 'unknown' as const } : {}),
          ...(Number.isFinite(checkedAt) ? { catalogCheckedAt: checkedAt } : {}),
          ...(typeof row.api_callable === 'boolean' ? { apiCallable: row.api_callable } : {})
        };
      })
      .filter((model): model is AnnotatedModel => model !== null);
  } catch {
    return [];
  }
};

/** model_id → hosted-API callability (only rows that have been probed). */
export const loadCallabilityMap = async (source: string): Promise<Map<string, boolean>> => {
  const map = new Map<string, boolean>();
  if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) return map;
  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin.from(TABLE).select('model_id, api_callable').eq('source', source);
    if (error || !Array.isArray(data)) return map;
    for (const row of data as Array<{ model_id?: string; api_callable?: boolean | null }>) {
      if (row.model_id && typeof row.api_callable === 'boolean') map.set(row.model_id, row.api_callable);
    }
    return map;
  } catch {
    return map;
  }
};

/** Persist hosted-API callability results from a probe. Updates only api_callable. */
export const persistCallability = async (
  source: string,
  results: Array<{ modelId: string; callable: boolean }>
): Promise<void> => {
  if (!getSupabaseCapabilityStatus().storagePersistenceEnabled || !results.length) return;
  try {
    const admin = getSupabaseAdmin();
    await Promise.all(
      results.map((r) =>
        admin.from(TABLE).update({ api_callable: r.callable }).eq('source', source).eq('model_id', r.modelId)
      )
    );
  } catch (err) {
    console.warn('[catalog-cache] callability persist threw:', (err as Error)?.message);
  }
};
