# 10 — Feature Catalog

> Part II · Product Definition · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan](../00-MASTER-PLAN.md) · [Foundations](../F-ENTERPRISE-FOUNDATIONS.md) ·
> [Executive Summary](./00-executive-summary.md) · [Personas](./03-personas-jtbd.md)

## 10.1 How to read this catalog

This is the **complete, traceable inventory of features** in Code Studio Autopilot, organized
by functional area. It is the bridge between *strategy* (Parts I) and *delivery* (Part V): every
feature here maps forward to a UX section, an architecture section, and — most importantly — a
**delivery epic** that actually ships it. Nothing in this catalog is orphaned.

Each feature row carries four fields:

- **Description** — what it does, in one honest line.
- **MoSCoW priority** — **Must** (GA-blocking), **Should** (strongly wanted, can trail GA by one
  release), **Could** (valuable, opportunistic), **Won't-yet** (deliberately out of the current
  horizon — *not* "never"; the decision and its trigger are recorded).
- **Persona(s)** — who is served, using the [persona codes](./03-personas-jtbd.md): **Maya**
  (non-technical founder, P1), **Dev** (solo developer, P1), **Sam** (agency lead, P2),
  **Riley** (existing creator, P2), **Ops** (owner/operator, internal P1).
- **Epic** — the delivery epic that ships it: **A0–A9** (the autonomy backlog in
  [00-MASTER-PLAN.md](../00-MASTER-PLAN.md) §9) or **F0–F10** (the enterprise foundations in
  [F-ENTERPRISE-FOUNDATIONS.md](../F-ENTERPRISE-FOUNDATIONS.md)). A feature shipped by two epics
  cites both (the foundation that enables it, then the autonomy epic that surfaces it).

**Honesty note (house rule):** none of these features is shipped yet — the whole A/F program is
planned. The MoSCoW column therefore expresses *intended priority for the build*, not current
state. Status against the build is tracked in [`../STATUS.md`](../STATUS.md), not here.

The terminology (Venture, Goal, Run, Tick, Checkpoint, Budget, Connection, Adapter, Operator
Console) is the canon glossary from [00-MASTER-PLAN.md](../00-MASTER-PLAN.md) §2.

---

## 10.2 Intake & Roadmap

The on-ramp: turning a sentence into an approved plan the agents can execute. This area is the
single biggest driver of Maya's adoption — if intake doesn't feel smart, nothing else gets a
chance.

| Feature | Description | Priority | Personas | Epic |
|---|---|---|---|---|
| Plain-language idea capture | A free-text intake where the user describes a product/business idea in their own words; no schema, no jargon. | Must | Maya, Dev, Sam | A3, 13 |
| Clarifying-question loop | The intake agent asks a short, adaptive set of questions to disambiguate scope, audience, and success criteria before drafting. | Must | Maya, Sam | A3 |
| Venture spec generation | LLM produces a structured `{ name, summary, scope, success_metrics }` spec from the idea + answers. | Must | Maya, Dev, Sam | A3 |
| Roadmap generation (epics→features→tasks) | A structured `VentureGoal[]` backlog with priorities, dependencies, and estimates, derived from the spec. | Must | Maya, Dev, Sam | A3 |
| Roadmap review & edit | The user can reorder, edit, add, or delete goals before approving — the plan is theirs, not the agent's. | Must | Maya, Dev | A3, A8 |
| Roadmap approval checkpoint | The initial roadmap is a hard checkpoint; the Venture stays `draft` until approved, then flips to `active`. | Must | Maya, Sam, Ops | A0, A3 |
| Scope definition & capture | The approved `scope` is persisted and becomes the boundary the scope guard enforces. | Must | Maya, Sam, Ops | A3 |
| Template/vertical starters | Pre-seeded intakes for common shapes (landing page, simple SaaS, creative app for Riley). | Should | Maya, Riley | A3 |
| Idea import from existing project | Seed a Venture's roadmap from an existing `studio_project` or GitHub repo instead of from scratch. | Could | Dev | A3, A4 |
| Re-intake / roadmap regeneration | Re-run intake to materially re-plan a Venture (gated by a scope checkpoint if it changes scope). | Should | Maya, Dev | A3 |

---

## 10.3 Autonomous Engine

The heart: the durable, governed loop. Every feature here is either *the loop itself* or *a
brake on the loop*. Per the prime directive, the brakes (A0) ship before the engine (A2).

