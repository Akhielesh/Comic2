// Per-request account context via AsyncLocalStorage, so code deep inside tool
// execution (e.g. the provider usage meter) can attribute upstream API calls to
// the signed-in account without threading a userId through every call signature.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

const als = new AsyncLocalStorage<{ accountId: string | null }>();

/** The account id for the current request, or null (unauthenticated/background). */
export const currentAccountId = (): string | null => als.getStore()?.accountId ?? null;

/** Run fn with an explicit account context (tests, background jobs). */
export const runWithAccount = <T>(accountId: string | null, fn: () => T): T => als.run({ accountId }, fn);

/** Express middleware — mount AFTER auth so req.user is populated. */
export const attachAccountContext = (req: Request, _res: Response, next: NextFunction): void => {
  als.run({ accountId: req.user?.id ?? null }, next);
};
