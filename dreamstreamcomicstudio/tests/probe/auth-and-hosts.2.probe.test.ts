// @vitest-environment node
// Probe: a sign-in link asked for on the Comic Studio host (comics.dreamstreamstudio.ai).
// Sessions are per host (services/supabase.ts), the sign-in intent (nonce) is recorded on the origin
// the request came from (services/authEmail.ts authLinkLandsHere → true on comics), and the backend
// builds the emailed link from pickLinkOrigin(request Origin) with an allowlist of APP_PUBLIC_URL +
// AUTH_LINK_ORIGINS (server/src/services/authEmailLinks.ts). api-proxy/wrangler.jsonc sets
// APP_PUBLIC_URL only — AUTH_LINK_ORIGINS is not among the backend vars — so this runs with the
// shipped configuration: AUTH_LINK_ORIGINS empty.
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  vi.stubEnv('APP_PUBLIC_URL', 'https://dreamstreamstudio.ai');
  vi.stubEnv('AUTH_LINK_ORIGINS', '');
});

import { LINK_ORIGIN_ALLOWLIST, buildAuthLink, pickLinkOrigin } from '../../server/src/services/authEmailLinks.js';
import { authLinkLandsHere } from '../../services/authEmail';
import { COMICS_HOST, COMICS_ORIGIN, resolveAuthRedirectUrl } from '../../services/productHost';

describe('magic link / sign-up confirmation requested on comics.dreamstreamstudio.ai', () => {
  it('comes back to the comics host, where the per-host session and the recorded sign-in intent live', () => {
    // The SPA on the comics host: the intent IS recorded here (the link is expected to land here)…
    expect(authLinkLandsHere('main', COMICS_HOST)).toBe(true);
    // …and the client's own OAuth/redirect helper says the comics callback is the registered one.
    expect(resolveAuthRedirectUrl({ explicit: 'https://dreamstreamstudio.ai/auth/callback', hostname: COMICS_HOST, origin: COMICS_ORIGIN })).toBe(`${COMICS_ORIGIN}/auth/callback`);

    // The backend, with the request's Origin header as the edge Worker forwards it untouched:
    const origin = pickLinkOrigin(COMICS_ORIGIN);
    const link = buildAuthLink({ app: 'main', origin, hashedToken: 'hash-magiclink', verificationType: 'magiclink', signInNonce: '0123456789abcdef0123' });
    process.stderr.write(`probe auth2 ${JSON.stringify({ allowlist: LINK_ORIGIN_ALLOWLIST, origin, link })}\n`);
    // Expected: the emailed link lands on comics. Observed with the shipped config: the apex — where
    // no intent exists ("Finish signing in?") and whose session the comics host never sees.
    expect(new URL(link).origin).toBe(COMICS_ORIGIN);
  });
});
