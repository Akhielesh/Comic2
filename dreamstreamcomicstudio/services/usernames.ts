import { buildApiUrl } from './clientConfig';
import { supabase } from './supabase';
import { USERNAME_REGEX, type UsernameAvailability } from '../shared/username';

export async function checkUsername(username: string, signal: AbortSignal): Promise<UsernameAvailability> {
  const response = await fetch(buildApiUrl('/api/auth/username/check'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username }), signal, cache: 'no-store',
  });
  if (!response.ok) throw new Error('Availability could not be checked.');
  const result = await response.json();
  if (typeof result.available !== 'boolean' || !Array.isArray(result.suggestions)) throw new Error('Availability could not be checked.');
  return { available: result.available, suggestions: result.suggestions.filter((v: unknown) => typeof v === 'string' && USERNAME_REGEX.test(v)).slice(0, 3) };
}
export async function signInWithUsername(username: string, password: string, captchaToken?: string) {
  const fallback = 'Username sign-in is unavailable right now. Try signing in with your email.';
  const response = await fetch(buildApiUrl('/api/auth/username/signin'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, captchaToken }),
    redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000),
  }).catch(() => { throw new Error(fallback); });
  const body = await response.json().catch(() => ({}));
  if (response.status === 429) throw new Error('Too many sign-in attempts. Please try again later.');
  if (!response.ok || !body.access_token || !body.refresh_token) throw new Error(body.message || fallback);
  return supabase.auth.setSession({ access_token: body.access_token, refresh_token: body.refresh_token });
}
