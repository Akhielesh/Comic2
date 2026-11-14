import { createPublicKey, verify, type JsonWebKey } from 'node:crypto';

export const CATALOG_MAINTENANCE_AUDIENCE = 'urn:dreamstream:catalog-maintenance';
export const CATALOG_MAINTENANCE_ISSUER = 'https://token.actions.githubusercontent.com';
export const CATALOG_MAINTENANCE_REF = 'refs/heads/Dreamstrream-v1';
export const CATALOG_MAINTENANCE_WORKFLOWS = {
  refresh: 'refresh-model-catalog.yml',
  'probe-nvidia': 'probe-nvidia-availability.yml'
} as const;
export type CatalogMaintenanceAction = keyof typeof CATALOG_MAINTENANCE_WORKFLOWS;
type SigningKey = JsonWebKey & { kid?: string; alg?: string; use?: string };
type Claims = Record<string, unknown>;
const JWKS_URL = `${CATALOG_MAINTENANCE_ISSUER}/.well-known/jwks`;

/** Fixed GitHub trust policy: no caller-controlled issuer, URL, repository, or workflow. */
export function validateMaintenanceClaims(claims: Claims, action: CatalogMaintenanceAction, now = Date.now()): void {
  const seconds = Math.floor(now / 1000);
  const { iat, nbf, exp, jti } = claims;
  const subjects = [
    `repo:Akhielesh/Comic2:ref:${CATALOG_MAINTENANCE_REF}`,
    `repo:Akhielesh@102168504/Comic2@1151761968:ref:${CATALOG_MAINTENANCE_REF}`
  ];
  if (claims.iss !== CATALOG_MAINTENANCE_ISSUER || claims.aud !== CATALOG_MAINTENANCE_AUDIENCE
    || claims.repository !== 'Akhielesh/Comic2' || claims.repository_id !== '1151761968'
    || claims.repository_owner !== 'Akhielesh' || claims.repository_owner_id !== '102168504'
    || claims.ref !== CATALOG_MAINTENANCE_REF || claims.ref_type !== 'branch'
    || claims.workflow_ref !== `Akhielesh/Comic2/.github/workflows/${CATALOG_MAINTENANCE_WORKFLOWS[action]}@${CATALOG_MAINTENANCE_REF}`
    || !subjects.includes(String(claims.sub)) || claims.job_workflow_ref !== undefined
    || !['schedule', 'workflow_dispatch'].includes(String(claims.event_name))
    || claims.runner_environment !== 'github-hosted'
    || typeof jti !== 'string' || jti.length < 8 || jti.length > 200
    || typeof iat !== 'number' || typeof exp !== 'number' || typeof nbf !== 'number'
    || ![iat, nbf, exp].every(Number.isFinite)
    || exp <= seconds || iat > seconds + 30 || nbf > seconds + 30
    || exp <= iat || exp - iat > 600 || seconds - iat > 600
    || !/^\d+$/.test(String(claims.run_id ?? '')) || !/^\d+$/.test(String(claims.run_attempt ?? ''))) {
    throw new Error('MAINTENANCE_UNAUTHORIZED');
  }
}

/** Factory isolates the bounded key/replay caches and permits real-signature unit tests. */
export function createMaintenanceAuthenticator(fetcher: typeof fetch = fetch, now: () => number = Date.now) {
  let keys: SigningKey[] = [];
  let keysExpire = 0;
  let lastKeyFetch = -Infinity;
  let inflightKeys: Promise<void> | null = null;
  const used = new Map<string, number>();

  async function loadKeys(): Promise<void> {
    if (inflightKeys) return inflightKeys;
    if (now() - lastKeyFetch < 30_000) throw new Error('MAINTENANCE_UNAUTHORIZED');
    lastKeyFetch = now();
    inflightKeys = (async () => {
      const response = await fetcher(JWKS_URL, { redirect: 'error', signal: AbortSignal.timeout(5_000) });
      if (!response.ok) throw new Error('MAINTENANCE_AUTH_UNAVAILABLE');
      const text = await response.text();
      if (text.length > 64_000) throw new Error('MAINTENANCE_AUTH_UNAVAILABLE');
      const body = JSON.parse(text);
      if (!Array.isArray(body.keys) || body.keys.length > 30) throw new Error('MAINTENANCE_AUTH_UNAVAILABLE');
      keys = body.keys.filter((key: SigningKey) => key.kty === 'RSA' && key.alg === 'RS256' && key.use === 'sig');
      keysExpire = now() + 10 * 60_000;
    })().finally(() => { inflightKeys = null; });
    return inflightKeys;
  }

  return async (token: string, action: CatalogMaintenanceAction): Promise<{ runId: string; attempt: string }> => {
    try {
      if (token.length > 16_000 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) throw new Error();
      const [headerPart, payloadPart, signaturePart] = token.split('.');
      const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
      const claims = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
      if (header.alg !== 'RS256' || header.typ !== 'JWT' || typeof header.kid !== 'string'
        || header.kid.length > 200 || header.crit !== undefined) throw new Error();
      validateMaintenanceClaims(claims, action, now());
      if (keysExpire <= now() || !keys.some((key) => key.kid === header.kid)) await loadKeys();
      const key = keys.find((candidate) => candidate.kid === header.kid);
      if (!key || !verify('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`),
        createPublicKey({ key, format: 'jwk' }), Buffer.from(signaturePart, 'base64url'))) throw new Error();
      for (const [id, expires] of used) if (expires <= now()) used.delete(id);
      if (used.has(claims.jti) || used.size >= 1000) throw new Error();
      used.set(claims.jti, claims.exp * 1000);
      return { runId: claims.run_id, attempt: claims.run_attempt };
    } catch {
      // Never return token contents, decoded claims, upstream bodies, or keys.
      throw new Error('MAINTENANCE_UNAUTHORIZED');
    }
  };
}

export const authenticateCatalogMaintenance = createMaintenanceAuthenticator();
