/**
 * 7-day cloud copies of recordings — the one way to save a recording that uses our
 * storage (and the host's upload). Off unless the host chooses it (ADR 0007 D6), and
 * capped at 10 GB rolling per account (D5). The server enforces the cap when an upload
 * starts (live-worker/src/cloudCopyQuota.ts); this module reads it for the save sheet's
 * meter and turns the server's refusal into an error the sheet shows as-is.
 *
 * Google Drive and this device are free and come first in the save sheet.
 */
import { accessToken } from './account';
import { WORKER_BASE } from './config';

/** Shown before the server answers; the server's own number wins once known. */
export const CLOUD_COPY_LIMIT_BYTES = 10 * 1024 ** 3;
export const CLOUD_COPY_DAYS = 7;

export interface CloudCopyQuota {
  usedBytes: number;
  limitBytes: number;
  /** Copies still counted (each for 7 days from its upload). */
  copies: number;
  /** When the oldest counted copy stops counting (null = none). */
  nextFreeAt: number | null;
  /**
   * Part of `usedBytes` held by an unfinished earlier try of the recording asked about.
   * Starting it again replaces that try, so it doesn't count against the new one.
   */
  retryBytes?: number;
}

export type CloudCopyErrorCode =
  | 'cloud_copy_full'
  | 'cloud_copy_too_big'
  | 'sign_in_required'
  | 'quota_unavailable'
  | 'bad_size'
  | 'failed';

export class CloudCopyError extends Error {
  readonly code: CloudCopyErrorCode;
  /** When enough older copies expire for this one to fit (full only). */
  readonly freesAt: number | null;
  readonly usedBytes: number | null;
  readonly limitBytes: number | null;
  constructor(code: CloudCopyErrorCode, message: string, extra: { freesAt?: number | null; usedBytes?: number | null; limitBytes?: number | null } = {}) {
    super(message);
    this.name = 'CloudCopyError';
    this.code = code;
    this.freesAt = extra.freesAt ?? null;
    this.usedBytes = extra.usedBytes ?? null;
    this.limitBytes = extra.limitBytes ?? null;
  }
  /** The allowance said no: retrying won't help until older copies expire. */
  get isLimit(): boolean {
    return this.code === 'cloud_copy_full' || this.code === 'cloud_copy_too_big';
  }
}

const KNOWN: CloudCopyErrorCode[] = ['cloud_copy_full', 'cloud_copy_too_big', 'sign_in_required', 'quota_unavailable', 'bad_size'];
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A failed upload start → the server's own honest reason (or a safe generic one). */
export async function cloudCopyErrorFrom(res: Response): Promise<CloudCopyError> {
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const code = KNOWN.includes(body?.error as CloudCopyErrorCode) ? (body!.error as CloudCopyErrorCode) : 'failed';
  const message =
    typeof body?.message === 'string' && body.message
      ? body.message
      : res.status === 403
        ? 'This studio link no longer lets you upload — your recording is still on this device.'
        : `The 7-day copy couldn’t start (${res.status}) — your recording is still on this device.`;
  return new CloudCopyError(code, message, { freesAt: num(body?.freesAt), usedBytes: num(body?.usedBytes), limitBytes: num(body?.limitBytes) });
}

/**
 * The signed-in account's 7-day copy usage, or null if it can't be read right now. With
 * the recording's size, the server also says what an unfinished earlier try of it holds
 * (a retry replaces that), so the sheet decides "fits" the way the server will.
 */
export async function fetchCloudCopyQuota(eventId: string, hostKey: string, bytes?: number, fetchImpl: typeof fetch = fetch): Promise<CloudCopyQuota | null> {
  try {
    const token = await accessToken();
    if (!token) return null;
    const size = bytes != null && Number.isFinite(bytes) && bytes > 0 ? `&bytes=${Math.floor(bytes)}` : '';
    const res = await fetchImpl(`${WORKER_BASE}/api/events/${eventId}/recordings?op=quota&k=${encodeURIComponent(hostKey)}${size}`, {
      headers: { authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return parseQuota(await res.json());
  } catch {
    return null;
  }
}

export function parseQuota(v: unknown): CloudCopyQuota | null {
  const o = v as Record<string, unknown> | null;
  const used = num(o?.usedBytes);
  const limit = num(o?.limitBytes);
  if (used == null || limit == null || limit <= 0) return null;
  const q: CloudCopyQuota = { usedBytes: Math.max(0, used), limitBytes: limit, copies: Math.max(0, num(o?.copies) ?? 0), nextFreeAt: num(o?.nextFreeAt) };
  const retry = Math.min(q.usedBytes, Math.max(0, num(o?.retryBytes) ?? 0));
  return retry > 0 ? { ...q, retryBytes: retry } : q;
}

/** "3.1 GB" — one decimal, the same GB as the rest of the app (fmtBytes). */
export const fmtGb = (bytes: number): string => `${(Math.max(0, bytes) / 1024 ** 3).toFixed(1)} GB`;

const limitLabel = (limitBytes: number) => `${Math.round(limitBytes / 1024 ** 3)} GB`;

/** "kept 7 days · 3.1 of 10 GB used" (the meter's caption). */
export function quotaLine(q: CloudCopyQuota | null | undefined): string {
  if (!q) return `kept ${CLOUD_COPY_DAYS} days · up to ${limitLabel(CLOUD_COPY_LIMIT_BYTES)} per account`;
  return `kept ${CLOUD_COPY_DAYS} days · ${(q.usedBytes / 1024 ** 3).toFixed(1)} of ${limitLabel(q.limitBytes)} used`;
}

/**
 * Does a copy of this size fit what's left? (Unknown usage → let the server decide.) An
 * unfinished earlier try of this recording is replaced by starting again — the server
 * doesn't count it twice, so neither does this.
 */
export function fitsQuota(q: CloudCopyQuota | null | undefined, bytes: number): boolean {
  return !q || q.usedBytes - (q.retryBytes ?? 0) + bytes <= q.limitBytes;
}

/** Percent of the allowance used, for the meter (0–100). */
export const quotaPct = (q: CloudCopyQuota): number => Math.min(100, Math.max(0, (q.usedBytes / q.limitBytes) * 100));

/** "Mon, Oct 29" — the day space frees up, in the viewer's own calendar. */
export const fmtFreeDay = (ms: number): string =>
  new Date(ms).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
