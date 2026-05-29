# Changelog

All notable user-facing changes. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). Newest first.

## [Unreleased]

### Added
- Documentation architecture under `docs/` — `README.md` (index), `ARCHITECTURE.md`,
  `decisions/` (ADRs), and `SOLUTION_LOG.md` (problem→solution history for future agents).
- OpenRouter BYOK: enter your own OpenRouter key in Settings; live image generation
  runs on your key when set.
- Accurate per-comic cost using OpenRouter's real reported cost; "Actual API cost"
  shown in Review/Export.
- User-settable monthly spend cap + in-app usage alerts at 80%/100% thresholds.
- OpenRouter generation routes (`/api/text/generate`, `/api/image/openrouter`) and a
  smoke test (`npm run openrouter:smoketest`).

### Changed
- Notifications copy is legible for usage alerts (no more generic "System notification").

### Removed
- Subscription pricing section from the home page (billing backend kept dormant;
  see ADR 0002).

### In progress
- API Configuration redesign: multiple keys per provider with per-key usage limits.
- Replace the CT/credit usage pill with a per-key usage view.
- Notifications section visual redesign + fix duplicate bell in Studio.
