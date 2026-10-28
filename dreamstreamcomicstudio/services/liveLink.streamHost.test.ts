// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://stream.dreamstreamstudio.ai/#/settings" }
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ token: 'access-1' as string | null }));
vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: h.token ? { access_token: h.token } : null } }) } },
}));

const { continueWithDreamStream, linkNav, mainAppUrl, onStreamHost, openLiveApp, openMainApp, resetCrossing } = await import('./liveLink');
const { PENDING_SIGN_IN_KEY, consumeSignInIntent } = await import('./pendingSignIn');

const APP = 'https://dreamstreamstudio.ai';
const went: string[] = [];
const fetchMock = vi.fn();

beforeEach(() => {
  resetCrossing();
  h.token = 'access-1';
  went.length = 0;
  linkNav.assign = (u) => void went.push(u);
  linkNav.replace = (u) => void went.push(u);
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true, url: `${APP}/auth/callback?token_hash=t&type=magiclink&next=%2F%3Fview%3Dchat` }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('on the Stream Studio host', () => {
  it('knows where it is, and links to DreamStream pages absolutely', () => {
    expect(onStreamHost()).toBe(true);
    expect(mainAppUrl('/?view=privacy')).toBe(`${APP}/?view=privacy`);
    expect(mainAppUrl()).toBe(`${APP}/`);
  });

  it('opens DreamStream signed in (handoff), or plainly when signed out', async () => {
    resetCrossing();
    await openMainApp('/?view=chat', { on: true });
    expect(went).toEqual([`${APP}/auth/callback?token_hash=t&type=magiclink&next=%2F%3Fview%3Dchat`]);
    expect(JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body))).toEqual({ to: 'main', path: '/?view=chat' });
    h.token = null;
    resetCrossing();
    await openMainApp('/?view=chat', { on: true });
    expect(went[1]).toBe(`${APP}/?view=chat`);
    // A handoff answer pointing anywhere but the main app is ignored.
    h.token = 'access-1';
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, url: 'https://stream.dreamstreamstudio.ai.evil.com/' }), { status: 200 }));
    resetCrossing();
    await openMainApp('/', { on: true });
    expect(went[2]).toBe(`${APP}/`);
    // Before the switch the host is only being checked: plain links, no handoff request.
    fetchMock.mockClear();
    resetCrossing();
    await openMainApp('/?view=chat', { on: false });
    expect(went[3]).toBe(`${APP}/?view=chat`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Stream Studio links stay in this app (no handoff to itself)', async () => {
    resetCrossing();
    await openLiveApp('/live#/monitor', { on: true });
    expect(went).toEqual(['https://stream.dreamstreamstudio.ai/#/monitor']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('"Continue with DreamStream" starts the sign-in HERE (the host the handoff returns to) and carries only the screen and that nonce back', () => {
    localStorage.clear();
    continueWithDreamStream('settings');
    const [first] = JSON.parse(localStorage.getItem(PENDING_SIGN_IN_KEY) || '[]') as { nonce: string; kind: string }[];
    expect(first).toMatchObject({ kind: 'handoff' });
    continueWithDreamStream('');
    const [, second] = JSON.parse(localStorage.getItem(PENDING_SIGN_IN_KEY) || '[]') as { nonce: string; kind: string }[];
    expect(second.nonce).not.toBe(first.nonce);
    expect(went).toEqual([
      `${APP}/?next=${encodeURIComponent(`https://stream.dreamstreamstudio.ai/?sn=${first.nonce}#/settings`)}`,
      `${APP}/?next=${encodeURIComponent(`https://stream.dreamstreamstudio.ai/?sn=${second.nonce}`)}`,
    ]);
    // DreamStream hands the nonce to /api/auth/handoff, which echoes it into the link: back here,
    // that link — and only that link — completes without asking.
    expect(consumeSignInIntent(`https://stream.dreamstreamstudio.ai/?token_hash=h&type=magiclink&sn=${second.nonce}&after=settings`)).toBe(true);
    expect(consumeSignInIntent('https://stream.dreamstreamstudio.ai/?token_hash=h&type=magiclink&after=settings')).toBe(false);
  });
});
