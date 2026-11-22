# SPRINT-01 — Comic Document model + migration

**Status:** 📋 planned
**Goal:** One canonical `ComicDoc` (the solid base template) exists, persists, autosaves,
and **old projects migrate into it and still open**.
**Depends on:** Sprint 0.
**Flags:** `VITE_COMICDOC_ENABLED` (default false until parity) — new projects can be
born as `ComicDoc` behind it; migration is read-only-safe regardless.

## Why
Everything else (quick engine, editor, edit ops) reads/writes this model. Get the shape
right and additive; never destructive. See `03-ARCHITECTURE.md` §1 for the schema.

## Tasks

### 01.1 — Define the schema (types)
- **Do:** Add the `ComicDoc` types from `03-ARCHITECTURE.md` §1 to `types.ts` in a new
  clearly-marked section: `ComicDoc, BookMeta, Intake, StyleBible, AssetCard,
  ContinuityGraph, Page, Panel, LayoutSpec, Layer (union), LayerBase, RasterLayer,
  InpaintLayer, BubbleLayer, TextLayer, ImageOverlayLayer, FxLayer, Transform, Rect,
  ReferencePack, Provenance, DocJob, HistoryEntry, DocFlags`. Bump `ComicDoc.v = 1`.
- **Files:** `types.ts`.
- **Accept:** `npm run typecheck` clean; types exported and importable.
- [ ] done

### 01.2 — Doc service (read/write/normalize)
- **Do:** `services/comicDoc/index.ts` — `createEmptyDoc(meta)`, `normalizeDoc(any)`,
  selectors (`getPage`, `getPanel`, `getLayer`, `panelsForPage`), and pure mutators
  (`addLayer`, `updateLayer`, `removeLayer`, `reorderLayer`, `setPanelRaster`,
  `addPage`, …) returning new doc objects (immutable). No React here.
- **Files:** `services/comicDoc/index.ts`, `services/comicDoc/selectors.ts`,
  `services/comicDoc/mutators.ts`, unit tests.
- **Accept:** Vitest covers create + each mutator (immutability + correctness).
- [ ] done

### 01.3 — Migrator from the three legacy shapes
- **Do:** `services/comicDoc/migrate.ts` — `toComicDoc(project)`:
  - **classic** (`state.panels[]` + `continuity` + `characters/items/locations` +
    `stylePrompt`) → pages/panels/layers + StyleBible + cast.
  - **pagestudio** (`state.pageStudio`) → one page per `PageStudioPage`, raster layer
    from `imageUrl`, edits → history.
  - **comicforge** (`state.comicforge`) → best-effort skeleton (it has little real data).
  - Idempotent; preserves legacy fields (no destructive delete) until v1 GA.
- **Files:** `services/comicDoc/migrate.ts`, tests with one fixture per shape.
- **Accept:** Each fixture migrates without loss of images/dialogue/cast; running twice
  yields the same doc.
- [ ] done

### 01.4 — Persistence wiring
- **Do:** Store `ComicDoc` at `project.state.doc`. On open, if `state.doc` missing,
  lazily migrate (01.3) and persist. Keep Supabase as source of truth; IndexedDB mirrors;
  reconcile by newer `updated_at`.
- **Files:** `hooks/useProjectManager.ts`, `services/projectStorage.ts`, `services/db.ts`,
  `services/cloudSync.ts`.
- **Accept:** Open a legacy project → it gains `state.doc`; reload → loads from doc;
  offline edit → syncs; no drift on reconcile.
- [ ] done

### 01.5 — Autosave + history
- **Do:** Debounced (~800ms) doc save on mutation; coarse `history` snapshot on
  structural events; reuse existing project versioning for named "Save version".
- **Files:** `hooks/useProjectManager.ts` (or a new `hooks/useComicDoc.ts`),
  `services/projectStorage.ts`.
- **Accept:** Rapid edits don't thrash the network (debounced); a version snapshot
  restores correctly.
- [ ] done

### 01.6 — Result-cache table (foundation for cost)
- **Do:** Create the durable result-cache (T4): Supabase table
  `image_result_cache(hash text pk, image_id, model, seed, created_at, last_used_at)` +
  RLS; a `services/comicDoc/resultCache.ts` get/put keyed by
  `hash(promptCanonical+refsHash+seed+model+size)`. (Population happens in Sprint 2.)
- **Files:** `server/sql/image_result_cache.sql`, `server/src/services/resultCache.ts`,
  client `services/comicDoc/resultCache.ts`.
- **Accept:** Migration applies with RLS; get/put round-trips in a test.
- [ ] done

## Out of scope
- Generating anything (Sprint 2). Rendering on a canvas (Sprint 3).

## Definition of done (sprint)
- [ ] Tasks 01.1–01.6 checked
- [ ] Legacy projects of all three `pipelineMode`s open via the migrator with no data loss
- [ ] Typecheck/build/tests clean; migrator tests green
- [ ] Four docs updated; branch pushed; draft PR
