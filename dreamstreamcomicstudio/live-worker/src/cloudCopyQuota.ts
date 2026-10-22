/**
 * Fair-use allowance for 7-day cloud copies of recordings (ADR 0007 D5; feature doc
 * docs/features/stream-studio-costs.md §4.7, step C1): **10 GB rolling per account**.
 *
 * Checked once per cloud copy, when its upload starts (`op=init`): one R2 list and one
 * tiny marker write. Nothing per part, nothing on a timer.
 *
 * The ledger is R2 itself, one empty marker object per cloud copy:
 *   quota/rec/<accountId>/<eventId>-<bytes>
 * R2 keeps each marker's upload time, which starts its 7-day window. Retrying the same
 * recording rewrites the same marker, so a retry never counts twice. Markers past the
 * window are deleted on the account's next check.
 *
 * Sizes are what the host's app declares when the upload starts. This is a fair-use
 * guard, not billing-grade metering (ADR 0007 D1: we don't charge). The owner view
 * reads Cloudflare's own R2 numbers.
 */
import { bearerFrom, verifyMember, type SupabaseEnv } from './supabaseAuth';

export const CLOUD_COPY_LIMIT_BYTES = 10 * 1024 ** 3;
/** Same as EventRoom's RECORDING_RETENTION_MS: a copy counts while it's kept. */
export const CLOUD_COPY_WINDOW_MS = 7 * 24 * 60 * 60_000;
const PREFIX = 'quota/rec/';
/** 5 × 1,000 markers is far beyond anyone's 10 GB; a hard stop on list calls. */
const MAX_LIST_PAGES = 5;

export interface QuotaEnv extends SupabaseEnv {
  LIVE_BUCKET: R2Bucket;
}

export interface CopyMarker {
  key: string;
  bytes: number;
  at: number;
}

export interface CloudCopyUsage {
  usedBytes: number;
  limitBytes: number;
  /** Live markers, oldest first. */
  markers: CopyMarker[];
}

export type QuotaResult =
  | { ok: true; accountId: string; usage: CloudCopyUsage }
  | { ok: false; status: number; body: Record<string, unknown> };

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const LIMIT_LABEL = `${CLOUD_COPY_LIMIT_BYTES / 1024 ** 3} GB`;
const FREE_WAYS = 'Save it to Google Drive (free, yours to keep) or to this device instead';

export const markerPrefix = (accountId: string) => `${PREFIX}${accountId}/`;

export function markerKey(accountId: string, eventId: string, bytes: number): string {
  return `${markerPrefix(accountId)}${eventId}-${Math.max(0, Math.floor(bytes))}`;
}

/** Bytes recorded in a marker key, or null when it isn't one. */
export function markerBytes(key: string): number | null {
  const m = /-(\d{1,15})$/.exec(key);
  return m ? Number(m[1]) : null;
}

/**
 * When enough of the oldest copies will have expired for `wantedBytes` to fit, or null
 * if it never fits (bigger than the whole allowance).
 */
export function freesAt(markers: CopyMarker[], usedBytes: number, wantedBytes: number, now: number, limitBytes = CLOUD_COPY_LIMIT_BYTES, windowMs = CLOUD_COPY_WINDOW_MS): number | null {
  if (wantedBytes > limitBytes) return null;
  if (usedBytes + wantedBytes <= limitBytes) return now;
  let freed = 0;
  for (const m of [...markers].sort((a, b) => a.at - b.at)) {
    freed += m.bytes;
    if (usedBytes - freed + wantedBytes <= limitBytes) return m.at + windowMs;
  }
  return null;
}

/** The account's copies inside the window. Deletes expired markers (R2 deletes are free). */
export async function readUsage(
  bucket: R2Bucket,
  accountId: string,
  now: number,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<CloudCopyUsage> {
  const markers: CopyMarker[] = [];
  const stale: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const res = await bucket.list({ prefix: markerPrefix(accountId), cursor, limit: 1000 });
    for (const o of res.objects) {
      const bytes = markerBytes(o.key);
      if (bytes == null) continue;
      const at = o.uploaded instanceof Date ? o.uploaded.getTime() : Number(o.uploaded) || now;
      if (now - at >= CLOUD_COPY_WINDOW_MS) stale.push(o.key);
      else markers.push({ key: o.key, bytes, at });
    }
    if (!res.truncated) break;
    cursor = res.cursor;
  }
  if (stale.length) {
    const cleanup = bucket.delete(stale.slice(0, 1000)).catch(() => undefined);
    if (waitUntil) waitUntil(cleanup);
    else await cleanup;
  }
  markers.sort((a, b) => a.at - b.at);
  return { usedBytes: markers.reduce((s, m) => s + m.bytes, 0), limitBytes: CLOUD_COPY_LIMIT_BYTES, markers };
}

