# 38 — Observability (Logs / Metrics / Traces / Alerts)

> Part IV · Non-functional / Foundations · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [F-ENTERPRISE-FOUNDATIONS](../F-ENTERPRISE-FOUNDATIONS.md) (**F0** — this section is its deep
> design; also F1 provider metrics, F2 queue depth/backpressure) ·
> [Master Plan](../00-MASTER-PLAN.md) (A1 control plane / `venture_events`, A8 Operator Console) ·
> [Reliability & SRE](./37-reliability-sre.md) (SLOs + error budgets that consume these signals) ·
> [Metrics & KPIs](./06-metrics-kpis.md) (§6.7 instrumentation plan — the three planes) ·
> [Security & Threat Model](./35-security-threat-model.md) (audit log as a control) ·
> [alerting-thresholds.md](../../../production/alerting-thresholds.md) (the thresholds this
> section finally feeds). Grounded in a real code audit (2026-06): `middleware/requestContext.ts`,
> `services/systemDashboard.ts`, `ai/capabilities.ts`, `ai/guardrails.ts`, `routes/system.ts`.

## 38.1 Why this section is load-bearing

The whole Autopilot thesis is an **always-on** product studio: agents that run 24/7, ship to
production, and spend real money on model tokens and compute without a human watching every
tick. That thesis is uninsurable without observability. F0 states the rule in one line — *you
cannot run 24/7 what you cannot see* — and grades it the **#1 gap** in the audit. This section
is the deep design that closes it.

The honest position, repeated throughout so we never oversell: **what exists today is good
request-level logging plus a live admin dashboard, and nothing else.** There is no error
tracking, no tracing, no metrics backend, and the documented alert thresholds in
`alerting-thresholds.md` have **nothing emitting the signals they reference.** This section
maps the gap precisely, then specifies the target (Sentry + pino + `prom-client` + a
`requestId` trace spine + an append-only audit log + three dashboards + real alerting/on-call),
and ties every deliverable back to an F0 acceptance bullet so it is gated, not aspirational.

## 38.2 Current state (audited, honest)

These are the four things that genuinely exist and work. They are strengths to **preserve, not
regress** — the target builds on them rather than replacing them.

| Capability | What it does today | Where | Verdict |
|---|---|---|---|
| **Structured request logging** | Every HTTP response emits one JSON line: `event:http_request`, `requestId`, `method`, `path`, `status`, `latencyMs`, `userId`, `ip`. A `requestId` is minted (or honoured from `X-Request-Id`) per request and echoed in the response header. | `middleware/requestContext.ts` | 🟢 good |
| **Health & readiness endpoints** | `GET /api/health` liveness; `GET /api/system/ready` returns **503** when required env vars are missing or Supabase is unreachable, **200** otherwise — already the exact two probes `alerting-thresholds.md` §1.3/§1.4 name. | `routes/system.ts:322` | 🟢 good |
| **Admin dashboard (live)** | Live upstream tool-API pings (up/down + latency), documented dependency free-tier limits with a `connected` flag per vendor, configured rate-limit summary, capability report, recent notices. Honest about what is connected vs not. | `services/systemDashboard.ts`, `routes/system.ts:293` | 🟢 good |
| **Guardrail / capability audit notices** | A bounded in-memory ring buffer of "capability notices": tool failures, degraded fallbacks, missing keys, and guardrail findings (secret/PII/fabrication). Surfaced to users and to the dashboard. | `ai/capabilities.ts`, `ai/guardrails.ts` | 🟡 good but **in-memory only** (lost on restart, single-process) |

What this means in practice: we can answer *"what was the latency and status of request X?"*
from logs, *"is the box up and are its dependencies reachable?"* from the probes, and *"which
upstreams are degraded right now?"* from the dashboard. That is a real, non-trivial baseline —
better than many early products — and we will not throw it away.

## 38.3 The gaps (also honest)

