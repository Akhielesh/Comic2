/**
 * Fair-use allowance for 7-day cloud copies of recordings (ADR 0007 D5; feature doc
 * docs/features/stream-studio-costs.md §4.7, step C1): **10 GB rolling per account**,
 * evaluated on server truth, never on what the app says (§4.7 rules).
 *
 * - **Upload start** (`op=init`): one R2 list of the account's ledger. If the copy fits,
 *   its size is reserved and its multipart upload created; if not, an honest refusal and
 *   nothing is stored.
 * - **Every part** (`op=part`): must fit inside that reservation. The reserved size is part
 *   of the copy's own key, `events/<eventId>/rec/<startedAt>-<bytes>/<file>`, and R2 binds
 *   the uploadId to that key — so a client can't raise it, and checking costs no R2 call.
 *   The bytes an upload can hold, even unfinished, never exceed what the ledger counts.
 * - **Completion** (`op=complete`): the stored object's real size (R2's number) is checked
 *   against the reservation again and is what gets registered; an over-size object is deleted.
 *
 * The ledger is R2 itself, one empty marker object per upload:
 *   quota/rec/<accountId>/<eventId>-<startedAt>-<bytes>   customMetadata { obj, up }
 * R2 keeps each marker's upload time, which starts its 7-day window. Every upload has its
 * own marker, so two copies never collapse into one entry. Starting the same recording
 * again (same event, same size) replaces an earlier try that never finished: that upload
 * is aborted first (so it can't be finished later) and stops counting — a retry never
 * counts twice. A finished copy is never replaced: a second copy is a second object, and
 * counts. Markers past the window are deleted on the account's next check, and by the
 * `quota/rec/` R2 lifecycle rule in the feature doc's deploy notes.
 *
 * The owner view reads Cloudflare's own R2 numbers (ADR 0007 D1: we don't charge).
 */
import { bearerFrom, checkMember, type SupabaseEnv } from './supabaseAuth';

export const CLOUD_COPY_LIMIT_BYTES = 10 * 1024 ** 3;
/** Same as EventRoom's RECORDING_RETENTION_MS: a copy counts while it's kept. */
export const CLOUD_COPY_WINDOW_MS = 7 * 24 * 60 * 60_000;
/**
 * Every part but the last is exactly this size (R2 needs uniform parts of ≥ 5 MiB); the
 * app uses the size `op=init` returns. Small enough for flaky uplinks.
 */
export const CLOUD_COPY_PART_BYTES = 16 * 1024 * 1024;
const PREFIX = 'quota/rec/';
/** 5 × 1,000 markers is far beyond anyone's 10 GB. A longer ledger fails closed. */
const MAX_LIST_PAGES = 5;
/** Earlier unfinished tries of one recording looked at per start (normally 0 or 1). */
const MAX_RETRY_CHECKS = 3;
/** R2's "this multipart upload does not exist" (aborted, expired or already finished). */
const NO_SUCH_UPLOAD = /10024|NoSuchUpload|does not exist/i;

export interface QuotaEnv extends SupabaseEnv {
  LIVE_BUCKET: R2Bucket;
}

export interface CopyMarker {
  key: string;
  bytes: number;
  at: number;
  /** The event the copy belongs to (null for a marker we can't read it from). */
  eventId: string | null;
  /** The copy's R2 key and multipart uploadId (absent on markers from before they were kept). */
  obj?: string;
  up?: string;
}

export interface CloudCopyUsage {
  usedBytes: number;
  limitBytes: number;
  /** Live markers, oldest first. */
  markers: CopyMarker[];
}

export type QuotaFailure = { ok: false; status: number; body: Record<string, unknown> };

export type QuotaResult =
  | {
      ok: true;
      accountId: string;
      usage: CloudCopyUsage;
      /** Bytes held by an unfinished earlier try of the asked-about recording, which starting again replaces. */
      retryBytes: number;
    }
  | QuotaFailure;

export type StartResult = { ok: true; accountId: string; key: string; uploadId: string; usage: CloudCopyUsage } | QuotaFailure;

const gb = (b: number) => `${(b / 1024 ** 3).toFixed(1)} GB`;
const LIMIT_LABEL = `${CLOUD_COPY_LIMIT_BYTES / 1024 ** 3} GB`;
const FREE_WAYS = 'Save it to Google Drive (free, yours to keep) or to this device instead';
const sum = (ms: readonly CopyMarker[]) => ms.reduce((s, m) => s + m.bytes, 0);

