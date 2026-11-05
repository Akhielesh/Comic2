// Per-caller limits for the public data routes in routes/chat.ts `chatPublicRouter`
// (abuse-ops-1 f, abuse-ops-6): link unfurl, reader mode and live-widget refresh.
//
// Those routes mount BEFORE requireAuth (a stale session must degrade a dashboard to anonymous data,
// not kill every tile), so anyone can call them, and each call makes the backend fetch a page or a
// data API. The only limiter in front of them was the shared `system` one (generous, keyed per
// address). These run AFTER optionalAuth, so they count:
//   - a signed-in caller per account (`user:<id>`), wherever they connect from;
//   - everyone else per IPv4 address or IPv6 /64 (lib/clientKey.ts): one subscriber holds a whole
//     /64, so keying a single v6 address would let a caller rotate addresses and never meet a limit.
// Same counter store as middleware/rateLimit.ts (Redis when configured, else in memory) and the same
// 429 body, so a client that already handles RATE_LIMITED needs nothing new. A store failure fails
// open, as there.
//
// The client memoises unfurl and reader-mode results per URL (services/chatApi.ts) and a dashboard
// refreshes a tile at most every 30 s (monitors are clamped 30–3600 s), so the numbers below sit far
// above real use: they bound a script, not a person.

import type { NextFunction, Request, Response } from 'express';
import { clientKey } from '../lib/clientKey.js';
import { getRateLimitStore } from './rateLimitStore.js';

export type PublicDataWindow = {
  /** The bucket name; the 429 body reports it. */
  scope: string;
  windowMs: number;
  maxRequests: number;
};

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** A signed-in caller by account; everyone else by IPv4 address or IPv6 /64. */
export const publicRequesterKey = (req: Request): string =>
  req.user?.id ? `user:${req.user.id}` : `ip:${clientKey(req.ip) ?? 'unknown'}`;

/** Express middleware that admits the request only while every window still has room. */
export const createPublicDataLimit =
  (...windows: PublicDataWindow[]) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const requester = publicRequesterKey(req);
    for (const w of windows) {
      let count: number;
      let resetAt: number;
      try {
        ({ count, resetAt } = await getRateLimitStore().hit(`${w.scope}:${requester}`, w.windowMs, w.maxRequests));
      } catch {
        continue; // fail open: a store hiccup never blocks a widget
      }
      if (count <= w.maxRequests) continue;
      const retryAfterMs = Math.max(0, resetAt - Date.now());
      const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.setHeader('RateLimit-Policy', `${w.scope};w=${Math.floor(w.windowMs / 1000)};q=${w.maxRequests}`);
      res.status(429).json({
        error: {
          message: `Rate limit exceeded for ${w.scope}. Retry in ${retryAfterSeconds}s.`,
          code: 'RATE_LIMITED',
          requestId: req.requestId,
          details: {
            scope: w.scope,
            limit: w.maxRequests,
            windowMs: w.windowMs,
            retryAfterMs,
            keyType: req.user?.id ? 'user' : 'ip'
          }
        }
      });
      return;
    }
    next();
  };

/** The windows for each public data route (exported for tests and docs). */
export const PUBLIC_DATA_WINDOWS = {
  unfurl: [{ scope: 'chat_unfurl', windowMs: MINUTE, maxRequests: 60 }],
  readUrl: [{ scope: 'chat_read_url', windowMs: MINUTE, maxRequests: 20 }],
  toolRefresh: [
    { scope: 'chat_tool_refresh', windowMs: MINUTE, maxRequests: 30 },
    { scope: 'chat_tool_refresh_day', windowMs: DAY, maxRequests: 300 }
  ]
} as const satisfies Record<string, readonly PublicDataWindow[]>;

export const unfurlLimit = createPublicDataLimit(...PUBLIC_DATA_WINDOWS.unfurl);
export const readUrlLimit = createPublicDataLimit(...PUBLIC_DATA_WINDOWS.readUrl);
export const toolRefreshLimit = createPublicDataLimit(...PUBLIC_DATA_WINDOWS.toolRefresh);

/**
 * Refreshable tools that spend a PLATFORM key with a paid quota (Foursquare places, the YouTube Data
 * API). Anonymous callers get the keyless tools only; a signed-in caller is counted per account above.
 */
export const SIGNED_IN_REFRESH_TOOLS: ReadonlySet<string> = new Set(['find_places', 'video_search']);
