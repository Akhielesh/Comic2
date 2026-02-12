import Stripe from 'stripe';
import { addPurchasedCredits, setUserPlanTier, upsertPaymentProfile } from './billingLedger.js';
import { getSupabaseAdmin } from './supabase.js';

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecretKey
  ? new Stripe(stripeSecretKey, { apiVersion: '2026-01-28.clover' })
  : null;

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';
const processedSetupIntents = new Set<string>();
const processedPaymentIntents = new Set<string>();
const processedCheckoutSessions = new Set<string>();

const resolvePlanPriceId = (planTier: string) => {
  const normalized = planTier.trim().toLowerCase();
  if (normalized === 'creator') {
    return process.env.STRIPE_PRICE_ID_CREATOR || process.env.STRIPE_PRICE_ID;
  }
  if (normalized === 'studio') {
    return process.env.STRIPE_PRICE_ID_STUDIO || process.env.STRIPE_PRICE_ID;
  }
  return process.env.STRIPE_PRICE_ID_PRO || process.env.STRIPE_PRICE_ID;
};

const assertStripe = () => {
  if (!stripe) {
    throw new Error('Stripe configuration missing (STRIPE_SECRET_KEY).');
  }
  return stripe;
};

export const isStripeConfigured = () => Boolean(stripe);

export const ensureStripeCustomer = async (userId: string, email?: string) => {
  const client = assertStripe();

  try {
    const admin = getSupabaseAdmin();
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
  } catch {
    // continue with creation path
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
  planTier: string;
}) => {
  const client = assertStripe();
  const priceId = resolvePlanPriceId(input.planTier);
  if (!priceId) {
    throw new Error(`Stripe price ID missing for plan tier ${input.planTier}.`);
  }

  const customer = await ensureStripeCustomer(input.userId, input.email);

  return client.checkout.sessions.create({
    payment_method_types: ['card'],
    customer: customer.id,
    client_reference_id: input.userId,
    line_items: [{ price: priceId, quantity: 1 }],
    mode: 'subscription',
    success_url: `${CLIENT_URL}/settings?billing=success`,
    cancel_url: `${CLIENT_URL}/settings?billing=cancelled`,
    metadata: {
      userId: input.userId,
      planTier: input.planTier
    }
  });
};

// Legacy alias retained for existing route usage.
export const createCheckoutSession = async (userId: string, email: string) =>
  createPlanCheckoutSession({ userId, email, planTier: 'pro' });

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

export const createCreditPackPaymentIntent = async (input: {
  customerId: string;
  userId: string;
  packUsd: number;
  packCt: number;
}) => {
  const client = assertStripe();
  return client.paymentIntents.create({
    customer: input.customerId,
    amount: Math.round(input.packUsd * 100),
    currency: 'usd',
    setup_future_usage: 'off_session',
    automatic_payment_methods: { enabled: true },
    metadata: {
      kind: 'credit_pack',
      userId: input.userId,
      packUsd: String(input.packUsd),
      packCt: String(input.packCt)
    }
  });
};

const hasProcessedCreditPurchase = async (userId: string, paymentIntentId: string) => {
  if (processedPaymentIntents.has(paymentIntentId)) {
    return true;
  }

  try {
    const admin = getSupabaseAdmin();
    const { data, error } = await admin
      .from('token_ledger_entries')
      .select('id')
      .eq('user_id', userId)
      .eq('entry_type', 'CREDIT_PURCHASE')
      .contains('metadata', { paymentIntentId })
      .limit(1);

    if (!error && Array.isArray(data) && data.length > 0) {
      processedPaymentIntents.add(paymentIntentId);
      return true;
    }
  } catch {
    // Continue with best-effort in-memory idempotency.
  }

  return false;
};

const syncPaymentMethodFromSetupIntent = async (setupIntent: Stripe.SetupIntent) => {
  if (processedSetupIntents.has(setupIntent.id)) return;
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
  processedSetupIntents.add(setupIntent.id);
};

const handleCreditPurchase = async (intent: Stripe.PaymentIntent) => {
  if (intent.metadata?.kind !== 'credit_pack') return;
  const userId = intent.metadata.userId;
  if (!userId) return;
  if (!intent.id) return;

  if (await hasProcessedCreditPurchase(userId, intent.id)) {
    return;
  }

  const packUsd = Number(intent.metadata.packUsd || 0);
  const packCt = Number(intent.metadata.packCt || 0);
  if (!Number.isFinite(packUsd) || !Number.isFinite(packCt) || packUsd <= 0 || packCt <= 0) return;

  await addPurchasedCredits({
    userId,
    ctAmount: Math.floor(packCt),
    usdAmount: packUsd,
    source: 'stripe_credit_pack',
    metadata: {
      paymentIntentId: intent.id,
      amountReceived: intent.amount_received
    }
  });

  const paymentMethodId = typeof intent.payment_method === 'string'
    ? intent.payment_method
    : intent.payment_method?.id;
  const customerId = typeof intent.customer === 'string' ? intent.customer : intent.customer?.id;

  if (paymentMethodId) {
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
  }

  processedPaymentIntents.add(intent.id);
};

const handleCheckoutCompleted = async (session: Stripe.Checkout.Session) => {
  if (processedCheckoutSessions.has(session.id)) return;
  const userId = session.client_reference_id || session.metadata?.userId;
  if (!userId) return;

  const planTier = session.metadata?.planTier || 'pro';
  await setUserPlanTier(userId, ['free', 'creator', 'pro', 'studio', 'custom', 'admin'].includes(planTier) ? (planTier as any) : 'pro', {
    source: 'stripe_checkout',
    sessionId: session.id,
    subscriptionId: typeof session.subscription === 'string' ? session.subscription : session.subscription?.id
  });

  if (typeof session.customer === 'string') {
    await upsertPaymentProfile(userId, {
      stripe_customer_id: session.customer
    });
  }
  processedCheckoutSessions.add(session.id);
};

const handleSubscriptionCancelled = async (subscription: Stripe.Subscription) => {
  const userId = subscription.metadata?.userId;
  if (!userId) return;
  await setUserPlanTier(userId, 'free', {
    source: 'stripe_subscription_cancelled',
    subscriptionId: subscription.id
  });
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

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
      break;
    case 'setup_intent.succeeded':
      await syncPaymentMethodFromSetupIntent(event.data.object as Stripe.SetupIntent);
      break;
    case 'payment_intent.succeeded':
      await handleCreditPurchase(event.data.object as Stripe.PaymentIntent);
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionCancelled(event.data.object as Stripe.Subscription);
      break;
    default:
      break;
  }

  return { received: true };
};
