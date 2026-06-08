# 12 — Information Architecture & Navigation

> Part II · Product Definition · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Executive Summary](./00-executive-summary.md) (§0.4 surfaces) ·
> [Personas](./03-personas-jtbd.md) · [Value Proposition](./04-value-proposition.md)

## 12.1 Scope & the integration constraint

Autopilot does not get a greenfield app shell. It extends the **existing single-page app**
(`App.tsx`) whose navigation is a flat `AppView` union persisted in the URL via `?view=`
(`dashboard`, `chat`, `codestudio`, `gallery`, `settings`, …). That code already does the hard
part: a load-time effect restores the active view from `?view=` so a refresh keeps you in place,
and a `replaceState` sync effect keeps the URL honest without spamming history. Reader/share/
auth-callback/models routes are intentionally excluded from `?view=` because they own their URLs.

This section defines the IA for the **new venture-centric surfaces** and specifies how they slot
into that existing scheme **without breaking it**. The honest constraint: today's nav is *flat*
(one global level). Ventures introduce a **scoped** level (everything-under-a-venture). The IA
below adds exactly that second level and nothing more — we resist a third.

The new top-level surfaces (per [§0.4](./00-executive-summary.md) and the personas):

| Surface | Status today | What it is |
|---|---|---|
| **Ventures Dashboard** | new | The portfolio: every venture you own, health/budget/checkpoint at a glance. The new "home" for logged-in users. |
| **Venture detail** | new | A single venture's overview (roadmap, deploys, budget, connections summary). |
| **Operator Console** | new | The 24/7 cockpit *scoped to a venture*: live activity, approval queue, budget meter, controls. |
| **Code Studio** | **shipped** (`?view=codestudio` + `/studio.html`) | The existing builder/editor/preview, now openable in-venture context. |
| **Billing / Budgets** | partial (Settings → billing tab) | Cross-venture spend, plan, credits; per-venture budget caps. |
| **Integrations / Connections** | partial (Nango exists) | BYO accounts + model keys, global and per-venture. |
| **Settings** (incl. Devices/Sessions) | shipped (Settings tabs) | Account, security, **devices/sessions** (new, from `UserCoordinatorDO`), preferences. |
| **Admin** | shipped (admin tab, gated) | Platform operator surface: global kill switch, quotas, tenants. |

## 12.2 Site map / navigation tree

```
DreamStream / Code Studio Autopilot
│
├── (public)
│   ├── Home (/)                         marketing / sign-in entry
│   ├── How it works  (?view=how-it-works)
│   ├── Gallery       (?view=gallery)    public comics/showcase (existing)
│   ├── Legal         (?view=privacy | terms)
│   └── Share/Reader  (/share/:token, ?view=read&id=…)   own URLs, no login
│
└── (authenticated)
    ├── Ventures Dashboard   (?view=ventures)      ← new default landing
    │     └── [+ New Venture] → Intake (first checkpoint)
    │
    ├── Venture  «:id»        (?view=venture&v=:id)        VENTURE-SCOPED ROOT
    │     ├── Overview        (default tab)
    │     ├── Operator Console (?view=console&v=:id)   ← the 24/7 cockpit
    │     │     ├── Activity stream     (primary)
    │     │     ├── Approvals / Checkpoints
    │     │     ├── Roadmap / Backlog board
    │     │     ├── Budget meter & spend
    │     │     ├── Deployments
    │     │     └── Logs / Runs / Audit
    │     ├── Code Studio      (?view=codestudio&v=:id) ← existing builder, in context
    │     ├── Connections      (?view=connections&v=:id)  per-venture BYO accounts
    │     └── Budget           (?view=budget&v=:id)       per-venture cap & report
    │
    ├── Chat                  (?view=chat)          existing assistant (global)
    ├── Code Studio (global)  (?view=codestudio)    existing, ad-hoc (no venture)
    ├── Billing & Budgets     (?view=billing)       cross-venture spend, plan, credits
    ├── Integrations          (?view=integrations)  global connections + model keys
    │
    ├── Settings              (?view=settings)
    │     ├── Profile · Preferences · Security
    │     ├── Devices & Sessions   ← new (live, revocable)
    │     ├── Billing (deep-link target → Billing surface)
    │     └── Legal · Contact
    │
    └── Admin                 (?view=admin)   ← operator-only, gated
          ├── Global kill switch
          ├── Tenants / quotas
          └── Platform health
```

## 12.3 Route / URL scheme

The scheme is **two-layered on purpose**: keep the shipped `?view=` mechanism (it already gives
us free refresh-restore and zero-router-dependency) for v1, and reserve **clean paths** as the
forward-looking public contract for deep-links, sharing, and SEO. Both resolve to the same view
state.

