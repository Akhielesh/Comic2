import Stripe from 'stripe';
import { getSupabaseAdmin } from '../services/supabase.js';

type LedgerRow = {
  id: string;
  created_at: string;
  entry_type: string;
  usd_delta: number;
  metadata: Record<string, unknown>;
};

const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
const stripe = stripeSecretKey
  ? new Stripe(stripeSecretKey, { apiVersion: '2026-01-28.clover' })
  : null;

const toIso = (d: Date) => d.toISOString();

const parseArgs = () => {
  const args = new Set(process.argv.slice(2));
  return {
    strict: args.has('--strict') || args.has('--check'),
    hours: Number(process.env.BILLING_RECON_WINDOW_HOURS || '24')
  };
};

const listRelevantPaymentIntents = async (fromEpoch: number) => {
  if (!stripe) throw new Error('STRIPE_SECRET_KEY missing');

  const intents: Stripe.PaymentIntent[] = [];
  let startingAfter: string | undefined;

  while (true) {
    const page = await stripe.paymentIntents.list({
      created: { gte: fromEpoch },
      limit: 100,
      starting_after: startingAfter
    });

    intents.push(...page.data.filter((intent) => {
      const kind = intent.metadata?.kind || '';
      return kind === 'credit_pack' || kind === 'auto_reload' || kind === 'overage_capture';
    }));

    if (!page.has_more || page.data.length === 0) break;
    startingAfter = page.data[page.data.length - 1].id;
  }

  return intents;
};

export const runDailyBillingReconciliation = async (options?: { strict?: boolean; windowHours?: number }) => {
  const strict = options?.strict === true;
  const windowHours = Number.isFinite(options?.windowHours) ? Number(options?.windowHours) : 24;

  const fromDate = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const fromIso = toIso(fromDate);
  const fromEpoch = Math.floor(fromDate.getTime() / 1000);

  const admin = getSupabaseAdmin();

  const { data: ledgerRowsRaw, error: ledgerError } = await admin
    .from('token_ledger_entries')
    .select('id, created_at, entry_type, usd_delta, metadata')
    .gte('created_at', fromIso)
    .in('entry_type', ['CREDIT_PURCHASE', 'OVERAGE_CAPTURE'])
    .order('created_at', { ascending: false })
    .limit(5000);

  if (ledgerError) throw ledgerError;

  const ledgerRows = (ledgerRowsRaw || []) as LedgerRow[];
  const ledgerByIntent = new Map<string, LedgerRow>();

  ledgerRows.forEach((row) => {
    const metadata = row.metadata || {};
    const paymentIntentId = typeof metadata.paymentIntentId === 'string' ? metadata.paymentIntentId : null;
    if (paymentIntentId) {
      ledgerByIntent.set(paymentIntentId, row);
    }
  });

  const stripeIntents = await listRelevantPaymentIntents(fromEpoch);
  const stripeById = new Map(stripeIntents.map((intent) => [intent.id, intent]));

  const missingInStripe: string[] = [];
  const missingInLedger: string[] = [];

  for (const intentId of ledgerByIntent.keys()) {
    if (!stripeById.has(intentId)) {
      missingInStripe.push(intentId);
    }
  }

  for (const intentId of stripeById.keys()) {
    if (!ledgerByIntent.has(intentId)) {
      missingInLedger.push(intentId);
    }
  }

  const { data: failedWebhookRows, error: webhookError } = await admin
    .from('stripe_webhook_events')
    .select('event_id, event_type, received_at, error')
    .gte('received_at', fromIso)
    .eq('status', 'failed')
    .order('received_at', { ascending: false })
    .limit(200);

  if (webhookError) throw webhookError;

  const failedWebhookCount = Array.isArray(failedWebhookRows) ? failedWebhookRows.length : 0;

  const result = {
    windowHours,
    fromIso,
    ledgerEntriesChecked: ledgerRows.length,
    stripeIntentsChecked: stripeIntents.length,
    missingInStripeCount: missingInStripe.length,
    missingInLedgerCount: missingInLedger.length,
    failedWebhookCount,
    missingInStripe,
    missingInLedger,
    failedWebhooks: failedWebhookRows || []
  };

  if (strict && (missingInStripe.length > 0 || missingInLedger.length > 0 || failedWebhookCount > 0)) {
    throw new Error(
      `Billing reconciliation failed: missingInStripe=${missingInStripe.length}, missingInLedger=${missingInLedger.length}, failedWebhooks=${failedWebhookCount}`
    );
  }

  return result;
};

const isDirectRun = Boolean(process.argv[1] && process.argv[1].includes('dailyBillingReconciliation'));

if (isDirectRun) {
  const args = parseArgs();
  runDailyBillingReconciliation({ strict: args.strict, windowHours: args.hours })
    .then((result) => {
      console.log(JSON.stringify({ ok: true, ...result }));
    })
    .catch((error) => {
      console.error(JSON.stringify({ ok: false, error: (error as Error).message }));
      process.exitCode = 1;
    });
}
