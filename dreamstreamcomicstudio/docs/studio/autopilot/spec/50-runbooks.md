# 50 — Runbooks & Operational Procedures

> Part V · Delivery · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan](../00-MASTER-PLAN.md) (A0 brakes / kill switch, A9 GA gating) +
> [Enterprise Foundations](../F-ENTERPRISE-FOUNDATIONS.md) (F0 observability — the signals these
> runbooks read · F2 distributed limits · F3 sessions/revocation · F10 secret lifecycle) ·
> builds on [§35 Security & Threat Model](./35-security-threat-model.md),
> [§37 Reliability & SRE](./37-reliability-sre.md) (severity ladder, burn-rate alerts,
> mitigation levers), [§42 Disaster Recovery](./42-disaster-recovery.md) (DR restore,
> kill-switch safe-stop), [§44 CI/CD & Release](./44-cicd-release.md) (deploy + rollback),
> [§40 Cost & FinOps](./40-cost-finops.md) / [§41 Billing & Metering](./41-billing-metering.md)
> (budgets, ledger) · grounded in the **shipped** production runbooks:
> [`deployment-runbook.md`](../../../production/deployment-runbook.md),
> [`go-live-checklist.md`](../../../production/go-live-checklist.md),
> [`alerting-thresholds.md`](../../../production/alerting-thresholds.md).

## 50.1 What this section is

This is the **operator's binder**: a library of concrete, step-by-step runbooks an on-call human
(or, today, the solo owner) follows when something happens. Where §37 says *what* the severity
ladder and mitigation levers are, and §42 says *what* the DR posture is, this section is the
**literal checklist** for each named situation — numbered steps a half-asleep operator can execute
without re-deriving the design.

Every runbook follows the same template so they are interchangeable under stress:

| Field | Meaning |
|---|---|
| **Detection signals** | the alerts/observations that *open* this runbook (which threshold from `alerting-thresholds.md`, which §37.3 burn-rate page, which advisor) |
| **Severity** | the §37.9.1 SEV level this typically maps to |
| **Steps** | numbered, in order; **mitigate before diagnose** (§37.9.2) — stop the bleeding first |
| **Rollback / undo** | how to reverse each consequential action if it makes things worse |
| **Verification** | the checks that *close* the runbook (reused from the deploy smoke test + §42.6) |
| **Post-incident** | what to file (post-mortem for SEV-1/2; ticket otherwise) |

**Honesty rules (consistent with the rest of the spec):**

1. **Shipped vs planned is marked per runbook.** RB-01 (deploy/release) and parts of RB-08 (DR)
   exist as production docs **today** and are marked **[SHIPPED]**; the autonomy-specific ones
   (kill-switch drill, runaway-loop containment, budget breach) depend on A0/A2 + F0 and are marked
   **[PLANNED]** — they describe the procedure for when the engine is live (`VENTURES_ENABLED`).
2. **Most detection signals are F0-blocked.** §37 is explicit: today we have honest health/ready
   endpoints and a *written* threshold table with nothing emitting metrics. Until F0 ships the
   metrics/error-tracking/paging path, several "detection signals" below are *manual observations*,
   not automated pages. We say so where it matters.
3. **Stop the engine first.** For any incident touching the autonomous engine or the data plane,
   **step 0 is the kill switch** (`VENTURES_KILL`, §42.8) — an always-on builder must be halted
   before recovery, or it writes stale/duplicate state over your fix.

The **prime directive**, restated from §37.9.2: *mitigate, then diagnose.* Restore service or stop
the loss first; find root cause after.

---

## 50.2 Runbook index

| ID | Runbook | Typical SEV | Primary trigger | Status |
|---|---|---|---|---|
| **RB-01** | Deploy / release (cross-ref §44) | — (planned change) | release to `Dreamstrream-v1` | **[SHIPPED]** |
| **RB-02** | Incident response (sev, comms, post-mortem) | meta | any page | [PARTIAL] |
| **RB-03** | Kill-switch drill (`VENTURES_KILL`) | — (drill) / SEV-1 (real) | autonomy misbehaving; A9 drill | **[PLANNED]** |
| **RB-04** | Budget breach / spend-spike response | SEV-1/2 | cost alert (`alerting-thresholds` §Cost); budget guard | [PARTIAL] |
| **RB-05** | Provider outage failover (model / Cloudflare / Supabase / Stripe) | SEV-1/2 | dependency 5xx / `/ready` 503 / provider all-down | [PARTIAL] |
| **RB-06** | Runaway-loop / stuck-venture containment | SEV-2/3 | no-progress detector; spend velocity | **[PLANNED]** |
| **RB-07** | Tenant onboarding + offboarding/deletion (GDPR) | — (workflow) | signup; deletion request (Art. 17) | [PARTIAL] |
| **RB-08** | DR restore (cross-ref §42) | SEV-1 | data loss / store down / region loss | **[SHIPPED]** (rollback) / [PLANNED] (full restore) |
| **RB-09** | On-call rotation + escalation | meta | scheduling / handoff | [PLANNED] |
| **RB-10** | Secret rotation | SEV-3 (planned) / SEV-1 (compromise) | scheduled rotation; suspected leak | [PARTIAL] |
| **RB-11** | Cross-tenant-leak suspected (security incident) | **SEV-1** | isolation advisor; user report; anomalous read | **[PLANNED]** |
| **RB-12** | Cost-anomaly investigation | SEV-2/3 | spend deviates from baseline (not yet a breach) | [PLANNED] |

