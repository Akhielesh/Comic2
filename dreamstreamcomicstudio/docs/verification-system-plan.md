# DreamStream Comic Studio — Self‑Verifying App & Auto‑Resolve System (v2)

**Status:** PLAN — approved scope, **no implementation code yet**. This document IS the build spec; a builder should be able to follow it phase by phase.
**Branch:** `claude/trusting-noether-ltz2R`
**Last updated:** 2026-06-02

---

## 0. Decisions locked with the owner

| Decision | Choice |
|---|---|
| Free‑only behaviour when no genuinely‑free model can serve a step | **Block + explain** — hard stop with a clear message; never a silent paid call. |
| Auto‑fix autonomy when the council confirms a real bug | **Full auto‑merge when checks pass**, behind a hard safety envelope (§7.4–7.6). |
| Pricing display | **Multi‑dimensional and explicitly stated** — show every applicable cost axis and say plainly which apply; never collapse to one misleading "free/paid". |
| BYOK / "whose key pays" | First‑class in the cost model; "free" is defined relative to the paying key (§3.4). |
| Delivery | Phased (0→3); plan‑only until sign‑off to implement. |

---

## 1. The four problems and their verified root causes

| # | Complaint | Verified root cause | Evidence |
|---|---|---|---|
| 1 | Review/cost metrics "follow the old code and costing models" | **4 competing pricing sources**; deprecated routing table still in tree; inline hardcoded cost math in the Preview stage; estimate path diverges from the billed path. | `server/src/comicforge/modelRouter.ts` (deprecated table, retired model IDs); `services/pricingConfig.ts` (hardcoded constants); `server/src/services/pricingCatalog.ts` (`FALLBACK_MODEL_PRICING`); `model_pricing_snapshots` (live); `components/steps/CombinedPreview.tsx:103‑111` (inline math). |
| 2 | "Autorouter is free but costs money" | (a) image route never asks for free; (b) token‑billed image models mislabelled free; (c) silent fallback to paid; (d) BYOK key charged directly while app shows $0. | `routes/image.ts:513` (`costPref:'quality'`); `ai/providers/openrouter.ts:139‑141` (`isFree` ignores token billing for image models); `ai/providers/openrouter.ts:233` (silent paid retry on 404/429); `ai/autoRouter.ts:85` (falls through to cheapest paid); `middleware/keys.ts` (`byokBypass`). |
| 3 | "Panel count in review is bullshit — we already chose the layout" | Per‑scene ±Panels stepper in the **Preview** stage duplicates/overrides the grid template chosen in the **Layout** stage. | `components/steps/CombinedPreview.tsx:539‑554` (stepper); `:81` (`panelCounts` state); template source of truth `services/gridTemplates.ts` → `GridTemplate.panelCount`, chosen in `LayoutSelector.tsx`, stored as `state.gridTemplateId`. |
| 4 | "No verification/auto‑resolve across features that source info" | No system audits the catalog / pricing / labels / output, and nothing turns a confirmed issue into a fix. Existing primitives (`consistency_metrics.ts`, `dailyPricingSync.ts`, `dailyBillingReconciliation.ts`, BullMQ, nightly Actions) are unconnected one‑offs. | See §5. |

---

## 2. Surface map — where AI actually flows (corrected from v1)

```
UI stage components
  └─ services/geminiService.ts | services/imageService.ts | services/generationManager.ts   ← REAL surface
       └─ HTTP → server /api/*  (text/vision/assistant + 3 image endpoints)
            └─ routes/*.ts  →  ai/gateway.ts  →  providers/{openrouter,nvidia}.ts + legacy Gemini
```

Confirmed facts that change the design:
- Every creation stage generates through the **client services**, which `post()` to the server (`geminiService.ts` → `/api/text/analyze-script`, `/api/text/extract-world`, `/api/text/panel-breakdown`, `/api/vision/analyze-layout`, `/api/image/{nvidia,openrouter,gemini}`, …). The server is the enforcement choke point.
- **Image generation uses three distinct endpoints** chosen client‑side by the selected model's `source`. `/api/image/nvidia` is **billing‑bypassed** (BYOK `nvapi-` key) → the genuinely‑free image path.
- `services/generationManager.ts` runs **background** generation (`startBackgroundGeneration`) — any free‑only block must surface to the user, not throw into the void.

