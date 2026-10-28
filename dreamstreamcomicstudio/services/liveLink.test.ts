import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ token: 'access-1' as string | null }));
vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: h.token ? { access_token: h.token } : null } }) } },
}));

const { followLiveLink, linkNav, liveAppUrl, mainAppUrl, openLiveApp, requestHandoff, resetCrossing } = await import('./liveLink');

const STREAM = 'https://stream.dreamstreamstudio.ai';
const went: string[] = [];
const fetchMock = vi.fn();

beforeEach(() => {
  resetCrossing();
  h.token = 'access-1';
  went.length = 0;
  linkNav.assign = (u) => void went.push(`assign ${u}`);
  linkNav.replace = (u) => void went.push(`replace ${u}`);
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { to: string; path?: string; sn?: string };
    const after = body.path?.replace('#/', '') || '';
    // Like the route: the receiving app's nonce is echoed into the link.
    return new Response(JSON.stringify({ ok: true, url: `${STREAM}/?token_hash=t&type=magiclink${body.sn ? `&sn=${body.sn}` : ''}${after ? `&after=${after}` : ''}` }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('links to Stream Studio from DreamStream', () => {
  it('switch off: the same /live… links as before, no handoff', async () => {
    expect(liveAppUrl('/live.html', false)).toBe('/live.html');
    expect(liveAppUrl('/live#/monitor', false)).toBe('/live#/monitor');
    resetCrossing();
    await openLiveApp('/live.html', { on: false });
    resetCrossing();
    await openLiveApp('/live.html', { on: false, replace: true });
    expect(went).toEqual(['assign /live.html', 'replace /live.html']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('one crossing per page: a second open while the first is loading shares it (each handoff cancels the last)', async () => {
    resetCrossing();
    // Regression: the hand-back and the Stream-only redirect (or a double click) both asked for a
    // handoff; the second link cancelled the first, which then failed as "already used".
    await Promise.all([openLiveApp('/live#/monitor', { on: true }), openLiveApp('/live.html', { on: true, replace: true })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(went).toEqual([`assign ${STREAM}/?token_hash=t&type=magiclink&after=monitor`]);
    // Still loading the first a moment later: nothing new either.
    await openLiveApp('/live', { on: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('switch on, signed in: arrives signed in, on the right screen', async () => {
    resetCrossing();
    await openLiveApp('/live#/monitor', { on: true });
    expect(went).toEqual([`assign ${STREAM}/?token_hash=t&type=magiclink&after=monitor`]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/auth\/handoff$/);
    expect(JSON.parse(String(init.body))).toEqual({ to: 'live', path: '#/monitor' });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer access-1');
    resetCrossing();
    await openLiveApp('/live.html', { on: true, replace: true });
    expect(went[1]).toBe(`replace ${STREAM}/?token_hash=t&type=magiclink`);
  });

  it('switch on, signed out / refused / odd answer: the plain new address', async () => {
    h.token = null;
    resetCrossing();
    await openLiveApp('/live#/settings', { on: true });
    expect(fetchMock).not.toHaveBeenCalled();
    h.token = 'access-1';
    fetchMock.mockResolvedValueOnce(new Response('{"ok":false}', { status: 429 }));
    resetCrossing();
    await openLiveApp('/live', { on: true });
    // Never follow a link to anywhere but Stream Studio.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, url: 'https://evil.example/' }), { status: 200 }));
    resetCrossing();
    await openLiveApp('/live', { on: true });
    fetchMock.mockRejectedValueOnce(new Error('offline'));
    resetCrossing();
    await openLiveApp('/live', { on: true });
    expect(went).toEqual([`assign ${STREAM}/#/settings`, `assign ${STREAM}/`, `assign ${STREAM}/`, `assign ${STREAM}/`]);
  });

  it('a link that carries more than a screen (a viewer link) goes plain', async () => {
    resetCrossing();
    await openLiveApp('/live.html?e=evt_1', { on: true });
    resetCrossing();
    await openLiveApp('/live#/monitor/abc/watch', { on: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(went).toEqual([`assign ${STREAM}/?e=evt_1`, `assign ${STREAM}/#/monitor/abc/watch`]);
  });

  it('a handoff leaves no sign-in intent on the sending origin (it would wave through any link opened here)', async () => {
    localStorage.clear();
    resetCrossing();
    await openLiveApp('/live#/monitor', { on: true, replace: true });
    expect(went).toEqual([`replace ${STREAM}/?token_hash=t&type=magiclink&after=monitor`]);
    expect(localStorage.getItem('ds.pendingSignIn')).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, url: 'https://evil.example/?token_hash=t' }), { status: 200 }));
    expect(await requestHandoff('live', '')).toBeNull();
    expect(localStorage.getItem('ds.pendingSignIn')).toBeNull();
  });

  it('the hand-back from Stream Studio ("Continue with DreamStream") carries that host’s nonce into the handoff, so it completes there without asking; the plain fallback drops it', async () => {
    const sn = 'c0ffee00-1111-4222-8333-444455556666';
    resetCrossing();
    await openLiveApp(`${STREAM}/?sn=${sn}#/monitor`, { on: true, replace: true });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ to: 'live', path: '#/monitor', sn });
    expect(went).toEqual([`replace ${STREAM}/?token_hash=t&type=magiclink&sn=${sn}&after=monitor`]);
    // Signed out here: the plain address, without the nonce (nothing to complete).
    h.token = null;
    resetCrossing();
    await openLiveApp(`${STREAM}/?sn=${sn}#/monitor`, { on: true });
    expect(went[1]).toBe(`assign ${STREAM}/#/monitor`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Something that only looks like a nonce is neither sent nor kept.
    h.token = 'access-1';
    resetCrossing();
    await openLiveApp(`${STREAM}/?sn=${encodeURIComponent('<script>')}`, { on: true });
    expect(JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body))).toEqual({ to: 'live' });
    expect(went[2]).toBe(`assign ${STREAM}/?token_hash=t&type=magiclink`);
    // No sign-in intent is recorded on THIS origin by any of it.
    expect(localStorage.getItem('ds.pendingSignIn')).toBeNull();
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
