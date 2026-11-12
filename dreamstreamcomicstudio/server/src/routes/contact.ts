import { Router, type Request, type Response } from 'express';
import { getRateLimitStore, type RateLimitHit, type RateLimitStore } from '../middleware/rateLimitStore.js';
import {
  CONTACT_EMAIL_MAX,
  CONTACT_EMAIL_MIN,
  CONTACT_MESSAGE_MAX,
  supabaseContactStore,
  type ContactStore
} from '../services/contactStore.js';

// POST /api/contact — Settings › Contact (CONTACT-1).
//
// Mounted AFTER the global requireAuth in server/src/index.ts; the handler re-checks the user so
// the route answers 401 on its own if it is ever mounted elsewhere. The body is { email, message }:
// trimmed, checked against the same caps as server/sql/contact_messages.sql, then written with the
// service role (services/contactStore.ts).
//
// - Per-user limit: 5 sends an hour and 20 a day, in the shared limiter store (Redis when REDIS_URL
//   is set, in memory otherwise). Only a well-formed message counts; an over-limit send gets 429.
// - Errors never echo the message or the address back, and nothing here logs either of them.
// - No timer: the limiter windows are counters in the store, read on each request.

/** Per-user send limits: checked in this order. */
export const CONTACT_RATE_LIMITS = [
  { scope: 'contact_hour', windowMs: 60 * 60_000, maxRequests: 5 },
  { scope: 'contact_day', windowMs: 24 * 60 * 60_000, maxRequests: 20 }
] as const;

/** A practical address shape: something@something.tld, no spaces, one @. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** Postgres char_length counts code points; so do these caps. NUL cannot be stored in text. */
const codePoints = (value: string): number => Array.from(value).length;
const clean = (value: unknown): string => (typeof value === 'string' ? value.replace(/\u0000/g, '').trim() : '');

export const CONTACT_COPY = {
  signIn: 'Sign in to send us a message.',
  emailMissing: 'Add the email address we should reply to.',
  emailShape: 'That email address doesn’t look complete. Check it and send again.',
  messageMissing: 'Write a message before sending.',
  messageTooLong: `Your message is over ${CONTACT_MESSAGE_MAX.toLocaleString('en-US')} characters. Shorten it and send again.`,
  rateLimited: 'You’ve sent several messages in a short time. Please wait a while before sending another.',
  unavailable: 'We couldn’t send that right now. Nothing was saved.'
} as const;

export type ContactBodyResult =
  | { ok: true; email: string; message: string }
  | { ok: false; field: 'email' | 'message'; message: string };

/** Validates a request body. The result's `message` on failure is fixed copy, never the input. */
export const parseContactBody = (body: unknown): ContactBodyResult => {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const email = clean(raw.email);
  const message = clean(raw.message);
  if (!email) return { ok: false, field: 'email', message: CONTACT_COPY.emailMissing };
  const emailLength = codePoints(email);
  if (emailLength < CONTACT_EMAIL_MIN || emailLength > CONTACT_EMAIL_MAX || !EMAIL_SHAPE.test(email)) {
    return { ok: false, field: 'email', message: CONTACT_COPY.emailShape };
  }
  if (!message) return { ok: false, field: 'message', message: CONTACT_COPY.messageMissing };
  if (codePoints(message) > CONTACT_MESSAGE_MAX) return { ok: false, field: 'message', message: CONTACT_COPY.messageTooLong };
  return { ok: true, email, message };
};

export interface ContactRouterDeps {
  store?: ContactStore;
  /** The limiter's counter store; defaults to the app-wide one (Redis or in memory). */
  limiter?: () => RateLimitStore;
  now?: () => number;
}

type LimitVerdict = { limited: false } | { limited: true; retryAfterSeconds: number };

const checkLimits = async (userId: string, limiter: () => RateLimitStore, now: () => number): Promise<LimitVerdict> => {
  for (const { scope, windowMs, maxRequests } of CONTACT_RATE_LIMITS) {
    let hit: RateLimitHit;
    try {
      hit = await limiter().hit(`${scope}:user:${userId}`, windowMs, maxRequests);
    } catch {
      // Fail open, like createRateLimit: a limiter hiccup must not block a real message.
      return { limited: false };
    }
    if (hit.count > maxRequests) {
      return { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((hit.resetAt - now()) / 1000)) };
    }
  }
  return { limited: false };
};

const fail = (res: Response, status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  res.status(status).json({ error: { message, code, ...extra } });

export const createContactRouter = (deps: ContactRouterDeps = {}) => {
  const store = deps.store ?? supabaseContactStore;
  const limiter = deps.limiter ?? getRateLimitStore;
  const now = deps.now ?? Date.now;
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const userId = req.user?.id;
    if (!userId) {
      fail(res, 401, 'AUTH_REQUIRED', CONTACT_COPY.signIn);
      return;
    }

    const parsed = parseContactBody(req.body);
    if (parsed.ok === false) {
      fail(res, 400, 'INVALID_CONTACT', parsed.message, { field: parsed.field });
      return;
    }

    const verdict = await checkLimits(userId, limiter, now);
    if (verdict.limited) {
      res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
      fail(res, 429, 'RATE_LIMITED', CONTACT_COPY.rateLimited, { retryAfterSeconds: verdict.retryAfterSeconds });
      return;
    }

    let saved: Awaited<ReturnType<ContactStore['insert']>>;
    try {
      saved = await store.insert({ userId, email: parsed.email, message: parsed.message });
    } catch {
      saved = { ok: false, reason: 'failed' };
    }
    if (saved.ok === false) {
      fail(res, 503, 'CONTACT_UNAVAILABLE', CONTACT_COPY.unavailable);
      return;
    }
    res.json({ ok: true });
  });

  return router;
};

export const contactRouter = createContactRouter();
