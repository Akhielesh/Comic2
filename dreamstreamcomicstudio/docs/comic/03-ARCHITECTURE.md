# 03 — Target Architecture

The whole redesign rests on **one idea**: a single, layer-native **Comic Document**
that both the quick-generate engine and the Adobe-style editor read and write. Every
custom feature you add later is "just another layer type" or "just another operation
on the document." That is the **solid base template**.

```
        ┌──────────────────────────────────────────────────────────────┐
  UI    │  Create (one entry)   ·   Editor (layer canvas)   ·   Reader   │
        │  Quick mode (3 clicks)        progressive depth      publish    │
        └───────────────┬───────────────────────┬──────────────────────┘
                        │ reads/writes           │ reads/writes
                        ▼                        ▼
        ┌──────────────────────────────────────────────────────────────┐
  CORE  │              ComicDocument  (one canonical model)             │
        │   Book → Pages → Panels → Layers   +   StyleBible · Cast ·    │
        │   Continuity · History/undo · Render+Edit jobs                │
        └───────────────┬───────────────────────┬──────────────────────┘
              generate / │ render                │ edit (mask, regen, letter)
                        ▼                        ▼
        ┌──────────────────────────────────────────────────────────────┐
 ENGINE │  Generation Engine (page-first hybrid)  ·  Edit Engine        │
        │  intake→aggregate→stylebible→cast→render→letter→assemble      │
        └───────────────┬──────────────────────────────────────────────┘
                        │ generateText / generateImage / editImage
                        ▼
        ┌──────────────────────────────────────────────────────────────┐
 MODEL  │  AI Gateway (provider-agnostic)  ·  Model Orchestrator        │
        │  capability registry · clusters/roles · routing · consistency │
        │  OpenRouter (default) · NVIDIA · [later: fal/Replicate]       │
        └──────────────────────────────────────────────────────────────┘
                        │
        ┌──────────────────────────────────────────────────────────────┐
 DATA   │  Supabase (Postgres+RLS, Storage) · IndexedDB cache · Result  │
        │  cache (content-hash) · BYOK key store · (billing ledger:off) │
        └──────────────────────────────────────────────────────────────┘
```

---

## 1. The Comic Document model (`ComicDoc`)

The canonical shape lives in `types.ts` (new `comicDoc` section) and is
implemented under `services/comicDoc/`. It **supersedes** the scattered
`ComicState` fields and the three engines' private shapes. Old projects migrate in
(see §5). Design goals: **layer-native, non-destructive, render-agnostic, diff-able**.

