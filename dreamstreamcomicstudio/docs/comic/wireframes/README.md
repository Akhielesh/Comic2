# Wireframes

Low-fidelity, layout + interaction wireframes for the Comic Studio redesign. They show
**what's on each screen and what each control does** — not visual design (no real colors,
type, or art direction yet).

## The screens (page-by-page)

| File | Stage | Shows |
|---|---|---|
| `00-flow.png` | Flow map | The whole journey: quick path → reader; deep path → editor; publish/export. Legend explains the wireframe conventions. |
| `01-connect-key.png` | 1. Connect key | BYOK first-run gate (OpenRouter primary, free-only default, guide link). |
| `02-dashboard.png` | 2. Dashboard | One-product library; resume/read/new; running spend chip. |
| `03-create.png` | 3. Create | The quick path: one screen — story box, style, format, length, auto-cast, **cost preview** → Create. |
| `04-generating.png` | 4. Generating | Live stepper (aggregate → Style Bible → cast → render → letter → assemble) + preview + spend. |
| `05-reader.png` | 5. Reader | Finished book; Edit / Publish; page nav + thumbnails. |
| `06-editor-shell.png` | 6. Editor shell | Artboard + tool rail + pages rail + inspector + **layers** (no AI; pure manipulation). |
| `07-editor-bubbles.png` | 6a. Bubbles | Bubble palette (9 designs), drag/resize handles, tail, restyle, speaker, layer-on-layer. |
| `08-editor-region-edit.png` | 6b. Region edit | Circle/mask a spot → describe → re-gen only that area → variation tray (non-destructive InpaintLayer). |
| `09-editor-regen-variations.png` | 6c. Re-roll | Single-panel re-roll, seed control, N variations, pick one (bubbles preserved). |
| `10-editor-layers.png` | 6d. Layers | The "layer on layer" system close-up: reorder, opacity/blend, hide/lock, group. |

## Conventions
- **Yellow** button = the primary / AI action. **Red numbered dots** = interactions, keyed
  to each screen's "Notes / interactions" panel. **Hatched boxes** = generated images.
  **Blue outline** = deep-edit path; **green** = publish/export.

## Regenerate
These are generated from one script (pure SVG → PNG via `sharp`, already a dependency):

```bash
# from dreamstreamcomicstudio/
node docs/comic/wireframes/generate.mjs
```

Edit `generate.mjs` to change a screen; both `.svg` (vector, editable) and `.png` (for
viewing) are written. Keep this folder in sync with `04-CANVAS-EDITOR-SPEC.md` and the
sprint files — if a screen changes, update the matching spec.
