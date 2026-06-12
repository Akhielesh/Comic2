# Comic Studio — the finalized creation flow

_June 2026: Comic Studio was recommitted as a shareable product. This doc is the
single source of truth for its design flow and structure. The experimental
ComicForge pipeline and the admin Test Lab were removed the same week (see ADR
0004); the classic engine is THE engine._

## The flow: three stages, seven live steps

The Story-Planning review and the manual panel-Preview stages were **removed**
(June 2026, owner feedback: "remove the story scenes section entirely… auto
generate the panels, don't ask the user"). Scene analysis runs silently inside
Script; panel planning runs automatically inside the Build. Their `AppStep`
enum values stay reserved and both the load-time migration
(`hooks/useProjectManager.ts`) and a runtime remap in `ComicEditor` route any
project saved on a removed step onto its live neighbour.

| Stage | Steps inside | What the user does | Required? |
|---|---|---|---|
| **1 · Story** | Script → Style | Paste/write the script, click Analyze; pick a style card | Script + style choice |
| **2 · World** | Cast → Cover | Review auto-extracted characters/items/locations; optional cover (full trade dress: title masthead rendered in-image) | All optional |
| **3 · Pages** | Layout → Build → Done | Pick a layout + answer "how many pages?"; click **Generate my comic**; review/retry/publish | Layout + generate |

Minimum path to a finished comic: **analyze script → pick style → generate**
(3 clicks). Everything else has a default. Page count drives the automatic
panel plan: `pages × layout panels-per-page`, spread evenly across scenes
(clamped 1–8 per scene, `services/generationManager.ts`).

Navigation rules (`components/ComicEditor.tsx`): forward motion follows
`STEP_SEQUENCE` and is gated by `advanceBlockReason` (scenes exist, style
chosen); backward motion is free up to `maxStepReached`, and editing an
upstream step snapshots the current state into Version History before
resetting downstream work (`services/pipelineReset.ts`). Confirming Layout is
the single spend gesture — it launches the build directly.

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
`/api/text/panel-breakdown` — `pageCount × layout panels-per-page` spread
across scenes (3 per scene when no page count was set), grounded in the
continuity bible + the running summary. This is the ONLY panel-planning path
now (the manual Preview stage is gone).

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
  pro-tier upgrade. The user's own selection (Settings → API & Models, or the
  Models page) always wins. The legacy "Flux Schnell (Pixazo Free)" entry was
  removed from every picker/pricing surface; `fluxService` keeps the id only
  as an internal transport constant. (`services/imageModels.ts`)
- Covers are the one stage allowed to render in-image text (title masthead,
  tagline, issue badge) — the global no-text blocker exempts `stage: 'cover'`,
  and each cover template carries a typography direction
  (`services/coverTemplates.ts`).
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
