/**
 * Save recordings straight into the user's Google Drive — through Google's API.
 *
 *  1. The backend holds the user's Google grant for the `google_drive_save` connector,
 *     whose ONLY Drive scope is `drive.file`: Stream Studio can see the files it saves,
 *     never the rest of the user's Drive.
 *  2. Per recording, the backend makes sure a "DreamStream Recordings" folder exists and
 *     opens a Drive *resumable upload session* (POST /api/connectors/drive/upload-session).
 *  3. The browser PUTs the recording to that session URL in 8 MiB chunks, resuming after
 *     drops (308 Resume Incomplete + `Range`), so even multi-GB masters survive flaky Wi-Fi.
 *     The bytes never pass through our backend (10 MB body limit — and no reason to).
 *
 * Connecting reuses the app's existing Google OAuth popup flow; this module only talks
 * to the same-origin `/api/connectors/*` routes with the user's Supabase session token.
 * Nothing here polls on a timer (the backend must be free to sleep).
 */

import { useEffect, useState } from 'react';
import { buildApiUrl } from '@/services/clientConfig';
import { accessToken } from './account';

export const DRIVE_CONNECTOR_ID = 'google_drive_save';
/** Shown wherever we ask to connect — the whole point of the drive.file scope. */
export const DRIVE_PRIVACY_NOTE = 'Stream Studio can only see files it saves — never the rest of your Drive.';
/** Drive requires every non-final chunk to be a multiple of 256 KiB; 8 MiB = 32 × 256 KiB. */
export const DRIVE_CHUNK_BYTES = 8 * 1024 * 1024;
const CHUNK_QUANTUM = 256 * 1024;
const OAUTH_RESULT = 'connector-oauth-result';
/**
 * A good answer is kept 10 min: each status check can wake the backend container
 * (≈ $0.0027 a wake past the free hours), and a Drive save session should cost at
 * most one wake (ADR 0007 C11). A failed check is not cached, and anything that
 * says the connection changed (an upload refused, a consent finishing, sign-out)
 * drops the cache.
 */
export const STATUS_TTL_MS = 10 * 60_000;

/* ------------------------------------------------------------------ errors */

export type DriveErrorCode =
  | 'signed_out'
  | 'not_connected'
  | 'reconnect'
  | 'quota'
  | 'network'
  | 'session_expired'
  | 'rate_limited'
  | 'unavailable'
  | 'popup_blocked'
  | 'consent_closed'
  | 'consent_declined'
  | 'stalled'
  | 'bad_request'
  | 'server'
  | 'aborted';

export class DriveError extends Error {
  readonly code: DriveErrorCode;
  constructor(code: DriveErrorCode, message?: string) {
    super(message || DRIVE_ERROR_TEXT[code]);
    this.name = 'DriveError';
    this.code = code;
  }
}

const DRIVE_ERROR_TEXT: Record<DriveErrorCode, string> = {
  signed_out: 'Sign in to save recordings to Google Drive.',
  not_connected: 'Connect Google Drive first — it takes one tap.',
  reconnect: 'Reconnect Google Drive — Google no longer accepts the old connection.',
  quota: 'Your Google Drive is full. Free up space in Drive, or save to this device instead.',
  network: 'Lost the connection while uploading to Drive. Your recording is still safe on this device — try again when you’re back online.',
  session_expired: 'The Drive upload expired before it finished — start the save again.',
  rate_limited: 'Google Drive is busy right now — try again in a minute.',
  unavailable: 'Saving straight to Google Drive isn’t switched on yet — use your Drive folder or Download for now.',
  popup_blocked: 'Your browser blocked the Google sign-in window. Allow pop-ups for this site, then tap Connect again.',
  consent_closed: 'Google Drive wasn’t connected — the sign-in window was closed.',
  consent_declined: 'Google Drive wasn’t connected — permission was declined.',
  stalled: 'The upload to Drive stopped making progress — try again.',
  bad_request: 'Google Drive couldn’t accept this file.',
  server: 'Google Drive had a problem — try again in a moment.',
  aborted: 'Upload cancelled.',
};

/** A message to show the user for any error thrown by this module (or anything else). */
export function driveErrorMessage(e: unknown): string {
  if (e instanceof DriveError) return e.message;
  return e instanceof Error && e.message ? e.message : DRIVE_ERROR_TEXT.server;
}

