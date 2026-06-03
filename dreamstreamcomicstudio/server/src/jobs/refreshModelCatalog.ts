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

type SourceSpec = { id: 'openrouter' | 'nvidia'; key: string | null };

export const refreshModelCatalog = async (): Promise<{ source: string; count: number }[]> => {
  const sources: SourceSpec[] = [
    { id: 'openrouter', key: process.env.OPENROUTER_API_KEY || null },
    { id: 'nvidia', key: process.env.NVIDIA_API_KEY || null }
  ];

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
