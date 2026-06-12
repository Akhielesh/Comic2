# Comic Generation Audit — logic, flow & bugs

> Audit of the comic-generation pipelines: why the staged flow ("stages") does
> not work, plus secondary issues in the live pipeline. Dated 2026-06-02.

> **HISTORICAL (2026-06-12):** ComicForge was removed entirely per ADR 0004 —
> the classic engine is the only engine, with new Phase 0 auto-references and
> soft gates. Current truth: `features/comic-studio.md`. This audit is kept as
> the record of why.

The repo has **two** generation systems:

1. **ComicForge** — the staged studio (`components/comicforge/`,
   `server/src/comicforge/`, `services/comicforge/`). This is the one with a
   locked stage-stepper UI and is the subject of "the stages are not working."
2. **Classic / live** — `services/generationManager.ts` →
   `components/steps/`. This is the path actually wired to real model calls.

---

## A. Root cause — ComicForge is a dormant scaffold, not a working pipeline

It is feature-flagged **off** by default (`COMICFORGE_ENABLED=false`,
`server/src/config.ts:140`) and its model router is explicitly marked
**DEPRECATED** (`server/src/comicforge/modelRouter.ts:1-14`). Beyond the flag,
the stages cannot work for several independent reasons.

### 1. The generation work is entirely stubbed — nothing is ever produced
- The worker no-ops the core tasks: `panel_gen_draft`, `panel_gen_final`, and
  `thumbnail_gen` all fall through to `{ completed: true }` with no image call
  (`server/src/comicforge/worker.ts:37-44`).
- The three sub-workers are hardcoded stubs: `runAssemblyWorker` →
  `{assembled:true}`, `runLetteringWorker` → `{lettered:true}`, `runQcWorker`
  → `{qcPassed:true}` (`server/src/comicforge/workers/*.ts`).
- Even the non-job stages call no AI — `analyzeScript`, `buildArchitecture`,
  `suggestStyles`, `buildStyleBible` are deterministic heuristics (regex cast
  extraction at `pipelineService.ts:67-71`, fixed beat sheet at `:352-359`,
  canned style list at `:102-137`). Every stage emits placeholder data.
- `modelRouter.ts` routes to **retired** model ids (`gemini-2.5-pro`,
  `pixazo/flux-1-schnell`, `gemini-3-pro-image-preview`) that 404 against the
  live OpenRouter gateway — and nothing actually calls the gateway anyway.
  `promptLibrary.ts` is dead code (never imported).

### 2. Job-based stages dead-end in the UI — completion is never observed
- `getJobStatus`/`getJobEvents` exist in `services/comicforge/api.ts:127-130`
  but were **never called** anywhere in the frontend — no polling, no
  `EventSource`.
- `lastJob` was set once at enqueue time (status `queued`) and never refreshed,
  so `canApprove = latestJob?.status === 'done'`
  (`components/comicforge/GenerationScreen.tsx:24`) was never true → "Approve
  Generation" stayed disabled → the user could never advance to QC/Export. Same
  dead-end for Storyboard (thumbnails) and Export.
- **Fixed** in this change: `ComicForgeStudio` now polls `getJobStatus` until a
  terminal state (see Fixes below). Note this only helps when a queue + worker
  are actually running (see A3/A4).

### 3. Nothing consumes the queue in the server process
- `startComicForgeWorker` is only invoked when
  `server/src/comicforge/worker.ts` runs as its own process
  (`npm run comicforge:worker`, `worker.ts:96-101`). `server/src/index.ts`
  never starts it. If that separate process is not deployed, every enqueued job
  sits `queued` forever.

### 4. Hard Redis dependency that is unmet
- `generate`, `generate-thumbnails`, `export`, `regenerate`, `assemble`,
  `render-lettering`, and job status/events are gated by
  `requireComicForgeQueue` (`server/src/routes/comicforge.ts`). With
  `REDIS_URL` unset they return **503 `COMICFORGE_QUEUE_UNAVAILABLE`**. The
  whole generation half is offline before anything above matters.

---

## B. Concrete contract / flow bugs in ComicForge

1. **QC stage always failed with 400.** `ComicForgeStudio.tsx` called
   `runQc(firstPageId, { pageId })` with no `projectId`, but the route requires
   `req.body.projectId` (`routes/comicforge.ts:363-365`). **Fixed** —
   `projectId` is now sent and added to `ComicForgeRunQcRequest`. (The `pageId`
   is still hardcoded to `'page-1'`; revisit once real pages exist.)
2. **Unused-but-broken routes.** `regeneratePanel`, `assemblePage`,
   `renderLettering`, `patchPanelLettering` require `projectId` in the body, but
   the `api.ts` wrappers never send it — they would 400 if wired. Left as-is
   (no caller today); fix when those features are built.
3. **Approval gating creates a terminal lock.** `isStageUnlocked` requires the
   previous stage's `approved` flag (`store.ts:60-65`); Generation/Storyboard
   approval depends on a job reaching `done`. With polling fixed this now
   resolves *when a worker runs*; without a worker it still locks.
4. **Dual source-of-truth state clobbering.** Both the client store (persisted
   via `onUpdateProject` → `project.state.comicforge`) and the server
   (`writeComicForgeState`, `repositories.ts:97-119`) write the **same**
   Supabase column from opposite directions (last-writer-wins). Server methods
   read server state for cross-stage deps (e.g. `buildArchitecture` needs
   `analysis`, `pipelineService.ts:344`) while the client re-persists its own
   copy on every action — a race that can drop `analysis`/`architecture` or
   reset `stage`/`approvals`. Recommend a single owner (server) with the client
   reading server state, or scoping the client to write only stage/approvals.
