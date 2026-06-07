# 13 — UX Spec: Intake & Onboarding

> Part II · Product Definition · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Executive Summary](./00-executive-summary.md) (§0.4 surfaces) ·
> [Vision](./01-vision-positioning.md) (§1.6 magic moments) ·
> [Personas](./03-personas-jtbd.md) · [User Journeys](./11-user-journeys.md) (Journey A) ·
> [Information Architecture](./12-information-architecture.md) ·
> [Master Plan](../00-MASTER-PLAN.md) (Epic A3 intake, Epic A0 brakes)

## 13.1 Scope & the job this surface does

Intake is the **on-ramp** — the single funnel from *"I have an idea"* to *"a roadmap I
approved and a venture that's building."* It owns three of the five magic moments from
[§1.6](./01-vision-positioning.md): **M1 "it understood my idea,"** the trust that comes from
**setting a real budget**, and the hand-off into **M2 "it's actually building."** If intake
feels smart and the budget feels safe, Maya adopts ([§3.9](./03-personas-jtbd.md)); if it
feels like a black box, she churns before the loop ever runs.

The honest framing: most of this surface is **net-new** (Epic A3 builds the intake→roadmap
flow; Epic A0 builds the budget brake), but the *intelligence* reuses shipped machinery — the
CLARIFY stage (`server/src/ai/studio/studioClarify.ts`) and the PLAN stage
(`server/src/ai/studio/studioPlan.ts`), which already turn a free-text idea into clarifying
questions and a structured, multi-file build plan. Intake wraps those flows in a venture-scoped
wizard and adds the governance steps autonomy requires.

This section is a funnel, not a maze ([§12.7](./12-information-architecture.md)): **every state
has exactly one obvious next action** toward the activation metric — *idea → approved roadmap →
first live deploy* ([§0.8](./00-executive-summary.md)).

## 13.2 The end-to-end flow (and where each step lives)

```
 ACCOUNT ─► IDEA INTAKE ─► CLARIFY ─► GENERATED SPEC + ROADMAP ─► ◇ROADMAP ─► BUDGET ─► CONNECT ─► HAND-OFF
 onboarding   (free-text)   (0–4 Q)     (review / edit)          APPROVAL    SETUP    (optional)   to Console
    │             │            │              │                     │          │          │           │
   [U/S]        [U]          [S/U]          [S/U]                  [U]        [U]      [U/skip]       [S]
   A0/F-acct      A3          A3             A3                    A3/A0       A0        A5          A2/A8
```

| Step | Surface | Epic | Skippable? |
|---|---|---|---|
| 0. First-run / account onboarding | App shell, Readiness checklist | A0 + F-sessions | No (account required to create) |
| 1. Idea intake | Intake screen | **A3** | No |
| 2. Clarifying questions | Intake (inline wizard) | **A3** | Auto-skipped when idea is clear (0 questions) |
| 3. Generated spec + roadmap review/edit | Roadmap review screen | **A3** | No (must view) |
| 4. Roadmap-approval checkpoint | Roadmap review (Approve action) | **A3** + **A0** | No — this is the gate |
| 5. Budget setup | Budget step (modal/inline) | **A0** | No — soft-blocks first paid action |
| 6. Connect accounts | Connections prompt | **A5** | **Yes — deferrable** (managed preview works without) |
| 7. Hand-off → Operator Console | Transition | A2/A8 | No (the destination) |

The ordering is deliberate. The roadmap is approved **before** money is discussed so the user
commits to *what* before *how much*; the budget is set **before** the loop can spend; connecting
a cloud is **last and optional** because managed preview removes the need to connect anything to
see the product come alive ([§0.6 hybrid hosting](./00-executive-summary.md)).

## 13.3 First-run / account onboarding

Reading is free, but **creating or saving a venture requires an account** — the same boundary
the shipped Readiness checklist enforces (`components/ReadinessChecklist.tsx`,
[onboarding-readiness.md](../../../features/onboarding-readiness.md)). We reuse that checklist
verbatim rather than inventing a new gate; it already makes blockers explicit instead of letting
the app *look* ready and fail mid-flow.

Three readiness checks gate a productive first run:

| Check | Satisfied by | Fix → |
|---|---|---|
| **Account** | Signed in | `auth` |
| **Model access** | Any active API key (OpenRouter recommended; BYOK feeds the F1 key pool) | `settings` → API Configuration |
| **Budget default** | Platform default offered; user confirms or sets a cap (new for ventures) | Budget step (§13.7) |

