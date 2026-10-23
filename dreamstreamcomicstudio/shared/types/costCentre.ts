// Admin "Cost centre" report — the response of GET /api/admin/costs?days=7|30|90.
//
// Shared by the server aggregator (server/src/services/costCentre.ts) and the admin UI
// (components/admin/CostCentre.tsx). Keep this shape STABLE: add optional fields rather
// than renaming. Every dollar figure carries an honest provenance label:
//   measured  — summed from rows the platform recorded (provider-reported $ or counts × list price)
//   estimated — derived from usage with documented unit prices / assumptions
//   fixed     — a flat plan fee, amortized per day (usd / 30)

export type CostRangeDays = 7 | 30 | 90;
export const COST_RANGE_DAYS: readonly CostRangeDays[] = [7, 30, 90];

export type CostSource = 'measured' | 'estimated' | 'fixed';

/** Daily stack keys, bottom → top in the chart. */
export type CostCategoryId = 'fixed' | 'ai' | 'containers' | 'connectors' | 'email';
export const COST_CATEGORY_IDS: readonly CostCategoryId[] = ['fixed', 'ai', 'containers', 'connectors', 'email'];

export interface CostDailyRow {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  ai: number;
  email: number;
  containers: number;
  connectors: number;
  fixed: number;
}

export interface CostCategory {
  id: CostCategoryId;
  label: string;
  usd: number;
  source: CostSource;
  note: string;
}

export interface AiModelRow {
  provider: string;
  model: string;
  /** All AI events for this model in the range (platform-paid + BYOK). */
  events: number;
  /** Settled provider cost of platform-paid events (what the platform paid). */
  providerUsd: number;
  /** What platform-paid events were billed to user credits. */
  billableUsd: number;
  /** How many of `events` ran on the user's own key (not a platform cost). */
  byok: number;
  /** Provider cost of those BYOK events — paid by users, shown for context. */
  byokUsd?: number;
}

export interface AiOperationRow {
  operation: string;
  events: number;
  providerUsd: number;
}

export interface AiUserRow {
  userId: string;
  email: string | null;
  events: number;
  providerUsd: number;
}

export interface ConnectorRow {
  provider: string;
  calls: number;
  errors: number;
  blocked: number;
  /** Guardrail budget expressed per month (per-day cap × 30); null when the provider has none. */
  monthlyBudget: number | null;
  /** Monthly run-rate of calls as a % of monthlyBudget. */
  pctOfBudget: number | null;
  /** Busiest single day as a % of the per-day cap (the cap that actually bites). */
  peakDayPct?: number | null;
  usd: number;
}

export interface FixedCostRow {
  service: string;
  plan: string;
  usdMonth: number;
  note: string;
  /** 'fixed' for flat plan fees; 'estimated' for usage-billed lines we can't meter yet. */
  source?: CostSource;
}

export interface RevenueTierRow {
  tier: string;
  /** Paying subscribers: active/trialing with a Stripe subscription. */
  subscribers: number;
  priceUsd: number;
  mrrUsd: number;
  /** Active on the tier WITHOUT a Stripe subscription (admin overrides / comped) — not in MRR. */
  comped?: number;
}

export type ProductId = 'comic' | 'chat' | 'stream' | 'code' | 'other';

export interface ProductRow {
  id: ProductId;
  label: string;
  costUsd: number;
  requests: number;
  users: number | null;
  revenueUsd: number | null;
  note: string;
  /** One-line cost-benefit verdict. */
  verdict?: string;
  /**
   * What the same usage would cost at LIST PRICE with no free tier (estimated; the planning number).
   * `costUsd` stays the marginal cost (the product's share of the account's overage).
   */
  listValueUsd?: number;
}

// ─── Stream Studio (ADR 0007; docs/features/stream-studio-costs.md §3) ───────────────────

export type StreamPathKey = 'lan' | 'direct' | 'turn' | 'server';

/** One account-wide free allowance: month to date, projected to month end. */
export interface StreamHeadroomRow {
  id: string;
  label: string;
  unit: string;
  used: number;
  allowance: number;
  projected: number;
  /** projected ÷ allowance × 100. */
  projectedPct: number;
  /** UTC day the run-rate crosses the allowance this month, or null. */
  crossesOn: string | null;
  /** Overage $ this month so far (list price beyond the allowance). */
  overageUsd: number;
  source: CostSource;
  note?: string;
}

export interface StreamFeatureRow {
  id: string;
  label: string;
  /** The units behind the $ (requests, rows, GB-s, GB, …). */
  units: { label: string; value: number; unit: string }[];
  /** List-price value of the period's usage (estimated). */
  listValueUsd: number;
  source: CostSource;
  note?: string;
}