| Feature | Description | Priority | Personas | Epic |
|---|---|---|---|---|
| The OODA tick (SENSE→ORIENT→DECIDE→ACT→VERIFY→SHIP→REFLECT) | One resumable, metered, logged pass of the loop; the atomic unit of work. | Must | All | A2 |
| Repeatable scheduler / heartbeat | Picks active, non-paused, in-budget Ventures and enqueues a tick on a cadence (BullMQ repeatable; DO Alarm in the CF topology). | Must | Ops, Dev | A2 |
| Goal selection (ORIENT) | A cost-aware LLM call assesses Venture state vs roadmap and selects the next highest-value Goal with a rationale. | Must | Maya, Dev | A2 |
| Budget gate (DECIDE) | Deterministic, no-LLM check that the proposed action fits remaining budget *before* spending. | Must | Maya, Ops, Sam | A0, A2 |
| Checkpoint gate (DECIDE) | Deterministic check of whether the action requires human approval; if so, enqueue a checkpoint and pause that goal. | Must | Maya, Ops | A0, A2 |
| Scope guard | ORIENT may not pursue goals outside the approved scope without raising a scope checkpoint — prevents drift and runaway feature invention. | Must | Maya, Sam, Ops | A3, A6 |
| No-progress / stuck detector | Same goal fails or same error repeats N times → pause and raise a checkpoint instead of looping forever. | Must | Maya, Dev, Ops | A0, A2 |
| Max-ticks-per-run + wall-clock-per-tick caps | Hard bounds so a run can never spin indefinitely or hang a tick. | Must | Ops | A0, A2 |
| Global kill switch | One flag (`VENTURES_KILL`) halts *every* Venture immediately; checked every tick. | Must | Ops | A0, A2 |
| Per-Venture pause / resume | The user (or a breach) can pause one Venture and resume it later from durable state. | Must | Maya, Dev, Ops | A2, A8 |
| Per-Venture kill / archive | Permanently stop and archive a Venture. | Must | Maya, Ops | A2, A8 |
| Global concurrency cap | A platform-wide max of concurrent ticks to protect providers and the bill. | Must | Ops | A0, A2 |
| Crash-safe resumption | A worker restart mid-tick resumes cleanly from durable state with no double-spend. | Must | Ops, Dev | A2 |
| Append-only event log (REFLECT) | Every sense/decision/action/deploy/dollar written to `venture_events` with model + prompt hash. | Must | Ops, Sam | A0, A2 |
| External-trigger wake (cron / webhook / message) | Ticks can be triggered by signals, not just the heartbeat (feeds the iterate loop). | Should | Dev, Maya | A2, A6, F10 |
| Configurable autonomy policy | Adjust checkpoint strictness / budget posture per Venture without code changes ("more autonomous" = a policy change, not a rewrite). | Should | Dev, Ops | A0 |
| Multi-Venture fair scheduling | Fairly interleave ticks across many active Ventures for one user (no starvation). | Should | Dev, Sam | A2, F2 |

---

## 10.4 Build & Iterate

Where code actually gets written. This area is almost entirely **reuse** of the existing Phase-4
build loop and swarm; the new work is wiring it into the tick and keeping diffs minimal.

| Feature | Description | Priority | Personas | Epic |
|---|---|---|---|---|
| Agentic build loop (plan→write→run→observe→fix) | The existing Phase-4 loop runs against the chosen Goal, producing a new `studio_version` on success. | Must | Maya, Dev | A4 |
| Swarm code agent (decomposition) | Larger goals are decomposed and parallelized via the existing multi-agent swarm. | Should | Dev | A4 |
| Real verification (typecheck/build/tests + preview health) | `verifyApp.ts` + build/typecheck/tests gate anything before it ships. | Must | Dev, Maya | A4 |
| Code-safety + secret scan pre-ship | Diffs scanned for committed secrets, injection sinks, and dangerous ops before VERIFY passes. | Must | Ops, Sam | A4, A9 |
| Minimal-diff iteration | Changes are minimal, scoped diffs (reuse `buildGuards.ts`), not wholesale rewrites. | Should | Dev | A4 |
| Per-goal iteration cap | Bounded FIX attempts per goal; exceeding the cap raises a checkpoint. | Must | Dev, Ops | A4, A0 |
| Versioning & history | Every successful build is a durable `studio_version`; full history is browsable. | Must | Dev, Maya | A4 |
| In-browser code editor | View and edit the real multi-file code at any time ("code optional, never code-locked"). | Should | Dev | 15 |
| Manual takeover / redirect mid-loop | Pause autonomy, edit by hand or redirect the loop to a new goal, then hand control back. | Must | Dev, Maya | A8, 15 |
| GitHub two-way sync | Push to / pull from the user's repo; the agent can open PRs the user reviews. | Should | Dev, Sam | A4 |
| Diff / PR review surface | Review the agent's changes as a diff or PR before they land. | Should | Dev | 15 |
| Optimistic-concurrency safe saves | Versioned, transactional file upserts so concurrent edits can't interleave-corrupt a project. | Must | Dev, Ops | F2 |
| Live build trace | Real-time view of plan/act/run/fix steps (reuse `SwarmTraceCard`/`ActivityFeed`). | Must | Dev, Maya | A8 |
| Frontier-model routing for hard goals | Route difficult coding goals to stronger models via BYOK/credits; auto-router otherwise. | Should | Dev | F1, A4 |

