export type SmokeTargetKind = 'frontend' | 'api' | 'live-api' | 'live-bundle';
export type SmokeScope = 'all' | 'temporary-launch';
export type SmokeTargetScope = Exclude<SmokeScope, 'all'>;

/**
 * The workers.dev base that the deployed Stream Studio bundle MUST reference as its
 * live fallback (see live/config.ts). If a stale/misbuilt Pages deploy ships without
 * it, the studio falls back to dead same-origin /live-api even though endpoint probes
 * still pass — so the 'live-bundle' target asserts the string is actually in the bundle.
 */
export const EXPECTED_LIVE_WORKER_BASE = 'dreamstream-live.akhieleshsrirangam.workers.dev';

export type SmokeTarget = {
  name: string;
  url: string;
  kind: SmokeTargetKind;
  /**
   * Optional focused launch gates this target belongs to. The default `all` smoke
   * still runs every target; scoped gates let us prove the temporary Pages path
   * without treating the known custom-domain Cloudflare challenge as a failure.
   */
  scopes?: SmokeTargetScope[];
};

export type SmokeStatus = 'pass' | 'fail';

export type SmokeResult = {
  target: SmokeTarget;
  status: SmokeStatus;
  httpStatus: number;
  elapsedMs: number;
  detail: string;
};

export type SmokeFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type RunLiveSmokeOptions = {
  targets?: SmokeTarget[];
  timeoutMs?: number;
  fetcher?: SmokeFetcher;
};

export const DEFAULT_SMOKE_TARGETS: SmokeTarget[] = [
  { name: 'primary app', url: 'https://dreamstreamstudio.ai/', kind: 'frontend' },
  { name: 'fallback app', url: 'https://comic2.pages.dev/', kind: 'frontend', scopes: ['temporary-launch'] },
  { name: 'stream studio', url: 'https://comic2.pages.dev/live.html', kind: 'frontend', scopes: ['temporary-launch'] },
  { name: 'stream studio bundle', url: 'https://comic2.pages.dev/live.html', kind: 'live-bundle', scopes: ['temporary-launch'] },
  { name: 'fallback live worker', url: 'https://dreamstream-live.akhieleshsrirangam.workers.dev/api/events/smokeprobe', kind: 'live-api', scopes: ['temporary-launch'] },
  { name: 'custom-domain live worker', url: 'https://dreamstreamstudio.ai/live-api/api/events/smokeprobe', kind: 'live-api' },
  { name: 'railway api', url: 'https://comic2-production.up.railway.app/api/health', kind: 'api', scopes: ['temporary-launch'] }
];

export const smokeTargetsForScope = (
  scope: SmokeScope = 'all',
  targets: SmokeTarget[] = DEFAULT_SMOKE_TARGETS
): SmokeTarget[] => {
  if (scope === 'all') return targets;
  return targets.filter((target) => target.scopes?.includes(scope));
};

export function parseSmokeScope(args: string[]): SmokeScope {
  if (args.includes('--temporary-launch') || args.includes('--temporary') || args.includes('--scope=temporary')) {
    return 'temporary-launch';
  }
  return 'all';
}

export function formatSmokeScopeBanner(scope: SmokeScope): string | null {
  if (scope !== 'temporary-launch') return null;
  return 'Scope: temporary launch — checking comic2.pages.dev + workers.dev; custom-domain targets intentionally omitted until the Cloudflare challenge is fixed.';
}

const CLOUDFLARE_CHALLENGE_MARKERS = [
  'just a moment...',
  'checking your browser',
  'verify you are human',
  'security verification',
  'cf_chl_',
  'cf-mitigated',
  'cloudflare challenge'
];

const readHeader = (response: Response, name: string): string => response.headers.get(name)?.toLowerCase() ?? '';

export function detectCloudflareChallenge(response: Response, body: string): boolean {
  const server = readHeader(response, 'server');
  const mitigated = readHeader(response, 'cf-mitigated');
  const ray = readHeader(response, 'cf-ray');
  const lowerBody = body.toLowerCase();

  if (mitigated.includes('challenge')) return true;
  if (server.includes('cloudflare') && response.status >= 400 && response.status < 500) {
    return CLOUDFLARE_CHALLENGE_MARKERS.some((marker) => lowerBody.includes(marker));
  }
  if (ray && CLOUDFLARE_CHALLENGE_MARKERS.some((marker) => lowerBody.includes(marker))) return true;
  return CLOUDFLARE_CHALLENGE_MARKERS.some((marker) => lowerBody.includes(marker)) && lowerBody.includes('cloudflare');
}

