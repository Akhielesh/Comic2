# 07 — Assumptions, Constraints & Risks

> Part I · Product & Strategy · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan §11](../00-MASTER-PLAN.md) · [Cloudflare Architecture §4](../ARCHITECTURE-CLOUDFLARE.md) ·
> [Foundations](../F-ENTERPRISE-FOUNDATIONS.md)

## 7.1 Why this section exists

Every prior section argued *why* and *what*. This one is the disciplined inventory of what we
are **betting on**, what **boxes us in**, and what could **go wrong** — written honestly, with
owners and triggers, so the plan survives contact with reality. It is the single document the
owner should re-read before turning on real autonomy (A2/A4) and before GA (A9). Nothing here
is theoretical hedging: the brakes in [Master Plan §8](../00-MASTER-PLAN.md) and the F-series
foundations exist precisely because of the risks catalogued below.

Three operating principles frame everything that follows:

1. **Brakes before engine.** Budgets, kill switch, no-progress detection, and checkpoints
   (A0) ship before any autonomous build (A2/A4). A risk that is mitigated by a control we
   haven't built yet is not mitigated.
2. **Spend caps are a security control.** A confused or compromised agent that cannot exceed a
   dollar cap cannot do unbounded damage. Cost, security, and abuse risks share one brake.
3. **Honest about the seams.** We mark assumptions we have *not* validated, constraints we
   cannot engineer away, and risks we are accepting rather than eliminating.

---

## 7.2 Assumptions log

These are the beliefs the plan rests on. Each is stated, justified, given a validation path,
and paired with the blast radius if it turns out false.

