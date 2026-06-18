export type SmokeTargetKind = 'frontend' | 'api' | 'live-api';

export type SmokeTarget = {
  name: string;
  url: string;
  kind: SmokeTargetKind;
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
  { name: 'fallback app', url: 'https://comic2.pages.dev/', kind: 'frontend' },
  { name: 'stream studio', url: 'https://comic2.pages.dev/live.html', kind: 'frontend' },
  { name: 'stream worker route', url: 'https://comic2.pages.dev/live-api/api/events/smokeprobe', kind: 'live-api' },
  { name: 'railway api', url: 'https://comic2-production.up.railway.app/api/health', kind: 'api' }
];

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

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('text/html') || looksLikeAppShell(body)) {
    return { status: 'fail', detail: 'live-worker probe returned website HTML instead of worker JSON' };
  }

  const json = parseJsonBody(body);
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

const fetchWithTimeout = async (fetcher: SmokeFetcher, url: string, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timeout);
  }
};

export async function runLiveSmoke(options: RunLiveSmokeOptions = {}): Promise<SmokeResult[]> {
  const targets = options.targets ?? DEFAULT_SMOKE_TARGETS;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const fetcher = options.fetcher ?? fetch;
  const results: SmokeResult[] = [];

  for (const target of targets) {
    const started = Date.now();
    try {
      const response = await fetchWithTimeout(fetcher, target.url, timeoutMs);
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
  const results = await runLiveSmoke();
  const report = formatSmokeReport(results);
  console.log(report);
  if (results.some((result) => result.status === 'fail')) {
    process.exitCode = 1;
  }
}
