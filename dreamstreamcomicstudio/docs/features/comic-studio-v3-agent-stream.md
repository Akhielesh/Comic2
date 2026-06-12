# Comic Studio v3 — the Agent Stream

**Status:** approved direction (owner, 2026-06-12). Supersedes the "Layer 1 prompt-bar"
sketch in `comic-studio-v2-direction.md` (kept for history); builds on the 3-click flow
shipped the same day (`comic-studio.md`).

**Owner's brief, verbatim intent:** *"A simple stream where the user enters the script
(or whatever) and has a simple agent option; the agent designs the best comic pages
possible based on the references and prompts the user gave, and the user can then
alter/edit as they need. This gives us significant control over the backend, less
clutter in the front end, and editing options for the users."*

**Reference UX** (owner-supplied screenshots): Google Flow — a near-empty dark canvas,
one floating "What do you want to create?" prompt bar with an **Agent** chip, an
**Agent settings** side panel (*Confirm before generating: Always / Never*; image &
video generation defaults: aspect-ratio segmented control, ×1–×4 count, model
dropdown, one Save button), and a thin left rail (All Media / Images / Videos /
Characters / Scenes / Tools). Ideogram — prompt bar with inline popovers for model /
count / aspect, and a model menu with friendly names + one-line descriptions.

---

## 1. The experience (narrative spec)

1. **Open Comic Studio → a calm, almost-empty canvas.** Left: a thin rail
   (`Project · Pages · Cast · Styles · Assets · Trash`). Center: "Start your comic or
   drop a script" empty state. Bottom-center: one floating prompt bar.
2. **The prompt bar** holds everything that used to be wizard stages, as inline chips:
   `[+ attach]` `[Agent ▾]` `[ratio ▾]` `[pages ▾]` `[model ▾]` `[➤]`. The user types
   or pastes a script (or just an idea), optionally drops reference images, hits send.
3. **The agent takes over and the stream begins.** Below the canvas top, agent cards
   appear in a conversation column, newest at the bottom — exactly like Chat Studio,
   but the "messages" are structured comic artifacts:
   - **Plan card** — scenes/beats, page count, panel budget, estimated cost. Inline
     `Looks right` / `Adjust` actions.
   - **Style gallery card** — 3–4 generated style boards; tapping one locks the style.
   - **Cast card** — auto-extracted characters/locations with reference-sheet thumbs
     as they render; per-entity `Edit` / `Re-roll`.
   - **Cover options card** — the AI-concept covers (shipped 2026-06-12) as a card.
   - **Page cards** — each finished page as a large preview with per-panel actions.
   - **Done card** — read, export PDF/ZIP, publish, total cost.
