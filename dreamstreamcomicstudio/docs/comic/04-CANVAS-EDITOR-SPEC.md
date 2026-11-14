# 04 — Canvas Editor Spec (the "Adobe but AI" surface)

This is the centerpiece (D4). It is a **layer-based comic canvas**: the page is an
artboard, everything on it is a **layer**, and AI operations (region edit, panel
re-roll) produce new layers non-destructively. This doc specifies it down to the
interaction level so any session can build a slice without re-deciding UX.

> Implements `ComicDoc` from [`03-ARCHITECTURE.md`](./03-ARCHITECTURE.md). Built in
> Sprints 3 (shell+layers) → 4 (bubbles) → 5 (region edit) → 6 (regen+variations).

## 0. Anatomy (screen regions)

```
┌─────────────────────────────────────────────────────────────────────┐
│ Topbar: ⟵back · title · undo/redo · zoom% · Render status · Export   │
├──────────┬───────────────────────────────────────────┬──────────────┤
│ Pages    │                                           │ Inspector     │
│ rail     │            ARTBOARD (zoom/pan)            │ (context to    │
│ (thumbs) │   page → panels(frames) → layers          │  selection)    │
│          │                                           │               │
│ Tools    │   ● select ● move ● bubble ● region ● text │  Layers panel │
│ (left)   │   ● crop ● hand/pan ● eyedropper           │ (z-order list) │
├──────────┴───────────────────────────────────────────┴──────────────┤
│ Bottom: variation tray (when present) · cost preview · save state    │
└─────────────────────────────────────────────────────────────────────┘
```

- **Pages rail** (left): page thumbnails; add/duplicate/reorder/delete page; click to
  load onto the artboard.
- **Tools** (left, vertical): Select(V), Move(M)*, Bubble(B), Region-edit(R), Text(T),
  Crop(C), Hand/Pan(Space-hold or H), Eyedropper(I). *(Move merges into Select in v1.)*
- **Artboard** (center): the page. Zoom 10–800% (⌘/Ctrl-scroll, pinch); pan
  (space-drag / hand). Rulers + optional grid + snapping. Renders the `ComicDoc` page:
  layout frames, panel rasters, bubble/text/fx layers in `z` order.
- **Inspector** (right, top): properties of the current selection (bubble style, layer
  opacity/blend, panel seed/model, etc.). Contextual.
- **Layers panel** (right, bottom): the ordered layer list for the selected panel (and
  a page-level group). Drag to reorder; toggle visible/lock; rename; group.
- **Variation tray** (bottom, conditional): appears after a regen/region edit with N
  candidates to pick from.

## 1. Selection & transform model (applies to every layer)

- **Click** selects the topmost layer at the point; **Alt-click** cycles down the stack;
  **marquee** (drag on empty) multi-selects; **Shift-click** adds/removes.
- Selected layer shows an **8-handle bounding box**: corners scale (Shift = lock ratio),
  edges stretch, a top **rotate handle**, center drag = move.
- **Snapping:** to panel frame edges, page center lines, other layers' edges/centers,
  and a toggleable grid. Hold **Alt** to suppress snapping.