const isAbort = (e: unknown, signal?: AbortSignal) =>
  !!signal?.aborted || (e as { name?: string } | null)?.name === 'AbortError';

/* ------------------------------------------------------------- backend api */

type ApiResult = { status: number; data: Record<string, unknown> | null };

async function requireToken(): Promise<string> {
  const token = await accessToken();
  if (!token) throw new DriveError('signed_out');
  return token;
}

async function apiCall(
  token: string,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; signal?: AbortSignal } = {},
): Promise<ApiResult> {
  let res: Response;
  try {
    res = await fetch(buildApiUrl(path), {
      method: init.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: 'no-store',
      signal: init.signal,
    });
  } catch (e) {
    if (isAbort(e, init.signal)) throw new DriveError('aborted');
    throw new DriveError('network', 'Couldn’t reach DreamStream — check your connection and try again.');
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, data };
}

/** Map a backend error response to a DriveError (contract in server/src/routes/connectorsDrive.ts). */
export function errorFromApi(status: number, data: Record<string, unknown> | null): DriveError {
  const err = data?.error;
  const code = typeof err === 'string' ? err : typeof (err as { code?: unknown })?.code === 'string' ? String((err as { code: string }).code) : '';
  const msg =
    typeof data?.message === 'string'
      ? data.message
      : typeof (err as { message?: unknown })?.message === 'string'
        ? String((err as { message: string }).message)
        : '';
  if (status === 401) return new DriveError('signed_out', 'Your sign-in expired — sign in again to save to Drive.');
  if (code === 'not_connected') return new DriveError('not_connected');
  if (code === 'reconnect') return new DriveError('reconnect');
  if (code === 'quota_exceeded') return new DriveError('quota');
  if (status === 429 || code === 'rate_limited' || code === 'RATE_LIMITED') return new DriveError('rate_limited');
  if (code === 'no_credentials' || (status === 404 && /disabled/i.test(msg))) return new DriveError('unavailable');
  if (status === 400) return new DriveError('bad_request', msg || undefined);
  if (status === 404) return new DriveError('unavailable');
  return new DriveError('server');
}

/* ------------------------------------------------------------------ status */

export interface DriveStatus {
  /** Signed in to DreamStream (the Drive connection belongs to the account). */
  signedIn: boolean;
  /** The server can do Google OAuth at all (false → only the offline fallbacks). */
  available: boolean;
  connected: boolean;
  /** Connected, but Google needs the user again (expired/revoked, or drive.file unticked). */
  expired: boolean;
  email?: string;
  name?: string;
  folderUrl?: string;
  /** The status check itself failed (offline / backend asleep). */
  error?: DriveErrorCode;
}

let cache: { at: number; status: DriveStatus } | null = null;
let inflight: Promise<DriveStatus> | null = null;
/** Which account the cached status belongs to (null = never asked). */
let lastAccount: { key: string | undefined } | null = null;
const listeners = new Set<(s: DriveStatus) => void>();

function publish(s: DriveStatus): DriveStatus {
  cache = { at: Date.now(), status: s };
  for (const l of listeners) l(s);
  return s;
}

/** The last known status, without a network call. */
export const peekDriveStatus = (): DriveStatus | null => cache?.status ?? null;

/** Forget the cached status (e.g. after sign-out). */
export function resetDriveStatus(): void {
  cache = null;
}

