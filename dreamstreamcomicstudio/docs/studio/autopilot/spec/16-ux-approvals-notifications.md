# 16 — UX Spec: Approvals, Checkpoints & Notifications

> Part II · Product Definition · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan](../00-MASTER-PLAN.md) (§8 guardrails & checkpoints, Epic A0) ·
> [Personas](./03-personas-jtbd.md) · [User Journeys](./11-user-journeys.md) (Journey E) ·
> [Information Architecture](./12-information-architecture.md) (§12.5, §12.8)

## 16.1 Scope & the trust contract

This section specifies the UX for the one part of Autopilot that **needs the human**:
checkpoints (human-in-the-loop gates on irreversible actions), the **approval queue** that
presents them, and the **notifications** that pull the user to a decision. Everything else
the loop does autonomously; this is the deliberate friction.

The design obligation is the product's trust contract from
[Journey E](./11-user-journeys.md): *money and irreversibles are always human-gated, with
full context, and the user never feels the platform did something risky behind their back.*
A misattributed or context-starved approval is a trust-destroying error for Maya
([03](./03-personas-jtbd.md) §3.2) and Sam (§3.4). So the bar here is higher than "show a
yes/no dialog": **the user must be able to decide correctly without scrolling, without
opening another tab, and without trusting us blindly.**

The data substrate is `venture_checkpoints` and the append-only `venture_events` audit log,
both shipped by **Epic A0** (the brakes, built before the engine). The *presentation* — the
queue, the cards, the routing, the deep-links — is **Epic A8** (Operator Console). This
split matters: A0 guarantees a checkpoint *can never be skipped* (the deterministic DECIDE
gate raises it regardless of autonomy level); A8 guarantees it is *legible*.

## 16.2 The six checkpoint types

Per [Master Plan](../00-MASTER-PLAN.md) §8, the DECIDE step (deterministic, no LLM) raises a
checkpoint when the chosen action matches one of six types. Each type is reversible-or-not,
costs-or-not, and public-or-not — which drives how urgently it is presented and routed.

| # | Type | Fires when | Default urgency | Presentation emphasis |
|---|---|---|---|---|
| 1 | **First production deploy** | Loop is ready to put the product on a real prod URL / custom domain (first time, or per-redeploy if policy gates it) | High | Live URL preview, what-goes-public, target environment/account |
| 2 | **Spending real money** | Paid provider resource, domain purchase, paid API beyond the free tier of budget | High | Itemized cost, who gets charged (us vs BYO), one-time vs recurring |
| 3 | **Destructive operation** | Deleting a DB / resource / deployment, dropping data, irreversible migration | **Critical** | Exactly what is destroyed, blast radius, "no undo" warning, typed confirm |
| 4 | **External publishing** | Anything putting the product/user's brand in public (publish, send email campaign, post) | High | The artifact/audience, brand surface, reach |
| 5 | **Scope change** | ORIENT proposes work materially outside the approved roadmap scope | Medium | Old scope vs proposed addition, why, downstream effort/cost |
| 6 | **Roadmap approval** | The initial roadmap, before any autonomous work begins (intake → activate) | Medium (blocking) | The full roadmap (epics→features→tasks), editable inline, budget set here |

**Type 6 is special:** it is the on-ramp ([Journey A](./11-user-journeys.md) step 4, Epic
A3), presented as a *reviewable plan* in the intake wizard rather than a queue card — the
user edits/removes goals and sets the budget cap in the same view, then approves to flip the
venture `draft → active`. Types 1–5 are *interruptions* to a running venture and land in the
approval queue. **Type 3 (destructive)** is the only one requiring a typed confirmation
("type the resource name") because it has no undo — every other type is reversible by
denial-before-action or rollback after.

**One gate, many presentations.** Whatever the type, the underlying contract is identical: a
`venture_checkpoint` row with `{type, what, why, cost_estimate, impact, diff_ref,
event_refs, status}`. The card's *layout* adapts (cost-forward for type 2, destruction-
forward for type 3, URL-forward for type 1), but the decision actions never change:
**Approve · Deny · Ask for more.**

## 16.3 The approval queue

The queue lives in the Operator Console as the **Approvals** local tab
([IA §12.5](./12-information-architecture.md)) and as a global cross-venture roll-up on the
Ventures Dashboard. It is promoted above everything when anything is pending — the IA rule
is *anything that demands a human decision outranks anything merely informative.*

