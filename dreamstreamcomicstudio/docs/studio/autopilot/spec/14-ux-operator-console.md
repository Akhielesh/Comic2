# 14 — UX Spec: Operator Console (24/7 Workspace)

> Part II · Product Definition · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Executive Summary](./00-executive-summary.md) (§0.4 surfaces) ·
> [Personas](./03-personas-jtbd.md) · [Information Architecture](./12-information-architecture.md) ·
> [Domain Model](./09-domain-model-glossary.md) · [Master Plan](../00-MASTER-PLAN.md) (A8 console, §4 loop, §8 checkpoints).

## 14.1 What this surface is (and the honest constraint)

The **Operator Console** is the 24/7 cockpit: the one screen where a user watches their agents
work, decides the things only a human can decide, and steers or stops the whole thing. It is the
product's **daily-use surface** — [§12.5](./12-information-architecture.md) already fixed its
information priority; this section specifies the widgets in detail. It is **venture-scoped**
(`?view=console&v=:id` / `/ventures/:id/console`) and never global: you operate one venture at a
time, with the venture switcher to swap.

The console is **delivered by Epic A8**, but it is a *window onto* state owned by earlier epics —
it builds almost nothing of its own logic. Each widget reads one set of entities ([§9.3](./09-domain-model-glossary.md))
and writes through the control plane (A1):

| Widget | Reads (entity) | Writes / acts via | Backend epic |
|---|---|---|---|
| Activity stream | `venture_events` (Tick spans) | — (read-only) | A2 (events), A8 (UI) |
| Roadmap / backlog board | `venture_goals` | reprioritize/edit goals (A1 routes) | A2/A4 (goal state), A8 |
| Approval queue | `venture_checkpoints` (`open`) | approve/deny (A1) | A0 (checkpoints), A8 |
| Budget meter | `venture_budgets` + ledger | edit caps → A7 portal | A0/A7, A8 |
| Deployments | `studio_deployments` (+`venture_id`) | rollback (A5 adapter) | A5, A8 |
| Logs / runs / audit | `venture_runs`, `venture_events` | — (read-only) | A2, A8 |
| Status + controls | `ventures.status` | pause/resume/redirect/kill (A1 + kill switch A0) | A0/A1, A8 |
| Venture list/dashboard | `ventures` (all) | open/create | A1, A8 |

The honest framing: **A8 is mostly presentation and real-time plumbing over governance state that
already exists.** If A0–A7 are right, the console is the easy part; if they are wrong, no UI saves
it. The console's job is to make the existing state *legible and actionable* — for Maya without
jargon, for Dev without hiding the trace.

## 14.2 Overall layout (desktop)

A three-region cockpit. The **left** is the local nav register (the console's own tab strip,
[§12.4](./12-information-architecture.md) "within-Console nav"). The **center** is the active tab
(Activity by default). The **right rail** holds the three always-present, never-buried elements:
**status + controls**, the **budget meter**, and the **approval badge** — they persist across every
tab, because risk and human-decision elements outrank anything informative ([§12.5](./12-information-architecture.md)).