**Implication:** free‑only + verification instrumentation live server‑side, but the **free‑only flag must be threaded through the client services and their many call sites**, must influence the client's choice of image endpoint, and must have a background‑safe "blocked" surface.

---

## 3. Canonical pricing & "free" model (the crux — problem #1 and #2)

### 3.1 Pricing is multi‑dimensional and independent
Server canonical shape (`server/src/ai/providers/types.ts`):

| Axis | Field | Meaning |
|---|---|---|
| Input tokens | `promptPerToken` | charged per input token |
| Output tokens | `completionPerToken` | charged per output token |
| Per image | `imagePerImage` | charged per generated image |
| Per request | `requestFlat` | flat charge per call |

These are **independent**. Concretely:
- A model can have `imagePerImage = 0` **but** `completionPerToken > 0` → image is produced but **token‑billed** (Gemini "Nano Banana"). **Not free.**
- A model can have `promptPerToken = completionPerToken = 0` **but** `imagePerImage > 0` → free text axis, **per‑image cost** (Flux‑style).
- "Free" and "cheap" are therefore **relative to which axis applies and how the model is used.**

### 3.2 Frontend/backend shape mismatch (a real bug to fix)
Frontend `types.ts:129‑131` uses `inputPer1k` / `outputPer1k` / `imagePerOutput` (per‑1k, **no `requestFlat`**) — a *different* shape from the server's per‑token 4‑axis model. This is a source of display drift. **Unify on one canonical shape** (recommend the server 4‑axis, with a per‑1k display helper) shared via `shared/`.

### 3.3 "Free" classification — replace the single `isFree` boolean
Derive a class from the axes + the `:free` suffix:

| Class | Rule | UI treatment |
|---|---|---|
| `free_verified` | id ends `:free` **OR** all 4 axes = 0 | "Free" badge (green). Safe for free‑only. |
| `zero_priced_token_billed` | `imagePerImage = 0` **and** (`promptPerToken > 0` **or** `completionPerToken > 0`) | "NOT free — token‑billed" badge; show token axes. |
| `per_image_only` | tokens = 0 **and** `imagePerImage > 0` | "Per‑image cost" badge; show per‑image price. |
| `paid` | otherwise | "Paid" badge; show all non‑zero axes. |

`ai/providers/openrouter.ts:139‑141`'s `isFree` must be replaced by this classification (the current rule wrongly treats token‑billed image models as free). Propagate through `ai/catalogAnnotations.ts`, `services/modelCapabilities.ts`, `components/ModelLibrary.tsx`.

### 3.4 BYOK overlay — whose key pays (the literal "free is costing me money")
- `middleware/keys.ts` resolves keys from **BYOK headers** (`X-OpenRouter-Key`/`X-Nvidia-Key`/`X-Gemini-Key`) or platform env, and sets `openRouterByok`/`nvidiaByok` + reservation `byokBypass`.
- When BYOK is in use the app **charges no credits** (`byokBypass`) — because **the user's own provider account is billed directly.** So a "0‑priced but token‑billed" model shows $0 in‑app while the user's OpenRouter/Gemini bill rises. **That is the complaint.**
- Rule: a model is "free to *you*" only if (`free_verified`) **or** (platform‑paid tier covers it). For any other axis under BYOK, show: **"Your own &lt;provider&gt; key will be charged: …"**.
- **Honest limitation:** the app **cannot read the user's BYOK provider bill**, so cost‑reconciliation (§5.2) can verify in‑app charges and *estimates*, but cannot confirm the exact external BYOK spend. We surface estimated BYOK cost and label it an estimate.

### 3.5 Display requirements (what the UI must show)
For every model, render all **applicable** axes with units and a plain statement, e.g.:
- *"Costs $0.30 / 1K input + $2.50 / 1K output tokens. No per‑image charge."*
- *"Costs $0.039 per image. No token charge."*
- *"$0 on OpenRouter's :free tier — exempt from key spend limits."*
Plus a relativity note ("cost depends on length/number of panels") and the BYOK note when applicable. **Never** a bare "free/paid" with no breakdown.

