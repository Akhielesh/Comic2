import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  token: 'jwt-1' as string | null,
  getSession: vi.fn(),
  refreshSession: vi.fn(async () => ({ data: {}, error: null })),
}));
vi.mock('./supabase', () => ({
  supabase: {
    auth: {
      getSession: auth.getSession.mockImplementation(async () => ({ data: { session: auth.token ? { access_token: auth.token } : null } })),
      refreshSession: auth.refreshSession,
    },
  },
}));

import { updateAccountName } from './accountName';
import { onAccountAccessChange } from './studioAccessApi';

const fetchMock = vi.fn();
beforeEach(() => {
  auth.token = 'jwt-1';
  auth.refreshSession.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('updateAccountName', () => {
  it('saves the cleaned name with the session token, refreshes the session and tells open views', async () => {
    fetchMock.mockResolvedValue(reply(200, { ok: true, name: 'Ada Lovelace', stream: true }));
    const changed = vi.fn();
    const off = onAccountAccessChange(changed);

    expect(await updateAccountName('  Ada   Lovelace ')).toEqual({ ok: true, name: 'Ada Lovelace', stream: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/account\/name$/);
    expect(init.method).toBe('PATCH');
    expect(init.headers.authorization).toBe('Bearer jwt-1');
    expect(JSON.parse(init.body)).toEqual({ name: 'Ada Lovelace' });
    expect(auth.refreshSession).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    off();
  });

  it('checks the name before calling the server', async () => {
    expect(await updateAccountName('   ')).toEqual({ ok: false, error: 'Add your name (1–40 characters).' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('needs a session', async () => {
    auth.token = null;
    expect(await updateAccountName('Ada')).toEqual({ ok: false, error: 'Sign in to change your name.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the server’s message, and an honest one when the reply is not the API (e.g. an app shell)', async () => {
    fetchMock.mockResolvedValueOnce(reply(400, { error: { message: 'Add your name (1–40 characters).' } }));
    expect(await updateAccountName('Ada')).toEqual({ ok: false, error: 'Add your name (1–40 characters).' });
    fetchMock.mockResolvedValueOnce(new Response('<!doctype html><div id="root"></div>', { status: 200 }));
    expect(await updateAccountName('Ada')).toEqual({ ok: false, error: 'Couldn’t save your name right now — try again.' });
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect((await updateAccountName('Ada')).ok).toBe(false);
    expect(auth.refreshSession).not.toHaveBeenCalled();
  });
});
