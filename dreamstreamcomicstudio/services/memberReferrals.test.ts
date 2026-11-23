import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSignupReferral, getMemberReferral, getSignupReferralCode } from './memberReferrals';
vi.mock('./accountProviderUsage', () => ({ ownerBearer: async (id: string) => 'Bearer ' + id }));
const code = 'd'.repeat(32);
const fetcher = vi.fn();
const signal = () => new AbortController().signal;
beforeEach(() => {
  vi.stubGlobal('fetch', fetcher);
  window.history.replaceState({}, '', '/?view=auth&mode=signup&ref='+code);
});
afterEach(() => { clearSignupReferral(); vi.unstubAllGlobals(); vi.resetAllMocks(); window.history.replaceState({}, '', '/'); });
it('retains a landing code through navigation on this tab and ignores a raw account id and reader URL', () => {
  expect(getSignupReferralCode()).toBe(code);
  window.history.replaceState({}, '', '/?view=auth');
  expect(getSignupReferralCode()).toBe(code);
  clearSignupReferral();
  window.history.replaceState({}, '', '/?ref=00000000-0000-0000-0000-000000000001');
  expect(getSignupReferralCode()).toBeNull();
  window.history.replaceState({}, '', '/c/last-tram?ref='+code);
  expect(getSignupReferralCode()).toBeNull();
});
it('accepts only a canonical account link',async () => {
  fetcher.mockResolvedValueOnce(new Response(JSON.stringify({code,verifiedSignups:2,url:'https://elsewhere.invalid'})));
  const info = await getMemberReferral('member',signal());
  expect(info).toEqual({url:'https://comics.dreamstreamstudio.ai/?view=auth&mode=signup&ref='+code,verifiedSignups:2});
});
