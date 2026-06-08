# 53 — Appendix B: Decision Log (ADRs)

> Part V · Delivery · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan §"Owner decisions locked"](../00-MASTER-PLAN.md) ·
> [Cloudflare Architecture](../ARCHITECTURE-CLOUDFLARE.md) ·
> [Assumptions & Risks §7.6 open questions](./07-assumptions-risks.md#76-open-questions--decisions-needing-the-owner) ·
> existing ADRs in [`../../../decisions/`](../../../decisions/)

> **What this is.** A single, durable register of the architecturally and commercially
> significant decisions behind Autopilot: the ones already **locked** (so we don't
> relitigate them), the ones still **open** and waiting on the owner (each with a
> recommended default so nothing is blocked), and the **new ADRs** to author in the repo's
> existing `docs/decisions/` series. It is the bridge between the prose specs and the
> immutable, numbered ADR files. The honest stance throughout: a decision recorded here is
> *proposed* until it lands as an `Accepted` ADR; a decision marked *locked* below has owner
> sign-off ([Master Plan, 2026-06-07](../00-MASTER-PLAN.md)) but still needs its ADR written
> so the *why* survives.

---

## 53.1 How this log relates to the repo's ADRs

The repository already runs a lightweight ADR process under
[`docs/decisions/`](../../../decisions/): copy `0000-template.md`, number sequentially and
never reuse, use the four sections **Status / Date / Context / Decision / Consequences**, and
treat an `Accepted` ADR as immutable — to change course you write a *new* ADR and mark the old
one `Superseded by NNNN` ([decisions README](../../../decisions/README.md)). Three ADRs exist
today (0001–0003); they predate Autopilot but constrain it, so they are referenced here, not
copied.

This appendix does two jobs the per-file ADRs cannot:

1. **It gives the whole Autopilot decision surface in one table** — locked and open together —
   so the owner can review the full bet in one place ([§53.2](#532-the-decision-table)).
2. **It records decisions while they are still proposed.** Several Autopilot decisions are
   "locked by the owner" but have *no ADR file yet*. This log is their interim home and the
   to-do list for authoring them ([§53.5](#535-new-adrs-to-author)). Until an entry is an
   `Accepted` file in `docs/decisions/`, treat it as the spec's recommendation, not settled
   law.

**Convention for Autopilot ADRs.** New ADRs continue the existing single sequence (next free
number is **0004**), live in `docs/decisions/`, and use the existing template verbatim. We do
*not* start a separate numbering scheme for Autopilot; the A-series (A0–A9) names *epics*, not
decisions. Where an Autopilot decision changes a prior one (e.g. billing UI, which ADR 0002
removed), the new ADR must mark the old one `Superseded by NNNN` and link forward.

---

## 53.2 The decision table

Status legend: **🔒 locked** (owner-approved, 2026-06-07 — needs its ADR authored) ·
**✅ accepted-ADR** (already an `Accepted` file in `docs/decisions/`) · **❓ open** (needs the
owner; a recommended default is given so work proceeds). "ADR" column points to the file that
records it (existing) or the file to author ([§53.5](#535-new-adrs-to-author)).

| id | decision | status | recommendation | consequences | ADR |
|---|---|---|---|---|---|
| **D1** | **Hybrid hosting** — managed previews now + bring-your-own provider accounts via Nango, phased second | 🔒 locked | Managed = previews + small SaaS, quota-tight; push real production to BYO | We carry managed cost/abuse risk → budgets + quotas + kill switch are mandatory and ship first (A0); deploy layer must be provider-agnostic | author 0006 |
| **D2** | **Generalize the studio first** — idea → web app / landing / simple SaaS, reusing the existing build loop | 🔒 locked | Keep first scope narrow; expand only when stuck-rate is low | Value prop lands where the loop already works; "any product" deferred; bounds A1/A4 acceptance | author 0005 |
| **D3** | **Continuous autonomy + checkpoints + budgets** — never ungoverned | 🔒 locked | Ship one governed tier (all six checkpoints) first | Governance is the moat, not a tax; higher-trust tier is a *policy* change later, not a rewrite | author 0007 |
| **D4** | **Extend this repo** (`dreamstreamcomicstudio/`) — no new codebase | 🔒 locked | Keep; add `server/src/ventures/` + `components/ventures/` | Maximum reuse (~60% of machinery exists); inherits conventions (Gallery rule, RLS, billing ledger) | author 0008 |
| **D5** | **Cloudflare DO + Workflows + Containers** as the durable substrate | 🔒 locked | Adopt the full stack incrementally, behind an interface | "Always-on" emerges from DO Alarms + Workflows, not an idle server; a migration from Railway/BullMQ, not a switch; vendor concentration accepted, bounded by portable SoR | author 0009 |
| **D6** | **Brakes before engine** — A0 governance ships before A2 loop | 🔒 locked | Non-negotiable sequencing; treat as a hard rule | Budgets/kill-switch/checkpoints/audit exist before any autonomous build; "secure by construction" | author 0007 (with D3) |
| **D7** | **BYOK / free-first models; no self-hosted LLMs** | 🔒 locked | API/BYOK models; frontier coding via BYOK/credits for hard goals | Model COGS → ~0 with BYOK; rules out GPU renting (~$10k–25k/mo per user); extends ADR 0001 | extends ✅ 0001 |
| **D8** | **Supabase as system-of-record** (Postgres + auth + RLS) | 🔒 locked | Keep as the portable SoR through the CF migration | De-risks vendor concentration (D5); RLS owner-isolation is the tenant-isolation primitive; JWKS-local verify removes per-request uptime dependency | author 0009 (with D5) |
| **D9** | **Nango for BYO secrets + connectors** | 🔒 locked | Keep; `venture_connections` stores only a Nango reference + metadata | No plaintext provider creds in our DB or client; managed-preview path needs no Nango; connection-expiry tracking required | author 0010 |
| **D10** | **Product / unit naming** — "Code Studio Autopilot" / "Venture" | ❓ open | Keep as-is; rename is mechanical if the owner prefers | Naming touches UI copy + docs only; no architectural impact | (decide → ADR if changed) |
| **D11** | **Default build/coding model** | ❓ open | Strong-open model as default + frontier via BYOK | Drives quality vs cost of every tick; routes through `autoRouter` so it's one config knob; extends ADR 0001 | extends ✅ 0001 / 0003 |
| **D12** | **Per-project backend** — SQLite-in-container vs Supabase-per-project | ❓ open | SQLite-in-container first; Supabase-per-project later (via `supabaseProvision` adapter, A5) | Container SQLite = zero-provision instant builds but ephemeral/single-node; Supabase-per-project = durable/multi-user but adds provisioning + cost | author 0011 |
| **D13** | **Pricing numbers** (platform fee, markup, credit pack sizes) | ❓ open | Use the illustrative model in [05 §pricing](./05-business-model-pricing.md); single markup knob `BILLING_PLATFORM_MARKUP` (default 1.30) | Owner sets final list prices; machinery is dormant-but-present (ADR 0002); no code change to set numbers | extends ✅ 0002 |
| **D14** | **Managed-preview quota defaults** | ❓ open | Conservative per-venture caps (container-minutes/day, concurrent previews, egress) with one-click raise | Quotas are how managed hosting can't be abused (R5) or bankrupt us (R1); too tight hurts the wow, too loose carries cost | author 0006 (with D1) |
| **D15** | **Default per-venture budget caps** | ❓ open | Low `usd_per_day`, modest `usd_total`; never uncapped; require BYOK above a threshold | The DECIDE gate reads these before spend; too low = stalls, too high = surprise bills; protects A7 economics | author 0007 (with D3) |
| **D16** | **GA gating criteria** — what must be true to flip `VENTURES_ENABLED` from admin → plan-gated | ❓ open | No H×H risk (R1–R5, R9, R13) left `open`; clean security review; kill-switch drill passed; isolation audit clean | Defines the A9 exit bar; an unmet criterion blocks GA without a recorded owner exception | author 0012 |

---

## 53.3 Locked decisions — rationale & consequences

These are owner-approved ([Master Plan, 2026-06-07](../00-MASTER-PLAN.md)). Each still needs
its ADR file authored ([§53.5](#535-new-adrs-to-author)); the prose below is the source
material for those ADRs' *Context* and *Consequences* sections.

### D1 — Hybrid hosting (managed preview now + BYO via Nango)
**Rationale.** Managed previews on `*.dreamstreamstudio.ai` (infra already live) give the
"few clicks → it's live" wow with zero user setup; BYO accounts give power users
cost pass-through and avoid us fronting production cost at scale
([Master Plan §6](../00-MASTER-PLAN.md#6-hosting-model--deploy-adapters)).
**Consequences.** In managed mode *we* carry the provider bill, so metering, quotas, and the
kill switch are not optional — they are A0, before any loop ([Risk R1/R5](./07-assumptions-risks.md#74-risk-register)).
The deploy layer must be provider-agnostic (the `DeployAdapter` interface, A5) so managed and
BYO targets are interchangeable. Recommended posture: managed = previews + small SaaS,
quota-tight; real production → BYO ([Q1](./07-assumptions-risks.md#76-open-questions--decisions-needing-the-owner)).

### D2 — Generalize the studio first (idea → web app / landing / simple SaaS)
**Rationale.** This is the band where the existing Phase-4 build loop + swarm already work
(`server/src/ai/studio/`). Picking the narrow scope is how we *de-risk A1* (LLMs can reliably
build within a budgeted loop) — by not betting on "any product."
**Consequences.** First-scope acceptance is bounded and testable (A4: a venture ships its first
goals with passing versions); "any product" is an explicit later expansion gated on a low
stuck-rate ([Risk R7](./07-assumptions-risks.md#74-risk-register), decision trigger in
[§7.7](./07-assumptions-risks.md#77-decision-triggers)).

### D3 — Continuous autonomy + checkpoints + budgets (never ungoverned)
**Rationale.** "Never stop iterating" — yes; ungoverned — no. Unbounded autonomy is a runaway
cost/thrash trap. Governance is the differentiator, not a tax
([market §2.4](./02-market-competitive-analysis.md)).
**Consequences.** Six checkpoints (first prod deploy, spending money, destructive ops, public
publish, scope change, roadmap approval) are always required regardless of any future autonomy
tier ([Master Plan §8](../00-MASTER-PLAN.md#8-guardrails--checkpoints)). A higher-trust "fewer
checkpoints" tier is a budget/checkpoint-*policy* change, never a rewrite. Ship one governed
tier first ([Q3](./07-assumptions-risks.md#76-open-questions--decisions-needing-the-owner)).

### D4 — Extend this repo
**Rationale.** Autopilot is ~mostly orchestration + state + governance over assets that already
exist; the risky/expensive parts (sandboxed exec, billing, multi-model, swarm) are done
([Master Plan §3 reuse inventory](../00-MASTER-PLAN.md#3-what-we-build-on)).
**Consequences.** New code lands as `server/src/ventures/` and `components/ventures/`,
inheriting repo conventions — the Gallery-coverage rule for any new artifact component
([CLAUDE.md](../../../../CLAUDE.md)), RLS owner-isolation, the existing billing ledger. The
"weeks not months" framing depends on this reuse holding (Assumption A4); each A-epic measures
net-new vs reused code.

### D5 — Cloudflare DO + Workflows + Containers substrate
**Rationale.** "Workers + Containers" is only 2 of ~5 primitives an always-on builder needs.
The brain is **Durable Objects** (Alarm-driven tick heartbeat + per-venture isolation +
hibernating WebSocket for real-time) plus **Workflows** (durable, retrying build pipelines),
with Containers as the execution muscle ([Architecture §1–§3](../ARCHITECTURE-CLOUDFLARE.md)).
This is also the *cheapest* path — you pay for work, not idle servers.
**Consequences.** "Always-on" emerges from DO Alarms + Workflows; no always-on server is
needed. It is a migration, not a switch: keep Railway/Express + BullMQ during the transition
and move coordination/pipelines behind an interface, incrementally (A2 builds the orchestrator
this way; [Risk R18](./07-assumptions-risks.md#74-risk-register)). DOs are coordination-only
(single-threaded, storage-bounded) — heavy work stays in Containers/Workflows. Vendor
concentration is accepted but bounded by D8 + provider-agnostic adapters (D1).

### D6 — Brakes before engine
**Rationale.** A risk mitigated by a control we haven't built is not mitigated. Spend caps are
a security control: an agent that cannot exceed a dollar cap cannot do unbounded damage
([§7.1 principles](./07-assumptions-risks.md#71-why-this-section-exists)).
**Consequences.** A0 (budgets, kill switch, no-progress detector, checkpoints, append-only
audit) ships and is proven *before* A2 wires any autonomous build. Hard sequencing:
A0 → A1 → A2; and F0→F1→F2 before A2 wires real builds. This is paired with D3 in one ADR.

### D7 — BYOK / free-first models; no self-hosted LLMs
**Rationale.** Self-hosting frontier models is ~$10k–25k/mo per user — out of scope by design
([01-VISION non-goal](../00-MASTER-PLAN.md#11-risks--honest-caveats)). BYOK collapses model
COGS to ~0 and is already normalized in the product (ADR 0001).
**Consequences.** Extends ADR 0001's gateway/BYOK control plane to the loop: ORIENT, intake,
and build all run through the gateway; frontier coding models reachable via BYOK/credits for
hard goals. Rules out GPU renting permanently; protects the A7 economic model. The *default*
model is still open (D11).

### D8 — Supabase as system-of-record
**Rationale.** A portable Postgres + auth + RLS layer is the hedge against D5's vendor
concentration: keep the durable state and identity off Cloudflare so a substrate change is
survivable ([Architecture §4](../ARCHITECTURE-CLOUDFLARE.md), [Risk R8](./07-assumptions-risks.md#74-risk-register)).
**Consequences.** All `venture_*` tables live in Supabase with RLS owner-isolation mirroring
`projects_rls_owner_isolation.sql` — the primary tenant-isolation control (R3). JWKS-local JWT
verification (F3) removes a per-request dependency on Supabase uptime. Authored jointly with D5.

### D9 — Nango for BYO secrets + connectors
**Rationale.** Always-on agents holding users' cloud credentials is the sharpest security edge.
Nango is already wired (`server/src/ai/tools/nango.ts`); credentials stay encrypted in Nango,
never in our DB plaintext or the client bundle
([Master Plan §5](../00-MASTER-PLAN.md#5-security--multi-tenancy)).
**Consequences.** `venture_connections` stores only a Nango connection reference + metadata.
The managed-preview path needs no Nango (no creds). BYO deploys are blocked if Nango is down;
managed is unaffected. Connection-state/expiry tracking is required (F10). Per-venture deploy
tokens are least-privilege and revocable; never logged (R4/R13).

---

## 53.4 Open decisions — recommended defaults

Each is genuinely the owner's to make, but carries a recommended default so the build is never
blocked. Mirrors and extends [§7.6 open questions](./07-assumptions-risks.md#76-open-questions--decisions-needing-the-owner).

### D10 — Product / unit naming ("Code Studio Autopilot" / "Venture")
**Recommended default:** keep as-is. **Why / consequences:** naming touches UI copy + docs
only; the rename is mechanical (string replace) with no architectural impact. The owner said
the word stands until they prefer otherwise ([Master Plan close](../00-MASTER-PLAN.md), Q7). If
changed, record the final names in a one-line ADR for durability.

### D11 — Default build/coding model
**Recommended default:** a strong open-weight model as the platform default + frontier via BYOK
for hard goals, selected through `autoRouter` so it is a single config knob (extends ADR 0001;
mirrors the studio open decision in [00-STATUS](../../00-STATUS.md#open-decisions-see-linked-docs)).
**Consequences:** this knob sets the quality/cost of every tick. Because routing already exists,
changing the default is config, not code. Above a per-venture spend threshold, require BYOK
([Q9](./07-assumptions-risks.md#76-open-questions--decisions-needing-the-owner)) so we don't
front large model cost.

### D12 — Per-project backend (SQLite-in-container vs Supabase-per-project)
**Recommended default:** SQLite-in-container first; Supabase-per-project later via the optional
`supabaseProvision` adapter (A5) when a venture needs durable, multi-user data. **Consequences:**
SQLite-in-container is zero-provision and instant (great for the wow) but ephemeral and
single-node; Supabase-per-project is durable and multi-user but adds provisioning, a Management
token/OAuth scope, and per-project cost. Phasing matches D2 (simple apps first). Author ADR 0011.

### D13 — Pricing numbers
**Recommended default:** use the illustrative model in
[05 — Business Model & Pricing](./05-business-model-pricing.md) — a low platform fee, metered
agent compute with a single markup knob (`BILLING_PLATFORM_MARKUP`, default **1.30** =
+30% on provider cost), and managed hosting as a separate metered line. **Consequences:** every
number is the owner's to set; the machinery exists but is dormant in the UI (ADR 0002), so
turning numbers on is config + restoring surfaces, not new architecture. Re-enabling the
billing UI is itself a new ADR that supersedes 0002.

### D14 — Managed-preview quota defaults
**Recommended default:** conservative per-venture caps (container-minutes/day, max concurrent
previews, egress rate) with a one-click raise in the portal. **Consequences:** these quotas are
the direct mitigation for managed-hosting abuse (R5) and runaway cost (R1). Too tight undercuts
the instant-gratification wow (D1); too loose carries our cost. Author jointly with D1 (0006).

### D15 — Default per-venture budget caps
**Recommended default:** low `usd_per_day`, modest `usd_total`, never uncapped; require BYOK
above a threshold ([Q2/Q9](./07-assumptions-risks.md#76-open-questions--decisions-needing-the-owner)).
**Consequences:** the DECIDE gate reads these before any spend (A0); too low stalls ventures
waiting on raises, too high risks surprise bills. Defaults protect the A7 economics. Author
jointly with D3 (0007).

### D16 — GA gating criteria
**Recommended default:** GA (flipping `VENTURES_ENABLED` from admin-only → plan-gated) requires:
no high-likelihood/high-impact risk (R1–R5, R9, R13) left `open`; a clean security review of the
whole `venture_*` surface; a passed kill-switch drill; a clean tenant-isolation audit
(`get_advisors` RLS coverage); and the go-live checklist complete (A9). **Consequences:** this
is the A9 exit bar. Any unmet criterion blocks GA without an explicit, recorded owner exception
([§7.8](./07-assumptions-risks.md#78-how-this-section-stays-alive)). Author ADR 0012.

---

## 53.5 Reference: existing ADRs & new ADRs to author

### 53.5.1 Existing repo ADRs (referenced, not modified)

These predate Autopilot and **constrain** it. Autopilot extends them; it does not relitigate
them. Source: [`docs/decisions/`](../../../decisions/).

| # | Title | Status | Relevance to Autopilot |
|---|---|---|---|
| **0001** | OpenRouter gateway + BYOK as the AI control plane | Accepted | The provider-agnostic gateway + BYOK is exactly what D7/D11 build on — the loop's model calls route through `getProvider(...)`, BYOK funds them on the user's account, cost is metered in one place. |
| **0002** | Remove pricing/billing UI; keep billing backend dormant | Accepted | D13's machinery (`billingLedger`, `usageEnforcer`, `costEstimator`, Stripe, the token tables) is the *dormant* backend this ADR preserved. Re-enabling billing UI for the Autopilot portal (A7) is a **new ADR that supersedes 0002**. |
| **0003** | Multi-key API configuration + per-key usage limits | Proposed | Per-key, per-provider spend tracking + "block at limit" is the pattern Autopilot's per-venture budgets generalize. Note 0003 is still **Proposed**; its noted hardening (a server-authoritative per-key ledger) overlaps A0's metering work. |

### 53.5.2 New ADRs to author (next free number: 0004)

To make the locked decisions durable and the open ones final, author these in
`docs/decisions/` using the existing template, continuing the single sequence. Numbers are a
recommended assignment; the only hard rule is sequential and never reused.

| ADR # | Title | Covers (this log) | Trigger to write |
|---|---|---|---|
| **0004** | Autopilot / Ventures layer — scope & relationship to the studio | overarching framing; cites D1–D9 | before A1 (control plane) |
| **0005** | First scope: generalize the studio (web app / landing / simple SaaS) | D2 | before A3 (intake/roadmap) |
| **0006** | Hybrid hosting + managed-preview quotas | D1, D14 | before A5 (deploy adapters) |
| **0007** | Continuous autonomy: brakes-before-engine, checkpoints, budget defaults | D3, D6, D15 | before A0 (it *is* the A0 charter) |
| **0008** | Extend this repo (no new codebase) | D4 | before A1 |
| **0009** | Cloudflare DO/Workflows/Containers substrate + Supabase as SoR | D5, D8 | with F4 / before A2 |
| **0010** | Nango as the BYO secret/connector vault | D9 | before A5 |
| **0011** | Per-project backend (SQLite-in-container → Supabase-per-project) | D12 | before A5 `supabaseProvision` |
| **0012** | GA gating criteria for `VENTURES_ENABLED` | D16 | before A9 / GA |
| **00xx** | Re-enable billing/pricing UI for the portal — **supersedes 0002** | D13 | before A7 (billing portal) |

> **Authoring note.** When an Autopilot ADR changes a prior decision (most relevant: ADR 0002,
> which removed the billing UI that A7 restores), the new ADR must state `Supersedes 0002` and
> the old file must be edited to `Superseded by 00xx` with a forward link — the one permitted
> edit to an `Accepted` ADR ([decisions README](../../../decisions/README.md)). All other
> `Accepted` ADRs stay immutable.

---

## 53.6 How this log stays alive

This appendix is the *index of intent*; the `docs/decisions/` files are the *durable record*.
The lifecycle is one-directional and explicit:

1. A decision appears here as **🔒 locked** (owner-approved, spec is its interim home) or
   **❓ open** (recommended default given, work proceeds on the default).
2. When its ADR is authored and accepted, its row flips to **✅ accepted-ADR** and the "ADR"
   column points to the real file; the prose rationale here is the ADR's source material.
3. To reverse a settled decision, write a *new* sequential ADR that supersedes the old one —
   never edit an `Accepted` file except to add the `Superseded by` pointer.

The open decisions (D10–D16) are reviewed at the same three owner gates as the risk register —
**before A2** (real autonomy on), **before A9** (hardening), and **before GA** — plus at any P0
incident ([§7.8](./07-assumptions-risks.md#78-how-this-section-stays-alive)). No open decision
with a budget, security, or GA consequence (D13–D16) may remain unresolved at GA without an
explicit, recorded owner exception.
