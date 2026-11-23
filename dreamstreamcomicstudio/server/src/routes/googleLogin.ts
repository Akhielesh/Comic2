import { COMICS_ORIGIN } from '../../../services/productHost.js';
import { Router, type Request, type Response } from 'express';
import { LINK_ORIGIN_ALLOWLIST } from '../services/authEmailLinks.js';
import { turnstileConfigured, verifyTurnstile } from '../services/turnstile.js';
import { GoogleLoginAccountError, issueGoogleSession, resolveGoogleAccount } from '../services/googleLoginAccounts.js';
import { browserChallenge, exchangeGoogleIdentity, googleAuthorization, loginAvailable, readGoogleFlow, saveGoogleFlow, validGoogleFlowToken } from '../services/googleLoginFlow.js';

export const googleLoginRouter = Router();
const retry = 'Google sign-in could not finish. Start again or continue with email.';
const failed = (res: Response, status: number, message = retry) => res.status(status).json({ message });
googleLoginRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
googleLoginRouter.get('/status', async (_req, res) => {
  try { res.json({ enabled: await loginAvailable() }); }
  catch { res.json({ enabled: false }); }
});
googleLoginRouter.post('/start', async (req, res) => {
  try {
    const origin = req.get('origin') || '';
    if (!LINK_ORIGIN_ALLOWLIST.includes(origin) || !validGoogleFlowToken(req.body?.browserChallenge)) return failed(res, 400);
    if (!await loginAvailable()) return failed(res, 503);
    const token = typeof req.body?.captchaToken === 'string' ? req.body.captchaToken : '';
    if (turnstileConfigured() && (!token || !await verifyTurnstile(token, req.ip))) return failed(res, 400, 'Complete the verification challenge and try again.');
    return res.json({ authorizationUrl: await googleAuthorization(origin, req.body.browserChallenge) });
  } catch { return failed(res, 503); }
});

/** Reuse the Google Console-registered URI. Connector consent uses separate unprefixed state. */
export async function finishGoogleAuthorization(req: Request, res: Response) {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  try {
    const state = await readGoogleFlow('authorize', String(req.query.state || '').slice('login.'.length), true);
    if (!state || !LINK_ORIGIN_ALLOWLIST.includes(state.data.origin)) return res.status(400).type('text').send(retry);
    const destination = new URL('/?view=auth', state.data.origin);
    try {
      const code = req.query.code;
      if (typeof code !== 'string' || !code || code.length > 4096 || req.query.error) throw new Error('Cancelled');
      const identity = await exchangeGoogleIdentity(code, state.data);
      const grant = await saveGoogleFlow('complete', identity, state.challenge);
      destination.hash = new URLSearchParams({ google_finish: grant }).toString();
    } catch { destination.hash = 'google_error=1'; }
    return res.redirect(303, destination.href);
  } catch { return res.status(503).type('text').send(retry); }
}

googleLoginRouter.post('/complete', async (req, res) => {
  const { grant, browserSecret, profile } = req.body ?? {};
  if (!validGoogleFlowToken(grant) || !validGoogleFlowToken(browserSecret)) return failed(res, 400);
  const origin = req.get('origin') || '';
  if (!LINK_ORIGIN_ALLOWLIST.includes(origin)) return failed(res, 400);
  const challenge = browserChallenge(browserSecret);
  try {
    const found = await readGoogleFlow('complete', grant, false, challenge);
    if (!found || found.data.origin !== origin) return failed(res, 410, 'This sign-in has expired. Continue with Google again.');
    const { identity, authoritativeEmail } = found.data;
    const account = await resolveGoogleAccount(identity);
    if (account === 'email-conflict') return res.status(409).json({ code: 'email-conflict', message: 'This email already has an account. Use your existing sign-in method.' });
    if (account === 'needs-profile') {
      if (!authoritativeEmail) return failed(res, 400, 'Please use email signup so we can verify this address directly.');
      if (!profile) return res.json({ needsProfile: true, firstName: identity.firstName || '', email: identity.email });
    }
    // Atomic DELETE ... RETURNING prevents two racing submissions minting two sessions.
    if (!await readGoogleFlow('complete', grant, true, challenge)) return failed(res, 410);
    try {
      return res.json(await issueGoogleSession(identity, account === 'needs-profile' ? { ...profile, signupSource: origin === COMICS_ORIGIN ? 'comic_studio' : undefined } : undefined));
    } catch (error) {
      if (error instanceof GoogleLoginAccountError && ['invalid-profile','username-taken'].includes(error.code)) {
        const replacement = await saveGoogleFlow('complete', found.data, challenge, found.expiresAt);
        return res.status(422).json({ code: error.code, message: error.message, grant: replacement });
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof GoogleLoginAccountError) return res.status(error.code === 'unavailable' ? 503 : 409).json({ code: error.code, message: error.message });
    return failed(res, 503);
  }
});
