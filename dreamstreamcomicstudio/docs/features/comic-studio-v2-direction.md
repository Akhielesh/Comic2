# Comic Studio v2 — direction assessment & layered plan (June 2026)

The owner proposed a redesigned flow (script → AI analysis → image styling →
character/world/item/location references with zero hallucination → comic layout
(4:3/16:9, panel positions, custom grid templates) → cover styling → bubbles/captions →
a full drag-drop compositing editor → PDF/book export) and, separately, a
counter-instinct: *"think of it like a Chat Studio/Code Studio base layer where the
user enters their comic idea, the AI shows a gallery of design choices, then simple
form factor / upscaling / circle-to-edit — simple and clean, layer by layer."*
Reference UI: Ideogram's prompt bar (inline model/count/aspect popovers, Auto toggle),
Google Flow's minimal canvas ("start creating or drop media"), and comic-page samples
(grid/asymmetric/strip/focal/manga layouts; lettered covers; bubble-heavy pages).

## Honest assessment (the requested bullshit-check)

**The second instinct is right and the first is wrong — and the codebase already
proves it.** The 8-stage wizard is, almost step for step, what Comic Studio already
has: `AppStep` runs SCRIPT_INPUT → STORY_PLANNING → STYLE_SELECTION →
REFERENCE_BUILDER → COVER → LAYOUT_SELECTION → COMBINED_PREVIEW → FULL_GENERATION →
REVIEW_EXPORT, grouped as the 3-stage Story/Cast/Pages flow, with self-healing
auto-references (ADR 0004) and PDF/ZIP export. Rebuilding that as MORE steps
contradicts the stated goal ("good clean customizable comics, not just another
option") and the products being emulated — Ideogram and Flow win because there is
**one input and progressive disclosure**, not a corridor of forms. The June overhaul
already cut the minimum path to 5 clicks; v2 should cut it further, not regrow it.

What in the proposal is genuinely new (not yet built) and worth doing:

1. **Visual style gallery** — pick the comic's look from generated sample cards
   (Ideogram-style chips/cards), not a text prompt. Highest leverage, smallest build.
2. **Custom grid/layout templates** — user-editable panel grids beyond the presets,
   per page, including 4:3/16:9 form factors.
3. **Bubble & caption editor** — typed bubble styles (speech/thought/narration/SFX),
   editable after render.
4. **Compositing editor** — drag/resize/reorder panels, swap images, per-panel
   regenerate ("circle to edit" = mask + reference re-render).
5. **Upscaling + print/book export** — bleed, spreads, cover wrap beyond today's PDF.

What to reject or defer, and why:

- **"Full custom studio (Photoshop-like) if they want"** — defer. That's a
  multi-quarter editor project; items 2–4 deliver 80% of the customization with a
  constrained (and therefore learnable) surface.
- **A separate "AI deep-analysis" stage** — already exists inside Script→Plan
  (scene/panel breakdown + reference auto-collection). Don't surface it as a step;
  surface its *output* (the plan) for editing.
- **"No hallucination, skip unspecified details"** — right goal, but it's a prompting
  policy inside existing stages (reference sheets only for entities the script names;
  no invented characters), not a new pipeline stage.
- **Bubble positions baked into image generation** — keep text OUT of renders
  (models butcher lettering); overlay bubbles as editable SVG/HTML. This is also what
  makes the bubble editor and clean PDF text possible.

## The layered build (ship each layer, keep the studio usable throughout)

- **Layer 0 — today.** 3-stage flow, self-healing references, PDF/ZIP. Already live.
- **Layer 1 — the base layer (chat-studio-like entry).** One prompt bar ("describe
  your comic…") with inline popovers: aspect/form factor, page count, style. Submit →
  AI drafts plan + 3–4 style sample cards (the gallery); picking one IS the style
  lock. Everything else (cast, layout) gets sensible defaults the user can open later.
  This is mostly re-skinning existing stages behind progressive disclosure.
- **Layer 2 — page customization.** Custom grid templates (editor + save/reuse),
  per-panel regenerate, bubble/caption overlay editor with typed styles.
- **Layer 3 — compositing.** Drag/drop/resize/reorder panels on the page canvas,
  image swap from project assets, circle-to-edit (mask region + instruction →
  reference-capable re-render of that panel).
- **Layer 4 — output.** Upscaling pass, print-ready PDF (bleed/margins), book/spread
  view, cover wrap.

Each layer is independently shippable and none blocks the current flow; Layer 1 is the
recommended next build.
