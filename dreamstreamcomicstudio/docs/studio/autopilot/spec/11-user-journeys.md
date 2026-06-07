# 11 — End-to-End User Journeys

> Part II · Product Definition · Canon: [SPEC-INDEX](../SPEC-INDEX.md)

## 11.1 How to read this section

This section traces the **complete arc** of each primary persona ([03-personas-jtbd](./03-personas-jtbd.md))
through the product, surface by surface ([Intake / Operator Console / Code Studio](./00-executive-summary.md)
§0.4). Each journey is written honestly: the **happy path** *and* the **failure /
checkpoint branches** that the design ([Master Plan](../00-MASTER-PLAN.md) §8) deliberately
forces. Every journey lists its **trigger**, a numbered **step-by-step flow** (user action ↔
system action), the **checkpoints** that gate it, the **failure branches**, and the
**success state**. Each step is annotated with the spec section and/or epic (A0–A9, F0–F10)
that implements it, so this doubles as a traceability map.

Notation: **[U]** = user action, **[S]** = system/agent action, **◇** = checkpoint (human
gate), **✗** = failure branch. The atomic unit referenced throughout is **one tick** —
SENSE → ORIENT → DECIDE → ACT → VERIFY → SHIP → REFLECT ([Master Plan](../00-MASTER-PLAN.md)
§4.1).

---

## 11.2 Journey A — Maya: idea → first live Venture

**Persona:** Maya, non-technical founder (P1). **Trigger:** Maya signs up, clicks
*"New Venture,"* and types a paragraph describing her idea.

```
 IDEA ─► INTAKE ─► ◇ROADMAP ─► AUTONOMOUS BUILD ─► MANAGED PREVIEW ─► ◇PROD DEPLOY ─► LIVE URL
   │        │         │              │ (loop)            │                 │             │
  [U]      [S]       [U]            [S]×N              [S]               [U]           [S]
```

**Step-by-step (happy path)**

1. **[U]** Maya writes: *"A habit-tracker SaaS with email reminders and a weekly streak
   report."* (Intake surface — Epic **A3**, UX §13.)
2. **[S]** The intake agent runs an LLM flow (reuses `studioPlan.ts` patterns + swarm planner)
   and returns a **venture spec**: name, summary, declared **scope**, success metrics, and a
   structured **roadmap** of goals (epics → features → tasks). (A3; ORIENT model via
   `autoRouter`, §29.)
3. **[S]** Before any work, Maya is shown a **budget setup**: a hard cap she sets with sliders
   (`usd_total`, `usd_per_day`). The cap is a real brake, not a suggestion. (Budgets — Epic
   **A0**; portal UX §17/§41.)
4. **◇ Roadmap-approval checkpoint.** **[U]** Maya reviews the roadmap, edits/removes goals,
   then approves. Approval resolves the checkpoint and flips the venture `draft → active`.
   (Checkpoint type 6, [Master Plan](../00-MASTER-PLAN.md) §8; `approve-roadmap` route, A3.)
5. **[S]** The **loop engine** (Epic **A2**) begins ticking. Each tick: SENSE (backlog) →
   ORIENT (pick highest-value goal, within scope) → DECIDE (budget OK? checkpoint needed?) →
   ACT (real build via the Phase-4 build loop + swarm, Epic **A4**) → VERIFY (typecheck/build/
   tests + safety scan) → SHIP → REFLECT (append `venture_event`, update goals, record cost).
6. **[S]** Each goal that passes VERIFY ships automatically to a **managed preview** at
   `*.dreamstreamstudio.ai` — no credentials needed (managed-preview adapter, Epic **A5**).
   Maya gets an instant, working link early.
7. **[U]** Maya watches it happen in the **Operator Console** (Epic **A8**, UX §14): a legible
   live activity stream, the roadmap board advancing, and a live **spend meter vs cap**. She
   never has to read code.
8. **◇ Production-deploy checkpoint.** When the loop is ready to put the product on a real
   production URL, it **pauses** and raises a checkpoint. **[U]** Maya is notified (in-app +
   email) and approves. (Checkpoint type 1; §16.)
9. **[S]** SHIP runs the production deploy (managed production, or BYO if she connected an
   account). `ventures.deploy_url` is set; the event is logged.

