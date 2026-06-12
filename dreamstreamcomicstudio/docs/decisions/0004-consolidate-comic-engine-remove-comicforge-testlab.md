# ADR 0004 — Consolidate on the classic comic engine; remove ComicForge and Test Lab

- Status: Accepted (June 2026)
- Owner decision: Comic Studio is recommitted as a shareable product ("I want to
  share that with a few people"); the flow must reliably produce comics.

## Context

Two generation engines coexisted. The **classic engine** (client-orchestrated,
`services/generationManager.ts`) is live and works. **ComicForge**
(`server/src/comicforge`, BullMQ/Redis, 11 approve-every-stage screens) was
half-wired: core generation tasks stubbed to no-ops, model router pointing at
retired model ids, no queue consumer in the server process, UI polling only
partially fixed, disabled by default behind `COMICFORGE_ENABLED`. The June 2026
audit (`docs/COMIC_GENERATION_AUDIT.md`) documents all of this. Meanwhile the
admin-only Test Lab duplicated what the bench/verification systems now do.

The 2025 OVERHAUL_PLAN (Track B) chose ComicForge's async base as the
consolidation target. That bet did not pay off — a year later it still had no
working generation path, while the classic engine kept improving (continuity
bible, reference packs, style lock, mood guardrails).

## Decision

1. **The classic engine is THE comic engine.** ComicForge is deleted: client
   screens, services, server pipeline/routes/worker, config flags, env vars.
   `PipelineMode` narrows to `'classic' | 'pagestudio'`; stored projects with
   `pipelineMode: 'comicforge'` are coerced to the classic editor on open.
   ComicForge-only DB tables (`generation_jobs`, `panel_lettering`) are left in
   place (harmless, no code references) — dropping them is an ops cleanup, not
   a code concern.
2. **Test Lab is removed entirely** (component, services, `/testlab-report`
   endpoint, `testlab_report` stage).
3. **Reliability over gates** in the classic engine: pre-run hard stops for
   unresolved style locks and missing references are replaced by Phase 0
   auto-generation (style anchor + character/world reference sheets) and
   honest soft-continue logging. See `docs/features/comic-studio.md`.
4. **The flow is presented as three stages** (Story / Cast / Pages) over the
   unchanged 9-step machine.

## Consequences

- One engine to maintain, test, and improve; ~6k LoC and a Redis-coupled
  worker path removed from the comic surface.
- Supersedes OVERHAUL_PLAN Track B (engine consolidation onto ComicForge).
  The plan doc stays as read-only history per docs convention.
- Character consistency now depends on Phase 0 reference sheets; its cost
  (≤ 11 extra images/run, flag-gated by `ENABLE_CHAR_SHEETS`) is accepted as
  the price of comics that look coherent by default.
- Redis/BullMQ remains for other consumers (ventures); the comic path no
  longer needs it.
