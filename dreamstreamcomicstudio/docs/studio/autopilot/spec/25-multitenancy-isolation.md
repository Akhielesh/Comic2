# 25 — Multi-tenancy & Isolation

> Part III · Architecture · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan](../00-MASTER-PLAN.md) (§5 security & multi-tenancy, Epic A0, Epic A9) ·
> [Enterprise Foundations](../F-ENTERPRISE-FOUNDATIONS.md) (F2 distributed correctness,
> F3 sessions, F8 input/supply-chain) ·
> [Cloudflare Architecture](../ARCHITECTURE-CLOUDFLARE.md) (DOs/Workflows/Containers) ·
> [Domain Model](./09-domain-model-glossary.md) (tenancy graph) ·
> [Security & Threat Model](./35-security-threat-model.md) (planned)

## 25.1 Why this section is load-bearing

Autopilot runs **always-on agents that write and execute code, hold users' cloud
credentials, and deploy to the public internet** ([Master Plan §5](../00-MASTER-PLAN.md)).
Get isolation wrong and the failure modes are not bugs — they are a **cross-tenant data
breach, a leaked provider credential, or a runaway bill on someone else's account**. This
is the section that earns the word "enterprise" in the product description, and it is the
substrate that **Epic A9** must independently audit and prove before GA.

The honest stance, inherited from the Master Plan, is **secure by construction**: every
isolation primitive in this section ships in **Epic A0 (the brakes) / A1 (the control
plane)** — *before* the autonomous engine (A2) is wired to do real work. We never run the
engine without the brakes. This section defines what those primitives are, where each
isolation boundary sits, and exactly what A9 must prove.

What is **shipped today** vs **planned** is marked throughout, because honesty is house
style: the existing studio already has the strongest building blocks (RLS owner-isolation,
per-`(user,project)` sandboxes, HMAC-signed worker calls, Nango secret custody). Autopilot
*extends* them to the venture grain; it does not reinvent them.

## 25.2 The tenancy model: user → ventures → projects

The tenant boundary is the **user** (`auth.users`). Everything else hangs off it. There is
no "organization" or "team" tenant in the MVP — a user is the unit of isolation, billing,
and identity ([Domain Model §9](./09-domain-model-glossary.md)). Teams are a deliberate
post-GA expansion, not a silent gap.

| Grain | Entity | Table(s) | Role in isolation |
|---|---|---|---|
| **Tenant** | User | `auth.users` (Supabase) | The RLS anchor (`auth.uid()`); the billing payer; the credential owner |
| **Product** | Venture | `ventures` (+ children) | The unit the agents own; the per-venture DO + budget + audit boundary |
| **Codebase** | Project | `studio_projects` (+ `venture_id` FK) | A venture's actual code; the per-`(user,project)` sandbox boundary |
| **Account** | Connection | `venture_connections` | A user's BYO provider account; a Nango reference, never a raw secret |

The shape is **one user → many ventures → each venture one-or-more `studio_projects`** (a
web app plus an API, say). Every `venture_*` child row (`venture_goals`, `venture_runs`,
`venture_checkpoints`, `venture_budgets`, `venture_connections`, `venture_events`) is owned
transitively through its parent venture, whose `user_id` FK is the single point where
ownership is decided. **Ownership never branches**: there is exactly one path from any row
to exactly one tenant, which is what makes the RLS and the service-identity rules
provable rather than hopeful.

```
              auth.users  (TENANT BOUNDARY — RLS anchor, billing payer, secret owner)
                  │ 1:N
                  ▼
              ventures  (PRODUCT — VentureDO + budget + audit boundary)
        ┌─────────┼───────────────────────────┐
        │ 1:N     │ 1:N                         │ 1:N
        ▼         ▼                             ▼
   studio_projects   venture_goals/runs/        venture_connections
   (+venture_id)     checkpoints/budgets/        (Nango ref → user's
        │ 1:N        events                       provider account)
        ▼
   per-(user,project) Container sandbox  u_<userId>_<projectId>
```

## 25.3 The isolation layers (defense in depth)

No single mechanism is trusted to hold the tenant boundary. Isolation is **layered**, so a
defect in one layer is contained by the next. Each layer below names the mechanism, the
boundary it enforces, where it lives, and its status.

