import { NextFunction, Request, Response } from 'express';
import { resolveAccessProfile } from '../services/rbac.js';

declare module 'express-serve-static-core' {
  interface Request {
    accessProfile?: {
      isAdmin: boolean;
      isModerator: boolean;
      bootstrapAdmin: boolean;
      roles: Array<'admin' | 'moderator'>;
    };
  }
}

const unauthorized = (res: Response) => {
  res.status(403).json({ error: { message: 'Admin access required' } });
};

export const hydrateAccessProfile = async (req: Request) => {
  if (req.accessProfile) return req.accessProfile;
  if (!req.user?.id) {
    req.accessProfile = {
      isAdmin: false,
      isModerator: false,
      bootstrapAdmin: false,
      roles: []
    };
    return req.accessProfile;
  }

  const profile = await resolveAccessProfile({
    userId: req.user.id,
    email: req.user.email
  });
  req.accessProfile = profile;
  return profile;
};

export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user?.id) {
    unauthorized(res);
    return;
  }

  const profile = await hydrateAccessProfile(req);
  if (!profile.isAdmin) {
    unauthorized(res);
    return;
  }

  next();
};

export const requireModerator = async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user?.id) {
    res.status(403).json({ error: { message: 'Moderator access required' } });
    return;
  }

  const profile = await hydrateAccessProfile(req);
  if (!profile.isModerator) {
    res.status(403).json({ error: { message: 'Moderator access required' } });
    return;
  }

  next();
};
