import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ token: 'access-1' as string | null }));
vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: h.token ? { access_token: h.token } : null } }) } },
}));

const { followLiveLink, linkNav, liveAppUrl, mainAppUrl, openLiveApp, requestHandoff } = await import('./liveLink');

const STREAM = 'https://stream.dreamstreamstudio.ai';
const went: string[] = [];
const fetchMock = vi.fn();

beforeEach(() => {
  h.token = 'access-1';
  went.length = 0;
  linkNav.assign = (u) => void went.push(`assign ${u}`);
  linkNav.replace = (u) => void went.push(`replace ${u}`);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { to: string; path?: string };
    const after = body.path?.replace('#/', '') || '';
    return new Response(JSON.stringify({ ok: true, url: `${STREAM}/?token_hash=t&type=magiclink${after ? `&after=${after}` : ''}` }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('links to Stream Studio from DreamStream', () => {
  it('switch off: the same /live… links as before, no handoff', async () => {
    expect(liveAppUrl('/live.html', false)).toBe('/live.html');
    expect(liveAppUrl('/live#/monitor', false)).toBe('/live#/monitor');
    await openLiveApp('/live.html', { on: false });
    await openLiveApp('/live.html', { on: false, replace: true });
    expect(went).toEqual(['assign /live.html', 'replace /live.html']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('switch on, signed in: arrives signed in, on the right screen', async () => {
    await openLiveApp('/live#/monitor', { on: true });
    expect(went).toEqual([`assign ${STREAM}/?token_hash=t&type=magiclink&after=monitor`]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/auth\/handoff$/);
    expect(JSON.parse(String(init.body))).toEqual({ to: 'live', path: '#/monitor' });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer access-1');
    await openLiveApp('/live.html', { on: true, replace: true });
    expect(went[1]).toBe(`replace ${STREAM}/?token_hash=t&type=magiclink`);
  });

  it('switch on, signed out / refused / odd answer: the plain new address', async () => {
    h.token = null;
    await openLiveApp('/live#/settings', { on: true });
    expect(fetchMock).not.toHaveBeenCalled();
    h.token = 'access-1';
    fetchMock.mockResolvedValueOnce(new Response('{"ok":false}', { status: 429 }));
    await openLiveApp('/live', { on: true });
    // Never follow a link to anywhere but Stream Studio.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, url: 'https://evil.example/' }), { status: 200 }));
    await openLiveApp('/live', { on: true });
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    await openLiveApp('/live', { on: true });
    expect(went).toEqual([`assign ${STREAM}/#/settings`, `assign ${STREAM}/`, `assign ${STREAM}/`, `assign ${STREAM}/`]);
  });

  it('a link that carries more than a screen (a viewer link) goes plain', async () => {
    await openLiveApp('/live.html?e=evt_1', { on: true });
    await openLiveApp('/live#/monitor/abc/watch', { on: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(went).toEqual([`assign ${STREAM}/?e=evt_1`, `assign ${STREAM}/#/monitor/abc/watch`]);
  });

  it('gives up on a slow backend and uses the plain link', async () => {
    fetchMock.mockImplementationOnce((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    expect(await requestHandoff('live', '', 20)).toBeNull();
  });

  it('followLiveLink: plain clicks hand over, new-tab clicks keep the browser’s behaviour', async () => {
    const click = (init: Partial<{ button: number; metaKey: boolean }>) => {
      const e = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false, preventDefault: vi.fn(), ...init };
      followLiveLink(e as unknown as React.MouseEvent<HTMLElement>, '/live', true);
      return e.preventDefault;
    };
    expect(click({ metaKey: true })).not.toHaveBeenCalled();
    expect(click({ button: 1 })).not.toHaveBeenCalled();
    expect(click({})).toHaveBeenCalled();
    await vi.waitFor(() => expect(went).toEqual([`assign ${STREAM}/?token_hash=t&type=magiclink`]));
    const off = { button: 0, preventDefault: vi.fn() };
    followLiveLink(off as unknown as React.MouseEvent<HTMLElement>, '/live', false);
    expect(off.preventDefault).not.toHaveBeenCalled();
  });

  it('main-app paths stay relative on the main app', () => {
    expect(mainAppUrl('/?view=privacy')).toBe('/?view=privacy');
    expect(mainAppUrl('?view=terms')).toBe('/?view=terms');
  });
});