---

## 10.5 Deploy

Making it real on the internet. Provider-agnostic via the Adapter contract; managed previews
are automatic, production is always behind a human checkpoint.

| Feature | Description | Priority | Personas | Epic |
|---|---|---|---|---|
| Managed preview deploy | Automatic deploy to `*.dreamstreamstudio.ai` via `studio-worker/`; the "few clicks → it's live" wow. | Must | Maya, Riley | A5 |
| Production deploy checkpoint | The first production deploy (and any custom-domain go-live) is always a human checkpoint. | Must | Maya, Sam, Ops | A0, A5 |
| Deploy adapter contract + registry | A single `deploy()`/`provision()`/`status()`/`rollback()` interface so the loop is provider-agnostic. | Must | Dev, Ops | A5 |
| BYO Cloudflare adapter (Pages/Workers) | Deploy to the user's own Cloudflare account via Connection/PAT, least-privilege scopes. | Must | Dev, Sam | A5 |
| BYO Vercel adapter | Deploy to the user's Vercel account. | Should | Dev, Sam | A5 |
| BYO Railway adapter | Deploy to the user's Railway account. | Should | Dev, Sam | A5 |
| Supabase provisioning adapter | Optional per-project DB/auth/storage provisioning on the user's Supabase. | Should | Dev, Sam | A5 |
| Rollback | Roll a deployment back to a previous good version. | Must | Dev, Maya, Ops | A5, A8 |
| Custom domains | Attach a custom domain to a production deployment (go-live is a checkpoint). | Could | Maya, Sam | A5 |
| Deployment records & status | Every deploy recorded in `studio_deployments` (with `venture_id`); status surfaced to the user. | Must | Dev, Maya | A5 |
| Per-Venture deploy tokens (revocable) | Each adapter holds minimum, per-Venture, revocable scopes; tokens never logged. | Must | Sam, Ops | A5, A9 |

---

## 10.6 Sense & Observe (the iterate loop)

"Never stop *iterating*" needs eyes. This area feeds real signals into SENSE so the loop chooses
improvements, not just the next backlog item — the visible "it keeps improving itself" behavior.

| Feature | Description | Priority | Personas | Epic |
|---|---|---|---|---|
| Deploy / uptime health checks | Per-live-deployment health probes; results written to `venture_events`. | Must | Maya, Dev, Ops | A6 |
| Runtime error ingestion | A tiny error collector in deployed apps posts to a rate-limited, owner-scoped signals endpoint. | Must | Dev, Maya | A6 |
| Error → fix-goal creation | An ingested error becomes a signal → ORIENT proposes a fix goal → loop fixes it (within scope/budget). | Must | Maya, Dev | A6 |
| Basic analytics (page views / events) | Lightweight usage signals feed SENSE. | Should | Maya, Sam | A6 |
| Feedback widget hook | An in-app feedback channel whose entries become candidate goals. | Could | Maya | A6 |
| Inbound webhook signals | Nango sync / MCP push / third-party webhooks become SENSE signals. | Should | Dev, Sam | F10, A6 |
| Improvement-goal proposals (perf/UX) | ORIENT can create new perf/UX goals from signals, within scope. | Should | Maya, Dev | A6 |
| Anomaly / spend-spike detection | Spend spikes, runaway loops, or suspicious egress auto-pause the Venture and alert. | Must | Ops | A9, A6 |

---

## 10.7 Operator Console