**Success state.** Maya has a **live, working URL** she can show users, a roadmap that keeps
advancing, spend safely under her cap, and a feeling of control — exactly her JTBD
([03](./03-personas-jtbd.md) §3.2). She can say *"I built this."*

**Checkpoints in this journey:** roadmap approval (4), production deploy (8). Plus implicit
budget enforcement throughout (A0).

**Failure / branch handling**

- **✗ Intake too vague.** The agent can't produce a confident scope → it asks 2–3
  clarifying questions in the wizard rather than guessing. (A3; never auto-invent scope.)
- **✗ A goal won't build.** ACT/FIX retries within the per-goal iteration cap
  (`buildGuards.ts`). If still stuck, the **no-progress detector** ([Master Plan](../00-MASTER-PLAN.md)
  §8) raises a checkpoint: *"This goal is stuck — skip, retry, or give guidance?"* — it does
  **not** loop forever burning budget. (A2/A4.)
- **✗ Spend nears the cap.** See Journey D — the venture alerts at 80%, pauses at 100%; Maya
  is never surprised by a bill.
- **✗ Maya denies the prod deploy.** The loop stays paused on that step and (if she leaves a
  note) re-plans; nothing ships externally without her yes. (§16; checkpoint type 1.)

---

## 11.3 Journey B — Dev: BYOK, BYO cloud, many ventures, mid-loop takeover

**Persona:** Dev, solo developer / indie hacker (P1). **Trigger:** Dev wants leverage on
several side projects at once, on **his own keys and accounts**, with the real code.

```
 CONNECT KEYS/ACCOUNTS ─► CREATE VENTURES ─► RUN CONCURRENTLY ─► TAKE OVER IN EDITOR ─► PUSH PR ─► DEPLOY TO OWN ACCT
        │                      │                  │ (×3 loops)         │                   │             │
       [U]                    [U]                [S]                  [U]                  [S]          [S]
```

**Step-by-step (happy path)**

1. **[U]** Dev opens **Integrations** (UX §18) and connects: his **OpenRouter/NVIDIA API
   keys** (BYOK, fed into the provider key pool, F1/§29) and his **Cloudflare + GitHub**
   accounts via Nango. Each becomes a `venture_connection` (reference only; secrets stay in
   Nango). (Epic **A5**; §30.)
2. **[U]** Dev creates **three ventures** from short prompts (A3). Each gets its own budget,
   its own `studio_project`, its own audit trail.
3. **[S]** The scheduler runs all three **concurrently**, each isolated (per-venture
   `VentureDO` / RLS / container sandbox), bounded by the **global concurrency cap** so the
   providers and bill stay safe. (Multi-tenancy §25; [Master Plan](../00-MASTER-PLAN.md) §5.)