The checklist **hides itself when everything is ready** (no clutter) and re-evaluates on window
focus, so it updates after the user adds a key and returns. For Maya, the only mandatory step is
the account; managed preview + a platform model key let her reach a live URL without ever
touching settings. For Dev, the checklist is where he lands his **own** OpenRouter/NVIDIA key
before creating ventures ([Journey B step 1](./11-user-journeys.md)).

**Empty Ventures Dashboard** is the true first-run destination ([§12.7](./12-information-architecture.md)):
a single warm panel — *"Describe an idea and we'll draft a plan"* — with one button,
**Start a venture**, that opens the intake screen. Existing DreamStream creators (Riley) also
see *"turn a project into a venture"* alongside Start.

## 13.4 The idea-intake screen

Free-text first, guided second. A founder should be able to paste a paragraph and go; a less
confident user should be able to lean on prompts. Both feed the same CLARIFY/PLAN flow.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Ventures  ›  New Venture                                    [ ✕ Close]│
├──────────────────────────────────────────────────────────────────────┤
│                                                                        │
│   Describe the product you want to exist.                              │
│   The more concrete, the better the plan — but a sentence is fine.     │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐ │
│   │ A habit-tracker SaaS with email reminders and a weekly streak   │ │
│   │ report. For people building daily routines.                     │ │
│   │                                                                 │ │
│   │                                                       142 / 4000 │ │
│   └────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│   Need a nudge? Add detail with a prompt:                              │
│   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌───────────────┐  │
│   │ Who is it   │ │ What's the  │ │ Does it     │ │ Any data /    │  │
│   │ for?        │ │ #1 feature? │ │ need login? │ │ integrations? │  │
│   └─────────────┘ └─────────────┘ └─────────────┘ └───────────────┘  │
│                                                                        │
│   Examples:  · Booking site for a salon   · Internal CRM              │
│              · Landing page + waitlist     · Invoice generator         │
│                                                                        │
│            ┌──────────────────────────────────────────┐               │
│            │   Draft my plan  →                        │               │
│            └──────────────────────────────────────────┘               │
│   Managed preview is free to try · You'll approve everything first     │
└──────────────────────────────────────────────────────────────────────┘
```

**Behaviors**
- **Free-text area** is primary and auto-focused; the character counter caps at the
  `studioPlan`/`studioClarify` input ceiling (~4000 chars, well above any real idea).
- **Guided prompt chips** append a scaffolded fragment to the text (e.g. "Who is it for?" →
  *"It's for …"*) and place the cursor — they augment the free-text, never replace it. This is
  the "free-text + guided prompts" requirement: the chips are training wheels, not a form.
- **Example pills** populate the box with a known-good idea so a hesitant user can edit a
  template instead of facing a blank page.
- **One primary CTA** — *Draft my plan*. Disabled (with a quiet hint) until the text is long
  enough to plan from; we never send an empty idea to the model.
- **Reassurance microcopy** under the button restates the two trust facts: preview is free,
  nothing happens without approval. This is honest-by-construction
  ([§1.5](./01-vision-positioning.md)), set on the very first screen.

## 13.5 The clarifying-question flow

On submit, the **CLARIFY** stage runs (`runClarify`, `studioClarify.ts`). Per its prompt
contract it asks **0–4 high-signal questions** — only ones that *change what gets built* (scope,
key feature, data source, audience, auth, platform) — and for anything obvious it makes an
assumption instead. **When the idea is already clear, it returns zero questions and the wizard
skips straight to the roadmap.** We honor that: no forced interrogation.

```
┌──────────────────────────────────────────────────────────────────────┐
│  New Venture  ›  A couple of questions            ●━━━○━━━○  Step 2/4  │
├──────────────────────────────────────────────────────────────────────┤
│  These change what we build, so it's worth a moment.                   │
│                                                                        │
│  1. Who signs in?                                          (pick one)  │
│     ( ) Public — no accounts                                           │
│     (•) Email + password                                               │
│     ( ) Social login (Google/GitHub)                                   │
│     ( ) ✎ Something else…                                              │
│                                                                        │
│  2. Where do reminders send from?                         (pick one)  │
│     ( ) We pick a sensible default (recommended)                       │
│     ( ) I have an email provider to connect                            │
│                                                                        │
│  Assumptions we're already making  (edit later, anytime):             │
│   · Mobile-responsive web app · Free tier, no payments at launch       │
│                                                                        │
│         [ Skip — use defaults ]            [ Continue  → ]             │
└──────────────────────────────────────────────────────────────────────┘
```

**Behaviors**
- Each question renders as `single`/`multi` choice with 2–5 **options** plus an **`allowCustom`
  "Something else…"** field — exactly the `StudioClarifyResult` shape. No free-form question
  ever blocks progress.
- **Assumptions are shown, not hidden.** The model's `assumptions[]` are surfaced read-only so
  the user sees what was decided *for* them — and knows it's editable on the roadmap screen.
  Honest-by-construction again.
- **Skip — use defaults** answers nothing and proceeds on assumptions; **Continue** carries the
  answers into PLAN as `StudioAnswer[]`.
- If CLARIFY returns 0 questions, this step is silently absent — the progress indicator shows
  3 steps instead of 4 and the user never sees a question screen.

## 13.6 The generated venture spec + roadmap review/edit screen

The **PLAN** stage (`runPlan`, `studioPlan.ts`) — extended by A3 into a venture intake that
emits `{ name, summary, scope, success_metrics, roadmap: VentureGoal[] }` — produces the
reviewable artifact. This is the M1 moment: the roadmap should feel right enough that the user
*just approves* ([§1.6](./01-vision-positioning.md)). It must also be **editable**, because a
plan the user can't shape is a plan they don't trust.

```
┌──────────────────────────────────────────────────────────────────────┐
│  New Venture  ›  Review the plan                  ○━━━●━━━○  Step 3/4  │
├──────────────────────────────────────────────────────────────────────┤
│  ┌─ Venture ─────────────────────────────────────────────────────┐   │
│  │  Name:    Streakly                                       [ ✎ ]  │   │
│  │  Summary: A habit-tracker SaaS that sends email reminders and   │   │
│  │           a weekly streak report.                       [ ✎ ]  │   │
│  │  Type:    React web app + API · Stack: React, Node, Postgres   │   │
│  │  Scope:   Habit tracking, reminders, streak reports.  ⓘ Work    │   │
│  │           outside this scope will ask you first.        [ ✎ ]  │   │
│  │  Success: Weekly active users · reminder open-rate              │   │
│  └────────────────────────────────────────────────────────────────┘   │
│                                                                        │
│  Roadmap  (3 epics · 11 goals)        [ + Add goal ]  [ Collapse all ] │
│                                                                        │
│  ▾ Epic 1 — Core tracking                                              │
│     ⠿ ☑ Habit model + CRUD                        ~S    [ ✎ ] [ ✕ ]   │
│     ⠿ ☑ Daily check-in UI                         ~M    [ ✎ ] [ ✕ ]   │
│     ⠿ ☑ Streak calculation                        ~S    [ ✎ ] [ ✕ ]   │
│  ▾ Epic 2 — Reminders                                                  │
│     ⠿ ☑ Email reminder scheduler                  ~M    [ ✎ ] [ ✕ ]   │
│     ⠿ ☐ SMS reminders            (you removed this — undo)            │
│  ▸ Epic 3 — Reporting                                       (4 goals) │
│                                                                        │
│  ⓘ This is a draft. Nothing builds until you approve.                  │
│                                                                        │
│      [ ◂ Back ]      [ Regenerate plan ]      [ Approve roadmap → ]    │
└──────────────────────────────────────────────────────────────────────┘
```

**Behaviors**
- **Venture header** shows name/summary/appType/stack from PLAN, each inline-editable. **Scope**
  is called out with an explicit promise — *work outside this scope will ask you first* — because
  the stored `scope` is what the loop's ORIENT step is fenced by, and a scope checkpoint
  ([type 5](./11-user-journeys.md)) fires when the agent wants to exceed it. Editing scope here
  is the user's one cheap chance to widen or narrow the fence.
- **Roadmap** renders goals grouped by epic (epic → feature → task). Each goal is:
  **reorderable** (drag handle), **editable** (rename/redescribe), **removable** (with undo),
  **toggleable** (uncheck to defer without deleting), with a rough **size estimate** (~S/M/L,
  advisory only). **+ Add goal** lets the user inject work the model missed.
- **Regenerate plan** re-runs PLAN with the same idea+answers (the `runPlan` stricter-retry path
  is also what catches an unusable first draft). **Back** returns to clarify/idea.
- **Approve roadmap** is the primary, highest-emphasis action — and the checkpoint (§13.6.1).

### 13.6.1 The roadmap-approval checkpoint

Approval is **checkpoint type 6** ([Master Plan §8](../00-MASTER-PLAN.md)), the only gate that
must clear before *any* autonomous work. Mechanically it calls
`POST /api/ventures/:id/approve-roadmap`, which **resolves the roadmap checkpoint and flips the
venture `draft → active`** (A3). Until then the venture sits in `draft` and the loop never ticks.

```
        ┌──────────────────────────────────────────────────┐
        │  Approve this roadmap?                            │
        │                                                  │
        │  Once approved, agents start building goal by     │
        │  goal — but they'll pause and ask you before:     │
        │   · spending real money                           │
        │   · deploying to production                        │
        │   · anything outside the scope above              │
        │                                                  │
        │  You set a spending cap next.                     │
        │                                                  │
        │     [ Keep editing ]        [ Approve & set budget ]
        └──────────────────────────────────────────────────┘
