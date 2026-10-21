// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../connectors/store.js', () => ({
  getActiveConnection: vi.fn(),
  listConnections: vi.fn(),
  deleteConnection: vi.fn(),
  loadCredentials: vi.fn(),
  setConnectionStatus: vi.fn(),
  updateConnectionMetadata: vi.fn(),
  upsertCatalog: vi.fn()
}));
vi.mock('../connectors/credentials.js', () => ({
  getValidAccessToken: vi.fn()
}));

import { driveSaveRouter, trustedBrowserOrigin } from './connectorsDrive.js';
import { connectorsRouter } from './connectors.js';
import * as store from '../connectors/store.js';
import * as credentials from '../connectors/credentials.js';
import { connectorRegistry } from '../connectors/index.js';
import { GoogleDriveSaveConnector, DRIVE_FILE_SCOPE } from '../connectors/connectors/googleDriveSave.js';
import { sanitizeDriveFileName, validateUploadRequest, MAX_DRIVE_UPLOAD_BYTES } from '../connectors/driveSave.js';

const TOKEN = 'ya29.SECRET-ACCESS-TOKEN';
const DRIVE_FILES_Q = 'https://www.googleapis.com/drive/v3/files?';
const SESSION_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=ABC123';

// ---- harness -----------------------------------------------------------------