4. **[S]** Because Dev's keys are in the pool, a single provider **429** fails over to another
   key/provider instead of stalling a session (F1 — the audit's #1 finding; §29).
5. **[U]** Dev sees venture #2 take an architectural turn he disagrees with. He clicks **"Take
   over"** in the **Code Studio** editor mid-loop. The loop **yields** that venture (pauses
   the tick, releases the project lock); the other two keep running. ("Code optional, never
   code-locked," §0.4; UX §15.)
6. **[U]** Dev edits files directly, reviews diffs, and writes a guidance note redirecting the
   roadmap. (Editor + diffs, §15; goal edit, A8.)
7. **[U]** Dev hands control back ("Resume autonomy"). The loop re-SENSEs the now-changed
   project state and continues from his edits. (A2 resumability.)
8. **[S]** On the next shippable goal, the venture opens a **GitHub PR** against his repo
   (two-way sync, `studioGithub.ts`) rather than committing blind, so Dev reviews like any
   teammate's work.
9. **◇ Production-deploy checkpoint.** **[U]** Dev approves; **[S]** the **cloudflare-pages /
   -workers** adapter deploys to **his own Cloudflare account** using his connection
   (least-privilege, per-venture token, never logged). (A5; §31.) Dev pays Cloudflare
   directly; we meter only agent compute.

**Success state.** Dev runs "a team of five": three improving products on his own keys and
cloud, the grind automated, the code his, every change reviewable as a PR, and takeover
available at any moment ([03](./03-personas-jtbd.md) §3.3).

**Checkpoints in this journey:** per-venture production deploys (9). Takeover (5) is **not** a
checkpoint — it's a first-class user control.

**Failure / branch handling**

- **✗ All provider keys rate-limited.** Circuit breaker opens; the affected tick is
  re-queued with backoff rather than hammering providers; Dev is notified. The other ventures
  are unaffected (per-venture isolation). (F1/§29.)
- **✗ Takeover edits break the build.** On resume, VERIFY fails → the loop runs FIX on *his*
  changes within the cap, or raises a stuck checkpoint with the failing diff — it won't
  silently overwrite his work. (A4; §15.)
- **✗ BYO deploy token rejected/expired.** The adapter surfaces an actionable connection
  error ("reconnect Cloudflare") and pauses only that venture's SHIP; nothing is half-deployed.
  (A5; §18.)
- **✗ Concurrency cap reached.** A fourth venture's ticks queue fairly behind the running
  three instead of overloading providers. (Global concurrency cap, A0.)

---

## 11.4 Journey C — The "fix-itself" cycle

**Persona:** any venture owner; especially Maya's promise *"it keeps improving."*
**Trigger:** a **runtime error** fires in a live, deployed venture (e.g. a null-pointer on the
reminders endpoint).

```
 RUNTIME ERROR ─► SENSE ingests signal ─► ORIENT creates FIX goal ─► loop fixes ─► VERIFY ─► RE-DEPLOY ─► notify user
       │                  │                       │                    │           │           │            │
   (deployed app)        [S]                     [S]                  [S]         [S]         [S]          [S]
```

**Step-by-step (happy path)**

1. **[S]** The tiny error-collector injected into the deployed app posts the stack trace to
   `POST /api/ventures/:id/signals` (rate-limited, owner-scoped). (Sense layer — Epic **A6**.)
2. **[S]** On the next tick, **SENSE** ingests the signal alongside uptime/analytics. (A6;
   loop §4.1.)
3. **[S]** **ORIENT** recognizes the error as higher-value than the next backlog item and
   **creates a new fix Goal** — *within the venture's approved scope*. (A6; scope guard, A0.)
4. **[S]** **DECIDE** gate: is there budget for this fix? Is it in scope? Yes → proceed (no
   checkpoint, because a same-environment fix is neither prod-launch nor money-spend).
5. **[S]** **ACT** dispatches the fix goal to the build loop (`studioFix.ts`); **VERIFY** runs
   build/tests + the safety scan, including a regression check that the failing path now
   passes. (A4/A9.)
6. **[S]** **SHIP** re-deploys. For a **managed** deployment this is automatic. For a **BYO
   production** redeploy, see the checkpoint branch below.
7. **[S]** **REFLECT** logs the whole cycle (signal → fix → redeploy → cost) to
   `venture_events`, then **notifies the user**: *"Fixed a runtime error on /reminders and
   redeployed — here's the diff and cost."* (A6/A8; notifications §16.)

**Success state.** The product self-heals inside the user's guardrails. The user sees a calm,
after-the-fact notification with full context, embodying the North-Star metric *"weekly
shipped, healthy venture-improvements"* ([00](./00-executive-summary.md) §0.8).

**Checkpoints in this journey:** none on the **happy** managed path — autonomous fixes within
budget and scope are exactly what the loop is for.

**Failure / branch handling**

- **◇ Re-deploy is to BYO production.** Per [Master Plan](../00-MASTER-PLAN.md) §8, the
  *first* prod deploy is checkpointed; whether routine prod **redeploys** are auto or gated is
  a per-venture **autonomy-policy** setting. If gated → raise checkpoint type 1, notify, wait.
- **✗ Fix won't converge.** Same error repeats N times → **no-progress detector** stops the
  loop and raises a checkpoint with the trace and attempted diffs, instead of thrashing. (A0.)
- **✗ Fix would exceed budget.** DECIDE blocks; venture pauses on the fix goal and alerts (see
  Journey D). The error stays logged for when budget is restored.
- **✗ Out-of-scope fix.** If the real fix needs work outside the approved scope (e.g. a new
  dependency or schema change), ORIENT raises a **scope checkpoint** rather than silently
  expanding the venture. (Scope guard, A0; checkpoint type 5.)

---

## 11.5 Journey D — Hitting a budget

**Persona:** any owner; the safety net behind Maya's *"never surprised by a bill."*
**Trigger:** cumulative spend on a venture approaches its `usd_total` (or `usd_per_day`) cap.

```
 spend rising ─► 80% ALERT ─► 100% reached ─► VENTURE PAUSES ─► [U] top up / raise cap ─► RESUMES
      │             │              │               │                    │                   │
     [S]           [S]            [S]             [S]                  [U]                 [S]
```

**Step-by-step**

1. **[S]** Every tick's REFLECT step records spend (tokens + container-minutes + managed
   hosting) tagged by `venture_id` via `costEstimator → billingLedger`. The DECIDE gate reads
   the budget **before** spending. (Metering A0/§41; portal A7.)
