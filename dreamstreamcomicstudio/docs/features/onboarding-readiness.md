# Onboarding Readiness Checklist

`components/ReadinessChecklist.tsx` — a guided setup checklist that makes blockers
explicit (instead of the app looking "ready" and then failing mid-flow).

## What it checks

1. **Account** — signed in? Reading is free, but creating/saving needs an account.
   Fix → `auth`.
2. **API key** — is there an active key (any provider; OpenRouter recommended)? Warns if
   the active key is over its per-key monthly limit. Fix → `settings` (API Configuration).
3. **Image model** — is an image model usable? Satisfied by a specific choice **or** an
   active OpenRouter key (default works). Fix → `models` (Model Library).

Each unmet item shows a short "how to fix" and a one-click action button that navigates
to the right place.

## Behavior

- Rendered at the top of the dashboard (`ProjectDashboard`).
- **Hides itself when everything is ready** (no clutter), and can be dismissed for the session.
- Re-evaluates on window focus, so it updates after you add a key / pick a model and return.

## Extending

Add a check by pushing a `CheckItem` in `buildItems()` with `status` (`done|todo|warn`),
`help`, and an optional `action: { label, view }`. Keep checks cheap (they run on render).
