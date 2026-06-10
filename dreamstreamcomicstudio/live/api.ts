/** REST + WebSocket client for the dreamstream-live worker. */

import { WORKER_BASE } from './config';
import type { EventMeta, ServerMsg, StatsResponse } from './protocol';

export interface CreatedEvent {
  id: string;
  hostKey: string;
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
const NO_RECONNECT_CODES = new Set([4001, 4002]);
const MAX_RECONNECT_ATTEMPTS = 8;

export type SocketStatus = 'connected' | 'reconnecting';

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
  params: { name: string; k?: string; token?: string },
  onMsg: (m: ServerMsg) => void,
  onGone: (reason: 'denied' | 'kicked' | 'failed') => void,
  onStatus?: (s: SocketStatus) => void,
): RoomSocket {
  let ws: WebSocket | null = null;
  let closedByUs = false;
  let attempts = 0;

  const connect = () => {
    const qs = new URLSearchParams({ name: params.name });
    if (params.k) qs.set('k', params.k);
    if (params.token) qs.set('token', params.token);
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
