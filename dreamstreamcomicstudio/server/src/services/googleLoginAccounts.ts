import { getSupabaseAdmin } from './supabase.js';
import { dobProblem, USERNAME_REGEX } from './signupValidation.js';

/** This service accepts only claims verified by the server-side Google OIDC callback. */
export interface GoogleLoginIdentity { sub: string; email: string; firstName?: string }
export interface GoogleLoginProfile { username: string; firstName: string; dob: string; acceptedTerms: boolean; referralCode?: string; signupSource?: 'comic_studio' }
type Failure = 'needs-profile' | 'email-conflict' | 'invalid-profile' | 'unavailable' | 'username-taken' | 'identity-mismatch';

export class GoogleLoginAccountError extends Error {
  constructor(readonly code: Failure, message: string) { super(message); }
}

type Account = { bound_id: string | null; login_email: string | null; email_in_use: boolean };
const unavailable = () => new GoogleLoginAccountError('unavailable', 'Google sign-in is temporarily unavailable. Try again or use email.');
const conflict = () => new GoogleLoginAccountError('email-conflict', 'This address already has a DreamStream account. Use your existing sign-in method.');
const mismatch = () => new GoogleLoginAccountError('identity-mismatch', 'Please sign in with the email address currently associated with your DreamStream account.');

async function lookup(identity: GoogleLoginIdentity): Promise<Account> {
  if (!identity || typeof identity.sub !== 'string' || !identity.sub || identity.sub.length > 255 ||
    typeof identity.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identity.email) || identity.email.length > 320) throw mismatch();
  const { data, error } = await getSupabaseAdmin().rpc('lookup_google_login', { p_subject: identity.sub, p_email: identity.email }).single();
  if (error || !data) throw unavailable();
  const row = data as Account;
  if (row.bound_id && row.login_email?.toLowerCase() !== identity.email.toLowerCase()) throw mismatch();
  return row;
}

export async function resolveGoogleAccount(identity: GoogleLoginIdentity): Promise<'bound' | 'needs-profile' | 'email-conflict'> {
  const account = await lookup(identity);
  return account.bound_id ? 'bound' : account.email_in_use ? 'email-conflict' : 'needs-profile';
}

function validatedProfile(profile?: GoogleLoginProfile) {
  if (!profile) throw new GoogleLoginAccountError('needs-profile', 'Finish your profile to create your account.');
  const username = typeof profile.username === 'string' ? profile.username.trim() : '';
  const firstName = typeof profile.firstName === 'string' ? profile.firstName.trim() : '';
  const dob = typeof profile.dob === 'string' ? profile.dob : '';
  const error = !USERNAME_REGEX.test(username) ? 'Choose a username of 3–20 letters, numbers, or underscores.'
    : !firstName || firstName.length > 100 ? 'Enter a first name of up to 100 characters.'
    : dobProblem(dob) ?? (profile.acceptedTerms !== true ? 'Accept the terms to create your account.' : null);
  if (error) throw new GoogleLoginAccountError('invalid-profile', error);
  return { username, first_name: firstName, dob, terms_accepted: true, marketing_consent: false, email_pref_marketing: false };
}

export async function issueGoogleSession(identity: GoogleLoginIdentity, profile?: GoogleLoginProfile): Promise<{ tokenHash: string }> {
  const admin = getSupabaseAdmin();
  let account = await lookup(identity);
  if (!account.bound_id) {
    if (account.email_in_use) throw conflict();
    const metadata = validatedProfile(profile);
    const referralCode = profile?.referralCode;
    const result = await admin.auth.admin.createUser({
      email: identity.email, email_confirm: true, user_metadata: { ...metadata, ...(profile?.signupSource === 'comic_studio' ? { signup_source: 'comic_studio' } : {}) },
      app_metadata: { dreamstream_google_sub: identity.sub,
        ...(typeof referralCode === 'string' && /^[0-9a-f]{32}$/.test(referralCode) ? { dreamstream_referral_code: referralCode } : {}) }
    });
    // A retry may race the first insert. Its subject binding, never its email alone, determines ownership.
    account = await lookup(identity);
    if (!account.bound_id) {
      if (account.email_in_use) throw conflict();
      if (result.error) {
        const { data: taken } = await admin.from('profiles').select('id').ilike('username', metadata.username.replaceAll('_','\\_')).limit(1);
        if (taken?.length) throw new GoogleLoginAccountError('username-taken', 'That username is taken. Choose another.');
      }
      throw unavailable();
    }
    if (result.data.user && result.data.user.id !== account.bound_id) throw mismatch();
  }
  const { data: verified, error: userError } = await admin.auth.admin.getUserById(account.bound_id);
  const user = verified?.user;
  if (userError || !user || !user.email_confirmed_at || user.app_metadata?.dreamstream_google_sub !== identity.sub ||
    user.email?.toLowerCase() !== identity.email.toLowerCase() || (user.banned_until && Date.parse(user.banned_until) > Date.now())) throw mismatch();
  // The main site's Google route cannot complete a factor challenge. Do not issue it an AAL1 session for an enrolled account.
  const factors = await admin.auth.admin.mfa.listFactors({ userId: user.id });
  if (factors.error || !Array.isArray(factors.data?.factors)) throw unavailable();
  if (factors.data.factors.some(factor => factor.status === 'verified')) {
    throw new GoogleLoginAccountError('identity-mismatch', 'Use your existing two-step sign-in to access this account.');
  }
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: user.email! });
  if (error || !data.properties?.hashed_token) throw unavailable();
  if (data.user?.id !== account.bound_id || data.user.app_metadata?.dreamstream_google_sub !== identity.sub) throw mismatch();
  return { tokenHash: data.properties.hashed_token };
}
