import Stripe from 'stripe';
import type { BillingInterval, BillingPlanTier, BillingSubscriptionStatus, CreditPackId, PurchasablePlanTier } from '../../../shared/types/billing.js';
import { addPurchasedCredits, setUserPlanTier, upsertPaymentProfile } from './billingLedger.js';
import { getCreditPackById } from './pricingCatalog.js';
import { getSupabaseAdmin } from './supabase.js';
import {
  resolveCreditPackFromStripePriceId,
  resolveCreditPackStripePriceId,
  resolvePlanFromStripePriceId,
  resolvePlanStripePriceId
} from './stripePriceConfig.js';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecretKey
  ? new Stripe(stripeSecretKey, { apiVersion: '2026-01-28.clover' })
  : null;

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const BILLING_PORTAL_RETURN_URL = process.env.STRIPE_BILLING_PORTAL_RETURN_URL || `${CLIENT_URL}/settings?tab=billing`;
const WEBHOOK_MAX_AGE_SECONDS = Number(process.env.STRIPE_WEBHOOK_MAX_AGE_SECONDS || '86400');

const PURCHASABLE_TIERS: PurchasablePlanTier[] = ['creator', 'pro', 'studio'];

const isPurchasablePlanTier = (value: unknown): value is PurchasablePlanTier =>
  typeof value === 'string' && PURCHASABLE_TIERS.includes(value as PurchasablePlanTier);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const assertStripe = () => {
  if (!stripe) {
    throw new Error('Stripe configuration missing (STRIPE_SECRET_KEY).');
  }
  return stripe;
};

const toBillingTier = (value: unknown): BillingPlanTier => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : 'free';
  if (normalized === 'free' || normalized === 'creator' || normalized === 'pro' || normalized === 'studio' || normalized === 'custom' || normalized === 'admin') {
    return normalized;
  }
  return 'free';
};

const isBillingInterval = (value: unknown): value is BillingInterval =>
  value === 'month' || value === 'year';

const toBillingInterval = (value: unknown): BillingInterval | undefined =>
  isBillingInterval(value) ? value : undefined;

const toIsoOrUndefined = (value?: number | null) => {
  if (!value || !Number.isFinite(value)) return undefined;
  return new Date(value * 1000).toISOString();
};

const nowIso = () => new Date().toISOString();

const getAdmin = () => getSupabaseAdmin();

const getSubscriptionPeriodWindow = (subscription: Stripe.Subscription) => {
  const firstItem = subscription.items.data[0];
  const start = typeof firstItem?.current_period_start === 'number' ? firstItem.current_period_start : null;
  const end = typeof firstItem?.current_period_end === 'number' ? firstItem.current_period_end : null;
  return { start, end };
};

const getInvoiceSubscriptionId = (invoice: Stripe.Invoice): string | null => {
  const fromParent = invoice.parent?.subscription_details?.subscription;
  if (typeof fromParent === 'string') return fromParent;
  if (fromParent && typeof fromParent === 'object' && typeof fromParent.id === 'string') {
    return fromParent.id;
  }
  return null;
};

const findUserIdBySubscriptionId = async (subscriptionId: string): Promise<string | null> => {
  const admin = getAdmin();
  const { data, error } = await admin
    .from('user_plan_subscriptions')
    .select('user_id')
    .eq('stripe_subscription_id', subscriptionId)
    .maybeSingle();

  if (error || !data) return null;
  const userId = (data as Record<string, unknown>).user_id;
  return typeof userId === 'string' ? userId : null;
};

const getUserSubscriptionRow = async (userId: string) => {
  const admin = getAdmin();
  const { data, error } = await admin
    .from('user_plan_subscriptions')
    .select('plan_tier, status, stripe_subscription_id, stripe_status, cancel_at_period_end, cancel_requested_at, canceled_at, current_period_start, current_period_end, metadata')
    .eq('user_id', userId)
    .maybeSingle();

  if (error || !data) return null;
  return data as Record<string, unknown>;
};

const hasProcessedCreditCheckout = async (userId: string, checkoutSessionId: string) => {
  const admin = getAdmin();
  const { data, error } = await admin
    .from('token_ledger_entries')
    .select('id')
    .eq('user_id', userId)
    .eq('entry_type', 'CREDIT_PURCHASE')
    .contains('metadata', { checkoutSessionId })
    .limit(1);

  if (error) return false;
  return Array.isArray(data) && data.length > 0;
};