export const markerPrefix = (accountId: string) => `${PREFIX}${accountId}/`;

export function markerKey(accountId: string, eventId: string, startedAt: number, bytes: number): string {
  return `${markerPrefix(accountId)}${eventId}-${Math.max(0, Math.floor(startedAt))}-${Math.max(0, Math.floor(bytes))}`;
}

/** Event, start time and size from a marker key (`<eventId>-<startedAt>-<bytes>`; older ones lack the start). */
export function parseMarker(key: string): { eventId: string; startedAt: number | null; bytes: number } | null {
  const m = /^([a-z0-9]{1,64})-(?:(\d{1,15})-)?(\d{1,15})$/.exec(key.slice(key.lastIndexOf('/') + 1));
  return m ? { eventId: m[1], startedAt: m[2] ? Number(m[2]) : null, bytes: Number(m[3]) } : null;
}

/** Bytes recorded in a marker key, or null when it isn't one. */
export function markerBytes(key: string): number | null {
  return parseMarker(key)?.bytes ?? null;
}

const safeFile = (file: unknown): string => {
  const s = String(file ?? 'recording.webm').replace(/[^\w.-]/g, '_').slice(0, 80);
  return /^\.*$/.test(s) ? 'recording.webm' : s;
};

/** Where a cloud copy is stored. The reserved size is part of the key, so R2 ties it to the uploadId. */
export function copyObjectKey(eventId: string, startedAt: number, bytes: number, file: unknown): string {
  return `events/${eventId}/rec/${Math.floor(startedAt)}-${Math.floor(bytes)}/${safeFile(file)}`;
}

/** The size reserved for the copy stored at `key`, or null if the key isn't one this server hands out. */
export function reservedBytesOf(eventId: string, key: string): number | null {
  const prefix = `events/${eventId}/rec/`;
  if (!key.startsWith(prefix)) return null;
  const m = /^\d{1,15}-(\d{1,15})\/[\w.-]{1,80}$/.exec(key.slice(prefix.length));
  const bytes = m ? Number(m[1]) : NaN;
  return bytes > 0 && bytes <= CLOUD_COPY_LIMIT_BYTES ? bytes : null;
}

/**
 * The most part `n` may hold so the whole upload stays inside `reserved` bytes: every part
 * but the last is `partBytes`, so part n starts at (n − 1) × partBytes. 0 = no room.
 */
export function partAllowance(reserved: number, n: number, partBytes = CLOUD_COPY_PART_BYTES): number {
  if (!Number.isInteger(n) || n < 1) return 0;
  return Math.max(0, Math.min(partBytes, reserved - (n - 1) * partBytes));
}

/**
 * When enough of the oldest copies will have expired for `wantedBytes` to fit, or null
 * if it never fits (bigger than the whole allowance).
 */
export function freesAt(markers: readonly Pick<CopyMarker, 'bytes' | 'at'>[], usedBytes: number, wantedBytes: number, now: number, limitBytes = CLOUD_COPY_LIMIT_BYTES, windowMs = CLOUD_COPY_WINDOW_MS): number | null {
  if (wantedBytes > limitBytes) return null;
  if (usedBytes + wantedBytes <= limitBytes) return now;
  let freed = 0;
  for (const m of [...markers].sort((a, b) => a.at - b.at)) {
    freed += m.bytes;
    if (usedBytes - freed + wantedBytes <= limitBytes) return m.at + windowMs;
  }
  return null;
}

/**
 * The account's copies inside the window. Deletes expired markers (R2 deletes are free).
 * Throws when the ledger is longer than we read — callers fail closed.
 */
