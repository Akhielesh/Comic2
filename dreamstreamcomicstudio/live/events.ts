/**
 * Local registry of MY events (id + hostKey live only in this browser — there
 * is no account system, the hostKey IS the credential). The dashboard hydrates
 * each entry from the worker, so titles/status/viewers are always cloud-truth;
 * this file just remembers which events are mine and my recording downloads.
 */

import { getEvent } from './api';
import type { EventMeta, StreamStatus } from './protocol';

export interface MyEvent {
  id: string;
  hostKey: string;
  title: string;
  createdAt: number;
  scheduledAt: number | null;
  /** Last meta snapshot from the worker (refreshed by the dashboard). */
  status?: StreamStatus;
  viewers?: number;
  startedAt?: number | null;
  endedAt?: number | null;
  quality?: string;
  access?: 'open' | 'approval';
  cover?: number;
  peakViewers?: number;
}

export interface MyRecording {
  eventId: string;
  title: string;
  file: string;
  bytes: number;
  at: number;
}

const EVENTS_KEY = 'ds-live-my-events';
const REC_KEY = 'ds-live-my-recordings';
const CAP = 50;

function read<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    const arr = raw ? (JSON.parse(raw) as T[]) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function write<T>(key: string, items: T[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(items.slice(-CAP)));
  } catch {
    /* storage unavailable */
  }
}

export const listMyEvents = (): MyEvent[] => read<MyEvent>(EVENTS_KEY).slice().reverse();

export function addMyEvent(ev: MyEvent): void {
  const all = read<MyEvent>(EVENTS_KEY).filter((e) => e.id !== ev.id);
  all.push(ev);
  write(EVENTS_KEY, all);
}

export function updateMyEvent(id: string, patch: Partial<MyEvent>): void {
  const all = read<MyEvent>(EVENTS_KEY);
  const i = all.findIndex((e) => e.id === id);
  if (i >= 0) {
    all[i] = { ...all[i], ...patch };
    write(EVENTS_KEY, all);
  }
}

export function removeMyEvent(id: string): void {
  write(EVENTS_KEY, read<MyEvent>(EVENTS_KEY).filter((e) => e.id !== id));
}

export const findMyEvent = (id: string): MyEvent | undefined => read<MyEvent>(EVENTS_KEY).find((e) => e.id === id);

/** Refresh every entry from the worker (cloud truth); drops events the worker
 *  no longer knows. Failures keep the cached snapshot — fine offline. */
export async function hydrateMyEvents(): Promise<MyEvent[]> {
  const all = listMyEvents();
  const fresh = await Promise.all(
    all.map(async (e) => {
      try {
        const meta: EventMeta = await getEvent(e.id);
        const patch: Partial<MyEvent> = {
          title: meta.title,
          status: meta.status,
          viewers: meta.viewers,
          scheduledAt: meta.scheduledAt,
          startedAt: meta.startedAt,
          endedAt: meta.endedAt,
          quality: meta.quality,
          access: meta.access,
          cover: meta.cover,
        };
        updateMyEvent(e.id, patch);
        return { ...e, ...patch };
      } catch {
        return e;
      }
    }),
  );
  return fresh;
}

export const listMyRecordings = (): MyRecording[] => read<MyRecording>(REC_KEY).slice().reverse();

export function addMyRecording(rec: MyRecording): void {
  const all = read<MyRecording>(REC_KEY);
  all.push(rec);
  write(REC_KEY, all);
}

/* ----------------------------- viewer session ----------------------------- */

const NAME_KEY = 'ds-live-viewer-name';

export const loadViewerName = (): string => {
  try {
    return localStorage.getItem(NAME_KEY) || '';
  } catch {
    return '';
  }
};

export const saveViewerName = (name: string): void => {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* storage unavailable */
  }
};

/** Refresh-resilient "I already joined this event" flag (per tab session). */
export const joinedFlagKey = (eventId: string): string => `ds-live-joined-${eventId}`;
