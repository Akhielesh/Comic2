/**
 * Environment for the backend container (the Express server in ../server).
 *
 * Two sources, merged at container start:
 *   1. D1 `dreamstream-backend-env`, table `backend_env (name, value)` — the
 *      secrets copied over from Railway. Editable from the Cloudflare dashboard
 *      (D1 → console) without a deploy; a container restart picks them up.
 *   2. This Worker's own vars (wrangler.jsonc) and secrets (dashboard /
 *      `wrangler secret put`). These WIN over D1, so promoting a value to a real
 *      Worker secret is just "set the secret, then delete the D1 row".
 *
 * Every string var/secret on the Worker is forwarded except the proxy's own
 * settings below — so a new backend setting is one line in wrangler.jsonc.
 */

/** The subset of the D1 API the env loader uses. */
export interface EnvDb {
  prepare(sql: string): { all<T = Record<string, unknown>>(): Promise<{ results?: T[] }> };
}

/** Proxy-only settings — they configure this Worker and never reach the backend. */
export const PROXY_ONLY_VARS: ReadonlySet<string> = new Set(['BACKEND_ORIGIN', 'BACKEND_TARGET']);

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

export function buildBackendEnv(workerEnv: Record<string, unknown>, rows: { name?: unknown; value?: unknown }[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    if (typeof row.name === 'string' && ENV_NAME.test(row.name) && typeof row.value === 'string' && !PROXY_ONLY_VARS.has(row.name)) {
      out[row.name] = row.value;
    }
  }
  for (const [name, value] of Object.entries(workerEnv)) {
    if (typeof value === 'string' && ENV_NAME.test(name) && !PROXY_ONLY_VARS.has(name)) out[name] = value;
  }
  return out;
}

/** Reads the D1 rows (one retry) and merges the Worker env over them. Throws if D1 stays unreadable. */
export async function loadBackendEnv(workerEnv: Record<string, unknown>, db: EnvDb | undefined): Promise<Record<string, string>> {
  if (!db) return buildBackendEnv(workerEnv, []);
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { results } = await db.prepare('SELECT name, value FROM backend_env').all<{ name: string; value: string }>();
      return buildBackendEnv(workerEnv, results ?? []);
    } catch (err) {
      lastError = err;
    }
  }
  // Starting without the secrets would leave a half-working backend up for the whole
  // sleep window; failing here returns a retryable 503 instead.
  throw new Error(`backend env store unreadable: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
