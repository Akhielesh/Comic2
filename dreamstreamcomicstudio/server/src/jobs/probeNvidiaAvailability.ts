// Probe NVIDIA hosted-API callability.
//
// NVIDIA Build's /models lists many "download-only" NIMs that aren't served on the
// hosted API (integrate.api.nvidia.com) — calling them returns 404 "not found for
// account". The metadata gives no signal, so we VERIFY by probing each model with a
// tiny request and persist the result (model_catalog_cache.api_callable) so the UI can
// flag/disable models that can't actually be called.
//
// Run via `npm run nvidia:probe` (needs NVIDIA_API_KEY + Supabase service role).
// Schedule it alongside the catalog refresh. Transient failures (rate-limit/timeout)
// are recorded as "unknown" and left unchanged rather than wrongly marked uncallable.

import { NVIDIA_BASE_URL } from '../config.js';
import { persistCallability } from '../services/modelCatalogStore.js';
import { getSupabaseCapabilityStatus } from '../services/supabase.js';

type ProbeStatus = 'callable' | 'download_only' | 'unknown';

const probeModel = async (key: string, model: string): Promise<ProbeStatus> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(`${NVIDIA_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ok' }], max_tokens: 1, temperature: 0.2 }),
      signal: controller.signal
    });
    if (res.ok) return 'callable';
    const body = await res.text();
    if (res.status === 404 && /not found for account|no endpoints/i.test(body)) return 'download_only';
    // Validation errors do not prove account access or successful inference.
    return 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
};

export const probeNvidiaAvailability = async (): Promise<{ callable: number; downloadOnly: number; unknown: number }> => {
  const key = process.env.NVIDIA_API_KEY?.trim();
  if (!key) {
    throw new Error('NVIDIA_API_KEY_MISSING');
  }
  if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) throw new Error('CATALOG_STORAGE_UNAVAILABLE');

  const listRes = await fetch(`${NVIDIA_BASE_URL}/models`, { signal: AbortSignal.timeout(15_000) });
  if (!listRes.ok) throw new Error('NVIDIA_LIST_UNAVAILABLE');
  const list = await listRes.json();
  const ids: string[] = (Array.isArray(list?.data) ? list.data : [])
    .map((m: { id?: string }) => m.id)
    .filter((id: string): id is string => Boolean(id) && !/embed|rerank|nvclip/i.test(id));
  if (!ids.length) throw new Error('NVIDIA_LIST_EMPTY');

  const statuses: Array<{ id: string; status: ProbeStatus }> = [];
  const POOL = 6;
  let cursor = 0;
  const worker = async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      statuses.push({ id, status: await probeModel(key, id) });
    }
  };
  await Promise.all(Array.from({ length: POOL }, worker));

  // Only persist confident results; leave "unknown" rows unchanged.
  const decided = statuses.filter((s) => s.status !== 'unknown');
  await persistCallability('nvidia', decided.map((s) => ({ modelId: s.id, callable: s.status === 'callable' })), { strict: true });

  const summary = {
    callable: statuses.filter((s) => s.status === 'callable').length,
    downloadOnly: statuses.filter((s) => s.status === 'download_only').length,
    unknown: statuses.filter((s) => s.status === 'unknown').length
  };
  if (!decided.length) throw new Error('NVIDIA_PROBE_UNAVAILABLE');
  return summary;
};

const isDirectRun = Boolean(process.argv[1] && process.argv[1].includes('probeNvidiaAvailability'));
if (isDirectRun) {
  if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) {
    console.error(JSON.stringify({ ok: false, error: 'Storage disabled — set SUPABASE_SERVICE_ROLE_KEY + VITE_SUPABASE_URL.' }));
    process.exitCode = 1;
  } else {
    probeNvidiaAvailability()
      .then((summary) => console.log(JSON.stringify({ ok: true, summary, probedAt: new Date().toISOString() })))
      .catch((error) => {
        console.error(JSON.stringify({ ok: false, error: (error as Error).message }));
        process.exitCode = 1;
      });
  }
}
