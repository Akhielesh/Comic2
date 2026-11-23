import { AUTH_WORKSPACE_PATHS, authWorkspace, type AuthWorkspace } from '../shared/authWorkspace';
import { FRAMED_LINK_MESSAGE, inFrame } from './authLink';
import { buildApiUrl } from './clientConfig';
import { getSignupReferralCode } from './memberReferrals';
import { supabase } from './supabase';

const KEY = 'ds.googleSignIn.attempt';
interface Attempt { secret: string; at: number; workspace?: AuthWorkspace; referralCode?: string; grant?: string }
export interface GoogleProfile { username: string; firstName: string; dob: string; acceptedTerms: boolean }
export type GoogleCompletion = { needsProfile: true; firstName: string; email: string } | { needsProfile: false; destination: string | null };
const expired = 'This Google sign-in has expired. Continue with Google again.';
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

function read(): Attempt | null {
  try {
    const attempt = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (validToken(attempt?.secret) && Date.now() >= attempt.at && Date.now() - attempt.at < 25 * 60_000) return attempt;
  } catch { /* Missing or blocked tab storage. */ }
  return null;
}
export function cancelGoogleSignIn() {
  try { sessionStorage.removeItem(KEY); } catch { /* Already unavailable. */ }
}
function save(attempt: Attempt) {
  try { sessionStorage.setItem(KEY, JSON.stringify(attempt)); }
  catch { throw new Error('Allow this site to use tab storage to sign in with Google, or choose email.'); }
}
async function post(path: string, body: unknown) {
  const response = await fetch(buildApiUrl('/api/auth/google/' + path), {
    method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), cache: 'no-store', signal: AbortSignal.timeout(20_000),
  });
  return { response, data: await response.json() };
}

export async function googleSignInAvailable(signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(buildApiUrl('/api/auth/google/status'), { signal, cache: 'no-store', redirect: 'error' });
    return response.ok && (await response.json()).enabled === true;
  } catch { return false; }
}

export async function startGoogleSignIn(workspace?: AuthWorkspace, captchaToken?: string): Promise<void> {
  if (inFrame()) throw new Error(FRAMED_LINK_MESSAGE);
  const secret = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const referralCode = getSignupReferralCode() ?? undefined;
  save({ secret, workspace, referralCode, at: Date.now() });
  try {
    const { response, data } = await post('start', { browserChallenge: base64url(new Uint8Array(hash)), captchaToken });
    if (!response.ok) throw new Error(data.message || 'Google sign-in could not start.');
    const url = new URL(data.authorizationUrl);
    if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth') throw new Error('Google sign-in could not start.');
    window.location.assign(url.href);
  } catch (err) { cancelGoogleSignIn(); throw err; }
}

/** Only the same tab can finish. Remove the opaque callback handle from the location immediately. */
export function pendingGoogleSignIn(): 'ready' | 'error' | null {
  const url = new URL(window.location.href);
  // AuthPage mounts during App's view restoration, before ?view=auth is re-synced.
  if (url.pathname !== '/') return null;
  const params = new URLSearchParams(url.hash.slice(1));
  if (!params.has('google_finish') && !params.has('google_error')) return read()?.grant ? 'ready' : null;
  url.hash = '';
  window.history.replaceState({}, '', url);
  const attempt = read();
  const grant = params.get('google_finish');
  if (!attempt || !validToken(grant)) { cancelGoogleSignIn(); return 'error'; }
  save({ ...attempt, grant });
  return 'ready';
}

export async function completeGoogleSignIn(profile?: GoogleProfile): Promise<GoogleCompletion> {
  if (inFrame()) throw new Error(FRAMED_LINK_MESSAGE);
  const attempt = read();
  if (!attempt?.grant) throw new Error(expired);
  const { response, data } = await post('complete', {
    browserSecret: attempt.secret, grant: attempt.grant,
    ...(profile ? { profile: { ...profile, referralCode: attempt.referralCode } } : {}),
  });
  if (!response.ok) {
    if (validToken(data.grant)) save({ ...attempt, grant: data.grant });
    else if (response.status < 500) cancelGoogleSignIn();
    throw new Error(data.message || 'Google sign-in could not finish.');
  }
  if (data.needsProfile === true) return { needsProfile: true, email: data.email, firstName: data.firstName };
  if (typeof data.tokenHash !== 'string' || !data.tokenHash) throw new Error(expired);
  cancelGoogleSignIn();
  const { error } = await supabase.auth.verifyOtp({ type: 'magiclink', token_hash: data.tokenHash });
  if (error) throw new Error('We could not finish signing in. Continue with Google again.');
  const workspace = authWorkspace(attempt.workspace);
  return { needsProfile: false, destination: workspace ? AUTH_WORKSPACE_PATHS[workspace] : null };
}