| Gap | Reality today | Consequence | F0 bullet that closes it |
|---|---|---|---|
| **No error tracking** | Exceptions land in `console.error` and scroll off. No Sentry/Rollbar; no aggregation, alerting, release-health, or grouping. | A 24/7 agent can throw all night and nobody is paged; "healthy deploy" (North Star §6.2) is uncomputable without release health. | Add Sentry (server + client). |
| **No distributed tracing** | `requestId` exists at the HTTP edge but does **not** propagate into the AI gateway, BullMQ jobs, or the studio worker. | A slow or failed ship can't be followed across gateway → queue → worker → DO/Workflow; root-causing is archaeology. | Propagate `requestId` as trace context. |
| **No metrics backend** | No `/metrics`, no `prom-client`, no time-series store. The dashboard pings are point-in-time, not aggregable, not alertable. | 5xx rate, p95/p99, 429 ratio, queue depth, per-provider error/latency, cost — **none are emitted.** | Add a metrics exporter + `/metrics`. |
| **Unstructured logging** | **62 raw `console.*` calls** across `server/src` (e.g. `ai/flux.ts`, `jobs/refreshModelCatalog.ts`, `index.ts`). No levels, no redaction, no correlation to the JSON request line. | Secrets can be logged; logs can't be filtered by level or joined by `requestId`; noisy and unsearchable. | Replace `console.*` with pino. |
| **Thresholds with nothing feeding them** | `alerting-thresholds.md` lists 5xx, latency, capacity, 429, and cost alerts — all real, all sensible, **all dead.** No emitter, no evaluator, no route. | Documented SLOs are theatre; an incident is discovered by a user, not a page. | Wire thresholds to real alerts. |
| **Audit trail is ephemeral** | The only "audit log" is the in-memory notices ring (max 200, lost on restart). No durable record of role changes, deletes, auth events, or deploys. | No forensic trail for security (§35); no substrate to seed Autopilot's `venture_events` (§6.7). | Security/admin audit log table + writer. |
| **Worker/Redis blind** | BullMQ worker can run in-process (`index.ts`); no liveness, depth, or stalled-job signal. | Backpressure (F2) and queue-depth alerts have no input; a stuck worker is invisible. | BullMQ + Redis liveness in the dashboard. |

## 38.4 The three pillars, mapped

Observability is conventionally split into **logs, metrics, and traces**; we add **events**
(the audit/autonomy record) and **alerts** (the action layer) because an autonomous,
multi-tenant, cost-exposed platform needs both. Each pillar has exactly one source of truth so
a number is auditable, not vibes (mirroring §6.1).

| Pillar | Question it answers | Source of truth (target) | Builds on |
|---|---|---|---|
| **Logs** | "What happened in this one request/job, in detail?" | pino structured logs, one line per event, `requestId`-correlated | the existing JSON request line (`requestContext.ts`) |
| **Metrics** | "What is the aggregate rate/latency/cost across all requests?" | `prom-client` exporter at `/metrics`; scraped into a time-series store | nothing today (new) |
| **Traces** | "Where did the time/failure go across services for request X?" | `requestId` trace spine + spans across gateway/queue/worker/DO/Workflow | the edge `requestId` (`requestContext.ts`) |
| **Events** | "What did the agents/operators *do* (and is it allowed)?" | append-only `audit_log` → seeds `venture_events` | the in-memory notices ring (made durable) |
| **Alerts** | "What needs a human *now*?" | Sentry alert rules + a cron threshold evaluator → on-call routing | `alerting-thresholds.md` (finally fed) |
| **Errors** | "What broke, for whom, on which release?" | Sentry (server + client), `requestId`/`user`/`release`-tagged | `console.error` (replaced) |

Errors are technically a slice of logs+events, but we list Sentry separately because it is the
operational center of gravity for incidents and release health.

## 38.5 Target: error tracking (Sentry, PII-scrubbed)

**Server.** Initialize the Sentry Node SDK at boot in `server/src/index.ts`, before the
Express app, gated on `SENTRY_DSN` (absent ⇒ no-op, never a hard dependency). Install the
request/error handlers around the router so unhandled exceptions are captured with full
context. Every event is tagged:

| Tag / context | Value | Source |
|---|---|---|
| `requestId` | the per-request id | `req.requestId` (`requestContext.ts`) |
| `user` | `{ id }` only — **never** email/PII | `req.user.id` |
| `release` | git SHA / version | build-time env (`SENTRY_RELEASE`) |
| `environment` | `production` / `preview` / `dev` | `NODE_ENV` / deploy env |
| `venture_id`, `run_id`, `tick` | when in an Autopilot loop | loop context (A1/A2) |

**Client.** The browser SDK (separate DSN) captures front-end exceptions and unhandled
rejections, with the same `release`/`environment` tagging and **source maps uploaded at build**
so stack traces are readable. Browser session/replay sampling is conservative and PII-masked.

**PII / secret scrubbing — reuse what we already have.** This is the critical reuse decision:
Sentry's `beforeSend` runs the event (message, breadcrumbs, request body, headers) through the
**same redaction the guardrails already implement** in `ai/guardrails.ts` — the `SECRET_PATTERNS`
set (OpenAI/OpenRouter `sk-…`, AWS `AKIA…`, Google `AIza…`, GitHub `gh*_…`, Slack `xox*-…`,
Stripe `[sr]k_…`, JWTs, private-key blocks, Bearer tokens) plus `EMAIL_RE`, with the
`redactSecret` masker so a flagged credential is never echoed. We factor that pattern table out
of `guardrails.ts` into a shared `redaction` module so guardrails, pino, and Sentry all scrub
identically — **one definition, three consumers.** Authorization headers, cookies, and the
known secret env vars are dropped wholesale.

**Release health.** Sentry's crash-free-session/release data is the source for the North Star's
**"healthy"** computation (§6.2): a deploy that produces a new error spike attributable to it
within the watch window is *unhealthy* and excludes the shipped goal. This is why error
tracking is not just ops hygiene — it is wired into the product's top-line metric.

**Acceptance (F0):** an exception shows in Sentry with `requestId` + user id; secrets/PII are
absent from the captured payload; client errors carry readable source-mapped traces.
**Owner action:** create a Sentry project → set `SENTRY_DSN` (server) + a client DSN.

## 38.6 Target: structured logging (pino)

Replace the **62 raw `console.*`** calls in `server/src` with a single pino logger, while
**keeping the existing JSON request line** (it is already the right shape — pino just gives it
levels, redaction, and a correlation child).

- **Levels.** `fatal | error | warn | info | debug | trace`; default `info` in prod, `debug`
  in dev, overridable via `LOG_LEVEL`. The `http_request` line stays at `info`.
- **Correlation.** A per-request child logger bound to `requestId` (and `userId`, `venture_id`
  when present) via `req`-scoped context, so every line within a request joins to the request
  and to Sentry events by the same id.
- **Redaction.** pino `redact` paths for known secret-bearing fields **plus** the shared
  `redaction` module (§38.5) as a serializer hook, so a token never reaches stdout even if a
  developer logs an object that happens to contain one.
- **Format.** NDJSON to stdout (Railway/Cloudflare collect stdout); `pino-pretty` only in dev.
- **Migration discipline.** A lint rule (`no-console` in `server/src`, allowing the logger
  module) prevents regression to `console.*` after the sweep — the count goes from 62 to 0 and
  stays there.

| What changes | Before | After |
|---|---|---|
| Call sites | 62 × `console.log/info/warn/error` | one `log` import; leveled calls |
| Correlation | only the one request line | every line carries `requestId` |
| Redaction | none (secrets can leak) | shared scrubber on every line |
| Searchability | grep stdout | structured, level-filterable NDJSON |

**Acceptance (F0):** `console.*` count in `server/src` is 0 (lint-enforced); logs are
level-filterable and `requestId`-correlated; a logged object containing a key is redacted.

## 38.7 Target: metrics (`prom-client` + `/metrics`)

Add `prom-client`, register a default + custom registry, and expose `GET /metrics` on the
system router, **admin/network-guarded** (same guard posture as the admin dashboard; reachable
only by the scraper/admin, never public — metrics leak topology and volume). The exporter emits
**the exact signals `alerting-thresholds.md` lists and nothing feeds today**:

| Metric (Prometheus name) | Type | Labels | Feeds which alert (`alerting-thresholds.md`) |
|---|---|---|---|
| `http_requests_total` | counter | `method`, `route`, `status_class` | 5xx rate §1.1/§1.2 (`status_class="5xx"` ÷ total) |
| `http_request_duration_seconds` | histogram | `route`, `method` | p95/p99 latency §2.1/§2.2; image p95 §2.3 (`route=/api/image/*`) |
| `http_requests_429_total` | counter | `route` | 429 ratio §4.1/§4.2 |
| `image_requests_total` | counter | `outcome` (`ok`/`timeout`/`error`) | image error ratio §2.4 |
| `queue_depth` | gauge | `queue` | capacity / backpressure (F2); operator dashboard |
| `queue_stalled_jobs` | gauge | `queue` | stuck-worker detection |
| `provider_requests_total` | counter | `provider`, `model`, `outcome` | per-provider error rate (F1; §6.5 guardrail) |
| `provider_request_duration_seconds` | histogram | `provider`, `model` | per-provider latency (F1) |
| `provider_429_total` | counter | `provider`, `model` | key-pool cooldown signal (F1) |
| `provider_circuit_state` | gauge | `provider`, `model` | breaker open/half-open/closed (F1) |
| `model_cost_usd_total` | counter | `provider`, `byok` (`true`/`false`) | cost alerts §5.x; BYOK ratio (§6.3.4) |
| `process_*` (default) | gauge/counter | — | CPU/memory capacity §3.x |

**Latency percentiles.** p95/p99 are computed from `http_request_duration_seconds` buckets
(histogram quantiles) — we do not store every sample; bucket boundaries are chosen around the
2.5s/5s thresholds so the alert math is accurate near the line.

**Per-provider counters.** These are the audit's #1 finding made visible (F1 + §6.5): the
gateway (`ai/gateway.ts`) increments `provider_requests_total{outcome}`, observes duration, and
sets `provider_circuit_state` on every model call, so a degraded provider is *charted*, not
silently retried. `model_cost_usd_total` splits BYOK vs platform-key spend for the margin and
BYOK-ratio metrics (§6.3.4).

**Scraping.** A Prometheus-compatible scraper (self-hosted Prometheus, Grafana Agent, or the
host's metrics pipeline) pulls `/metrics`; for the no-backend-yet interim, a cron reads
`/metrics` and evaluates thresholds directly (§38.10). The **gauge values also surface in the
admin dashboard** so the operator sees queue depth, stalled jobs, and breaker state without a
Grafana login (§38.9).

**Acceptance (F0):** `/metrics` exposes the alerting signals above; provider error rate is
visible; queue depth + stalled jobs are gauged.
**Owner action:** none for the exporter; optional — point a Prometheus/Grafana stack at it.

## 38.8 Target: distributed tracing (`requestId` → spans)

Today `requestId` dies at the HTTP edge. The target threads it through every async hop so one
id follows a request — or an autonomous tick — across the whole system.

```
edge (requestContext.ts)  ──requestId──►  AI gateway (ai/gateway.ts)
        │                                        │  span: provider call (provider,model,tokens,$)
        │                                        ▼
        ├──requestId──►  BullMQ enqueue  ──(job.data.traceId)──►  studio worker
        │                  span: queue wait                         span: build/render
        ▼                                                              │
   Sentry event + pino lines, all keyed by requestId  ◄───────────────┘
        │
        ├──► Cloudflare Durable Object (UserCoordinatorDO / VentureDO)  span: DO op
        └──► Cloudflare Workflow step                                    span: workflow step
```

- **Carrier.** `requestId` is the trace id; we propagate it explicitly: into gateway calls as a
  field, into BullMQ as `job.data.traceId` (jobs lose the HTTP context, so the id must ride the
  payload), into the studio worker via the same payload, and into Cloudflare DO/Workflow calls
  via a header on the sub-request (`X-Request-Id`, already the convention in `requestContext.ts`).
- **Spans.** Start lightweight: **manual span ids** (parent `requestId` + monotonic child ids)
  emitted as structured pino lines with `span`, `parent`, `startMs`, `durMs`. This needs no
  vendor and works across the Express/BullMQ/Workers boundary where a single OTel SDK does not
  span cleanly. F0 explicitly allows *"lightweight OTel or manual span ids."*
- **Upgrade path.** When a backend warrants it, swap the manual ids for OpenTelemetry spans
  with the same `requestId` as the trace id — the carrier convention is unchanged, so the
  upgrade is a serializer swap, not a re-architecture. We deliberately do **not** adopt full
  OTel on day one (the audit notes no OTel today; we add value before we add a heavy SDK).

**Acceptance (F0):** a slow or failed ship is followable end-to-end by one `requestId` across
gateway, queue, and worker; a Sentry exception links to the same id.

## 38.9 Target: dashboards

Three dashboards, three audiences (matching §6.7.1). Each names its backing source so it is
auditable. The **Operator dashboard extends today's admin dashboard** (`systemDashboard.ts`) —
we add to it, we don't replace it.

| Dashboard | Audience | Primary panels | Backing source |
|---|---|---|---|
| **Operator** | Ops / Owner, per-tenant operator (§14) | live activity stream, run/tick health, **queue depth + stalled jobs**, stuck Ventures, kill-switch state, **provider breaker status**, upstream tool health (existing pings), capability notices | `venture_events`, F0 exporter gauges, BullMQ liveness, `systemDashboard.ts` |
| **Business** | Owner / GTM | North Star (WSHI/AU), activation funnel w/ drop-off reasons, AARRR, cohort retention, ARPA/NRR | `venture_events` aggregations, billing |
| **Reliability** | Ops / SRE | 5xx & latency vs `alerting-thresholds.md`, per-provider error/latency/429, **error-budget burn** (§37), cost-vs-budget, Sentry release health | F0 exporter, Sentry, cost meters |

The Reliability dashboard is the one that makes the documented thresholds **live for the first
time** — it is their first real data source. The Operator dashboard's new panels (queue depth,
stalled jobs, breaker state, worker/Redis liveness) close the "worker/Redis blind" gap (§38.3)
without requiring a Grafana login for routine operations.