2. **[S]** At **80% of cap**, the system fires a **spend alert** (in-app + email): *"Habit
   Tracker is at 80% of its $40 budget."* Work continues. (Alerts, Epic **A7**.)
3. **[S]** At **100%**, the DECIDE gate returns `pause-budget`. The venture **pauses
   immediately** — it does not start the next spending action. A hard cap is a hard cap.
   (Budget evaluator `budget.ts`, A0.)
4. **[S]** The Operator Console shows the venture **Paused (budget)**, the spend meter pinned
   at the cap, and a clear call to action. The user is notified.
5. **[U]** The user chooses: **(a)** raise the cap with the budget slider, or **(b)** top up
   credits via Stripe Checkout (reuses `stripe.ts`). (Portal UX §17/§41.)
6. **[S]** The new headroom updates `venture_budgets`; the scheduler picks the venture back up
   on the next pass and resumes exactly where it paused (resumable state, A2).

**Success state.** Spend never exceeds what the user authorized; the trust/safety guardrail
*"zero budget overruns"* ([00](./00-executive-summary.md) §0.8) holds. The user stays in
control of money at all times.

**Checkpoints / failure branches**

- **✗ User does nothing.** The venture simply **stays paused** — the safe default. No work,
  no spend. It waits indefinitely; nothing degrades.
- **✗ Top-up payment fails.** Stripe error surfaces; the venture remains paused; the user is
  prompted to fix payment. No work proceeds on a failed charge. (§41.)
- **✗ Daily cap hit but total has room.** Only `usd_per_day` is exhausted → the venture pauses
  for the day and **auto-resumes** at the next daily window, no user action needed. (A0/A7.)
- **Interaction with checkpoints.** A budget pause is **independent** of approval checkpoints:
  a venture can be paused-for-budget *and* have a pending checkpoint; resolving one does not
  resolve the other.

---

## 11.6 Journey E — A checkpoint (human-in-the-loop on an irreversible)

**Persona:** any owner. **Trigger:** the loop reaches an action the design **always** gates —
a production deploy, spending real money, a destructive op, external publishing, or a scope
change ([Master Plan](../00-MASTER-PLAN.md) §8, the six checkpoint types).

```
 loop reaches gated action ─► DECIDE raises CHECKPOINT ─► notify ─► [U] APPROVE or DENY ─► continue OR re-plan
          │                          │                     │              │                      │
         [S]                        [S]                   [S]            [U]                    [S]
```

**Step-by-step**

1. **[S]** During DECIDE (deterministic, no LLM), the gate detects the chosen action matches a
   checkpoint type. Instead of ACTing, it **enqueues a `venture_checkpoint`** and pauses that
   goal. (`checkpoints.ts`, Epic **A0**.)
2. **[S]** The checkpoint lands in the **approval queue** in the Operator Console and triggers
   a notification (in-app + email). It carries full **context**: what the agent wants to do,
   *why*, the diff/plan, the estimated cost, and the relevant event history. (A8/§16.)
3. **[U]** The user opens the queue and sees one-click **Approve** / **Deny**, plus an
   optional note. Independent goals keep running while this one waits — only the gated work is
   blocked. ([Master Plan](../00-MASTER-PLAN.md) §8.)
4a. **[U → S] Approve.** The checkpoint resolves `approved`; the loop **continues** straight
    into ACT/SHIP for that goal on the next tick. (A0/A2.)
4b. **[U → S] Deny (with reason).** The checkpoint resolves `denied`; ORIENT **re-plans** —
    it drops or reshapes the goal per the user's note instead of retrying the rejected action.
    (Scope/ORIENT, A2/A3.)

