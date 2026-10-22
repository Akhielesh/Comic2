# Ventures (Autopilot)

The Autopilot / Ventures layer: an idea becomes a venture with a roadmap of goals, budgets,
human checkpoints and an append-only event log, worked by a governed tick loop.

> **Build stage retired (2026-10-22, [ADR 0005](../decisions/0005-retire-code-studio.md)).**
> The loop's ACT step built apps with Code Studio's generator. Code Studio is retired, and the
> build stage went with it. What that means today:
>
> - **Still works:** intake (idea → roadmap, `POST /api/ventures/intake`), goals, budgets,
>   checkpoints, signals, the event log, the kill switch and the Operator Console (`?view=ventures`).
> - **Retired:** building. A tick pauses an active venture once (`pause_reason = 'build_retired'`,
>   one `venture.paused` event, no spend). Approving a roadmap leaves the venture paused, and
>   `PATCH /api/ventures/:id/status {"status":"active"}` answers **410 `VENTURES_BUILD_RETIRED`**.
> - **Flags in production:** `VENTURES_ENABLED=false` (admins still get in) and
>   `VENTURES_PILOT_INLINE=false` (no in-process tick loop).
> - **Data:** every venture table was empty when this happened; nothing was migrated.
>
> Code: `server/src/ventures/` (`tickRunner.ts` is the retired ACT step, `intakeModel.ts` the
> intake model call), `server/src/routes/ventures.ts`, `components/ventures/OperatorConsole.tsx`.
> `server/src/ventures/noCodeStudioImports.test.ts` keeps Ventures free of Code Studio imports.

## What is in this folder

These docs moved here from `docs/studio/autopilot/`. They describe the **target design** written
while the build stage was planned, not the current state. Where they say "the studio", "build" or
"deploy", read it as design history. Links to Code Studio docs and source files that were deleted
are left as plain text marked "removed with Code Studio".

| Doc | What it is |
|---|---|
| [00-MASTER-PLAN.md](00-MASTER-PLAN.md) | The original plan: epics, guardrails, hosting model |
| [STATUS.md](STATUS.md) | The living tracker as of the last Autopilot work |
| [OPERATING-MODEL.md](OPERATING-MODEL.md) | How ventures were meant to run day to day |
| [ARCHITECTURE-CLOUDFLARE.md](ARCHITECTURE-CLOUDFLARE.md) | Target Cloudflare topology |
| [F-ENTERPRISE-FOUNDATIONS.md](F-ENTERPRISE-FOUNDATIONS.md) | F0–F10 foundations backlog |
| [GO-LIVE-RUNBOOK.md](GO-LIVE-RUNBOOK.md) | Go-live steps written for the build stage |
| [SPEC-INDEX.md](SPEC-INDEX.md) | Index of the 55-part spec in [`spec/`](spec/) |
