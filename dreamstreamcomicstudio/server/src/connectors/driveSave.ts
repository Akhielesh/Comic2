// ============================================================================
// Drive "save recordings" — request validation, folder bootstrap, resumable sessions
// ============================================================================
//
// The backend never touches recording bytes (10 MB body limit, and no reason to): it
// only (1) makes sure a "DreamStream Recordings" folder exists in the user's Drive and
// (2) opens a Drive *resumable upload session* for the file, returning the session URL.
// The browser then PUTs the bytes straight to Google in chunks.
//
// The session is opened with the BROWSER's Origin header: Google ties the session's CORS
// to the origin that initiated it, so forwarding it is what lets the browser's later
// cross-origin PUTs (and its reads of the 308 `Range` header) succeed.
//
// Everything here runs under drive.file — the app can only see files it created, so the
// folder search naturally only finds OUR folder, never a same-named one the user made.
// ============================================================================

import { googleApiFetch } from './googleClient.js';
import { ConnectorAuthError, ConnectorRateLimitError } from './types.js';

const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export const RECORDINGS_FOLDER_NAME = 'DreamStream Recordings';
export const MAX_DRIVE_NAME_LENGTH = 120;
/** 20 GiB — far above any real recording, well under Drive's 5 TB per-file cap. */
export const MAX_DRIVE_UPLOAD_BYTES = 20 * 1024 ** 3;

const INIT_TIMEOUT_MS = 20_000;
const INIT_MAX_ATTEMPTS = 3;

// ---- errors ------------------------------------------------------------------

/** The user's Drive is full (Google: 403 storageQuotaExceeded). Not retryable. */
export class DriveQuotaError extends Error {
  constructor(message = 'Your Google Drive storage is full.') {
    super(message);
    this.name = 'DriveQuotaError';
  }
}

/** Google answered, but not usefully (5xx after retries, unexpected 4xx, no Location). */
export class DriveUpstreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DriveUpstreamError';
  }
}

// ---- validation --------------------------------------------------------------

/**
 * Make a user-typed file name safe and tidy: no control characters, no path separators
 * or characters that break when Drive for desktop syncs it to Windows/macOS, no leading
 * dots, collapsed whitespace, ≤ 120 chars with the extension preserved.
 */
export const sanitizeDriveFileName = (raw: unknown): string => {
  let s = typeof raw === 'string' ? raw.normalize('NFC') : '';
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');
  s = s.replace(/[\\/:*?"<>|]/g, '_');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').trim();
  if (s.length > MAX_DRIVE_NAME_LENGTH) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
    s = `${s.slice(0, MAX_DRIVE_NAME_LENGTH - ext.length).trimEnd()}${ext}`;
  }
  return s;
};

/** `video/webm;codecs=vp9,opus` → `video/webm` (Drive's mimeType must be bare). */
const baseMime = (raw: string): string => raw.split(';')[0].trim().toLowerCase();

const MEDIA_MIME = /^(video|audio)\/[a-z0-9][a-z0-9.+-]{0,63}$/;

export type UploadRequest = { name: string; mimeType: string; size: number };
export type UploadRequestCheck =
  | ({ ok: true } & UploadRequest)
  | { ok: false; field: 'name' | 'mimeType' | 'size'; message: string };

export const validateUploadRequest = (body: unknown): UploadRequestCheck => {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;

  const name = sanitizeDriveFileName(b.name);
  if (!name) return { ok: false, field: 'name', message: 'Give the recording a file name.' };

  const mimeType = typeof b.mimeType === 'string' ? baseMime(b.mimeType) : '';
  if (!MEDIA_MIME.test(mimeType)) {
    return { ok: false, field: 'mimeType', message: 'Only video or audio recordings can be saved to Drive.' };
  }

  const size = b.size;
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1) {
    return { ok: false, field: 'size', message: 'The recording is empty.' };
  }
  if (size > MAX_DRIVE_UPLOAD_BYTES) {
    return { ok: false, field: 'size', message: 'Recordings over 20 GB can’t be uploaded — save it to this device instead.' };
  }
  return { ok: true, name, mimeType, size };
};

// ---- folder ------------------------------------------------------------------

interface DriveFileRef {
  id?: string;
  trashed?: boolean;
}

/**
 * Find (or create) the "DreamStream Recordings" folder. A cached id is re-checked first
 * (one cheap GET) so a folder the user trashed or deleted is replaced instead of
 * silently swallowing new recordings into the bin.
 */