`[SHIPPED]` = a real production doc/procedure exists today · `[PARTIAL]` = some controls exist,
full automation pending F0/F2 · `[PLANNED]` = procedure specified for when the dependency lands.

---

## RB-01 · Deploy / release  **[SHIPPED]** — cross-ref §44

> **Detection signals:** n/a — this is a planned action, not an incident. Triggered by a merge to
> `Dreamstrream-v1` (the production branch). **Severity:** none unless it goes wrong (then RB-08
> rollback).

The full release pipeline is §44; the *operational* checklist is the production deployment runbook
(`deployment-runbook.md`), reproduced here as the canonical steps.

**Steps:**

1. **Pin the SHA.** Confirm frontend (Cloudflare Pages) and backend (Railway) will build from the
   **same commit SHA**. Set `APP_VERSION`, `GIT_SHA`, `BUILD_TIMESTAMP` in both deploy targets.
2. **Pre-flight gate.** Confirm the go-live checklist Part-1 gate is green: `npm run typecheck`,
   `npm run build`, `npm run verify:world-contract`, `npm run build:server` all pass.
3. **Apply migrations** (F6 runner, ordered/idempotent — until then, the by-hand SQL step) **before**
   new code serves traffic. Migrations are expand/contract so old + new code coexist during rollout.
4. **Deploy backend first** (Railway). Verify `curl -i https://api.<domain>/api/system/version`
   reports the **target `gitSha`** and `worldExtractionContractVersion >= 3`.
5. **Deploy frontend second** (Cloudflare Pages) from the **same SHA**. Run
   `npm run verify:world-contract`, then **purge the Cloudflare cache**.
6. **Confirm parity.** `gitSha` matches across frontend + backend runtime diagnostics.
7. **Smoke test** (`deployment-runbook.md` §Smoke Test): `/api/health` 200, `/api/system/ready` 200,
   auth login, one text generation, one image generation, Stripe webhook receives an event at
   `/api/webhook/stripe`.
8. **Staged rollout** (target): promote behind flag/canary `5% → 25% → 100%`, watching the §44.3.3
   health signals (5xx, p95, error budget) at each step.

**Rollback:** see **RB-08** (rollback path). Frontend → redeploy previous Pages deployment;
backend → redeploy previous Railway image; verify health/ready/version; verify login + one
generation before closing. **Never force-push production.**

**Verification:** the §50.13 standard post-change checklist (health/ready/version, auth, one clean
flow). **Post-incident:** none if clean; if rolled back, file a SEV-2/3 post-mortem (RB-02).

---

## RB-02 · Incident response  [PARTIAL]

