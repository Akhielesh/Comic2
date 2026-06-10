/** REST + WebSocket client for the dreamstream-live worker. */

import { WORKER_BASE } from './config';
import type { ServerMsg } from './protocol';

export interface CreatedEvent {
  id: string;
  hostKey: string;
}

export async function createEvent(opts: {
  title: string;
  access: 'open' | 'approval';
  quality: string;
  segMs: number;
}): Promise<CreatedEvent> {
  const res = await fetch(`${WORKER_BASE}/api/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!res.ok) throw new Error(`create failed (${res.status})`);
  return res.json();
}

export async function getEvent(id: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${WORKER_BASE}/api/events/${id}`);
  if (!res.ok) throw new Error(`event not found (${res.status})`);
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

export interface RoomSocket {
  send(msg: Record<string, unknown>): void;
  close(): void;
}

/**
 * Opens the event room socket with simple backoff reconnect (network blips
 * shouldn't end a stream). Deliberate removals (deny/kick) never reconnect.
 */
export function openRoomSocket(
  id: string,
  params: { name: string; k?: string; token?: string },
  onMsg: (m: ServerMsg) => void,
  onGone: (reason: 'denied' | 'kicked' | 'failed') => void,
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
      if (attempts > 5) return onGone('failed');
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