The 24/7 cockpit — the surface where the user watches, approves, and steers. This is what makes
the autonomy legible and therefore trustworthy.

| Feature | Description | Priority | Personas | Epic |
|---|---|---|---|---|
| Live activity stream | Real-time `venture_events` over SSE; the human-readable "what is my agent doing right now?". | Must | Maya, Dev | A8 |
| Roadmap / backlog board | Goals grouped by status; drag to reprioritize (writes back to goals). | Must | Maya, Dev | A8 |
| Approval queue (checkpoints) | Pending checkpoints with context and one-click approve/deny. | Must | Maya, Sam, Ops | A8 |
| Budget meter + spend display | Live spend vs cap per Venture, always visible. | Must | Maya, Sam | A7, A8 |
| Pause / resume / kill controls | Per-Venture and global controls, one click. | Must | Maya, Dev, Ops | A8 |
| Deployments panel | Preview/prod links, status, and rollback in one place. | Must | Maya, Dev | A5, A8 |
| Logs viewer | Build/run/deploy logs for the Venture. | Should | Dev, Ops | A8 |
| Venture list / dashboard | All of a user's Ventures with status, spend, and health at a glance. | Must | Dev, Sam, Maya | A8 |
| Intake wizard (surfaced) | The A3 intake flow lives in the console. | Must | Maya | A3, A8 |
| Mobile-responsive console | The console works on a phone (approve a checkpoint from anywhere). | Should | Maya, Dev | A8, 19 |
| Real-time multi-device sync | Console state converges instantly across the user's devices/tabs (Durable Object backed). | Should | Dev, Maya | F4 |

---

## 10.8 Approvals & Notifications

The human-in-the-loop fabric. Checkpoints are how autonomy stays safe; notifications are how the
user is never surprised.

| Feature | Description | Priority | Personas | Epic |
|---|---|---|---|---|
| Checkpoint queue (the 6 types) | Prod deploy, spend money, destructive op, publish externally, scope change, roadmap approval — all surfaced for approval. | Must | Maya, Sam, Ops | A0, A8 |
| One-click approve / deny | Resolve a checkpoint with a single action; the relevant goal resumes or stops. | Must | Maya, Dev | A8 |
| In-app notifications | Real-time in-app alerts for checkpoints, breaches, and key events. | Must | Maya, Dev | A8 |
| Email notifications | Email for checkpoints and budget alerts when the user isn't in-app. | Must | Maya, Sam | A7, A8 |
| Spend / budget alerts (80% / 100%) | Threshold alerts before and at cap. | Must | Maya, Sam, Ops | A7 |
| Escalation / reminders | Unresolved checkpoints re-notify after a delay so nothing stalls silently. | Should | Maya, Sam | A8 |
| Suspicious-login / security alerts | New-device/geo and security-relevant events notify + audit. | Should | Ops, Dev | F3, F0 |
| Per-Venture notification preferences | Choose channels/quiet hours per Venture. | Could | Dev, Sam | A8 |

---

## 10.9 Billing & Budgets

The "one central payment portal." Reuses the existing Stripe + ledger machinery, tagged per
Venture. Budgets are a *security control*, not just an accounting feature.

| Feature | Description | Priority | Personas | Epic |
|---|---|---|---|---|
| Per-Venture spend meter | Tokens + compute + managed-hosting cost, tagged by `venture_id`, surfaced live. | Must | Maya, Sam, Ops | A0, A7 |
| Budget sliders (caps) | Set `usd_per_day`, `usd_total`, `max_tokens`, `max_container_minutes` per Venture. | Must | Maya, Sam | A0, A7 |
| Hard-pause on breach | Hitting a cap pauses the Venture and alerts — no overrun is possible. | Must | Maya, Ops | A0 |
| Credits / top-up (Stripe Checkout) | Buy credits; topping up raises available headroom. | Must | Maya, Dev, Sam | A7 |
| Plans & entitlements | Plan-gated features and quotas (reuse `rbac.ts`/`modelAccessPolicy.ts`). | Should | Maya, Dev, Ops | A7 |
| Invoices & receipts | Downloadable invoices; per-client billing clarity for Sam. | Should | Sam, Maya | A7 |
| Per-client / per-Venture spend report | Clean cost attribution across a portfolio of Ventures. | Should | Sam | A7 |
| BYO vs managed cost transparency | The portal shows provider-paid (BYO) vs platform-fronted (managed) cost separately — no billing surprises. | Must | Maya, Sam, Ops | A7 |
| Billing reconciliation | Daily reconciliation extended to include Venture compute (`dailyBillingReconciliation.ts`). | Must | Ops | A7 |
| Re-auth on billing actions | Sensitive billing changes require step-up re-auth. | Should | Ops, Sam | F3 |

