// Free-only request middleware.
//
// Reads `X-Free-Only: true` from incoming requests and stamps req.freeOnly so
// downstream routes / autoRouter can enforce strict free-only model selection
// and never silently fall back to a paid model. The client (account / project
// setting in localStorage; persisted profile flag is a follow-up) attaches the
// header to every /api/* call when the user has turned free-only mode on.

import { Request, Response, NextFunction } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    /** True when the user has free-only mode enabled. Drives autoRouter and routes/image. */
    freeOnly?: boolean;
  }
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export const attachFreeOnly = (req: Request, _res: Response, next: NextFunction) => {
  const header = (req.header('X-Free-Only') || '').trim().toLowerCase();
  req.freeOnly = TRUE_VALUES.has(header);
  next();
};

/** Build the costPref for a request. Honors free-only header strictly. */
export const costPrefFromRequest = (
  req: Request,
  fallback: 'free' | 'cheap' | 'quality' = 'free'
): 'free' | 'cheap' | 'quality' | 'free-only' => (req.freeOnly ? 'free-only' : fallback);
