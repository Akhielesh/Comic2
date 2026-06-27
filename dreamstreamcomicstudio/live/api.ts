/** REST + WebSocket client for the dreamstream-live worker. */

import { WORKER_BASE } from './config';
import type { EventMeta, ServerMsg, StatsResponse } from './protocol';

export interface CreatedEvent {
  id: string;
  hostKey: string;
}

export interface LiveWorkerProbeResult {
  ok: boolean;
  baseUrl: string;
  httpStatus: number;
  detail: string;
}

const CLOUDFLARE_CHALLENGE_MARKERS = [
  'just a moment...',
  'checking your browser',
  'verify you are human',
  'security verification',
  'cf_chl_',
  'cf-mitigated',
  'cloudflare challenge',
];

const APP_SHELL_MARKERS = ['id="root"', "id='root'", 'id="live-root"', "id='live-root'", '/assets/', 'type="module"'];

const lowerHeader = (res: Response, name: string): string => res.headers.get(name)?.toLowerCase() ?? '';

function bodyLooksLikeAppShell(body: string): boolean {
  const lower = body.toLowerCase();
  return (lower.includes('<!doctype html') || lower.includes('<html')) && APP_SHELL_MARKERS.some((marker) => lower.includes(marker));
}

function bodyLooksLikeCloudflareChallenge(res: Response, body: string): boolean {
  const lower = body.toLowerCase();
  if (lowerHeader(res, 'cf-mitigated').includes('challenge')) return true;
  return CLOUDFLARE_CHALLENGE_MARKERS.some((marker) => lower.includes(marker))
    && (lower.includes('cloudflare') || lowerHeader(res, 'server').includes('cloudflare'));
}

function parseJsonBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function bodyLooksLikeWorkersDevMissingScript(body: string, json: unknown): boolean {
  if (json && typeof json === 'object') {
    const code = String((json as { error_code?: unknown }).error_code ?? '');
    const name = String((json as { error_name?: unknown }).error_name ?? '').toLowerCase();
    if (code === '1042' || name.includes('workers_dev_script_not_found')) return true;
  }

  const lower = body.toLowerCase();
  return lower.includes('error 1042') || lower.includes('workers_dev_script_not_found');
}

export function classifyLiveWorkerProbeResponse(
  res: Response,
  body: string,
  baseUrl = WORKER_BASE,
): LiveWorkerProbeResult {
  const contentType = lowerHeader(res, 'content-type');
  const json = parseJsonBody(body);

  if (bodyLooksLikeCloudflareChallenge(res, body)) {
    return {
      ok: false,
      baseUrl,
      httpStatus: res.status,
      detail: 'Cloudflare security verification returned instead of live-worker JSON',
    };
  }

  if (bodyLooksLikeWorkersDevMissingScript(body, json)) {
    return {
      ok: false,
      baseUrl,
      httpStatus: res.status,
      detail: 'workers.dev host is not deployed/enabled for the live worker',
    };
  }

  if (contentType.includes('text/html') || bodyLooksLikeAppShell(body)) {
    return {
      ok: false,
      baseUrl,
      httpStatus: res.status,
      detail: 'request reached the website shell instead of the live-worker route',
    };
  }

  if (res.status === 404 && json && typeof json === 'object' && String((json as { error?: unknown }).error ?? '').toLowerCase().includes('not found')) {
    return {
      ok: true,
      baseUrl,
      httpStatus: res.status,
      detail: 'live-worker route reachable (missing-event probe returned JSON 404)',
    };
  }

  if (res.ok && json && typeof json === 'object') {
    return { ok: true, baseUrl, httpStatus: res.status, detail: 'live-worker route reachable' };
  }

  return {
    ok: false,
    baseUrl,
    httpStatus: res.status,
    detail: json && typeof json === 'object'
      ? `unexpected live-worker probe HTTP ${res.status}`
      : 'live-worker probe did not return JSON',
  };
}

export async function probeLiveWorker(timeoutMs = 5_000): Promise<LiveWorkerProbeResult> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${WORKER_BASE}/api/events/smokeprobe`, {
      method: 'GET',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    const body = await res.text();
    return classifyLiveWorkerProbeResponse(res, body);
  } catch (error) {
    return {
      ok: false,
      baseUrl: WORKER_BASE,
      httpStatus: 0,
      detail: error instanceof Error ? `request failed: ${error.message}` : 'request failed',
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

/** 405/HTML responses mean we reached the static website, not the live-worker. */
function assertWorkerResponse(res: Response): void {
  if (res.status === 405 || res.headers.get('content-type')?.includes('text/html')) {
    throw new Error(
      'Streaming backend not reachable — the request hit the website instead of the live-worker. Deploy live-worker/ (see its README) or set VITE_LIVE_WORKER_URL.',
    );
  }
}

export async function createEvent(opts: {
  title: string;
  host?: string;
  desc?: string;
  cover?: number;
  access: 'open' | 'approval';
  quality: string;
  segMs: number;
  scheduledAt?: number | null;
  maxViewers?: number;
}): Promise<CreatedEvent> {
  const res = await fetch(`${WORKER_BASE}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });
  assertWorkerResponse(res);
  if (!res.ok) throw new Error(`create failed (${res.status})`);
  return res.json();
}