---

## 10.10 Integrations & Connections

How a Venture reaches the outside world — provider accounts, connectors, and MCP tools — with
health and expiry tracked, not forgotten.

| Feature | Description | Priority | Personas | Epic |
|---|---|---|---|---|
| Connect provider accounts (BYO) | Link Cloudflare/Vercel/Railway/Supabase/GitHub via Nango/OAuth/PAT, stored as `venture_connections` (reference only). | Must | Dev, Sam | A5, F10 |
| Unified connector catalog | One surface spanning Nango + MCP connections with scopes, owner, and state. | Should | Dev, Sam, Ops | F10 |
| MCP tools | Per-Venture MCP tool access (reuse `mcpRegistry`/`mcpClient`). | Should | Dev | F10 |
| Connection health & expiry tracking | OAuth lifecycle observability — "your Slack connection expired" surfaced, not silently failing. | Should | Dev, Sam, Ops | F10 |
| Inbound webhooks (beyond Stripe) | Nango sync / MCP push events consumed end-to-end (feeds SENSE). | Should | Dev, Sam | F10, A6 |
| Connection retries / auto-disable | Retries on MCP calls; auto-disable-after-N-fails to protect the loop. | Should | Dev, Ops | F10 |
| Per-Venture connection isolation | A connection belongs to one Venture; no cross-Venture credential reuse. | Must | Sam, Ops | A5, A9 |

---

## 10.11 Identity, Sessions & Multi-device

The foundation under everything. Audited as a real gap (F3/F4); these features make identity
authoritative and multi-device behavior real.

| Feature | Description | Priority | Personas | Epic |
|---|---|---|---|---|
| First-party server-side sessions | Session records layered on the Supabase JWT, enabling timeouts and binding. | Must | Ops, Dev | F3 |
| Idle + absolute session timeouts | Sessions expire on inactivity and on an absolute lifetime. | Must | Ops, Sam | F3 |
| Local JWT verification (JWKS) | Verify tokens locally instead of a per-request `getUser()` round-trip — faster, no hard Supabase dependency per call. | Must | Ops, Dev | F3 |
| Authoritative device registry | A real `user_devices` registry (with its missing migration), not a best-effort list. | Must | Dev, Maya | F3, F6 |
| Per-device sign-out (real revocation) | Revoking a device actually invalidates its session. | Must | Maya, Dev | F3, F4 |
| Sign-out everywhere (instant) | Global revocation pushed to all devices in real time via the per-user Durable Object. | Must | Maya, Dev, Sam | F4 |
| MFA / TOTP enrollment | Native MFA enrollment (Supabase). | Should | Ops, Sam | F3 |
| Step-up re-auth on sensitive actions | Re-auth required for billing, deploy, and account changes. | Should | Ops, Sam | F3 |
| Real-time cross-device convergence | Edits and state converge across devices/tabs in real time. | Should | Dev, Maya | F4 |
| Offline write outbox | Offline writes queue and sync on reconnect. | Could | Dev | F4 |
| Cross-tab coordination | BroadcastChannel so same-device tabs don't race. | Could | Dev | F4 |

---

## 10.12 Security & Governance

The features that earn the word "secure." Many are also brakes (A0) or audit gates (A9); a few
are platform-wide foundations (F8).

