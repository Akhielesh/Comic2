# 07 — Roadmap (sprint sequence)

Sprints are ~1 week, vertical, and flag-gated. The detailed task list for each lives in
`sprints/SPRINT-NN.md`. `00-STATUS.md` is the live board; this is the *why/sequence*.

## Sequencing logic
We build **inside-out**: first the spine everything depends on (fences + the Comic
Document model), then the value path (idea → comic book), then depth (the editor),
last polish + publish. Editor sprints are ordered by risk/dependency: shell+layers →
bubbles (no AI) → region-edit (AI+mask) → regen+seeds.

## The plan

| Sprint | Title | Outcome (what works after) | Headline risk |
|---|---|---|---|
| **0** | Foundation & fences | Comic is the only product surfaced; BYOK + OpenRouter default; billing UI off; repo clean; flags in place | Low — mostly config/hygiene |
| **1** | Comic Document model + migration | One `ComicDoc` schema; old projects migrate in + keep opening; persistence + autosave | Medium — schema must be right (it's the base template) |
| **2** | Quick-generate engine (page-first) | Idea/script → aggregated → Style Bible + cast → page-composite render → book → reader, with cost preview + result cache + scoped prompts + seeds | High — the value path; consistency + cost |
| **3** | Canvas editor shell + layers | Open any `ComicDoc` page on an artboard; layers panel; select/move/resize/rotate bubble+text layers; undo/redo; autosave; export-flatten | High — net-new canvas |
| **4** | Bubble system | Parametric bubble library; on-canvas add/drag/resize/restyle; speaker links; auto-lettering as editable layers | Medium |
| **5** | Region / circle-to-edit | Mask capture → inpaint (or instruct-edit fallback) → non-destructive `InpaintLayer` → variation tray; `mask` API param | High — new AI+mask pipeline |
| **6** | Panel regen + variations + seeds | Single-panel re-roll; N variations; seed control on unified path; explode page→panels; crop | Medium |
| **7** | Consistency hardening | Scoped reference packs everywhere; character-sheet injection; QC-vision drift flagging; pre-flight continuity audit | Medium |
| **8** | Publish + polish | Cover; export presets (PDF/webtoon/CBZ/PNG); publish/share; onboarding; responsive/mobile pass | Low/Medium |

**→ v1 you can use after Sprint 6; v1 you can show others after Sprint 8.**

## Post-v1 fast-follows (not scheduled; capture ideas in DECISIONS/STATUS)
- Object/character **pose-swap / replace** editing (segment-select → edit).
- **LoRA / IP-Adapter / ControlNet** provider cluster for hard identity locking
  (fal/Replicate roles) + dedicated **upscaler**.
- **Batch "render whole book"** via the dormant ComicForge BullMQ worker (T5).
- Re-activate **platform billing** for multi-tenant (fix the settle-leak first).
- **Collaboration** (multiplayer canvas), **native mobile**, **templates marketplace**.

## How a session knows what to do
1. `00-STATUS.md` → the 🟡 sprint + the single NEXT STEP.
2. `sprints/SPRINT-NN.md` → the next unchecked task + its acceptance criteria.
3. Do the smallest vertical slice that satisfies a task; verify; update the four docs
   (`AGENTS.md` §2); push; draft PR.