const upsertSubscriptionState = async (input: {
  userId: string;
  planTier: BillingPlanTier;
  status: string;
  stripeSubscriptionId?: string;
  stripeStatus?: string;
  cancelAtPeriodEnd?: boolean;
  cancelRequestedAt?: string | null;
  canceledAt?: string | null;
  currentPeriodStart?: string | null;
  currentPeriodEnd?: string | null;
  metadata?: Record<string, unknown>;
}) => {
  const admin = getAdmin();
  await admin
    .from('user_plan_subscriptions')
    .upsert({
      user_id: input.userId,
      plan_tier: input.planTier,
      status: input.status,
      stripe_subscription_id: input.stripeSubscriptionId || null,
      stripe_status: input.stripeStatus || null,
      cancel_at_period_end: input.cancelAtPeriodEnd === true,
      cancel_requested_at: input.cancelRequestedAt || null,
      canceled_at: input.canceledAt || null,
      current_period_start: input.currentPeriodStart || null,
      current_period_end: input.currentPeriodEnd || null,
      metadata: input.metadata || {},
      updated_at: nowIso()
    }, { onConflict: 'user_id' });
};

const upsertWebhookProcessingState = async (eventId: string, eventType: string) => {
  const admin = getAdmin();
  const { data, error } = await admin
    .from('stripe_webhook_events')
    .select('status')
    .eq('event_id', eventId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const status = typeof data?.status === 'string' ? data.status : undefined;
  if (status === 'processed') {
    return { alreadyProcessed: true };
  }

  if (data) {
    await admin
      .from('stripe_webhook_events')
      .update({
        event_type: eventType,
        status: 'processing',
        processed_at: null,
        error: null,
        updated_at: nowIso()
      })
      .eq('event_id', eventId);
    return { alreadyProcessed: false };
  }

  await admin
    .from('stripe_webhook_events')
    .insert({
      event_id: eventId,
      event_type: eventType,
      status: 'processing',
      received_at: nowIso(),
      updated_at: nowIso()
    });

  return { alreadyProcessed: false };
};

const markWebhookProcessed = async (eventId: string) => {
  const admin = getAdmin();
  await admin
    .from('stripe_webhook_events')
    .update({
      status: 'processed',
      processed_at: nowIso(),
      error: null,
      updated_at: nowIso()
    })
    .eq('event_id', eventId);
};

const markWebhookFailed = async (eventId: string, errorMessage: string) => {
  const admin = getAdmin();
  await admin
    .from('stripe_webhook_events')
    .update({
      status: 'failed',
      processed_at: nowIso(),
      error: errorMessage,
      updated_at: nowIso()
    })
    .eq('event_id', eventId);
};

const syncPaymentMethodFromSetupIntent = async (setupIntent: Stripe.SetupIntent) => {
  const userId = setupIntent.metadata?.userId || '';
  if (!userId) return;

  const paymentMethodId = typeof setupIntent.payment_method === 'string'
    ? setupIntent.payment_method
    : setupIntent.payment_method?.id;

  if (!paymentMethodId) return;

  const customerId = typeof setupIntent.customer === 'string' ? setupIntent.customer : setupIntent.customer?.id;
  const client = assertStripe();
  const paymentMethod = await client.paymentMethods.retrieve(paymentMethodId);

  if (customerId) {
    await client.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId }
    });
  }

  await upsertPaymentProfile(userId, {
    stripe_customer_id: customerId || undefined,
    default_payment_method_id: paymentMethodId,
    has_payment_method: true,
    overage_enabled: true,
    payment_method_brand: paymentMethod.card?.brand || null,
    payment_method_last4: paymentMethod.card?.last4 || null
  });
};

const syncPaymentMethodFromPaymentIntent = async (intent: Stripe.PaymentIntent, userId: string) => {
  const paymentMethodId = typeof intent.payment_method === 'string'
    ? intent.payment_method
    : intent.payment_method?.id;
  const customerId = typeof intent.customer === 'string' ? intent.customer : intent.customer?.id;

  if (!paymentMethodId) {
    if (customerId) {
      await upsertPaymentProfile(userId, {
        stripe_customer_id: customerId
      });
    }
    return;
  }

  const client = assertStripe();
  const paymentMethod = await client.paymentMethods.retrieve(paymentMethodId);

  if (customerId) {
    await client.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId }
    });
  }

  await upsertPaymentProfile(userId, {
    stripe_customer_id: customerId || undefined,
    default_payment_method_id: paymentMethodId,
    has_payment_method: true,
    overage_enabled: true,
    payment_method_brand: paymentMethod.card?.brand || null,
    payment_method_last4: paymentMethod.card?.last4 || null
  });
};

