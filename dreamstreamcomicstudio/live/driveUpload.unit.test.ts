// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./account', () => ({ accessToken: vi.fn(async () => 'supabase-jwt') }));

import { accessToken } from './account';
import {
  DRIVE_CHUNK_BYTES,
  DriveError,
  errorFromApi,
  getDriveStatus,
  nextOffsetFromRange,
  resetDriveStatus,
  saveRecordingToDrive,
  uploadResumable,
} from './driveUpload';

const MiB = 1024 * 1024;
const SESSION = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=XYZ';

type Res = { status: number; ok: boolean; headers: Headers; json: () => Promise<unknown>; text: () => Promise<string> };
const resp = (status: number, body: unknown = '', headers: Record<string, string> = {}): Res => ({
  status,
  ok: status >= 200 && status < 300,
  headers: new Headers(headers),
  json: async () => (typeof body === 'string' ? JSON.parse(body || 'null') : body),
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

type Step = 'network' | 'lost' | 'partial' | 503 | 429 | 'quota' | 404 | 'noRange' | null;

/**
 * A tiny Drive resumable-session simulator. It enforces the protocol the way Google does:
 * every chunk must start exactly at the stored offset, `bytes * /total` reports progress,
 * 308 + Range until the last byte, then 200 + file JSON. `script[i]` injects a fault into
 * the i-th request.
 */
function fakeDrive(total: number, script: Step[] = []) {
  let stored = 0;
  let n = 0;
  const calls: { method: string; range: string; bodySize: number }[] = [];
  const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init: RequestInit = {}) => {
    const step = script[n++] ?? null;
    const range = ((init.headers || {}) as Record<string, string>)['Content-Range'] || '';
    const body = init.body as Blob | undefined;
    calls.push({ method: String(init.method), range, bodySize: body ? body.size : 0 });
    if (init.method === 'DELETE') return resp(499) as unknown as Response;
    if (step === 'network') throw new TypeError('Failed to fetch');
    if (step === 503) return resp(503, 'backend error', { 'retry-after': '2' }) as unknown as Response;
    if (step === 429) return resp(429, 'slow down') as unknown as Response;
    if (step === 404) return resp(404, 'Not Found') as unknown as Response;
    if (step === 'quota') {
      return resp(403, { error: { errors: [{ reason: 'storageQuotaExceeded' }], message: 'The user’s Drive storage quota has been exceeded.' } }) as unknown as Response;
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = Number(m[2]);
      if (start !== stored) return resp(400, `chunk starts at ${start}, expected ${stored}`) as unknown as Response;
      if (body?.size !== end - start + 1) return resp(400, 'body size mismatch') as unknown as Response;
      stored = step === 'partial' ? start + 256 * 1024 : end + 1;
      if (step === 'lost') throw new TypeError('network dropped after Google stored the chunk');
    } else if (range !== `bytes */${total}`) {
      return resp(400, `bad Content-Range ${range}`) as unknown as Response;
    }
    if (stored >= total) {
      return resp(200, { id: 'file-1', name: 'Show.webm', webViewLink: 'https://drive.google.com/file/d/file-1/view' }) as unknown as Response;
    }
    const headers: Record<string, string> = step !== 'noRange' && stored > 0 ? { range: `bytes=0-${stored - 1}` } : {};
    return resp(308, '', headers) as unknown as Response;
  });
  return { fetchImpl, calls, stored: () => stored };
}

const blobOf = (bytes: number) => new Blob([new Uint8Array(bytes)], { type: 'video/webm' });
const instantSleep = () => vi.fn(async (_ms: number) => undefined);

describe('nextOffsetFromRange', () => {
  it('parses Google’s Range header into the next byte to send', () => {
    expect(nextOffsetFromRange('bytes=0-8388607')).toBe(8 * MiB);
    expect(nextOffsetFromRange('bytes=0-0')).toBe(1);
    expect(nextOffsetFromRange(null)).toBe(0);
    expect(nextOffsetFromRange('garbage')).toBe(0);
  });
});