| # | Layer | Boundary enforced | Mechanism / where | Status |
|---|---|---|---|---|
| L1 | **Database RLS** | Row-level: a row is visible only to its owning user | Postgres RLS `auth.uid() = user_id` on `ventures`; children join to parent | Pattern shipped (studio); `venture_*` policies = A0/A1 |
| L2 | **Service-identity scoping** | The worker (service role, bypasses RLS) must self-scope every query by `venture_id` + `user_id` | `ventures` worker / VentureDO query layer | Planned A2 (rule defined here) |
| L3 | **Per-venture coordination** | One venture's loop state, concurrency, and heartbeat never touch another's | `VentureDO` (Durable Object per venture) | Planned A2 ([CF arch](../ARCHITECTURE-CLOUDFLARE.md)) |
| L4 | **Per-(user,project) sandbox** | Generated code executes in an isolated container; never in the API/worker process | `studio-worker/` Container `u_<userId>_<projectId>`, HMAC-gated | **Shipped** (studio) |
| L5 | **Secret isolation** | BYO credentials never enter our DB/logs/client in plaintext | Nango custody; `venture_connections` holds only a reference | **Shipped** (Nango wired); per-venture refs = A5 |
| L6 | **Network egress control** | A sandbox cannot exfiltrate to arbitrary destinations unwatched | Per-sandbox egress allow/rate-limit + logging | Partial (SSRF guards on user URLs); full = A9 |
| L7 | **Spend caps** | A compromised/confused agent cannot exceed a hard budget | `venture_budgets` + deterministic DECIDE gate | Planned A0 (the brakes) |
| L8 | **Audit** | Every cross-boundary action is attributable and reversible | Append-only `venture_events` (model + prompt hash) | Planned A0 |

### L1 — Database RLS (owner-isolation)

The pattern is already proven in the studio and is the **literal template** for every
`venture_*` table. From `server/sql/projects_rls_owner_isolation.sql`:

```sql
alter table public.projects enable row level security;
create policy projects_select_public_or_owner on public.projects
  for select to anon, authenticated
  using (is_public = true or auth.uid() = user_id);
create policy projects_insert_owner on public.projects
  for insert to authenticated with check (auth.uid() = user_id);
-- update/delete policies likewise gate on auth.uid() = user_id
```

Autopilot mirrors this on the **root** table (`ventures`) with a `for all using
(auth.uid() = user_id)` policy, and on **child** tables by joining back to the parent so
ownership flows from one place (e.g. `using (exists (select 1 from ventures v where
v.id = venture_goals.venture_id and v.user_id = auth.uid()))`). Two house rules:

- **No public read for ventures.** Unlike `projects` (which has `is_public` for shared
  comics), a venture and its children are **owner-only** — there is no `is_public` escape
  hatch on tenant state. Public surfaces (a deployed app's URL) are a separate, intentional
  publish action gated by a checkpoint, not an RLS predicate.
- **RLS is policy, not the only fence.** RLS protects against a leaked *anon* key (the
  threat fixed in `server/sql/enable_rls_exposed_admin_tables.sql`). It does **not** protect
  against the service role, which bypasses RLS by design — hence L2.

### L2 — Service-identity scoping (the rule that protects against ourselves)

The Autopilot worker authenticates to Postgres with the **Supabase service role**, which
**bypasses RLS**. RLS therefore cannot be the worker's tenant fence — the worker is its own
fence. The non-negotiable rule (Master Plan §5.1) is restated here as a contract:

> **Service-identity rule.** Any query issued by the ventures worker / VentureDO MUST be
> scoped by **both** `venture_id` **and** `user_id`, derived from the durable job/DO context
> — never from request-supplied input, never by `venture_id` alone, never unscoped. There is
> **no code path** that reads or writes a row for a venture the current job does not own.

Concretely: the tick driver loads `{ venture_id, user_id }` from the durable job payload
(itself written under RLS at enqueue time by an authenticated request in
`server/src/middleware/auth.ts`'s context); every downstream repository call threads that
pair; a query that lacks the `user_id` predicate is a **review-blocking defect** and is
caught by the A9 isolation tests (§25.10). This is the human analogue of RLS for the one
identity that can ignore RLS.

### L3 — Per-venture coordination (VentureDO)

Each venture gets its own **Durable Object** (`VentureDO`), per the Cloudflare topology
([ARCHITECTURE-CLOUDFLARE.md §3](../ARCHITECTURE-CLOUDFLARE.md)). A DO is a *single global
point of coordination per object id with private persistent storage*, so a venture's loop
state, its concurrency control, its Alarm-driven tick heartbeat, and its live activity
stream are **physically separate** from every other venture's. This is isolation at the
*coordination* grain that the in-memory caps of today (F2 gap) cannot provide across
instances. (During the transition, the BullMQ scheduler from `server/src/comicforge/`
provides the same per-venture scoping logically; the DO makes it structural.)

### L4 — Per-(user,project) sandbox (shipped, the strongest layer today)

Generated code is **never** executed in the API or worker process. It runs only in a
per-`(user,project)` Cloudflare Container, addressed `u_<userId>_<projectId>` and reachable
**only** through the `studio-worker/` Worker, which **rejects any request that is not
HMAC-signed** by the Railway backend (`STUDIO_HMAC_SECRET`, length-safe compare). From the
worker: the sandbox id is documented as *"ALWAYS scope per authenticated user (set by
Railway)."* Properties this gives Autopilot for free:

- **Compute isolation.** A runaway or compromised build burns its own container, not the
  platform — and not another tenant's container.
- **Filesystem isolation.** `/workspace` is per sandbox; no shared mount across tenants.
- **No client-reachable control plane.** Browsers can open a preview URL but cannot launch,
  stop, or read logs of a sandbox; only the HMAC-signed control plane can.

Autopilot reuses this verbatim; A4 simply points the existing build loop at the venture's
`studio_project`. The only addition is **resource quotas** per sandbox (§25.5).

### L5 — Secret isolation (Nango custody)

BYO provider credentials (Cloudflare / Vercel / Supabase / Railway / GitHub) are the
sharpest edge in the whole system. The rule: **they never live in our database in
plaintext, never in the client bundle, never in logs.** They live in **Nango** (already
wired: `server/src/ai/tools/nango.ts`), encrypted at rest. `venture_connections` stores
only a **Nango connection reference + non-sensitive metadata** (provider, scopes, label,
expiry) — never the token. Deploy adapters (A5) ask Nango for a token *at the moment of
use*, with **least-privilege scopes**, and **never log it**. Platform secrets (managed-mode
deploy tokens, HMAC secret) stay in host env (Railway/CF), never committed — the repo
already enforces "secrets never printed." See [Integrations (§30)](./30-integrations-framework.md)
and [Deploy Adapters (§31)](./31-deploy-adapters.md) for the lifecycle.

### L6 — Network egress control

Egress from a sandbox is **allowed but governed** (an autonomous builder must `npm install`
and call APIs). The controls: outbound calls are **rate-limited and logged**; SSRF guards
(already present for user-supplied URLs) prevent the loop from reaching internal/metadata
endpoints; and the A9 hardening adds **anomaly detection on suspicious egress** (unexpected
destinations, exfil-shaped traffic) → auto-pause + alert. The honest position from the
Master Plan: egress is *decided* (we don't block it outright, which would break real
builds), but it is *watched* and *capped*.

## 25.4 Service-identity rules (summary contract)

| Principal | Identity | Sees RLS? | Tenant fence | Rule |
|---|---|---|---|---|
| Browser client | User JWT (Supabase) | **Yes** (enforced) | `auth.uid()` | Can only ever touch own rows; RLS is the backstop |
| API (Express) on user request | User JWT context | Yes (via authed client) | `auth.uid()` | Scopes by the authenticated `req.user.id` |
| Ventures worker / VentureDO | Service role | **No** (bypasses) | **Code, not RLS** | MUST scope every query by `venture_id` **and** `user_id` (L2) |
| Deploy adapter | Per-venture BYO token (via Nango) | n/a (external) | The venture's own connection | Least-privilege scopes; per-venture; revocable; never logged |
| studio-worker control plane | HMAC shared secret | n/a | `u_<userId>_<projectId>` | Rejects unsigned requests; sandbox id always user-scoped |

**The single most important rule** is the worker one (L2): because the service role can read
everything, *the service identity must voluntarily behave as though RLS were on*. Every
other layer assumes this holds.

## 25.5 Noisy-neighbor, fair-share & quotas

Multi-tenancy without fairness is just shared blast radius. Three orthogonal controls keep
one tenant from degrading or bankrupting the platform — and themselves:

**1. Per-venture spend caps (`venture_budgets`) — the primary brake.** Hard caps:
`usd_per_day`, `usd_total`, `max_tokens`, `max_container_minutes`. The deterministic DECIDE
gate reads them **before** spending; REFLECT updates spend after; breach → **hard pause +
notify** (Epic A0). A budget cap is explicitly a *security* control: a compromised or
confused agent **cannot** exceed it (Master Plan §5.6).

**2. Resource quotas (per sandbox / per tick).** CPU / memory / disk per container
(Cloudflare instance types, [ARCHITECTURE-CLOUDFLARE.md §1](../ARCHITECTURE-CLOUDFLARE.md):
`lite`→`standard-4`), plus a **wall-clock cap per tick** and **max ticks per run**. These
bound any single tenant's footprint regardless of intent.

**3. Global fair-share controls.** A **global concurrency cap** (max concurrent ticks across
all ventures) and a **global kill switch** (`VENTURES_KILL=true`) protect the providers, our
bill, and every other tenant from one tenant's surge. The concurrency cap must be *shared
state* (Redis / DO), not in-memory per process — this is the **F2** distributed-correctness
requirement; in-memory caps multiply and fail-open across instances.

| Control | Grain | Scope | Trigger → effect | Owner epic |
|---|---|---|---|---|
| `usd_per_day` / `usd_total` | Venture | Tenant | Exceed → pause venture + notify | A0 |
| `max_tokens` / `max_container_minutes` | Venture | Tenant | Exceed → pause venture | A0 |
| Wall-clock per tick / max ticks per run | Tick / Run | Tenant | Exceed → end tick/run; no infinite loop | A2 |
| Container CPU/mem/disk quota | Sandbox | Tenant | Cap utilization | A4/A9 |
| Egress rate limit | Sandbox | Tenant | Throttle + log | A9 |
| Global concurrency cap | Platform | All tenants | Saturated → queue/reject (backpressure, F2) | A2 |
| Global kill switch | Platform | All tenants | Flag → halt every venture | A0 |

**Fairness honesty:** the MVP fair-share model is **per-venture hard caps + a global
concurrency ceiling**, not weighted/priority scheduling. That is sufficient to prevent a
noisy neighbor; true QoS tiers (a paid plan gets more concurrent ticks) are a billing-plan
feature layered on later via `rbac.ts` / `modelAccessPolicy.ts`, not a new isolation
mechanism.

## 25.6 Data partitioning & residency

**Partitioning model: logical, single-database, RLS-partitioned.** All tenants share one
Supabase Postgres; isolation is by `user_id` (RLS) + service-identity scoping (L2), **not**
by a database/schema per tenant. This is the right default — it keeps the system-of-record
portable and simple, and RLS + L2 are strong enough — but the trade-offs are stated
honestly:

| Aspect | This model (shared DB, RLS) | Note |
|---|---|---|
| Isolation strength | Strong if **both** RLS and L2 hold | Two independent fences; A9 proves both |
| Blast radius of an RLS gap | All tenants of the affected table | Mitigated by L2 + audit + A9 RLS-coverage check |
| Per-tenant export / delete | A scoped query, not a DB drop | §25.7 lifecycle |
| Noisy-neighbor at DB layer | Connection pooling (Hyperdrive) + caps | Not full DB-per-tenant isolation |
| Residency | Single region per Supabase project | See below |

**Object/artifact data** (build outputs, blobs) lives in **R2**, keyed by tenant/venture so
a tenant's artifacts are addressable and deletable as a unit. **Secrets** are partitioned by
custody, not by row: they are in **Nango**, isolated per connection, never in this DB at all
(L5).

**Residency considerations (honest, MVP-limited).** The MVP runs **one Supabase project in
one region**; there is **no per-tenant data-residency selection** yet. For tenants with
EU/regional residency requirements this is a known gap, mitigated by:

- **BYO hosting moves the workload to the tenant's region** — when a venture deploys to the
  user's own Cloudflare/Vercel/Supabase account, the *application* data lives in their
  account, in their chosen region (§25.8). Only Autopilot's *control-plane* metadata
  (ventures, goals, events) stays in our system-of-record.
- **Cloudflare's edge** (Workers/DO/Containers) runs near the request; durable tenant state
  is anchored to the Supabase region.
- Region pinning / data-residency tiers are a **post-GA** item, flagged in
  [Privacy & Compliance (§36)](./36-privacy-compliance.md), not silently assumed.

## 25.7 Managed vs BYO: how hosting changes the isolation boundary

This is the most important nuance in the section, because **the hosting model moves where
the trust boundary sits** ([Master Plan §6](../00-MASTER-PLAN.md)):

| Dimension | **Managed** (`*.dreamstreamstudio.ai`) | **BYO** (user's Cloudflare/Vercel/Supabase/Railway) |
|---|---|---|
| Who runs the deployed app | **We do** | **The user's own account** does |
| Who pays the provider | **We front it** (then meter + bill) | **The user pays the provider directly** |
| Cost/abuse risk carrier | **Us** → caps + quotas are mandatory | **The user** → we meter only agent + our compute |
| Credentials needed | Platform tokens (host env) | **Per-venture** BYO tokens via Nango (L5) |
| Isolation boundary for the *app* | Our managed quotas + sandbox | **The provider account boundary** (the user's own tenant) |
| Residency of app data | Our region | **The user's chosen region/account** |

**The implication for isolation:** in **managed** mode, *we* are the multi-tenant landlord,
so **budgets + quotas + the kill switch are the only thing standing between one tenant and
everyone's bill** — which is exactly why those primitives are A0, not an afterthought, and
why the Master Plan's stance is *keep managed previews quota-tight and push real production
to BYO*. In **BYO** mode, the heavy isolation is delegated to the provider: the user's app
runs in the user's account, behind their account boundary, billed to them; our remaining job
is to (a) never leak the BYO credential (L5), (b) request least-privilege scopes, and (c)
keep our control-plane metadata owner-isolated (L1/L2). BYO is not just a cost choice — it
is a *stronger* isolation posture for the deployed product, because the blast radius of a
managed-tenant defect (one shared infra) is replaced by the provider's own hard tenant
boundary.

## 25.8 Tenant lifecycle: create, suspend, delete, export

A tenant (and each venture within it) has a governed lifecycle. Every transition is an
append-only `venture_events` record (Epic A0), so the lifecycle itself is auditable.

| Phase | What happens | Isolation-relevant guarantees |
|---|---|---|
| **Create** | User signs up (Supabase) → creates a venture (`draft`) → approves roadmap (checkpoint) → `active` | Venture born owner-isolated (L1); budget set before any spend; no autonomous work until roadmap approved (A3) |
| **Suspend** | Budget breach, kill switch, manual pause, or non-payment → `paused` | Loop stops at the next tick boundary; no new spend; existing deployments keep serving; data retained, untouched |
| **Delete** | User deletes a venture / closes account | Cascade-delete all `venture_*` rows (FK on `ventures`); R2 artifacts purged by venture key; **BYO connections revoked in Nango**; managed deployments torn down — a destructive op, so **checkpoint-gated** (Master Plan §8) |
| **Export** | User requests their data | Owner-scoped export of ventures/goals/events/code; their app already lives in their BYO account; honors data-portability (Supabase = portable system-of-record) |

Honest notes on lifecycle isolation:

- **Suspend ≠ delete.** A paused venture keeps its data and live URLs; only the *autonomous
  spend* stops. This is the correct default for budget pauses (the user tops up and resumes,
  Epic A7) and the kill switch (a platform-wide safety pause, not data loss).
- **Delete must reach external state.** Deleting a venture is not just deleting rows — it
  must **revoke BYO tokens in Nango** and **tear down managed deployments**, or we leave
  dangling credentials and live URLs. This crosses the trust boundary, so it is a
  checkpointed, audited, irreversible operation.
- **Export is owner-scoped, no exception.** The export path uses the same L2 scoping as
  every other read; there is no "admin export" that crosses tenants without an explicit,
  audited admin action.

## 25.9 Threats this model is designed to stop

| Threat | Primary control | Backstop(s) |
|---|---|---|
| Tenant A reads Tenant B's venture/data | L1 RLS (`auth.uid()`) | L2 service-identity scoping; A9 isolation tests |
| Worker accidentally serves wrong tenant | L2 (`venture_id` + `user_id` on every query) | L3 per-venture DO; audit (L8) |
| Generated code escapes / attacks platform | L4 sandbox (`u_<user>_<project>`, HMAC) | Egress control (L6); code-safety scan (A9) |
| BYO credential leaks | L5 Nango custody (never in DB/log/client) | Least-privilege scopes; never-logged; A9 secret review |
| Data exfiltration via egress | L6 rate-limit + log + anomaly detect | SSRF guards; auto-pause on suspicious egress (A9) |
| Runaway loop / cost on one tenant | L7 budget caps + DECIDE gate | Wall-clock/max-tick guards; no-progress detector |
| One tenant degrades all (noisy neighbor) | Global concurrency cap + kill switch | Per-sandbox quotas; backpressure (F2) |
| Privilege escalation via anon key | RLS on admin tables (already fixed) | Service-role-only access pattern |

## 25.10 Isolation test matrix (what A9 must prove)

Isolation that is not *tested* is isolation that is *assumed*. **Epic A9** ("Multi-tenant
security hardening & GA") gates GA on an external pass that finds **no cross-tenant leak, no
secret exposure, no uncapped spend path**. This matrix enumerates what must be proven; each
row maps to an automated test (ties to **F5** integration/E2E) plus, where noted, a Supabase
`get_advisors` / `run_secret_scanning` check.

| # | Property to prove | Test shape | Layer | Maps to |
|---|---|---|---|---|
| T1 | User A cannot read User B's venture or any child row over the API | Integration: authed-as-A request for B's `venture_id` → 404/empty | L1 | A1, A9, F5 |
| T2 | Worker query without `user_id` predicate is rejected/caught | Static + runtime: assert every repo call threads `{venture_id,user_id}` | L2 | A2, A9 |
| T3 | Service role cannot be tricked into cross-venture write | Integration: tick payload tampering → no foreign-row mutation | L2 | A2, A9 |
| T4 | Every `venture_*` and `studio_*` table has an RLS policy | CI RLS-coverage check + `get_advisors` (fail if a table lacks RLS) | L1 | A9, F6 |
| T5 | Generated code cannot read another sandbox's filesystem/process | Sandbox: cross-`u_<user>_<project>` access attempt fails | L4 | A4, A9 |
| T6 | Unsigned control-plane request to studio-worker is rejected | Worker: request without valid HMAC → 401 | L4 | shipped, A9 regression |
| T7 | BYO credential never appears in DB, logs, or client bundle | Secret scan of DB rows + logs + bundle; `run_secret_scanning` on pushes | L5 | A9, F8 |
| T8 | Deploy token uses least-privilege scopes and is per-venture | Connection audit: scopes requested = minimum; revocable | L5 | A5, A9 |
| T9 | Egress to internal/metadata endpoints is blocked; exfil-shaped traffic alerts | SSRF probe + anomaly-detection test → auto-pause | L6 | A9 |
| T10 | A venture cannot exceed its budget caps | Spend simulation past `usd_total` → hard pause + alert | L7 | A0, A7, A9 |
| T11 | Global kill switch halts every venture; concurrency cap holds across instances | Flip `VENTURES_KILL`; 2-instance load test on the cap | L3/quotas | A0, A2, F2 |
| T12 | Delete revokes BYO tokens + tears down deployments (no dangling state) | Lifecycle: delete venture → Nango token gone, managed URL down | §25.8 | A9 |
| T13 | Export is owner-scoped only; no cross-tenant rows in any export | Export-as-A contains zero B rows | §25.8 | A9 |

**Acceptance for this section (inherited from A9):** all T1–T13 are automated and green; the
RLS-coverage check is wired into CI (F6); a `/security-review` of the entire `venture_*`
surface is clean; and the external security pass signs off before `VENTURES_ENABLED` flips
from admin-only to plan-gated.

## 25.11 Summary

The tenant boundary is the **user**; isolation is **layered** (RLS → service-identity
scoping → per-venture DO → per-(user,project) sandbox → Nango secret custody → egress
control → spend caps → audit), so no single defect breaches a tenant. The **service-identity
rule** — the worker must self-scope by `venture_id` + `user_id` even though it can ignore RLS
— is the keystone, because it is the one identity powerful enough to cause a cross-tenant
leak. **Managed hosting makes us the landlord** (so budgets/quotas/kill-switch are
mandatory, hence A0); **BYO hosting delegates the heavy isolation to the user's own provider
account** (a stronger posture for the deployed product). The whole model is **proven, not
assumed**: Epic A9's test matrix (T1–T13) must be green before GA. Everything here ships
*before* the engine — secure by construction.
