# Comic Studio — the finalized creation flow

_June 2026: Comic Studio was recommitted as a shareable product. This doc is the
single source of truth for its design flow and structure. The experimental
ComicForge pipeline and the admin Test Lab were removed the same week (see ADR
0004); the classic engine is THE engine._

## The flow: three stages, nine steps under the hood

Users see **three stages** (StepIndicator groups them; the `AppStep` machine in
`types.ts` is unchanged, so existing projects resume exactly where they were):

| Stage | Steps inside | What the user does | Required? |
|---|---|---|---|
| **1 · Story** | Script → Plan → Style | Paste/write the script, click Analyze; accept the recommended plan; pick a style card | Script + style choice |
| **2 · Cast** | World → Cover | Review auto-extracted characters/items/locations; optionally upload/generate reference art; optional cover | All optional |
| **3 · Pages** | Layout → Preview → Build → Done | Pick a layout (default grid works); confirm the panel plan; generation runs; review/retry/publish | Confirm + generate |

Minimum path to a finished comic: **analyze script → pick style → confirm
layout → confirm preview → build** (5 clicks). Everything else has a default.

Navigation rules (`components/ComicEditor.tsx`): forward motion is gated by
`advanceBlockReason` (scenes exist, style chosen, panels planned); backward
motion is free up to `maxStepReached`, and editing an upstream step snapshots
the current state into Version History before resetting downstream work
(`services/pipelineReset.ts`).

## Generation: what actually happens on Build

`services/generationManager.ts` orchestrates; images render server-side via
`/api/image/*` (`services/imageService.ts` picks the model).

**Phase 0a — auto style anchor (new).** If no style image is locked, one
"style exploration board" is generated from the chosen style prompt and locked
as the run's style reference. Strict mode used to hard-fail here
(`STRICT_STYLE_LOCK_UNRESOLVED`); now it self-heals.

**Phase 0b — auto reference sheets (new).** `collectAutoReferenceTasks`
(`services/autoReferences.ts`) lists every character without a visual anchor
plus every binding-flagged location/item (capped at 10/run). Each gets a
turnaround/concept sheet (`character_sheet`/`world` prompt stages,
`CHARACTER_SHEET_MODEL`, style anchor + user uploads as references, 3 in
parallel). Results are written onto the entities, the continuity bible is
rebuilt, and every panel prompt from then on carries real reference images.
**This is the character-consistency linchpin: reference packs were empty for
most users because building references was a manual, skippable step.**

**Phase 1 — per-scene panel breakdown.** Scenes lacking a plan get one from
`/api/text/panel-breakdown` (3 panels default), grounded in the continuity
bible + the running summary.

**Phase 2 — batched panel rendering.** 4 panels in flight; each panel builds a
reference pack (entity sheets first, then location, prior panel, style — max
8), a structured prompt (mood guardrail, shot/camera/composition, continuity
lock), and renders on a reference-capable model (`resolveLockedPanelModelId`
forces one if the configured model can't take references). Failures are
isolated: the panel is saved with `failureReason` and retried from Done.

**Phase 3 — continuity summary update** per scene (rendered panels only), then
metrics + a generation insight record.

### Soft gates instead of dead ends (the reliability fix)

The two pre-run hard stops ("Failed: style lock" / "Failed: missing reference
images") are gone. After Phase 0 auto-fixes, any *remaining* continuity issue
logs honestly and the run continues — per-panel strict checks still flag
affected panels for individual retry. A run now always produces a reviewable
comic; the worst case is some flagged panels, never a blocked build.

## Models

- Panels/covers/sheets: `gemini-2.5-flash-image` (Nano Banana) by default —
  reference-capable. `gemini-3-pro-image-preview` (Nano Banana Pro) is the
  pro-tier upgrade. Flux Schnell remains the free no-reference fallback for
  style boards. (`services/imageModels.ts`)
- Text stages (analysis, planning, breakdown, continuity): stage-resolved via
  `server/src/ai/stageModels.ts`.

## Persistence & sharing

One `projects` row holds the full `ComicState` (panels carry their own
continuity + image history). Publish = `isPublic` flag → readable at
`/read?id={projectId}` (`ComicReader`), or share-token links via
`SharedViewer` (`share_tokens`). RLS: owners write, public reads published.

## Gotchas

- Phase 0 spends images (≤ 1 style anchor + ≤ 10 sheets) before any panel
  renders — visible in the build log lines (`Creating reference sheets…`).
- Legacy projects with `pipelineMode: 'comicforge'` open in the classic editor
  (coerced in `App.tsx handleOpenProject`); their state predates this flow but
  the step machine is the same.
- `FEATURE_FLAGS.ENABLE_CHAR_SHEETS` (`services/modelPolicy.ts`) turns Phase 0b
  off if reference-sheet spend ever needs a kill switch.