4. **Confirmation is a user setting, not a wizard.** Agent settings (gear on the
   prompt bar) mirrors Flow: **Confirm before generating: Always / Big spends only /
   Never**, plus generation defaults (aspect, panel density, image model from the
   user's governed model list, per-run budget cap). "Always" pauses the stream with a
   confirm card at each spending phase; "Never" runs straight through; "Big spends
   only" (default) auto-runs anything under the configured threshold (default $0.50)
   and pauses above it.
5. **Everything is editable after the fact.** Click any page card → the page overlay:
   per-panel regenerate (with instruction), dialogue/bubble editing, panel swap from
   project assets. Click a cast entry → entity editor. Type into the prompt bar at any
   time — "make page 3 darker", "give Maya a red jacket" — and the agent translates it
   into the minimal set of regenerations (see §3.1 scoped invalidation).
6. **Cost is always visible.** The `This comic: $X.XX` chip (shipped 2026-06-12) lives
   in the canvas header; every card that spent money shows its own line cost; the plan
   card shows the estimate before anything renders.

The classic step editor remains available as **"Detailed mode"** (a toggle in the
project menu) during the transition; the agent stream is the default for new projects
once Phase B ships.

---

## 2. Why this direction is right (and its honest risks)

**For it:** it matches how the product already wins elsewhere (Chat Studio = stream of
artifact cards; Code Studio = agentic build loop); it collapses seven surfaces into
one; backend-driven orchestration means flow changes stop requiring frontend step
surgery (the exact pain of the last two overhauls); and it matches the Flow/Ideogram
patterns the owner wants.

**Risks to manage:** (1) an agent that silently spends money is a trust-killer — the
confirm modes + budget cap + estimates-first are not optional polish, they're the
core; (2) "agent did something weird" needs every card to be reversible (Version
History already exists — every card action snapshots); (3) long-running streams need
resume (Phase C's server-side run record); until then, the run is client-resident
exactly like today's engine, so a closed tab pauses (not loses) a build.

---

## 3. Solutions to the five rigidities (the owner's direct question)

Each one becomes a designed behavior in v3 — not a hardcoded rule.

### 3.1 "Editing the script wipes everything downstream" → **scoped, diff-aware invalidation**
- **Today:** `resetFromScriptAnalysis` (services/pipelineReset.ts) clears style, cast,
  world art, layout, panels on every re-analysis. A typo costs the whole project.
- **Fix:** fingerprints already exist per slice (`services/pipelineFingerprint.ts` —
  `stableHash`, `hashScenes`, `hashWorld`). Make invalidation **per-scene and
  per-entity**:
  1. Re-analyze the new script; diff new scenes against old by scene hash.
  2. Unchanged scene hash → keep its panels untouched. Changed/new scene → reset only
     that scene's panels.
  3. Entities: diff the extracted cast against `state.characters/items/locations` by
     name; keep reference sheets for entities that survive; only new entities need
     sheets.
  4. Style is **never** reset by a script edit (it's an aesthetic, not a story fact).
     Aspect/resolution keep their values instead of resetting to `1:1`/`1K`.
- **In the agent stream:** the agent computes the invalidation set and SAYS it before
  acting: *"This edit touches scenes 2 and 5 — I'll re-plan 7 panels (~$0.31). Cast,
  style and the other 14 panels are untouched."* Confirm modes apply.
- **Implementation:** new `services/scopedReset.ts` (`diffScenes(old, new)`,
  `diffWorld(old, new)`, `invalidationPlan(state, nextScript, nextScenes)`) replacing
  the all-or-nothing branches of `resetFromScriptAnalysis`; ~1 day; unit-testable
  pure functions. **This fix is worth shipping in the CURRENT editor too** (Phase A).

### 3.2 "Mid-run fallback mixes image models in one comic" → **a consistency policy the user owns**
- **Today:** `services/imageService.ts` falls back across `IMAGE_MODELS` on
  429/5xx/key errors; panels in one run can render on different models
  (`mixed_model_in_run` metric).
- **Fix:** a per-project **Consistency policy** in Agent settings:
  - **Strict (default for pinned models):** no cross-model fallback mid-run. A failed
    panel is queued and retried on the SAME model with exponential backoff (30s/2m/5m,
    riding the existing per-panel `failureReason` + retry loop). The run finishes with
    "N panels queued for retry" instead of a mixed book.
  - **Resilient:** today's behavior, for users who prefer completion over uniformity.
  - Either way the build banner names what happened (already shipped: fallback count
    surfaces in `ComicGenerator`).
- **Implementation:** `consistencyPolicy: 'strict' | 'resilient'` on `ComicState` +
  Agent settings toggle; `imageService.generateImage` gains
  `options.disableModelFallback`; the per-panel retry path already exists
  (`ReviewExport` retry + `failureReason`). ~0.5 day.

### 3.3 "Reference caps starve big casts" → **cast tiers + persistent sheets + per-panel relevance**
- **Today:** 10 auto-sheets per RUN (`collectAutoReferenceTasks`,
  services/autoReferences.ts:37), 8 reference images per panel
  (generationManager.ts:896), continuity window of 2 panels
  (`MAX_CONTINUITY_PANELS`, services/modelPolicy.ts:36).
- **Fix (three parts):**
  1. **Cast tiers.** The plan card classifies entities by screen time: **Lead**
     (sheet always), **Support** (sheet when budget allows), **Extra** (no sheet —
     instead a locked one-line visual descriptor injected into every panel prompt that
     features them, e.g. "VENDOR: heavyset man, 60s, white stubble, blue apron" —
     text-locking is cheap and prevents drift better than nothing). Tiering is
     editable on the cast card.
  2. **Sheets persist and accumulate.** The 10-cap stays per RUN (cost bound) but
     un-sheeted Support entities are queued; the next run (or an explicit "finish
     cast sheets" card action, with cost shown) completes them. The cap stops being a
     per-project ceiling.
  3. **Per-panel relevance already half-exists** (`requiredEntityIds` per panel): the
     8-slot pack should be filled by THIS panel's entities first (lead → support →
     location → prior panel → style), never by global order. Verify and enforce the
     ordering in `buildReferencePack`.
- **Implementation:** `castTier` on `Character`; descriptor-lock line in
  `imagePrompt.ts`; queue in `collectAutoReferenceTasks`; pack-ordering audit. ~1.5 days.

### 3.4 "Style change strips world art" → **re-skin instead of delete**
- **Today:** `resetFromStyleConfirm` strips every generated entity image; the cast
  must be rebuilt from scratch in the new style.
- **Fix:** **Re-skin**: for each entity that HAD a sheet, re-render it with the NEW
  style anchor while passing the OLD sheet as an identity reference ("same character,
  new rendering style") — identity survives, style migrates. The agent offers it as a
  costed choice: *"Re-skin 6 cast sheets in the new style (~$0.23), or rebuild from
  scratch?"* Old art stays in Version History (already true).
- **Implementation:** `reskinWorldReferences(state, newStyleAnchor)` in
  `autoReferences.ts` — same generation path as Phase 0b, plus the old sheet at the
  front of the reference pack; replace the unconditional strip in
  `resetFromStyleConfirm` with the choice. ~1 day. (The same-style re-confirm no-op
  guard already shipped 2026-06-12.)

### 3.5 "Panels clamp to 1–8 per scene" → **beat-based planning (split/merge scenes)**
- **Today:** `pages × panelsPerPage / scenes`, clamped 1–8 — extreme ratios get
  silently flattened.
- **Fix:** the plan card plans **beats**, not scenes×N. When the target implies >8
  panels for a scene, the planner splits it into sequential beats (each ≤8); when
  scenes are thin (<1 panel each), it merges adjacent scenes into one beat. The clamp
  remains only as the final safety net. The plan card SHOWS the beat map so the user
  sees exactly what the page budget bought before anything renders.
- **Implementation:** a `planBeats(scenes, pageCount, panelsPerPage)` step before
  Phase 1 (text-model call returning a beat list; deterministic fallback = current
  math); `generatePanelBreakdown` runs per beat instead of per scene. ~1 day + prompt
  iteration.

---

## 4. UI specification

### 4.1 Design language
The agent stream uses the **calm-studio glass language**, not the legacy comic kit
(per CLAUDE.md): tokens from `components/chat/studioDesign.ts` (`PANEL`, `GLASS`,
`GLASS_STRONG`, `HAIRLINE`, `SHADOW_SOFT`, `PILL`, `CONTROL_BTN`, `PRIMARY_BTN`,
`INK`/`MUTED`/`LABEL`, `ACCENT_* = #D97757`, `RADIUS_PANEL/CONTROL/PILL`,
`TRANSITION`, `HOVER_LIFT`), themed by the `--ds-*` CSS vars in `index.css`
(light/dark via `services/theme.ts` `useTheme()`). No `border-2 border-black`, no
`shadow-comic`, no `font-display` inside the stream. The comic brand look survives
only in the rendered comic content itself.

### 4.2 Layout regions
```
┌────────────────────────────────────────────────────────────────┐
│ Header: ‹back · project title · [This comic: $X.XX] · [⚙]      │
├──────┬─────────────────────────────────────────────────────────┤
│ Rail │                Agent stream (scroll column)              │
│ Proj │   [plan card] [style gallery] [cast card] [page card]…   │
│ Pages│                                                          │
│ Cast │                                                          │
│ Style│                                                          │
│ Asset│                                                          │
│ Trash│  ┌───────────────────────────────────────────────┐       │
│      │  │ [+] [Agent ▾] | prompt… | [3:4][12p][model][➤]│       │
│      │  └───────────────────────────────────────────────┘       │
└──────┴─────────────────────────────────────────────────────────┘
```
- **Left rail** (Flow-style): filtered views over the same project — `Pages` (page
  cards only), `Cast` (entities), `Styles` (boards), `Assets` (all images). Reuse
  `RAIL_ROW` / `RAIL_ROW_ACTIVE` from studioDesign. Collapsible; hidden on mobile
  (bottom tab bar instead).
- **Stream column**: max-w-3xl centered, same scroll/append behavior as
  `ChatConversation` (auto-scroll to newest, smooth streaming).
- **Prompt bar**: fixed bottom-center, `GLASS_STRONG + HAIRLINE + SHADOW_SOFT +
  RADIUS_PANEL`, the `ChatComposer` skeleton minus chat-specific toggles.

### 4.3 Prompt bar anatomy (Ideogram-pattern inline chips)
| Chip | Behavior | Reuse from |
|---|---|---|
| `+` attach | script file / reference images (≤6), removable preview pills | ChatComposer attachments (lines ~346) |
| `Agent ▾` | popover: agent on/off (off = "manual mode" routes to classic editor), link to Agent settings | new `AgentChip`; `PILL` token |
| ratio `3:4 ▾` | segmented popover: 1:1 · 3:4 · 4:3 · 16:9 · 9:16 · custom — Flow's aspect picker | StyleSelection custom-ratio input + `RangeTabs` kit |
| pages `12 ▾` | stepper popover 1–60 (the shipped Layout page-count control, relocated) | LayoutSelector pageCount stepper |
| model chip | the user's selected image model (governed list); opens the model picker | `ChatModelPicker` invocation pattern; `services/modelSelection` |
| `➤` send | `PRIMARY_BTN`; disabled while a phase is awaiting confirmation | ChatComposer send |
| dictation/enhance | inherit from ChatComposer (optional, Phase B) | ChatComposer |

### 4.4 Agent settings panel (Flow-parity)
Right-side sheet (like the screenshot), `ModalPortal` + `PANEL`:
- **Confirm before generating:** radio — `Always` / `Big spends only (default,
  threshold $ input)` / `Never`. Maps to server gate behavior (§5.4).
- **Image generation defaults:** aspect segmented control; panel density (`Airy ×1 /
  Standard ×2 / Dense ×3` — maps to panels-per-page bias); model dropdown built from
  `useModelSourceScope()` + `fetchModelCatalog({modality:'image'})` (governed — never
  shows disabled sources).
- **Consistency policy:** Strict / Resilient (§3.2).
- **Per-run budget cap:** $ input; the orchestrator hard-stops and asks when the
  running total would exceed it.
- **Save** persists into `project.state.agentPrefs` (per-project) with account-level
  defaults in the settings snapshot (cloudSync v2 — add `comicAgent` to the snapshot
  the same way `studios.code` rides it).

### 4.5 The card system — new artifact types
Cards follow the EXISTING artifact pipeline (CLAUDE.md contract): declare type in
`apiTypes.ts` → register in `ARTIFACT_RENDERERS`
(`components/chat/artifacts/ChatArtifacts.tsx`) → demo in `GALLERY_DEMOS`
(`ComponentGallery.tsx`) or `gallery.coverage.test.ts` fails. All wrapped in
`WidgetFrame` (density toggle + resize persist per type). Shell = `kit/Surface`
(+`SurfaceTitle`/`SurfaceSubtitle`), controls = `RangeTabs`, `Chip`, `Badge`;
narrative text = `ChatMarkdown`.

| Type | Payload (sketch) | Card content & actions |
|---|---|---|
| `comic_plan` | `{ beats: [{id, sceneIds, synopsis, panelCount}], pages, panelsPerPage, castTiers: [{name, tier}], estimate: {usd, perPhase} }` | Beat map table, page math line, cast tier chips (editable), estimate; actions: **Approve plan** / **Adjust** (frees the prompt bar with context) |
| `style_gallery` | `{ options: [{id, label, prompt, imageId, imageUrl}], selectedId? }` | 2×2 image grid; tap = lock style (✓ overlay); **More options** regenerates; uses existing style-variant generation |
| `cast_sheet` | `{ entities: [{id, kind, name, tier, descriptor, imageUrl?, status: 'queued'|'rendering'|'done'|'failed'}] }` | Entity grid with live-filling thumbs; per-entity **Edit** (opens entity overlay) / **Re-roll**; queued badge for over-cap support cast (§3.3) |
| `cover_options` | reuse `CoverConcept[]` + candidates from the shipped CoverDesigner flow | concept-labeled gallery, tap to select; **New options** |
| `page_preview` | `{ pageNumber, imageUrl?, panels: [{id, thumbUrl, status, failureReason?}], costUsd }` | composed page preview (or live panel grid while rendering); actions: **Edit page** (overlay §4.6), per-panel retry, **Regenerate page** |
| `confirm_gate` | `{ phase, summary, estimateUsd, options: ['run','skip','adjust'] }` | the pause card when confirm mode triggers; Run is `PRIMARY_BTN` with the $ amount in the label |
| `run_summary` | `{ pages, panels, failures, totalUsd, durationMs }` | done card: Read / Export PDF / Export ZIP / Publish; links Version History |
| `agent_note` | `{ markdown }` | plain narration between cards (ChatMarkdown) |

Status/progress primitives inside cards: the `ComicGenerator` phase stepper
(●—○—○—○ Initializing→Planning→Rendering→Finishing), `LiveDuration` elapsed timer
(ChatMessageView lines ~32), rotating tips, and the completion sound — all lift-and-shift.

### 4.6 Edit overlays (the "alter/edit as they need" half)
All via `ModalPortal`, calm-glass:
- **Page overlay** (click a page card): large page render; panel grid below; per-panel
  → `Regenerate with instruction…` (textarea + reference toggle; reuses
  `RegenerateModal` pattern + existing `panel_regen` prompt stage), `Swap image`
  (project asset picker), `Edit dialogue` (existing `BubbleEditorModal` pattern —
  bubble text/kind/position). Phase C adds drag-reorder of panels within the page
  grid (slot-based, `panelSlotsSnapshot` already models slots).
- **Entity overlay** (click a cast entry): name, tier, descriptor, bio; sheet image
  with `Re-roll` / `Upload replacement`; "used in N panels" list.
- **Style overlay:** current anchor + prompt; `Adjust style…` → re-skin offer (§3.4).
- **Reader/export:** unchanged (`ReviewExport`, PDF/ZIP) — reached from the done card.

### 4.7 Cost surfaces
- Header chip: `ComicCostChip` (shipped) — total + per-stage hover.
- Plan card: pre-run estimate via `/api/billing/estimate`
  (`services/billing.ts:23 estimateTokenCharge`) extended with a whole-run projection
  (§5.5).
- Every spending card: its own line cost from the billing block already attached to
  generation responses.
- `AllowanceBanner` thresholds keep working unchanged above the stream.

### 4.8 Assets to produce
- Icons (lucide, existing set): `Sparkles` (agent), `Wand2`, `Layout`, `Users`,
  `Palette`, `FileImage`, `DollarSign` — no custom icon work needed.
- Empty states: canvas empty state (one line + ghost flower-style mark like Flow —
  reuse the brand "D" mark, muted), per-rail-section empties.
- Gallery demos: one realistic `GALLERY_DEMOS` entry per new artifact type
  (enforced by test).
- Sounds: reuse the existing completion chime; no new audio.

---

## 5. Backend specification

### 5.1 Architecture decision — phased control transfer
- **Today:** comic generation is **client-orchestrated** (`services/generationManager.ts`
  runs in the browser, calling per-op server endpoints; the server already gates every
  op with `reserveForOperation`/`settleReservedOperation`). Project state persists in
  Supabase `public.projects` (RLS owner-isolated; `services/db.ts:464` upsert) — note:
  persistence EXISTS; an earlier internal audit claiming otherwise was wrong.
- **End state (owner's goal — backend control):** a **server-side comic agent
  orchestrator** that owns planning + conversation + run state, streaming SSE events;
  the heavy per-image generation stays per-op server endpoints (unchanged billing/key
  flows).
- **Phasing:** Phase A keeps execution client-side (the stream UI drives the existing
  engine directly — zero backend risk). Phase B introduces the server agent for
  planning/conversation (SSE), with the client executing generation phases on the
  agent's instruction. Phase C moves run state server-side for cross-device resume.

### 5.2 Transport — reuse the chat SSE protocol exactly
`server/src/routes/chat.ts` (~1137–1239) already implements: `event: meta / delta /
reasoning / reset / final / error`, 15s heartbeat, reserve-before/settle-after billing.
Client: `services/chatApi.ts consumeEventStream` (45s idle timeout).
**New route:** `POST /api/comic/agent/stream` (same middleware stack: requireAuth,
attachAccountKeys, X-Allowed-Sources governance) emitting additional events:
```
event: card        data: { artifact: { type, data }, replacesCardId? }
event: card_patch  data: { cardId, patch }            // live thumb fills, statuses
event: gate        data: { gateId, phase, estimateUsd, summary }   // confirm pause
event: state       data: { runId, phase, totalUsd }   // run heartbeat
```
`POST /api/comic/agent/respond` resolves a gate (`{ gateId, decision: 'run'|'skip'|
'adjust', adjustment? }`) or carries a mid-run user message.

### 5.3 Orchestrator — extend the existing agent layer
- Registry pattern: `server/src/ai/agents/registry.ts` (`AgentDefinition {id, name,
  description, systemPrompt, toolNames}`); orchestration core:
  `server/src/ai/agents/orchestrator.ts` (`runSwarm`, `onProgress`, retry-with-backoff).
- New agents (naming convention `comic_<role>`): `comic_director` (top-level planner —
  produces the plan card, decides invalidation scopes, answers mid-run messages),
  `comic_beat_planner` (§3.5), `comic_style_director` (style options + re-skin),
  `comic_cover_artist` (wraps the shipped `suggestCoverConcepts`),
  `comic_continuity_editor` (post-pass QC, flags identity drift).
- Agent **tools** are the comic operations: `analyze_script`, `plan_beats`,
  `generate_style_options`, `generate_reference_sheet`, `panel_breakdown`,
  `render_panel`, `compose_page`, `design_covers` — thin wrappers over the existing
  text/image endpoints' internals so billing semantics are identical.

### 5.4 Confirm gates + budget cap
Before each spending phase the orchestrator: (1) builds the phase estimate
(`server/src/services/costEstimator.ts` has `buildEstimateFromRequestBody`); (2)
applies the user's confirm mode — `always` → emit `gate` and await `respond`;
`threshold` → gate only if `estimate > thresholdUsd` OR `runTotal + estimate >
budgetCapUsd`; `never` → gate only on the budget cap; (3) on run, the per-op
`reserveForOperation`/`settle`/`release` flow (`server/src/services/usageEnforcer.ts`)
proceeds unchanged — the gate is additive UX, not a billing rewrite. Gates time out
into a paused run (resumable), never silent spending.

### 5.5 Run-level estimate endpoint
Extend the existing estimate surface with `POST /api/comic/agent/estimate`:
`{ script|beats, pages, panelsPerPage, imageModel, castSize }` → per-phase + total
projection (panel count × per-image price from the live pricing config + text-stage
token estimates). Powers the plan card; clearly labeled as an estimate.

### 5.6 Phase extraction (the one real refactor)
`services/generationManager.ts startBackgroundGeneration` is monolithic. Extract pure
phases sharing a context object — `runStyleAnchorPhase`, `runReferenceSheetPhase`,
`runBeatPlanPhase`, `runPanelRenderPhase(batch)`, `runContinuityPhase` — each taking
`(ctx, onEvent)` and returning a result. Keeps: cancellation (`isCanceled`), resume
(existing-panel skip), progress semantics. The classic editor calls them in sequence
(behavior unchanged — regression-tested), the agent calls them as tools. This is the
load-bearing prerequisite for Phase B and is pure mechanical refactor (~2 days,
covered by existing generation tests + new per-phase unit tests).

### 5.7 Run state (Phase C)
`comic_agent_runs` table modeled on the ventures pattern
(`server/src/ventures/controlPlane.ts`; `venture_runs`): `id, user_id, project_id,
status('planning'|'awaiting_gate'|'rendering'|'paused'|'done'|'failed'), phase,
total_usd, gate_payload jsonb, created_at, updated_at` + `comic_agent_events`
append-only log. RLS owner-only. Enables cross-device resume and a server that
continues a render batch after the tab closes. **Not required for Phases A/B.**

### 5.8 Data model additions (`types.ts ComicState`)
```ts
agentPrefs?: {
  confirmMode: 'always' | 'threshold' | 'never';
  thresholdUsd?: number;          // default 0.50
  budgetCapUsd?: number;
  consistencyPolicy: 'strict' | 'resilient';
  panelDensity?: 1 | 2 | 3;
};
agentStream?: Array<{ id: string; at: number; artifact: ChatArtifact }>; // persisted cards
beats?: Array<{ id: string; sceneIds: number[]; synopsis: string; panelCount: number }>;
castTiers?: Record<string, 'lead' | 'support' | 'extra'>;
```
All optional — old projects parse untouched. `agentStream` rides the existing
`projects.state` persistence + Version History snapshots.

---

## 6. Phased build plan (each phase ships alone)

**Phase A — stream shell + rigidity fixes (≈1 week).** Scoped invalidation (§3.1),
consistency policy (§3.2), cast tiers + sheet queue (§3.3), re-skin (§3.4), beat
planning (§3.5) — all wired into the CURRENT 3-click editor so value lands
immediately. Build the stream UI shell (canvas, rail, prompt bar, card renderers +
gallery demos) behind `VITE_COMIC_AGENT_ENABLED`, driven by a client-side
orchestrator that simply sequences the existing engine and emits local cards.
**Exit:** a user can generate a comic end-to-end inside the stream UI, flag-gated.

**Phase B — the real agent (≈1–2 weeks).** Phase extraction (§5.6), `comic_director`
+ tools on the orchestrator/SSE stack (§5.2–5.3), confirm gates + estimates
(§5.4–5.5), mid-run natural-language edits via scoped invalidation, Agent settings
panel + cloud-synced defaults. **Exit:** agent stream becomes the default for new
projects; classic editor = "Detailed mode".

**Phase C — durability + deep editing (≈2 weeks, can trail).** Server run state +
resume (§5.7), page-overlay drag/reorder + panel swap, circle-to-edit (mask + region
re-render), print-grade export (bleed/spreads). **Exit:** close-the-laptop resilience
+ the full-custom editing the owner sketched.

## 7. Telemetry & quality bars
Per run: `mixed_model_in_run` (target → 0 under Strict), `zero_ref_panel`,
gate-acceptance rate (a plan card that's always "Adjust"-ed means the planner is bad),
estimate-vs-settled delta (target ±20%), per-phase failure rates, time-to-first-page.
Cards for failures must always carry a retry — the no-dead-ends rule from ADR 0004
applies to every agent phase.

## 8. Open questions (owner)
1. Default image model for the agent (currently Nano Banana): keep, or prompt
   per-project on first run?
2. Should "Never confirm" be allowed on platform-funded (non-BYOK) accounts, or is a
   budget cap mandatory there? (Recommend: cap mandatory.)
3. PageStudio (single-page quick mode): fold into the stream as a "one page" plan, or
   keep as a separate fast path? (Recommend: fold in at Phase B; it's the same flow
   with pages=1.)