const syncSubscriptionFromStripe = async (subscription: Stripe.Subscription, source: string) => {
  const subscriptionId = subscription.id;
  const metadataUserId = subscription.metadata?.userId;
  const userId = metadataUserId || (await findUserIdBySubscriptionId(subscriptionId));
  if (!userId) return;

  const firstItem = subscription.items.data[0];
  const periodWindow = getSubscriptionPeriodWindow(subscription);
  const resolvedPlan = await resolvePlanFromStripePriceId(firstItem?.price?.id);
  const metadataInterval = toBillingInterval(subscription.metadata?.interval);
  const resolvedInterval = resolvedPlan?.interval || metadataInterval;
  const resolvedTier = resolvedPlan?.planTier || null;
  const existing = await getUserSubscriptionRow(userId);
  const existingTier = existing ? toBillingTier(existing.plan_tier) : 'free';
  const effectiveTier: BillingPlanTier = resolvedTier
    || (existingTier === 'creator' || existingTier === 'pro' || existingTier === 'studio' || existingTier === 'free'
      ? existingTier
      : 'free');

  await upsertSubscriptionState({
    userId,
    planTier: effectiveTier,
    status: ['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status) ? 'active' : 'inactive',
    stripeSubscriptionId: subscription.id,
    stripeStatus: subscription.status,
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    cancelRequestedAt: subscription.cancel_at_period_end ? nowIso() : null,
    canceledAt: toIsoOrUndefined(subscription.canceled_at),
    currentPeriodStart: toIsoOrUndefined(periodWindow.start),
    currentPeriodEnd: toIsoOrUndefined(periodWindow.end),
    metadata: {
      source,
      stripeSubscriptionId: subscription.id,
      stripeStatus: subscription.status,
      interval: resolvedInterval || undefined
    }
  });

  if (['active', 'trialing', 'past_due', 'unpaid'].includes(subscription.status) && resolvedTier) {
    await setUserPlanTier(userId, resolvedTier, {
      source,
      stripeSubscriptionId: subscription.id,
      stripeStatus: subscription.status,
      interval: resolvedInterval || undefined
    });
  }
};

const handleSubscriptionDeleted = async (subscription: Stripe.Subscription) => {
  const subscriptionId = subscription.id;
  const userId = subscription.metadata?.userId || (await findUserIdBySubscriptionId(subscriptionId));
  if (!userId) return;
  const periodWindow = getSubscriptionPeriodWindow(subscription);

  await upsertSubscriptionState({
    userId,
    planTier: 'free',
    status: 'canceled',
    stripeSubscriptionId: subscription.id,
    stripeStatus: subscription.status,
    cancelAtPeriodEnd: false,
    cancelRequestedAt: null,
    canceledAt: nowIso(),
    currentPeriodStart: toIsoOrUndefined(periodWindow.start),
    currentPeriodEnd: toIsoOrUndefined(periodWindow.end),
    metadata: {
      source: 'stripe_subscription_deleted',
      stripeSubscriptionId: subscription.id
    }
  });

  await setUserPlanTier(userId, 'free', {
    source: 'stripe_subscription_deleted',
    stripeSubscriptionId: subscription.id
  });
};

const handleInvoiceLifecycleUpdate = async (invoice: Stripe.Invoice, stripeStatus: string) => {
  const subscriptionId = getInvoiceSubscriptionId(invoice);
  if (!subscriptionId) return;

  const userId = await findUserIdBySubscriptionId(subscriptionId);
  if (!userId) return;

  const existing = await getUserSubscriptionRow(userId);
  const existingMetadata = existing && isRecord(existing.metadata)
    ? existing.metadata
    : {};
  await upsertSubscriptionState({
    userId,
    planTier: existing ? toBillingTier(existing.plan_tier) : 'free',
    status: existing ? String(existing.status || 'active') : 'active',
    stripeSubscriptionId: subscriptionId,
    stripeStatus,
    cancelAtPeriodEnd: Boolean(existing?.cancel_at_period_end),
    cancelRequestedAt: typeof existing?.cancel_requested_at === 'string' ? existing.cancel_requested_at : null,
    canceledAt: typeof existing?.canceled_at === 'string' ? existing.canceled_at : null,
    currentPeriodStart: typeof existing?.current_period_start === 'string' ? existing.current_period_start : null,
    currentPeriodEnd: typeof existing?.current_period_end === 'string' ? existing.current_period_end : null,
    metadata: {
      ...existingMetadata,
      source: 'stripe_invoice_event',
      invoiceId: invoice.id
    }
  });
};

const handleCheckoutCompleted = async (session: Stripe.Checkout.Session) => {
  const userId = session.client_reference_id || session.metadata?.userId;
  if (!userId) return;

  if (typeof session.customer === 'string') {
    await upsertPaymentProfile(userId, {
      stripe_customer_id: session.customer
    });
  }

  if (session.mode === 'subscription') {
    const subscriptionId = typeof session.subscription === 'string'
      ? session.subscription
      : session.subscription?.id;

    if (!subscriptionId) return;

    const client = assertStripe();
    const subscription = await client.subscriptions.retrieve(subscriptionId);
    await syncSubscriptionFromStripe(subscription, 'stripe_checkout_subscription');
    return;
  }

  if (session.mode === 'payment' && session.metadata?.kind === 'credit_pack') {
    if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
      return;
    }

    if (await hasProcessedCreditCheckout(userId, session.id)) {
      return;
    }

    const lineItemPriceId = session.metadata?.priceId || null;
    const mappedPackId = await resolveCreditPackFromStripePriceId(lineItemPriceId);
    const fromPrice = mappedPackId ? getCreditPackById(mappedPackId) : null;
    const fromMetadataPack = session.metadata?.packId ? getCreditPackById(session.metadata.packId) : null;
    const selectedPack = fromPrice || fromMetadataPack;
    if (!selectedPack) {
      return;
    }

    await addPurchasedCredits({
      userId,
      ctAmount: selectedPack.ct,
      usdAmount: selectedPack.usd,
      source: 'stripe_checkout_credit_pack',
      metadata: {
        checkoutSessionId: session.id,
        packId: mappedPackId || fromMetadataPack?.id,
        amountTotal: session.amount_total || 0,
        paymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id
      }
    });

    const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
    if (paymentIntentId) {
      const client = assertStripe();
      const intent = await client.paymentIntents.retrieve(paymentIntentId);
      await syncPaymentMethodFromPaymentIntent(intent, userId);
    }
  }
};

