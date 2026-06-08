# 19 — Mobile Experience

> Part II · Product Definition · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Information Architecture](./12-information-architecture.md) (§12.6 mobile nav, §12.8 deep-links) ·
> [Personas](./03-personas-jtbd.md) (Maya P1, Dev P1, Sam P2) ·
> [UX: Operator Console](./14-ux-operator-console.md) · [Realtime & Sync](./34-realtime-sync.md) ·
> [Accessibility](./20-accessibility.md) · Delivered by **Epic A8**.

## 19.1 The mobile thesis: monitor and decide, don't build

Autopilot's value on a phone is **not** that you can build a product from a bus stop. It is
that an autonomous system is running *for you* whether you are at a desk or not, and the two
things that only a human can do — **notice** ("is it OK?") and **decide** ("approve / pause /
kill") — must work from anywhere, in seconds, one-handed. That is the whole mobile job.

This maps cleanly onto the primary personas. Maya (P1) wants to "watch it happen" and "never be
surprised by a bill" — both are passive-monitoring-plus-one-tap jobs. Dev (P1) runs several
ventures at once and wants to "come back to a green build" — a glanceable portfolio plus the
ability to unblock a checkpoint without opening a laptop. Sam (P2) wants per-client health and
spend at a glance. None of these requires editing code on a 390px screen.

So the design is a **deliberate triage**, stated honestly rather than disguised as a full port:

| Tier | Capability | Mobile support | Rationale |
|---|---|---|---|
| **First-class** | Monitor: portfolio health, live activity stream, status, budget/spend | Full, optimized | The core "is it OK?" loop; the reason to install. |
| **First-class** | Decide: approve/deny checkpoints, pause/resume/redirect/kill | Full, optimized | The only things that *need* a human; must work one-handed. |
| **Viewable** | Roadmap/backlog, deployments, logs, run history, diffs, preview links | Read-only / light edits | Consulted on mobile, authored on desktop. |
| **Desktop-leaning** | Code Studio editor, multi-pane build/iterate, resizable splits | Open-in-desktop link only | Heavy editing is genuinely worse on a phone; we don't fake it (§19.8). |

The honest line we hold throughout: **mobile is a complete monitoring-and-approval product, and
an intentionally incomplete building product.** We say so in copy rather than ship a degraded
editor that frustrates everyone.

## 19.2 What each surface looks like on mobile

Mobile is not a responsive reflow of the desktop Console; per [§12.6](./12-information-architecture.md)
it is a reduced surface with a thumb-zone bottom tab bar (Ventures · Activity · Approvals ·
Controls) and the venture switcher living in the sticky header title.

**Ventures Dashboard (portfolio).** A vertical stack of venture cards, each a self-contained
health summary — the one screen Dev opens to triage five projects.

```
┌──────────────────────────────┐
│  Your Ventures        [+]     │
├──────────────────────────────┤
│ Acme Booking      ● Building  │
│ $4.10/$25  ▓▓░░░  ⚠ 1 approval│
├──────────────────────────────┤
│ Lead CRM          ◐ Blocked   │
│ $19/$50   ▓▓▓▓░  needs cloud  │
├──────────────────────────────┤
│ Portfolio site    ✓ Idle      │
│ $0.80/$10 ▓░░░░  live ↗        │
└──────────────────────────────┘
```

**Operator Console — activity stream.** The default tab. A reverse-chronological, live SSE feed
of `venture_events` rendered as compact one-liners (verb + object + relative time), reusing the
`ActivityFeed` pattern. Tapping a row expands it in place (diff summary, cost, links); it never
navigates away mid-scroll. A sticky status pill (Building / Idle / Blocked / Paused / Stopped)
and a thin budget bar pin to the top so "what is it doing and is it OK?" is answered without
scrolling.

**Approval queue.** The highest-priority mobile surface. Each pending checkpoint is a full-width
card: what is being asked (e.g. "Deploy to production"), the *why*, the cost estimate, a
collapsible diff/plan, and two large fixed-bottom buttons — **Deny** and **Approve** — sized for
the thumb. Approving a spend/deploy checkpoint may require a confirm sheet (§19.4 destructive
actions). The tab badge shows the pending count; it is the one number that earns a notification.

**Budget / spend.** A single-screen meter: spent / cap, burn rate, projected exhaustion date,
and a sparkline of recent spend. Editing the cap is allowed on mobile (it is a safety control,
not authoring) behind a confirm. This directly serves Maya's "never surprised by a bill."

**Deployments.** Read-first: current live URL (tap to open), preview URL, last deploy status,
and a **Rollback** action (a governance control, so it is mobile-first, behind confirm).
Triggering a *new* production deploy still flows through the normal checkpoint, not a free
button.

**Code Studio.** Present only as read-only diffs, a live-preview link, and an **"Open in
Studio (desktop)"** affordance that emails/links the deep target. No editor (§19.8).

## 19.3 Push and notification-driven re-entry

Because the agent runs 24/7 and the human is usually *away*, the dominant mobile entry path is
not "open the app and look" — it is **"get pinged, tap, decide, leave."** Notifications are the
front door; the deep-link resolver ([§12.8](./12-information-architecture.md)) is the hallway.

| Notification | Channel(s) | Lands on | Re-entry job |
|---|---|---|---|
| `deploy-checkpoint` | push + email + in-app | Approvals → that checkpoint | approve/deny prod deploy |
| `spend-checkpoint` | push + email + in-app | Approvals → that checkpoint | approve/deny a paid action |
| `budget-threshold` | push + in-app | Budget meter | review burn, raise/hold cap |
| `stuck` / `blocked` | push + in-app | Activity → the blocked run | redirect or connect a cloud |
| `deploy-succeeded` | in-app (push opt-in) | Deployments / live URL | celebrate, share link |

Every notification is a **working deep-link to the exact entity**, authenticated through the
sign-in-and-resume gate, refresh-safe, with the context stack (breadcrumbs + venture switcher)
set correctly — and if the checkpoint was already actioned, it shows the resolved state
("approved by you, 09:14"), never a 404. Re-notification/escalation for unresolved checkpoints
(per the feature catalog) is what keeps the loop from stalling silently while the operator is
asleep. Web Push (VAPID) covers Android/desktop PWA; iOS receives push only when the PWA is
installed to the Home Screen (a documented platform constraint), with email as the universal
fallback so no checkpoint depends on push alone.

## 19.4 Offline and poor-connection behavior

Phones lose connectivity constantly. We reuse the **sync + outbox** model defined in
[§34 — Realtime & Sync](./34-realtime-sync.md) rather than inventing a mobile-specific one.

- **Reads degrade gracefully.** The activity stream, last-known status, budget, and the pending
  approval queue are cached (last snapshot) so opening the app offline shows the **last known
  state with a clear "stale as of HH:MM — reconnecting" banner**, never a blank screen or a
  spinner of death.
- **The live channel auto-reconnects.** The SSE/realtime subscription backs off and resumes on
  reconnect; on resume it reconciles against the server cursor so the user never sees a gap or a
  duplicated event (the at-least-once + idempotent-render contract from §34).
- **Decisions queue through the outbox.** A tap on Approve/Deny/Pause/Kill while offline is
  written to a **local outbox** with an idempotency key and a visible "Queued — will send when
  back online" state. On reconnect it flushes; the server, being idempotent, safely no-ops a
  duplicate.
- **Conflict is surfaced, never silently lost.** If a queued decision arrives after the
  checkpoint was already resolved (e.g. it timed out, or another operator acted), the outbox
  flush returns the *current* state and the UI reconciles to it with a short notice ("This was
  already approved by you at 09:14"). Destructive/governance actions (Kill, raise budget) do
  **not** optimistically render as done; they show "queued/pending confirmation" until the
  server acknowledges, because a falsely-rendered "killed" is a trust failure.

The principle: **monitoring tolerates staleness; decisions tolerate latency but never
ambiguity.** We would rather say "queued" honestly than fake a confirmation we cannot guarantee.

## 19.5 Responsive breakpoints strategy

We extend the **existing Tailwind breakpoints** (the codebase already keys major layout on `lg:`;
the shipped mobile-compat work, §19.10, hangs off exactly this). No bespoke breakpoint system.

| Range | Tailwind | Layout |
|---|---|---|
| **Phone** | `< sm` (<640px) | Single column; bottom tab bar; sticky header switcher; sheets for detail/confirm. |
| **Large phone / small tablet** | `sm`–`md` (640–1024px) | Single column, wider cards; bottom bar persists; some side-by-side meta. |
| **Tablet / small laptop** | `lg` (≥1024px) | Console gains its multi-column layout; left/secondary nav rails appear; Code Studio panes unlock. |
| **Desktop** | `xl`+ | Full operator cockpit; resizable splits; multi-pane editor. |

The hard rule is **`lg` is the desktop/mobile seam** — the same line the existing app uses, and
the line where the §19.10 fixes had bitten (header nav vanished, studio panes collapsed) when a
breakpoint had *no* fallback below `lg`. The console therefore ships a real mobile layout below
`lg`, not a `hidden lg:flex` element with nothing behind it. We design **mobile-first** (the
base styles are the phone layout; `lg:` adds desktop), which is also what keeps the first-paint
bundle small (§19.7).

## 19.6 Touch targets and interaction

- **Minimum 44×44 CSS px hit area** on every interactive element (WCAG 2.5.5 / Apple HIG / Material
  48dp), enforced via shared `components/ui/*` button sizing so it cannot drift per-screen.
- **Primary decisions live in the thumb zone:** Approve/Deny and Pause/Resume/Kill are
  bottom-anchored, not in a top-right overflow that requires a hand-shuffle on a tall phone.
- **Destructive/governance actions require a confirm sheet** with the verb spelled out ("Kill
  Acme Booking? The loop stops and this is logged") — no swipe-to-kill, no accidental fat-finger
  on a screen the user is glancing at.
- **No hover-only affordances.** Anything reachable by hover on desktop (tooltips, row actions)
  has a tap-equivalent; expand-on-tap replaces reveal-on-hover for activity rows.
- **Native scroll, momentum, and pull-to-refresh** on the streams; we never hijack the scroller.

## 19.7 Performance budget on mobile

Mobile performance is a product feature: a checkpoint you can't load on hotel Wi-Fi is a
checkpoint you can't approve. We tie to the existing first-paint work (the studio's boot-reveal /
shimmer-skeleton pattern, and the §19.10 backdrop-filter fix that proved heavy GPU effects can
fail to paint at all on weak hardware — so mobile uses **solid surfaces, no `backdrop-blur`, no
animated `blur()`**).

| Metric (mid-tier phone, 4G) | Target | How |
|---|---|---|
| First Contentful Paint | ≤ 1.8s | Code-split the Console route; mobile bundle excludes the editor. |
| Time to Interactive (approve a checkpoint) | ≤ 3.0s | Hydrate the approval queue + controls before secondary panels. |
| Largest Contentful Paint | ≤ 2.5s | Skeleton-first; stream content in (boot-reveal pattern). |
| Route JS (gzipped, mobile) | ≤ ~200 KB | Lazy-load Studio/editor/diff viewers; they never load on phone. |
| Activity stream | 60fps scroll, virtualized | Windowed list; cap rendered rows; no layout thrash. |
| Reconnect after sleep | ≤ 2s to live | Backoff + cursor resume (§34), not a full refetch. |

The single biggest lever is that **the editor never ships to the phone** — it is the heaviest part
of the app and the one mobile deliberately omits, so excluding it via route-level code-splitting
both shrinks the bundle and aligns with §19.1/§19.8.

## 19.8 What is intentionally desktop-only, and why

| Desktop-only | Why | Mobile substitute |
|---|---|---|
| **Code Studio editor / multi-pane build-iterate** | Heavy WebContainer/editor; resizable splits assume ≥`lg` width; serious code editing on a 390px screen is worse for everyone. | Read-only diffs + preview link + "Open in Studio (desktop)". |
| **Full roadmap drag-to-reprioritize** | Multi-column drag is fiddly on touch; mis-drops reorder a backlog. | Reorder via a per-goal menu ("move up / set priority"); board is read-first. |
| **Dense logs / raw traces** | Wide tabular data; on-demand depth for Dev/Ops, not a monitoring need. | Summary + key errors; "open full logs on desktop". |
| **Admin platform surface** | Operator-grade controls (global kill, tenants, quotas); rarely needed from a phone. | Reachable but unoptimized; not in the bottom bar. |

This is the §19.1 thesis enforced at the feature level: we **omit honestly** rather than ship a
cramped editor. The line in copy is consistent — "Editing is a desktop job; we'll open this on
your computer" — so the user is never hunting for a feature we quietly hid.

## 19.9 PWA / installability and mobile a11y

**Installable PWA.** The app ships a web app manifest (name, icons, `display: standalone`,
theme color) and a service worker so it can be **added to the Home Screen** and launched
chrome-less — which is also the *only* way iOS grants Web Push (§19.3), making installability a
functional requirement, not a nicety. The service worker's scope is the app-shell + cached
last-known snapshots feeding the offline reads of §19.4; it explicitly does **not** try to cache
the live agent feed (that always comes from the network/SSE). We are honest that this is a PWA,
not a native app — no app-store binary at launch.

**Accessibility on mobile** (full spec in [§20](./20-accessibility.md); the mobile-specific
commitments):

- **Screen readers** (VoiceOver / TalkBack): the activity stream uses an `aria-live="polite"`
  region so new events are announced without stealing focus; status changes (Building → Blocked)
  announce; the approval queue is a labeled list with each card a labeled group and the
  Approve/Deny buttons named with their venture + action.
- **Reachability/focus:** confirm sheets trap focus and restore it on close; the bottom tab bar
  is a proper landmark; deep-links move focus to the resolved entity so a screen-reader user
  lands *on* the checkpoint, not at the top of the page.
- **Type & contrast:** respect OS Dynamic Type / font-scaling (layout reflows, nothing clips at
  200% zoom — WCAG 1.4.4/1.4.10); contrast meets AA on the solid mobile surfaces; status is never
  conveyed by color alone (the pill carries a label + glyph).
- **Motion:** honor `prefers-reduced-motion` — the boot-reveal shimmer and fade-ins fall back to
  instant render (also a perf win on weak GPUs).

## 19.10 Delivery: Epic A8 — and what already shipped

**Mobile polish is delivered by [Epic A8 (Operator Console)](../00-MASTER-PLAN.md).** A8's
acceptance is explicit: the user can create a venture, approve its roadmap, watch it build,
approve the prod deploy, see spend, and pause/kill — **"on desktop and mobile."** The
"mobile-responsive console" feature is tracked in the catalog (Should-have, owners Maya/Dev,
refs A8 + this §19). Mobile is therefore not a separate epic; it is an acceptance dimension of
the console epic, with this section as its detailed contract.

**Already shipped (mobile-compat, honest status).** Two responsive defects from the broader app
were found and fixed by browser-verified work (headless Chromium at 800/1280px), and they
establish the foundation this section builds on:

- **Header navigation below `lg`.** The product nav was `hidden lg:flex` with no fallback, so
  under 1024px there was *no* nav at all; a hamburger + mobile menu (full product groups + Sign
  In) was added in `StaticSiteHeader`. This is exactly the "`lg` seam needs a real mobile
  layout" rule of §19.5.
- **Studio panes collapsing in the wide layout.** `ResizableSplit` had no root height, so panes
  could size to 0 until a forced reflow; fixed with `h-full w-full`. Plus the backdrop-filter
  blank-render fix (solid panels, filter-free aurora) that §19.7 generalizes into "no heavy GPU
  effects on mobile."
- **Preview device frames.** `workspace/PreviewFrame.tsx` already ships a desktop/tablet/**mobile**
  device-size toggle with a boot-reveal — the read-only mobile preview surface §19.2/§19.8 rely on.

These are foundational app-shell fixes, **not** the venture Operator Console mobile layout, which
remains 📋 planned under A8. Stated plainly: the responsive scaffolding and the mobile preview
exist today; the monitoring-and-approval mobile Console described here is the A8 deliverable.

## 19.11 Acceptance criteria

- From a phone, a user can: see portfolio health, read the live activity stream, view budget/spend,
  and **approve/deny a checkpoint and pause/kill a venture** — all in the thumb zone, one-handed.
- A push/email notification deep-links to the exact checkpoint, authenticated, refresh-safe, with
  the right venture context; an already-actioned checkpoint shows its resolved state, not a 404.
- Offline: reads show last-known state with a "stale" banner; decisions queue in an idempotent
  outbox and flush (and reconcile) on reconnect; no decision is falsely rendered as confirmed.
- The `lg` seam has a real mobile layout below it (no `hidden lg:`-only nav); base styles are
  mobile-first; the editor route is not loaded on phone.
- All interactive targets ≥ 44px; destructive/governance actions require a labeled confirm sheet.
- Mobile FCP ≤ 1.8s and approve-checkpoint TTI ≤ 3.0s on a mid-tier phone over 4G; no
  `backdrop-blur`/animated `blur()` on mobile surfaces.
- Installable PWA (manifest + service worker); iOS Web Push works when installed; email is the
  universal fallback.
- Screen-reader: live activity announces politely; approval cards/buttons are labeled with venture
  + action; deep-links move focus to the entity; `prefers-reduced-motion` and 200% zoom respected.