```
Ventures › Acme Booking › Operator Console › Approvals
┌────────────────────────────────────────────────────────────────────────────┐
│  APPROVALS  (2 pending · 1 critical)                    [ Quiet hours: off ] │
├────────────────────────────────────────────────────────────────────────────┤
│  ⛔ CRITICAL                                                       raised 3m │
│  Delete staging database `acme_staging`                                       │
│  …                                                            [ Review → ]   │
├────────────────────────────────────────────────────────────────────────────┤
│  ⚠ Deploy "Acme Booking" to production (your Cloudflare)          raised 8m │
│  Est. cost $0 (your account) · 14 files · first prod deploy   [ Review → ]   │
├────────────────────────────────────────────────────────────────────────────┤
│  Resolved today:  ✔ Approved 2  ·  ✕ Denied 1  ·  ⏱ expired 0  [ History → ] │
└────────────────────────────────────────────────────────────────────────────┘
```

Queue rules:

- **Ordering:** by urgency (critical → high → medium), then by age (oldest first), so a
  destructive op never sits below a scope tweak.
- **Independence:** a pending checkpoint blocks only its own goal. Other goals keep running
  ([Master Plan](../00-MASTER-PLAN.md) §8); the queue makes clear the venture is *partially*
  paused, not stopped.
- **No bulk approve.** Each checkpoint is decided individually — approving five irreversibles
  in one click is exactly the unaccountable behavior we forbid. (Bulk *dismiss/snooze* of
  notifications is fine; bulk *approve* is not.)
- **Global roll-up.** The Dashboard shows `⚠ 3 approvals across 2 ventures`, each a
  deep-link into the right venture's queue and card.

### Checkpoint approval card — anatomy & wireframe

