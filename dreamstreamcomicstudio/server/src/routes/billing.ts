import { Router } from 'express';
import type { CreditPackId, PurchasablePlanTier, TokenEstimateRequest } from '../../../shared/types/billing.js';
import { estimateCharge } from '../services/costEstimator.js';
import {
  getBillingSummary,
  getComicCostReport,
  listUsageHistory,
  reserveUsageTokens,
  settleReservation,
  updateAutoReloadSettings,
  upsertPaymentProfile
} from '../services/billingLedger.js';
import { getPricingCatalog } from '../services/pricingCatalog.js';
import {
  assertCreditPackId,
  assertPurchasableTier,
  cancelSubscriptionAtPeriodEnd,
  createBillingPortalSession,
  createCreditPackCheckoutSession,
  createPlanCheckoutSession,
  createSetupIntent,
  ensureStripeCustomer,
  getSubscriptionStatus,
  isStripeConfigured,
  reactivateSubscription
} from '../services/stripe.js';

export const billingRouter = Router();

const requireAuthUser = (user: { id: string; email?: string } | undefined) => {
  if (!user?.id) {
    const error = new Error('User not authenticated') as Error & { status?: number; publicCode?: string };
    error.status = 401;
    error.publicCode = 'UNAUTHORIZED';
    throw error;
  }
  return user;
};

const requireStripe = () => {
  if (!isStripeConfigured()) {
    const error = new Error('Stripe is not configured on this deployment.') as Error & { status?: number; publicCode?: string };
    error.status = 503;
    error.publicCode = 'STRIPE_NOT_CONFIGURED';
    throw error;
  }
};

const parseLimit = (value: unknown) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 100;
  return Math.max(1, Math.min(500, Math.floor(parsed)));
};

const parseTokenEstimateRequest = (body: unknown): TokenEstimateRequest => {
  if (!body || typeof body !== 'object') {
    throw Object.assign(new Error('Invalid estimate payload'), { status: 400, publicCode: 'BAD_REQUEST' });
  }

  const input = body as Record<string, unknown>;
  if (!input.provider || !input.model || !input.operation) {
    throw Object.assign(new Error('provider, model, and operation are required'), { status: 400, publicCode: 'BAD_REQUEST' });
  }

  return input as unknown as TokenEstimateRequest;
};

const parseCheckoutPlanTier = (value: unknown): PurchasablePlanTier => {
  try {
    return assertPurchasableTier(value);
  } catch {
    throw Object.assign(new Error('Invalid plan tier. Allowed values: creator, pro, studio.'), { status: 400, publicCode: 'BAD_REQUEST' });
  }
};

const parseCreditPackId = (value: unknown): CreditPackId => {
  try {
    return assertCreditPackId(value);
  } catch {
    throw Object.assign(new Error('Invalid credit pack ID. Allowed values: pack_10, pack_25, pack_100.'), { status: 400, publicCode: 'BAD_REQUEST' });
  }
};

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
    const user = requireAuthUser(req.user);
    const summary = await getBillingSummary(user.id);
    res.json(summary);
  } catch (error) {
    next(error);
  }
});