| Feature | Description | Priority | Personas | Epic |
|---|---|---|---|---|
| Append-only audit log | Every decision/action/deploy/dollar is an immutable record — the basis of "what did my agent do?". | Must | Ops, Sam | A0, F0 |
| Tenant isolation (RLS) | Every Venture row + child row is RLS owner-isolated; the worker always scopes by `venture_id` + `user_id`. | Must | Sam, Ops | A0, A1 |
| Per-tenant sandbox isolation | Generated code only ever runs in the per-tenant Cloudflare Container sandbox. | Must | Dev, Sam, Ops | A4 |
| Secrets in Nango (never in DB/client) | BYO credentials live encrypted in Nango; we store only a reference. | Must | Sam, Ops | A5, A9 |
| Full code-safety scan pre-ship | Committed-secret detection, dangerous-op patterns, dependency audit, secret scanning on push. | Must | Ops, Sam | A9 |
| Tenant-isolation audit | Automated proof of no cross-Venture data access; RLS-coverage check across all tables. | Must | Ops, Sam | A9, F6 |
| Human gate on irreversibles | Prod deploys, spending money, domain buys, destructive ops are always checkpoints. | Must | Maya, Sam, Ops | A0 |
| Egress & resource quotas | Per-sandbox CPU/mem/time quotas; rate-limited, logged egress. | Must | Ops | A9 |
| Shared (Redis) rate limits & caps | Limits hold across instances, not per-process. | Must | Ops | F2 |
| Input validation (zod) | Systematic body/query validation with consistent error shapes. | Should | Ops, Dev | F8 |
| Security headers (helmet + CSP) | Hardened, unified headers for the served frontend. | Should | Ops | F8 |
| CI security gates | Dependency/secret scanning + CodeQL block merges on known issues. | Should | Ops | F8, F5 |
| RBAC (roles & permissions) | Role-based access within an account/team. | Could (now) / Should (Sam) | Sam, Ops | A1, F8 |
| Idempotency keys on mutations | Safe retry of build/deploy/billing/intake. | Should | Ops, Dev | F2 |

---

## 10.13 Admin & Ops

The operator's control room — running a multi-tenant autonomous platform safely and profitably.
Primarily serves Ops, but RBAC-aware tenant management later serves Sam.

| Feature | Description | Priority | Personas | Epic |
|---|---|---|---|---|
| System dashboard | Platform health: 5xx rate, latency, queue depth, worker/Redis liveness, cost meters. | Must | Ops | F0 |
| Metrics exporter (`/metrics`) | Prometheus-style metrics feeding the documented alert thresholds. | Must | Ops | F0 |
| Error tracking (Sentry) | Server + client exception capture with `requestId`/user tagging, PII scrubbed. | Must | Ops | F0 |
| Tracing / requestId propagation | Trace context through gateway, BullMQ jobs, and the studio worker. | Should | Ops | F0 |
| Provider reliability controls | Key pool, circuit breaker, cross-provider failover, provider error/latency metrics. | Must | Ops, Dev | F1 |
| Feature flags | Flag-gated rollout (`VENTURES_ENABLED`, GA gating from admin-only → plan-gated). | Must | Ops | A0, A9 |
| Global kill-switch admin control | An admin route to flip `VENTURES_KILL`. | Must | Ops | A0 |
| Tenant management | Admin view/manage of tenants, quotas, and suspensions. | Should | Ops | A9 |
| Incident runbook + kill-switch drill | Documented incident response and a tested kill-switch drill. | Must | Ops | A9 |
| Backpressure / saturation handling | Reject or queue work when the cluster is saturated. | Should | Ops | F2, F0 |
| GA go-live checklist | The gating checklist before flipping autonomy to plan-gated GA. | Must | Ops | A9 |

---

## 10.14 Cross-cutting & enabling features

A handful of features don't sit in one functional area but make the whole catalog work; recorded
here so they aren't lost.

| Feature | Description | Priority | Personas | Epic |
|---|---|---|---|---|
| Migration runner & versioned schema | Ordered, idempotent migrations (the `ventures_*` set + missing `user_devices`); no "run SQL by hand". | Must | Ops | F6 |
| OpenAPI spec + typed client | Documented REST surface and a generated client — a real contract. | Should | Dev, Ops | F7 |
| Unified design system + a11y | One token source, a real `components/ui/` library, WCAG-AA audit, living gallery. | Should | Maya, Dev | F9 |
| Integration / E2E / contract tests | Coverage for the failure-prone paths (auth, RLS, providers) + a CI coverage gate. | Should | Ops, Dev | F5 |
| Multiple concurrent Ventures | One user runs several isolated Ventures at once ("look like a team of five"). | Must | Dev, Sam | A2, F2 |
| Creative-vertical Venture type | The comic/creative pipeline as a Venture vertical for Riley. | Could | Riley | A3 |
| Export / handoff artifacts | Exportable code/artifacts + GitHub handoff for agency delivery. | Should | Sam, Dev | A4 |

---

## 10.15 Summary — counts by priority and by epic