The card is the whole decision surface. Its design principle: **what / why / cost / impact /
diff, all above the fold, so the user decides without scrolling.** Order is fixed so the eye
learns it.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ⚠  DEPLOY TO PRODUCTION                            Checkpoint #1 · raised 8m  │
│      Type: first-production-deploy · Acme Booking                              │
├──────────────────────────────────────────────────────────────────────────────┤
│  WHAT   Deploy version v23 of "Acme Booking" to production at                  │
│         https://acme-booking.pages.dev  (your connected Cloudflare account)    │
│                                                                                │
│  WHY    Roadmap goal "Launch booking MVP" passed VERIFY: build green,          │
│         12/12 tests pass, safety scan clean. This is the first time this        │
│         venture goes to a public production URL.                               │
│                                                                                │
│  COST   $0.00 to you — deploys to YOUR Cloudflare account (you pay Cloudflare  │
│         directly). Agent compute for this goal: $0.74 (already spent).         │
│         Recurring: none.                                                       │
│                                                                                │
│  IMPACT • Public, internet-reachable URL with your brand                       │
│         • Reversible: rollback available (one click) after deploy             │
│         • Target: cloudflare-pages · account acme-prod · least-priv token     │
│                                                                                │
│  DIFF   14 files changed (+612 / −38)              [ View full diff ▸ ]        │
│         + src/routes/book.tsx        + src/api/reminders.ts                    │
│         ~ src/App.tsx               ~ wrangler.jsonc                           │
│                                                                                │
│  TRAIL  drafted goal 2h · built 41m · fixed 1 test 22m · verified 9m   [ ▸ ]  │
├──────────────────────────────────────────────────────────────────────────────┤
│   [ ✓ Approve & deploy ]     [ ✕ Deny ]     [ 💬 Ask for more / give guidance ]│
│   Approving acts on the next tick. Denying re-plans this goal.                 │
└──────────────────────────────────────────────────────────────────────────────┘
```

| Slot | Content | Source |
|---|---|---|
| **What** | The concrete action in one plain sentence (no jargon) | `checkpoint.what` |
| **Why** | The agent's rationale + the VERIFY evidence that earned the gate | `checkpoint.why` + `venture_events` |
| **Cost** | Itemized: to-you vs agent, one-time vs recurring, who is charged | `cost_estimate` + budget context (A0/A7) |
| **Impact** | Reversibility, blast radius, target environment/account | `checkpoint.impact` |
| **Diff** | File list + counts inline; full diff one click away (not auto-expanded) | `diff_ref` → `studio_versions` |
| **Trail** | Compact event timeline for *this* goal, expandable to the audit log | `event_refs` → `venture_events` |
| **Actions** | Approve · Deny · Ask-for-more, with the consequence stated inline | resolves `checkpoint.status` |

The three actions:

- **Approve** → `status = approved`; the loop continues into ACT/SHIP for that goal on the
  next tick. The card shows a brief "approved by you, 09:14" stamp and moves to history.
- **Deny** (note optional but prompted) → `status = denied`; ORIENT **re-plans** — drops or
  reshapes the goal per the note rather than retrying the rejected action
  ([Journey E](./11-user-journeys.md) 4b). Denial never silently re-raises the same gate.
- **Ask for more / give guidance** → does *not* resolve the checkpoint. It posts a question
  back to the venture (an event the loop reads next tick) and keeps the goal paused. The
  agent answers in the activity stream; the card updates with the reply so the user can then
  Approve/Deny with more confidence. This is the pressure valve that prevents a forced
  yes/no on incomplete information.

**Staleness guard.** If context changed since the checkpoint was raised (files moved, a
later tick edited the venture), Approve triggers a **re-validation** before acting; if the
plan no longer applies, the loop re-raises a *fresh* checkpoint instead of acting on stale
intent ([Journey E](./11-user-journeys.md), staleness branch; A0/A2). The card shows
"context changed — re-checking" rather than acting blindly.

## 16.4 Notification channels

A checkpoint that nobody sees is a venture stuck forever. Notifications pull the user to the
queue. Three channels, layered by reach and intrusiveness.

| Channel | Mechanism (reuse) | Best for | Honest limits |
|---|---|---|---|
| **In-app** | SSE `/api/ventures/:id/stream` → toast + badge + queue (A8) | The active operator at their desk | Only works while a session is open |
| **Email** | Transactional email; the **Gmail tool** path for owner-relevant sends, Stripe-style template for billing/checkpoint mail | The user who's away; durable, deep-linkable | Latency; spam-filter risk; not real-time |
| **Push** (optional) | Web Push / mobile push; opt-in | Mobile monitor-and-decide ([IA §12.6](./12-information-architecture.md)) | Requires permission grant + a registered device |

**Channel content parity.** Every channel carries the same essentials: venture name, the
one-line *what*, the *cost/impact* headline, the urgency, and a **deep-link** to the exact
card (§16.6). Email additionally embeds the cost + diff summary so the user can often decide
from the inbox preview; the link still lands them on the full card to actually act (we never
let an email button approve without re-auth on the destination).

In-app is always on. Email and push routing follow the rules below.

## 16.5 Routing, escalation, quiet hours & batching

### Routing by urgency

| Urgency | In-app | Email | Push | Re-nudge |
|---|---|---|---|---|
| **Critical** (type 3 destructive; budget-driven hard pause; anomaly auto-pause) | immediate | immediate | immediate | every 4h until actioned, bypasses quiet hours |
| **High** (types 1, 2, 4) | immediate | immediate | if enabled | once at +24h, then daily; respects quiet hours |
| **Medium** (type 5; roadmap reminders) | immediate | batched (next digest) | optional | in daily digest |
| **Informational** (deploy-succeeded, fix shipped, 80% budget alert) | immediate | batched | suppressed by default | none — it's an FYI |

### Escalation

If a checkpoint is unactioned past its urgency window, it **re-nudges**, not escalates to
someone else (single-owner ventures in v1; team roles are later, [03](./03-personas-jtbd.md)
§3.4). The escalation is *frequency + channel breadth*, not *recipient*: a critical
checkpoint that's ignored adds push + repeats; it never auto-approves and never reassigns.
For the internal **Ops** persona ([Journey G](./11-user-journeys.md)), anomaly auto-pause
escalates to the on-call path in addition to in-app/email.

### Quiet hours

Per-user quiet-hours window (e.g. 22:00–08:00, user timezone). During quiet hours:

- **Critical** checkpoints **still notify on every channel** — a destructive op or runaway
  pause is exactly what should wake you. This is a deliberate, stated exception.
- **High/Medium/Informational** are **held and batched** into the next digest after the
  window closes. Nothing is lost; the queue still shows them in-app.
- The user can set "managed previews never notify" and similar granular mutes — but
  money/destruction/publishing mutes are **disallowed** (you can't silence the gates that
  protect you, only the FYIs).

### Batching

A **digest** collapses non-critical notifications to avoid alert fatigue (Dev runs many
ventures — [03](./03-personas-jtbd.md) §3.3 — and must not drown):

```
Subject: Autopilot — 1 approval + 3 updates across 2 ventures

  ⚠ 1 NEEDS YOU
    • Acme Booking — approve scope change: add Stripe checkout  [ Review → ]
  ✔ 3 updates
    • Acme Booking  — shipped "weekly streak report" to preview
    • Habit Tracker — fixed runtime error on /reminders, redeployed
    • Habit Tracker — at 80% of $40 budget
