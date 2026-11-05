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
// open, as there. routes/learn.ts reuses createPublicDataLimit for the SQL playground.
//
// Sized against what the client really sends, not against one widget. An anonymous caller is a stale
// session or a script (and many people can share one IPv4 address), so it gets the tighter numbers:
//   - unfurl and reader mode are memoised per URL (services/chatApi.ts), but the news list (signed-in
//     chat, dashboards and gallery only) prefetches an article on HOVER and focus, so moving down a
//     long list spends one reader call per new link: reader mode is 60/min signed in, 20/min
//     anonymous (each read is the heaviest unauthenticated request on the main thread). Unfurl, a
//     small page head, is 60/min for everyone.
//   - widget refresh counts every tile on every tick: Dashboards re-runs every data tile of the open
//     board AT ONCE, on open and every 5 min while the tab is visible (12 calls/h per tile), and a live
//     monitor refreshes as often as every 30 s (120 calls/h). Boards have no tile cap, so a signed-in
//     account gets a 120/min burst window (a 40-tile board plus monitors in one minute); anonymous
//     callers keep 30/min. The daily window is 300 anonymous and 10,000 signed in, above a 10-tile
//     board plus two 30 s monitors left open around the clock (8,640), so it never stops a real
//     dashboard. The paid-key tools need sign-in (SIGNED_IN_REFRESH_TOOLS below) and their spend is
//     bounded by the provider budgets in ai/tools (DreamStream session), not by this window.

import type { NextFunction, Request, Response } from 'express';
import { clientKey } from '../lib/clientKey.js';
import { getRateLimitStore } from './rateLimitStore.js';

export type PublicDataWindow = {
  /** The bucket name; the 429 body reports it. */
  scope: string;
  windowMs: number;
  maxRequests: number;
  /** Count only these callers (default: everyone). */
  appliesTo?: 'anonymous' | 'signedIn';
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
    const audience = req.user?.id ? 'signedIn' : 'anonymous';
    for (const w of windows) {
      if (w.appliesTo && w.appliesTo !== audience) continue;
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
  readUrl: [
    { scope: 'chat_read_url', windowMs: MINUTE, maxRequests: 20, appliesTo: 'anonymous' },
    { scope: 'chat_read_url', windowMs: MINUTE, maxRequests: 60, appliesTo: 'signedIn' }
  ],
  toolRefresh: [
    { scope: 'chat_tool_refresh', windowMs: MINUTE, maxRequests: 30, appliesTo: 'anonymous' },
    { scope: 'chat_tool_refresh', windowMs: MINUTE, maxRequests: 120, appliesTo: 'signedIn' },
    { scope: 'chat_tool_refresh_day', windowMs: DAY, maxRequests: 300, appliesTo: 'anonymous' },
    { scope: 'chat_tool_refresh_day', windowMs: DAY, maxRequests: 10_000, appliesTo: 'signedIn' }
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
