import { buildApiUrl } from './clientConfig';
import { comicsUrl } from './productHost';
import { ownerBearer } from './accountProviderUsage';

const CODE = /^[0-9a-f]{32}$/;
const PENDING = 'ds.memberReferral.pending';
const LINK_AGE = 24 * 60 * 60 * 1000;
function read(key: string, maxAge: number): string | null {
  try {
    const entry = JSON.parse(sessionStorage.getItem(key) ?? 'null') as { value?: string; at?: number } | null;
    if (entry && typeof entry.value === 'string' && Number.isFinite(entry.at) && Date.now() - entry.at! < maxAge && Date.now() >= entry.at!) return entry.value;
    sessionStorage.removeItem(key);
  } catch { /* Storage can be blocked. Signup remains available. */ }
  return null;
}
function write(key: string, value: string | null): boolean {
  try {
    if (value) sessionStorage.setItem(key, JSON.stringify({ value, at: Date.now() }));
    else sessionStorage.removeItem(key);
    return true;
  } catch { return false; }
}

export function getSignupReferralCode(): string | null {
  if (typeof window === 'undefined') return null;
  const url = new URL(window.location.href);
  const incoming = url.pathname === '/' ? url.searchParams.get('ref') : null;
  if (incoming && CODE.test(incoming)) {
    if (write(PENDING, incoming)) {
      url.searchParams.delete('ref');
      window.history.replaceState(window.history.state, '', url);
    }
    return incoming;
  }
  const previous = read(PENDING, LINK_AGE);
  return previous && CODE.test(previous) ? previous : null;
}

export function clearSignupReferral() {
  write(PENDING, null);
}

export async function getMemberReferral(ownerId: string, signal: AbortSignal): Promise<{ url: string; verifiedSignups: number }> {
  const authorization = await ownerBearer(ownerId, signal);
  const response = await fetch(buildApiUrl('/api/referrals/me'), {
    headers: { Authorization: authorization }, signal, cache: 'no-store', redirect: 'error'
  });
  if (!response.ok) throw new Error('Referral unavailable');
  const result = await response.json();
  if (typeof result.code !== 'string' || !CODE.test(result.code) || !Number.isSafeInteger(result.verifiedSignups) || result.verifiedSignups < 0) throw new Error('Referral unavailable');
  return { url: comicsUrl('/?view=auth&mode=signup&ref=' + result.code), verifiedSignups: result.verifiedSignups };
}
