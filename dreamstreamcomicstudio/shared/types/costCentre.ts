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
    /** Month to date: active nursery-days, and the averages per active nursery-day. */
    activeNurseryDays: number;
    /** Durable Object INVOCATIONS as Cloudflare's analytics count them (incoming WebSocket messages 1:1). */
    doRequests: number | null;
    rowsWritten: number | null;
    gbSeconds: number | null;
    serverShare: number | null;
    /**
     * The Phase 0 acceptance figures: the MEDIAN per active nursery-day over the last 7 complete days
     * with activity marks (`days` says how many there were; acceptance needs 7). Absent from servers
     * that predate ADR 0006 WS-8.
     */
    median7d?: { days: number; doRequests: number | null; rowsWritten: number | null; gbSeconds: number | null };
    /**
     * ADR 0006 Phase 0 budgets per active nursery-day, in the units measured: `doRequests` is Cloudflare's
     * invocation count (every incoming WebSocket message once, not the billed 20:1), so its budget is
     * 2,600 invocations ≈ the ADR's 1,000 billed requests; ≤ 1,800 rows; ≤ 40 GB-s.
     */
    budgets?: { doRequests: number; rowsWritten: number; gbSeconds: number };
    /** The 7-day medians against the budgets ('unknown' with no days to judge). */
    status?: Record<'doRequests' | 'rowsWritten' | 'gbSeconds', 'ok' | 'over' | 'unknown'>;
    /** TURN relay egress this month, GB (account-wide, measured). */
    turnGbMonthToDate?: number | null;
    /** Share (0–1) of monitor viewer-minutes on a paid path (TURN relay + our server), once viewers report paths. */
    relayShare?: number | null;
    /** Durable Object storage now (account-wide level, GB), and per nursery active this month (MB, an upper bound). */
    doStoredGb?: number | null;
    doStoredMbPerNursery?: number | null;
    /** Watch readiness: Glance bumps and pushes per active nursery-night (floors; null until the rooms count them). */
    glanceBumpsPerNight?: number | null;
    pushesPerNight?: number | null;
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

// ─── Security signals (ADR 0006 WS-8; docs/infrastructure/live-security-runbook.md) ──────
// Aggregate counts only: no account, nursery, device, IP, token, URL or email ever appears here.

/** One CSP violation bucket: which app, which directive, which ORIGIN (or keyword) was blocked. */
export interface CspViolationRow {
  /** 'live' (Stream Studio) · 'main' · 'srcdoc' (a chat artifact frame) · 'other'. */
  page: string;
  directive: string;
  /** An origin (`https://x.example`) or a keyword (`inline`, `eval`, `data:`, `extension`, …) — never a path. */
  blocked: string;
  /** 'enforce' · 'report' · 'unknown'. */
  disposition: string;
  /** False when a browser extension caused it (not our code). */
  firstParty: boolean;
  count: number;
}

export interface SecuritySignalRow {
  id: string;
  label: string;
  /** In the selected range (a floor: counts held by an evicted isolate are lost). */
  count: number;
  /** The equal period before (null when Analytics Engine doesn't reach back that far). */
  prevCount: number | null;
  /** 'bad' = refusals, lockouts, spoof attempts; 'neutral' = expected traffic. */
  tone: 'bad' | 'neutral';
  /** Where it happened (socket kind / route), largest first. */
  bySurface: { surface: string; count: number }[];
}

export interface SecuritySection {
  range: { from: string; to: string; days: number };
  /** Browser protections: the Content-Security-Policy violation counts (functions/csp-report.ts → CSP_REPORTS). */
  csp: {
    /** The dataset answered (the Pages binding exists and has data). */
    measured: boolean;
    total: number | null;
    /**
     * First-party violations on Stream Studio in the last 48 h of the policy ENFORCE_LIVE will enforce — the
     * gate for enforcing it. Trusted Types reports are not in it (that policy stays report-only for good).
     */
    firstPartyLive48h: number | null;
    /**
     * First-party violations on Stream Studio in the range: enforced (blocked for real, whatever the policy)
     * vs report-only (of the policy that will be enforced).
     */
    firstPartyLiveEnforced: number | null;
    firstPartyLiveReportOnly: number | null;
    /**
     * First-party reports on Stream Studio in the range against the report-only Trusted Types policy
     * (require-trusted-types-for): an inventory, never a gate or an alert. Absent from older servers.
     */
    trustedTypesLive?: number | null;
    /** Caused by browser extensions (not our code). */
    extension: number | null;
    top: CspViolationRow[];
    note: string;
    error?: string;
  };
  /** New sign-ins and the alerts about them (Supabase `security_events`, live_security_v2.sql). */
  signIns: {
    measured: boolean;
    newSessions: number | null;
    alertsEmailed: number | null;
    /** "Not you? Secure my account" used — each one is a suspected account takeover. */
    secured: number | null;
    devicesAdded: number | null;
    devicesRevoked: number | null;
    note: string;
    error?: string;
  };
  /** The live Worker's refusal / disconnect counts (shared/stream/signals.ts). */
  signals: { measured: boolean; counted: boolean; rows: SecuritySignalRow[]; note: string };
  alerts: StreamAlertRow[];
  notes: string[];
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
  /** Admin → Costs → Security: aggregate security signals (absent from servers that predate ADR 0006 WS-8). */
  security?: SecuritySection;
}