export interface StreamConsumerRow {
  scope: 'nursery' | 'account' | 'event';
  /** Internal id (admin console only). */
  id: string;
  /** Nursery name, account email or event id — admin console only; guests are never listed. */
  label: string;
  owner?: string | null;
  listValueUsd: number;
  serverMinutes: number;
  turnGb: number;
  minutes: number;
}

export interface StreamAlertRow {
  id: string;
  severity: 'warning' | 'critical';
  title: string;
  cause: string;
}

export interface StreamCostSection {
  /** Which sources answered: Cloudflare GraphQL (measured) and Analytics Engine (in-room counters). */
  sources: { graphql: boolean; analyticsEngine: boolean };
  /** Cloudflare analytics credentials are set (the reads were asked), whether or not they answered. */
  configured?: boolean;
  /** Month to date (UTC) that headroom, overage and alerts cover. */
  month: { from: string; to: string; daysElapsed: number; daysInMonth: number };
  /** Stream Studio's share of the account's overage this month (marginal $; $0 inside the free tiers). */
  marginalUsd: number;
  /** List-price value of the selected range's usage, and the range before it (estimated). */
  listValueUsd: number;
  prevListValueUsd: number | null;
  /** Estimated list value per active nursery-month (null until the rooms' daily activity marks exist) and per broadcast-hour. */
  perNurseryMonthUsd: number | null;
  perBroadcastHourUsd: number | null;
  /** Share (0–1) of monitor + call + meeting minutes on Home Wi-Fi or Direct (monitor only once its viewers report paths). */
  freePathShare: number | null;
  activeNurseries: number;
  events: number;
  features: StreamFeatureRow[];
  /** Minutes by path for monitor, calls and meetings — the frugality scoreboard. */
  pathMix: { kind: string; label: string; minutes: Record<StreamPathKey, number> }[];
  top: { nurseries: StreamConsumerRow[]; accounts: StreamConsumerRow[]; events: StreamConsumerRow[] };
  headroom: StreamHeadroomRow[];
  /** At today's per-nursery cost (list price). */
  projection: { perNurseryMonthUsd: number | null; at1k: number | null; at10k: number | null; source: CostSource };
  /** ADR 0006 per-active-nursery-day KPIs (thresholds apply after Phase 0). */
  kpis: {
    activeNurseryDays: number;
    doRequests: number | null;
    rowsWritten: number | null;
    gbSeconds: number | null;
    serverShare: number | null;
    source: CostSource;
    note: string;
  };
  alerts: StreamAlertRow[];
  /** Price table date (STREAM_UNIT_PRICES.checkedOn). */
  pricesCheckedOn: string;
  notes: string[];
  /** Per-dataset failures (the rest still shows). */
  errors: string[];
}

export interface CloudflareWorkerRow {
  script: string;
  requests: number;
  errors: number;
  /** Median CPU time per invocation, ms (request-weighted across ≤30-day query chunks). */
  cpuP50Ms: number | null;
  subrequests?: number;
}

export interface CloudflareR2Row {
  bucket: string;
  payloadBytes: number;
  objectCount: number;
}

export interface CloudflareSection {
  configured: boolean;
  workers?: CloudflareWorkerRow[];
  r2?: CloudflareR2Row[];
  /** Scripts on the account that are not DreamStream's and were left out. */
  excludedScripts?: number;
  error?: string;
}

export interface CostCentreReport {
  generatedAt: string;
  range: { from: string; to: string; days: number };
  totals: {
    costUsd: number;
    prevCostUsd: number;
    aiProviderUsd: number;
    aiBillableUsd: number;
    aiMarginUsd: number;
    revenueMrrUsd: number;
    creditRevenueUsd: number;
    users: number;
    activeUsers: number;
    costPerActiveUserUsd: number | null;
  };
  daily: CostDailyRow[];
  categories: CostCategory[];
  ai: {
    byModel: AiModelRow[];
    byOperation: AiOperationRow[];
    topUsers: AiUserRow[];
    /** BYOK events in range and their provider cost (users' keys — not platform spend). */
    byokEvents?: number;
    byokProviderUsd?: number;
  };
  connectors: ConnectorRow[];
  email: { sent: number; failed: number; monthToDate: number; freeMonthly: number; usd: number };
  containers: { runs: number; awakeHours: number; usd: number; note: string };
  fixed: FixedCostRow[];
  revenue: { byTier: RevenueTierRow[]; creditPurchasesUsd: number };
  products: ProductRow[];
  cloudflare: CloudflareSection;
  notes: string[];
  /** Admin → Costs → Stream Studio (absent from servers that predate it). */
  stream?: StreamCostSection;
}
