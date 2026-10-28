// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://stream.dreamstreamstudio.ai/" }
// Auth emails asked for on Stream Studio's own host: a sign-in intent is recorded only where the
// link will LAND. A password-reset link always opens on the main app (its own origin, its own
// storage), so recording it here would only leave a standing pass on this host.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STREAM_HOST_ON } from '../shared/streamHost';
import { authLinkLandsHere, requestAuthEmail } from './authEmail';
import { hasFreshSignInIntent } from './pendingSignIn';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
});
afterEach(() => vi.unstubAllGlobals());

describe('on stream.dreamstreamstudio.ai', () => {
  it('a password reset (a main-app link) records no intent here', async () => {
    expect(await requestAuthEmail('recovery', { email: 'a@b.co', app: 'main' })).toEqual({ status: 'ok', data: { ok: true } });
    expect(hasFreshSignInIntent()).toBe(false);
  });

  it('a Stream Studio sign-up confirmation records one here only once the host is live (STREAM_HOST_ON); before the flip its links open on the apex', async () => {
    await requestAuthEmail('signup', { email: 'a@b.co', app: 'live', after: 'monitor' });
    expect(hasFreshSignInIntent()).toBe(STREAM_HOST_ON);
    expect(authLinkLandsHere('live', location.hostname, true)).toBe(true);
  });
});

describe('authLinkLandsHere — where each kind of link opens', () => {
  it('main-app links land on the main origin; Stream Studio links follow the switch', () => {
    const main = 'dreamstreamstudio.ai';
    const stream = 'stream.dreamstreamstudio.ai';
    expect(authLinkLandsHere('main', main, false)).toBe(true);
    expect(authLinkLandsHere('main', main, true)).toBe(true);
    expect(authLinkLandsHere('main', stream, false)).toBe(false);
    expect(authLinkLandsHere('main', stream, true)).toBe(false);
    // Switch off: Stream Studio lives at /live on the apex.
    expect(authLinkLandsHere('live', main, false)).toBe(true);
    // Switch on: its links open on its own host.
    expect(authLinkLandsHere('live', main, true)).toBe(false);
    expect(authLinkLandsHere('live', stream, true)).toBe(true);
    // Switch off, on the (pre-flip) Stream Studio host: its links still open on the apex.
    expect(authLinkLandsHere('live', stream, false)).toBe(false);
    // No app named = the main app.
    expect(authLinkLandsHere(undefined, stream, false)).toBe(false);
    expect(authLinkLandsHere(undefined, main, false)).toBe(true);
  });
});