> **Detection signals:** any burn-rate **Page** (§37.3.2: 14.4× / 6× pairs) or static critical
> alert (`alerting-thresholds.md` #1/#3, p95 > 5s, image error > 10%); or a credible human report.
> **Severity:** assigned in step 2 from the §37.9.1 ladder (SEV-1…SEV-4).

This is the **meta-runbook** every other runbook plugs into — the incident loop from §37.9.2.

**Steps:**

1. **Detect & acknowledge.** Alert fires (or report arrives). Acknowledge the page so it stops
   re-paging and so the timeline starts.
2. **Declare & classify.** Open a single incident channel/thread. Assign a **SEV** (§37.9.1) and an
   **incident commander** (today: the owner). Start the timeline — every action gets a timestamp.
3. **Mitigate first (stop the bleeding).** Reach for the §37.9.2 levers *in order*:
   (a) **kill switch** for any autonomy-driven incident (RB-03); (b) **roll back** the last deploy
   (RB-08); (c) **lower autonomy cadence / freeze deploys** per the error-budget policy (§37.3.1);
   (d) **scale** per `scaling-and-cost.md`; (e) **shed load** via backpressure (§37.6). Jump to the
   specific runbook (RB-04…RB-12) for the matching situation.
4. **Communicate.** Post status to stakeholders (and the status page, when one exists). Cadence:
   SEV-1 every 30 min, SEV-2 hourly, until resolved. Honest, factual, no speculation on cause.
5. **Diagnose.** Once mitigated, find root cause: logs by `requestId`, the `gitSha` from
   `/api/system/version` to correlate the release, the append-only `audit_log` / `venture_events`
   (§26.11), advisors (`get_advisors`). All depend on F0 for the rich path.
6. **Resolve & verify.** Apply the fix; run the §50.13 verification; confirm the alert clears and
   the burn-rate normalizes.
7. **Close & retro.** Close the incident. For **SEV-1/2**, file a **blameless post-mortem**
   (§50.14) within 3 business days: timeline, root cause, **error-budget impact** (§37.3), what
   worked, dated action items with owners.

**Rollback:** each mitigation lever in step 3 is independently reversible (un-flip the kill switch
after verification; redeploy forward; raise cadence). **Comms templates** live in §50.14.

---

## RB-03 · Kill-switch drill (`VENTURES_KILL`)  **[PLANNED]** — A9 gate

> **Detection signals (real use):** runaway spend, suspected cross-tenant leak, a venture deploying
> bad code, or any SEV-1 where autonomy must stop *now*. **Detection signals (drill):** scheduled
> A9 readiness exercise (the §35.10 "kill-switch drill" GA requirement). **Severity:** SEV-1 (real)
> / none (drill).

The kill switch is **step 0 of every data-plane and autonomy incident** (§42.8). This runbook is
both the emergency procedure and the drill that proves it works before GA.

**Steps (engage):**

1. **Flip `VENTURES_KILL=true`** via the admin route. It is re-checked at **both** the scheduler
   *and* inside the DECIDE gate (§24.7) — so no new Tick proceeds to ACT.
2. **Confirm halt.** Verify no Tick advances past DECIDE: watch `venture_events` (or the Operator
   Console) for the absence of new ACT/SHIP events; confirm scheduled runs do not start.
3. **Confirm the audit row.** The flip writes `audit_log` (`action='kill_switch'`, actor +
   `request_id`, §26.11) — confirm it landed so the timeline is reconstructable.
4. **Verify safe-stop semantics.** In-flight Ticks either never passed DECIDE (never acted) or
   completed their current durable step; the loop is crash-safe (§24.9). No mid-write corruption,
   no half-spend, no half-ship.
5. **(If targeted, not global)** prefer **per-venture pause** (`ventures.status='paused'`,
   `pause_reason='kill'`, §26.4) to isolate one venture without halting the fleet.

**Steps (disengage — only after the incident is resolved & verified):**

6. Run the relevant runbook's verification and the §42.6 checklist (isolation, ledger, one clean
   Tick).
7. **Flip `VENTURES_KILL=false`** (or lift the per-venture pause). Watch **one Tick** end-to-end
   (DECIDE gate → budget read → event append) before declaring recovery.

**Drill acceptance:** time-to-halt measured (target: seconds); audit row present; one venture
verified stopped mid-build with no corruption; un-flip resumes cleanly. Record last-drilled date —
it is an A9/SRE metric and a GA gate (§35.10).

**Rollback:** disengaging *is* the rollback. If un-flip causes problems, re-flip immediately
(idempotent, instant).

---

## RB-04 · Budget breach / spend-spike response  [PARTIAL]

> **Detection signals:** `alerting-thresholds.md` §Cost — daily spend warning 60% / critical 85%;
> monthly warning 70% / critical 90%. Plus a per-venture **budget guard** breach (§26.5) or a
> token-ledger velocity spike (§41). **Severity:** SEV-1 (runaway, money escaping) / SEV-2
> (elevated but bounded).

Distinguish two cases up front: a **per-venture** breach (one venture's cap) vs a **platform**
spend spike (aggregate across tenants).

**Steps:**

1. **Mitigate — stop the spend.**
   - **Per-venture:** the deterministic budget guard should already have **paused** the venture on
     breach (`pause_reason='budget'`, A0). Confirm it did; if not (guard gap), pause it manually.
   - **Platform-wide / unclear source:** **flip `VENTURES_KILL`** (RB-03) — halt all autonomy
     before diagnosing. This is the "stop the bleeding" lever.
2. **Identify the source.** Query the **token ledger** (§41) and cost events grouped by venture /
   provider / model / day. Find the top contributor(s) and when the slope changed.
3. **Classify** the spike: legitimate growth, a runaway loop (→ **RB-06**), a pricing/model
   regression (an expensive model selected), a provider price change (→ **RB-12** cost-anomaly), or
   abuse (→ §35.6 anomaly).
4. **Contain at the right layer.** Tighten the venture's budget cap; pin a cheaper model; lower
   autonomy cadence (§24.4.1); for abuse, suspend the tenant (RB-07 offboarding controls).
5. **Reconcile.** Compare the internal ledger to the provider's billing (Google AI / OpenRouter /
   NVIDIA / Stripe). Identify the actual dollar exposure vs the alert estimate.