billingRouter.get('/subscription-status', async (req, res, next) => {
  try {
    const user = requireAuthUser(req.user);
    const status = await getSubscriptionStatus(user.id);
    res.json(status);
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/subscription/cancel', async (req, res, next) => {
  try {
    const user = requireAuthUser(req.user);
    requireStripe();
    const status = await cancelSubscriptionAtPeriodEnd(user.id);
    res.json(status);
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/subscription/reactivate', async (req, res, next) => {
  try {
    const user = requireAuthUser(req.user);
    requireStripe();
    const status = await reactivateSubscription(user.id);
    res.json(status);
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/portal', async (req, res, next) => {
  try {
    const user = requireAuthUser(req.user);
    requireStripe();

    const returnUrl = typeof req.body?.returnUrl === 'string' && req.body.returnUrl.trim()
      ? req.body.returnUrl.trim()
      : undefined;

    const session = await createBillingPortalSession({
      userId: user.id,
      email: user.email,
      returnUrl
    });

    res.json({ url: session.url });
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/estimate', async (req, res, next) => {
  try {
    const input = parseTokenEstimateRequest(req.body);
    const estimate = await estimateCharge(input);
    res.json(estimate);
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/reserve', async (req, res, next) => {
  try {
    const user = requireAuthUser(req.user);
    const estimateInput = parseTokenEstimateRequest(req.body);
    const estimate = await estimateCharge(estimateInput);

    const payload = req.body as Record<string, unknown>;
    const result = await reserveUsageTokens({
      userId: user.id,
      estimate,
      provider: String(payload.provider || 'internal'),
      model: String(payload.model || 'unknown'),
      operation: String(payload.operation || 'manual_reserve'),
      projectId: typeof payload.projectId === 'string' ? payload.projectId : undefined,
      comicId: typeof payload.comicId === 'string' ? payload.comicId : undefined,
      stage: typeof payload.stage === 'string' ? payload.stage : undefined,
      byok: payload.byok === true,
      metadata: typeof payload.metadata === 'object' && payload.metadata ? payload.metadata as Record<string, unknown> : undefined
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
    const user = requireAuthUser(req.user);

    const body = req.body as Record<string, unknown>;
    const reservationId = typeof body.reservationId === 'string' ? body.reservationId : undefined;
    const estimatedCt = Number(body.estimatedCt || 0);
    const actualEstimate = parseTokenEstimateRequest(body.actualEstimate);
    const actual = await estimateCharge(actualEstimate);

    const settled = await settleReservation({
      userId: user.id,
      reservationId,
      estimatedCt,
      actual,
      operation: String(body.operation || 'manual_settle'),
      provider: String(body.provider || 'internal'),
      model: String(body.model || 'unknown'),
      projectId: typeof body.projectId === 'string' ? body.projectId : undefined,
      metadata: typeof body.metadata === 'object' && body.metadata ? body.metadata as Record<string, unknown> : undefined,
      byokBypass: body.byokBypass === true
    });

    res.json(settled);
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/setup-payment-method', async (req, res, next) => {
  try {
    const user = requireAuthUser(req.user);
    requireStripe();

    const customer = await ensureStripeCustomer(user.id, user.email);
    const setupIntent = await createSetupIntent(customer.id, user.id);

    await upsertPaymentProfile(user.id, {
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

billingRouter.post('/checkout/subscription', async (req, res, next) => {
  try {
    const user = requireAuthUser(req.user);
    requireStripe();
    if (!user.email) {
      throw Object.assign(new Error('Authenticated user email is required'), { status: 401, publicCode: 'UNAUTHORIZED' });
    }

    const planTier = parseCheckoutPlanTier(req.body?.planTier);
    const session = await createPlanCheckoutSession({
      userId: user.id,
      email: user.email,
      planTier
    });

    res.json({ url: session.url, id: session.id });
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/checkout/credits', async (req, res, next) => {
  try {
    const user = requireAuthUser(req.user);
    requireStripe();
    if (!user.email) {
      throw Object.assign(new Error('Authenticated user email is required'), { status: 401, publicCode: 'UNAUTHORIZED' });
    }

    const packId = parseCreditPackId(req.body?.packId);
    const session = await createCreditPackCheckoutSession({
      userId: user.id,
      email: user.email,
      packId
    });

    res.json({ url: session.url, id: session.id });
  } catch (error) {
    next(error);
  }
});

billingRouter.post('/add-credits', async (_req, res) => {
  res.status(410).json({
    error: {
      message: 'Direct credit grants are deprecated. Use /api/billing/checkout/credits.',
      code: 'ENDPOINT_DEPRECATED'
    }
  });
});

billingRouter.post('/auto-reload', async (req, res, next) => {
  try {
    const user = requireAuthUser(req.user);
    const enabled = req.body?.enabled === true;

    if (enabled) {
      return res.status(409).json({
        error: {
          message: 'Auto-reload is disabled by policy. Confirm each purchase via Stripe Checkout.',
          code: 'AUTO_RELOAD_DISABLED'
        }
      });
    }

    const updated = await updateAutoReloadSettings({
      userId: user.id,
      enabled: false,
      thresholdCt: undefined,
      packUsd: undefined
    });

    res.json(updated);
  } catch (error) {
    next(error);
  }
});

billingRouter.get('/usage-history', async (req, res, next) => {
  try {
    const user = requireAuthUser(req.user);
    const history = await listUsageHistory(user.id, parseLimit(req.query.limit));
    res.json({ items: history });
  } catch (error) {
    next(error);
  }
});

billingRouter.get('/comic-cost/:comicId', async (req, res, next) => {
  try {
    const user = requireAuthUser(req.user);
    const report = await getComicCostReport(user.id, req.params.comicId);
    res.json(report);
  } catch (error) {
    next(error);
  }
});

// Backward-compatible alias; strict validation still applies.
billingRouter.post('/checkout-plan', async (req, res, next) => {
  try {
    const user = requireAuthUser(req.user);
    requireStripe();
    if (!user.email) {
      throw Object.assign(new Error('Authenticated user email is required'), { status: 401, publicCode: 'UNAUTHORIZED' });
    }

    const planTier = parseCheckoutPlanTier(req.body?.planTier);
    const session = await createPlanCheckoutSession({
      userId: user.id,
      email: user.email,
      planTier
    });

    res.json({ url: session.url, id: session.id });
  } catch (error) {
    next(error);
  }
});