### 3.6 Reconcile the per‑tier allowlist
`server/src/services/modelAccessPolicy.ts` hands free‑tier users `FREE_NANO_BANANA_MODEL = gemini-2.5-flash-image` (token‑billed) with `FREE_NANO_BANANA_DAILY_CAP = 5`. Decide and document explicitly: this is **platform‑paid up to the daily cap** (so "free" to the user is true only on the platform key, and false under BYOK). Make the UI state which case applies.

---

## 4. Phase 0 — Concrete fixes

### 0A. Remove the redundant panel‑count control
- **Edit** `components/steps/CombinedPreview.tsx`: delete the ±Panels stepper (`:539‑554`) and `panelCounts`/`setPanelCounts` (`:81`); derive per‑scene count from `getGridTemplate(state.gridTemplateId).panelCount` (+ `panelSlots`). Keep per‑scene **Regenerate** (regenerates against the template count). Fallback when only `state.layoutType` is set: sane default, no stepper.
- **DoD:** Preview shows no panel stepper; generated plans match the layout template count; existing vitest green; a new test asserts no stepper + template‑driven count.
- **Size:** S.

### 0B. One pricing source of truth + correct multi‑dimensional display
- **New** `shared/pricing.ts` — canonical 4‑axis pricing type + helpers (`classifyModel()`, `perThousand()`, `describeCost()` → the §3.5 strings). Single shared definition for client + server.
- **Edit** `ai/providers/openrouter.ts` (use classification), `ai/catalogAnnotations.ts`, `services/modelCapabilities.ts`, `components/ModelLibrary.tsx` → consume `shared/pricing.ts`.
- **Edit** `components/steps/CombinedPreview.tsx:103‑111` — remove inline math; call the shared estimator fed by **live** pricing.
- **Quarantine/delete** `server/src/comicforge/modelRouter.ts`'s `MODEL_ROUTING_TABLE`; add a test that no live path imports it.
- **Demote** `services/pricingConfig.ts` constants to clearly‑labelled last‑resort fallback; frontend fetches live pricing (new `GET /api/models/pricing` or include in catalog).
- **Persist the estimate** per generation (new column/field on `generation_cost_events` or `artifacts.meta`) so §5.2 can reconcile.
- **Edit** `ReviewExport.tsx` — headline = billed actual; pre‑gen number labelled "estimate".
- **DoD:** all model‑cost UIs render from `shared/pricing.ts`; the deprecated table is gone; Preview estimate equals Review's billed value within tolerance on a sample run; each model shows its full axis breakdown + plain statement.
- **Size:** M.

### 0C. Free labelling + free‑only setting + BYOK‑aware routing
- **Setting (new):** `freeOnly` preference at **account** level (`components/AccountSettings.tsx` + a server‑persisted profile flag) with optional **per‑project** override in project `state`. Threaded into client services as a request param/header.
- **Client services:** `services/geminiService.ts` / `imageService.ts` / `generationManager.ts` attach the free‑only flag to every `/api/*` call and pick the **free image endpoint** (NVIDIA) when free‑only + a key is present.
- **Model pickers:** when free‑only is on, filter selectable models to `free_verified` (+ NVIDIA free image), grey out the rest with the reason.
- **Server routing:**
  - Add a strict `free-only` mode distinct from today's `'free'` preference.
  - Text (`ai/autoRouter.ts`, `ai/stageModels.ts`): only `free_verified`; if none → throw typed `NO_FREE_MODEL_AVAILABLE`. **No** fall‑through to cheapest paid (`autoRouter.ts:85`).
  - Image (`routes/image.ts`): when free‑only, prefer NVIDIA free image (`/api/image/nvidia`); else other `free_verified` image models; else `NO_FREE_MODEL_AVAILABLE`. Stop using `costPref:'quality'` under free‑only (`:513`).
  - **Disable the silent paid retry** (`ai/providers/openrouter.ts:233`) when free‑only.
  - Enforce `isTrulyFreeModelId()` (`services/modelSelection.ts:65`) in free‑only routing.
