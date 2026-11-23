import { createHash, randomBytes } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET } from '../config.js';
import { generatePkce, googleRedirectUri, isGoogleOAuthConfigured } from '../connectors/oauth.js';
import { decryptSecret, encryptSecret, isSecureStoreAvailable } from '../lib/secureStore.js';
import { getSupabaseAdmin } from './supabase.js';
import type { GoogleLoginIdentity } from './googleLoginAccounts.js';

const TABLE = 'google_login_flows';
const LIFETIME = 10 * 60_000;
const verifier = new OAuth2Client();
const randomToken = () => randomBytes(32).toString('base64url');
export const validGoogleFlowToken = (token: unknown): token is string => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
export const browserChallenge = (secret: string): string => createHash('sha256').update(secret).digest('base64url');
interface AuthorizeData { origin: string; nonce: string; verifier: string }
interface CompletionData { identity: GoogleLoginIdentity; authoritativeEmail: boolean; origin: string }
interface Stages { authorize: AuthorizeData; complete: CompletionData }
export async function loginAvailable(): Promise<boolean> {
  if (!isGoogleOAuthConfigured() || !isSecureStoreAvailable() || !googleRedirectUri()) return false;
  const db = getSupabaseAdmin();
  const [flows, bindings] = await Promise.all([
    db.from(TABLE).select('id_hash', { head: true }).limit(1),
    db.rpc('lookup_google_login', { p_subject: '', p_email: '' }),
  ]);
  return !flows.error && !bindings.error;
}

export async function saveGoogleFlow<K extends keyof Stages>(stage: K, data: Stages[K], challenge: string, previousExpiry?: string): Promise<string> {
  const expiry = Math.min(Date.now() + LIFETIME, previousExpiry ? Date.parse(previousExpiry) : Infinity);
  if (!(expiry > Date.now())) throw new Error('Google sign-in state expired.');
  const token = randomToken();
  const id = createHash('sha256').update(token).digest('hex');
  const encrypted = encryptSecret(JSON.stringify(data));
  if (!encrypted) throw new Error('Google login storage is unavailable.');
  const db = getSupabaseAdmin();
  const { error } = await db.from(TABLE).insert({
    stage, id_hash: id, browser_challenge: challenge, ...encrypted, expires_at: new Date(expiry).toISOString(),
  });
  if (error) throw new Error('Could not save sign-in state.');
  // Every new attempt also retires abandoned callbacks. Expired rows cannot be redeemed.
  await db.from(TABLE).delete().lt('expires_at', new Date().toISOString());
  return token;
}

export async function readGoogleFlow<K extends keyof Stages>(stage: K, token: string, consume: boolean, challenge?: string): Promise<{ data: Stages[K]; challenge: string; expiresAt: string } | null> {
  if (!validGoogleFlowToken(token)) return null;
  const table = getSupabaseAdmin().from(TABLE);
  const columns = 'ciphertext,iv,browser_challenge,expires_at';
  const query = consume ? table.delete().select(columns) : table.select(columns);
  const filter = query.eq('id_hash', createHash('sha256').update(token).digest('hex')).eq('stage', stage).gt('expires_at', new Date().toISOString());
  if (challenge) filter.eq('browser_challenge', challenge);
  const { data, error } = await filter.maybeSingle();
  if (error) throw new Error('Could not read sign-in state.');
  if (!data) return null;
  const decoded = decryptSecret(data.ciphertext, data.iv);
  if (!decoded) throw new Error('Could not read sign-in state.');
  return { data: JSON.parse(decoded) as Stages[K], challenge: data.browser_challenge, expiresAt: data.expires_at };
}

export async function googleAuthorization(origin: string, challenge: string): Promise<string> {
  const pkce = generatePkce();
  const nonce = randomToken();
  const state = await saveGoogleFlow('authorize', { origin, nonce, verifier: pkce.codeVerifier }, challenge);
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: GOOGLE_OAUTH_CLIENT_ID, redirect_uri: googleRedirectUri(), response_type: 'code',
    scope: 'openid email profile', state: 'login.' + state, nonce, code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256', prompt: 'select_account', access_type: 'online', include_granted_scopes: 'false',
  }).toString();
  return url.href;
}

export async function exchangeGoogleIdentity(code: string, state: AuthorizeData): Promise<CompletionData> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({ client_id: GOOGLE_OAUTH_CLIENT_ID, client_secret: GOOGLE_OAUTH_CLIENT_SECRET,
      code, code_verifier: state.verifier, redirect_uri: googleRedirectUri(), grant_type: 'authorization_code' }),
  });
  if (!response.ok) throw new Error('Google could not complete authorization.');
  const { id_token } = await response.json() as { id_token?: string };
  if (!id_token) throw new Error('Google did not return identity.');
  const ticket = await verifier.verifyIdToken({ idToken: id_token, audience: GOOGLE_OAUTH_CLIENT_ID });
  const payload = ticket.getPayload() as (ReturnType<typeof ticket.getPayload> & { nonce?: string }) | undefined;
  if (!payload || !['accounts.google.com','https://accounts.google.com'].includes(payload.iss) ||
      payload.aud !== GOOGLE_OAUTH_CLIENT_ID || (payload.azp && payload.azp !== GOOGLE_OAUTH_CLIENT_ID) ||
      payload.nonce !== state.nonce || !payload.sub || payload.sub.length > 255 || payload.email_verified !== true ||
      typeof payload.email !== 'string' || !payload.email || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error('Google identity could not be verified.');
  }
  const email = payload.email.trim().toLowerCase();
  return {
    origin: state.origin,
    identity: { sub: payload.sub, email, firstName: payload.given_name },
    authoritativeEmail: email.endsWith('@gmail.com') || !!payload.hd,
  };
}
