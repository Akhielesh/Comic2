// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://stream.dreamstreamstudio.ai/" }
// Stream Studio on its own host: the app lives at '/', so its links, sign-in returns, alert
// worker scope and manifest follow (live/host.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { verifyOtp } = vi.hoisted(() => ({ verifyOtp: vi.fn() }));
vi.mock('@/services/supabase', () => ({ supabase: { auth: { getSession: vi.fn(), verifyOtp }, rpc: vi.fn() } }));
vi.mock('@/services/authEmail', () => ({ requestAuthEmail: vi.fn(), EMAIL_SERVICE_DOWN: 'down' }));

import { LIVE_APP_PATH, LIVE_MANIFEST, LIVE_SW_SCOPE, ON_STREAM_HOST } from './host';
import { SW_SCOPE } from './monitor/push';
import { confirmRedirectUrl, consumeAuthReturn } from './account';
import { viewerUrl, guestUrl, studioUrl } from './nav';
import { LIVE_LEGAL_LINKS } from './ui/legalLinks';
import { markSignInStarted } from '@/services/pendingSignIn';

const go = (path: string) => history.replaceState(null, '', path);
const S = 'https://stream.dreamstreamstudio.ai';

beforeEach(() => {
  verifyOtp.mockReset();
  localStorage.clear();
  go('/');
});

describe('on stream.dreamstreamstudio.ai', () => {
  it('lives at / with its own alert-worker scope and manifest', () => {
    expect(ON_STREAM_HOST).toBe(true);
    expect(LIVE_APP_PATH).toBe('/');
    expect(LIVE_SW_SCOPE).toBe('/');
    expect(SW_SCOPE).toBe('/');
    expect(LIVE_MANIFEST).toBe('/stream.webmanifest');
  });

  it('share links use the new address', () => {
    expect(viewerUrl('evt_1')).toBe(`${S}/?e=evt_1`);
    expect(studioUrl('evt_1', 'k')).toBe(`${S}/?e=evt_1#/studio?k=k`);
    expect(guestUrl('evt_1', 'g', { meeting: true })).toBe(`${S}/?e=evt_1#/guest?g=g&m=1`);
  });

  it('sign-up confirmations return to the root, on the right screen', () => {
    go('/#/monitor/11111111-2222-4333-8444-555555555555/watch');
    expect(confirmRedirectUrl()).toBe(`${S}/?after=monitor`);
    go('/?e=x#/studio?k=secret');
    expect(confirmRedirectUrl()).toBe(`${S}/`);
  });

  it('finishes a link carrying a sign-in this host started at the root, leaving no token (or nonce) behind', async () => {
    verifyOtp.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    // The intent lives on the RECEIVING host — here a handoff whose nonce /api/auth/handoff echoed.
    const sn = markSignInStarted('handoff');
    go(`/?token_hash=h&type=magiclink&sn=${sn}&after=monitor`);
    expect(await consumeAuthReturn()).toEqual({ confirmed: true, handoff: true });
    expect(location.href).toBe(`${S}/#/monitor`);
  });

  it('a handoff started on another host (its own storage) asks once before signing in here', async () => {
    verifyOtp.mockResolvedValue({ data: { session: { access_token: 't' } }, error: null });
    go('/?token_hash=h&type=magiclink&after=monitor');
    const r = await consumeAuthReturn();
    expect(r).toMatchObject({ confirm: true, handoff: true });
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(r && 'confirm' in r ? await r.proceed() : null).toEqual({ confirmed: true, handoff: true });
    expect(location.href).toBe(`${S}/#/monitor`);
  });

  it('links to DreamStream’s legal pages absolutely', () => {
    expect(LIVE_LEGAL_LINKS.map((l) => l.href).slice(0, 2)).toEqual([
      'https://dreamstreamstudio.ai/?view=privacy',
      'https://dreamstreamstudio.ai/?view=terms',
    ]);
  });
});