## 38.10 Target: alerting & on-call routing

A metric nobody is paged on is a chart, not an alert. §6.7 makes this an acceptance bar: a
guardrail is "instrumented" only when it is **wired to a real alert**, not merely charted. Two
mechanisms, both honest about what exists:

1. **Sentry alert rules** — exception spikes, new-issue-in-release, crash-free-rate drops →
   notification channels. Native to the error pillar.
2. **Threshold evaluator (cron)** — a scheduled job reads `/metrics` (or queries the
   time-series store) and evaluates **every rule in `alerting-thresholds.md`** with its exact
   numbers and durations, firing to the same channels. This is the bridge that gives the
   documented thresholds teeth even before a full Prometheus Alertmanager is stood up.

Mapping the documented rules to their now-real signals:

| Rule (`alerting-thresholds.md`) | Severity | Signal that now feeds it | Evaluator |
|---|---|---|---|
| 5xx rate > 3% / 5m | Critical | `http_requests_total{status_class="5xx"}` ÷ total | cron |
| 5xx rate > 1% / 10m | Warning | same | cron |
| `/api/health` failing ×3 | Critical | health probe (`routes/system.ts`) | uptime check |
| `/api/system/ready` 503 ×2 | Warning | readiness probe (`routes/system.ts:322`) | uptime check |
| p95 latency > 2.5s / 10m · > 5s / 5m | Warn / Crit | `http_request_duration_seconds` quantile | cron |
| `/api/image/*` p95 > 30s; err ratio > 10% | Warn / Crit | image histogram + `image_requests_total` | cron |
| CPU > 65/80%; Mem > 70/85% | Warn / Crit | `process_*` default metrics | cron / host |
| 429 ratio > 5% / 15% | Warn / Crit | `http_requests_429_total` ÷ total | cron |
| Single IP > 10× baseline | Warning | per-IP request counter (abuse) | cron |
| Daily/monthly spend 60/85/70/90% | Warn / Crit | `model_cost_usd_total` vs budget (§40/A7) | cron |
| Provider breaker open (F1) | Warning | `provider_circuit_state` | cron |