const APP_ROOT_MARKERS = ['id="root"', "id='root'", 'id="app"', "id='app'", 'id="live-root"', "id='live-root'"];

const looksLikeAppShell = (body: string): boolean => {
  const lower = body.toLowerCase();
  const hasRoot = APP_ROOT_MARKERS.some((marker) => lower.includes(marker));
  const hasScript = lower.includes('type="module"') || lower.includes('/assets/') || lower.includes('src="/assets') || lower.includes("src='/assets") || lower.includes('/live/main.tsx');
  return (lower.includes('<!doctype html') || hasRoot) && hasRoot && hasScript;
};

const parseJsonBody = (body: string): unknown => {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
};

const classifyFrontend = (response: Response, body: string): Pick<SmokeResult, 'status' | 'detail'> => {
  if (detectCloudflareChallenge(response, body)) {
    return { status: 'fail', detail: 'Cloudflare challenge/interstitial returned instead of app shell' };
  }
  if (!response.ok) {
    return { status: 'fail', detail: `unexpected HTTP ${response.status}` };
  }
  if (!looksLikeAppShell(body)) {
    return { status: 'fail', detail: 'response did not look like a deployed app shell' };
  }
  return { status: 'pass', detail: 'app shell returned' };
};

const classifyApi = (response: Response, body: string): Pick<SmokeResult, 'status' | 'detail'> => {
  if (detectCloudflareChallenge(response, body)) {
    return { status: 'fail', detail: 'Cloudflare challenge/interstitial returned instead of API response' };
  }
  if (!response.ok) {
    return { status: 'fail', detail: `unexpected HTTP ${response.status}` };
  }
  const json = parseJsonBody(body);
  if (!json || typeof json !== 'object' || !('status' in json) || String((json as { status?: unknown }).status).toLowerCase() !== 'ok') {
    return { status: 'fail', detail: 'unexpected health payload' };
  }
  return { status: 'pass', detail: 'health ok' };
};

const classifyLiveApi = (response: Response, body: string): Pick<SmokeResult, 'status' | 'detail'> => {
  if (detectCloudflareChallenge(response, body)) {
    return { status: 'fail', detail: 'Cloudflare challenge/interstitial returned instead of live-worker JSON' };
  }

  const json = parseJsonBody(body);
  if (json && typeof json === 'object') {
    const code = String((json as { error_code?: unknown }).error_code ?? '');
    const name = String((json as { error_name?: unknown }).error_name ?? '').toLowerCase();
    if (code === '1042' || name.includes('workers_dev_script_not_found')) {
      return { status: 'fail', detail: 'workers.dev host is not deployed/enabled for the live worker' };
    }
  }

  const lowerBody = body.toLowerCase();
  if (lowerBody.includes('error 1042') || lowerBody.includes('workers_dev_script_not_found')) {
    return { status: 'fail', detail: 'workers.dev host is not deployed/enabled for the live worker' };
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('text/html') || looksLikeAppShell(body)) {
    return { status: 'fail', detail: 'live-worker probe returned website HTML instead of worker JSON' };
  }

  if (!json || typeof json !== 'object') {
    return { status: 'fail', detail: 'live-worker probe did not return JSON' };
  }

  const error = String((json as { error?: unknown }).error ?? '').toLowerCase();
  if (response.status === 404 && error.includes('not found')) {
    return { status: 'pass', detail: 'live worker route reachable (missing-event probe returned JSON 404)' };
  }

  if (response.ok) {
    return { status: 'pass', detail: 'live worker route reachable' };
  }

  return { status: 'fail', detail: `unexpected live-worker HTTP ${response.status}` };
};

export function classifySmokeResponse(
  target: SmokeTarget,
  response: Response,
  body: string,
  elapsedMs: number
): SmokeResult {
  const classified = target.kind === 'api'
    ? classifyApi(response, body)
    : target.kind === 'live-api'
      ? classifyLiveApi(response, body)
      : classifyFrontend(response, body);
  return {
    target,
    status: classified.status,
    httpStatus: response.status,
    elapsedMs,
    detail: classified.detail
  };
}

const fetchUrlWithTimeout = async (
  fetcher: SmokeFetcher,
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { signal: controller.signal, redirect: 'follow', headers });
  } finally {
    clearTimeout(timeout);
  }
};

const fetchWithTimeout = (fetcher: SmokeFetcher, target: SmokeTarget, timeoutMs: number): Promise<Response> =>
  fetchUrlWithTimeout(
    fetcher,
    target.url,
    timeoutMs,
    target.kind === 'frontend' ? undefined : { accept: 'application/json' }
  );