- **Nudge:** arrows 1px, Shift+arrows 10px. **Numeric** x/y/w/h/rotation in the Inspector.
- **Z-order:** ⌘/Ctrl-] forward, ⌘/Ctrl-[ back, with [+Shift] for front/back; or drag in
  Layers panel.
- **Lock / visibility / opacity / blend** per layer. **Group/ungroup** (⌘/Ctrl-G).
- Every transform is a **command** on the undo stack (§6).

## 2. Bubble system (Sprint 4 — the headline)

A **parametric SVG bubble library**. A bubble is a `BubbleLayer` (see `03`). The user
drags one from a palette onto a panel, then edits it entirely on-canvas.

**Designs (v1 set):** `speech`, `thought` (cloud + trailing dots), `shout`/`burst`
(jagged), `whisper` (dashed), `narration` (rectangular caption), `caption` (bottom bar),
`electronic`/`radio` (notched), `offpanel` (tail to edge). Each is a function of params
(corner radius, tail length/angle, spikes, fill, stroke, dash) → SVG path, so we get
infinite variants from a small code set. Library is data: `services/bubbles/designs.ts`.

**Interactions:**
- **Add:** pick a design in the Bubble palette → click (drop at point) or drag a box
  (set size). New `BubbleLayer` added to the panel, auto-selected.
- **Move:** drag the body. **Resize:** corner/edge handles; text **auto-reflows and
  auto-fits** (font scales to fit, or box grows — toggle in Inspector).
- **Tail:** a draggable endpoint; **snap-to-speaker** if dropped on a character
  (`tail.attachAssetId`), so the tail re-points if the bubble moves.
- **Edit text:** double-click → inline editor (multiline, manual line breaks honored).
- **Restyle (Inspector):** design swap (keeps text+position), font/size/weight/align,
  fill/stroke/strokeWidth/radius, dash, opacity, blend. **Speaker** dropdown (links an
  `AssetCard` → can auto-color the bubble/tail per character).
- **Layer-on-layer:** multiple bubbles per panel, freely overlapping, reorderable in the
  Layers panel; bubbles always render **above** raster/inpaint layers by default but z is
  user-controllable.
- **Auto-lettering** (from the engine) drops bubbles per the panel's dialogue plan using
  the existing auto-layout heuristic (`services/bubbleLayout.ts`) — but as **editable
  layers**, never baked into art. This is the bridge from today's overlay system.
- **Reset-on-regen rule:** when a panel's raster is re-rolled, bubble layers are
  **preserved** (they're separate layers); only the raster changes. (Contrast: today
  bubble positions reset on image regen.)

## 3. Region / circle-to-edit (Sprint 5 — local AI editing)

The "circle a spot and fix it" capability. Non-destructive: produces an `InpaintLayer`
composited over the panel raster.

**Flow (minute detail):**
1. Pick **Region-edit (R)**. Cursor becomes a mask brush. Sub-tools: **Brush** (paint
   mask, [/] resize), **Lasso** (freeform), **Ellipse/Rect** (drag), **Magic** (later:
   segment-by-click). Mask renders as a 40%-red overlay; Alt = erase mask.
2. The masked area + a small feather is captured as a **binary mask PNG** at panel
   resolution.
3. A prompt bar appears: *"Describe the change in this area"* (e.g. "fix the left hand",
   "make her eyes closed"). Optional: keep-style toggle (on by default → injects Style
   Bible), strength slider.
4. **Send** → Edit Engine `regionEdit(panelId, mask, instruction)` → routes to the
   **region-editor** model cluster (inpaint-capable; see `05`) with `{image, mask,
   prompt, refs(styleBible)}`. New API param: `mask` through `services/imageService.ts`
   → `POST /api/image/*` (flip `ENABLE_INPAINTING`).
5. Result returns as **N candidates** in the variation tray. Hover-preview composited in
   place. **Accept** → adds an `InpaintLayer` (masked to the region, feathered) above the
   raster, with provenance. **Reject** → discard, mask stays for a retry. **Variations**
   → request more.
6. Because it's a layer, the user can later lower its opacity, re-mask, or delete it to
   reveal the original art. Multiple region edits stack as multiple `InpaintLayer`s.

**Fallback when no true-inpaint model is available on the user's keys:** degrade to
"masked instruct-edit" — send the full panel + the masked crop + "change ONLY the
circled area, keep everything else identical," then **auto-composite back only the masked
region** client-side (we own the mask), so even non-inpaint image-edit models behave
locally. This is the realistic v1 path for Gemini-image-style models. (See `05` §
region-editor cluster.)

## 4. Panel operations (Sprint 6)

- **Single-panel regen:** select a panel → "Re-roll" → optional change note + seed →
  `regeneratePanel` → variation tray (N). Pick → swaps the `RasterLayer`; bubbles/inpaint
  layers above are preserved (or optionally reset). **Seed shown + editable** for
  deterministic control.
- **Variations:** request N (default 3) in one batched call where the provider supports
  it; otherwise N parallel calls with N seeds. Tray shows thumbnails + cost.
- **Explode to panels:** a `page_composite` page → "Edit panels separately" →
  `explodeToPanels` cuts the composite along layout slots into per-panel `RasterLayer`s
  for precise per-panel work. Reversible (re-flatten on export).
- **Crop (C):** interactive crop on a raster layer (re-frame a panel) — pure client,
  no model call.

## 5. Inspector — context map

| Selection | Inspector shows |
|---|---|
| Bubble | design, text, font/size/weight/align, fill/stroke/radius/dash, tail, speaker, opacity/blend |
| Raster/Inpaint layer | model, prompt (read-only + "edit & re-roll"), seed, opacity/blend, mask (for inpaint), provenance/cost |
| Panel (no layer) | brief (description/shot/focal), refs used, render mode, seed, model override, "Re-roll / Explode" |
| Page (empty) | format/size, layout template, background, page render, "Render page" |
| Text/SFX | font, size, color, stroke, path/warp (later), opacity/blend |

## 6. Undo/redo, history, autosave

- **Command stack** per document: every mutation (transform, add/delete layer, text
  edit, accept variation, reorder) is a reversible command. ⌘/Ctrl-Z / ⌘/Ctrl-Shift-Z.
  Target ≥ 50 steps in memory.
- **Coarse history** (`ComicDoc.history`): named snapshots on structural events (render,
  explode, page add) and on demand ("Save version") — reuses the existing project
  versioning so the reader/share still work.
- **Autosave:** debounced (~800ms) doc write to IndexedDB immediately + Supabase on
  idle; visible save-state chip ("Saving…/Saved"). Conflict: newer `updated_at` wins,
  warn if a remote change is detected.

## 7. Export (flatten)

- Compose layers per panel/page in `z` order at target resolution → PNG/JPG per page →
  PDF / webtoon vertical strip / CBZ / PNG-zip. Bubble/text/fx layers rasterize on
  export; inpaint layers are already composited. Reuses `services/download.ts` +
  `panelLayout.ts` export CSS where useful, but the **layer compositor** is the new
  authority (replaces the HTML-overlay export path).

## 8. Keyboard reference (ship this in a "?" overlay)

`V` select · `B` bubble · `R` region-edit · `T` text · `C` crop · `H`/Space pan ·
`I` eyedropper · `⌘/Ctrl-Z`/`⇧⌘Z` undo/redo · `⌘/Ctrl-G`/`⇧⌘G` group/ungroup ·
`⌘/Ctrl-]`/`[` z-order · `Del` delete layer · `⌘/Ctrl-D` duplicate · arrows nudge ·
`⌘/Ctrl-scroll` zoom · `0` fit · `1` 100%.

## 9. Build order (so slices stay vertical)

1. **Sprint 3:** artboard + zoom/pan + render a `ComicDoc` page (read-only) + Layers
   panel + select/move/resize/rotate on **bubble+text layers** (no AI yet) + undo/redo +
   autosave + export-flatten. Migrate existing overlay bubbles into `BubbleLayer`s.
2. **Sprint 4:** full bubble library + palette + on-canvas bubble editing + speaker
   linking + auto-lettering into editable layers.
3. **Sprint 5:** region-edit tool + mask capture + `mask` API param + inpaint/instruct
   fallback + `InpaintLayer` composite + variation tray.
4. **Sprint 6:** panel re-roll + variations + seeds + explode-to-panels + crop.

## 10. Tech note (decide T1 in Sprint 3)

Recommend **`react-konva`** for the artboard: a real scene graph with raster + vector
layers, hit-testing, transforms, and canvas export — a natural fit for the layer model.
Evaluate **`tldraw`** as a faster-to-stand-up alternative (rich editor out of the box,
but more opinionated; bending it to comic panels/inpaint may cost more than it saves).
Whatever we pick, the **`ComicDoc` is the source of truth** and the canvas lib is a
*view/controller* — never the data owner. Record the choice in `DECISIONS.md` (T1).