**Rollback:** raise the cap / un-pause the venture / un-flip the kill switch **after** the source is
understood and contained. Reversing too early re-opens the spend.

**Verification:** spend velocity returns to baseline; ledger reconciles to provider billing; the
cost alert clears. **Post-incident:** SEV-1/2 post-mortem; action item to tighten the breached
guard or add a missing alert. (Full automation — auto-pause on velocity — is A0 + F0.)

---

## RB-05 · Provider outage failover  [PARTIAL]

> **Detection signals:** model gateway: all-models-down / sustained provider 5xx (§29.6 breaker);
> Cloudflare: edge errors / Pages or Worker down; Supabase: `/api/system/ready` returns **503**
> (DB unreachable, `system.ts:322`) or `alerting-thresholds.md` #4; Stripe: webhook failures /
> charge errors. **Severity:** SEV-1 (Supabase/Cloudflare global) / SEV-2 (model-all-down,
> Stripe).

Each vendor degrades differently; pick the sub-procedure for the affected dependency. The unifying
rule (§37.5): **fail narrow** — one dependency down degrades one capability, not the platform.

**A. Model / LLM provider down**
1. Confirm via the model gateway (provider error counters, §29.6). The breaker should **open** and
   **fail over** OpenRouter↔NVIDIA (F1); confirm failover fired.
2. If **all** providers are down: ACT pauses (no thinking) — this is graceful, **not** corruption.
   No data is lost; Ticks resume on recovery. Consider lowering cadence to avoid retry-amplification.
3. Surface a typed error to users (not a 500); communicate degraded AI features.
**Rollback:** none needed — auto-recovers when a provider returns; close the breaker.

**B. Cloudflare**
1. A single PoP/colo loss is absorbed transparently (edge is multi-region, §42.5) — usually no
   action. 2. A **global** Cloudflare outage = product down (we run on it, §42.10) — communicate;
   there is no failover for the platform itself. R2 reads survive regionally; DO state is durable.
**Rollback:** n/a (vendor-side recovery).

**C. Supabase (system of record)**
1. **Flip `VENTURES_KILL`** (RB-03) — do **not** let the engine write against a degraded data
   plane (§42.5). 2. Confirm `/ready` is 503 (fail-closed pulls unhealthy instances). 3. If a region
   outage is **prolonged**: escalate to **RB-08** → PITR-restore into a healthy region (§42.4.7).
   4. Edge stays up; serve cached reads where safe (catalog pattern, §37.5).
**Rollback:** lift the kill switch after `/ready` is 200 and the §42.6 checklist passes.

**D. Stripe**
1. Charges queue/retry; the engine can keep building on **existing** budget. 2. Do **not** block
   product access on a billing-provider blip. 3. On recovery, **reconcile** the ledger to Stripe
   (§42.6, RB-04 step 5).
**Rollback:** n/a; reconcile forward.

**Verification (all):** `/ready` 200; the affected capability restored; one clean flow through it;
ledger reconciled (D). **Post-incident:** SEV-1/2 post-mortem with vendor-SPOF note (§42.10).

---

## RB-06 · Runaway-loop / stuck-venture containment  **[PLANNED]** — A0/A2

> **Detection signals:** the **no-progress detector** (`STUCK_REPEAT_LIMIT=3`, §24.7) fires; a
> venture exceeds `MAX_TICKS_PER_RUN`; spend velocity for one venture climbs without a corresponding
> VERIFY-pass (§37 SLO 4); the per-tick wall-clock timeout trips repeatedly. **Severity:** SEV-2
> (one venture burning) / SEV-3 (stuck but bounded).

A *runaway* loop spends/retries without progress; a *stuck* venture has stopped progressing and
should checkpoint. The engine is designed to catch both (§24.7, §24.11); this runbook is the human
backstop when the guards underperform or for a venture not yet auto-contained.

**Steps:**

1. **Contain the one venture first** (prefer surgical over global): **pause it** —
   `ventures.status='paused'`, `pause_reason='stuck'` (§26.4). Only escalate to global
   `VENTURES_KILL` (RB-03) if multiple ventures are affected or the cause is shared.
2. **Confirm the guard state.** Check whether the no-progress detector / budget guard already acted.
   If a guard *should* have fired but didn't, that is itself a SEV-2 (a brake gap) → post-mortem.