/** Fetch the Drive connection status (cached for STATUS_TTL_MS unless `force`). Never throws. */
export function getDriveStatus(opts: { force?: boolean } = {}): Promise<DriveStatus> {
  // A failed check (offline, backend asleep and slow) is shown, but asked again next time.
  if (!opts.force && cache && !cache.status.error && Date.now() - cache.at < STATUS_TTL_MS) return Promise.resolve(cache.status);
  if (inflight) return inflight;
  inflight = (async () => {
    const token = await accessToken().catch(() => null);
    if (!token) return publish({ signedIn: false, available: true, connected: false, expired: false });
    try {
      const { status, data } = await apiCall(token, '/api/connectors/drive/status');
      if (status === 200 && data) {
        return publish({
          signedIn: true,
          available: data.configured !== false,
          connected: data.connected === true,
          expired: data.expired === true,
          email: typeof data.email === 'string' ? data.email : undefined,
          name: typeof data.name === 'string' ? data.name : undefined,
          folderUrl: typeof data.folderUrl === 'string' ? data.folderUrl : undefined,
        });
      }
      const e = errorFromApi(status, data);
      if (e.code === 'unavailable') return publish({ signedIn: true, available: false, connected: false, expired: false });
      if (e.code === 'signed_out') return publish({ signedIn: false, available: true, connected: false, expired: false });
      return publish({ signedIn: true, available: true, connected: false, expired: false, error: e.code });
    } catch (e) {
      return publish({ signedIn: true, available: true, connected: false, expired: false, error: e instanceof DriveError ? e.code : 'network' });
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * React hook — the shared Drive status. Pass something that changes when the signed-in
 * account changes (e.g. the user id); `null` while the account is still loading.
 */
export function useDriveStatus(accountKey: string | null | undefined): DriveStatus | null {
  const [s, setS] = useState<DriveStatus | null>(cache?.status ?? null);
  useEffect(() => {
    ensureResultListener();
    listeners.add(setS);
    if (accountKey !== null) {
      // A different account (or sign-in/out) invalidates the cached answer.
      const force = lastAccount !== null && lastAccount.key !== accountKey;
      lastAccount = { key: accountKey };
      void getDriveStatus({ force }).then(setS);
    }
    return () => {
      listeners.delete(setS);
    };
  }, [accountKey]);
  return s;
}

/* ----------------------------------------------------------------- connect */

let activePopup: Window | null = null;
let resultListenerInstalled = false;

function trustedOrigins(): string[] {
  const out = new Set<string>();
  if (typeof window !== 'undefined') out.add(window.location.origin);
  try {
    out.add(new URL(buildApiUrl('/api/connectors/oauth/callback'), window.location.href).origin);
  } catch { /* relative base */ }
  return [...out];
}

/** Is this postMessage the OAuth callback page reporting back to us? */
function isOAuthResult(e: MessageEvent): boolean {
  const d = e.data as { type?: unknown } | null;
  if (!d || typeof d !== 'object' || d.type !== OAUTH_RESULT) return false;
  // Same rule as the main app's Connectors page, tightened: the message must come from
  // the window we opened, or from our own / the API's origin. The payload is never
  // trusted for state — it only triggers a fresh, authenticated status check.
  return (!!activePopup && e.source === activePopup) || trustedOrigins().includes(e.origin);
}

/** A consent that finishes after we stopped waiting (or in another tab's popup) still lands. */
function ensureResultListener(): void {
  if (resultListenerInstalled || typeof window === 'undefined') return;
  resultListenerInstalled = true;
  window.addEventListener('message', (e) => {
    if (isOAuthResult(e)) void getDriveStatus({ force: true });
  });
}

const closeQuietly = (w: Window | null) => {
  try {
    w?.close();
  } catch { /* already gone */ }
};

const isGoogleConsentUrl = (url: string) => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'accounts.google.com';
  } catch {
    return false;
  }
};

/**
 * Open the consent window. Call this SYNCHRONOUSLY inside the click handler — pop-up
 * blockers only allow windows opened during a user gesture — then hand it to
 * connectDrive(), which points it at Google once the server returns the consent URL.
 */
export function openConsentWindow(): Window | null {
  if (typeof window === 'undefined') return null;
  const w = 500;
  const h = 640;
  const left = Math.max(0, Math.round((window.screenX || 0) + ((window.outerWidth || w) - w) / 2));
  const top = Math.max(0, Math.round((window.screenY || 0) + ((window.outerHeight || h) - h) / 2));
  let popup: Window | null = null;
  try {
    popup = window.open('', 'ds_drive_connect', `popup=yes,width=${w},height=${h},left=${left},top=${top}`);
  } catch {
    popup = null;
  }
  if (popup) {
    try {
      popup.document.title = 'Connect Google Drive';
      popup.document.body.style.cssText =
        'margin:0;height:100vh;display:grid;place-items:center;font:14px system-ui,-apple-system,sans-serif;color:#6e6a60;background:#faf9f5';
      popup.document.body.textContent = 'Opening Google…';
    } catch { /* already on another origin (re-used window) */ }
  }
  return popup;
}

type ConsentOutcome = { connected?: string; error?: string; closed?: boolean };

function waitForConsent(popup: Window, opts: { signal?: AbortSignal; timeoutMs?: number }): Promise<ConsentOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
      opts.signal?.removeEventListener('abort', onAbort);
      clearTimeout(grace);
      clearTimeout(timeout);
      fn();
    };
    const onMessage = (e: MessageEvent) => {
      if (!isOAuthResult(e)) return;
      const d = e.data as { connected?: unknown; error?: unknown };
      closeQuietly(popup);
      settle(() => resolve({ connected: d.connected ? String(d.connected) : undefined, error: d.error ? String(d.error) : undefined }));
    };
    // Back on our page: the user finished, or gave up and closed the window. We don't poll
    // popup.closed (Google's consent page makes Chrome log a COOP warning on every read);
    // instead give a late postMessage a beat, then ask the server — the source of truth.
    const onReturn = () => {
      if (document.visibilityState !== 'visible') return;
      clearTimeout(grace);
      grace = setTimeout(() => {
        void getDriveStatus({ force: true }).then((s) => {
          if (s.connected && !s.expired) settle(() => resolve({ connected: DRIVE_CONNECTOR_ID }));
          else if (popupClosed(popup)) settle(() => resolve({ closed: true }));
        });
      }, 900);
    };
    const onAbort = () => {
      closeQuietly(popup);
      settle(() => reject(new DriveError('aborted')));
    };
    const timeout = setTimeout(() => settle(() => resolve({ closed: true })), opts.timeoutMs ?? 5 * 60_000);
    window.addEventListener('message', onMessage);
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function popupClosed(popup: Window): boolean {
  try {
    return popup.closed;
  } catch {
    return true;
  }
}

/**
 * Connect Google Drive (drive.file only) through the app's OAuth popup. Pass the window
 * from openConsentWindow() when you need to await something before calling this.
 * Resolves with the fresh status once connected; throws a DriveError otherwise.
 */
export async function connectDrive(opts: { popup?: Window | null; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<DriveStatus> {
  ensureResultListener();
  const popup = opts.popup !== undefined ? opts.popup : openConsentWindow();
  if (!popup) throw new DriveError('popup_blocked');
  activePopup = popup;
  try {
    let url: string;
    try {
      const token = await requireToken();
      const { status, data } = await apiCall(token, `/api/connectors/${DRIVE_CONNECTOR_ID}/connect`, { method: 'POST', body: {}, signal: opts.signal });
      const authUrl = data?.authorizationUrl;
      if (status !== 200 || typeof authUrl !== 'string') throw errorFromApi(status, data);
      if (!isGoogleConsentUrl(authUrl)) throw new DriveError('server', 'Unexpected sign-in address from the server — try again.');
      url = authUrl;
    } catch (e) {
      closeQuietly(popup);
      throw e;
    }
    try {
      popup.location.href = url;
    } catch {
      throw new DriveError('consent_closed');
    }
    const outcome = await waitForConsent(popup, opts);
    const s = await getDriveStatus({ force: true });
    if (s.connected && !s.expired) return s;
    if (s.connected && s.expired) {
      throw new DriveError('reconnect', 'Google Drive connected without permission to save files. Connect again and leave the Drive box ticked on Google’s screen.');
    }
    if (outcome.error) throw new DriveError(/access_denied/i.test(outcome.error) ? 'consent_declined' : 'server', outcome.error === 'no_credentials' ? DRIVE_ERROR_TEXT.unavailable : undefined);
    throw new DriveError('consent_closed');
  } finally {
    if (activePopup === popup) activePopup = null;
  }
}

/** Disconnect Drive saving. The server keeps your other Google connections working. */
export async function disconnectDrive(): Promise<DriveStatus> {
  const token = await requireToken();
  const { status, data } = await apiCall(token, '/api/connectors/drive/disconnect', { method: 'POST', body: {} });
  if (status !== 200) throw errorFromApi(status, data);
  return getDriveStatus({ force: true });
}

/* ------------------------------------------------------------------ upload */

export interface DriveSession {
  uploadUrl: string;
  folderId: string;
  folderUrl?: string;
}

/** Ask the backend to open a resumable session for one file. */
export async function createUploadSession(
  file: { name: string; mimeType: string; size: number },
  signal?: AbortSignal,
): Promise<DriveSession> {
  const token = await requireToken();
  const { status, data } = await apiCall(token, '/api/connectors/drive/upload-session', { method: 'POST', body: file, signal });
  if (status !== 200 || typeof data?.uploadUrl !== 'string') {
    const err = errorFromApi(status, data);
    if (err.code === 'not_connected' || err.code === 'reconnect') void getDriveStatus({ force: true });
    else if (err.code === 'signed_out') resetDriveStatus();
    throw err;
  }
  return {
    uploadUrl: data.uploadUrl,
    folderId: String(data.folderId || ''),
    folderUrl: typeof data.folderUrl === 'string' ? data.folderUrl : undefined,
  };
}

export interface DriveFile {
  id: string;
  name?: string;
  webViewLink?: string;
}

export interface UploadOptions {
  /** Bytes per PUT (rounded down to a 256 KiB multiple). Default 8 MiB. */
  chunkSize?: number;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  /** Consecutive failed attempts (network / 5xx / 429) before giving up. Default 7. */
  maxRetries?: number;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  isOnline?: () => boolean;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DriveError('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DriveError('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** `bytes=0-524287` → 524288 (the next byte Google wants). No header → nothing stored yet. */
export function nextOffsetFromRange(range: string | null): number {
  if (!range) return 0;
  const m = /bytes\s*=\s*0-(\d+)/i.exec(range);
  return m ? Number(m[1]) + 1 : 0;
}

const retryAfterMs = (res: Response): number | null => {
  const h = res.headers.get('retry-after');
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, Math.min(120_000, s * 1000));
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, Math.min(120_000, at - Date.now())) : null;
};

/** ~1 s, 2 s, 4 s … capped at 30 s, with jitter. */
const backoff = (failures: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, failures - 1)) + Math.floor(Math.random() * 400);

/**
 * Upload a Blob/File to a Drive resumable session URL in chunks.
 *
 * - Each chunk is `PUT` with `Content-Range: bytes a-b/total`; Google answers 308 (Resume
 *   Incomplete) with `Range: bytes=0-N` until the last chunk, which returns 200/201 + the
 *   file JSON (`id,name,webViewLink`).
 * - On a network drop, 5xx, or 429 it backs off, asks Google how much it has
 *   (`Content-Range: bytes * /total`, empty body) and resumes from there — never re-sending
 *   what Google already stored. Offline? It waits for the connection to come back.
 * - 404/410 = the session expired (Drive keeps them ~a week); 403 storageQuotaExceeded =
 *   Drive is full. Both stop immediately with a specific error.
 */
export async function uploadResumable(uploadUrl: string, blob: Blob, opts: UploadOptions = {}): Promise<DriveFile> {
  const doFetch = opts.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const sleep = opts.sleep ?? defaultSleep;
  const isOnline = opts.isOnline ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const maxRetries = opts.maxRetries ?? 7;
  const total = blob.size;
  const chunk = Math.max(CHUNK_QUANTUM, Math.floor((opts.chunkSize ?? DRIVE_CHUNK_BYTES) / CHUNK_QUANTUM) * CHUNK_QUANTUM);
  const signal = opts.signal;

  let offset = 0;
  let failures = 0; // consecutive transport/5xx/429 failures
  let noProgress = 0; // consecutive 308s that didn't move the offset
  let probe = false; // next request asks Google for its offset instead of sending bytes
  let lastReported = -1;
  const report = (n: number) => {
    if (n === lastReported) return;
    lastReported = n;
    opts.onProgress?.(n, total);
  };

  const cancelSession = () => {
    // Tell Google to drop the partial upload (best effort; it expires on its own anyway).
    void Promise.resolve()
      .then(() => doFetch(uploadUrl, { method: 'DELETE' }))
      .catch(() => undefined);
  };

  if (total < 1) throw new DriveError('bad_request', 'This recording is empty.');
  report(0);

  for (;;) {
    if (signal?.aborted) {
      cancelSession();
      throw new DriveError('aborted');
    }

    let res: Response;
    const sentFrom = offset;
    // Everything sent but not finalized (or we just recovered from a failure): ask Google.
    if (offset >= total) probe = true;
    try {
      if (probe) {
        res = await doFetch(uploadUrl, { method: 'PUT', headers: { 'Content-Range': `bytes */${total}` }, signal });
      } else {
        const end = Math.min(offset + chunk, total);
        res = await doFetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${total}` },
          body: blob.slice(offset, end),
          signal,
        });
      }
    } catch (e) {
      if (isAbort(e, signal)) {
        cancelSession();
        throw new DriveError('aborted');
      }
      if (!isOnline()) {
        await waitUntilOnline(signal, sleep, isOnline);
        probe = true;
        continue; // going offline isn't a strike against the upload
      }
      failures += 1;
      if (failures > maxRetries) throw new DriveError('network');
      await sleep(backoff(failures), signal);
      probe = true;
      continue;
    }

    if (res.status === 200 || res.status === 201) {
      const json = (await res.json().catch(() => null)) as Partial<DriveFile> | null;
      report(total);
      return { id: String(json?.id || ''), name: json?.name, webViewLink: json?.webViewLink };
    }

    if (res.status === 308) {
      const next = Math.min(total, nextOffsetFromRange(res.headers.get('range')));
      const moved = next > sentFrom;
      const wasProbe = probe;
      offset = next;
      failures = 0;
      probe = false;
      report(offset);
      if (moved) {
        noProgress = 0;
      } else if (!wasProbe || offset >= total) {
        // Google kept none of what we just sent (or keeps saying "incomplete" for a
        // finished upload). Retry a few times, then stop rather than loop forever.
        noProgress += 1;
        if (noProgress > maxRetries) throw new DriveError('stalled');
        await sleep(backoff(noProgress), signal);
      }
      continue;
    }

    if (res.status === 404 || res.status === 410) throw new DriveError('session_expired');

    const text = await res.text().catch(() => '');
    if (res.status === 403 && /storageQuotaExceeded|quotaExceeded.{0,40}storage|storage quota/i.test(text)) throw new DriveError('quota');
    if (res.status === 401) throw new DriveError('reconnect');
    const rateLimited = res.status === 429 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(text));
    if (rateLimited || res.status >= 500) {
      failures += 1;
      if (failures > maxRetries) throw new DriveError(rateLimited ? 'rate_limited' : 'server');
      await sleep(retryAfterMs(res) ?? backoff(failures), signal);
      probe = true;
      continue;
    }
    throw new DriveError('server', `Google Drive rejected the upload (HTTP ${res.status}). Your recording is still on this device.`);
  }
}

async function waitUntilOnline(
  signal: AbortSignal | undefined,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  isOnline: () => boolean,
): Promise<void> {
  // Up to 10 minutes offline before giving up; checks every 2 s (no network traffic).
  for (let waited = 0; !isOnline(); waited += 2000) {
    if (waited >= 10 * 60_000) throw new DriveError('network');
    await sleep(2000, signal);
  }
}

export interface DriveSaved extends DriveFile {
  /** Open-in-Drive link (falls back to the folder when Google didn't return one). */
  webViewLink: string;
  folderUrl?: string;
}

const mimeFromName = (name: string) => (/\.mp4$/i.test(name) ? 'video/mp4' : /\.m4a$/i.test(name) ? 'audio/mp4' : 'video/webm');

/**
 * Save one recording to the user's Drive: open a session (backend) and upload the bytes
 * (browser → Google). Throws DriveError with a specific, user-facing message.
 */
export async function saveRecordingToDrive(
  blob: Blob,
  name: string,
  opts: UploadOptions & { mimeType?: string; onSession?: (s: DriveSession) => void } = {},
): Promise<DriveSaved> {
  if (blob.size < 1) throw new DriveError('bad_request', 'This recording is empty.');
  const mimeType = opts.mimeType || blob.type || mimeFromName(name);
  const session = await createUploadSession({ name, mimeType, size: blob.size }, opts.signal);
  opts.onSession?.(session);
  let file: DriveFile;
  try {
    file = await uploadResumable(session.uploadUrl, blob, opts);
  } catch (e) {
    // Google refused the grant mid-upload: the cached "connected" is stale now.
    if (e instanceof DriveError && (e.code === 'reconnect' || e.code === 'signed_out')) resetDriveStatus();
    throw e;
  }
  const webViewLink =
    file.webViewLink ||
    (file.id ? `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/view` : session.folderUrl || 'https://drive.google.com/drive/my-drive');
  return { ...file, name: file.name || name, webViewLink, folderUrl: session.folderUrl };
}