| Surface | `?view=` form (ships first, extends `App.tsx`) | Clean path (target / canonical) |
|---|---|---|
| Ventures Dashboard | `?view=ventures` | `/ventures` |
| Venture detail | `?view=venture&v=:id` | `/ventures/:id` |
| Operator Console | `?view=console&v=:id` | `/ventures/:id/console` |
| Console sub-tab | `?view=console&v=:id&tab=approvals` | `/ventures/:id/console/approvals` |
| Code Studio (in-venture) | `?view=codestudio&v=:id` | `/ventures/:id/code` |
| Per-venture Connections | `?view=connections&v=:id` | `/ventures/:id/connections` |
| Per-venture Budget | `?view=budget&v=:id` | `/ventures/:id/budget` |
| Billing & Budgets (global) | `?view=billing` | `/billing` |
| Integrations (global) | `?view=integrations` | `/integrations` |
| Settings | `?view=settings` | `/settings` |
| Settings → Devices | `?view=settings&tab=devices` | `/settings/devices` |
| Admin | `?view=admin` | `/admin` |

**Adding the new views to the existing machinery.** Each new top-level view name
(`ventures`, `venture`, `console`, `connections`, `budget`, `billing`, `integrations`, `admin`)
is added to the `AppView` union and to the `RESTORABLE_VIEWS` set so the existing load-time
restore effect and the `replaceState` sync effect cover them for free. The only genuinely new
piece of URL state is the **venture id** (`v=:id`): venture-scoped views read it on load (like
the reader already reads `id=`), and the sync effect must preserve `v` while it preserves `view`.
A scoped view with no resolvable `v` falls back to the Ventures Dashboard (mirroring how
`editor`/`comicforge` fall back to home when their project isn't loaded).

**Refresh restores the page.** This is the one behavior we must not regress. Because the new
views are restorable and carry `v=:id`, a hard refresh on
`/ventures/abc/console?tab=approvals` (or the `?view=` equivalent) re-hydrates the same venture,
the same console, the same tab. Non-restorable, state-dependent views (a half-loaded editor)
deliberately fall back rather than render broken — same policy as today.

**Code Studio's separate tab.** The heavy WebContainer Studio still opens cross-origin via
`services/studioLauncher.ts` (`/studio.html?id=…` with the payload stashed in `localStorage`).
That is unchanged. In-venture, "Open in Studio" carries the venture id so the Studio tab can
report runs/usage back to the right `VentureDO`; the in-app `?view=codestudio&v=:id` remains the
lightweight, embedded path.

## 12.4 Navigation model

**Three navigation registers**, kept visually distinct so the user always knows their altitude.

1. **Primary (global) nav.** Persistent. Switches between top-level, *unscoped* surfaces:
   Ventures · Chat · Billing · Integrations · Settings · (Admin if operator). This is the
   account-level rail. On desktop it is a left rail or top bar; it never disappears.

2. **Venture-scoped nav.** Appears *only inside a venture* (`v=:id` present). A secondary bar
   under a **venture switcher** (the current venture's name + dropdown to jump ventures without
   returning to the dashboard). Tabs: Overview · Console · Code · Connections · Budget. Leaving
   the venture (Ventures, or picking a global surface) tears this register down.

3. **Within-Console nav.** A third, *local* register inside the Operator Console only (Activity ·
   Approvals · Roadmap · Budget · Deploys · Logs). It is the console's own tab strip, not part of
   global IA — which is why we cap the IA at two levels and let surfaces own their internals.

**Global vs venture-scoped context switching.** The mental model is a **context stack**:
`account → venture → console-tab`. The venture switcher lets you swap the middle of the stack
in place; the primary nav pops back to the account level. We never silently change which venture
you're operating on — switching is always an explicit action with a visible current-venture
label, because a misattributed approve/pause/kill is a trust-destroying error for Maya and Sam.

**Breadcrumbs.** Shown on every venture-scoped surface, reflecting the context stack:

```
Ventures  ›  Acme Booking  ›  Operator Console  ›  Approvals
 (global)      (venture switcher)   (scoped tab)      (local)
```

Each crumb is a real navigation target; the venture crumb doubles as the switcher. Global
surfaces show a single non-clickable label (no false hierarchy).

## 12.5 Information hierarchy in the Operator Console

The Console is the product's daily-use surface, so its hierarchy is opinionated. Detail lives in
[14 — UX: Operator Console]; here we fix the *information priority*.

| Priority | Element | Why it ranks here |
|---|---|---|
| **Primary** | Live **activity stream** + **status pill** (Building / Idle / Blocked / Paused / Stopped) | The one-glance answer to "what is it doing right now and is it OK?" |
| **Primary** | **Approval queue** badge + first pending checkpoint | Checkpoints are the only thing that *needs the human*; they must surface above everything when present. |
| **Primary** | **Budget meter** (spent / cap, burn rate) | Trust guardrail; Maya's "never surprised by a bill." Always visible, never buried. |
| **Secondary** | Roadmap / backlog board, Deployments, latest live URL | The "what's been done / what's next" context; consulted, not monitored. |
| **Tertiary** | Logs, run history, audit trail, raw traces | On-demand depth for Dev/Sam; reachable, not foregrounded. |
| **Always-present controls** | Pause · Resume · Redirect · Kill | First-class governance; fixed position, not in an overflow menu. |

The rule: **anything that demands a human decision or signals risk outranks anything that is
merely informative.** When a checkpoint or a budget threshold trips, the relevant element is
promoted (and notified) regardless of which tab is open.

## 12.6 Mobile navigation model (monitoring-first)

On phones the job changes from *operating* to *monitoring + deciding*. Mobile is not a port of
the desktop Console; it is a deliberately reduced surface.

```
┌──────────────────────────────┐
│  Acme Booking      ● Building │  ← venture + status, sticky top
├──────────────────────────────┤
│  Budget  $4.10 / $25  ▓▓░░░░  │  ← always visible
│                              │
│  ⚠ 1 approval needs you  [→] │  ← promoted when pending
│                              │
│  Activity (live)             │
│  · deployed preview …  2m    │
│  · fixed failing test  6m    │
│  · drafted goal: auth  11m   │
├──────────────────────────────┤
│ [Ventures] [Activity] [⚠ 1] [⏸]│  ← bottom tab bar
└──────────────────────────────┘
```

- **Bottom tab bar** (thumb zone): Ventures (portfolio) · Activity (the live stream) ·
  Approvals (with count badge) · Controls (pause/resume/kill in a confirm sheet).
- **Primary global nav collapses** into the Ventures tab + an overflow for Billing/Integrations/
  Settings — these are rarely needed on a phone.
- **The venture switcher** is the sticky header title; tap to swap ventures.
- **Code Studio is intentionally absent** on mobile beyond read-only diffs/preview links —
  editing is a desktop job; we don't pretend otherwise.
- Push/in-app notifications deep-link straight to the relevant Approvals or Activity item.

## 12.7 Empty states & first-run entry points

| State | What the user sees | Primary action |
|---|---|---|
| First login, **no ventures** | A single, warm empty Ventures Dashboard: "Describe an idea and we'll draft a plan." | **Start a venture → Intake** (the first checkpoint) |
| Venture created, **no roadmap yet** | Venture overview with intake-in-progress state | Review/approve the drafted roadmap |
| Roadmap approved, **loop not started** | Console showing Idle + "Press start" | **Start building** (governed-but-idle → active) |
| **No connections** | Inline prompt in Console/Deploys: managed preview works now; connect your cloud for production | Connect via Integrations (Nango) |
| **No budget set** | Soft block before first paid action | Set a budget cap (platform default offered) |
| Existing DreamStream user, **0 ventures but has comics** | Dashboard offers "turn a project into a venture" alongside Start | Convert / Start fresh |

First-run is a **funnel, not a maze**: every empty state has exactly one obvious next action that
moves toward "idea → approved roadmap → first live deploy" (the activation metric in §0.8). We do
not show an empty Console with twelve disabled controls.

## 12.8 Deep-link resolution (checkpoints & notifications)

A notification ("Acme Booking needs your approval to deploy to production") must land the user on
the exact decision, authenticated, with full context — across web push, email, and in-app.

**Canonical deep-link shape:**
`/ventures/:id/console/approvals?checkpoint=:checkpointId`
(`?view=console&v=:id&tab=approvals&cp=:checkpointId` in the shipped scheme).

Resolution order:

1. **Auth gate.** If logged out, route through sign-in preserving the full target (same pattern
   the reader uses to defer a target until login), then continue.
2. **Resolve venture `v=:id`** → hydrate the `VentureDO`. If the venture is gone/forbidden →
   Ventures Dashboard with a clear "no longer available" notice (never a blank console).
3. **Open the scoped surface** (Console) and **the right local tab** (Approvals).
4. **Focus the specific entity** (`cp=:checkpointId`): scroll to + expand that checkpoint; if it
   was already actioned, show its resolved state ("approved by you, 09:14") rather than a 404.
5. **Set the context stack** so breadcrumbs and the venture switcher show the right venture, and a
   **refresh stays put** (§12.3).

The same machinery serves notification types: `deploy-checkpoint`, `spend-checkpoint`,
`stuck/blocked`, `deploy-succeeded`, `budget-threshold` — each carries `v=:id` plus an entity id
(`cp=`, `run=`, or `deploy=`) and resolves to its surface and local tab. **Invariant:** every
notification is a working deep-link to the thing it is about; we never drop the user on a generic
dashboard and make them hunt.

## 12.9 Acceptance criteria

- New views (`ventures`, `venture`, `console`, `connections`, `budget`, `billing`,
  `integrations`, `admin`) are in `AppView` + `RESTORABLE_VIEWS`; refresh restores each.
- Venture-scoped views persist and restore `v=:id`; missing/forbidden `v` falls back to the
  Ventures Dashboard with a notice, never a broken render.
- Clean paths (`/ventures/:id/console`, `/billing`, `/settings/devices`, …) resolve to the same
  state as their `?view=` equivalents.
- Breadcrumbs + venture switcher always reflect the current context; switching ventures is always
  explicit and labeled.
- Operator Console foregrounds status, approvals, and budget; controls are never in overflow.
- Mobile exposes monitor + approve + pause/kill in the thumb zone; no editor.
- Every empty state offers exactly one forward action toward first live deploy.
- A checkpoint deep-link lands the authenticated user on that checkpoint, in the right venture,
  with refresh-safe state — or a graceful "already actioned / unavailable" equivalent.