**On-call routing.** Severity drives the channel: **Critical** pages on-call (PagerDuty/Opsgenie
or the chosen pager) with an ack SLA; **Warning** posts to the ops channel (Slack/email) for
business-hours triage; **cost** alerts also notify the Owner (budget is a business decision).
Each alert carries the offending `requestId`/provider/route and a link to the runbook (§50) so
the responder starts mid-diagnosis, not from zero. The on-call schedule, escalation policy, and
ack SLAs live in §37 (SLOs/error budgets) and §50 (runbooks); this section owns the **signal →
alert → channel** wiring.

**Acceptance (F0):** the documented thresholds fire real notifications; a 5xx spike pages
on-call; a cost overrun notifies the Owner.
**Owner action:** provide notification channel webhooks (pager + ops channel) and set the
budget figures the cost alerts compare against.

## 38.11 Target: security / admin audit log (seeds `venture_events`)

The in-memory notices ring (§38.2) is good for capability gaps but is **not** a security audit
trail — it is lost on restart and single-process. F0 requires a **durable, append-only audit
log**. This table is also the substrate that seeds Autopilot's `venture_events` (§6.7, A1): one
write, two uses — forensic trail *and* analytics/audit source of truth.

**Table `audit_log` (append-only, per-tenant RLS).** Indicative shape (full DDL in §26):

| Column | Purpose |
|---|---|
| `id`, `created_at` | identity + ordering (append-only; no update/delete) |
| `actor_id`, `actor_type` | who: user, agent (loop), or system |
| `action` | typed verb: `role.change`, `project.delete`, `auth.login`, `auth.logout`, `auth.device.revoke`, `deploy.live`, `budget.change`, `kill.triggered`, `connection.connect` |
| `target_type`, `target_id` | what was acted on |
| `requestId` | correlates to logs/traces/Sentry |
| `payload` | redacted (shared scrubber, §38.5) before/after where relevant |
| `tenant_id` / `user_id` | RLS isolation key |

**What is audited (F0 list):** role changes, project deletes, auth events (login/logout/device
revoke — ties to F3 sessions), deploys, budget changes, kill-switch triggers, connection
lifecycle. Writes are **best-effort-but-logged**: an audit-write failure is itself an error
(Sentry), never silently dropped, but never blocks the user action. Append-only is enforced at
the DB layer (no UPDATE/DELETE grant; RLS read-only to the tenant, write via service role).

**Acceptance (F0):** a role change and a project delete each appear in the audit log with actor,
target, and `requestId`; the table is append-only; per-tenant reads are RLS-isolated.

## 38.12 Instrumentation conventions

So instrumentation is consistent across every contributor and every Autopilot loop:

- **One id to rule them.** `requestId` is the universal correlation key — it appears in every
  pino line, every Sentry event, every span, every audit row, and rides every job/sub-request.
  Autonomy adds `venture_id`, `run_id`, `tick` alongside it (never instead of it).
- **Emit at the point of action** (§6.7 acceptance): a counter/event is incremented where the
  thing happens, not reconstructed later from logs.
- **Naming.** Prometheus metrics use `snake_case` with a unit suffix (`_total`, `_seconds`,
  `_usd_total`); labels are low-cardinality (route templates, not raw paths; `provider`/`model`,
  not per-request ids — never put `requestId` or `user_id` in a metric label).
- **Levels.** `error` = a human may need to act; `warn` = degraded but handled (a guardrail
  flag, a provider fallback); `info` = lifecycle (the request line, a deploy); `debug`/`trace`
  = dev only.
- **Honesty carries over.** The platform's existing honesty layer (capability notices, the
  `ok/empty/error` tool status, the dashboard's `connected` flags) is observability too — a
  degraded fallback is *recorded*, not hidden. The target makes those records durable.
- **Flag-safe & additive.** Every piece (Sentry, exporter, audit writer) is gated on its env
  var and is a no-op when absent — observability never becomes a hard runtime dependency that
  can take the product down (the F-series rule: flag-safe, additive, shippable).

## 38.13 What to log — and what to NEVER log

The single highest-risk failure mode of observability is **leaking the secrets it was meant to
help protect.** Hard rules:

| Always log | Never log |
|---|---|
| `requestId`, route template, method, status, latency | API keys / tokens / `sk-…`, `AKIA…`, `gh*_…`, Stripe `[sr]k_…` (the `SECRET_PATTERNS` set) |
| `user_id` (opaque id) | user email / name / phone / address (PII) |
| provider, model, outcome, token counts, $ cost | raw model prompts/completions containing user content (log lengths/hashes, not bodies) |
| audit action, actor, target | `Authorization`/`Cookie` headers; session tokens; JWTs |
| error type, redacted message, stack | private-key blocks; Bearer tokens; `.env` values |
| queue depth, breaker state, cost meters | full request/response bodies by default |

Enforcement is **defense-in-depth, not a promise**: (1) pino `redact` paths drop known fields;
(2) the **shared `redaction` module** (factored from `guardrails.ts`) runs as a serializer on
logs, a `beforeSend` on Sentry, and a payload scrubber on audit writes — the same patterns that
already guard model *output* now guard our *telemetry*; (3) `Authorization`/`Cookie` headers and
secret env vars are dropped wholesale; (4) the `no-console` lint rule prevents an un-redacted
`console.log` from sneaking a secret to stdout. The audit's existing guardrail redaction
(`redactSecret`, `SECRET_PATTERNS`, `EMAIL_RE`) is the proven core we reuse rather than
reinvent.

## 38.14 Mapping to F0 (nothing dropped)

Every F0 task → its home in this section, so the spec is a complete, gated answer to the #1 gap.

| F0 task | Section | Acceptance gate |
|---|---|---|
| Sentry (server + client), `requestId`/release tagging, source maps, PII scrub via guardrails | §38.5 | exception in Sentry w/ `requestId` + user; no PII in payload |
| Replace `console.*` with pino; keep JSON request line; levels + redaction | §38.6 | `console.*` count = 0; correlated, redacted logs |
| `prom-client` + `/metrics` (admin-guarded): 5xx, p95/p99, 429, queue depth, per-provider error/latency, cost | §38.7 | `/metrics` exposes the `alerting-thresholds.md` signals |
| Propagate `requestId` through gateway, BullMQ, studio worker (lightweight OTel / manual spans) | §38.8 | one id follows a request across services |
| BullMQ worker + Redis liveness (depth, stalled) in the dashboard | §38.7, §38.9 | depth + stalled jobs gauged and shown |
| Security/admin audit log table + writer (append-only; seeds `venture_events`) | §38.11 | role change + delete in append-only audit log |
| Wire documented thresholds to real alerts (Sentry alerts / cron check) | §38.10 | a 5xx spike pages on-call; cost overrun notifies Owner |

**Strengths preserved (not regressed):** the JSON request line, the health/ready probes, the
live admin dashboard with honest `connected` flags, and the guardrail/capability honesty layer
— all kept and extended, never replaced.

## 38.15 Open questions

- **Time-series backend.** Self-hosted Prometheus + Grafana, a managed metrics vendor, or lean
  on the host's pipeline? The exporter is backend-agnostic; the cron evaluator (§38.10) makes
  the thresholds work *before* this is decided. Resolve with §40 (cost) + ops capacity.
- **Log retention & cost.** NDJSON volume at 24/7 autonomous scale can be large; what retention
  window and sampling (e.g. `debug` off in prod, request-line always on) balances forensics vs
  spend? Resolve with §40.
- **Trace upgrade trigger.** At what volume/complexity do manual span ids stop paying their way
  and OTel earns its weight? Define the trigger (e.g. >N services, cross-account traces) rather
  than adopting OTel speculatively.
- **Audit immutability bar.** Is DB append-only sufficient, or do compliance needs (§36) demand
  WORM storage / hash-chaining for tamper-evidence? Resolve with §35/§36.

---

*Next: [39 — Performance & scalability](./39-performance-scalability.md). Upstream:
[37 — Reliability & SRE](./37-reliability-sre.md) (consumes these signals as SLOs),
[06 §6.7](./06-metrics-kpis.md) (the three-plane instrumentation plan). Foundation canon:
[F0](../F-ENTERPRISE-FOUNDATIONS.md) · [alerting-thresholds](../../../production/alerting-thresholds.md).*
