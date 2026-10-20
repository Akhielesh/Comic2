// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getSession = vi.fn();
vi.mock('@/services/supabase', () => ({ supabase: { auth: { getSession } } }));

import { confirmRedirectUrl, consumeAuthReturn } from './account';

const go = (path: string) => history.replaceState(null, '', path);

beforeEach(() => {
  getSession.mockReset();
  go('/live');
});

describe('confirmRedirectUrl', () => {
  it('returns to the screen the user signed up from, with no fragment', () => {
    go('/live#/monitor/11111111-2222-4333-8444-555555555555/camera');
    expect(confirmRedirectUrl()).toBe(`${location.origin}/live?after=monitor`);
    go('/live#/settings');
    expect(confirmRedirectUrl()).toBe(`${location.origin}/live?after=settings`);
  });

  it('never carries private links or unknown screens', () => {
    go('/live?e=abc#/studio?k=secret');
    expect(confirmRedirectUrl()).toBe(`${location.origin}/live`);
    go('/live');
    expect(confirmRedirectUrl()).toBe(`${location.origin}/live`);
  });
});

describe('consumeAuthReturn', () => {
  it('ignores an ordinary page load', async () => {
    go('/live#/monitor');
    expect(await consumeAuthReturn()).toBeNull();
    expect(location.hash).toBe('#/monitor');
    expect(getSession).not.toHaveBeenCalled();
  });

  it('adopts the session from a confirmation link and lands on the start screen', async () => {
    getSession.mockResolvedValue({ data: { session: { access_token: 't' } } });
    go('/live?after=monitor#access_token=t&refresh_token=r&type=signup');
    expect(await consumeAuthReturn()).toEqual({ confirmed: true });
    expect(getSession).toHaveBeenCalledOnce();
    expect(location.pathname + location.search + location.hash).toBe('/live#/monitor');
  });

  it('explains an expired or already-used link and cleans the URL', async () => {
    go('/live?after=monitor#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired');
    expect(await consumeAuthReturn()).toEqual({ error: 'expired' });
    expect(getSession).not.toHaveBeenCalled();
    expect(location.search + location.hash).toBe('#/monitor');
  });

  it('reports a link that produced no session', async () => {
    getSession.mockResolvedValue({ data: { session: null } });
    go('/live#access_token=bad&type=signup');
    expect(await consumeAuthReturn()).toEqual({ error: 'failed' });
    expect(location.hash).toBe('');
  });

  it('drops an unknown ?after= screen', async () => {
    go('/live?after=studio');
    expect(await consumeAuthReturn()).toBeNull();
    expect(location.search + location.hash).toBe('');
  });
});
