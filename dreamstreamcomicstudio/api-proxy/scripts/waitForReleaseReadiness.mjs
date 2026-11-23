import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const healthUrl = 'https://dreamstream-api.akhieleshsrirangam.workers.dev/api/health';
const gatePath = 'dreamstreamcomicstudio/api-proxy/scripts/waitForReleaseReadiness.mjs';
const buildPattern = /^(?:[a-f0-9]{12}|[a-f0-9]{40})$/;

export function predatesReadiness(build, cwd = process.cwd()) {
  if (!buildPattern.test(build)) return false;
  const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    const commit = git(['rev-parse', '--verify', build + '^{commit}']);
    git(['merge-base', '--is-ancestor', commit, 'HEAD']);
    // A later build that removed the field or script must not appear to be a first upgrade.
    return git(['log', '--full-history', '-1', '--format=%H', commit, '--', gatePath]) === '';
  } catch {
    return false;
  }
}

async function readHealth() {
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(8_000), redirect: 'error', cache: 'no-store' });
  if (!response.ok) throw new Error('Health returned HTTP ' + response.status);
  return response.json();
}

/** A failed or busy sample breaks the idle window. A sampled busy build can never bootstrap. */
export async function waitForReleaseReadiness({
  read = readHealth, legacy = predatesReadiness, now = Date.now, wait = sleep, log = console.log,
  pollMs = 15_000, idleMs = 60_000, timeoutMs = 30 * 60_000,
} = {}) {
  const deadline = now() + timeoutMs;
  let stableSince;
  let lastBuild;
  let observedCapability = false;
  while (now() < deadline) {
    let health;
    try { health = await read(); } catch { /* A transient unreachable backend is never an idle sample. */ }
    const sampledAt = now();
    if (sampledAt >= deadline) break;
    if (health?.status === 'ok' && typeof health.build === 'string' && buildPattern.test(health.build)) {
      if (health.releaseReadiness === 'busy' || health.releaseReadiness === 'idle') observedCapability = true;
      if (health.releaseReadiness === undefined && !observedCapability && legacy(health.build)) {
        log('Verified the deployed commit predates creator readiness reporting. Bootstrapping the first guarded release.');
        return;
      }
      if (health.releaseReadiness === 'idle') {
        if (stableSince === undefined || lastBuild !== health.build) stableSince = sampledAt;
        lastBuild = health.build;
        if (sampledAt - stableSince >= idleMs) {
          log('All creator generation checks were idle throughout the release readiness window.');
          return;
        }
      } else {
        stableSince = undefined;
      }
    } else {
      stableSince = undefined;
    }
    if (stableSince === undefined) log('Waiting for a healthy backend with no active creator generation.');
    await wait(Math.min(pollMs, deadline - sampledAt));
  }
  throw new Error('Backend did not establish a stable idle window. Deployment stopped before Wrangler; retry the workflow after generation finishes.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await waitForReleaseReadiness();
}
