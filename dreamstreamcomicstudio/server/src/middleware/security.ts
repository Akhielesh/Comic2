import { NextFunction, Request, Response } from 'express';

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'"
].join('; ');

const isHttpsRequest = (req: Request) => {
  if (req.secure) return true;
  const forwardedProto = req.header('x-forwarded-proto');
  return typeof forwardedProto === 'string' && forwardedProto.split(',')[0].trim().toLowerCase() === 'https';
};

export const applySecurityHeaders = (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // microphone=(self): voice dictation captures audio in-page and transcribes it
  // on-device (services/dictation) — no audio ever leaves the browser.
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('X-DNS-Prefetch-Control', 'off');

  if (isHttpsRequest(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  next();
};
