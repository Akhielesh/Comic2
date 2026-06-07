# 20 — Accessibility (WCAG) Spec

> Part II · Product Definition · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Principles & Tenets](./08-principles-tenets.md) (D1, D6, §8.7) ·
> [Enterprise Foundations F9](../F-ENTERPRISE-FOUNDATIONS.md) ·
> [Information Architecture](./12-information-architecture.md)

## 20.1 The commitment

Autopilot targets **WCAG 2.2 Level AA** across every authenticated surface a user can
reach: the Ventures Dashboard, Venture detail, the Operator Console (the 24/7 cockpit),
Code Studio, billing/budgets, connections, and Settings. AA is the bar, not the
aspiration — it is part of the platform Definition of Done ([08 §8.6.1](./08-principles-tenets.md),
item 5) and a release gate ([§20.11](#2011-acceptance-checklist)). This is not a separate
"accessibility tier" sold later; per **P7 — enterprise-grade by default**, the same
keyboard operability, contrast, and screen-reader legibility ship to a solo founder and
an org alike.

Accessibility is also load-bearing for trust. The product's whole proposition is
**legibility of autonomy** ([08 D1](./08-principles-tenets.md)) and **honest by
construction** ([08 P3](./08-principles-tenets.md)): a user must be able to understand
what the agents are doing, what it costs, and what needs approval. If that status is only
conveyed by color, motion, or unlabeled icons, the product fails its own central promise
for a meaningful slice of users. A11y here is the same requirement as honesty, expressed
for assistive technology.

Two non-negotiables specific to this product shape:

- **The activity stream is real-time and high-volume.** It is the single hardest a11y
  problem in the product and gets dedicated treatment ([§20.5](#205-the-real-time-activity-stream)).
- **The product runs unattended for hours.** Idle/time-out handling ([§20.6](#206-time-out-idle--re-auth))
  must not silently log a user out mid-approval or strand assistive-tech users in a stale view.

## 20.2 Current state — honest

The audit baseline (from [F9](../F-ENTERPRISE-FOUNDATIONS.md), concern #6: "sparse a11y")
holds. Stated plainly, with file refs:

| Area | State | Evidence |
|---|---|---|
| Reduced motion | 🟡 partial | Per-animation opt-outs exist — `index.css` has `@media (prefers-reduced-motion: reduce)` blocks for slide-in, shimmer, staggered reveals, weather/HIW effects, composer glow. **But there is no global reduced-motion reset**, and core utilities like `.animate-fade-in` (`index.css:31`) have no guard, so some motion still plays for users who asked it off. |
| Dialog a11y | 🟡 partial | `components/studio/kit/useDialogA11y.ts` gives Escape-to-close + focus **restoration** on close. It does **not** trap focus inside the dialog or set `aria-modal`/`role="dialog"` — focus can tab out behind the modal. |
| Responsive primitives | 🟢 exists | `useMediaQuery.ts` / `useIsWide()` drive layout decisions cleanly and are matchMedia/SSR-safe. |
| ARIA coverage | 🔴 sparse | ~24 `aria-*` / `role` usages across ~15 component files (mostly studio workspace + a few forms). The large new venture surfaces have **none yet** because they are not built. No consistent landmark structure, no skip link, no documented naming convention. |
| Color contrast | 🔴 unaudited | The comic house style (`border-2 border-black`, bold display type, saturated accents) is high-contrast by instinct but has **never been measured**. Two unsynced token systems ([F9](../F-ENTERPRISE-FOUNDATIONS.md): Tailwind theme + `kit/theme.ts`) mean contrast can't even be reasoned about from one source. |
| Automated a11y testing | 🔴 none | No `axe` in CI; `gallery.coverage.test.ts` enforces component *presence*, not a11y. |
| Manual audit | 🔴 none | No screen-reader pass, no keyboard-only pass, no documented checklist (this section is the first). |

**The one-line gap:** good instincts and a few good hooks, but no measurement, no
automated gate, no convention, and the highest-risk surfaces (Operator Console, activity
stream) aren't built — so we specify the bar *before* they are, not after.

## 20.3 Requirements by area

All requirements are AA unless noted. "Component AC" in [§20.7](#207-per-component-acceptance-criteria)
makes these concrete per surface.

### 20.3.1 Keyboard navigation (WCAG 2.1.1, 2.1.2, 2.4.3, 2.4.7, 2.4.11)
- Every interactive control is reachable and operable by keyboard alone, in a logical
  order matching the visual layout.
- No keyboard traps. Any control that grabs focus (modal, menu, composer) can be left by
  keyboard.
- A visible focus indicator on every focusable element — not the UA default suppressed
  with `outline:none` and nothing in its place. Focus must not be *obscured* by sticky
  headers/footers (2.4.11, new in 2.2).
- A **skip-to-main-content** link as the first focusable element on each surface.
- Roving-tabindex for composite widgets (the activity stream list, the approvals queue,
  the file tree, tab bars) — Tab moves between widgets, arrow keys move within.
- Drag-only interactions (resizable panes via `useIsWide`, reordering) have a keyboard
  alternative (2.5.7).

### 20.3.2 Focus management (WCAG 2.4.3, 3.2.x)
- Opening a dialog/checkpoint sheet moves focus into it and **traps** focus until it
  closes; closing restores focus to the trigger (extend `useDialogA11y` to add the trap +
  `role="dialog"` + `aria-modal="true"` — see [§20.8](#208-shared-a11y-building-blocks)).
- Route/view changes (the `?view=` transitions in [12](./12-information-architecture.md))
  move focus to the new view's heading and announce the view name.
- No focus loss: when a streamed item that held focus is removed/collapsed, focus moves to
  a stable neighbor, never to `<body>`.

### 20.3.3 ARIA roles, landmarks & names (WCAG 1.3.1, 4.1.2)
- One `<main>`, plus `banner`/`navigation`/`contentinfo` landmarks per surface; the
  venture-scoped console uses `region` landmarks with `aria-label` for its panes
  (Activity, Approvals, Budget, Roadmap, Deployments).
- Every control has an accessible name (visible label, `aria-label`, or `aria-labelledby`).
  Icon-only buttons (pause, kill switch, approve) **must** carry a name — this is the most
  common current gap.
- Native semantics first; ARIA only where native HTML can't express the pattern. No
  `role` that contradicts the element. Prefer `<button>` over `<div onClick>`.
- State exposed programmatically: `aria-expanded`, `aria-pressed`, `aria-current`,
  `aria-busy` on the streaming console while a tick is in flight.

### 20.3.4 Color & contrast (WCAG 1.4.3, 1.4.11, 1.4.1) — ties to F9 tokens
- Text/icon contrast ≥ **4.5:1** (normal) / **3:1** (large ≥18.66px bold or 24px).
- UI component & state contrast ≥ **3:1** (1.4.11): button borders, input outlines, the
  focus ring, the budget meter fill, status chips.
- **Status is never color-only** (1.4.1): every venture status
  (building / awaiting approval / shipped / paused / blocked / over-budget-soon) carries a
  text label and/or shape/icon in addition to color — this is the a11y expression of
  [08 D2 "one-glance status"](./08-principles-tenets.md).
- **Contrast is a property of the design tokens, audited at the source.** Once F9 lands a
  **single token source** (CSS custom properties feeding both Tailwind and `kit/theme.ts`),
  each semantic token *pair* (`fg-on-surface`, `accent-on-bg`, `border-on-card`,
  `focus-ring-on-bg`, status chip fg/bg) carries a measured contrast ratio in the token
  catalog, and a unit test fails CI if any pair drops below its required ratio. This is the
  only durable way to keep AA from rotting as themes change ([F9 acceptance](../F-ENTERPRISE-FOUNDATIONS.md):
  "one token source of truth; axe passes in CI").

### 20.3.5 Reduced motion (WCAG 2.3.3) — D6
- Honor `prefers-reduced-motion: reduce` *globally*: a single base reset that neutralizes
  non-essential animation/transition, then opt specific, meaningful motion back in — rather
  than today's per-animation opt-out that's easy to forget on a new keyframe.
- Read the preference in JS via `useMediaQuery('(prefers-reduced-motion: reduce)')` so the
  activity stream and build animations can choose instant updates over animated ones.
- **Nothing essential is conveyed by motion alone** (08 D6): a build "in progress" pulse is
  decoration; the textual status and `aria-busy` are the signal.
- No content flashes more than 3×/second (2.3.1).

### 20.3.6 Screen-reader support for dynamic content
- Static content is correctly structured (headings form an outline; lists are lists; tables
  use `<th>`/scope). Dynamic content is announced via live regions — see
  [§20.5](#205-the-real-time-activity-stream) for the stream, the hard case.
- Loading/empty/error states are announced, not just rendered (the Studio shimmer must pair
  with an `aria-live` "loading…" / "loaded" message; today the shimmer is visual-only).
- Toasts/notifications use `role="status"` (polite) or `role="alert"` (assertive) per
  urgency — a budget-cap breach is assertive; a routine "deploy started" is polite.

### 20.3.7 Forms & error handling (WCAG 1.3.1, 3.3.1–3.3.4, 4.1.3)
- Every field has a programmatically-associated `<label>`; placeholder is never the only
  label.
- Errors are identified in text (not color/border alone), associated to the field via
  `aria-describedby`, and the field is marked `aria-invalid`. On submit failure, focus
  moves to the first error or to an `role="alert"` error summary that links to each field
  (3.3.1).
- Required fields are marked in text + `aria-required`. Format/constraint help is provided
  *before* the error (3.3.3).
- High-stakes actions (deploy to prod, raise a budget cap, delete a venture, billing
  changes — the re-auth set in [F3](../F-ENTERPRISE-FOUNDATIONS.md)) are reversible or
  confirmable (3.3.4 / 3.3.6) and never rely on a single mis-clickable control.

### 20.3.8 Time-out & idle (WCAG 2.2.1) — see [§20.6](#206-time-out-idle--re-auth)

## 20.4 The status-vocabulary contract

Because [08 D2](./08-principles-tenets.md) demands a status readable in under two seconds,
and 1.4.1 forbids color-only meaning, every status is defined once as a triple — **label +
icon/shape + token** — and reused everywhere:

| Status | Visible label | Non-color cue | SR text (when it changes) |
|---|---|---|---|
| Building | "Building" | spinner/`aria-busy` | "Venture {name} is building." |
| Awaiting approval | "Needs you" | badge + count | "Venture {name} needs your approval." (assertive) |
| Shipped | "Shipped" | check glyph | "Venture {name} shipped {what}." |
| Paused | "Paused" | pause glyph | "Venture {name} paused." |
| Blocked | "Blocked" | alert glyph | "Venture {name} is blocked: {reason}." (assertive) |
| Over-budget-soon | "Budget low" | meter near full | "Venture {name} is at {n}% of budget." |

## 20.5 The real-time activity stream

This is the product's signature surface and its hardest a11y problem. The Operator Console
streams a continuous, sometimes rapid feed of what the agents are doing (the "show your
work" trace, D1). Naively wrapping the whole feed in `aria-live="polite"` would make a
screen reader **read every new line aloud**, flooding the user and rendering the console
unusable. The requirements:

- **The full feed is a log, not a firehose announcement.** Use
  `role="log"` with `aria-live="polite"` on the stream container so AT *can* track new
  items, but tune what gets announced. Most routine ticks are **not** auto-announced; the
  user reads the log by navigating into it (it's keyboard-focusable with roving tabindex).
- **A separate, throttled summary region carries the announcements.** A small, visually
  optional `aria-live="polite"` "status" region announces *milestones and digests*, not raw
  ticks: "3 build steps completed," "Preview ready," "Awaiting your approval." Debounce/
  coalesce so announcements arrive at human pace (e.g., at most one every few seconds),
  honoring reduced-motion users' preference for calm.
- **Urgency escalates the politeness.** Routine progress is `polite`; a checkpoint that
  needs the human, a budget breach, or a blocked/failed run uses `role="alert"`
  (assertive) so it interrupts — these are the moments the product exists to surface.
- **User control over verbosity.** A per-user "announce: milestones only / everything / off"
  setting (persisted) lets power users and AT users choose their firehose. Default:
  milestones only.
- **Pause-on-interaction.** When the user is reading/operating within the stream, defer
  auto-scroll and announcements until they leave, so focus and reading position aren't
  yanked (no focus loss per §20.3.2).
- **Each item is independently legible.** A stream entry exposes time, actor (which agent),
  action, and outcome as text — not an icon row — so reading one line out of context still
  makes sense.

This design satisfies "legibility of autonomy" for AT without violating it by overload.

## 20.6 Time-out, idle & re-auth

The platform runs unattended; sessions and idle handling ([F3](../F-ENTERPRISE-FOUNDATIONS.md):
first-party sessions + idle/absolute timeouts) must be accessible (WCAG 2.2.1):

- **Warn before logout.** Before an idle timeout ends a session, show a dismissible warning
  with at least 20 seconds to extend, announced via `role="alert"`. Never log out mid-action
  silently.
- **Preserve work.** If a time-out does occur, the user's in-progress input (an intake
  prompt, a half-written approval note) is preserved on re-auth (2.2.5 AAA, adopted here as
  a quality bar — losing a user's text is a trust failure per P3).
- **Re-auth for sensitive actions** ([F3](../F-ENTERPRISE-FOUNDATIONS.md)) uses the same
  accessible dialog pattern (focus-trapped, labeled, keyboard-operable) — it must not be a
  modal the user can't complete with a screen reader.
- **Real-time revocation** (the `UserCoordinatorDO` "sign out everywhere" in
  [F4](../F-ENTERPRISE-FOUNDATIONS.md)) announces the state change rather than silently
  blanking the screen.

## 20.7 Per-component acceptance criteria

Each new surface ships only when its row passes. Existing shipped surfaces (Code Studio,
Settings) are retrofitted opportunistically; new venture surfaces are AA from day one.

| Component | Acceptance criteria (must all hold) |
|---|---|
| **Ventures Dashboard** | Skip link; `<main>` + landmarks; each venture card is a single focusable element with an accessible name = "{venture}, {status}, {budget}%"; status per §20.4 (never color-only); keyboard reorder if drag exists. |
| **Operator Console** | Panes are labeled `region`s; tab between panes via keyboard; activity stream per §20.5 (`role="log"`, throttled summary region, urgency→alert); `aria-busy` while a tick runs; budget meter has a text value + 3:1 fill contrast. |
| **Checkpoint / approval sheet** | Focus-trapped `role="dialog"` w/ `aria-modal`; decision, why, diff/impact, **and cost** all in the accessible name/description (D3, D4); Approve/Deny/Adjust are real `<button>`s with names; Escape closes and restores focus; opens with focus on the heading. |
| **Budget meter & spend** | Value exposed as text (not just a bar); `role="meter"` or `progressbar` with `aria-valuenow/min/max`; "over-budget-soon" announced assertively; fill ≥3:1. |
| **Intake / onboarding form** | Labels associated; required marked in text + `aria-required`; error summary `role="alert"` on submit; per-field `aria-invalid` + `aria-describedby`; focus to first error. |
| **Connections / integrations** | Connection health/expiry stated in text (not just a colored dot); connect/disconnect buttons named; OAuth popups don't strand keyboard focus. |
| **Code Studio (retrofit)** | File tree as `tree`/`treeitem` with arrow-key navigation + roving tabindex; tabs as `tablist`/`tab`/`tabpanel`; resizable panes have a keyboard size control or sensible default; preview iframe has a `title`. |
| **Notifications / toasts** | `role="status"` (polite) or `role="alert"` (assertive) by urgency; dismissible by keyboard; don't auto-dismiss faster than readable (no hard limit, or user-extendable). |
| **Dialogs/menus (kit)** | Use the extended `useDialogA11y` (trap + restore + `aria-modal`); menus are `menu`/`menuitem` with arrow keys + Escape. |

## 20.8 Shared a11y building blocks

Reuse over rebuild ([08 P6](./08-principles-tenets.md)). The kit already has the seeds;
F9's a11y program ([F9](../F-ENTERPRISE-FOUNDATIONS.md)) grows them into a small,
test-enforced set used everywhere:

- **`useDialogA11y` (extend, don't fork):** add an opt-in **focus trap** + initial-focus
  target + `role="dialog"`/`aria-modal` wiring, keeping today's Escape-close and focus
  restoration. Every modal/sheet/checkpoint uses it.
- **`useMediaQuery` / `useIsWide` (reuse):** already powers responsive layout; add a
  `useReducedMotion()` wrapper over `useMediaQuery('(prefers-reduced-motion: reduce)')` so
  the stream/build views can branch to instant updates.
- **`useLiveAnnounce()` (new):** a tiny hook owning the throttled polite/assertive live
  regions described in §20.5, so any feature can announce without each re-implementing live
  regions (and re-introducing the flood bug).
- **`<SkipLink>`, `<VisuallyHidden>`, `<FieldError>` (new primitives):** in the growing
  `components/ui/` library (F9), with gallery demos per [CLAUDE.md](../../../../CLAUDE.md)'s
  living-gallery rule.
- **Global reduced-motion reset** in `index.css`: one base rule, with explicit opt-ins —
  replacing the per-animation guards that are easy to miss on new keyframes.

## 20.10 Automated testing + manual audit

Per F5/F9, accessibility becomes a CI gate, not a courtesy ([08 E6](./08-principles-tenets.md)).

**Automated (in CI, blocking):**
- **`axe-core`** via `jest-axe`/`vitest-axe` over the **living gallery**
  ([CLAUDE.md](../../../../CLAUDE.md)) and each new surface's component test — every demo
  must pass axe with zero violations of the rules mapped to AA. This extends the existing
  `gallery.coverage.test.ts` discipline from "exists" to "is accessible."
- **Token contrast unit test** (§20.3.4): asserts every semantic token pair meets its
  required ratio; fails CI on regression.
- **Playwright a11y pass** (F5 E2E): `@axe-core/playwright` on the real, rendered
  Dashboard / Console / checkpoint / intake happy-paths, where axe can catch contrast and
  ARIA issues unit-rendered DOM can't.

Automated tools catch ~30–40% of issues; the rest is manual.

**Manual audit (each new surface, recorded in STATUS):**
- [ ] **Keyboard-only** full pass: every action reachable, logical order, visible focus, no
      trap, focus never obscured, skip link works.
- [ ] **Screen reader** pass on **two** stacks (e.g., VoiceOver/Safari + NVDA/Firefox):
      landmarks navigable, all controls named, status changes announced, **the stream does
      not flood**, forms/errors announced.
- [ ] **200% zoom / 400% reflow** (1.4.10): no loss of content/function, no horizontal
      scroll at 320px-equivalent.
- [ ] **Reduced-motion on**: no essential info lost, no unguarded animation plays.
- [ ] **Forced-colors / high-contrast mode**: nothing disappears (borders/focus survive).
- [ ] **Color-only check**: every status still distinguishable in grayscale.

## 20.11 Acceptance checklist

A surface is accessibility-Done when **all** hold (this is the gate referenced by
[08 §8.6.1](./08-principles-tenets.md) item 5):

- [ ] Targets and meets **WCAG 2.2 AA** for the surface (no known AA violations).
- [ ] **axe passes with zero violations** in the component test + gallery demo + Playwright
      pass; CI is green.
- [ ] **Token contrast test passes** — every token pair the surface uses meets its ratio.
- [ ] **Keyboard-only** manual pass complete and recorded: reachable, ordered, visible
      focus, no trap, skip link present.
- [ ] **Screen-reader** manual pass on two stacks complete: landmarks, names, announced
      state changes; **activity stream verified not to flood** (milestones-only default).
- [ ] **Focus management** verified: dialogs trap + restore; view changes move focus; no
      focus loss on stream churn.
- [ ] **Status is never color-only** (§20.4 triple present everywhere status appears).
- [ ] **Reduced motion** honored globally; nothing essential conveyed by motion alone.
- [ ] **Forms** have associated labels, in-text errors, `aria-invalid`/`describedby`, and
      focus-to-error on failure.
- [ ] **Idle/time-out** warns before logout, preserves input, and re-auth is operable by
      AT.
- [ ] **Reflow/zoom** to 200%/400% with no loss; forced-colors safe.
- [ ] Manual audit results recorded in STATUS with a one-line proof (per
      [08 §8.6.1](./08-principles-tenets.md) item 7).

> Accessibility here is the same requirement as the product's core promise — *legibility
> of autonomy* and *honest by construction* — expressed for assistive technology. A surface
> that an AT user can't read the status, cost, or approval of is not honest, and is
> therefore not done.