export async function getEvent(id: string): Promise<EventMeta> {
  const res = await fetch(`${WORKER_BASE}/api/events/${id}`);
  assertWorkerResponse(res);
  if (!res.ok) throw new Error(`event not found (${res.status})`);
  return res.json();
}

/** Host-gated analytics + activity log for the post-stream summary. */
export async function getStats(id: string, hostKey: string): Promise<StatsResponse> {
  const res = await fetch(`${WORKER_BASE}/api/events/${id}/stats?k=${encodeURIComponent(hostKey)}`);
  assertWorkerResponse(res);
  if (!res.ok) throw new Error(`stats unavailable (${res.status})`);
  return res.json();
}

/** Name-only RSVP from the invite page. */
export async function rsvpEvent(id: string, name: string): Promise<{ ok: boolean; rsvpCount: number }> {
  const res = await fetch(`${WORKER_BASE}/api/events/${id}/rsvp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assertWorkerResponse(res);
  if (!res.ok) throw new Error(`rsvp failed (${res.status})`);
  return res.json();
}

export const segmentUrl = (id: string, seq: number): string =>
  `${WORKER_BASE}/api/events/${id}/segments/${seq}`;

/**
 * Cost guardrail: fired from `pagehide` when the host's tab closes mid-stream.
 * `sendBeacon` survives tab teardown where fetch may not; the room ends the
 * stream immediately (still restartable from the studio link).
 */
export function sendHostExitBeacon(id: string, hostKey: string): void {
  const url = `${WORKER_BASE}/api/events/${id}/exit?k=${encodeURIComponent(hostKey)}`;
  try {
    if (!navigator.sendBeacon?.(url)) {
      void fetch(url, { method: 'POST', keepalive: true }).catch(() => undefined);
    }
  } catch {
    /* the room's paused-grace auto-end still backstops this */
  }
}

/* ------------------------- server-side recordings ------------------------- */
/* Multi-GB masters go up as R2 multipart parts so they fit Worker limits.    */

const REC_PART_BYTES = 16 * 1024 * 1024; // ≥5 MB (R2 minimum), small enough for flaky uplinks

export interface ServerRecordings {
  recordings: import('./protocol').RecordingEntry[];
  expiresAt: number | null;
}

export async function listServerRecordings(id: string, hostKey: string): Promise<ServerRecordings> {
  const res = await fetch(`${WORKER_BASE}/api/events/${id}/recordings?k=${encodeURIComponent(hostKey)}`);
  assertWorkerResponse(res);
  if (!res.ok) throw new Error(`recordings unavailable (${res.status})`);
  return res.json();
}

export const recordingDownloadUrl = (id: string, hostKey: string, key: string): string =>
  `${WORKER_BASE}/api/events/${id}/recordings?k=${encodeURIComponent(hostKey)}&download=${encodeURIComponent(key)}`;

/**
 * Uploads a finished recording to the event's 7-day server store.
 * Chunked (16 MB parts) with simple per-part retry; reports progress 0..1.
 */
export async function uploadRecording(
  id: string,
  hostKey: string,
  blob: Blob,
  opts: { file: string; durMs: number; onProgress?: (frac: number) => void },
): Promise<{ key: string }> {
  const headers = { 'x-host-key': hostKey, 'content-type': 'application/json' };
  const init = await fetch(`${WORKER_BASE}/api/events/${id}/recordings?op=init`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ file: opts.file, mime: blob.type || 'video/webm' }),
  });
  if (!init.ok) throw new Error(`recording upload init failed (${init.status})`);
  const { key, uploadId } = (await init.json()) as { key: string; uploadId: string };

  const parts: { partNumber: number; etag: string }[] = [];
  const total = Math.max(1, Math.ceil(blob.size / REC_PART_BYTES));
  for (let n = 1; n <= total; n++) {
    const slice = blob.slice((n - 1) * REC_PART_BYTES, Math.min(n * REC_PART_BYTES, blob.size));
    let lastErr: unknown;
    let done = false;
    for (let attempt = 0; attempt < 3 && !done; attempt++) {
      try {
        const res = await fetch(
          `${WORKER_BASE}/api/events/${id}/recordings?op=part&key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&n=${n}`,
          { method: 'PUT', headers: { 'x-host-key': hostKey }, body: slice },
        );
        if (!res.ok) throw new Error(`part ${n} failed (${res.status})`);
        parts.push((await res.json()) as { partNumber: number; etag: string });
        done = true;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      }
    }
    if (!done) throw lastErr instanceof Error ? lastErr : new Error(`part ${n} failed`);
    opts.onProgress?.(n / total);
  }

  const complete = await fetch(`${WORKER_BASE}/api/events/${id}/recordings?op=complete`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ key, uploadId, parts, file: opts.file, bytes: blob.size, mime: blob.type || 'video/webm', durMs: opts.durMs }),
  });
  if (!complete.ok) throw new Error(`recording upload complete failed (${complete.status})`);
  return { key };
}

export interface SegmentUploadResult {
  elapsedMs: number;
  bytes: number;
}

export async function uploadSegment(
  id: string,
  hostKey: string,
  seq: number,
  ms: number,
  blob: Blob,
): Promise<SegmentUploadResult> {
  const t0 = performance.now();
  const res = await fetch(`${WORKER_BASE}/api/events/${id}/segments?seq=${seq}&ms=${ms}`, {
    method: 'POST',
    headers: { 'content-type': blob.type || 'video/webm', 'x-host-key': hostKey },
    body: blob,
  });
  if (!res.ok) throw new Error(`segment ${seq} upload failed (${res.status})`);
  return { elapsedMs: performance.now() - t0, bytes: blob.size };
}

export async function fetchSegment(
  id: string,
  seq: number,
): Promise<{ buf: ArrayBuffer; elapsedMs: number }> {
  const t0 = performance.now();
  const res = await fetch(segmentUrl(id, seq));
  if (!res.ok) throw new Error(`segment ${seq} fetch failed (${res.status})`);
  const buf = await res.arrayBuffer();
  return { buf, elapsedMs: performance.now() - t0 };
}

/** Close codes the room uses for "you were removed on purpose — don't reconnect". */
const NO_RECONNECT_CODES = new Set([4001, 4002, 4003]);
const MAX_RECONNECT_ATTEMPTS = 8;

export type SocketStatus = 'connected' | 'reconnecting';
export type GoneReason = 'denied' | 'kicked' | 'full' | 'failed';

export interface RoomSocket {
  send(msg: Record<string, unknown>): void;
  close(): void;
}

/**
 * Opens the event room socket with backoff reconnect (network blips and tab
 * sleeps shouldn't end a stream). Deliberate removals (deny/kick) never
 * reconnect. `onStatus` lets the UI show a quiet "reconnecting…" pill.
 */
export function openRoomSocket(
  id: string,
  params: { name: string; k?: string; token?: string; g?: string },
  onMsg: (m: ServerMsg) => void,
  onGone: (reason: GoneReason) => void,
  onStatus?: (s: SocketStatus) => void,
): RoomSocket {
  let ws: WebSocket | null = null;
  let closedByUs = false;
  let attempts = 0;

  const connect = () => {
    const qs = new URLSearchParams({ name: params.name });
    if (params.k) qs.set('k', params.k);
    if (params.token) qs.set('token', params.token);
    if (params.g) qs.set('g', params.g);
    const wsBase = WORKER_BASE.replace(/^http/, 'ws');
    ws = new WebSocket(`${wsBase}/api/events/${id}/ws?${qs}`);

    ws.onopen = () => {
      attempts = 0;
      onStatus?.('connected');
    };
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data as string) as ServerMsg;
        if (m.t === 'admitted') params.token = m.token; // reconnects keep our seat
        onMsg(m);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = (ev) => {
      if (closedByUs) return;
      if (ev.code === 4001) return onGone('denied');
      if (ev.code === 4002) return onGone('kicked');
      if (ev.code === 4003) return onGone('full');
      if (NO_RECONNECT_CODES.has(ev.code)) return;
      attempts += 1;
      if (attempts > MAX_RECONNECT_ATTEMPTS) return onGone('failed');
      onStatus?.('reconnecting');
      setTimeout(connect, Math.min(8000, 500 * 2 ** attempts));
    };
  };
  connect();

  return {
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
    close() {
      closedByUs = true;
      try {
        ws?.close(1000);
      } catch {
        /* already closed */
      }
    },
  };
}
