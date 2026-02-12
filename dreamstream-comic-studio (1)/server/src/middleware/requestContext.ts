import crypto from 'node:crypto';
import { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

const REQUEST_ID_HEADER = 'X-Request-Id';

const sanitizeRequestId = (value?: string | null) => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 128);
};

const resolveRequestId = (req: Request) => {
  const incoming = sanitizeRequestId(req.header(REQUEST_ID_HEADER));
  return incoming || crypto.randomUUID();
};

export const attachRequestContext = (req: Request, res: Response, next: NextFunction) => {
  req.requestId = resolveRequestId(req);
  res.setHeader(REQUEST_ID_HEADER, req.requestId);
  next();
};

export const requestLogger = (req: Request, res: Response, next: NextFunction) => {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    console.info(
      JSON.stringify({
        event: 'http_request',
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        latencyMs: Number(elapsedMs.toFixed(2)),
        userId: req.user?.id ?? null,
        ip: req.ip
      })
    );
  });
  next();
};