describe('uploadResumable', () => {
  it('sends 8 MiB chunks with exact Content-Range headers and returns the Drive file', async () => {
    const total = 20 * MiB + 123;
    const drive = fakeDrive(total);
    const progress: number[] = [];
    const file = await uploadResumable(SESSION, blobOf(total), {
      fetchImpl: drive.fetchImpl,
      sleep: instantSleep(),
      onProgress: (sent) => progress.push(sent),
    });
    expect(file).toEqual({ id: 'file-1', name: 'Show.webm', webViewLink: 'https://drive.google.com/file/d/file-1/view' });
    expect(drive.calls.map((c) => c.range)).toEqual([
      `bytes 0-${8 * MiB - 1}/${total}`,
      `bytes ${8 * MiB}-${16 * MiB - 1}/${total}`,
      `bytes ${16 * MiB}-${total - 1}/${total}`,
    ]);
    expect(drive.calls.every((c) => c.method === 'PUT')).toBe(true);
    expect(drive.calls[0].bodySize).toBe(DRIVE_CHUNK_BYTES);
    expect(progress).toEqual([0, 8 * MiB, 16 * MiB, total]);
  });

  it('rounds the chunk size to a 256 KiB multiple (Drive rejects anything else)', async () => {
    const total = 1 * MiB;
    const drive = fakeDrive(total);
    await uploadResumable(SESSION, blobOf(total), { fetchImpl: drive.fetchImpl, chunkSize: 300 * 1024, sleep: instantSleep() });
    expect(drive.calls[0].bodySize).toBe(256 * 1024);
    expect(drive.calls).toHaveLength(4);
  });

  it('a small file goes up in one PUT', async () => {
    const drive = fakeDrive(5000);
    const file = await uploadResumable(SESSION, blobOf(5000), { fetchImpl: drive.fetchImpl, sleep: instantSleep() });
    expect(file.id).toBe('file-1');
    expect(drive.calls.map((c) => c.range)).toEqual(['bytes 0-4999/5000']);
  });

  it('after a network drop it asks Google for its offset (bytes */total) and resumes there', async () => {
    const total = 20 * MiB;
    // call 0: chunk 1 ok; call 1: chunk 2 fails; call 2: status probe; call 3: chunk 2 again; call 4: chunk 3
    const drive = fakeDrive(total, [null, 'network']);
    const sleep = instantSleep();
    const file = await uploadResumable(SESSION, blobOf(total), { fetchImpl: drive.fetchImpl, sleep });
    expect(file.id).toBe('file-1');
    expect(drive.calls.map((c) => c.range)).toEqual([
      `bytes 0-${8 * MiB - 1}/${total}`,
      `bytes ${8 * MiB}-${16 * MiB - 1}/${total}`,
      `bytes */${total}`,
      `bytes ${8 * MiB}-${16 * MiB - 1}/${total}`,
      `bytes ${16 * MiB}-${total - 1}/${total}`,
    ]);
    expect(drive.calls[2].bodySize).toBe(0);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('never re-sends bytes Google already stored when only the response was lost', async () => {
    const total = 16 * MiB + 10;
    const drive = fakeDrive(total, [null, 'lost']);
    await uploadResumable(SESSION, blobOf(total), { fetchImpl: drive.fetchImpl, sleep: instantSleep() });
    expect(drive.calls.map((c) => c.range)).toEqual([
      `bytes 0-${8 * MiB - 1}/${total}`,
      `bytes ${8 * MiB}-${16 * MiB - 1}/${total}`,
      `bytes */${total}`,
      `bytes ${16 * MiB}-${total - 1}/${total}`,
    ]);
  });

  it('continues from the Range Google reports when it kept only part of a chunk', async () => {
    const total = 10 * MiB;
    const drive = fakeDrive(total, ['partial']);
    await uploadResumable(SESSION, blobOf(total), { fetchImpl: drive.fetchImpl, sleep: instantSleep() });
    expect(drive.calls[1].range).toBe(`bytes ${256 * 1024}-${256 * 1024 + 8 * MiB - 1}/${total}`);
    expect(drive.stored()).toBe(total);
  });

  it('backs off on 5xx (honoring Retry-After) and on 429, then resumes', async () => {
    const total = 9 * MiB;
    const drive = fakeDrive(total, [503, null, 429]);
    const sleep = instantSleep();
    const file = await uploadResumable(SESSION, blobOf(total), { fetchImpl: drive.fetchImpl, sleep });
    expect(file.id).toBe('file-1');
    expect(sleep.mock.calls[0][0]).toBe(2000); // Retry-After: 2
    expect(drive.calls.filter((c) => c.range === `bytes */${total}`)).toHaveLength(2);
  });

  it('gives up with a network error after too many consecutive failures', async () => {
    const drive = fakeDrive(MiB, ['network', 'network', 'network', 'network']);
    await expect(
      uploadResumable(SESSION, blobOf(MiB), { fetchImpl: drive.fetchImpl, sleep: instantSleep(), maxRetries: 3 }),
    ).rejects.toMatchObject({ code: 'network' });
  });

  it('waits out an offline period without spending retries', async () => {
    const total = 9 * MiB;
    const drive = fakeDrive(total, [null, 'network']);
    // offline when the drop happens and on the first re-check, then back online
    const isOnline = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true);
    const sleep = instantSleep();
    const file = await uploadResumable(SESSION, blobOf(total), { fetchImpl: drive.fetchImpl, sleep, maxRetries: 0, isOnline });
    expect(file.id).toBe('file-1');
    expect(sleep).toHaveBeenCalledWith(2000, undefined);
    expect(drive.calls[2].range).toBe(`bytes */${total}`);
  });

  it('stops with session_expired on 404 and quota on 403 storageQuotaExceeded', async () => {
    const expired = fakeDrive(9 * MiB, [null, 404]);
    await expect(uploadResumable(SESSION, blobOf(9 * MiB), { fetchImpl: expired.fetchImpl, sleep: instantSleep() })).rejects.toMatchObject({
      code: 'session_expired',
    });
    const full = fakeDrive(9 * MiB, ['quota']);
    const err = await uploadResumable(SESSION, blobOf(9 * MiB), { fetchImpl: full.fetchImpl, sleep: instantSleep() }).catch((e) => e);
    expect(err).toBeInstanceOf(DriveError);
    expect(err.code).toBe('quota');
    expect(err.message).toMatch(/Drive is full/);
  });

  it('reports stalled instead of looping forever when Google never acknowledges bytes', async () => {
    const drive = fakeDrive(9 * MiB, Array(20).fill('noRange'));
    // The simulator stores the chunk but hides the Range header → looks like zero progress.
    drive.fetchImpl.mockImplementation(async () => resp(308) as unknown as Response);
    await expect(
      uploadResumable(SESSION, blobOf(9 * MiB), { fetchImpl: drive.fetchImpl, sleep: instantSleep(), maxRetries: 2 }),
    ).rejects.toMatchObject({ code: 'stalled' });
    expect(drive.fetchImpl.mock.calls.length).toBe(3);
  });

  it('aborts promptly and tells Google to drop the partial upload', async () => {
    const total = 20 * MiB;
    const drive = fakeDrive(total);
    const ac = new AbortController();
    const err = await uploadResumable(SESSION, blobOf(total), {
      fetchImpl: drive.fetchImpl,
      sleep: instantSleep(),
      signal: ac.signal,
      onProgress: (sent) => {
        if (sent >= 8 * MiB) ac.abort();
      },
    }).catch((e) => e);
    expect(err).toMatchObject({ code: 'aborted' });
    await new Promise((r) => setTimeout(r, 0));
    expect(drive.calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(drive.calls.filter((c) => c.method === 'PUT')).toHaveLength(1);
  });
});

describe('errorFromApi', () => {
  it('maps the backend contract to specific errors', () => {
    expect(errorFromApi(404, { error: 'not_connected' }).code).toBe('not_connected');
    expect(errorFromApi(409, { error: 'reconnect' }).code).toBe('reconnect');
    expect(errorFromApi(403, { error: 'quota_exceeded' }).code).toBe('quota');
    expect(errorFromApi(429, { error: { code: 'RATE_LIMITED' } }).code).toBe('rate_limited');
    expect(errorFromApi(401, { error: { message: 'Invalid or expired token' } }).code).toBe('signed_out');
    expect(errorFromApi(404, { error: { message: 'Connectors are disabled' } }).code).toBe('unavailable');
    expect(errorFromApi(400, { error: { message: 'x', code: 'no_credentials' } }).code).toBe('unavailable');
    expect(errorFromApi(400, { error: 'bad_request', message: 'Only video or audio…' }).message).toBe('Only video or audio…');
    expect(errorFromApi(502, { error: 'drive_unavailable' }).code).toBe('server');
  });
});

describe('saveRecordingToDrive (backend session + browser upload)', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    resetDriveStatus();
    vi.mocked(accessToken).mockResolvedValue('supabase-jwt');
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('opens the session with the user’s bearer token, then uploads straight to Google', async () => {
    const total = 3 * MiB;
    const drive = fakeDrive(total);
    const apiCalls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
      apiCalls.push({ url: String(url), init });
      return resp(200, { ok: true, uploadUrl: SESSION, folderId: 'fold', folderUrl: 'https://drive.google.com/drive/folders/fold' }) as unknown as Response;
    }) as typeof fetch;

    const saved = await saveRecordingToDrive(blobOf(total), 'Show.webm', { fetchImpl: drive.fetchImpl, sleep: instantSleep(), mimeType: 'video/webm;codecs=vp9' });

    expect(apiCalls).toHaveLength(1);
    expect(apiCalls[0].url).toMatch(/\/api\/connectors\/drive\/upload-session$/);
    expect((apiCalls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer supabase-jwt');
    expect(JSON.parse(String(apiCalls[0].init.body))).toEqual({ name: 'Show.webm', mimeType: 'video/webm;codecs=vp9', size: total });
    // The recording bytes went to Google, never to our API.
    expect(drive.calls[0].bodySize).toBe(total);
    expect(saved).toMatchObject({ id: 'file-1', webViewLink: 'https://drive.google.com/file/d/file-1/view', folderUrl: 'https://drive.google.com/drive/folders/fold' });
  });

  it('surfaces not connected / reconnect / quota from the backend', async () => {
    for (const [status, body, code] of [
      [404, { error: 'not_connected' }, 'not_connected'],
      [409, { error: 'reconnect' }, 'reconnect'],
      [403, { error: 'quota_exceeded' }, 'quota'],
    ] as const) {
      globalThis.fetch = vi.fn(async () => resp(status, body) as unknown as Response) as typeof fetch;
      await expect(saveRecordingToDrive(blobOf(10), 'a.webm', { sleep: instantSleep() })).rejects.toMatchObject({ code });
    }
  });

  it('needs a DreamStream sign-in', async () => {
    vi.mocked(accessToken).mockResolvedValue(null);
    await expect(saveRecordingToDrive(blobOf(10), 'a.webm')).rejects.toMatchObject({ code: 'signed_out' });
  });
});

describe('getDriveStatus', () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => resetDriveStatus());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('reads the connection and caches it', async () => {
    vi.mocked(accessToken).mockResolvedValue('jwt');
    const f = vi.fn(async () => resp(200, { ok: true, connected: true, configured: true, email: 'me@x.com', expired: false }) as unknown as Response);
    globalThis.fetch = f as unknown as typeof fetch;
    const s = await getDriveStatus();
    expect(s).toMatchObject({ signedIn: true, available: true, connected: true, expired: false, email: 'me@x.com' });
    await getDriveStatus();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('is signed-out (no API call) without a session, and never throws when offline', async () => {
    vi.mocked(accessToken).mockResolvedValue(null);
    const f = vi.fn();
    globalThis.fetch = f as unknown as typeof fetch;
    expect(await getDriveStatus({ force: true })).toMatchObject({ signedIn: false, connected: false });
    expect(f).not.toHaveBeenCalled();

    vi.mocked(accessToken).mockResolvedValue('jwt');
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    expect(await getDriveStatus({ force: true })).toMatchObject({ connected: false, error: 'network' });
  });
});
