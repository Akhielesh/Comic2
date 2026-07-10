# SPRINT-03 — Canvas editor shell + layer system

**Status:** 📋 planned
**Goal:** Open any `ComicDoc` page on a real **artboard**, see its **layers**, and
**select/move/resize/rotate** bubble + text layers with **undo/redo**, **autosave**, and
**export-flatten** — all with **no AI calls** (pure manipulation).
**Depends on:** Sprints 1–2.
**Flags:** `VITE_EDITOR_ENABLED`. Decide **T1 (canvas lib)** here and record in DECISIONS.

## Why
The Adobe-style surface (`04-CANVAS-EDITOR-SPEC.md`). This sprint builds the *frame* and
the *layer mechanics* — the riskiest net-new UI — before any AI editing (Sprints 4–5).
Ship it manipulating non-AI layers first so the canvas is proven before masks/regen.

## Tasks

### 03.0 — Decide & scaffold the canvas (T1)
- **Do:** Choose `react-konva` (recommended) vs `tldraw`; add the dep; scaffold an
  `<Artboard>` that renders a `ComicDoc` page (background/panel rasters + bubble/text
  layers) read-only. Record the decision + rationale in `DECISIONS.md` (T1).
- **Files:** `package.json`, `components/editor/Artboard.tsx`, `DECISIONS.md`.
- **Accept:** A rendered `ComicDoc` page from Sprint 2 displays faithfully on the artboard.
- [ ] done

### 03.1 — Editor shell + routing
- **Do:** `components/editor/EditorShell.tsx` — topbar (back/title/undo-redo/zoom/export),
  left tools rail (select/hand for now), pages rail (thumbnails), right Inspector + Layers
  panel scaffolds. Route `/edit/:id`. Replace the `pipelineMode` editor branch in `App.tsx`
  with this single editor opening a `ComicDoc`.
- **Files:** `components/editor/EditorShell.tsx`, `App.tsx`.
- **Accept:** Opening any project routes to one editor; pages rail switches pages.
- [ ] done

### 03.2 — Zoom / pan / fit
- **Do:** ⌘/Ctrl-scroll + pinch zoom (10–800%), space-drag / hand pan, `0` fit, `1` 100%,
  rulers, optional grid.
- **Files:** `components/editor/Artboard.tsx`, `components/editor/useViewport.ts`.
- **Accept:** Smooth zoom/pan; fit/100% shortcuts work; coordinates map correctly to doc px.
- [ ] done

### 03.3 — Selection + transform (bubble + text layers)
- **Do:** Click/alt-cycle/marquee/shift multi-select; 8-handle bbox; move/scale(Shift-lock)/
  rotate; snapping (frame/center/layer/grid, Alt suppress); arrow nudge; numeric Inspector
  x/y/w/h/rotation. Apply to `BubbleLayer`/`TextLayer` (not rasters yet).
- **Files:** `components/editor/Transformer.tsx`, `components/editor/Inspector.tsx`,
  `services/comicDoc/mutators.ts` (transform/update layer).
- **Accept:** Drag/resize/rotate a bubble updates the doc; snapping + nudge work; numeric
  fields round-trip.
- [ ] done

### 03.4 — Layers panel
- **Do:** Ordered layer list for the selected panel + a page group; drag-reorder (z),
  toggle visible/lock, rename, delete, duplicate, group/ungroup.
- **Files:** `components/editor/LayersPanel.tsx`, mutators (`reorderLayer`, `removeLayer`,
  `duplicateLayer`, group ops).
- **Accept:** Reordering changes render z-order; lock prevents selection; visibility hides.
- [ ] done

### 03.5 — Undo / redo (command stack)
- **Do:** A per-doc command stack; every mutation is a reversible command. ⌘/Ctrl-Z /
  ⇧⌘Z; ≥50 steps. Coalesce continuous drags into one command.
- **Files:** `services/comicDoc/history.ts`, `hooks/useComicDoc.ts`.
- **Accept:** Move→resize→delete→undo×3 restores exactly; redo re-applies; drag is one step.
- [ ] done

### 03.6 — Autosave + save state
- **Do:** Debounced doc persistence (reuse Sprint 1) on every command; "Saving…/Saved"
  chip; coarse history snapshot on structural events.
- **Files:** `hooks/useComicDoc.ts`, `components/editor/SaveChip.tsx`.
- **Accept:** Edits persist + survive reload; chip reflects state; no network thrash.
- [ ] done

### 03.7 — Export (layer compositor)
- **Do:** `services/comicDoc/export.ts` — composite layers per page in z-order at target
  res → PNG per page → reuse `services/download.ts` for PDF/PNG-zip. This becomes the
  export authority (over the old HTML-overlay path).
- **Files:** `services/comicDoc/export.ts`, `components/editor/ExportMenu.tsx`.
- **Accept:** Exported PDF/PNG matches the on-canvas composite (bubbles + art) pixel-close.
- [ ] done

### 03.8 — Migrate existing overlay bubbles → BubbleLayers
- **Do:** Ensure Sprint-1 migration + Sprint-2 lettering produce `BubbleLayer`s the editor
  edits; verify a migrated classic project's dialogue appears as editable bubbles.
- **Files:** `services/comicDoc/migrate.ts` (verify), `generate/letter.ts`.
- **Accept:** A migrated comic's speech bubbles are selectable/editable layers on canvas.
- [ ] done

## Out of scope
- AI ops: bubble *library* (Sprint 4), region edit (5), regen/variations (6).
- Raster-layer transform/crop → Sprint 6 (crop) / as needed.

## Definition of done (sprint)
- [ ] 03.0–03.8 checked; T1 recorded in DECISIONS
- [ ] Any `ComicDoc` opens in one editor; bubbles/text are manipulable layers; undo/redo +
      autosave + export work; no AI calls in this sprint
- [ ] Typecheck/build/tests clean; four docs updated; branch pushed; draft PR
