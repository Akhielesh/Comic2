import { NextFunction, Request, Response } from 'express';
import { recordServerError } from '../services/telemetryStore.js';

type ErrorLike = {
  code?: string;
  details?: unknown;
  message?: string;
  name?: string;
  publicCode?: string;
  /** A message safe to show the user even in production (e.g. an upstream model timeout). */
  publicMessage?: string;
  stack?: string;
  status?: number;
};

const PUBLIC_CODE_BY_STATUS: Record<number, string> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT'
};

const isProduction = process.env.NODE_ENV === 'production';

const getPublicErrorCode = (status: number, err: ErrorLike): string => {
  if (typeof err.publicCode === 'string' && err.publicCode.trim()) {
    return err.publicCode;
  }

  return PUBLIC_CODE_BY_STATUS[status] || 'INTERNAL_ERROR';
};

const getClientMessage = (status: number, err: ErrorLike): string => {
  // An explicitly user-safe message (e.g. "the model was too slow") is shown as-is, even
  // in production — it carries no internal detail and is actionable for the user.
  if (typeof err.publicMessage === 'string' && err.publicMessage.trim()) {
    return err.publicMessage;
  }
  if (isProduction && status >= 500) {
    return 'Unexpected server error';
  }

  return err?.message || 'Unexpected server error';
};

export const errorHandler = (err: ErrorLike, req: Request, res: Response, _next: NextFunction) => {
  // Map the typed free-only block error to HTTP 402 with a clear payload so the
  // client can surface "Block + explain" UX (no silent paid fallback under free-only).
  if (err && (err.code === 'NO_FREE_MODEL_AVAILABLE' || err.name === 'NoFreeModelAvailableError')) {
    res.status(402).json({
      error: {
        code: 'NO_FREE_MODEL_AVAILABLE',
        message: err.message || 'No genuinely-free model is currently available. Free-only mode is on, so the request was blocked.',
        details: err.details,
        requestId: req.requestId
      }
    });
    return;
  }

  const status = Number.isInteger(err?.status) ? Number(err.status) : 500;
  const code = getPublicErrorCode(status, err);

  const logEvent = {
    ts: new Date().toISOString(),
    event: 'server_error',
    requestId: req.requestId,
    path: req.originalUrl,
    method: req.method,
    status,
    code,
    message: err?.message,
    details: err?.details,
    name: err?.name,
    stack: err?.stack
  };

  // Keep complete error detail only in logs.
  console.error(JSON.stringify(logEvent));

  // Persist genuine server failures (5xx) to the telemetry store so "every failed
  // request" lands alongside client-reported failures for triage. Fire-and-forget:
  // routine 4xx (auth/validation) are skipped to avoid flooding the table. A model
  // timeout is an UPSTREAM/model condition (already captured client-side as chat_failed),
  // not a server fault — excluding it keeps server_error meaningful for real bugs.
  if (status >= 500 && err.publicCode !== 'MODEL_TIMEOUT') {
    recordServerError({
      requestId: req.requestId,
      path: req.originalUrl,
      method: req.method,
      status,
      code,
      message: err?.message,
      userId: req.user?.id ?? null,
      ip: req.ip
    });
  }

  const errorResponse: {
    message: string;
    code: string;
    requestId?: string;
    details?: unknown;
    internalCode?: string;
  } = {
    message: getClientMessage(status, err),
    code,
    requestId: req.requestId
  };

  if (!isProduction) {
    errorResponse.details = err?.details;
    if (typeof err?.code === 'string' && err.code.trim()) {
      errorResponse.internalCode = err.code;
    }
  }

  res.status(status).json({
    error: errorResponse
  });
};