```

The confirm names the *other* gates the user is buying into, so approving the roadmap is not
mistaken for approving spend or production. It is a one-click decision with full context — the
trust contract of [§11.9](./11-user-journeys.md): money and irreversibles are *always*
human-gated.

## 13.7 Budget-setup step

Immediately after approval — before the loop can run — the user sets a **hard cap** (Epic A0,
`venture_budgets`). This is a real brake, not a suggestion: the DECIDE gate reads the budget
*before* every spend, alerts at 80%, and **pauses at 100%** ([Journey D](./11-user-journeys.md)).
Setting it here, in the funnel, is what makes Maya feel safe enough to press start.

```
┌──────────────────────────────────────────────────────────────────────┐
│  New Venture  ›  Set a budget                     ○━━━○━━━●  Step 4/4  │
├──────────────────────────────────────────────────────────────────────┤
│  Agents stop the moment they hit this. You can raise it anytime.       │
│                                                                        │
│  Total cap          $25  ◀────●──────────────▶   $5 ──────── $500      │
│  Per-day cap        $5   ◀──●────────────────▶   off ─────── $50       │
│                                                                        │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  Estimated reach at $25:  ~first 4–6 goals + managed preview     │  │
│  │  We'll alert you at 80% ($20) and pause at 100% ($25).           │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  Running on your own model key? Your spend can be near-zero.  [BYOK ⓘ] │
│                                                                        │
│              [ ◂ Back ]              [ Start building → ]              │
└──────────────────────────────────────────────────────────────────────┘
```

**Behaviors**
- Two sliders — `usd_total` (required) and `usd_per_day` (optional; "off" allowed) — pre-filled
  with a **platform default** so the path of least resistance is still safe. Daily cap exhaustion
  pauses for the day and **auto-resumes** the next window ([Journey D](./11-user-journeys.md)).
- A plain-language **estimate** ("~first 4–6 goals") translates dollars into outcomes for
  non-technical Maya, with the explicit 80%/100% behavior stated.
- **BYOK note** tells Dev his own key makes spend near-zero — the economic moat
  ([§0.6](./00-executive-summary.md)) surfaced exactly where it matters.
- **Start building** is the funnel's terminal CTA. It persists the budget and triggers the
  hand-off (§13.9). A budget is required before this paid path; the soft-block in
  [§12.7](./12-information-architecture.md) ("set a budget cap") is satisfied here.

## 13.8 Connect-accounts prompt (optional, deferrable)

Connecting a cloud is **never** in the critical path. Managed preview ships to
`*.dreamstreamstudio.ai` with **no credentials** ([Journey A step 6](./11-user-journeys.md)), so
intake can complete and the product can go live without a single connection. We therefore present
connections as an **optional offer**, not a step, and we make deferral the easy choice.

It appears in two non-blocking places:
1. A **dismissible card** on the budget step / first Console view: *"Want production on your own
   cloud? Connect Cloudflare, Vercel, Supabase, or GitHub — or do it later."*
2. **Inline at the moment it's actually needed** — the production-deploy checkpoint
   ([Journey B step 9](./11-user-journeys.md)), where the deploy adapter (A5) needs a
   `venture_connection`. Just-in-time beats up-front for the 90% who only want a preview first.

```
┌──────────────────────────────────────────────────────────┐
│  Optional — connect your cloud for production       [ ✕ ] │
│  Previews are on us. For a real production URL on your     │
│  own account, connect a provider (least-privilege, via    │
│  Nango — we store a reference, never your secret).         │
│                                                          │
│  [ Cloudflare ] [ Vercel ] [ Supabase ] [ GitHub ]       │
│                                                          │
│  [ Maybe later ]                                          │
└──────────────────────────────────────────────────────────┘
```

Each provider opens the Nango connect flow (`services/chatConnectors.ts` / `ai/tools/nango.ts`);
the connection is stored as a per-venture, reference-only `venture_connection` (secrets stay in
Nango). For Sam's per-client work this is where each client's *own* accounts attach, isolated per
venture ([Journey F](./11-user-journeys.md)). **Maybe later** dismisses without penalty; managed
mode continues.

## 13.9 The hand-off: "what happens next"

The last screen the user sees in intake is a **bridge into M2** — not a dead-end "done." On
**Start building**, the venture is `active`, the scheduler can pick it up, and the user is routed
to the **Operator Console** ([§14](./12-information-architecture.md) covers it in full) with a
short orientation overlay so the live activity stream isn't a wall of unexplained motion.

```
┌──────────────────────────────────────────────────────────────────────┐
│  🚀  Streakly is live and building.                                    │
│                                                                        │
│  Here's what happens now:                                             │
│   1. Agents start on Epic 1, goal by goal — you'll see it live.        │
│   2. Each finished goal ships to a free preview URL automatically.     │
│   3. We'll pause and ask before spending money or going to production. │
│   4. You can pause, redirect, or stop anytime.                         │
│                                                                        │
│  Budget: $0.00 / $25  ░░░░░░░░░░                                       │
│                                                                        │
│              [ Take me to the Console → ]                              │
└──────────────────────────────────────────────────────────────────────┘
```

This sets expectations against the loop's real behavior (SENSE→…→REFLECT,
[§11.1](./11-user-journeys.md)): autonomous building, automatic previews, gated money/prod,
always-available controls. After dismissal the user lands on the live Console; the deep-link
context stack ([§12.8](./12-information-architecture.md)) is set so a refresh stays put.

## 13.10 State catalog (empty / loading / error / success)

Intake spans LLM calls that take seconds and can fail; honest states are non-negotiable.

| Phase | State | What the user sees | Recovery |
|---|---|---|---|
| Dashboard | **Empty** | "Describe an idea and we'll draft a plan" + Start | Single CTA → intake |
| Idea | **Invalid** | CTA disabled, quiet hint "add a bit more detail" | Type more; never submit empty |
| Clarify | **Loading** | "Reading your idea…" skeleton, ~2–10s, cancelable | Cancel → back to idea |
| Clarify | **Zero questions** | Step silently skipped → roadmap | n/a (success) |
| Plan | **Loading** | "Drafting your roadmap…" with streamed epic titles as they arrive | Cancel → back |
| Plan | **Unusable draft** | `runPlan` already retried once stricter; if still null → "We couldn't draft a solid plan — try rephrasing or add detail" | Edit idea / Regenerate |
| Plan | **Partial** | Plan with few goals → banner "Sparse plan — add goals or regenerate" | Add goal / Regenerate |
| Roadmap | **Success** | Reviewable, editable roadmap | Edit → Approve |
| Approve | **Error** (network/save) | Inline "Couldn't save — your edits are kept" + Retry | Retry; edits never lost |
| Budget | **Error** | Inline validation; Start disabled until cap valid | Fix cap |
| Hand-off | **Success** | "Live and building" → Console | Continue |
| Any | **Model/provider down** (F1) | "Our planner is briefly unavailable — we'll retry" with backoff; draft preserved | Auto-retry; manual retry |

Two invariants: **the user's idea and edits are never lost** across a failure, and **no state
strands the user** — every error offers a forward or backward action. We never show a spinner
with no exit or a blank screen.

## 13.11 Mobile

Intake is **fully supported on mobile** — unlike the Code Studio editor, which is desktop-only
([§12.6](./12-information-architecture.md)). A founder should be able to describe an idea and
approve a roadmap from a phone.

- The wizard becomes a **single vertical scroll per step**; the step indicator pins to the top.
- The free-text area expands to fill the viewport; guided chips wrap to a 2-up grid; example
  pills become a horizontal scroller.
- Clarify options are **full-width tap targets** (≥44pt); the custom-answer field expands inline.
- The roadmap collapses to **one epic accordion at a time**; goal edit/remove/reorder use a
  per-goal action sheet (drag-reorder degrades to up/down buttons on touch).
- Budget sliders are large-thumb, with `±` stepper buttons as an accessible alternative.
- The primary CTA is a **sticky bottom button** in the thumb zone; the hand-off routes to the
  monitoring-first mobile Console ([§12.6](./12-information-architecture.md)).

## 13.12 Accessibility (WCAG 2.1 AA; full spec §20)

- **Wizard semantics:** each step is a labeled landmark; the step indicator exposes
  `aria-current="step"` and "Step N of M" to screen readers, not just visual dots.
- **Keyboard:** the entire flow is operable without a pointer — Tab order follows reading order,
  Enter activates the primary CTA, Escape closes confirms, roadmap reorder has keyboard
  equivalents (move up/down), and focus is **trapped** in the approval/budget confirm dialogs.
- **Focus management:** on step change, focus moves to the new step's heading; on async
  completion (plan ready), focus moves to the roadmap with a polite `aria-live` announcement
  ("Roadmap ready, 11 goals").
- **Live regions:** loading and streaming states announce via `aria-live="polite"`; errors via
  `role="alert"`. The user is never left guessing whether the model is working.
- **Forms:** clarify radios/checkboxes are real grouped inputs (`fieldset`/`legend`); custom
  fields are labeled; sliders are `role="slider"` with `aria-valuetext` in dollars.
- **Contrast & no-color-only:** status (removed goal, error, scope warning) is conveyed by text
  + icon, never color alone; all text meets 4.5:1.
- **Motion:** streamed-text and progress animations respect `prefers-reduced-motion`.

## 13.13 Epic ownership (traceability)

| Capability | Delivered by | Notes |
|---|---|---|
| Account gate / readiness checklist | F-sessions + shipped `ReadinessChecklist.tsx` | Reused, extended with budget-default check |
| Idea intake screen + guided prompts | **A3** | New client UI; CLARIFY/PLAN flows reused |
| Clarifying-question wizard | **A3** | `studioClarify.ts` (`runClarify`) |
| Generated spec + roadmap review/edit | **A3** | `studioPlan.ts` (`runPlan`) → venture intake `{name,summary,scope,success_metrics,roadmap}` |
| Roadmap-approval checkpoint | **A3** + **A0** | `approve-roadmap` route; checkpoint type 6; `draft→active` |
| Budget-setup step + hard cap | **A0** | `venture_budgets`; budget evaluator `budget.ts` |
| Connect-accounts prompt (deferrable) | **A5** | Nango `venture_connections`; reference-only |
| Hand-off → Operator Console | A2 (loop start) + A8 (console UX) | Scheduler activates; orientation overlay |
| Empty/loading/error states | A3 (flow) + F1 (provider reliability) | Draft preserved across failure |

## 13.14 Acceptance criteria

- A signed-in user can go from free-text idea to an **approved roadmap** without leaving the
  intake funnel; each step has exactly one obvious forward action.
- Guided prompt chips augment (never replace) the free-text; example pills populate an editable
  template; an empty idea cannot be submitted.
- When CLARIFY returns **0 questions**, the question step is skipped and the indicator reflects
  the shorter flow.
- Clarify shows the model's **assumptions** read-only; every question allows a custom answer and
  can be skipped via defaults.
- The roadmap is **viewable and editable** (rename/reorder/remove-with-undo/defer/add) before
  approval; scope is shown with the "we'll ask first" promise.
- Approving calls `approve-roadmap`, resolves checkpoint type 6, and flips the venture
  `draft → active`; the loop does **not** tick before approval.
- A **hard budget cap** is set before any paid action; the user sees the 80%-alert / 100%-pause
  behavior stated.
- Connect-accounts is **deferrable**; managed preview reaches a live URL with no connection.
- The hand-off explains "what happens next" and lands the user on the live Operator Console with
  refresh-safe context.
- Every loading/error state preserves the user's idea + edits and offers a forward/backward
  action; no spinner-without-exit, no blank screen.
- The full flow is operable on mobile and via keyboard, meets WCAG 2.1 AA, and announces async
  state changes to assistive tech.