**Success state.** Every irreversible action is owned by a human with full context; the metric
*"100% of prod deploys checkpoint-gated"* ([00](./00-executive-summary.md) §0.8) holds, and
the user never feels the platform did something risky behind their back.

**Failure / branch handling**

- **✗ User ignores the checkpoint.** The goal stays paused indefinitely (safe default).
  Reminder notifications can re-nudge; nothing irreversible happens without an explicit yes.
- **✗ Denied with no guidance.** ORIENT deprioritizes the goal and moves to the next
  in-scope, in-budget item rather than looping on the rejected one. (A2.)
- **✗ Checkpoint becomes stale** (context changed since it was raised — e.g. files moved). On
  approval the loop **re-validates** before acting; if the plan no longer applies it re-raises
  a fresh checkpoint instead of acting on outdated intent. (A0/A2.)

---

## 11.7 Journey F — Sam: per-client venture, isolation, delivery & handoff

**Persona:** Sam, agency / small-team lead (P2). **Trigger:** a new client engagement; Sam
must build on the **client's own cloud** and bill cleanly per client.

```
 PER-CLIENT VENTURE ─► CONNECT CLIENT ACCOUNTS ─► PER-VENTURE BUDGET + ISOLATION ─► BUILD ─► DELIVER ─► HANDOFF
        │                     │                            │                         │        │          │
       [U]                   [U]                          [S]                       [S]      [U]        [S]
```

**Step-by-step (happy path)**

1. **[U]** Sam creates a **separate venture per client** (one client = one isolated Venture).
   (A1; multi-tenancy §25.)
2. **[U]** For each, Sam connects the **client's** Cloudflare/Vercel/Supabase/GitHub accounts
   as that venture's `venture_connections` (Nango, per-venture, least-privilege). Client A's
   credentials are **never** visible to Client B's venture. (A5; §30; [Master Plan](../00-MASTER-PLAN.md)
   §5.1.)
3. **[U]** Sam sets a **per-venture budget** so each client's spend is capped and attributable.
   (A0/A7.)
4. **[S]** Each venture runs **strictly isolated**: RLS owner-isolation on every row, a
   per-tenant `VentureDO`, and a dedicated container sandbox `u_<userId>_<projectId>`. No
   cross-tenant reads, ever. (§25; [Master Plan](../00-MASTER-PLAN.md) §5.1–5.2.)
5. **[S]** The loop builds each client's product; metering is tagged per `venture_id`, so Sam
   gets a **clean per-client spend report**. (A7/§41.)
6. **◇ Production-deploy checkpoint.** **[U]** Sam approves; **[S]** the adapter deploys to the
   **client's own account** — the product lives in the client's cloud from day one. (A5.)
7. **[U]** At delivery, Sam exports artifacts and **hands off**: the code is already in the
   client's GitHub, the deploy is in the client's cloud, and the per-venture spend report is
   the invoice basis. (GitHub handoff, `studioGithub.ts`; export, A8.)

**Success state.** Sam ships per-client products fast, on each client's cloud, with strict
isolation, a clean cost report, and a professional handoff ([03](./03-personas-jtbd.md) §3.4) —
without leaking one client's data into another's.

**Checkpoints in this journey:** per-client production deploys (6); any destructive op on a
client resource (type 3).

**Failure / branch handling**

- **✗ Wrong account connected.** Connection metadata shows the account identity before first
  deploy; a mismatch is caught at the connection step, not after a deploy to the wrong cloud.
  (§18.)
- **✗ Isolation must be provable, not assumed.** The A9 tenant-isolation audit (automated
  cross-venture access test + RLS coverage + `get_advisors`) is a **GA gate** — Sam's
  compliance worry is addressed by construction. (Epic **A9**; §25/§35.)
- **✗ Client revokes access mid-build.** The adapter's deploy token fails cleanly; only that
  client's venture pauses its SHIP; Sam is alerted to reconnect. Other clients unaffected.

---

## 11.8 Journey G — Ops: incident → auto-pause → kill switch → diagnose → resume

**Persona:** Ops/Owner (internal P1) — the platform operator. **Trigger:** an **anomaly** —
a spend spike, a runaway loop, or suspicious egress on one or more ventures.