/** Who is asking: the caller's own Supabase token, verified (the Worker holds no secrets). */
async function accountOf(env: QuotaEnv, req: Request): Promise<string | QuotaResult> {
  const token = bearerFrom(req);
  const who = token ? await verifyMember(env, token) : null;
  if (who) return who.userId;
  return {
    ok: false,
    status: 401,
    body: {
      error: 'sign_in_required',
      message: 'We couldn’t confirm your sign-in, which 7-day copies need. Sign in again — or save it to Google Drive (free, yours to keep) or to this device instead.',
    },
  };
}

const unavailable = (): QuotaResult => ({
  ok: false,
  status: 503,
  body: { error: 'quota_unavailable', message: `Couldn’t check your 7-day copy allowance just now — try again in a moment. ${FREE_WAYS}.` },
});

/** GET …/recordings?op=quota — the caller's own usage, for the save sheet's meter. */
export async function cloudCopyUsageFor(env: QuotaEnv, req: Request, now = Date.now(), waitUntil?: (p: Promise<unknown>) => void): Promise<QuotaResult> {
  const account = await accountOf(env, req);
  if (typeof account !== 'string') return account;
  try {
    return { ok: true, accountId: account, usage: await readUsage(env.LIVE_BUCKET, account, now, waitUntil) };
  } catch {
    return unavailable();
  }
}

/**
 * `op=init`: may this account start a cloud copy of `bytes`? On yes, the copy's marker
 * is written (counted from now). On no, an honest reason the save sheet shows as-is,
 * with the numbers and when space frees up.
 */
export async function reserveCloudCopy(
  env: QuotaEnv,
  req: Request,
  input: { eventId: string; bytes: unknown },
  now = Date.now(),
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<QuotaResult> {
  const wanted = Math.floor(Number(input.bytes));
  if (!Number.isFinite(wanted) || wanted <= 0) {
    return { ok: false, status: 400, body: { error: 'bad_size', message: 'This app didn’t say how big the recording is — reload the page and try again.' } };
  }
  const account = await accountOf(env, req);
  if (typeof account !== 'string') return account;
  if (wanted > CLOUD_COPY_LIMIT_BYTES) {
    return {
      ok: false,
      status: 413,
      body: {
        error: 'cloud_copy_too_big',
        message: `This recording (${gb(wanted)}) is bigger than the ${LIMIT_LABEL} allowance for 7-day copies. ${FREE_WAYS}.`,
        usedBytes: null,
        limitBytes: CLOUD_COPY_LIMIT_BYTES,
        wantedBytes: wanted,
      },
    };
  }
  const key = markerKey(account, input.eventId, wanted);
  try {
    const all = await readUsage(env.LIVE_BUCKET, account, now, waitUntil);
    // A retry of the same recording replaces its own marker — never counted twice.
    const others = all.markers.filter((m) => m.key !== key);
    const used = others.reduce((s, m) => s + m.bytes, 0);
    if (used + wanted > CLOUD_COPY_LIMIT_BYTES) {
      return {
        ok: false,
        status: 413,
        body: {
          error: 'cloud_copy_full',
          message: `Your ${LIMIT_LABEL} of 7-day copies is full (${gb(used)} used; this recording is ${gb(wanted)}). ${FREE_WAYS} — or wait for an older copy to expire.`,
          usedBytes: used,
          limitBytes: CLOUD_COPY_LIMIT_BYTES,
          wantedBytes: wanted,
          freesAt: freesAt(others, used, wanted, now),
        },
      };
    }
    await env.LIVE_BUCKET.put(key, new Uint8Array(0));
    const markers = [...others, { key, bytes: wanted, at: now }];
    return { ok: true, accountId: account, usage: { usedBytes: used + wanted, limitBytes: CLOUD_COPY_LIMIT_BYTES, markers } };
  } catch {
    return unavailable();
  }
}

/** What the client sees: numbers only (no keys, no account id). */
export function usageBody(u: CloudCopyUsage): { usedBytes: number; limitBytes: number; copies: number; nextFreeAt: number | null } {
  return {
    usedBytes: u.usedBytes,
    limitBytes: u.limitBytes,
    copies: u.markers.length,
    nextFreeAt: u.markers.length ? u.markers[0].at + CLOUD_COPY_WINDOW_MS : null,
  };
}