3. **Inspect the loop.** Read `venture_events` for the repeating phase: is it the same failing ACT
   re-tried (model can't fix it), a flapping VERIFY, or a thrash between two states? Read the last
   TickCursor (§24.9).
4. **Decide the disposition:** (a) **raise a checkpoint** for the owner (the correct outcome for a
   genuinely stuck goal — §24.5.2 — *not* infinite retry); (b) **roll the venture back** to its last
   clean version snapshot (§32, §42.4.2); (c) **cap & resume** with a tighter budget if it's making
   slow progress; (d) **abandon the goal** and re-plan.
5. **Verify no double-spend / double-ship.** The loop is idempotent + crash-safe (§24.9) — confirm
   the ledger and deploy rows show no duplicate action from the thrash.

**Rollback:** un-pause the venture after the disposition is chosen; if the chosen fix regresses,
re-pause (idempotent).

**Verification:** the venture either makes a clean VERIFY pass, sits cleanly at a checkpoint, or is
cleanly abandoned; spend velocity flat; no duplicate ledger/deploy entries. **Post-incident:** if a
guard gap caused it, file the A0 brake fix; otherwise a quality ticket (model/template regression).

---

## RB-07 · Tenant onboarding + offboarding / deletion (GDPR)  [PARTIAL]

> **Detection signals:** n/a — workflows, not incidents. Triggered by signup (onboard), churn /
> suspension (offboard), or a **GDPR Art. 17 erasure request** (delete). **Severity:** none, unless
> a deletion fails to reach external state (then SEV-2 — dangling credentials/data).

Cross-ref §36 (privacy/compliance), §25.8 (delete reaches external state), §33 (sessions).

**A. Onboarding**
1. Account created via Supabase Auth; tenant rows seeded under RLS (user owns their `ventures`,
   `venture_*`). 2. No autonomy until `VENTURES_ENABLED` + plan gate (A9). 3. BYO connections, if
   any, are minted in **Nango** (never in our DB — only a `nango_connection_id` reference, §26.10).
4. Verify isolation: the new tenant can read only their own rows (the A9 "user A ≠ user B" test).

**B. Offboarding / suspension** (reversible)
1. Suspend: block new autonomy (per-venture pause / flag), keep data. 2. Revoke active sessions
   (§33/F3) if the suspension is for cause. 3. Notify per the plan's terms.

**C. Deletion / GDPR erasure** (irreversible — confirm authority first)
1. **Confirm the request is authenticated** and within scope (the data subject or authorized agent).
2. **Stop autonomy** for the tenant's ventures (pause) so nothing writes during deletion.
3. **Revoke BYO tokens in Nango** and **tear down managed deployments** (§25.8) — *no dangling
   credentials, no live deployed app outliving the account*. This is the step that reaches
   **external** state and most often fails silently — verify each connection is revoked.
4. **Delete / anonymize tenant data.** Venture delete is **archival, not cascade** by design
   (§26.14, `on delete set null`) — for a *true* GDPR erasure, the PII-bearing rows are
   deleted/anonymized while the append-only `audit_log` retains the *fact* of deletion (lawful-basis
   record-keeping, §36).
5. **Purge object storage** (R2 spill/snapshots, Supabase Storage assets) tied to the tenant.
6. **Record the erasure** as an audited event; produce the deletion confirmation for the requester.

**Rollback:** B is reversible (un-suspend). **C is not** — which is why step 1 (confirm authority)
and step 2 (stop autonomy) gate it. There is no "undo delete" beyond a DR restore predating it.

**Verification:** A → isolation test passes; C → no Nango connection remains, no live managed
deployment, no tenant rows/objects resolve, audit shows the erasure. **Post-incident:** SEV-2 if any
external-state revocation failed (dangling credential = security exposure).

---

## RB-08 · DR restore  **[SHIPPED]** (rollback) / **[PLANNED]** (full restore) — cross-ref §42

> **Detection signals:** data loss (accidental delete / bad migration), a store down, region loss,
> integrity-check failure, ledger drift (§42.9 Detect). **Severity:** SEV-1.

§42 owns the DR design; this is the operational checklist. It follows the §42.9 shape:
**detect → contain → restore → verify → post-mortem**.

**Steps:**

1. **Classify** — is this a DR-class event (data lost / store down / region dark) or a transient
   blip? Open the incident, start the timeline.
2. **Contain — kill switch first.** Flip `VENTURES_KILL` (RB-03) so the engine never writes against
   a degraded/stale plane or over a restore in progress. Stop the bleeding (revoke a compromised
   cred, fail a bad migration, isolate the store).
3. **Choose the restore** (§42.4.7):
   - **Bad deploy / config drift → ROLLBACK [SHIPPED]:** redeploy the previous Railway image +
     previous Cloudflare Pages deployment (`deployment-runbook.md` §Rollback). Fast, minutes.
   - **Accidental row/table delete or bad migration → PITR** to a timestamp *just before* the event,
     into a **new** Supabase project (RPO ≤ 1 min, RTO ≤ 1–2 h).
   - **Postgres project loss → restore** latest base backup + WAL → new project → repoint
     `VITE_SUPABASE_URL` / service-role in deploy targets.
   - **Supabase-account disaster → provision** fresh project → apply migrations from git (§26.13) →
     load latest logical `pg_dump` from R2 → reconcile ledger vs Stripe.
   - **R2 object loss → restore** from object version or cross-account copy; verify by sha256.
   - **Region loss → PITR-restore into a healthy region** (§42.5).
   - **Nango connection loss → re-authorize** (no secret backup exists by design, §42.4.4).
   Restore into a **new** target, **never in-place on a corrupt store**.
4. **Verify — the §42.6 post-restore checklist:** health/ready/version (`gitSha` correct); auth +
   no mass-logout beyond the restore point; **tenant isolation intact** (RLS not weakened); **ledger
   reconciled** to Stripe for the restore window; **object integrity** (sampled sha256); audit
   continuity. **Then lift the kill switch** and watch **one clean Tick** end-to-end.
5. **Post-mortem** — timeline, root cause, **RPO/RTO achieved vs target**, action items; update §42
   / this runbook if the procedure changed; record last-restore-tested date.

**Rollback:** the deploy-rollback case *is* a rollback; for data restores, the restore goes to a new
target so the original (if recoverable) remains untouched until cutover is verified.

**Verification:** §42.6 (above). **Post-incident:** SEV-1 post-mortem mandatory.

---

## RB-09 · On-call rotation + escalation  [PLANNED]

> **Detection signals:** n/a — operational process. **Severity:** none.

§37.9.2: **owner-as-on-call today**; this scales to a rotation as the team grows (§48 RACI,
planned). Requires F0 for a real paging path.

**Steps (running the rotation):**

1. **Primary** holds the pager for the shift (weekly handoff). **Secondary** is backup if primary
   doesn't ack in the escalation window.
2. **Paging path:** burn-rate **Page** alerts (§37.3.2) → Sentry/alerting (F0) → push/SMS to
   primary. Tickets (warnings) go to the queue, not the pager.
3. **Acknowledge SLA:** SEV-1 ack within **5 min**, SEV-2 within **15 min** (illustrative `[design]`).
4. **Escalation ladder:** primary → secondary (no-ack window) → incident commander / owner →
   (paid SLA era) vendor support. For a **security** incident (RB-11), escalate to the security
   owner immediately, in parallel.
5. **Handoff:** outgoing on-call writes a handoff note — open incidents, watch-items, recent
   deploys, current error-budget state (§37.3).

**Rollback:** n/a. **Verification:** a test page reaches primary; escalation fires on a simulated
no-ack (the go-live "monitoring alerts test-fired" gate). **Post-incident:** n/a.

---

## RB-10 · Secret rotation  [PARTIAL]

> **Detection signals:** scheduled rotation (calendar); **or** a suspected leak / committed-secret
> alert (`run_secret_scanning`, gitleaks, F8) → emergency rotation. **Severity:** SEV-3 (scheduled)
> / **SEV-1** (compromise — combine with RB-11 if cross-tenant).

Per §35.9: platform secrets are **rotatable via host env with no code change**; the HMAC scheme
supports a key-rotation window; Nango owns BYO refresh-token lifecycle (F10 tracks expiry).

**Steps (scheduled rotation, one secret at a time):**

1. **Mint the new secret** at the provider (Supabase service-role, Stripe, OpenRouter/NVIDIA/Gemini
   keys, `STRIPE_WEBHOOK_SECRET`, signing keys, etc.).
2. **Dual-validity window** where supported: for HMAC/signing keys, deploy with **both** old + new
   valid (the rotation window) so in-flight requests don't break.
3. **Update the deploy-target env** (Railway / Cloudflare Pages) — secrets live in deploy targets,
   **never in git** (§44.8). Redeploy or hot-reload.
4. **Verify** the service works on the new secret (one auth flow, one provider call, one Stripe
   webhook for the webhook secret).
5. **Revoke the old secret** at the provider once the window closes and traffic is confirmed on the
   new one.
6. **Audit** the rotation (who, when, which secret — not the value).

**Steps (emergency — suspected compromise):**
1. **Revoke the compromised secret immediately** (skip the dual-validity grace if active misuse).
2. Mint + deploy the replacement (steps 1–4 above), accepting brief disruption.
3. If a **BYO** credential is implicated, the owner **re-authorizes** in Nango (§42.4.4); per-venture
   tokens are revocable and isolated, limiting blast radius (Master Plan §5.9).
4. Scan for exposure: was it logged? committed? (§35.7 dual fences — model-output scan + diff scan).
5. If tenant data may have been reachable → **escalate to RB-11**.

**Rollback:** if the new secret is itself bad, re-mint (don't revert to the compromised one).
**Verification:** service healthy on the new secret; old secret rejected; audit row present.
**Post-incident:** emergency rotation → SEV-1 post-mortem.

---

## RB-11 · Cross-tenant-leak suspected (security incident)  **[PLANNED]** — SEV-1

> **Detection signals:** isolation advisor (`get_advisors`) flags an RLS gap; a user reports seeing
> another tenant's data; anomalous read pattern (one identity reading across `user_id`s); a failing
> "user A ≠ user B" test in prod. **Severity:** **SEV-1 always** — this is the highest-severity
> class in the threat model (asset B Integrity breach, §35).

A cross-tenant leak is a confirmed-or-suspected **breach**. Treat it as such: contain
aggressively, preserve evidence, assume the worst until disproven.

**Steps:**

1. **Contain — halt and isolate.** Flip `VENTURES_KILL` (RB-03) to stop the engine from propagating
   any leaked data, and freeze writes to the affected surface. If a specific code path is implicated
   (a route missing an RLS check), disable it via flag.
2. **Preserve evidence.** Snapshot relevant logs, `audit_log`, `venture_events`, and the suspect
   query path **before** changing anything — the post-mortem and any disclosure obligation need the
   forensic record (the append-only logs are designed for this, §26.11/§26.14).
3. **Confirm scope.** Determine *what* leaked (which assets — ventures/code/events/analytics, §35),
   *to whom*, and *for how long*. Run the RLS-coverage check / `get_advisors`; identify the missing
   or broken policy.
4. **Remediate the root cause.** Add/fix the RLS policy (every table must have one — F6); the
   service-identity scoping (§35 S5); deploy the fix (RB-01) with the isolation test as a required
   gate. The "user A cannot read user B" test must pass before re-enabling the path.
5. **Assess disclosure duty.** If personal data was exposed, engage the §36 privacy process —
   GDPR breach notification timelines (72h to the supervisory authority) may apply. **This is not
   optional** and is time-boxed.
6. **Lift containment** only after the fix is deployed, the isolation test is green in prod, and the
   §42.6 checklist passes (a security restore must not weaken RLS).

**Rollback:** the *containment* lifts (un-flip kill switch, re-enable path) only post-verification;
the *fix* rolls forward only.

**Verification:** isolation tests green in prod; advisor clean; no anomalous cross-`user_id` reads.
**Post-incident:** **mandatory** SEV-1 post-mortem + the §35.10 security-review gate must be re-run;
this event blocks/re-opens GA gating if pre-GA.

---

## RB-12 · Cost-anomaly investigation  [PLANNED]

> **Detection signals:** spend **deviates from baseline** but has **not** breached a hard budget cap
> (the early-warning zone — `alerting-thresholds.md` §Cost warning tiers, 60%/70%); an unexplained
> change in cost-per-venture or cost-per-Tick; a provider price change. **Severity:** SEV-2
> (climbing fast) / SEV-3 (drift). This is the *investigate* runbook; if it crosses into a breach,
> escalate to **RB-04**.

The goal is to explain a cost change **before** it becomes a breach — distinguish "healthy growth"
from "a problem."

**Steps:**

1. **Quantify the deviation.** Pull the token ledger / cost events (§41) and chart spend by day,
   broken down by **venture / provider / model / phase (ACT vs VERIFY vs SHIP)**. Compare to the
   trailing baseline (§40 FinOps).
2. **Localize.** Is the increase broad (more ventures / more users = healthy growth) or concentrated
   (one venture, one model, one phase = suspicious)?
3. **Attribute the cause** to one of: (a) **volume** (more legitimate work) → capacity/FinOps note,
   no incident; (b) **efficiency regression** (more tokens per outcome — a worse prompt/template, a
   thrashing loop → **RB-06**); (c) **model-mix shift** (an expensive model selected where a cheap
   one suffices → pin/route fix); (d) **provider price change** (external — update the cost model,
   §40); (e) **abuse** (§35.6 → RB-07 suspension).
4. **Recommend & act.** No-op (growth), or apply the matching fix; tighten an alert threshold if the
   anomaly slipped past the warning tier.
5. **Project forward.** Estimate the run-rate impact and whether it threatens a budget cap (→ if yes,
   pre-emptively raise the issue per RB-04 before the breach fires).

**Rollback:** any applied fix (model pin, cadence change) is reversible. **Verification:** the cost
slope is explained and either accepted or corrected; the ledger reconciles to provider billing.
**Post-incident:** FinOps note (§40); ticket for any threshold/alert tuning. (Automated anomaly
detection on spend velocity is §35.6 / A0 + F0.)

---

## 50.13 Standard verification checklist (reused by every runbook)

Every consequential runbook closes by passing this, extended from the deploy smoke test
(`deployment-runbook.md`) and the §42.6 DR checklist:

1. **Health / readiness / version** — `/api/health` 200, `/api/system/ready` 200,
   `/api/system/version` reports the **expected `gitSha`** and `worldExtractionContractVersion >= 3`.
2. **Auth** — one login flow + session check; no mass-logout beyond any restore point.
3. **One clean user flow** — one text generation and one image generation succeed.
4. **Tenant isolation** — the "user A cannot read user B" test passes (no runbook may weaken RLS).
5. **Ledger reconciliation** — billing ledger vs Stripe for the affected window (financial-touching
   runbooks: RB-04, RB-05D, RB-08).
6. **Engine resumes cleanly** — with autonomy involved: lift `VENTURES_KILL`, confirm **one Tick**
   completes end-to-end (DECIDE gate → budget read → event append) with no double-spend/double-ship.
7. **Audit continuity** — `audit_log` / `venture_events` show the incident *and* the recovery as
   audited events, with `request_id` correlation.

If any check fails, the incident is **not** closed — return to the runbook's steps.

## 50.14 Post-mortem template & comms

**Post-mortem (SEV-1/2, blameless, within 3 business days):**

| Field | Content |
|---|---|
| Summary | one paragraph: what happened, user impact, duration |
| Timeline | timestamped: detect → declare → mitigate → diagnose → resolve → close |
| Root cause | the actual cause (not "human error" — the system that allowed it) |
| Error-budget impact | which SLO(s), how much budget burned (§37.3) |
| What worked / what didn't | honest, blameless |
| Action items | dated, owned, tracked — e.g. add an alert, tighten a brake, fix a migration gate, add a missing RLS policy |
| Runbook delta | did the runbook need changing? update §50 + the source §35/§37/§42 if so |

**Comms cadence:** SEV-1 update every 30 min, SEV-2 hourly, until resolved; honest and factual; no
cause speculation in public comms. (Status-page integration is post-F0.)

---

## 50.15 Mapping to the plan & acceptance criteria

| This section ties to | Via |
|---|---|
| **§37 Reliability & SRE** | the severity ladder (§37.9.1), mitigation levers (§37.9.2), and the "must-have runbook set" (§37.9.3) are *implemented* here as RB-02…RB-12 |
| **§42 Disaster Recovery** | RB-08 is the operational expansion of the §42.9 DR skeleton; the §42.6 checklist is reused as §50.13 |
| **§44 CI/CD & Release** | RB-01 is the §44.3.3 release + rollback as a checklist |
| **§35 Security** | RB-03 (kill-switch drill, §35.10 GA gate), RB-10 (rotation, §35.9), RB-11 (cross-tenant leak, the SEV-1 breach class) |
| **§40/§41 Cost & Billing** | RB-04 budget breach + RB-12 cost-anomaly read the token ledger and cost-alert tiers |
| **§36 Privacy** | RB-07 deletion implements GDPR Art. 17 erasure (delete reaches external state, §25.8) |
| **F0 / A0 / A2 / F2 / F3** | detection signals (F0 metrics/paging), kill switch + guards (A0/A2), shared limits/backpressure (F2), session revocation (F3) — marked per-runbook where blocked |

**Acceptance criteria.** Runbooks are "done" when:

1. Each of the **12 named runbooks** exists as a numbered, executable checklist with **detection
   signals**, **steps (mitigate-before-diagnose)**, **rollback/undo**, and a **verification** that
   closes it. (This section.)
2. **Shipped vs planned is honest** per runbook, and F0/A0/A2 dependencies are named where a
   detection signal or control is not yet wired.
3. **The kill switch is step 0** of every autonomy/data-plane runbook (RB-03 referenced from RB-04,
   05C, 06, 08, 11), and **RB-03 has been drilled** (last-drilled date recorded — an A9 GA gate).
4. **A SEV-1 has a path**: it pages (RB-09), runs the matching runbook, and produces a blameless
   post-mortem with an error-budget impact note (§50.14).
5. Every runbook ends in the **standard verification checklist** (§50.13) and **changes no other
   file** — the source-of-truth designs stay in §35/§37/§42/§44; this section is their operator binder.
