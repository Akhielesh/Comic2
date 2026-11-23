import { createHash } from 'node:crypto';
import { IMAGE_MODELS } from '../../../shared/comic/models.js';
import { NATIVE_REFERENCE_MODEL, STANDALONE_MODEL } from '../../../shared/standaloneImage.js';
import { routeState } from '../comic/models/health.js';
import type { StudioKeys, ResolvedKey } from '../comic/types.js';
import { TtlCache } from '../lib/cache.js';
import { recentOpenRouterCreditExhaustion } from './providerBalances.js';

type Provider = 'gemini' | 'openrouter';
type Availability = 'ready' | 'unavailable' | 'invalid' | 'exhausted';
export interface WorkspaceImageRoute { provider: Provider; payer: 'personal' | 'platform'; model: string }

const credentialId = (owner: string, provider: Provider, key: string) =>
  createHash('sha256').update(JSON.stringify([owner, provider, key])).digest('hex');
const validated = new TtlCache<Availability>(60_000, 1000);
const probes = new TtlCache<Availability>(30_000, 1000);

// A Settings validation belongs only to this exact account and credential. Unknown
// responses don't erase a concrete rejection. A replacement key has a new identity.
export function rememberImageKeyValidation(owner: string, provider: string, key: string, status: string) {
  if ((provider === 'gemini' || provider === 'openrouter') && (status === 'invalid' || status === 'valid')) {
    const id = credentialId(owner, provider, key);
    validated.set(id, status === 'valid' ? 'ready' : 'invalid');
    for (const spec of IMAGE_MODELS) if (spec.routes[provider]) probes.delete(id + ':' + spec.routes[provider]);
  }
}

async function credentialReadiness(owner: string, provider: Provider, key: string, model: string): Promise<Availability> {
  const id = credentialId(owner, provider, key);
  const verified = validated.get(id);
  if (verified === 'invalid') return 'invalid';
  if (provider === 'openrouter' && recentOpenRouterCreditExhaustion(owner, key)) return 'exhausted';
  // A model-list validation proves the secret, not which Gemini image model it can access.
  // This short metadata probe checks the exact direct model or the router key's own limit.
  const cacheKey = id + ':' + model;
  return probes.getOrSet(cacheKey, async () => {
    try {
      const google = provider === 'gemini';
      const url = google
        ? 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model)
        : 'https://openrouter.ai/api/v1/key';
      const headers: Record<string, string> = google ? { 'x-goog-api-key': key } : { Authorization: 'Bearer ' + key };
      const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(1800) });
      if (!response.ok) {
        await response.body?.cancel();
        return [400, 401, 403, 404].includes(response.status) ? 'invalid' : 'unavailable';
      }
      if (google) {
        await response.body?.cancel();
        return 'ready';
      }
      const { data } = await response.json() as { data?: { limit_remaining?: number | null } };
      if (!data || typeof data !== 'object') return 'unavailable';
      return typeof data.limit_remaining === 'number' && data.limit_remaining <= 0 ? 'exhausted' : 'ready';
    } catch { return 'unavailable'; }
  });
}

const unavailable = (status: number, publicCode: string, message: string) =>
  Object.assign(new Error(message), { status, publicCode, publicMessage: message });

/** Every alternative has to serve the same named model and use the same funding preference. */
export async function selectStandaloneRoute(owner: string, keys: StudioKeys, model: string, freeOnly: boolean, deps = {
  readiness: credentialReadiness, circuit: routeState
}): Promise<WorkspaceImageRoute> {
  if (![STANDALONE_MODEL, NATIVE_REFERENCE_MODEL].includes(model)) throw unavailable(400, 'BAD_REQUEST', 'Choose a supported image model.');
  const spec = IMAGE_MODELS.find(row => row.routes.gemini === model);
  if (!spec) throw unavailable(400, 'BAD_REQUEST', 'Choose a supported image model.');
  const candidates: { provider: Provider; credential: ResolvedKey; model: string }[] = [];
  for (const provider of ['gemini', 'openrouter'] as const) {
    const credential = keys[provider];
    const routeModel = spec.routes[provider];
    if (credential && routeModel) candidates.push({ provider, credential, model: routeModel });
  }
  const personal = candidates.some(x => x.credential.byok);
  const eligible = candidates.filter(x => x.credential.byok === personal);
  if (!eligible.length) throw unavailable(422, 'IMAGE_KEY_MISSING', 'No enabled Gemini or OpenRouter key is available for this model.');
  const statuses = await Promise.all(eligible.map(async candidate => {
    if (deps.circuit(candidate.provider, candidate.model).state === 'down') return 'unavailable';
    if (!personal) return 'ready'; // platform credentials never enter a member-key probe
    return deps.readiness(owner, candidate.provider, candidate.credential.key, candidate.model);
  }));
  const chosen = eligible.find((option, index) => statuses[index] === 'ready' && !(freeOnly && option.provider === 'openrouter'));
  if (!chosen && eligible.some((option, index) => option.provider === 'openrouter' && statuses[index] === 'ready' && freeOnly)) {
    throw Object.assign(unavailable(402, 'NO_FREE_MODEL_AVAILABLE', 'This OpenRouter image requires approval for a paid request.'), {
      code: 'NO_FREE_MODEL_AVAILABLE', details: { provider: 'openrouter', payer: personal ? 'personal' : 'platform', model: spec.routes.openrouter }
    });
  }
  if (!chosen) {
    throw unavailable(statuses.includes('unavailable') ? 503 : 422, 'IMAGE_ROUTE_UNAVAILABLE',
      'No enabled ' + (personal ? 'personal ' : '') + 'image provider can use this model right now. Check your keys or retry shortly.');
  }
  return { provider: chosen.provider, payer: personal ? 'personal' : 'platform', model: chosen.model };
}