const handleLegacyCreditPaymentIntent = async (intent: Stripe.PaymentIntent) => {
  if (intent.metadata?.kind !== 'credit_pack') return;
  const userId = intent.metadata.userId;
  if (!userId) return;

  const checkoutSessionId = intent.metadata.checkoutSessionId;
  if (checkoutSessionId && await hasProcessedCreditCheckout(userId, checkoutSessionId)) {
    return;
  }

  const packId = intent.metadata.packId;
  const pack = packId ? getCreditPackById(packId) : null;
  if (!pack) return;

  await addPurchasedCredits({
    userId,
    ctAmount: pack.ct,
    usdAmount: pack.usd,
    source: 'stripe_payment_intent_credit_pack',
    metadata: {
      paymentIntentId: intent.id
    }
  });

  await syncPaymentMethodFromPaymentIntent(intent, userId);
};

const getSubscriptionStatusFromDb = async (userId: string): Promise<BillingSubscriptionStatus> => {
  const row = await getUserSubscriptionRow(userId);
  if (!row) {
    return {
      planTier: 'free',
      status: 'inactive',
      cancelAtPeriodEnd: false
    };
  }

  const metadata = isRecord(row.metadata) ? row.metadata : null;
  const interval = metadata ? toBillingInterval(metadata.interval) : undefined;

  return {
    planTier: toBillingTier(row.plan_tier),
    status: String(row.status || 'inactive'),
    interval,
    stripeStatus: typeof row.stripe_status === 'string' ? row.stripe_status : undefined,
    stripeSubscriptionId: typeof row.stripe_subscription_id === 'string' ? row.stripe_subscription_id : undefined,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    cancelRequestedAt: typeof row.cancel_requested_at === 'string' ? row.cancel_requested_at : undefined,
    canceledAt: typeof row.canceled_at === 'string' ? row.canceled_at : undefined,
    currentPeriodStart: typeof row.current_period_start === 'string' ? row.current_period_start : undefined,
    currentPeriodEnd: typeof row.current_period_end === 'string' ? row.current_period_end : undefined
  };
};

