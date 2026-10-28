import { Router, type Request, type Response } from 'express';
import type { SupabaseClient } from '@supabase/supabase-js';
import { STREAM_HOST_ON, STREAM_ORIGIN } from '../../../shared/streamHost.js';
import { createRateLimit } from '../middleware/rateLimit.js';
import {
  LINK_ORIGIN_ALLOWLIST,
  buildHandoffLink,
  parseMainHandoffPath,
  parseSignInNonce,
  parseStreamHandoffPath,
  pickLinkOrigin
} from '../services/authEmailLinks.js';
import { getSupabaseAdmin } from '../services/supabase.js';

// POST /api/auth/handoff — carry a signed-in person between DreamStream and Stream Studio.
//
// Since Stream Studio has its own host (stream.dreamstreamstudio.ai, shared/streamHost.ts), the two
// apps keep separate sessions (Supabase stores them in localStorage, per origin). Refresh tokens
// rotate (single use), so a session must never be copied from one origin to the other. Instead the
// app you're leaving asks for a fresh one-time sign-in link for YOUR account and opens it on the
// other side, which verifies it (verifyOtp) into a session of its own:
//
//   body {to:'live'|'main', path?, sn?}  →  {ok:true, url}   (sn: the receiving app's sign-in nonce, echoed)
//     to 'live':  https://stream.dreamstreamstudio.ai/?token_hash=…&type=magiclink[&after=<screen>]
//     to 'main':  https://dreamstreamstudio.ai/auth/callback?token_hash=…&type=magiclink&next=</ or /?view=…>
//
// Guardrails: requireAuth (mounted after the global one) — the link is only ever for the caller's
// own account; both destination origins are constants and the path is a strict allowlist (no open
// redirect); browsers may only ask from our own apps; 10 a minute per account; no-store; the token
// and the URL are never logged. It answers 404 while STREAM_HOST_ON is off: the apps share one
// origin then and there is nothing to hand off.

export interface AuthHandoffOptions {
  /** STREAM_HOST_ON — a parameter so tests can run both sides of the switch. */
  streamHostOn?: boolean;
  /** Service-role client (tests pass a fake). */
  getAdmin?: () => SupabaseClient;
  /** Requests per account per minute. */
  perMinute?: number;
}

type LinkProps = { hashed_token?: string; verification_type?: string };

const fail = (res: Response, status: number, code: string, message: string) => res.status(status).json({ ok: false, code, message });

/** Only our own apps' pages may ask (no Origin header = not a browser; the bearer token still rules). */
const trustedCaller = (req: Request): boolean => {
  const origin = req.get('origin');
  if (!origin) return true;
  return origin === STREAM_ORIGIN || LINK_ORIGIN_ALLOWLIST.includes(origin);
};

/** First 8 characters of the account id — enough to correlate, never the address or the link. */
const who = (id: string) => `${id.slice(0, 8)}…`;

export function createAuthHandoffRouter(opts: AuthHandoffOptions = {}): Router {
  const streamHostOn = opts.streamHostOn ?? STREAM_HOST_ON;
  const getAdmin = opts.getAdmin ?? getSupabaseAdmin;
  const router = Router();
  const limit = createRateLimit({ scope: 'auth-handoff', windowMs: 60_000, maxRequests: opts.perMinute ?? 10 });

  router.post('/', limit, async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!streamHostOn) return fail(res, 404, 'handoff_unavailable', 'Both apps share one address — nothing to hand off.');
      const user = req.user;
      if (!user?.id) return fail(res, 401, 'not_signed_in', 'Sign in first.');
      if (!user.email) return fail(res, 400, 'no_email', 'This account has no email address to sign in with.');
      if (!trustedCaller(req)) return fail(res, 403, 'forbidden_origin', 'Not allowed from this site.');

      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      const to = body.to === 'live' || body.to === 'main' ? body.to : null;
      if (!to) return fail(res, 400, 'invalid_input', 'Say where to go: "live" or "main".');
      const screen = to === 'live' ? parseStreamHandoffPath(body.path) : '';
      const nextPath = to === 'main' ? parseMainHandoffPath(body.path) : '/';
      if (screen === null || nextPath === null) return fail(res, 400, 'invalid_path', 'That page can’t be opened this way.');

      let admin: SupabaseClient;
      try {
        admin = getAdmin();
      } catch {
        return fail(res, 503, 'unavailable', 'Sign-in handoff is unavailable right now.');
      }
      const mainOrigin = pickLinkOrigin(req.get('origin'));
      const { data, error } = await admin.auth.admin.generateLink({
        type: 'magiclink',
        email: user.email,
        options: { redirectTo: to === 'live' ? `${STREAM_ORIGIN}/` : `${mainOrigin}/auth/callback` }
      });
      const props = (data?.properties ?? undefined) as LinkProps | undefined;
      if (error || !props?.hashed_token) {
        console.warn(`[auth-handoff] ${who(user.id)} → ${to}: generateLink failed (${(error as { status?: number } | null)?.status ?? 'no token'})`);
        return fail(res, 502, 'handoff_failed', 'Couldn’t prepare the sign-in — please sign in on the next page.');
      }
      // GoTrue finds the account by address; never hand out a link for anyone but the caller.
      if (data?.user?.id && data.user.id !== user.id) {
        console.error(`[auth-handoff] ${who(user.id)} → ${to}: link was for a different account — refused`);
        return fail(res, 409, 'account_mismatch', 'Couldn’t prepare the sign-in — please sign in on the next page.');
      }
      let url: string;
      try {
        url = buildHandoffLink({
          to,
          mainOrigin,
          hashedToken: props.hashed_token,
          verificationType: props.verification_type || 'magiclink',
          after: screen,
          next: nextPath,
          // Only the app that receives the link can have recorded this nonce, so it lets the link
          // through there without a confirm step — never anywhere else (services/pendingSignIn).
          signInNonce: parseSignInNonce(body.sn)
        });
      } catch (err) {
        console.warn(`[auth-handoff] ${who(user.id)} → ${to}: ${(err as Error).message}`);
        return fail(res, 502, 'handoff_failed', 'Couldn’t prepare the sign-in — please sign in on the next page.');
      }
      console.log(`[auth-handoff] ${who(user.id)} → ${to}`);
      return res.json({ ok: true, url });
    } catch (err) {
      next(err);
    }
  });
  return router;
}

export const authHandoffRouter = createAuthHandoffRouter();
