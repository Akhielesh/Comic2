import { NextFunction, Request, Response } from 'express';

type ErrorLike = {
  code?: string;
  details?: unknown;
  message?: string;
  name?: string;
  publicCode?: string;
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
  if (isProduction && status >= 500) {
    return 'Unexpected server error';
  }

  return err?.message || 'Unexpected server error';
};

export const errorHandler = (err: ErrorLike, req: Request, res: Response, _next: NextFunction) => {
  const status = Number.isInteger(err?.status) ? Number(err.status) : 500;
  const code = getPublicErrorCode(status, err);

  const logEvent = {
    event: 'server_error',
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

  const errorResponse: {
    message: string;
    code: string;
    details?: unknown;
    internalCode?: string;
  } = {
    message: getClientMessage(status, err),
    code
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