/** The final (business) handler of a route — skips the rate limiter in front of it. */
const handler = (method: 'get' | 'post', path: string) => {
  const layer = (driveSaveRouter as unknown as { stack: any[] }).stack.find(
    (l) => l.route?.path === path && l.route.methods[method]
  );
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${path}`);
  const stack = layer.route.stack;
  return stack[stack.length - 1].handle as (req: any, res: any, next: any) => Promise<void>;
};

const mockReq = (body: unknown, headers: Record<string, string> = {}, userId: string | null = 'u1') => {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { body, user: userId ? { id: userId } : undefined, get: (k: string) => h[k.toLowerCase()] } as any;
};

const mockRes = () => {
  const res: any = { statusCode: 200, body: undefined as any, headers: {} as Record<string, string> };
  res.status = (c: number) => {
    res.statusCode = c;
    return res;
  };
  res.json = (b: unknown) => {
    res.body = b;
    return res;
  };
  res.set = (k: string, v: string) => {
    res.headers[k] = v;
    return res;
  };
  return res;
};

const call = async (method: 'get' | 'post', path: string, req: any) => {
  const res = mockRes();
  const next = vi.fn();
  await handler(method, path)(req, res, next);
  if (next.mock.calls.length) throw next.mock.calls[0][0];
  return res;
};

const conn = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: 'conn-1',
    user_id: 'u1',
    connector_id: 'google_drive_save',
    status: 'connected',
    auth_type: 'user_oauth',
    account_identifier: 'maker@example.com',
    account_label: 'Maker',
    granted_scopes: [DRIVE_FILE_SCOPE, 'https://www.googleapis.com/auth/userinfo.email'],
    last_error: null,
    metadata: {},
    last_sync_at: null,
    created_at: '',
    updated_at: '',
    ...over
  }) as any;

const gRes = (body: unknown, status = 200, headers: Record<string, string> = {}) => {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => h[k.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body
  } as unknown as Response;
};

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

/** Fake Google: Drive search/create/get + the resumable-session endpoint. */
const installGoogle = (opts: { existingFolder?: string; cachedValid?: boolean; initStatus?: number; initBody?: unknown } = {}) => {
  const calls: Call[] = [];
  global.fetch = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = (init.method || 'GET').toUpperCase();
    const headers = { ...(init.headers || {}) } as Record<string, string>;
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, headers, body });
    if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files')) {
      const status = opts.initStatus ?? 200;
      return status === 200 ? gRes('', 200, { Location: SESSION_URL }) : gRes(opts.initBody ?? '', status);
    }
    if (method === 'GET' && /\/drive\/v3\/files\/[^?]+/.test(url)) {
      return opts.cachedValid ? gRes({ id: 'cached-folder', trashed: false }) : gRes({ error: { message: 'File not found' } }, 404);
    }
    if (method === 'GET' && url.startsWith('https://www.googleapis.com/drive/v3/files?')) {
      return gRes({ files: opts.existingFolder ? [{ id: opts.existingFolder }] : [] });
    }
    if (method === 'POST' && url.startsWith('https://www.googleapis.com/drive/v3/files?')) {
      return gRes({ id: 'new-folder' });
    }
    return gRes('unexpected', 500);
  }) as any;
  return calls;
};

const goodBody = { name: 'My stream.webm', mimeType: 'video/webm;codecs=vp9,opus', size: 50 * 1024 * 1024 };
const browser = { Origin: 'https://dreamstreamstudio.ai' };

beforeEach(() => {
  vi.clearAllMocks();
  (store.updateConnectionMetadata as any).mockResolvedValue(undefined);
  (store.setConnectionStatus as any).mockResolvedValue(undefined);
  (credentials.getValidAccessToken as any).mockResolvedValue(TOKEN);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ---- tests -------------------------------------------------------------------

describe('google_drive_save connector', () => {
  it('is registered, in the google group, and asks for drive.file only (never broad Drive)', () => {
    const c = connectorRegistry.get('google_drive_save');
    expect(c).toBeInstanceOf(GoogleDriveSaveConnector);
    expect(c!.metadata.providerGroup).toBe('google');
    expect(c!.metadata.requiredScopes).toContain(DRIVE_FILE_SCOPE);
    expect(c!.metadata.requiredScopes.filter((s) => /\/auth\/drive/.test(s))).toEqual([DRIVE_FILE_SCOPE]);
    expect(c!.metadata.capabilities.syncable).toBe(false);
  });

  it('leaves the read-only Drive connector unchanged', () => {
    expect(connectorRegistry.get('google_drive')!.metadata.requiredScopes).toContain('https://www.googleapis.com/auth/drive.readonly');
  });

  it('treats a grant without drive.file as unable to write', () => {
    expect(GoogleDriveSaveConnector.hasWriteScope([DRIVE_FILE_SCOPE])).toBe(true);
    expect(GoogleDriveSaveConnector.hasWriteScope(['https://www.googleapis.com/auth/userinfo.email'])).toBe(false);
    expect(GoogleDriveSaveConnector.hasWriteScope(null)).toBe(false);
  });

  it('is mounted under /drive in the authenticated connectors router', () => {
    const mounted = (connectorsRouter as any).stack.some((l: any) => !l.route && l.handle === driveSaveRouter);
    expect(mounted).toBe(true);
  });
});

describe('upload request validation', () => {
  it('sanitizes names: path chars, control chars, leading dots, length', () => {
    expect(sanitizeDriveFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeDriveFileName('a\u0000b\nc.webm')).toBe('abc.webm');
    expect(sanitizeDriveFileName('C:\\rec?.mp4')).toBe('C__rec_.mp4');
    const long = sanitizeDriveFileName(`${'x'.repeat(300)}.webm`);
    expect(long.length).toBe(120);
    expect(long.endsWith('.webm')).toBe(true);
  });

  it('accepts only video/* or audio/* and strips codec params', () => {
    expect(validateUploadRequest(goodBody)).toMatchObject({ ok: true, mimeType: 'video/webm' });
    expect(validateUploadRequest({ ...goodBody, mimeType: 'audio/ogg' })).toMatchObject({ ok: true });
    for (const bad of ['application/pdf', 'text/html', 'video', '', 'image/png']) {
      expect(validateUploadRequest({ ...goodBody, mimeType: bad })).toMatchObject({ ok: false, field: 'mimeType' });
    }
  });

  it('bounds size to 1 byte … 20 GB', () => {
    expect(validateUploadRequest({ ...goodBody, size: 0 })).toMatchObject({ ok: false, field: 'size' });
    expect(validateUploadRequest({ ...goodBody, size: 1.5 })).toMatchObject({ ok: false, field: 'size' });
    expect(validateUploadRequest({ ...goodBody, size: '100' })).toMatchObject({ ok: false, field: 'size' });
    expect(validateUploadRequest({ ...goodBody, size: MAX_DRIVE_UPLOAD_BYTES })).toMatchObject({ ok: true });
    expect(validateUploadRequest({ ...goodBody, size: MAX_DRIVE_UPLOAD_BYTES + 1 })).toMatchObject({ ok: false, field: 'size' });
  });
});

describe('POST /drive/upload-session', () => {
  it('404 not_connected when the user has no Drive-save connection', async () => {
    (store.getActiveConnection as any).mockResolvedValue(null);
    const calls = installGoogle();
    const res = await call('post', '/upload-session', mockReq(goodBody, browser));
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toBe('not_connected');
    expect(calls).toHaveLength(0);
  });

  it('400 for a non-media mime type (before touching Google or the DB)', async () => {
    const calls = installGoogle();
    const res = await call('post', '/upload-session', mockReq({ ...goodBody, mimeType: 'application/x-msdownload' }, browser));
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request', field: 'mimeType' });
    expect(store.getActiveConnection).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it('409 reconnect when the connection expired or lacks drive.file', async () => {
    (store.getActiveConnection as any).mockResolvedValue(conn({ status: 'expired' }));
    expect((await call('post', '/upload-session', mockReq(goodBody, browser))).statusCode).toBe(409);
    (store.getActiveConnection as any).mockResolvedValue(conn({ granted_scopes: ['https://www.googleapis.com/auth/userinfo.email'] }));
    const res = await call('post', '/upload-session', mockReq(goodBody, browser));
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('reconnect');
  });

  it('happy path: creates the folder if missing, opens a resumable session with the browser Origin, never returns the token', async () => {
    (store.getActiveConnection as any).mockResolvedValue(conn());
    const calls = installGoogle();
    const res = await call('post', '/upload-session', mockReq(goodBody, browser));

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ uploadUrl: SESSION_URL, folderId: 'new-folder' });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(res.headers['Cache-Control']).toBe('no-store');

    // search → create folder → open session
    const search = calls.find((c) => c.method === 'GET' && c.url.startsWith(DRIVE_FILES_Q))!;
    const q = new URL(search.url).searchParams.get('q') || '';
    expect(q).toContain("name = 'DreamStream Recordings'");
    expect(q).toContain("mimeType = 'application/vnd.google-apps.folder'");
    expect(q).toContain('trashed = false');
    const create = calls.find((c) => c.method === 'POST' && c.url.startsWith(DRIVE_FILES_Q))!;
    expect(create.body).toMatchObject({ name: 'DreamStream Recordings', mimeType: 'application/vnd.google-apps.folder' });

    const init = calls.find((c) => c.url.startsWith('https://www.googleapis.com/upload/drive/v3/files'))!;
    expect(init.method).toBe('POST');
    expect(init.url).toContain('uploadType=resumable');
    expect(decodeURIComponent(init.url)).toContain('fields=id,name,webViewLink');
    expect(init.headers['X-Upload-Content-Type']).toBe('video/webm');
    expect(init.headers['X-Upload-Content-Length']).toBe(String(goodBody.size));
    expect(init.headers.Origin).toBe('https://dreamstreamstudio.ai');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.body).toMatchObject({ name: 'My stream.webm', parents: ['new-folder'] });

    // folder id cached on the connection for next time
    expect(store.updateConnectionMetadata).toHaveBeenCalledWith('conn-1', { recordingsFolderId: 'new-folder' });
  });

  it('reuses an existing app-created folder instead of making a duplicate', async () => {
    (store.getActiveConnection as any).mockResolvedValue(conn());
    const calls = installGoogle({ existingFolder: 'found-folder' });
    const res = await call('post', '/upload-session', mockReq(goodBody, browser));
    expect(res.body.folderId).toBe('found-folder');
    expect(calls.some((c) => c.method === 'POST' && c.url.startsWith(DRIVE_FILES_Q))).toBe(false);
  });

  it('uses the cached folder id when it is still alive (no search, no create)', async () => {
    (store.getActiveConnection as any).mockResolvedValue(conn({ metadata: { recordingsFolderId: 'cached-folder' } }));
    const calls = installGoogle({ cachedValid: true });
    const res = await call('post', '/upload-session', mockReq(goodBody, browser));
    expect(res.body.folderId).toBe('cached-folder');
    expect(calls.filter((c) => c.url.startsWith(DRIVE_FILES_Q))).toHaveLength(0);
    expect(store.updateConnectionMetadata).not.toHaveBeenCalled();
  });

  it('replaces a cached folder that was deleted', async () => {
    (store.getActiveConnection as any).mockResolvedValue(conn({ metadata: { recordingsFolderId: 'gone-folder' } }));
    installGoogle({ cachedValid: false });
    const res = await call('post', '/upload-session', mockReq(goodBody, browser));
    expect(res.body.folderId).toBe('new-folder');
    expect(store.updateConnectionMetadata).toHaveBeenCalledWith('conn-1', { recordingsFolderId: 'new-folder' });
  });

  it('does not forward an untrusted Origin', async () => {
    (store.getActiveConnection as any).mockResolvedValue(conn());
    const calls = installGoogle();
    await call('post', '/upload-session', mockReq(goodBody, { Origin: 'https://evil.example' }));
    const init = calls.find((c) => c.url.startsWith('https://www.googleapis.com/upload/'))!;
    expect(init.headers.Origin).toBeUndefined();
  });

  it('maps Drive storageQuotaExceeded to 403 quota_exceeded', async () => {
    (store.getActiveConnection as any).mockResolvedValue(conn());
    installGoogle({ initStatus: 403, initBody: { error: { errors: [{ reason: 'storageQuotaExceeded' }], message: 'The user has exceeded their Drive storage quota' } } });
    const res = await call('post', '/upload-session', mockReq(goodBody, browser));
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('quota_exceeded');
  });

  it('maps a Google 401 to 409 reconnect and marks the connection expired', async () => {
    (store.getActiveConnection as any).mockResolvedValue(conn());
    installGoogle({ initStatus: 401 });
    const res = await call('post', '/upload-session', mockReq(goodBody, browser));
    expect(res.statusCode).toBe(409);
    expect(res.body.error).toBe('reconnect');
    expect(store.setConnectionStatus).toHaveBeenCalledWith('conn-1', 'expired', expect.any(String));
  });

  it('401 when there is no signed-in user', async () => {
    const res = await call('post', '/upload-session', mockReq(goodBody, browser, null));
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /drive/status', () => {
  it('reports not connected', async () => {
    (store.getActiveConnection as any).mockResolvedValue(null);
    const res = await call('get', '/status', mockReq(undefined));
    expect(res.body).toMatchObject({ connected: false });
  });

  it('reports the connected account + cached folder, and flags reconnect when expired', async () => {
    (store.getActiveConnection as any).mockResolvedValue(conn({ metadata: { recordingsFolderId: 'fold-er1' } }));
    const ok = await call('get', '/status', mockReq(undefined));
    expect(ok.body).toMatchObject({ connected: true, email: 'maker@example.com', expired: false, folderId: 'fold-er1', connectionId: 'conn-1' });
    (store.getActiveConnection as any).mockResolvedValue(conn({ status: 'expired' }));
    const exp = await call('get', '/status', mockReq(undefined));
    expect(exp.body).toMatchObject({ connected: true, expired: true });
  });
});

describe('POST /drive/disconnect', () => {
  it('keeps the shared Google grant alive when other Google connections use the same account', async () => {
    (store.listConnections as any).mockResolvedValue([
      conn(),
      conn({ id: 'gmail-1', connector_id: 'gmail' })
    ]);
    (store.loadCredentials as any).mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
    global.fetch = vi.fn(async () => gRes('')) as any;
    const res = await call('post', '/disconnect', mockReq({}));
    expect(res.body).toMatchObject({ ok: true, revoked: false });
    expect(store.deleteConnection).toHaveBeenCalledWith('conn-1');
    expect(store.deleteConnection).not.toHaveBeenCalledWith('gmail-1');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('revokes at Google when Drive-save was the only Google connection', async () => {
    (store.listConnections as any).mockResolvedValue([conn()]);
    (store.loadCredentials as any).mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
    global.fetch = vi.fn(async () => gRes('')) as any;
    const res = await call('post', '/disconnect', mockReq({}));
    expect(res.body).toMatchObject({ ok: true, revoked: true });
    expect(String((global.fetch as any).mock.calls[0][0])).toContain('oauth2.googleapis.com/revoke');
  });
});

describe('trustedBrowserOrigin', () => {
  const req = (h: Record<string, string>) => ({ get: (k: string) => h[k.toLowerCase()] }) as any;
  it('forwards trusted origins (incl. Referer fallback) and drops others', () => {
    expect(trustedBrowserOrigin(req({ origin: 'https://comic2.pages.dev' }))).toBe('https://comic2.pages.dev');
    expect(trustedBrowserOrigin(req({ referer: 'https://dreamstreamstudio.ai/live.html#/studio' }))).toBe('https://dreamstreamstudio.ai');
    expect(trustedBrowserOrigin(req({ origin: 'null' }))).toBeUndefined();
    expect(trustedBrowserOrigin(req({ origin: 'http://dreamstreamstudio.ai' }))).toBeUndefined();
    expect(trustedBrowserOrigin(req({}))).toBeUndefined();
  });
});
