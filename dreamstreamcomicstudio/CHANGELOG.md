# Changelog

All notable user-facing changes. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). Newest first.

## [Unreleased]

### Added
- Documentation architecture under `docs/` — `README.md` (index), `ARCHITECTURE.md`,
  `decisions/` (ADRs 0001-0003), and `SOLUTION_LOG.md` (problem→solution history).
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
