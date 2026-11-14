# 05 — Model Orchestration (handling many models, their limits, and consistency)

The core problem you named: *every image model has different limits, image generation
is expensive and inconsistent, and we don't want to be locked to one.* The answer is
**roles, not models.** The engine and editor request a **role** ("panel-artist",
"region-editor"); the **orchestrator** binds a concrete model that satisfies the role's
capability contract, honors the user's BYOK keys, prefers free, and falls back
gracefully. Builds on the existing gateway + capability registry + annotated catalog.

## 1. The seam (reuse what exists)
- `server/src/ai/gateway.ts` — provider-agnostic `generateText` / `generateImage`
  (+ new `editImage` for masks). **Make OpenRouter the default** (`AI_PROVIDER=openrouter`).
- `server/src/ai/capabilities.ts` + `stageModels.ts` — capability flags + per-stage
  gates. We **extend** these, not replace.
- `server/src/ai/catalogAnnotations.ts` + `services/modelCatalog.ts` — live, cached,
  annotated catalog from OpenRouter `/models`. The editorial "drawbacks/possibilities"
  layer is how a model's *limits* become routing signals and UI warnings.

## 2. Role clusters (the orchestration map)
Each role declares **required** + **preferred** capabilities and an **ordered preference
list** (free-first). A model is eligible iff it meets the required caps for the user's
available keys.

| Role | Required caps | Preferred | Default binding (today) | Notes / limit handling |
|---|---|---|---|---|
| **text-brain** (story, script, breakdown, continuity) | `structuredJson` | `longContext` | free Gemini/DeepSeek/Nemotron `:free` | JSON validate-and-repair on every call; pin known-good JSON models. Cheap → spend freely. |
| **panel-artist** (page/panel render) | `imageOutput` | `imageInput` (multi-ref), `seed` | `google/gemini-2.5-flash-image` (Nano Banana) | **MUST hold identity** → require `imageInput` when a scene has named cast; if a candidate lacks it, downgrade is blocked + user warned. |
| **region-editor** (inpaint / local fix) | `imageOutput` + `imageInput` | true `mask`/inpaint | Gemini-image (instruct-edit fallback) | If no native inpaint on user keys → masked instruct-edit + client-side region composite (see `04` §3 fallback). |
| **cover-artist** | `imageOutput` | `imageInput` | Nano Banana / GPT-Image | Prompt-adherence over consistency. |
| **stylist** (Style Bible keyframe) | `imageOutput` | `seed` | Nano Banana | Generated once; seed captured for coherence. |
| **qc-vision** (consistency check, later) | `imageInput` + `structuredJson` | — | a vision text model | Scores drift vs reference sheets; flags panels. |
| **upscaler** (later cluster) | `imageOutput` | dedicated upscale | — | fal/Replicate ESRGAN-class; post-approve only. |

Implementation: a `ROLE_REGISTRY` (`server/src/ai/roles.ts`) mapping role →
`{requiredCaps, preferredCaps, freeFirstOrder}`. `resolveRole(role, ctx)` reuses
`resolveStageModel`/`autoRouter` under the hood and returns `{modelId, provider,
downgraded, warnings}`. The client surfaces `warnings` (e.g. *"Selected model can't
hold a character's face across panels — using Nano Banana instead"*).

## 3. Consistency strategy (how we beat "inconsistent")
Consistency is engineered into the **document**, not hoped for per call. Layers of
defense, cheapest first:

1. **Generate-once anchors.** The **Style Bible** image and each **AssetCard reference
   sheet** are generated a single time and stored. They are the visual truth.
2. **Scoped reference packs.** Each panel's `ReferencePack` = Style Bible keyframe +
   reference sheets of **only the cast in that panel** (from the continuity binding) +
   the **immediately neighboring** rendered panels (1–2). *Not* "all entities every
   panel" (today's waste). Fewer, more relevant references → better identity + lower cost.
3. **Multi-image reference input.** Pass the reference pack as `image_url` parts to a
   `panel-artist` that supports `imageInput` (Gemini-image family). This is the single
   biggest consistency lever available through the API today.
4. **Seeds.** Add `seed` to `GenerateImageRequest` (`providers/types.ts`) and forward it
   in the OpenRouter provider (currently dropped — a real gap). Use:
   - `StyleBible.seed` as a base; derive `panel.seed = hash(styleSeed, pageIndex,
     panelIndex)`; `AssetCard.seed` for cast renders. Deterministic re-rolls + cheaper
     retries (same seed ≠ a fresh dice roll).
5. **Prompt locks.** Inject `lockedTraits` per cast member + the canonical Style Bible
   text + a strict-continuity instruction. (Exists today; keep, but scope it.)
6. **QC-vision pass (later).** After render, score each panel against its reference
   sheets; auto-flag drift for a targeted re-roll. Pre-flight continuity audit moves
   *before* the long render so drift is caught early.
7. **Future clusters (post-v1).** LoRA / IP-Adapter / ControlNet via providers that
   expose them (fal, Replicate) for true identity locking — slotted as new roles, no
   document change required.

## 4. Handling each model's limits (concretely)
- The **capability registry is the contract**; the **annotation layer is the nuance.**
  A model's `drawbacks` (e.g. "text→image only, weak multi-character", "no JSON mode",
  "heavy rate limits", "premium cost") drive: (a) eligibility (hard caps), (b) ranking
  (soft prefs), (c) **UI honesty** (show the drawback before the user picks it).
- **Downgrade is explicit, never silent.** `resolveRole` returns `downgraded:true` +
  reason; the client shows it (reuses today's downgrade notification path).
- **Rate limits / 429 / "no endpoints":** retry with backoff, then fall back to the next
  model in the role's free-first order — **unless** the user pinned a model or is in
  free-only mode (then surface a clear error, don't silently spend).
- **Provider outage:** the orchestrator is provider-agnostic; a role can bind across
  OpenRouter ↔ NVIDIA ↔ (later) fal. The *document* doesn't care which ran — provenance
  records it.

## 5. Per-stage / per-panel override (power users)
- Global per-role defaults (Settings) + per-panel override in the Inspector
  (`Panel.modelOverride`, `Panel.seed`). Reuses `services/modelSelection.ts` `byStage`
  map + `appSettings.modelRouting`. Overrides still pass the capability gate (an override
  that can't hold identity is warned, not blocked, for power users).

## 6. The Model Library (keep, refocus)
The existing annotated catalog UI (`components/ModelLibrary.tsx`) becomes the
**"choose your artist" surface** for the comic: filter by role-fitness (Holds character?
Supports inpaint? Free? Fast? Cheap?), with the product-POV drawbacks front and center.
This is where "clusters of models" is made legible to the user.

## 7. Net new work for orchestration (tracked in sprints)
- [ ] Make `AI_PROVIDER=openrouter` the default (Sprint 0).
- [ ] `seed` end-to-end on the unified path (Sprint 2/6) — `providers/types.ts` +
      `openrouter.ts` body.
- [ ] `mask`/`editImage` on the gateway + image route (Sprint 5).
- [ ] `ROLE_REGISTRY` + `resolveRole` wrapper (Sprint 2; extended each sprint).
- [ ] Scoped `ReferencePack` builder (Sprint 2) — replace "all entities" with
      continuity-scoped packs.
- [ ] QC-vision role + pre-flight audit (Sprint 7).
