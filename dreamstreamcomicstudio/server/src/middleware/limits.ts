import { Request, Response, NextFunction } from 'express';
import { getBillingSummary } from '../services/billingLedger.js';

type ProviderKey = 'gemini' | 'pixazo' | 'ideogram';

const providerKeyConfig: Record<ProviderKey, { headers: string[]; label: string }> = {
  gemini: {
    headers: ['X-Gemini-Key'],
    label: 'X-Gemini-Key'
  },
  pixazo: {
    headers: ['X-Pixazo-Key', 'X-Flux-Key'],
    label: 'X-Pixazo-Key'
  },
  ideogram: {
    headers: ['X-Ideogram-Key'],
    label: 'X-Ideogram-Key'
  }
};

export const checkLimits = (requiredProvider: ProviderKey) => async (req: Request, res: Response, next: NextFunction) => {
  if (!req.user?.id) {
    res.status(401).json({ error: { message: 'User not authenticated' } });
    return;
  }

  const { headers, label } = providerKeyConfig[requiredProvider];
  const hasRequiredProviderKey = headers.some((header) => !!req.header(header));

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