```
 ANOMALY ─► AUTO-PAUSE + ALERT ─► [Ops] KILL SWITCH ─► diagnose via AUDIT LOG ─► remediate ─► RESUME
    │             │                     │                      │                    │           │
   [S]           [S]                   [U]                    [U]                  [U]         [U]
```

**Step-by-step**

1. **[S]** Anomaly/abuse detection (Epic **A9**) flags the pattern — spend velocity above
   baseline, the same tick repeating, or unexpected outbound egress. (§38 observability;
   [Master Plan](../00-MASTER-PLAN.md) §5.5–5.7.)
2. **[S]** The system **auto-pauses** the affected venture(s) and **alerts Ops** (in-app +
   email + on-call). Auto-pause is the conservative default; spend stops immediately. (A9;
   budgets-as-security-control, [Master Plan](../00-MASTER-PLAN.md) §5.6.)
3. **[U]** If the blast radius is unclear, Ops flips the **global kill switch**
   (`VENTURES_KILL=true` via the admin route) — **one flag halts every venture** platform-wide.
   The scheduler checks it every tick and stops cleanly. (Kill switch, Epic **A0**;
   [Master Plan](../00-MASTER-PLAN.md) §5.7.)
4. **[U]** Ops diagnoses via the **append-only `venture_events` audit log**: every decision,
   action, deploy, and dollar is recorded with model + prompt hash, so the offending action is
   fully explainable and the root cause traceable. (Audit, A0; [Master Plan](../00-MASTER-PLAN.md)
   §5.8.)
5. **[U]** Ops remediates: revoke a leaked token, tighten a quota, ban an abusive input, or
   fix a loop bug — following the **incident runbook** (`INCIDENT-RUNBOOK.md`, A9; §50).
6. **[U]** Ops flips the kill switch off and **selectively resumes** healthy ventures; the
   resumable loop picks up exactly where it stopped. (A2 resumability.)

**Success state.** A potential runaway or breach is contained in seconds, diagnosed from a
complete audit trail, remediated by runbook, and resolved with no cross-tenant impact —
satisfying Ops' JTBD *"run an always-on platform without getting burned"*
([03](./03-personas-jtbd.md) §3.6) and the guardrail *"zero cross-tenant incidents"*
([00](./00-executive-summary.md) §0.8).

**Failure / branch handling**

- **✗ Kill switch must be drilled, not trusted.** A9 includes a **kill-switch drill** so the
  control is verified before GA, not discovered broken during an incident. (Epic **A9**.)
- **✗ Audit gap.** If an event is missing context for diagnosis, that's a logging defect →
  filed against A0/§38; the append-only design means events are never silently rewritten.
- **✗ Anomaly is a false positive.** Ops resumes the wrongly-paused venture immediately from
  the console; auto-pause is reversible and costs only a brief delay — the safe trade.

---

## 11.9 Cross-journey traceability summary

| Journey | Primary persona | Surfaces | Key epics | Checkpoints exercised |
|---|---|---|---|---|
| A — First Venture | Maya (P1) | Intake, Console | A0, A2, A3, A4, A5, A8 | Roadmap (6), Prod deploy (1) |
| B — Power user | Dev (P1) | Integrations, Studio, Console | A2, A4, A5, F1 | Per-venture prod deploy (1) |
| C — Fix-itself | any owner | Console | A2, A4, A6, A9 | (none on managed happy path) |
| D — Budget cap | any owner | Console, Billing | A0, A7 | Budget pause (not an approval gate) |
| E — Checkpoint | any owner | Console | A0, A2 | Whichever of the 6 types fired |
| F — Agency | Sam (P2) | Integrations, Console | A0, A1, A5, A7, A9 | Prod deploy (1), Destructive (3) |
| G — Incident | Ops (P1, internal) | Admin, Console | A0, A9, F0 | Auto-pause + global kill switch |

**Common threads across every journey:** (1) the loop is always SENSE→…→REFLECT and always
metered/logged; (2) money and irreversibles are **always** human-gated; (3) failure paths
**pause and ask**, never loop or overspend; (4) isolation is per-venture by construction; (5)
the audit log makes every action explainable after the fact. These five invariants are the
product's trust contract — the experience the rest of Part II (UX §13–§21) must deliver.
