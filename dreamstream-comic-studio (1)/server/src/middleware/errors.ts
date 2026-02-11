import { Request, Response, NextFunction } from 'express';

export const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction) => {
  const message = err?.message || 'Unexpected server error';
  const status = err?.status || 500;

  // Log the error for debugging
  console.error('[SERVER ERROR]', err);

  res.status(status).json({
    error: {
      message,
      code: err?.code,
      details: err?.details
    }
  });
};
