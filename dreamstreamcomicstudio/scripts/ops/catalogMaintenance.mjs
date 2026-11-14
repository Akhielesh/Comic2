import { pathToFileURL } from 'node:url';

export const AUDIENCE = 'urn:dreamstream:catalog-maintenance';
const ORIGIN = 'https://dreamstream-api.akhieleshsrirangam.workers.dev';
const ACTIONS = new Set(['refresh', 'probe-nvidia']);

/** Runs only in the two allow-listed Actions jobs. Never logs identity tokens or credentials. */
export async function runMaintenance(action, env = process.env, fetcher = fetch) {
  if (!ACTIONS.has(action)) throw new Error('Unsupported maintenance operation');
  if (!env.ACTIONS_ID_TOKEN_REQUEST_URL || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) throw new Error('GitHub OIDC permission is unavailable');
  const identityUrl = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
  if (identityUrl.protocol !== 'https:' || !identityUrl.hostname.endsWith('.actions.githubusercontent.com')) {
    throw new Error('Unexpected GitHub OIDC endpoint');
  }
  identityUrl.searchParams.set('audience', AUDIENCE);
  const identity = await fetcher(identityUrl, {
    headers: { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
    redirect: 'error', signal: AbortSignal.timeout(15_000)
  });
  if (!identity.ok) throw new Error(`GitHub OIDC request failed (${identity.status})`);
  const { value: token } = await identity.json();
  if (typeof token !== 'string' || token.length > 16_000 || !token) throw new Error('GitHub returned no identity token');
  const response = await fetcher(`${ORIGIN}/api/internal/catalog/${action}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    redirect: 'error', signal: AbortSignal.timeout(10 * 60_000)
  });
  let body;
  try { body = await response.json(); } catch { throw new Error(`Maintenance returned a non-JSON response (${response.status})`); }
  // Only allow-listed machine fields leave this script. Never echo arbitrary response bodies.
  const report = {
    ok: response.ok && body?.ok === true,
    action,
    httpStatus: response.status,
    code: typeof body?.code === 'string' && /^[A-Z_]{1,80}$/.test(body.code) ? body.code : undefined,
    completedAt: typeof body?.completedAt === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(body.completedAt) ? body.completedAt : undefined,
    results: Array.isArray(body?.results) ? body.results.map((result) => ({
      source: typeof result.source === 'string' && /^[a-z][a-z0-9_-]{0,30}$/.test(result.source) ? result.source : 'unknown',
      count: Number.isSafeInteger(result.count) && result.count >= 0 ? result.count : 0,
      status: ['refreshed', 'unconfigured', 'unavailable'].includes(result.status) ? result.status : 'unavailable'
    })) : undefined,
    summary: body?.summary ? Object.fromEntries(['callable', 'downloadOnly', 'unknown'].map((key) => [key,
      Number.isSafeInteger(body.summary[key]) && body.summary[key] >= 0 ? body.summary[key] : 0])) : undefined
  };
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runMaintenance(process.argv[2]);
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
  } catch (error) {
    // fetch errors can contain upstream details. Keep failure logs bounded and non-sensitive.
    console.error(JSON.stringify({ ok: false, code: 'MAINTENANCE_REQUEST_FAILED' }));
    process.exitCode = 1;
  }
}
