import { Router } from 'express';
import { USERNAME_REGEX } from '../../../shared/username.js';
import { getSupabaseAdmin } from '../services/supabase.js';
import { checkUsername, lookupHandles } from '../services/usernames.js';

export const usernameRouter = Router();
usernameRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
const invalid = { message: 'Invalid credentials. Use your email or username and password.' };
const unavailable = { message: 'Username sign-in is unavailable right now. Try signing in with your email.' };

usernameRouter.post('/check', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  if (!USERNAME_REGEX.test(username)) return res.status(400).json({ message: 'Enter a valid username.' });
  try { return res.json(await checkUsername(getSupabaseAdmin(), username)); }
  catch { return res.status(503).json({ message: 'Availability could not be checked.' }); }
});

usernameRouter.post('/signin', async (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const password = req.body?.password;
  if (!username || username.length > 128 || typeof password !== 'string' || !password.length || password.length > 4096) return res.status(401).json(invalid);
  try {
    const admin = getSupabaseAdmin();
    const id = (await lookupHandles(admin, [username])).get(username);
    if (!id) return res.status(401).json(invalid);
    const { data: account, error } = await admin.auth.admin.getUserById(id);
    if (error || !account.user?.email) return res.status(503).json(unavailable);
    // Use the publishable key and a single stateless password grant per request. Never
    // sign in on a shared Supabase client or persist a user's refresh token server-side.
    const grant = await fetch(new URL('/auth/v1/token?grant_type=password', process.env.VITE_SUPABASE_URL), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { apikey: process.env.VITE_SUPABASE_ANON_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: account.user.email, password,
        gotrue_meta_security: { captcha_token: typeof req.body.captchaToken === 'string' ? req.body.captchaToken : undefined } }),
    });
    if (grant.status === 429) return res.status(429).json({ message: 'Too many sign-in attempts. Try again later.' });
    if (!grant.ok) return grant.status >= 500 ? res.status(503).json(unavailable) : res.status(401).json(invalid);
    const session = await grant.json() as { user?: { id: string; email_confirmed_at?: string }; access_token?: string; refresh_token?: string };
    if (session.user?.id !== id || !session.user.email_confirmed_at || !session.access_token || !session.refresh_token) return res.status(401).json(invalid);
    return res.json({ access_token: session.access_token, refresh_token: session.refresh_token });
  } catch { return res.status(503).json(unavailable); }
});
