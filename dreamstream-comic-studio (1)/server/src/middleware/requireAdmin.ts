import { NextFunction, Request, Response } from 'express';

const DEFAULT_ADMIN_EMAILS = ['admin@test.com'];

const parseAdminEmails = () => {
  const configured = process.env.ADMIN_EMAILS
    ?.split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);

  if (configured && configured.length > 0) {
    return configured;
  }

  return DEFAULT_ADMIN_EMAILS;
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  const userEmail = req.user?.email?.toLowerCase();

  if (!userEmail) {
    res.status(403).json({ error: { message: 'Admin access required' } });
    return;
  }

  const adminEmails = parseAdminEmails();
  if (!adminEmails.includes(userEmail)) {
    res.status(403).json({ error: { message: 'Admin access required' } });
    return;
  }

  next();
};