export async function readUsage(
  bucket: R2Bucket,
  accountId: string,
  now: number,
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<CloudCopyUsage> {
  const markers: CopyMarker[] = [];
  const stale: string[] = [];
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    // `include` is in the runtime (compatibility date 2026-01-01); the base types predate it.
    const res = await bucket.list({ prefix: markerPrefix(accountId), cursor, limit: 1000, include: ['customMetadata'] } as R2ListOptions);
    for (const o of res.objects) {
      const p = parseMarker(o.key);
      if (!p) continue;
      const at = o.uploaded instanceof Date ? o.uploaded.getTime() : Number(o.uploaded) || now;
      if (now - at >= CLOUD_COPY_WINDOW_MS) {
        stale.push(o.key);
        continue;
      }
      const meta = o.customMetadata ?? {};
      markers.push({
        key: o.key,
        bytes: p.bytes,
        at,
        eventId: p.eventId,
        ...(typeof meta.obj === 'string' && typeof meta.up === 'string' ? { obj: meta.obj, up: meta.up } : {}),
      });
    }
    if (!res.truncated) {
      complete = true;
      break;
    }
    cursor = res.cursor;
  }
  if (stale.length) {
    const cleanup = bucket.delete(stale.slice(0, 1000)).catch(() => undefined);
    if (waitUntil) waitUntil(cleanup);
    else await cleanup;
  }
  // Counting only part of a ledger would let copies past the allowance: refuse instead.
  if (!complete) throw new Error('cloud copy ledger longer than one check reads');
  markers.sort((a, b) => a.at - b.at);
  return { usedBytes: sum(markers), limitBytes: CLOUD_COPY_LIMIT_BYTES, markers };
}

/**
 * Earlier tries of the same recording (same event, same size) whose upload never became
 * an object. Starting it again replaces them, so they don't count against the new try.
 */
async function unfinishedTries(bucket: R2Bucket, markers: CopyMarker[], eventId: string, bytes: number): Promise<CopyMarker[]> {
  const same = markers
    .filter((m) => m.eventId === eventId && m.bytes === bytes && m.up && m.obj && reservedBytesOf(eventId, m.obj) === bytes)
    .slice(-MAX_RETRY_CHECKS);
  const out: CopyMarker[] = [];
  for (const m of same) if (!(await bucket.head(m.obj!))) out.push(m);
  return out;
}

/**
 * Stop counting a replaced try — only once its upload can no longer be finished. An
 * error we can't read keeps it counted (over-counting is the safe side).
 */
async function releaseTry(bucket: R2Bucket, m: CopyMarker): Promise<void> {
  try {
    try {
      await bucket.resumeMultipartUpload(m.obj!, m.up!).abort();
    } catch (e) {
      // Already gone (R2 aborts unfinished uploads after 7 days, or it finished just now)?
      // It stops counting only if it never became an object.
      if (!NO_SUCH_UPLOAD.test(e instanceof Error ? e.message : String(e))) return;
      if (await bucket.head(m.obj!)) return;
    }
    await bucket.delete(m.key);
  } catch {
    /* keep counting it */
  }
}

const signInRequired = (): QuotaFailure => ({
  ok: false,
  status: 401,
  body: {
    error: 'sign_in_required',
    message: 'We couldn’t confirm your sign-in, which 7-day copies need. Sign in again — or save it to Google Drive (free, yours to keep) or to this device instead.',
  },
});

const unavailable = (why: 'ledger' | 'sign_in' = 'ledger'): QuotaFailure => ({
  ok: false,
  status: 503,
  body: {
    error: 'quota_unavailable',
    message:
      why === 'sign_in'
        ? `Couldn’t check your sign-in just now (our sign-in service didn’t answer) — try again in a moment. ${FREE_WAYS}.`
        : `Couldn’t check your 7-day copy allowance just now — try again in a moment. ${FREE_WAYS}.`,
  },
});

/**
 * Who is asking: the caller's own Supabase token, verified (the Worker holds no secrets).
 * Signed out or not a member → sign in; Supabase not answering → "try again", never
 * "sign in again" (signing in goes through the same Supabase).
 */
async function accountOf(env: QuotaEnv, req: Request): Promise<string | QuotaFailure> {
  const token = bearerFrom(req);
  if (!token) return signInRequired();
  const r = await checkMember(env, token);
  if (!r.ok) return unavailable('sign_in');
  return r.who ? r.who.userId : signInRequired();
}

/**
 * GET …/recordings?op=quota[&bytes=N] — the caller's own usage, for the save sheet's
 * meter. With the recording's size, also what an unfinished earlier try of it holds
 * (starting again replaces that, so the sheet doesn't count it twice).
 */