The catalog above lists **~110 features** across 14 functional areas. The two roll-ups below
make the shape of the program explicit; they are the traceability backbone for the delivery plan
([47-roadmap.md](./47-roadmap.md)) and the detailed backlogs ([45](./45-foundations-backlog.md),
[46](./46-autonomy-backlog.md)).

### By MoSCoW priority

| Priority | Count (approx.) | Read | Meaning |
|---|---|---|---|
| **Must** | ~63 | GA-blocking | The non-negotiable spine: the loop, the brakes, intake, build, deploy, budgets, the console, isolation, observability. |
| **Should** | ~37 | Fast-follow | Strongly wanted; can trail GA by one release without breaking the proposition. |
| **Could** | ~9 | Opportunistic | Real value, no dependency forces them; built when cheap. |
| **Won't-yet** | 0 explicit rows | Deferred | The deferred items live in scope boundaries ([00 §0.10](./00-executive-summary.md)) — self-hosting LLMs, a general cloud IDE, ungoverned autonomy — not as feature rows here. |

> **Reading the balance.** The Must-heavy distribution is deliberate and honest: an autonomous,
> money-spending, code-shipping platform has a large *irreducible* safe core. You cannot ship a
> "lite" version of budgets, isolation, or checkpoints. The Should/Could tail is where
> experience polish and breadth live.

### By delivery epic

| Epic | Theme | Features anchored here (approx.) |
|---|---|---|
| **A0** Brakes | Budgets, kill switch, checkpoints, audit | ~14 |
| **A1** Control plane | Ventures/goals/connections data + API, RLS, RBAC | ~4 |
| **A2** Loop engine | Tick, scheduler, guards, pause/resume/kill, events | ~16 |
| **A3** Intake → roadmap | Idea capture, spec, roadmap, approval, scope | ~12 |
| **A4** Real build | Build loop, swarm, verify, versioning, GitHub, takeover | ~12 |
| **A5** Deploy adapters | Managed + BYO adapters, rollback, domains, connections | ~13 |
| **A6** Sense layer | Health, error ingestion, analytics, fix-goal creation | ~9 |
| **A7** Billing portal | Spend meter, budget sliders, credits, invoices, alerts | ~10 |
| **A8** Operator Console | Activity stream, board, approvals, controls, deployments | ~16 |
| **A9** Hardening & GA | Code-safety scan, isolation audit, quotas, GA gating | ~12 |
| **F0** Observability | Dashboard, metrics, error tracking, tracing, audit seed | ~6 |
| **F1** Provider reliability | Key pool, breaker, cross-provider failover, metrics | ~3 |
| **F2** Distributed correctness | Shared limits, optimistic concurrency, idempotency | ~6 |
| **F3** Sessions & identity | First-party sessions, JWKS, timeouts, device revocation, MFA | ~9 |
| **F4** Real-time sync | DO coordinator, instant revocation, convergence, offline | ~6 |
| **F5** Testing | Integration/E2E/contract tests, coverage gate | ~2 |
| **F6** Migrations | Migration runner, missing migrations, RLS coverage | ~3 |
| **F7** API docs | OpenAPI + typed client | ~1 |
| **F8** Validation & supply-chain | zod, helmet/CSP, CI security gates, RBAC | ~5 |
| **F9** Design system | Token source, UI library, a11y, gallery | ~2 |
| **F10** Integrations framework | Unified catalog, MCP, health/expiry, webhooks | ~7 |

> Counts overlap by design — features that *cite two epics* (a foundation that enables, an
> autonomy epic that surfaces) are counted under both, which is why the per-epic totals exceed
> the ~110 unique features. That overlap is the point: the F-series and A-series are interwoven,
> not sequential silos, exactly as the
> [revised sequencing](../F-ENTERPRISE-FOUNDATIONS.md#revised-sequencing--foundations-under-autonomy)
> describes.

### What this catalog guarantees

- **No orphan features.** Every row names a delivery epic; every epic in the plan has features.
- **Persona coverage.** Each P1 persona (Maya, Dev, Ops) is the *primary* served persona on a
  large block of Must features; P2 personas (Sam, Riley) are served but not GA-blocking.
- **Safety is first-class.** The largest single concentration of Must features sits in the
  governance areas (Autonomous Engine, Security & Governance, Billing & Budgets) — consistent
  with the prime directive: *build the brakes before the engine.*

Next: [11 — End-to-end user journeys](./11-user-journeys.md) walks these features in narrative
order, and [12 — Information architecture](./12-information-architecture.md) places them in the
navigation.