const resolveSubscriptionForUser = async (userId: string) => {
  const row = await getUserSubscriptionRow(userId);
  const existingId = typeof row?.stripe_subscription_id === 'string' ? row.stripe_subscription_id : null;
  if (existingId) {
    return existingId;
  }

  const admin = getAdmin();
  const { data: profile } = await admin
    .from('payment_profiles')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .maybeSingle();

  const customerId = typeof profile?.stripe_customer_id === 'string' ? profile.stripe_customer_id : null;
  if (!customerId) return null;

  const client = assertStripe();
  const subscriptions = await client.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 20
  });

  const activeSubscription = subscriptions.data.find((sub) => ['active', 'trialing', 'past_due', 'unpaid'].includes(sub.status));
  return activeSubscription?.id || null;
};

export const isStripeConfigured = () => Boolean(stripe);

export const ensureStripeCustomer = async (userId: string, email?: string) => {
  const client = assertStripe();
  const admin = getAdmin();

  const { data } = await admin
    .from('payment_profiles')
    .select('stripe_customer_id')
    .eq('user_id', userId)
    .maybeSingle();

  const existingId = typeof data?.stripe_customer_id === 'string' ? data.stripe_customer_id : null;
  if (existingId) {
    const customer = await client.customers.retrieve(existingId);
    if (!('deleted' in customer)) {
      return customer;
    }
  }

  const customer = await client.customers.create({
    email,
    metadata: {
      userId
    }
  });

  await upsertPaymentProfile(userId, {
    stripe_customer_id: customer.id
  });

  return customer;
};

export const createPlanCheckoutSession = async (input: {
  userId: string;
  email: string;
  planTier: PurchasablePlanTier;
  interval: BillingInterval;
}) => {
  const client = assertStripe();
  const priceId = await resolvePlanStripePriceId(input.planTier, input.interval);
  if (!priceId) {
    throw new Error(`Stripe price ID missing for plan tier ${input.planTier} (${input.interval}).`);
  }

  const customer = await ensureStripeCustomer(input.userId, input.email);

  return client.checkout.sessions.create({
    payment_method_types: ['card'],
    customer: customer.id,
    client_reference_id: input.userId,
    line_items: [{ price: priceId, quantity: 1 }],
    mode: 'subscription',
    success_url: `${CLIENT_URL}/settings?billing=success&type=subscription&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${CLIENT_URL}/settings?billing=cancelled&type=subscription`,
    metadata: {
      kind: 'subscription',
      userId: input.userId,
      planTier: input.planTier,
      interval: input.interval,
      priceId
    },
    subscription_data: {
      metadata: {
        userId: input.userId,
        planTier: input.planTier,
        interval: input.interval
      }
    }
  });
};

export const createCreditPackCheckoutSession = async (input: {
  userId: string;
  email: string;
  packId: CreditPackId;
}) => {
  const client = assertStripe();
  const stripePriceId = await resolveCreditPackStripePriceId(input.packId);
  if (!stripePriceId) {
    throw new Error(`Stripe price ID missing for credit pack ${input.packId}.`);
  }

  const pack = getCreditPackById(input.packId);
  if (!pack) {
    throw new Error(`Unknown credit pack ${input.packId}.`);
  }

  const customer = await ensureStripeCustomer(input.userId, input.email);

  return client.checkout.sessions.create({
    payment_method_types: ['card'],
    customer: customer.id,
    client_reference_id: input.userId,
    line_items: [{ price: stripePriceId, quantity: 1 }],
    mode: 'payment',
    success_url: `${CLIENT_URL}/settings?billing=success&type=credits&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${CLIENT_URL}/settings?billing=cancelled&type=credits`,
    metadata: {
      kind: 'credit_pack',
      userId: input.userId,
      packId: input.packId,
      packCt: String(pack.ct),
      packUsd: String(pack.usd),
      priceId: stripePriceId
    }
  });
};

export const createBillingPortalSession = async (input: { userId: string; email?: string; returnUrl?: string }) => {
  const client = assertStripe();
  const customer = await ensureStripeCustomer(input.userId, input.email);

  return client.billingPortal.sessions.create({
    customer: customer.id,
    return_url: input.returnUrl || BILLING_PORTAL_RETURN_URL
  });
};

export const cancelSubscriptionAtPeriodEnd = async (userId: string) => {
  const client = assertStripe();
  const subscriptionId = await resolveSubscriptionForUser(userId);
  if (!subscriptionId) {
    throw new Error('No active subscription found for user.');
  }

  const updated = await client.subscriptions.update(subscriptionId, {
    cancel_at_period_end: true
  });

  await syncSubscriptionFromStripe(updated, 'api_cancel_at_period_end');

  return getSubscriptionStatusFromDb(userId);
};

