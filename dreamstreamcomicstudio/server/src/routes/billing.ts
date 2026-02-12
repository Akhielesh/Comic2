import { Router } from 'express';
import type { TokenEstimateRequest } from '../../../shared/types/billing.js';
import { estimateCharge } from '../services/costEstimator.js';
import {
  addPurchasedCredits,
  getBillingSummary,
  getComicCostReport,
  listUsageHistory,
  reserveUsageTokens,
  settleReservation,
  updateAutoReloadSettings,
  upsertPaymentProfile
} from '../services/billingLedger.js';
import { getCreditPackByUsd, getPricingCatalog } from '../services/pricingCatalog.js';
import {
  createCreditPackPaymentIntent,
  createPlanCheckoutSession,
  createSetupIntent,
  ensureStripeCustomer,
  isStripeConfigured
} from '../services/stripe.js';

export const billingRouter = Router();

billingRouter.get('/pricing-catalog', async (_req, res, next) => {
  try {
    const catalog = await getPricingCatalog();
    res.json(catalog);
  } catch (error) {
    next(error);
  }
});

billingRouter.get('/summary', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }
    const summary = await getBillingSummary(req.user.id);
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/estimate', async (req, res, next) => {
  try {
    const input = req.body as TokenEstimateRequest;
    if (!input || typeof input !== 'object') {
      return res.status(400).json({ error: { message: 'Invalid estimate payload' } });
    }
    if (!input.provider || !input.model || !input.operation) {
      return res.status(400).json({ error: { message: 'provider, model, and operation are required' } });
    }

    const estimate = await estimateCharge(input);
    res.json(estimate);
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/reserve', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }

    const estimate = await estimateCharge(req.body as TokenEstimateRequest);
    const result = await reserveUsageTokens({
      userId: req.user.id,
      estimate,
      provider: String(req.body?.provider || 'internal'),
      model: String(req.body?.model || 'unknown'),
      operation: String(req.body?.operation || 'manual_reserve'),
      projectId: typeof req.body?.projectId === 'string' ? req.body.projectId : undefined,
      comicId: typeof req.body?.comicId === 'string' ? req.body.comicId : undefined,
      stage: typeof req.body?.stage === 'string' ? req.body.stage : undefined,
      byok: req.body?.byok === true,
      metadata: req.body?.metadata
    });

    if ('details' in result) {
      return res.status(402).json({
        error: {
          message: 'Billing limit exceeded',
          code: 'BILLING_LIMIT_EXCEEDED',
          details: result.details
        }
      });
    }

    res.json({ allowed: true, reservation: result.reservation });
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/settle', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }

    const body = req.body || {};
    const reservationId = typeof body.reservationId === 'string' ? body.reservationId : undefined;
    const estimatedCt = Number(body.estimatedCt || 0);
    const actual = await estimateCharge(body.actualEstimate as TokenEstimateRequest);

    const settled = await settleReservation({
      userId: req.user.id,
      reservationId,
      estimatedCt,
      actual,
      operation: String(body.operation || 'manual_settle'),
      provider: String(body.provider || 'internal'),
      model: String(body.model || 'unknown'),
      projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
      metadata: body.metadata,
      byokBypass: body.byokBypass === true
    });

    res.json(settled);
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/setup-payment-method', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }

    if (!isStripeConfigured()) {
      return res.status(503).json({
        error: {
          message: 'Stripe is not configured on this deployment.',
          code: 'STRIPE_NOT_CONFIGURED'
        }
      });
    }

    const customer = await ensureStripeCustomer(req.user.id, req.user.email);
    const setupIntent = await createSetupIntent(customer.id, req.user.id);

    await upsertPaymentProfile(req.user.id, {
      stripe_customer_id: customer.id,
      has_payment_method: false,
      overage_enabled: true
    });

    res.json({
      customerId: customer.id,
      setupIntentClientSecret: setupIntent.client_secret
    });
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/add-credits', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }

    const packUsd = Number(req.body?.packUsd);
    const pack = getCreditPackByUsd(packUsd);
    if (!pack) {
      return res.status(400).json({ error: { message: 'Invalid credit pack amount' } });
    }

    const simulate = req.body?.simulate === true || !isStripeConfigured();
    if (simulate) {
      const added = await addPurchasedCredits({
        userId: req.user.id,
        ctAmount: pack.ct,
        usdAmount: pack.usd,
        source: 'manual_credit_purchase',
        metadata: { mode: 'simulated' }
      });
      return res.json({
        mode: 'simulated',
        addedCt: pack.ct,
        chargedUsd: pack.usd,
        ...added
      });
    }

    const customer = await ensureStripeCustomer(req.user.id, req.user.email);
    const paymentIntent = await createCreditPackPaymentIntent({
      customerId: customer.id,
      userId: req.user.id,
      packUsd: pack.usd,
      packCt: pack.ct
    });

    await upsertPaymentProfile(req.user.id, {
      stripe_customer_id: customer.id,
      overage_enabled: true
    });

    res.json({
      mode: 'payment_intent',
      paymentIntentId: paymentIntent.id,
      clientSecret: paymentIntent.client_secret,
      pack
    });
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/auto-reload', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }

    const enabled = req.body?.enabled === true;
    const thresholdCt = typeof req.body?.thresholdCt === 'number' ? req.body.thresholdCt : undefined;
    const packUsd = typeof req.body?.packUsd === 'number' ? req.body.packUsd : undefined;

    const updated = await updateAutoReloadSettings({
      userId: req.user.id,
      enabled,
      thresholdCt,
      packUsd
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

billingRouter.get('/usage-history', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }

    const limit = Number(req.query.limit || 100);
    const history = await listUsageHistory(req.user.id, limit);
    res.json({ items: history });
  } catch (error) {
    next(error);
  }
});

billingRouter.get('/comic-cost/:comicId', async (req, res, next) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ error: { message: 'User not authenticated' } });
    }

    const report = await getComicCostReport(req.user.id, req.params.comicId);
    res.json(report);
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/checkout-plan', async (req, res, next) => {
  try {
    if (!req.user?.id || !req.user.email) {
      return res.status(401).json({ error: { message: 'Authenticated user email is required' } });
    }

    if (!isStripeConfigured()) {
      return res.status(503).json({
        error: {
          message: 'Stripe is not configured on this deployment.',
          code: 'STRIPE_NOT_CONFIGURED'
        }
      });
    }

    const planTier = typeof req.body?.planTier === 'string' ? req.body.planTier : 'pro';
    const session = await createPlanCheckoutSession({
      userId: req.user.id,
      email: req.user.email,
      planTier
    });

    res.json({ url: session.url, id: session.id });
  } catch (error) {
    next(error);
  }
});

export default billingRouter;