```

Digest cadence is user-set (off / hourly / daily). Critical items are **never** batched —
they always fire standalone, immediately.

## 16.6 Deep-links from a notification

Every notification is a working deep-link to the thing it is about — the IA invariant
([§12.8](./12-information-architecture.md)): *we never drop the user on a generic dashboard
and make them hunt.*

Canonical shape: `/ventures/:id/console/approvals?checkpoint=:checkpointId`
(`?view=console&v=:id&tab=approvals&cp=:checkpointId` in the shipped scheme).

Resolution order (from [§12.8](./12-information-architecture.md)):

1. **Auth gate** — if logged out, route through sign-in preserving the full target, then
   continue. Approving always happens on an authenticated session, never from the email
   button alone.
2. **Resolve venture** `v=:id` → hydrate the `VentureDO`; gone/forbidden → Dashboard with a
   clear notice, never a blank console.
3. **Open Console → Approvals tab.**
4. **Focus the checkpoint** (`cp=:checkpointId`): scroll to + auto-expand that card; if
   already actioned, show its resolved state ("approved by you, 09:14") instead of a 404.
5. **Set the context stack** so breadcrumbs + venture switcher show the right venture and a
   **refresh stays put.**

Notification-type → target mapping (each carries `v=:id` + an entity id):

| Notification type | Entity | Lands on |
|---|---|---|
| `deploy-checkpoint`, `spend-checkpoint`, `destructive-checkpoint`, `publish-checkpoint`, `scope-checkpoint` | `cp=` | Approvals tab, that card |
| `stuck/blocked` (no-progress) | `cp=` | Approvals tab, the stuck-goal checkpoint |
| `budget-threshold` (80%/100%) | venture | Budget tab / meter |
| `deploy-succeeded`, `fix-shipped` | `deploy=` / `run=` | Activity stream, that entry |
| `roadmap-ready` | venture | Intake review (roadmap approval, type 6) |

## 16.7 Deny vs approve vs timeout/expire

| Outcome | Trigger | Loop behavior | Audit |
|---|---|---|---|
| **Approve** | User clicks Approve (+ re-validation passes) | Goal continues into ACT/SHIP next tick | `approved` event + actor + timestamp |
| **Deny** | User clicks Deny (+ optional note) | ORIENT re-plans: drops/reshapes the goal per the note; deprioritizes if no note ([Journey E](./11-user-journeys.md) 4b) | `denied` event + reason |
| **Ask-for-more** | User requests info | Checkpoint stays open; agent posts an answer; user decides after | `info_requested` + `info_provided` events |
| **Timeout / unactioned** | No decision (default) | **Goal stays paused indefinitely — the safe default.** No work, no spend. Re-nudges per §16.5; *never* auto-approves | nothing irreversible logged |
| **Expire (optional)** | Context invalidated, or a per-venture TTL elapses | Checkpoint marked `expired`; the *underlying decision is re-derived* — if still wanted, a **fresh** checkpoint is raised; if no longer relevant, the goal is dropped | `expired` event + cause |

The cardinal rule: **the safe default of inaction is "wait," never "proceed."** Expiry never
converts a pending irreversible into an action — it can only *retire a stale gate* and, if
the work is still wanted, re-raise a current one. This is the difference between "the user
didn't answer so we did nothing" (correct) and "we assumed yes" (forbidden).

## 16.8 Audit trail of decisions

Every checkpoint and every decision is recorded in the **append-only `venture_events`** log
(Epic A0) — the source of truth for "what did my agent do, and who approved it?"

Each decision event records: `checkpoint_id`, `type`, `decision` (approved/denied/
info-requested/expired), `actor` (user id; "system" only for expiry), `timestamp`, the
`reason/note`, the `cost_estimate` shown at decision time, and a reference to the diff/plan
the user saw. Because the log is append-only, a decision is **never silently rewritten** — a
later change is a new event, preserving the full history.

This makes every irreversible action **explainable after the fact** (the
[Journey G](./11-user-journeys.md) diagnosis path: Ops reads the trail to find the offending
action with model + prompt hash) and **defensible** for Sam's clients (who approved the prod
deploy, when, seeing what cost). The Console exposes it as a per-venture **Decisions /
Audit** view (filterable by type + outcome) and as the per-card **Trail** (§16.3).

## 16.9 Mobile & accessibility

**Mobile** ([IA §12.6](./12-information-architecture.md)) reframes the job from *operating*
to *monitoring + deciding*. The Approvals tab is in the bottom thumb-bar with a count badge;
a pending checkpoint is promoted to the sticky header (`⚠ 1 approval needs you [→]`). The
card is single-column, with What/Why/Cost/Impact above the fold and the diff collapsed
behind a tap (editing is desktop-only; mobile shows read-only diffs/preview links).
Destructive (type 3) keeps its typed confirm even on mobile. Push deep-links straight to the
card. Quiet hours and digests reduce phone noise to what actually needs a human.

**Accessibility** (the spec defers full detail to [20 — Accessibility](./12-information-architecture.md)
once written; the commitments here):

- **Never color-only.** Urgency is icon + text + color (`⛔ CRITICAL`, `⚠`), not hue alone —
  a destructive op is unmistakable to a color-blind user.
- **Pending checkpoints are an ARIA live region** so screen readers announce a new approval;
  the badge has an accessible label ("2 approvals pending, 1 critical").
- **Keyboard-complete:** the queue and card are fully operable without a pointer; Approve/
  Deny are buttons in a logical tab order with the consequence in the accessible name
  ("Approve and deploy to production"). Destructive confirm is a focus-trapped dialog.
- **Targets & contrast** meet WCAG AA (44px touch targets on mobile; AA contrast on all
  urgency states); no information is conveyed by motion alone.

## 16.10 Which epic delivers what

| Capability | Epic | Notes |
|---|---|---|
| Checkpoint data model, lifecycle, the 6 types, raise/resolve | **A0** | `venture_checkpoints`, `checkpoints.ts`; DECIDE gate enforces them |
| Append-only decision audit | **A0** | `venture_events`, `events.ts` |
| Budget-threshold / pause notifications | **A0** (caps) + **A7** (alerts) | 80%/100% alerts, in-app + email |
| Roadmap approval (type 6) presentation | **A3** | Intake wizard; `approve-roadmap` route |
| Approval queue UI, the card, Approve/Deny/Ask-for-more | **A8** | Operator Console Approvals tab |
| Live in-app notifications (SSE toasts + badges) | **A8** | over `/api/ventures/:id/stream` |
| Email (Gmail tool / transactional) + push + routing/quiet-hours/digest | **A8** | reuses notification plumbing; push is opt-in |
| Deep-link resolution to the exact card | **A8** | per [IA §12.8](./12-information-architecture.md) |
| Anomaly auto-pause → critical escalation | **A9** | Ops path ([Journey G](./11-user-journeys.md)) |

## 16.11 Acceptance criteria

- All six checkpoint types render with What/Why/Cost/Impact/Diff/Trail above the fold;
  type 3 (destructive) requires a typed confirm; type 6 is the intake roadmap review.
- Approve continues the goal (after re-validation); Deny re-plans; Ask-for-more keeps the
  gate open and returns an agent answer — none of these is skippable or bulk-approvable.
- A pending checkpoint blocks only its own goal; other goals keep running; the queue shows
  partial-pause clearly.
- Notifications reach in-app + email (+ push if enabled); critical bypasses quiet hours;
  non-critical batches into the digest; money/destruction/publishing gates can't be muted.
- Every notification deep-links to the exact card, through auth, refresh-safe; an
  already-actioned link shows the resolved state, never a 404.
- Unactioned checkpoints stay paused indefinitely (never auto-approve); expiry only retires
  a stale gate and re-raises a fresh one if still wanted.
- Every decision is in the append-only audit with actor, timestamp, reason, and the
  cost/diff shown at decision time.
- The card is keyboard-complete, screen-reader-announced (live region), never color-only,
  and meets WCAG AA on desktop and mobile.