export const reactivateSubscription = async (userId: string) => {
  const client = assertStripe();
  const subscriptionId = await resolveSubscriptionForUser(userId);
  if (!subscriptionId) {
    throw new Error('No active subscription found for user.');
  }

  const updated = await client.subscriptions.update(subscriptionId, {
    cancel_at_period_end: false
  });

  await syncSubscriptionFromStripe(updated, 'api_reactivate_subscription');

  return getSubscriptionStatusFromDb(userId);
};

export const getSubscriptionStatus = async (userId: string) => getSubscriptionStatusFromDb(userId);

export const createSetupIntent = async (customerId: string, userId: string) => {
  const client = assertStripe();
  return client.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
    usage: 'off_session',
    metadata: {
      userId
    }
  });
};

export const confirmCheckoutSession = async (input: { userId: string; sessionId: string }) => {
  const client = assertStripe();
  const sessionId = typeof input.sessionId === 'string' ? input.sessionId.trim() : '';
  if (!sessionId) {
    throw new Error('sessionId is required.');
  }

  const session = await client.checkout.sessions.retrieve(sessionId);
  const ownerUserId = session.client_reference_id || session.metadata?.userId;
  if (!ownerUserId || ownerUserId !== input.userId) {
    const error = new Error('Checkout session does not belong to the authenticated user.') as Error & { status?: number; publicCode?: string };
    error.status = 403;
    error.publicCode = 'FORBIDDEN';
    throw error;
  }

  if (session.status !== 'complete') {
    const error = new Error('Checkout session is not complete yet.') as Error & { status?: number; publicCode?: string };
    error.status = 409;
    error.publicCode = 'CHECKOUT_NOT_COMPLETE';
    throw error;
  }

  await handleCheckoutCompleted(session);
  return {
    synced: true,
    subscription: await getSubscriptionStatusFromDb(input.userId)
  };
};

export const handleStripeWebhook = async (sig: string, body: Buffer) => {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET missing');

  const client = assertStripe();

  let event: Stripe.Event;
  try {
    event = client.webhooks.constructEvent(body, sig, webhookSecret);
  } catch (err: any) {
    throw new Error(`Webhook Error: ${err.message}`);
  }

  const eventAgeSeconds = Math.max(0, Math.floor(Date.now() / 1000) - Number(event.created || 0));
  if (WEBHOOK_MAX_AGE_SECONDS > 0 && eventAgeSeconds > WEBHOOK_MAX_AGE_SECONDS) {
    throw new Error(`Webhook event too old (${eventAgeSeconds}s > ${WEBHOOK_MAX_AGE_SECONDS}s).`);
  }

  const webhookState = await upsertWebhookProcessingState(event.id, event.type);
  if (webhookState.alreadyProcessed) {
    return { received: true, replayed: true };
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;
      case 'setup_intent.succeeded':
        await syncPaymentMethodFromSetupIntent(event.data.object as Stripe.SetupIntent);
        break;
      case 'payment_intent.succeeded':
        await handleLegacyCreditPaymentIntent(event.data.object as Stripe.PaymentIntent);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await syncSubscriptionFromStripe(event.data.object as Stripe.Subscription, event.type);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;
      case 'invoice.payment_failed':
        await handleInvoiceLifecycleUpdate(event.data.object as Stripe.Invoice, 'payment_failed');
        break;
      case 'invoice.paid':
        await handleInvoiceLifecycleUpdate(event.data.object as Stripe.Invoice, 'paid');
        break;
      default:
        break;
    }

    await markWebhookProcessed(event.id);
    return { received: true };
  } catch (error: any) {
    await markWebhookFailed(event.id, error?.message || String(error));
    throw error;
  }
};

export const assertPurchasableTier = (value: unknown): PurchasablePlanTier => {
  if (!isPurchasablePlanTier(value)) {
    throw new Error('Invalid plan tier. Allowed values: creator, pro, studio.');
  }
  return value;
};

export const assertBillingInterval = (value: unknown): BillingInterval => {
  if (value !== 'month' && value !== 'year') {
    throw new Error('Invalid billing interval. Allowed values: month, year.');
  }
  return value;
};

export const assertCreditPackId = (value: unknown): CreditPackId => {
  if (typeof value !== 'string') {
    throw new Error('Invalid credit pack ID.');
  }
  if (value !== 'pack_10' && value !== 'pack_25' && value !== 'pack_100') {
    throw new Error('Invalid credit pack ID. Allowed values: pack_10, pack_25, pack_100.');
  }
  return value;
};