| # | Assumption | Why we believe it | How we'd validate | What breaks if false |
|---|---|---|---|---|
| A1 | LLMs can reliably build/iterate **web apps, landing pages, simple SaaS** within a budgeted loop | The existing Phase-4 build loop + swarm already does one-shot builds in this scope (`server/src/ai/studio/`) | A4 acceptance: an approved venture autonomously ships its first few backlog goals with passing versions; track stuck-rate per scope | Core value prop fails; first scope must shrink or autonomy stays human-in-the-loop per goal |
| A2 | "Continuous with budgets + checkpoints" is the autonomy users actually want (not ungoverned) | Owner explicitly accepted this reframing ([exec summary §0.2](./00-executive-summary.md)); governance is our moat ([market §2.4](./02-market-competitive-analysis.md)) | Intake→approval funnel; do users keep budgets/checkpoints on, or demand "just run it"? | Either we over-built governance UX, or we must offer a higher-trust auto-tier sooner |
| A3 | Cloudflare DO + Workflows + Containers is the right durable substrate at our scale | Verified capabilities, 2026-06 ([architecture §1](../ARCHITECTURE-CLOUDFLARE.md)); 1,000+ concurrent containers, DO Alarms as heartbeat | Load test (F5 k6) against DO/Workflow topology at target concurrency | Re-architect coordination tier; keep Railway/BullMQ longer; cost + reliability assumptions shift |
| A4 | **Reuse, not rebuild** — Autopilot is ~mostly orchestration over existing assets (~60% machinery exists) | Reuse inventory in [Master Plan §3](../00-MASTER-PLAN.md) maps each need to a shipped file | Each A-epic measures net-new vs reused code; A4 proves the build loop plugs in unchanged | Timeline/effort estimates inflate materially; the "weeks not months" framing breaks |
| A5 | Users will **bring their own** provider + model accounts (Nango BYO, BYOK) for production | BYOK already normalized; cost pass-through is our economic wedge ([market §2.7](./02-market-competitive-analysis.md)) | A5 BYO connect-rate; % of prod deploys on BYO vs managed | We carry far more provider cost; managed-hosting cost/abuse risk dominates margins |
| A6 | **Nango + RLS + least-privilege adapters** is sufficient for multi-tenant secret safety | Existing Nango wiring, broad RLS, SSRF guards, output guardrails ([foundations scorecard](../F-ENTERPRISE-FOUNDATIONS.md)) | A9 tenant-isolation audit + security review; `get_advisors` RLS coverage check | A breach is existential; we'd need a deeper isolation model before GA |
| A7 | Our **economic model holds** — low platform fee + metered compute + BYOK ≈ near-zero marginal model cost | BYOK/free-first design ([market §2.3/§2.7](./02-market-competitive-analysis.md)) | A7 cost-per-active-venture vs revenue; gross margin per plan | Pricing must change; managed mode may need to be premium/quota-tight only |
| A8 | A **small team** can build and operate this by sequencing safety-first, flag-gated increments | Every epic is small, shippable, reversible behind a flag ([Master Plan §9](../00-MASTER-PLAN.md)) | Velocity per epic; on-call load once A2+ runs continuously | Scope must contract; operational burden of 24/7 autonomy exceeds team capacity |
| A9 | The owner (or a deputy) is **available to clear checkpoints** in reasonable time | Checkpoints are few and high-value (prod, money, destructive) ([Master Plan §8](../00-MASTER-PLAN.md)) | Median checkpoint dwell-time in the approval queue | Ventures stall waiting on approvals; "always-on" feels stalled; need delegation/auto-policies |
| A10 | Providers (CF/Supabase/Stripe/Nango/models) are **reliable enough** with our resilience layer (F1) | F1 adds key pool + circuit breaker + cross-provider failover (the audit's #1 pain) | F1 acceptance: simulate outage → auto-failover; chaos drills | The loop spends/wastes budget on failing upstreams; user-visible downtime |

> **Stance on unvalidated assumptions:** A1, A5, and A9 are the least proven. They are
> behavioral/market bets that only validate post-launch. We de-risk A1 by *scoping down*, A5 by
> *measuring connect-rate early*, and A9 by *making checkpoints rare and delegable*.

---

## 7.3 Constraints

Constraints are the boundaries we design *within*; unlike risks, they don't "happen" — they are
always true. Grouped by source.

### 7.3.1 Technical (platform primitives)

These come directly from Cloudflare's verified limits ([architecture §1, §4](../ARCHITECTURE-CLOUDFLARE.md)).

| Constraint | What it forces | Design response |
|---|---|---|
| **Durable Objects are single-threaded per object + storage-bounded** | A DO is for *coordination*, never heavy compute | `VentureDO`/`UserCoordinatorDO` do scheduling, presence, isolation only; all real work goes to Containers/Workflows |
| **Workers cap at 5 min CPU per request** | The "brain" cannot be a long-lived Worker request | Always-on emerges from **DO Alarms (heartbeat) + Workflows (durable jobs)**, not a Worker loop; Workers stay edge/API/preview |
| **Containers cold-start and sleep when idle** | "Instant" interactive builds can stall on a cold sandbox | Small **warm pool** for interactive builds; the autonomous loop tolerates cold starts (it's async) |
| **Containers billed per active time** | Idle and runaway builds both cost money | Per-tick wall-clock cap + per-goal iteration cap + `max_container_minutes` budget |
| **Concurrency ceiling (6 TiB / 1,500 vCPU / 30 TB)** | Real but finite multi-tenant headroom | Global concurrency cap + per-venture isolation so one tenant can't starve others |

### 7.3.2 Product

- **First scope is deliberately narrow:** web apps / landing pages / simple SaaS — the band
  where the existing loop already works ([Master Plan §11](../00-MASTER-PLAN.md)). "Any product"
  is a later expansion, not the MVP.
- **Code-optional, never code-locked:** the user can take over the editor at any time; we cannot
  assume fully hands-off operation.
- **Non-goals (hard boundaries):** self-hosting LLMs / renting GPUs (~$10k–25k/mo per user),
  general cloud-IDE / VS Code replacement, and unbounded autonomy with no human gates — all
  out by design ([exec summary §0.10](./00-executive-summary.md)).

### 7.3.3 Organizational

- **Small team, safety-first sequencing.** Work proceeds as flag-gated, reversible increments;
  we cannot parallelize across ten workstreams. F0→F1→F2 must land before A2 wires real builds
  ([foundations sequencing](../F-ENTERPRISE-FOUNDATIONS.md)) — a sequencing constraint, not a
  preference.
- **24/7 operations imply on-call.** Once A2+ runs continuously, someone owns the kill switch,
  the incident runbook, and the approval queue.

### 7.3.4 Legal / liability

- **Who is liable for user-deployed apps?** The user owns the venture, its code, and its content;
  Autopilot is a tool that builds *at the user's direction* (their approved roadmap, their
  checkpoints). In **BYO** hosting the app runs on the user's own accounts under their provider
  terms — liability is clearly theirs. In **managed** hosting we are the host of record, so we
  carry takedown/abuse obligations and need ToS, an acceptable-use policy, and a takedown path.
- **Data processing roles.** For end-user data inside built apps, the venture owner is the
  controller and we are a processor (BYO) or sub-processor (managed) — a DPA and processing
  records are required (see [Risk R12](#74-risk-register)).
- **Open items requiring counsel** are flagged in [§7.6](#76-open-questions--decisions-needing-the-owner);
  this section states the working assumption, not legal advice.

---

## 7.4 Risk register

Categories: **product · technical · security · cost · legal · operational**.
Likelihood / Impact: **L / M / H**. Status: **open · mitigating · accepted · monitored**.
Owner is the function accountable for the mitigation, not necessarily the implementer.

| ID | Risk | Category | Like. | Impact | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|---|
| R1 | **Runaway cost** — agents/managed hosting burn an unexpected bill | cost | M | H | Per-venture budgets (`usd_per_day`/`usd_total`/tokens/container-minutes) read by the DECIDE gate *before* spend; spend alerts at 80/100%; reconciliation (A0/A7) | Eng/Finance | mitigating |
| R2 | **Runaway loop** — the loop iterates forever / thrashes a stuck goal | technical | M | H | Max ticks/run, wall-clock per tick, **no-progress detector** → checkpoint instead of looping, global concurrency cap (A0/A2) | Eng | mitigating |
| R3 | **Cross-tenant data leak** — venture A reads venture B | security | L | H | RLS owner-isolation on every `venture_*` row; service identity always scopes by `venture_id`+`user_id`; per-venture DO/container isolation; A9 isolation audit + `get_advisors` | Security | mitigating |
| R4 | **Secret exposure** — provider creds leak via logs/DB/client/generated code | security | M | H | Secrets only in Nango (encrypted); DB stores reference + metadata only; code-safety + secret scan before SHIP; tokens never logged; CI secret scanning (A0/A9, F8) | Security | mitigating |
| R5 | **Managed-hosting abuse** — users host malware/spam/phishing on our infra | legal/security | M | H | Tight per-venture quotas on managed previews; push real prod to BYO; AUP + abuse detection + takedown path; anomaly auto-pause (A9) | Trust & Safety | open |
| R6 | **Provider outage (the audit's #1 finding)** — a model/host provider fails silently | technical | H | M | **F1**: key pool + per-(provider,model) circuit breaker + **cross-provider failover** + per-call timeout budgets; provider error metrics (F0) | Eng | mitigating |
| R7 | **LLM unreliable on big scope** — generation fails/degrades beyond simple apps | product | H | M | First scope = web/landing/simple SaaS only; frontier-via-BYOK for hard goals; stuck→checkpoint; expand scope only when stuck-rate is low (A4) | Product | accepted |
| R8 | **Cloudflare vendor concentration** — pricing/limit shift or lock-in | technical/cost | M | M | Supabase as portable system-of-record; provider-agnostic deploy adapters; runtime behind an interface so BYO targets still work ([architecture §4](../ARCHITECTURE-CLOUDFLARE.md)) | Architecture | monitored |
| R9 | **Prompt injection of agents** — malicious content/feedback steers the agent (exfiltrate, deploy, spend) | security | M | H | DECIDE is deterministic (no LLM) and gates money/prod/destructive; scope guard; checkpoints on irreversibles; signal ingestion rate-limited + owner-scoped; egress logged (A0/A6/A9) | Security | mitigating |
| R10 | **Supply-chain (deps)** — a malicious/vulnerable npm dependency enters a build | security | M | M | Dependency audit + secret/SAST scan before SHIP; CI `npm audit`/Dependabot/CodeQL; least-privilege sandbox; egress rate-limited (F8/A9) | Eng | open |
| R11 | **Data loss** — venture state, code versions, or deployments lost | operational | L | H | Append-only `venture_events`; versioned `studio_versions`; Supabase backups; R2 for artifacts; DR/backup plan (spec §42) | SRE | open |
| R12 | **Compliance / GDPR** — handling EU user data without basis/DPA | legal | M | M | Controller/processor roles defined (§7.3.4); DPA + sub-processor list; data-residency options; deletion/export paths; privacy spec (§36) | Legal/Product | open |
| R13 | **Key / credential theft** — platform or user credentials stolen | security | L | H | Least-privilege, per-venture, revocable deploy tokens; Nango-held BYO creds; MFA + re-auth on sensitive actions (F3); kill switch; rotate-on-incident runbook (A9) | Security | mitigating |
| R14 | **Content / abuse** — users build harmful, illegal, or infringing apps | legal/product | M | M | AUP + output guardrails (`guardrails.ts`); intake/scope review; checkpoint on public publish; reporting + takedown; managed-mode anomaly detection (A9) | Trust & Safety | open |
| R15 | **Billing disputes** — user contests metered/managed charges | cost/legal | M | M | Transparent per-venture metering tagged at source; portal shows agent vs provider cost separately; hard budgets prevent surprise overspend; auditable ledger (A7) | Finance/Product | mitigating |
| R16 | **Checkpoint fatigue / approvals stall the loop** | product/operational | M | M | Keep checkpoints rare + high-value; batch + notify (in-app + email); delegable approval; sensible defaults per autonomy level (A8) | Product | open |
| R17 | **Scope drift** — ORIENT invents work outside the approved roadmap | product | M | M | Scope guard at DECIDE: out-of-scope work raises a scope checkpoint, never auto-proceeds (A3/A6) | Eng | mitigating |
| R18 | **Migration risk (CF DO/Workflows adoption)** — incremental migration regresses today's product | technical | M | M | Migrate coordination/pipelines **behind an interface**, incrementally; keep Railway/BullMQ during transition; retire pieces only once replacements proven ([architecture §4](../ARCHITECTURE-CLOUDFLARE.md)) | Architecture | monitored |

**Priority view (Like.×Impact = H):** R1, R2, R3, R4, R5, R9, R13. These define the A0/A9 gates
— none of them may be "open" at GA without an explicit owner-accepted exception.

---

## 7.5 Dependencies

Autopilot's reliability is bounded by what it depends on. We track external (vendor) and
internal (sequencing) dependencies explicitly.

### 7.5.1 External dependencies

| Provider | Used for | Failure impact | Resilience / fallback |
|---|---|---|---|
| **Cloudflare** | Containers (exec), Workers (edge/API/preview), DO (coordination), Workflows (build pipelines), R2/KV | Core runtime down → loop can't build/ship | Concentration risk accepted but bounded by portable SoR + provider-agnostic adapters (R8); incremental, interface-gated adoption (R18) |
| **Supabase** | Postgres system-of-record, auth (JWT/GoTrue), RLS, storage | State/auth down → control plane down | Treated as *portable* SoR; JWKS local verification (F3) removes per-request dependency on uptime |
| **Stripe** | Billing, credits, plans, checkout, webhooks | Billing/top-up impaired | Metering is local (ledger); Stripe is settlement only; budgets enforce locally regardless |
| **Nango** | BYO provider OAuth/credential vault for deploy adapters | BYO deploys blocked; managed unaffected | Self-hosted Nango; managed-preview path needs no Nango; connection-state/expiry tracking (F10) |
| **Model providers** (OpenRouter, NVIDIA, BYOK) | All LLM generation (ORIENT, build, intake) | Generation fails → loop stalls/wastes budget | **F1**: key pool + circuit breaker + **cross-provider failover**; BYOK isolates user keys; this is the audit's #1 pain |

### 7.5.2 Internal sequencing dependencies

- **F0 → F1 → F2 must ship before A2 wires real autonomous builds.** You cannot run an
  always-on builder you can't observe (F0), on providers that fail silently (F1), with limits
  that don't hold across instances (F2). This is a **hard rule**
  ([foundations sequencing](../F-ENTERPRISE-FOUNDATIONS.md)).
- **A0 (brakes) → A1 (control plane) → A2 (loop engine).** No loop runs before budgets, kill
  switch, checkpoints, and audit exist.
- **A1 needs F6 (migrations)** for the `ventures_*` schema and **F3 (sessions)** for
  authoritative identity before the control plane is trustworthy.
- **A2 and F4 share the Cloudflare DO/Workflows work** — coordinate to avoid duplicate effort.
- **A4 depends on A2 + A3** (a stub-proven loop and an approved roadmap) before real builds run.
- **A9 gates GA** and consumes F8 (supply-chain/secret scanning) + F9 (a11y) as launch gates.

---

## 7.6 Open questions / decisions needing the owner

Each carries a **recommended default** so progress is never blocked waiting on a decision; the
owner can override any of them.

| # | Question | Recommended default |
|---|---|---|
| Q1 | Managed-hosting liability posture — how much production do we host vs push to BYO? | **Managed = previews + small SaaS only, quota-tight; real production → BYO.** Limits cost + abuse + liability (R1/R5/R14). |
| Q2 | Default per-venture budget caps for new ventures | **Conservative defaults** (low `usd_per_day`, modest `usd_total`) with one-click raise via the portal; never uncapped. |
| Q3 | Autonomy tiers — do we offer a higher-trust "fewer checkpoints" mode? | **Ship one governed tier first** (all six checkpoints). Add a higher-trust tier only after stuck-rate + trust data justify it (A2 validation). |
| Q4 | Checkpoint delegation — can the owner delegate approvals to a teammate? | **Yes, post-GA** (needs F3 roles/RBAC). Single-owner approval at first to limit blast radius. |
| Q5 | Data residency / region pinning for managed ventures | **EU + US regions at GA**, default to the user's region; document in the DPA (R12). |
| Q6 | Content/abuse policy + takedown SLA for managed apps | **Adopt a standard AUP + 24–48h takedown SLA**; auto-pause on anomaly pending review (R5/R14). Needs counsel sign-off. |
| Q7 | Naming — "Code Studio Autopilot" / "Venture" | **Keep as-is** unless the owner prefers otherwise (rename is mechanical). |
| Q8 | Insurance / indemnity for managed-hosted user apps | **Defer to counsel**; until resolved, keep managed scope narrow (ties to Q1). |
| Q9 | BYOK enforcement — require BYOK above a spend threshold? | **Yes** — above a per-venture threshold, require BYOK or BYO hosting so we don't front large model/compute cost (protects A7 economics). |

---

## 7.7 Decision triggers

Pre-committed conditions under which we **change strategy** rather than push harder on a plan
that isn't working. Defining these now prevents sunk-cost paralysis later.

| Trigger condition | Strategic change |
|---|---|
| Stuck-rate on first-scope builds stays high after A4 tuning (LLMs unreliable, R7) | **Narrow scope further** (e.g. landing pages + CRUD only) or shift to human-in-the-loop per goal until model quality improves |
| Managed-hosting cost or abuse exceeds a set threshold (R1/R5) | **Pivot the hosting model** — managed becomes preview-only or premium-gated; production is BYO-only |
| BYO connect-rate is low and managed spend dominates (A5 false) | **Reprice** (managed becomes a paid premium) or invest in making BYO connection frictionless before scaling |
| Cloudflare pricing/limits shift materially or a lock-in risk materializes (R8) | **Exercise the adapter abstraction** — move build/coordination to a secondary substrate; lean on portable Supabase SoR |
| A cross-tenant or secret-exposure incident occurs (R3/R4/R13) | **Halt GA / kill switch on**, full security re-audit before re-enabling; treat as a P0 stop-the-line |
| Checkpoint dwell-time is high enough to stall ventures (R16/A9 false) | **Introduce delegation + a higher-trust autonomy tier** with safe auto-approve policies for low-risk actions |
| Provider failover (F1) proves insufficient under real outages (R6) | **Add a third model provider** + hedging; consider a self-hosted fallback only for critical paths (still not general GPU renting) |
| Unit economics turn negative per active venture (A7 false) | **Change pricing** (raise platform fee / meter compute higher) or **enforce BYOK/BYO** above a threshold (Q9) before growth |

---

## 7.8 How this section stays alive

This is a **living register**, not a one-time artifact. The append-only `venture_events` audit
trail (A0) is the data source: budget breaches, stuck-loop pauses, checkpoint dwell-times, and
provider failovers are all observable, so likelihoods and statuses here should be revised from
evidence, not opinion. The owner reviews this section at three gates — **before A2** (real
autonomy on), **before A9** (security hardening), and **before GA** — and at any P0 incident.
No high-likelihood/high-impact risk (R1–R5, R9, R13) may be left `open` at GA without an
explicit, recorded owner exception.