```
┌─ Ventures › Acme Booking ▾ › Operator Console › Activity ──────────────────────────────────┐
│ ┌──────────────┐ ┌──────────────────────────────────────────────┐ ┌──────────────────────┐ │
│ │  CONSOLE NAV │ │  ACTIVITY  (live)              ● connected     │ │  STATUS              │ │
│ │              │ │ ──────────────────────────────────────────────│ │  ● Building          │ │
│ │ ▸ Activity ● │ │ 14:22  ⚙ SHIP   deployed preview → acme-…dev   │ │  goal: "email auth"  │ │
│ │   Approvals 1│ │ 14:21  ✓ VERIFY tests pass (42) · build 11s    │ │  run #7 · tick 31    │ │
│ │   Roadmap    │ │ 14:19  ◆ ACT    wrote 6 files (+182 −9)        │ │  [⏸ Pause] [⤳ Redir] │ │
│ │   Budget     │ │ 14:18  ◇ DECIDE in budget, in scope → proceed  │ │  [■ Kill]            │ │
│ │   Deploys    │ │ 14:17  ◷ ORIENT next goal: "email auth" (LLM)  │ ├──────────────────────┤ │
│ │   Logs       │ │ 14:17  ⊙ SENSE  3 open goals · last deploy OK  │ │  BUDGET              │ │
│ │              │ │ ─────────────────── 14:10 · tick 30 ───────────│ │  $4.10 / $25.00      │ │
│ │              │ │ 14:08  ⚠ CHECKPT raised: deploy to PRODUCTION  │ │  ▓▓▓▓░░░░░░  16%      │ │
│ │              │ │        [Review →]                              │ │  burn ~$0.28/hr      │ │
│ │  ⌂ Overview  │ │ 14:02  ✓ SHIP   deployed preview               │ │  ~3.1d left at rate  │ │
│ │  ‹ Ventures  │ │                                    [load more] │ ├──────────────────────┤ │
│ └──────────────┘ └──────────────────────────────────────────────┘ │  ⚠ 1 APPROVAL        │ │
│                                                                     │  Deploy to prod [→]  │ │
│                                                                     └──────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

Breadcrumbs ([§12.4](./12-information-architecture.md)) sit above; the venture crumb is the
switcher. The right rail collapses into a top summary bar below ~1100px, then folds into mobile's
sticky header + bottom tabs ([§14.12](#1412-mobile-monitoring-first)). Visual language reuses the
studio's Linear/dark design system (`components/ui/*`, the kit's `Surface`, `cn`); status colors
follow `SwarmTraceCard.tsx` banding (emerald = good, amber = thin/warning, red/`brand-red` = error).

## 14.3 Live activity stream

**Purpose.** The one-glance answer to *"what is my agent doing right now, and is it OK?"* The
primary widget; the console opens here. It is the human-readable projection of `venture_events`
([§9.3](./09-domain-model-glossary.md)) — every SENSE/ORIENT/DECIDE/ACT/VERIFY/SHIP/REFLECT phase,
plus checkpoint/budget/error events, grouped by **Tick** (a correlated event span,
[§9.3](./09-domain-model-glossary.md)).

**Reuse.** This is `ActivityFeed.tsx` + `SwarmTraceCard.tsx` patterns at venture altitude:
- From **ActivityFeed**: phase rows as muted steps; spinner-while-active → checkmark-when-done; a
  collapsing summary line per Tick so a multi-day history doesn't bury the latest; auto-scroll to
  newest while live (`detailRef.scrollTop = scrollHeight`); diff markers (`+182 −9`) reused verbatim.
- From **SwarmTraceCard**: when ACT dispatches the swarm (A4), the ACT row **expands** to the same
  agent-swarm card (per-agent status icon, verifier confidence chip, tool-event chips). The console
  doesn't reinvent that card — it embeds it as the detail of an ACT event.

**Event types shown** (mapped from `venture_events.kind`):

| Glyph | Kind | One-line meaning | Expand reveals |
|---|---|---|---|
| ⊙ | `sense` | what signals it gathered | open goals, deploy health, new errors/feedback (A6) |
| ◷ | `orient` | the LLM picked the next goal | rationale, model used, cost |
| ◇ | `decide` | the deterministic gate's verdict | budget OK?, in-scope?, checkpoint needed? |
| ◆ | `act` | it built/changed code | the **swarm card**; files (+/−), `studio_version` link |
| ✓/⚠ | `verify` | tests/build/safety result | test count, build time, safety-scan findings |
| ⚙ | `ship` | it deployed | target, URL, managed vs prod |
| ✎ | `reflect` | learnings + goal updates | what advanced, learnings recorded |
| ⚠ | `checkpoint` | it paused for you | the decision + a `[Review →]` deep-link to Approvals |
| $ | `budget` | spend event / threshold | amount, running total vs cap |
| ✕ | `error` | something failed | the error, the no-progress count |

Each Tick renders as a collapsible group headed `14:10 · tick 30` with a one-line outcome; expanding
shows its phase rows. Errors and checkpoints **never auto-collapse** (mirroring ActivityFeed keeping
failures open).

**States.**
- *Empty* (loop never started): "Nothing yet — press **Start building** to begin." One forward
  action ([§12.7](./12-information-architecture.md)), not a wall of disabled controls.
- *Loading* (history fetch): skeleton phase rows; the live socket connects in parallel.
- *Error* (stream/fetch failed): an inline banner "Live updates paused — reconnecting…" with the
  last-known history still shown; a manual **Refresh**. We degrade to the last good state, never blank.
- *Live*: `● connected` pill (green); new events animate in (`animate-fade-in`); on disconnect the
  pill goes amber `● reconnecting` and we fall back to polling (§14.11).

**Interactions.** Filter by phase (chips: All · Build · Deploy · Decisions · Errors); jump to the
`studio_version` or deployment an event produced; click a checkpoint event → Approvals tab focused on
that checkpoint; infinite-scroll older Ticks (`[load more]`, paged from `venture_events`); copy a
single event's payload (Dev's "let me inspect it" JTBD, [§3.3](./03-personas-jtbd.md)).

## 14.4 Roadmap / backlog board

**Purpose.** The "what's been done / what's next" context — consulted, not monitored
([§12.5](./12-information-architecture.md)). A column board of **Goals** by status, so the user can
see the plan and reprioritize it.

**Data shown.** Columns mirror the Goal state machine ([§9.4](./09-domain-model-glossary.md)):
**Proposed · Queued · In progress · Verifying · Shipped · Blocked/Failed**. Each goal card shows:
title, `kind` badge (epic/feature/task/fix/chore), priority, a dependency hint (`waits on 2`), and —
for active cards — a live phase pill that tracks the activity stream. Epics group their child goals
(the `parent_goal_id` tree).

```
 PROPOSED        QUEUED          IN PROGRESS      VERIFYING        SHIPPED
┌────────────┐ ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
│ ▦ feature  │ │ ▦ feature  │  │ ◆ feature  │  │ ✓ feature  │  │ ✓ feature  │
│ Stripe     │ │ Email auth │  │ Email auth │  │ Landing v2 │  │ Landing v1 │
│ checkout   │ │ ⠿ drag     │  │ ●building  │  │ tests…     │  │ live ↗     │
│ waits on 1 │ │ P1         │  │ run#7 t31  │  │            │  │            │
└────────────┘ └────────────┘  └────────────┘  └────────────┘  └────────────┘
                                                  BLOCKED: ⚠ Stripe — needs spend approval [Review →]
```

**States.** *Empty before intake*: "Approve a roadmap to populate the backlog" → routes to intake
([§12.7](./12-information-architecture.md)). *Loading*: column skeletons. *Error*: per-column retry,
board stays readable from cache. *Live*: cards move columns in real time as the loop advances goals
(same socket as the activity stream).

**Interactions — drag to reprioritize.** Dragging a card within **Queued** reorders priority
(writes `venture_goals.priority` via A1). Dragging **Proposed → Queued** prioritizes a goal for the
loop; **Queued → Proposed** defers it. Honest constraint: you **cannot** drag a card into *Shipped*
or *Verifying* — those are loop-owned, machine-driven transitions; user drag is limited to the
human-owned edges (prioritize/defer/drop). This keeps the UI from implying control the user doesn't
have. Other interactions: edit a goal's title/scope (a scope change to an out-of-bounds goal raises a
**scope checkpoint**, [§8](../00-MASTER-PLAN.md)); add a goal; click a card → its activity + the
`studio_version`/deploy it produced. **Redirect** (a steer mid-loop, [§3.3](./03-personas-jtbd.md))
is a board action: pin a goal as "do this next," which the loop honors at the next DECIDE.

## 14.5 Approval / checkpoint queue

**Purpose.** The *only* widget that **needs the human** — so it is promoted above everything when
non-empty ([§12.5](./12-information-architecture.md)), badged in the nav, and mirrored in the right
rail and (mobile) the bottom bar. It is the set of `venture_checkpoints` in the `open` state
([§9.3](./09-domain-model-glossary.md)) — the six types from [Master Plan §8](../00-MASTER-PLAN.md):
first production deploy, spending money, destructive op, external publish, scope change, roadmap
approval.

**Data shown per checkpoint** (the `context` payload renders the decision in full):

```
┌─ ⚠ Approve: Deploy to PRODUCTION ──────────────────────────────────────────┐
│ Why now   The "email auth" goal passed all checks and is preview-healthy.   │
│ Target    Cloudflare Pages → acme-booking.com   (your connected account)    │
│ Changes   6 files · +182 −9   ·  view diff ↗   ·  preview ↗                 │
│ Safety    ✓ secret scan clean · ✓ dependency audit · ✓ 42 tests             │
│ Cost      est. $0.00 deploy (your CF account)   ·  blocks goal until decided │
│ Expires   in 23h  (TTL)                                                      │
│            [ ✓ Approve & deploy ]   [ ✕ Deny ]   [ Ask a question ]         │
└─────────────────────────────────────────────────────────────────────────────┘
```

Every checkpoint carries: a plain-language **why**, the exact **action**, **changes** (diff/preview
links), **safety** results (VERIFY + A9 scan), **cost** impact (managed vs BYO — no surprise, per
Maya, [§3.2](./03-personas-jtbd.md)), **what it blocks**, and the **TTL** (`expires_at`).

**States.** *Empty*: "No approvals needed — you're all caught up." (A calm zero state matters; an
always-anxious queue erodes trust.) *Loading*: card skeletons. *Live*: a new checkpoint slides in,
the nav badge increments, and a notification fires ([§16](./16-ux-approvals-notifications.md)).
*Resolved-while-open* (e.g. you approved it on another device): the card transitions in place to
"approved by you, 14:24" rather than vanishing or erroring — the multi-device guarantee from
`UserCoordinatorDO` ([§14.11](#1411-real-time-architecture)) and the deep-link contract
([§12.8](./12-information-architecture.md)).

**Interactions.** One-click **Approve**/**Deny** (the resolution writes a `venture_checkpoint`
transition → unblocks the Goal/Run, [§9.4](./09-domain-model-glossary.md), and records an Event).
**Ask a question** opens a note that the loop incorporates at the next ORIENT (Dev's steer). Deny
requires a one-tap reason (so the loop doesn't immediately re-raise the same gate). Destructive and
prod checkpoints use a **confirm step** (type-to-confirm for destructive) — irreversibles get extra
friction by design ([§8](../00-MASTER-PLAN.md)). Approvals deep-link from notifications straight to
the focused checkpoint ([§12.8](./12-information-architecture.md)).

## 14.6 Budget / spend meter

**Purpose.** The trust guardrail — Maya's "never surprised by a bill" ([§3.2](./03-personas-jtbd.md)).
Always visible in the right rail, on every tab. Reads `venture_budgets` caps + the live ledger spend.

**Data shown.** Spent vs cap as a bar (`$4.10 / $25.00`, 16%), today's spend vs `usd_per_day`,
**burn rate** (recent $/hr), and a derived **runway** ("~3.1d left at this rate"). Breakdown on
expand: tokens (LLM), container-minutes (compute), managed-hosting cost — the three metered inputs
([§7](../00-MASTER-PLAN.md)), each tagged by `venture_id` via the existing ledger. Honest split:
**managed** hosting shows our cost we front; **BYO** shows "$0 to us — paid to your provider"
([§7](../00-MASTER-PLAN.md)), so the bar never implies we're charging for the user's own cloud.

**States.** *No budget set*: a soft-block prompt "Set a cap before the first paid action" with the
platform default offered ([§12.7](./12-information-architecture.md)) — the loop will not spend until
a cap exists. *Healthy* (<80%): neutral bar. *Warning* (≥80%): amber bar + an inline alert; a
notification fires ([A7](../00-MASTER-PLAN.md)). *Breached* (100%): red bar, the venture is
**paused** with reason `budget` ([§9.4](./09-domain-model-glossary.md)), and the resume path is
**Top up / raise cap** (A7 portal) — pausing is the brake, the meter is just its face. *Loading*:
the bar shows last-known with a subtle refresh. The DECIDE gate enforces the cap server-side
*before* spend ([§9.3](./09-domain-model-glossary.md)); the meter only **reports** — it is never the
enforcement point, so a stale UI can't cause an overspend.

**Interactions.** Click → the per-venture Budget surface ([§12.2](./12-information-architecture.md),
`?view=budget&v=:id`) to adjust `usd_per_day` / `usd_total` / token / minute caps (A7). Inline
top-up via Stripe Checkout (reuses `stripe.ts`). Raising a cap that is the active pause cause
auto-resumes the venture once the cause clears ([§9.4](./09-domain-model-glossary.md)).

## 14.7 Deployments panel

**Purpose.** "What is live, where, since when" — and the ability to roll back. Reads
`studio_deployments` (extended with `venture_id`/`goal_id`/`is_production`,
[§9.3](./09-domain-model-glossary.md)); acts through the A5 deploy adapters.

**Data shown.** A list with the **current live** deploy pinned on top, then history:

```
 LIVE   ↗ acme-booking.com         prod · Cloudflare Pages · v18 · 14:22 · ✓ healthy   [Rollback]
        ↗ acme-…dev.dreamstream…   preview · managed · v18 · 14:22 · ✓                  [Promote→prod]
 ────
        ↗ acme-…dev …              preview · managed · v17 · 14:02 · superseded
        ⚙ building…                preview · managed · v19 · now    · ▓▓░ (live row)
        ✕ failed                   preview · managed · v16 · 13:40 · build error  [logs]
```

Per row: target + URL (clickable), environment (preview/prod), `studio_version`, adapter/provider,
timestamp, and **status** mapped to the Deployment state machine ([§9.4](./09-domain-model-glossary.md)):
`queued → building → live`, or `failed`, or `rolledback`/`superseded`. Health (from A6's uptime
check) shows as a ✓/⚠ on live rows.

**States.** *Empty*: "Not deployed yet — managed previews go live automatically once it builds."
*No connection for prod*: an inline prompt "Connect your Cloudflare/Vercel account to ship to your
own domain" → Integrations (Nango) ([§12.7](./12-information-architecture.md)); managed preview
still works meanwhile. *Building*: a live progress row. *Error*: the failed row links to build logs.
*Live*: real-time status as adapters report back.

**Interactions.** Open any URL; **Promote preview → prod** (raises the *first-production-deploy*
checkpoint, [§8](../00-MASTER-PLAN.md) — preview is automatic, prod is always gated);
**Rollback** a live prod deploy (calls the adapter's optional `rollback()`,
[§9.3](./09-domain-model-glossary.md); disabled with a tooltip if the adapter doesn't support it —
honest about capability). Rollback of a prod deploy is itself a confirm-gated action. View the
deploy's logs (§14.8) or the `studio_version` it shipped.

## 14.8 Logs view

**Purpose.** On-demand depth for Dev/Sam — tertiary by design ([§12.5](./12-information-architecture.md)),
reachable but not foregrounded. Three log sources behind a segmented control:
**Build/run logs** (from the `studio-worker/` sandbox), **Deploy logs** (adapter output, A5), and the
**raw event/audit trail** (`venture_events`, the same data the activity stream humanizes — here shown
unredacted with `model`, `prompt_hash`, `cost_usd` for audit/debug).

**Data shown.** A virtualized, timestamped log stream scoped to a Run, a Tick, or a deployment;
mono-font; severity coloring (info/warn/error) following the SwarmTrace banding. The audit view is
explicitly the append-only source of truth ([§9.3](./09-domain-model-glossary.md)) — read-only,
exportable (Sam's handoff JTBD, [§3.4](./03-personas-jtbd.md)).

**States.** *Empty* (no run yet): "Logs appear once a run starts." *Loading*: streaming skeleton.
*Live* (a run is active): tail-follow with an auto-scroll toggle. *Error*: "Log source unavailable"
with retry; never blocks the rest of the console.

**Interactions.** Scope picker (Run / Tick / Deploy); search/filter; severity filter; copy line;
export (JSON/text); a deep-link from any activity event or deployment lands here pre-scoped. Secrets
are masked even in raw logs ([§5](../00-MASTER-PLAN.md): "tokens never logged") — the audit view
proves *what* happened without exposing credentials.

## 14.9 Venture status + pause / resume / kill controls

**Purpose.** First-class governance — fixed position in the right rail, **never in an overflow menu**
([§12.5](./12-information-architecture.md)). The status answers "is it OK?"; the controls are the
brakes a human must always be able to reach.

**Data shown.** The **status pill** maps to the Venture lifecycle ([§9.4](./09-domain-model-glossary.md)):
`● Building` (active, working a goal) · `○ Idle` (active, backlog drained / sleeping until next
tick) · `▮ Paused — <reason>` (budget | checkpoint | kill | stuck) · `■ Stopped`. Paused always shows
its **reason** and the matching unblock action ([§9.4](./09-domain-model-glossary.md)): budget →
top up; checkpoint → review; stuck → answer the no-progress checkpoint; kill → (operator) lift the
switch. Alongside: current goal, `run #N · tick #M`.

**Controls.**
- **Pause** — stops admitting new ticks; the current tick finishes (graceful, resumable). Reversible.
- **Resume** — re-admits ticks once no blocking cause remains ([§9.4](./09-domain-model-glossary.md)).
- **Redirect** — steer mid-loop: pin a goal / inject a note that ORIENT honors next tick
  (Dev's "take over / redirect," [§3.3](./03-personas-jtbd.md)). Cross-links to the board (§14.4).
- **Kill** — hard stop this venture (drains the Run; sets `stop_reason=kill`). **Confirm-gated**
  (type-to-confirm) because it abandons in-flight work. Distinct from the **global kill switch**
  (`VENTURES_KILL`, [§5](../00-MASTER-PLAN.md)) which is operator-only and lives in Admin
  ([§12.2](./12-information-architecture.md)) — the console exposes the *per-venture* kill; if the
  global switch is on, every venture shows `Paused — kill` and per-venture resume is disabled with a
  clear "platform paused by operator" note.

**States.** Controls reflect legality: Resume is disabled (with reason) while a blocking cause stands;
Pause is disabled when already paused/stopped. We **never** silently change which venture a control
acts on — the current-venture label is always visible ([§12.4](./12-information-architecture.md)),
because a misattributed pause/kill is a trust-destroying error for Maya and Sam.

## 14.10 Venture list / dashboard

**Purpose.** The portfolio — the new "home" for logged-in users
([§12.1](./12-information-architecture.md), `?view=ventures`). Not strictly *inside* the console, but
its sibling and entry point: every venture's health, budget, and pending approvals at a glance, so an
operator running several (Dev/Sam, [§3.3](./03-personas-jtbd.md)) triages without opening each.

**Data shown.** One card per venture: name, status pill (§14.9), live URL (if deployed), budget
mini-meter, **approval count badge**, and a one-line latest-activity ("deployed preview · 2m"). Sort
by *needs attention* (open checkpoints first, then budget warnings, then most-active).

```
┌─ Acme Booking  ● Building ─────────┐ ┌─ Habit Tracker  ▮ Paused ──────────┐
│ ↗ acme-booking.com                 │ │ reason: budget (100%)               │
│ Budget ▓▓▓▓░░ $4.10/$25   ⚠ 1      │ │ Budget ▓▓▓▓▓▓▓▓▓▓ $25/$25  [Top up] │
│ deployed preview · 2m              │ │ stopped at "Stripe checkout" · 1h   │
└────────────────────────────────────┘ └─────────────────────────────────────┘
                                        [ + New venture → Intake ]
```

**States.** *Empty / first login*: the warm single-action empty state from
[§12.7](./12-information-architecture.md) ("Describe an idea and we'll draft a plan" → Intake). For
an existing DreamStream user with comics but no venture, the "turn a project into a venture" path
([§12.7](./12-information-architecture.md)). *Loading*: card skeletons. *Error*: per-card retry.
*Live*: cards update via the user-level real-time channel (§14.11) so badges/status stay current
without a refresh.

**Interactions.** Open a venture (→ its console); **+ New venture** → Intake (the first checkpoint,
[§0.4](./00-executive-summary.md)); per-card quick actions (approve from the card, pause) for the
fast triage flow; the venture switcher in the console header is the same data, in-place.

## 14.11 Real-time architecture

The console is a **live** surface; staleness here is a trust failure (a missed checkpoint, a wrong
budget number). The target architecture ([Master Plan §4.2](../00-MASTER-PLAN.md),
[ARCHITECTURE-CLOUDFLARE.md](../ARCHITECTURE-CLOUDFLARE.md)) uses **Durable Objects + WebSocket
Hibernation**, not an always-on socket server:

- **`VentureDO` (per venture)** drives the Tick heartbeat via **Alarms** and is the fan-out point for
  that venture's activity/board/deploy/status updates. As the loop writes a `venture_event`, the DO
  pushes it to every connected console over a **hibernating WebSocket** — long-lived connections that
  **don't bill while idle** ([ARCHITECTURE-CLOUDFLARE.md](../ARCHITECTURE-CLOUDFLARE.md) §"WebSocket
  + Hibernation"). This is what makes a 24/7 watch surface economically viable: thousands of open
  consoles cost nothing between events.
- **`UserCoordinatorDO` (per user)** carries cross-venture, multi-device state: the dashboard badge
  counts, and **instant convergence** — approve a checkpoint on your laptop and your phone's queue
  updates in place ([§14.5](#145-approval--checkpoint-queue)), because the coordinator broadcasts the
  resolution to every device. It is also the auth/session/revocation anchor.
- **Today vs target (honest).** The shipped studio uses **SSE** for the generate stream; A8 ships
  first against an **SSE `/api/ventures/:id/stream`** of `venture_events`
  ([Master Plan A8](../00-MASTER-PLAN.md)) plus polling for board/budget — adequate, one-directional.
  The DO WebSocket path (F4/F5) is the upgrade that adds bidirectional, multi-device, hibernating
  real-time. The console UI is written against an **event-source abstraction** so swapping SSE →
  WebSocket is a transport change, not a rewrite.
- **Degradation.** On disconnect: the `● connected` pill goes amber, we **fall back to polling**, and
  the last-known state stays rendered (never blank). On reconnect we **replay missed events** by
  `created_at` cursor (the append-only `venture_events` log makes this exact and idempotent —
  [§9.3](./09-domain-model-glossary.md)).
- **Optimistic + reconciled writes.** Approve/pause/reprioritize render optimistically, then reconcile
  against the authoritative DO/control-plane result; a rejected write reverts with a clear toast (e.g.
  "already approved on another device").

## 14.12 Mobile (monitoring-first)

On a phone the job shifts from *operating* to **monitoring + deciding**
([§12.6](./12-information-architecture.md)). Mobile is a deliberate reduction, not a port:

- **Sticky header** = venture name + status pill (tap title to switch ventures); **bottom tab bar**
  in the thumb zone: **Ventures · Activity · Approvals (badge) · Controls** ([§12.6](./12-information-architecture.md)).
- **Always visible**: the budget mini-meter and a promoted approval banner when one is pending
  ([§12.6](./12-information-architecture.md)) — the two things that demand attention.
- **Activity** is the same live stream, single-column, condensed Tick rows. **Approvals** are full
  decision cards (§14.5) — approving on a phone is a first-class flow (push deep-links straight to the
  focused checkpoint, [§12.8](./12-information-architecture.md)). **Controls** open a confirm sheet
  for pause/resume/kill.
- **Deliberately absent**: the Code Studio editor, drag-reprioritize, and dense log tailing — read-only
  diffs/preview links only ([§12.6](./12-information-architecture.md)). "Editing is a desktop job; we
  don't pretend otherwise."

## 14.13 Accessibility

The console must clear the enterprise bar ([§20](./20-accessibility.md) governs WCAG; here are the
console-specifics):

- **Status is never color-only.** The status pill pairs color with a glyph **and** text
  (`● Building`); the budget bar shows the numeric `$/cap` and a warning **icon + label** at
  thresholds — color-blind operators get the same signal.
- **The live region is announced.** The activity stream and the approval badge use `aria-live`
  (`polite` for activity, `assertive` for a new checkpoint) so screen-reader users hear "1 approval
  needs you" without watching. Auto-scroll never traps focus.
- **Keyboard-complete.** Every control (approve/deny/pause/resume/kill, board reprioritize, filters,
  deep-links) is keyboard-reachable with visible focus (the kit's `focusRing`); the board offers a
  keyboard reorder (move-up/down) so drag isn't the only path. Destructive confirms are focus-trapped
  dialogs.
- **Targets + motion.** ≥44px touch targets on mobile; `animate-fade-in` respects
  `prefers-reduced-motion` (events appear without sliding). Spinners carry `aria-busy` /
  `aria-label`, not just animation.
- **Plain language.** Per Maya, every checkpoint and status reads in plain English
  ([§3.2](./03-personas-jtbd.md), [§21](./21-content-voice.md)) — no raw enum values surfaced to the
  user (the raw kinds live only in the audit/logs view).

## 14.14 Epic ownership (who delivers what)

| Concern | Primary epic | Depends on |
|---|---|---|
| Console shell, nav, layout, real-time UI wiring | **A8** | A1 (API), F4/F5 (DO real-time) |
| Activity stream UI (reuse ActivityFeed/SwarmTraceCard) | **A8** | A2 (events), A4 (swarm card) |
| Roadmap board + drag-reprioritize | **A8** | A1/A2/A4 (goal state) |
| Approval queue UI | **A8** | **A0** (checkpoints), A1 |
| Budget meter UI | **A8** | **A0** (budgets) + **A7** (portal/spend) |
| Deployments panel + rollback | **A8** | **A5** (adapters), A6 (health) |
| Logs / audit view | **A8** | A2 (events), A5 (deploy logs), sandbox |
| Status + pause/resume/redirect/kill | **A8** | **A0** (kill), A1 (state) |
| Venture list/dashboard | **A8** | A1 |
| Mobile + a11y | **A8** | F9 (design system), [§19](./19-mobile.md)/[§20](./20-accessibility.md) |
| Real-time transport (SSE→WebSocket) | A8 (SSE) → **F4/F5** (DO/WS) | — |

The throughline: **A8 ships the cockpit, but every widget is a faithful window onto governance state
A0–A7 already own.** The console's design contract is that it never *creates* authority it doesn't
have — enforcement (budget caps, checkpoint gates, kill) lives server-side; the console makes that
authority visible, legible, and one click away.

## 14.15 Acceptance criteria

- The console opens on **Activity**, with **status + controls**, **budget meter**, and **approval
  badge** persistently visible on every tab (never in overflow).
- The activity stream renders `venture_events` grouped by Tick, reusing ActivityFeed/SwarmTraceCard
  patterns; live updates arrive without refresh; on disconnect it degrades to polling with last-known
  state and replays missed events on reconnect.
- The roadmap board shows goals by status, updates live, and allows drag-reprioritize only on
  human-owned edges (prioritize/defer/drop) — never into loop-owned columns.
- The approval queue shows every open checkpoint with why/action/changes/safety/cost/TTL; approve/deny
  is one click (plus confirm for irreversibles) and converges across devices.
- The budget meter shows spent/cap, burn, runway, and the managed-vs-BYO split; warning at ≥80%,
  paused at breach with a top-up path; it reports only — the DECIDE gate enforces.
- The deployments panel lists live + history with correct states; promote-to-prod raises the
  production checkpoint; rollback is available only when the adapter supports it.
- Status pill maps to the venture lifecycle with its pause reason and unblock action; pause/resume/
  redirect/kill are reachable, legality-gated, and unambiguous about which venture they act on.
- The dashboard triages multiple ventures by *needs attention*; every empty state offers exactly one
  forward action toward first live deploy.
- Mobile exposes monitor + approve + pause/kill in the thumb zone with no editor; the console meets
  the a11y bar (status not color-only, live regions announced, keyboard-complete, reduced-motion safe).