```ts
// ----- Top level -----
interface ComicDoc {
  v: number;                       // schema version (migration gate)
  id: string;
  meta: BookMeta;                  // title, logline, format, audience, status
  intake: Intake;                  // the raw user input + creative direction
  styleBible: StyleBible;          // the ONE source of visual truth (generate-once)
  cast: AssetCard[];               // characters/props/locations + reference sheets
  continuity: ContinuityGraph;     // who/what/where per scene; binding + locks
  pages: Page[];                   // ordered pages
  jobs: DocJob[];                  // render/edit jobs (status, cost, provenance)
  history: HistoryEntry[];         // doc-level snapshots (coarse undo / versions)
  flags: DocFlags;                 // per-doc feature toggles, defaults
}

// ----- Visual identity (consistency anchor) -----
interface StyleBible {
  id: string;
  prompt: string;                  // canonical style text injected everywhere
  tags: string[];                  // palette/linework/era/medium
  referenceImageId?: string;       // a locked style key-frame (a "north star" image)
  paletteHex?: string[];
  seed?: number;                   // base seed for style coherence
  confirmed: boolean;
}

interface AssetCard {              // a character / prop / location "model sheet"
  id: string;
  kind: 'character' | 'prop' | 'location';
  name: string;
  description: string;
  lockedTraits: string[];          // immutable identity clauses
  referenceImageIds: string[];     // turnaround/expression sheet (generate ONCE)
  seed?: number;                   // identity seed for this asset
}

// ----- Page / Panel / Layer (the editable spine) -----
interface Page {
  id: string;
  index: number;
  size: { w: number; h: number };  // artboard px (format-driven)
  format: ComicBookFormFactor;     // us_comic | webtoon_vertical | square | …
  layout: LayoutSpec;              // grid slots (the panel frames)
  panels: Panel[];
  renderMode: 'page_composite' | 'panel_assemble'; // D2: default composite
  background?: LayerRef;           // optional full-page art layer (page_composite)
}

interface Panel {
  id: string;
  slotId: string;                  // which layout frame it occupies
  rect: Rect;                      // x,y,w,h on the page (px)
  brief: PanelBrief;               // description, focalSubject, shot, dialogue plan
  refs: ReferencePack;             // scoped style + cast + neighbor refs (see 05)
  layers: Layer[];                 // ORDERED, bottom→top. This is the Adobe part.
  state: 'planned'|'rendering'|'ready'|'failed';
  seed?: number;                   // panel seed (deterministic regen)
}

// The layer is the unit of editing. Everything visible is a layer.
type Layer =
  | RasterLayer        // generated/edited panel art (the picture)
  | InpaintLayer       // result of a region edit, composited over raster (non-destructive)
  | BubbleLayer        // a parametric speech/thought/caption bubble (vector)
  | TextLayer          // free text (titles, SFX) — vector
  | ImageOverlayLayer  // uploaded sticker/logo
  | FxLayer;           // tone, halftone, gradient, border

interface LayerBase {
  id: string;
  type: Layer['type'];
  name: string;
  transform: Transform;            // x,y,w,h,rotation,scale (relative to panel/page)
  z: number;                       // order
  opacity: number;                 // 0..1
  blend?: BlendMode;
  visible: boolean;
  locked: boolean;
  createdBy: 'ai' | 'user';
  provenance?: Provenance;         // model, prompt, seed, cost, parentLayerId
}

interface BubbleLayer extends LayerBase {
  type: 'bubble';
  design: BubbleDesign;            // 'speech'|'thought'|'shout'|'whisper'|'narration'|'caption'|'burst'|'electronic'|'offpanel'
  text: string;
  speaker?: string;                // links to an AssetCard for color/tail logic
  tail: { x: number; y: number; attachAssetId?: string };
  typography: Typography;          // font, size, weight, align, letterStyle
  fill: string; stroke: string; strokeWidth: number; radius: number;
}
```

**Why this shape wins:**
- **Layer-native** → the canvas editor is first-class, not bolted on. Bubbles, region
  edits, SFX, overlays are all layers with the same transform/z/opacity contract.
- **Non-destructive** → a region edit (`InpaintLayer`) composites *over* the raster;
  the original art is never lost. Bubbles never bake into the art (fixes the PageStudio
  "baked lettering" trap).
- **Render-agnostic** → `renderMode` lets a page be a single composite image *or* an
  assembly of per-panel rasters. Same document; the engine chooses. "Explode to panels"
  = swap a page's composite into per-panel `RasterLayer`s for precise editing.
- **Consistency-anchored** → `StyleBible` + `AssetCard.referenceImageIds` + `seed`s are
  the shared truth every render reads. Generate the cast **once**; reuse forever.
- **Diff-able & cost-aware** → every layer/panel carries `provenance` (model, prompt,
  seed, cost). Enables the result cache, "what changed", and per-element re-roll.

## 2. The two engines

### 2a. Generation Engine (page-first hybrid) — `services/comicDoc/generate/`
Pipeline (each stage is a pure step over the doc; Quick mode auto-advances):
```
intake → aggregate(story→script→pagePlan→panelPlan)   [TEXT, free-tier]
       → styleBible(generate-once)                     [1 image]
       → cast(reference sheets, generate-once per asset)[N small images]
       → render(pages)                                  [page_composite: 1 img/page]
       → letter(auto bubble layers, NON-baked)          [no image calls]
       → assemble(book) → reader
```
Key properties: text stages are cheap/free; the **only** per-page image cost in the
default path is **one composite render** (plus the one-time Style Bible + cast). Deep
editing happens *after*, on demand, not by re-rendering everything. Full cost rules in
[`06-COST-AND-CONTEXT.md`](./06-COST-AND-CONTEXT.md).