- **Block + explain UX:** typed error → clear per‑stage message; **background path** (`generationManager`) writes a surfaced "blocked: no free model" status the UI reads (not a swallowed throw).
- **DoD:** with free‑only on, no stage can produce a paid/token‑billed call; blocking shows a clear message in foreground and background; NVIDIA free image is used for panels when available; tests cover "no free model → block" for text and image.
- **Size:** L.

---

## 5. Phase 1 — Verification engine + council + findings store

### 5.1 Database schema (new migration in `docs/migrations/`, applied via Supabase `apply_migration`)
```sql
create table verification_checks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  target_feature text not null,          -- pricing|free_labeling|autorouter|cost_reconciliation|
                                          -- pricing_freshness|capability_tags|continuity|moderation|custom
  kind text not null,                     -- 'deterministic' | 'ai_council'
  config jsonb not null default '{}',     -- thresholds, council model ids, prompt, tolerance
  schedule text,                          -- cron or interval; null = manual only
  enabled boolean not null default true,
  auto_fix_enabled boolean not null default false,
  severity_floor text not null default 'high',  -- min severity that may auto-fix
  created_by uuid references auth.users(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table verification_runs (
  id uuid primary key default gen_random_uuid(),
  check_id uuid references verification_checks(id) on delete cascade,
  trigger text not null,                  -- 'schedule' | 'manual' | 'ci'
  status text not null,                   -- 'running'|'passed'|'failed'|'error'
  summary jsonb,
  started_at timestamptz default now(),
  finished_at timestamptz
);

create table verification_findings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references verification_runs(id) on delete cascade,
  check_id uuid references verification_checks(id) on delete cascade,
  fingerprint text not null,              -- stable hash for dedupe (check_id + normalized detail)
  title text not null,
  detail jsonb not null,                  -- evidence, file:line pointers, repro, suggested area
  severity text not null,                 -- low|med|high|critical
  confidence numeric not null,            -- 0..1 (council/deterministic)
  council_votes jsonb,
  status text not null default 'open',    -- open|confirmed|dismissed|fixing|resolved|wontfix
  github_issue_number int,
  github_pr_number int,
  fix_attempts int not null default 0,
  created_at timestamptz default now(),
  resolved_at timestamptz,
  unique (fingerprint, status)            -- supports "one open finding per fingerprint"
);
```
RLS: admin/service‑role only. Include a `down`/rollback section in the migration file.

### 5.2 Check taxonomy (broader than v1 — covers "all features that source info")
| Check | Kind | Asserts | Notes |
|---|---|---|---|
| `freeLabelIntegrity` | deterministic | every "free"‑labelled model is `free_verified` (not token‑billed) | uses §3.3 |
| `autorouterFreeInvariant` | deterministic | free‑only routing never returns a non‑free id, against the **live** catalog | simulates `pickTextModel`/`pickImageModel` |
| `costReconciliation` | deterministic | persisted estimate ≈ `generation_cost_events` billed (tolerance) | BYOK rows flagged "external, est. only" (§3.4) |
| `pricingFreshness` | deterministic | `model_pricing_snapshots` < 24h; no lingering `REVIEW_REQUIRED` | reuses `dailyPricingSync` outputs |
| `capabilityTagAccuracy` | ai_council | advertised capabilities (JSON/image‑in/reasoning) match real behaviour | sample probes |
| `continuityIntegrity` | deterministic | **integrate** `scripts/consistency_metrics.ts` thresholds (do not duplicate) | wraps existing script |
| `moderationAccuracy` | ai_council | moderation verdicts vs a free‑model second opinion | low volume |
| `multiProviderCost` | deterministic | NVIDIA (bypassed)=$0 to user; Pixazo/OpenRouter axes correct | provider‑aware |

### 5.3 Council design ("work together", only act on real bugs)
- **Free models only** (enforced `free_verified`/`:free`). A panel of N models each independently assess; a **judge** model aggregates → confidence.
- A finding is emitted **only if confidence ≥ the check's threshold** (default high) → suppresses false positives.
- **Operational reality:** free models are rate‑limited — runner uses retry/backoff, a BullMQ queue, and **degrades gracefully** (deterministic checks still run if the council is throttled). Council results cached per run.
- Start with **independent‑vote + judge**; a debate/critique protocol is a later upgrade (documented, not built yet).

