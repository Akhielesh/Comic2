import { Request, Response, NextFunction } from 'express';
import { getBillingSummary } from '../services/billingLedger.js';
import { allowedProviderFilter } from './keys.js';

type ProviderKey = 'gemini' | 'pixazo' | 'ideogram';

const providerKeyLabels: Record<ProviderKey, string> = {
  gemini: 'X-Gemini-Key',
  pixazo: 'X-Pixazo-Key',
  ideogram: 'X-Ideogram-Key'
};

export const checkLimits = (requiredProvider: ProviderKey) => async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user?.id) {
    res.status(401).json({ error: { message: 'User not authenticated' } });
    return;
  }

  const label = providerKeyLabels[requiredProvider];
  // Account keys are resolved before this middleware and do not appear in raw
  // headers. Use the same selected credential as the image route, including its
  // ownership flag and source governance; platform keys cannot bypass billing.
  const hasRequiredProviderKey = allowedProviderFilter(req)(requiredProvider)
    && req.apiKeys?.[`${requiredProvider}Byok`] === true
    && Boolean(req.apiKeys?.[`${requiredProvider}Key`]?.trim());

  if (hasRequiredProviderKey) {
    next();
    return;
  }

  try {
    const summary = await getBillingSummary(req.user.id);
    const outOfDaily = summary.usage.dailyRemainingCt <= 0;
    const outOfBalance = summary.wallet.availableCt <= 0;

    if (outOfDaily || outOfBalance) {
      res.status(402).json({
        error: {
          message: `Usage limit reached. Add credits, upgrade, or provide ${label} (BYOK) to continue now.`,
          code: 'BILLING_LIMIT_REACHED',
          details: {
            planTier: summary.plan.id,
            dailyRemainingCt: summary.usage.dailyRemainingCt,
            availableCt: summary.wallet.availableCt,
            dailyResetAt: summary.usage.dailyResetAt,
            monthlyResetAt: summary.usage.monthlyResetAt,
            options: {
              canUpgrade: true,
              canAddCredits: true,
              canWaitForReset: true,
              canUseByok: true
            }
          }
        }
      });
      return;
    }

    next();
  } catch (error) {
    console.error('[LIMITS] Failed to evaluate token limits. Allowing request with route-level enforcement.', error);
    next();
  }
};

export const trackUsage = async (_req: Request, _res: Response, next: NextFunction) => {
  next();
};

// Legacy helper retained for older call sites. CT usage is now settled via billing ledger.
export const incrementUserUsage = async (_userId: string) => {
  return 0;
};