### 2b. Edit Engine — `services/comicDoc/edit/`
Operations on a ready doc, each producing a new layer or mutating one (all undoable):
- `regeneratePanel(panelId, {instructions?, seed?, n?})` → new `RasterLayer`(s) /
  variation tray; bubbles & overlays preserved.
- `regionEdit(panelId, mask, instruction)` → inpaint → `InpaintLayer` (non-destructive).
- `addBubble / updateBubble / moveBubble / restyleBubble` → `BubbleLayer` ops (no model).
- `explodeToPanels(pageId)` → composite → per-panel rasters for precision.
- `upscale(layerId)` / `relight` / `recolor` → later clusters.

## 3. Provider / model layer
The **AI Gateway** (`server/src/ai/gateway.ts`) stays the seam; we make **OpenRouter
the default** and add what's missing (seed, mask). On top sits the **Model
Orchestrator** (capability registry + role clusters + routing + consistency), detailed
in [`05-MODEL-ORCHESTRATION.md`](./05-MODEL-ORCHESTRATION.md). The editor and engine
**never** name a vendor — they ask for a *role* ("panel-artist", "region-editor",
"text-brain") and the orchestrator binds a concrete model honoring the user's BYOK keys,
capability gates, and free-first preference.

## 4. Persistence & sync
- **Source of truth:** Supabase. The `ComicDoc` persists as one JSON document on
  `projects.state.doc` (migrator-gated), with images in Storage and metadata rows in the
  normalized tables (`pages`, `panels`, `asset_cards` from the existing schema) used for
  query/RLS. Start JSON-first for velocity; promote hot sub-objects to rows as needed.
- **Cache:** IndexedDB mirrors the active doc for offline/fast load; **newer
  `updated_at` wins** on reconcile (kills the current drift).
- **Result cache:** content-hash table keyed by `(promptHash + refsHash + seed + model +
  size)` → image id, so identical renders cost $0 (T4). See cost doc.
- **Autosave:** debounced doc writes on every editor mutation; coarse `history`
  snapshots on structural changes (page add, render, explode).

## 5. Migration (no big-bang) — `services/comicDoc/migrate.ts`
- Keep `project.state.pipelineMode`; add `project.state.doc?: ComicDoc`.
- On open: if `doc` absent, **lazily migrate** from whichever legacy shape exists
  (classic `panels[]`+`continuity`, PageStudio `pageStudio`, or ComicForge `comicforge`)
  into a `ComicDoc`. Idempotent, reversible by keeping the legacy fields until v1 GA.
- New projects are born as `ComicDoc` only. Old projects keep opening throughout.

## 6. Routing & shell
Replace the hand-rolled `currentView` machine with `react-router-dom` (already a dep):
`/create`, `/edit/:id`, `/read/:id`, `/library`, `/settings`. One **Create** entry, one
**Editor**. The `pipelineMode` branch in `App.tsx` collapses to a single editor that
opens any `ComicDoc`. Frozen products live behind `/legacy/*`, hidden unless
`VITE_SHOW_LEGACY_PRODUCTS`.

## 7. What this buys us
- The "confusing three engines" problem **disappears** at the model layer — there's one
  document and one editor; `renderMode` is an implementation detail.
- Every future "custom detailed feature" (D4 fast-follows, new bubble designs, new edit
  ops, new export formats) is an **additive layer type or doc operation** — the base
  template doesn't churn.
- Cost and consistency become **properties of the document** (seeds, reference sheets,
  provenance, result cache), not ad-hoc per-call behavior.
