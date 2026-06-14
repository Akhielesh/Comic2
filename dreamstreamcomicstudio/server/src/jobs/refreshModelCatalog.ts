// Scheduled public-catalog refresh.
//
// Fetches each source's model list with the PLATFORM key and harvests the public metadata
// into model_catalog_cache, so the public/logged-out models page stays fresh even with zero
// user traffic. OpenRouter's list is public (no key needed); NVIDIA needs NVIDIA_API_KEY.
//
// Run via `npm run catalog:refresh` (and the .github/workflows cron). Never stores keys.

import { getProviderModels } from '../services/modelCatalog.js';
import { persistHarvestedModels } from '../services/modelCatalogStore.js';
import { getSupabaseCapabilityStatus } from '../services/supabase.js';
import { PROVIDERS_ORDERED } from '../../../shared/providers.js';
import type { AIProviderId } from '../ai/providers/types.js';

type SourceSpec = { id: AIProviderId; key: string | null };

export const refreshModelCatalog = async (): Promise<{ source: string; count: number }[]> => {
  // Harvest every provider's public model metadata with its platform key (when set), so the
  // logged-out models page stays fresh. OpenRouter's list is public; the others ship a curated
  // seed and add live ids when a platform key exists. Never stores keys.
  const sources: SourceSpec[] = PROVIDERS_ORDERED.map((def) => ({
    id: def.id as AIProviderId,
    key: process.env[def.keyEnv] || null
  }));

  const results: { source: string; count: number }[] = [];
  for (const { id, key } of sources) {
    const models = await getProviderModels(id, key);
    if (models.length) {
      await persistHarvestedModels(id, models);
    } else {
      console.warn(`[catalog-refresh] ${id}: 0 models (platform key set? ${Boolean(key)})`);
    }
    results.push({ source: id, count: models.length });
  }
  return results;
};

const isDirectRun = Boolean(process.argv[1] && process.argv[1].includes('refreshModelCatalog'));

if (isDirectRun) {
  if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) {
    console.error(JSON.stringify({ ok: false, error: 'Storage disabled — set SUPABASE_SERVICE_ROLE_KEY + VITE_SUPABASE_URL.' }));
    process.exitCode = 1;
  } else {
    refreshModelCatalog()
      .then((results) => console.log(JSON.stringify({ ok: true, results, refreshedAt: new Date().toISOString() })))
      .catch((error) => {
        console.error(JSON.stringify({ ok: false, error: (error as Error).message }));
        process.exitCode = 1;
      });
  }
}