5. **In-memory job store is fragile.** Jobs live mainly in `inMemoryJobs`
   (`repositories.ts:52`); `updateGenerationJob` throws `Job not found` if the
   entry is gone (`:335`). A server restart between enqueue and status-check
   breaks the job permanently.
6. **Malformed SSE terminator.** `routes/comicforge.ts` wrote literal
   backslashes (`'event: done\\ndata: {}\\n\\n'`). **Fixed** to real newlines.

---

## C. Classic pipeline (`services/generationManager.ts`) — secondary

This path works; the issues below are quality, not stage failures.

1. **Progress math corrupts when resuming.** Initial estimate is
   `existingPanels.length || scenes*3` (`:248`), but per-scene replanning does
   `totalPanelsEstimate = totalPanelsEstimate - 3 + breakdown.length` (`:329`)
   — the `-3` only holds when the estimate was `scenes*3`. Resuming with
   existing panels skews the total (can go negative), so progress % and ETA are
   wrong.
2. **Unbounded accumulation.** `recentPanelImageIds` /
   `recentPanelDescriptions` grow for the whole run and are only sliced on read.
3. **Continuity summary uses planned `breakdown`** including panels that failed
   to render (`:598-601`), so the running summary can describe panels that do
   not exist.

---

## Fixes applied in this change

- `apiTypes.ts` — `ComicForgeRunQcRequest` now includes `projectId`.
- `components/comicforge/ComicForgeStudio.tsx` — send `projectId` in `runQc`;
  add job-status polling so job-backed stages observe `done`/`failed` and unlock
  approval.
- `server/src/routes/comicforge.ts` — correct the SSE `done` frame newlines.

## Phase 2 — build-out applied in this change

Done (live image generation + worker wiring):

1. **In-process worker** — `server/src/index.ts` now starts the ComicForge
   worker when `COMICFORGE_ENABLED && REDIS_URL` (dynamic import, failures
   logged, never crash the API). The standalone `comicforge:worker` process
   still works for dedicated deployments.
2. **Real generation via the live gateway** — new
   `server/src/comicforge/generation.ts` drives the OpenRouter gateway with the
   platform key (no `req` needed), resolves the model through the capability-aware
   `resolveStageModel('image_generation', …)` (NOT the deprecated `modelRouter`
   table), builds a NO-TEXT-guarded prompt per planned page from the style
   bible + architecture, and persists each image via `persistGeneratedImage`.
3. **Worker dispatch** — `worker.ts` routes `thumbnail_gen` / `panel_gen_draft`
   / `panel_gen_final` (without an `operation`) to real generation with live
   progress events; the stub fall-through remains only for the not-yet-built
   assemble/lettering/export operations.
4. **Job payload** — `queueJobForTask` now threads `userId` so the worker can
   read project state and persist images under the owning user.

### Phase 3 — assemble/lettering/export + real text stages (follow-up branch)

Done:

1. **Real text stages** (`server/src/comicforge/textStages.ts`) — `analyzeScript`,
   `buildArchitecture`, `suggestStyles`, `buildStyleBible` now call the live
   gateway (platform key, model via `resolveStageModel`, JSON-schema output) and
   **fall back to the existing heuristic** when no key is set or a call fails, so
   the stages still work offline. `analyzeScript` preserves structural fields and
   only upgrades the semantic ones.
2. **Real sub-workers** — `assemblyWorker` resolves a project's generated page
   images into an ordered page set; `letteringWorker` composites caption/dialogue
   boxes onto a page via sharp + an SVG overlay (correct no-content pass when no
   dialogue exists yet); `exportWorker` packages pages into a downloadable ZIP +
   manifest uploaded to storage. Shared reads via `workers/pageAssets.ts`.

Still TODO before GA:

1. Per-panel grid composition (generation currently emits full-page images, so
   "assembly" is page-level); populate real dialogue/balloon zones so lettering
   renders actual text; add PDF / webtoon vertical-stitch export presets.
2. Meter worker generation through a job-level billing ledger (it currently
   bypasses the per-request `usageEnforcer` — platform-funded, experimental).
4. Pick a single source of truth for ComicForge state and remove the dual write
   (client store vs. server `writeComicForgeState`).
5. Persist jobs durably (Supabase `generation_jobs`) rather than in-memory.

> Not runtime-verified here: this environment has no `REDIS_URL`, no
> `OPENROUTER_API_KEY`, and no Supabase config, so the worker path typechecks
> and is wired correctly but was not executed end-to-end. Validate with a real
> queue + platform key + Supabase before enabling.

## Phase 2 — classic pipeline fixes applied

- **Progress estimate** (`generationManager.ts`) — seed `totalPanelsEstimate`
  per-scene (real plan length, else 3) so the `-3 + breakdown.length`
  adjustment stays correct on resume instead of skewing the %/ETA.
- **Bounded memory** — cap `recentPanelImageIds` / `recentPanelDescriptions` to
  the continuity window (`MAX_CONTINUITY_PANELS`) instead of growing per panel.
- **Continuity summary** — summarize only panels that actually rendered for the
  scene (exclude failed/image-less panels) so the running summary can't describe
  panels that don't exist.