export async function cloudCopyUsageFor(
  env: QuotaEnv,
  req: Request,
  input: { eventId: string; bytes?: unknown },
  now = Date.now(),
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<QuotaResult> {
  const account = await accountOf(env, req);
  if (typeof account !== 'string') return account;
  try {
    const usage = await readUsage(env.LIVE_BUCKET, account, now, waitUntil);
    const bytes = Math.floor(Number(input.bytes));
    const retry = Number.isFinite(bytes) && bytes > 0 ? await unfinishedTries(env.LIVE_BUCKET, usage.markers, input.eventId, bytes) : [];
    return { ok: true, accountId: account, usage, retryBytes: sum(retry) };
  } catch {
    return unavailable();
  }
}

/**
 * `op=init`: may this account start a cloud copy of `bytes`? On yes, the multipart upload
 * is created at a key that carries the reservation, and the copy's marker is written
 * (counted from now). On no, an honest reason the save sheet shows as-is, with the
 * numbers and when space frees up. Nothing is stored on a no.
 */
export async function startCloudCopy(
  env: QuotaEnv,
  req: Request,
  input: { eventId: string; bytes: unknown; file?: unknown; mime?: unknown },
  now = Date.now(),
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<StartResult> {
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
  const bucket = env.LIVE_BUCKET;
  try {
    const all = await readUsage(bucket, account, now, waitUntil);
    const replaced = await unfinishedTries(bucket, all.markers, input.eventId, wanted);
    const others = all.markers.filter((m) => !replaced.includes(m));
    const used = sum(others);
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
    const key = copyObjectKey(input.eventId, now, wanted, input.file);
    const upload = await bucket.createMultipartUpload(key, {
      httpMetadata: { contentType: String(input.mime ?? 'video/webm').slice(0, 80) },
    });
    const marker = markerKey(account, input.eventId, now, wanted);
    try {
      await bucket.put(marker, new Uint8Array(0), { customMetadata: { obj: key, up: upload.uploadId } });
    } catch (e) {
      await upload.abort().catch(() => undefined); // never an upload the ledger doesn't count
      throw e;
    }
    // Earlier unfinished tries stop counting only now that this one is counted:
    // briefly over, never under.
    if (replaced.length) {
      const release = Promise.all(replaced.map((m) => releaseTry(bucket, m)));
      if (waitUntil) waitUntil(release);
      else await release;
    }
    const markers = [...others, { key: marker, bytes: wanted, at: now, eventId: input.eventId, obj: key, up: upload.uploadId }];
    return { ok: true, accountId: account, key, uploadId: upload.uploadId, usage: { usedBytes: used + wanted, limitBytes: CLOUD_COPY_LIMIT_BYTES, markers } };
  } catch {
    return unavailable();
  }
}

const outdated = (): QuotaFailure => ({
  ok: false,
  status: 409,
  body: {
    error: 'upload_outdated',
    message: 'This upload was started by an older version of the app — start the 7-day copy again. Your recording is still on this device.',
  },
});

/** `op=part`: how big part `n` of the copy at `key` may be (server truth: the reservation in its key). */
export function copyPartRoom(eventId: string, key: string, n: number): { ok: true; maxBytes: number } | QuotaFailure {
  const reserved = reservedBytesOf(eventId, key);
  if (reserved == null) return outdated();
  const maxBytes = partAllowance(reserved, n);
  if (maxBytes <= 0) {
    return { ok: false, status: 413, body: { error: 'part_out_of_bounds', message: 'This part goes past the size the 7-day copy was started with.' } };
  }
  return { ok: true, maxBytes };
}

/** `op=complete`, before finishing: the size reserved for this copy, or why it can't be finished. */
export function copyCompleteRoom(eventId: string, key: string): { ok: true; reserved: number } | QuotaFailure {
  const reserved = reservedBytesOf(eventId, key);
  return reserved == null ? outdated() : { ok: true, reserved };
}

/** `op=complete`, after finishing: R2's real size is past the reservation (the object is then deleted). */
export const oversizeCopy = (size: number, reserved: number): QuotaFailure => ({
  ok: false,
  status: 413,
  body: {
    error: 'cloud_copy_mismatch',
    message: `This upload (${gb(size)}) came out bigger than the ${gb(reserved)} it was started with, so the 7-day copy wasn’t kept. Your recording is still on this device.`,
  },
});

/** What the client sees: numbers only (no keys, no account id). */
export function usageBody(u: CloudCopyUsage, retryBytes = 0): { usedBytes: number; limitBytes: number; copies: number; nextFreeAt: number | null; retryBytes: number } {
  return {
    usedBytes: u.usedBytes,
    limitBytes: u.limitBytes,
    copies: u.markers.length,
    nextFreeAt: u.markers.length ? u.markers[0].at + CLOUD_COPY_WINDOW_MS : null,
    retryBytes,
  };
}
