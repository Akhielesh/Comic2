# Changelog

All notable user-facing changes. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). Newest first.

## [Unreleased]

### Added
- **Autopilot workstream — plan only (2026-06-07):** defined the always-on autonomous
  ventures layer (idea → roadmap → continuous build/test/deploy/iterate, 24/7, with hard
  budgets + human checkpoints, hybrid hosting via managed previews + BYO accounts through
  Nango, and central Stripe billing). New docs under `docs/studio/autopilot/`:
  `00-MASTER-PLAN.md` (vision delta, architecture, security/multi-tenancy, hosting adapters,
  billing, the A0–A9 epic backlog), `OPERATING-MODEL.md` (how Claude builds it continuously +
  safety gates), `STATUS.md` (living tracker). Wired into `docs/studio/00-STATUS.md` and
  `09-ROADMAP.md`. **No code yet** — Epic A0 (budgets/kill-switch/checkpoints/audit) is next,
  flag-gated (`VENTURES_ENABLED` off) + admin-only, on owner go-ahead. Owner decisions locked:
  hybrid hosting, generalize the studio, continuous-with-checkpoints autonomy, extend this repo.
- **Code Studio (Sprint 0):** a dedicated, dark, animated workspace route — a 3-pane shell
  (prompt/build · code · live preview) with a working "Run live". Code apps in AI Chat now
  hand off with a single **"Open in Code Studio"** button. Admin-gated private preview;
  others can still preview an app instantly. Built on a new motion design system
  (`components/studio/kit/`) that respects reduced-motion.
- Model Library: live OpenRouter catalog, **compare up to 5** models, and
  **"Use this model"** (quick confirm) to set your image/text model.
- Universal Assistant runs on a **free** OpenRouter model with an anti-hallucination
  guardrail.
- **Free public comics** — anyone can read any comic without an account (commenting/
  liking still require login).
- **Onboarding readiness checklist** on the dashboard — flags missing account / API key /
  model with one-click fixes; hides when ready.
- Documentation architecture under `docs/` — `README.md` (index), `ARCHITECTURE.md`,
  `decisions/` (ADRs 0001-0003), `features/`, and `SOLUTION_LOG.md`.
- **Settings → API Configuration:** add multiple keys per provider, pick one active
  per provider, and set a per-key monthly limit with usage meters. Generation is
  blocked on a key once it reaches its limit (ADR 0003).
- Header usage pill now shows the **active key's** usage with a hover card (provider,
  spend vs. limit %, and the models in use) — replaces the CT credits pill.
- OpenRouter BYOK: enter your own OpenRouter key in Settings; live image generation
  runs on your key when set.
- Accurate per-comic cost using OpenRouter's real reported cost; "Actual API cost"
  shown in Review/Export.
- OpenRouter generation routes (`/api/text/generate`, `/api/image/openrouter`) and a
  smoke test (`npm run openrouter:smoketest`).

### Changed
- Notifications redesigned to the house style (legible, on-brand) with relative
  timestamps and a clear unread count.

### Removed
- Subscription pricing section from the home page.
- Billing tab from Settings, and the CT credits pill from the header.
  (Billing backend is kept dormant — see ADR 0002.)
- Duplicate notification bell on the dashboard (the global header provides one).