### 5.4 Runner, CLI, scheduling
- **New** `server/src/verification/{registry,runner,council}.ts` + `server/src/verification/checks/*`.
- **CLI** `server/src/jobs/runVerification.ts --check <id|all> [--check]` (mirrors `dailyPricingSync.ts`). Scripts: `verify:run`, `verify:run:check`.
- **In‑app scheduling** via **BullMQ repeatable jobs** (already in the stack) for user‑defined schedules; **CI scheduling** via a new nightly GitHub Action (`.github/workflows/verification.yml`, `workflow_dispatch` + cron).
- **DoD:** all deterministic checks runnable locally and in CI; council runs against free models with graceful degradation; findings persisted + deduped by fingerprint.
- **Size:** L.

---

## 6. Phase 2 — Control dashboard (create / track / monitor / stop)
- **UI** `components/VerificationCenter.tsx` (admin): list checks + last result + on/off toggle (**start/stop**); create/edit a check (name, target, kind, **free‑model picker**, thresholds, schedule, auto‑fix toggle); runs timeline; **findings inbox** (evidence, confidence, votes; Confirm / Dismiss / Won't‑fix / View issue / View PR); an **automation‑health** view (success/failure rate per check, mean‑time‑to‑fix, issue→PR→merge/revert feed).
- **Server** `server/src/routes/verification.ts` — admin‑gated CRUD + trigger run + update finding status.
- **DoD:** owner can create a custom check, schedule it, watch runs, validate/dismiss findings, and stop any automation from the UI.
- **Size:** M.

---

## 7. Phase 3 — Auto‑resolve bridge (Claude Code → full auto‑merge)

### 7.1 Finding → GitHub issue
- Filed by the **verification GitHub Action** (it already has `GITHUB_TOKEN`; the Express server needs no GitHub creds). Body = structured finding (title, evidence, file:line, repro, failing check id), label `auto-fix`.
- **Dedupe:** one open issue per `fingerprint`; **`fixing` lock** prevents re‑dispatch while a PR is open; **retry/backoff** with `fix_attempts` cap (then escalate to human).

### 7.2 Fixer workflow `.github/workflows/auto-fix.yml`
```yaml
on:
  issues:
    types: [labeled]
jobs:
  fix:
    if: github.event.label.name == 'auto-fix'
    runs-on: ubuntu-latest
    permissions: { contents: write, pull-requests: write, issues: write }
    steps:
      - uses: actions/checkout@v4
      - uses: anthropics/claude-code-action@v1   # Claude Code = the fixer (its own key)
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
        # reads the issue, implements the fix, opens a PR that references the issue
```
> This is "use Claude Code to fix bugs other agents find." The Action holds its own key; **the app never calls the Anthropic API** — it only writes an issue.

### 7.3 PR validation gate
The fix PR must pass: `typecheck` + `vitest` + **the originally‑failing check now PASSES** (`verify:run --check <id>`) + **council re‑validation** ≥ threshold.

### 7.4 Full auto‑merge — only if ALL hold + safety envelope
- All §7.3 checks green, **and** the safety envelope:
  - Diff‑size cap (configurable; large diffs → human review).
  - **Protected paths block auto‑merge:** `server/src/services/billing*`, `stripe*`, auth/middleware, `*/migrations/*`, `.github/workflows/*`, the auto‑merge logic itself.
  - PR confined to the finding's expected area (no sprawl).
  - All required status checks green; branch up to date; no force‑push.
- **Staged enablement (recommended):** start auto‑merge limited to a **whitelist of low‑risk check types** (labeling/copy/data), widen as trust grows.

### 7.5 Post‑merge re‑verify + auto‑revert
After merge, run the full check suite on the default branch; **on regression, auto‑revert** the merge and reopen the finding. (Essential because full auto‑merge can ship a fix that passed gates but broke something uncovered.)

### 7.6 Security (issue/PR bodies are external, attacker‑influenceable content)
- Only the verification system (or maintainers) may apply `auto-fix`; reject the label from other actors.
- Sanitize/scope issue bodies fed to the fixer; treat them as untrusted.
- Least‑privilege token; protected‑paths envelope as a hard floor.

### 7.7 Kill switch
A repo variable + `automerge-disabled` label + the in‑app **Stop** toggle each immediately halt all auto‑merges and dispatches.

- **DoD:** a seeded confirmed finding files an issue, Claude Code opens a PR, gates run, a whitelisted low‑risk fix auto‑merges, a deliberately‑bad fix is blocked or auto‑reverted, and the Stop toggle halts the loop.
- **Size:** L.

---

## 8. Phase 3b — Optional read‑only MCP
A thin `verification-mcp` exposing `get_finding`, `get_catalog_snapshot`, `run_check`, `get_recent_cost_events` so Claude Code can reproduce/verify against live runtime while fixing. **Deferred** — only if static code + issue body prove insufficient.

---

## 9. Cross‑cutting concerns
- **Notifications:** findings + issue/PR/merge/revert events surface in the dashboard and as GitHub notifications; optional email/webhook later.
- **Observability:** automation‑health metrics (§6); structured logs for each run.
- **Migrations/RLS/rollback:** SQL in `docs/migrations/`, applied via Supabase `apply_migration`; every migration includes a rollback section; new tables are service‑role/admin only.
- **Testing the checks ("who watches the watchers"):** each check ships unit tests with **false‑positive and false‑negative fixtures**; the council has mocked free‑model responses for deterministic tests.
- **BYOK blind spot (honest):** §3.4 — reconciliation cannot see external BYOK provider bills; those costs are shown as estimates and labelled as such.

---

## 10. File‑by‑file manifest

| Phase | New | Modified |
|---|---|---|
| 0A | — | `components/steps/CombinedPreview.tsx` |
| 0B | `shared/pricing.ts`, `GET /api/models/pricing` | `ai/providers/openrouter.ts`, `ai/catalogAnnotations.ts`, `services/modelCapabilities.ts`, `components/ModelLibrary.tsx`, `components/steps/CombinedPreview.tsx`, `services/pricingConfig.ts`, `components/steps/ReviewExport.tsx`, `comicforge/modelRouter.ts` (remove table), schema (persist estimate) |
| 0C | `freeOnly` profile flag + server enforcement | `components/AccountSettings.tsx`, `services/geminiService.ts`, `services/imageService.ts`, `services/generationManager.ts`, `ai/autoRouter.ts`, `ai/stageModels.ts`, `routes/image.ts`, `routes/text.ts`, `ai/providers/openrouter.ts`, model pickers |
| 1 | `server/src/verification/*`, `server/src/verification/checks/*`, `server/src/jobs/runVerification.ts`, migration SQL, `.github/workflows/verification.yml` | `package.json`, integrate `scripts/consistency_metrics.ts` |
| 2 | `components/VerificationCenter.tsx`, `server/src/routes/verification.ts` | `App.tsx` (route), `server/src/index.ts` (mount) |
| 3 | `.github/workflows/auto-fix.yml`, issue‑filer + dedupe in verification Action, auto‑merge + post‑merge revert job | `server/src/routes/verification.ts` |
| 3b | `verification-mcp` (optional) | — |

---

## 11. Build sequence, sizing, risks, open questions

**Sequence:** 0A → 0B → 0C → 1 → 2 → 3 (auto‑merge **disabled** first; enable on a whitelist) → 3b only if needed.

**Sizing:** 0A=S, 0B=M, 0C=L, 1=L, 2=M, 3=L. Each phase ships standalone value.

**Risks:**
- Full auto‑merge is the highest‑risk setting → §7.4–7.6 envelope + post‑merge revert + staged whitelist are mandatory.
- Free models (council + free‑only gen) are rate‑limited → graceful degradation required.
- Truly‑free image gen depends on NVIDIA **free credits** (BYOK, ~1,000) — finite; after that, free‑only image = Block + explain.

**Open questions for the owner:**
1. Auto‑merge **diff‑size cap** value, and confirm the **protected‑paths** list.
2. Free‑tier Nano Banana: confirm it is **platform‑paid up to the daily cap** (so the UI can state "free on platform key / charged on your key").
3. Notification channels beyond the dashboard (email/webhook)?

---

*Plan‑only. No application code changes are made by this document.*