export const ensureRecordingsFolder = async (
  accessToken: string,
  cachedFolderId?: string | null,
  signal?: AbortSignal
): Promise<{ folderId: string; created: boolean }> => {
  if (cachedFolderId) {
    try {
      const f = await googleApiFetch<DriveFileRef>(`${DRIVE_FILES}/${encodeURIComponent(cachedFolderId)}`, {
        accessToken,
        query: { fields: 'id,trashed' },
        maxRetries: 1,
        signal
      });
      if (f?.id && !f.trashed) return { folderId: f.id, created: false };
    } catch (err) {
      // Auth/rate problems are real; a 404 (deleted folder) just means "make a new one".
      if (err instanceof ConnectorAuthError || err instanceof ConnectorRateLimitError) throw err;
    }
  }

  const q = `name = '${RECORDINGS_FOLDER_NAME}' and mimeType = '${FOLDER_MIME}' and trashed = false`;
  const list = await googleApiFetch<{ files?: DriveFileRef[] }>(DRIVE_FILES, {
    accessToken,
    query: { q, spaces: 'drive', fields: 'files(id)', orderBy: 'createdTime', pageSize: 10 },
    signal
  });
  const existing = list.files?.find((f) => f?.id)?.id;
  if (existing) return { folderId: existing, created: false };

  const created = await googleApiFetch<DriveFileRef>(DRIVE_FILES, {
    accessToken,
    method: 'POST',
    query: { fields: 'id' },
    body: {
      name: RECORDINGS_FOLDER_NAME,
      mimeType: FOLDER_MIME,
      description: 'Recordings saved from DreamStream Stream Studio.'
    },
    // A retried POST after a 5xx Google actually completed would make a duplicate folder.
    maxRetries: 1,
    signal
  });
  if (!created?.id) throw new DriveUpstreamError('Google Drive did not return the new folder id');
  return { folderId: created.id, created: true };
};

// ---- resumable session -------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const backoffMs = (attempt: number) => Math.min(4000, 400 * 2 ** attempt) + Math.floor(Math.random() * 200);

const googleReason = (body: string): string => {
  try {
    const j = JSON.parse(body) as { error?: { message?: string; errors?: Array<{ reason?: string }> } };
    return j.error?.message || j.error?.errors?.[0]?.reason || '';
  } catch {
    return '';
  }
};

/** Only hand the browser a URL that really is a Google upload endpoint. */
const isGoogleUploadUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'www.googleapis.com' || u.hostname.endsWith('.googleapis.com'));
  } catch {
    return false;
  }
};

/**
 * Open a Drive resumable upload session and return its URL. The URL is a short-lived
 * capability for THIS one file (it needs no token), so it is safe to give the browser;
 * the access token itself never leaves the server.
 */
export const startResumableUpload = async (opts: {
  accessToken: string;
  name: string;
  mimeType: string;
  size: number;
  folderId: string;
  /** The browser's origin (validated by the caller) — Google scopes the session's CORS to it. */
  origin?: string;
  fetchImpl?: typeof fetch;
}): Promise<string> => {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = `${DRIVE_UPLOAD}?uploadType=resumable&fields=${encodeURIComponent('id,name,webViewLink')}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${opts.accessToken}`,
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Upload-Content-Type': opts.mimeType,
    'X-Upload-Content-Length': String(opts.size)
  };
  if (opts.origin) headers.Origin = opts.origin;
  const body = JSON.stringify({
    name: opts.name,
    mimeType: opts.mimeType,
    parents: [opts.folderId],
    description: 'Recorded with DreamStream Stream Studio.',
    appProperties: { source: 'dreamstream_stream_studio' }
  });

  let lastProblem = 'no response';
  for (let attempt = 0; attempt < INIT_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), INIT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await doFetch(url, { method: 'POST', headers, body, signal: controller.signal });
    } catch (err) {
      lastProblem = (err as Error)?.name === 'AbortError' ? 'timed out' : 'network error';
      if (attempt < INIT_MAX_ATTEMPTS - 1) await sleep(backoffMs(attempt));
      continue;
    } finally {
      clearTimeout(timer);
    }

    if (res.ok) {
      const location = res.headers.get('location') || res.headers.get('Location') || '';
      if (!isGoogleUploadUrl(location)) {
        throw new DriveUpstreamError('Google Drive did not return an upload session URL');
      }
      return location;
    }

    const text = await res.text().catch(() => '');
    if (res.status === 401) {
      throw new ConnectorAuthError('unauthorized', 'Google rejected the Drive token (401)');
    }
    if (res.status === 403 && /storageQuotaExceeded|quotaExceeded.{0,40}storage/i.test(text)) {
      throw new DriveQuotaError();
    }
    if (res.status === 403 && /insufficient.{0,20}(scope|permission)|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(text)) {
      throw new ConnectorAuthError('unauthorized', 'Drive permission missing — reconnect to grant it');
    }
    const rateLimited = res.status === 429 || (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded/i.test(text));
    if (rateLimited || res.status >= 500) {
      lastProblem = `HTTP ${res.status}`;
      if (attempt < INIT_MAX_ATTEMPTS - 1) {
        await sleep(backoffMs(attempt));
        continue;
      }
      if (rateLimited) throw new ConnectorRateLimitError('Google Drive is rate limiting uploads');
      break;
    }
    throw new DriveUpstreamError(`Google Drive refused the upload (${res.status}${googleReason(text) ? `: ${googleReason(text)}` : ''})`);
  }
  throw new DriveUpstreamError(`Google Drive is unavailable right now (${lastProblem})`);
};