/**
 * Find every `/assets/live-*.js` bundle path referenced by the Stream Studio shell
 * (script src or modulepreload href). Deduped + deterministic so it's unit-testable.
 */
export function discoverLiveBundlePaths(html: string): string[] {
  const matches = html.match(/\/assets\/live-[A-Za-z0-9_.-]+\.js/g) ?? [];
  return Array.from(new Set(matches));
}

/**
 * 'live-bundle' target: fetch the deployed live.html, discover its `/assets/live-*.js`
 * bundle(s), fetch them, and pass only if at least one bundle literally contains
 * EXPECTED_LIVE_WORKER_BASE. Guards against a stale/misbuilt Pages deploy that still
 * passes endpoint probes while the studio uses dead same-origin /live-api.
 */
export async function verifyLiveBundle(
  target: SmokeTarget,
  fetcher: SmokeFetcher,
  timeoutMs: number
): Promise<SmokeResult> {
  const started = Date.now();
  const fail = (httpStatus: number, detail: string): SmokeResult => ({
    target,
    status: 'fail',
    httpStatus,
    elapsedMs: Date.now() - started,
    detail
  });

  const shell = await fetchUrlWithTimeout(fetcher, target.url, timeoutMs, { accept: 'text/html' });
  const shellBody = await shell.text();

  if (detectCloudflareChallenge(shell, shellBody)) {
    return fail(shell.status, 'Cloudflare challenge/interstitial returned instead of live.html shell');
  }
  if (!shell.ok) {
    return fail(shell.status, `live.html shell returned unexpected HTTP ${shell.status}`);
  }

  const bundlePaths = discoverLiveBundlePaths(shellBody);
  if (bundlePaths.length === 0) {
    return fail(shell.status, 'no /assets/live-*.js bundle found in live.html (stale or misbuilt Pages deploy?)');
  }

  let lastStatus = shell.status;
  for (const path of bundlePaths) {
    const bundleUrl = new URL(path, target.url).toString();
    const res = await fetchUrlWithTimeout(fetcher, bundleUrl, timeoutMs, { accept: 'application/javascript' });
    lastStatus = res.status;
    if (!res.ok) continue;
    const body = await res.text();
    if (body.includes(EXPECTED_LIVE_WORKER_BASE)) {
      return {
        target,
        status: 'pass',
        httpStatus: res.status,
        elapsedMs: Date.now() - started,
        detail: `live bundle ${path} references ${EXPECTED_LIVE_WORKER_BASE}`
      };
    }
  }

  return fail(
    lastStatus,
    `none of ${bundlePaths.length} live bundle(s) reference expected worker base ${EXPECTED_LIVE_WORKER_BASE} (stale or misbuilt Pages deploy?)`
  );
}

export async function runLiveSmoke(options: RunLiveSmokeOptions = {}): Promise<SmokeResult[]> {
  const targets = options.targets ?? DEFAULT_SMOKE_TARGETS;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetcher = options.fetcher ?? fetch;
  const results: SmokeResult[] = [];

  for (const target of targets) {
    const started = Date.now();
    try {
      if (target.kind === 'live-bundle') {
        results.push(await verifyLiveBundle(target, fetcher, timeoutMs));
        continue;
      }
      const response = await fetchWithTimeout(fetcher, target, timeoutMs);
      const body = await response.text();
      results.push(classifySmokeResponse(target, response, body, Date.now() - started));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        target,
        status: 'fail',
        httpStatus: 0,
        elapsedMs: Date.now() - started,
        detail: `request failed: ${message}`
      });
    }
  }

  return results;
}

export function formatSmokeReport(results: SmokeResult[]): string {
  return results.map((result) => {
    const label = result.status.toUpperCase();
    const http = result.httpStatus || 'n/a';
    return `${label} ${result.target.name} (${result.target.url}) — HTTP ${http}, ${result.elapsedMs}ms — ${result.detail}`;
  }).join('\n');
}

const isCliRun = (): boolean => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return invoked.endsWith('/liveSmoke.ts') || invoked.endsWith('\\liveSmoke.ts') || invoked.endsWith('/liveSmoke.js') || invoked.endsWith('\\liveSmoke.js');
};

if (isCliRun()) {
  const scope = parseSmokeScope(process.argv.slice(2));
  const banner = formatSmokeScopeBanner(scope);
  const results = await runLiveSmoke({ targets: smokeTargetsForScope(scope) });
  const report = formatSmokeReport(results);
  if (banner) console.log(banner);
  console.log(report);
  if (results.some((result) => result.status === 'fail')) {
    process.exitCode = 1;
  }
}
