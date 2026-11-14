# 07 — Agentic Quality Overhaul & Eval Harness

> **Goal.** Make the two agentic surfaces — the **chat "swarm"** and **Code Studio** —
> actually reliable, progressively and measurably. Today both *generate → label →
> ship*; they rarely **observe reality and correct against it**, they run the hard
> reasoning on **cheap models**, and there is **no scoreboard** to tell us whether any
> change helped. This document is the staged plan to fix that without a rewrite.
>
> Authored from a six-part, file-cited review of the codebase (June 2026): the swarm
> orchestrator, the Code Studio pipeline, the model-routing layer, the persistence +
> worker infra, and the test/CI/eval infra. Every claim below is grounded in code we
> already run. It builds on `01`–`06`; it does not supersede them.

---

## 0. TL;DR — the one-line diagnosis

Both systems fail for the **same root cause wearing two costumes**:

> They **generate → label → ship**. The loop almost never closes against reality
> (run it, verify it, correct it), the hard cognition runs on **free/cheap models**,
> and there is **no eval harness** to measure quality.

The fix is **not** "more agents." It is, in order: **(0) build a scoreboard → (1)
close the loop against reality → (2) put capable models on the hard steps → (3) make
agents actually collaborate → (4) harden for enterprise.** The swarm is the *last*
thing we make bigger, not the first.

---

## 1. What we already have (the substrate — this is extension, not greenfield)

| Capability | Where | State |
|---|---|---|
| Strong test suite | 205 `*.test.ts(x)`, **1,420 tests, all pass (~82s)** | Mature. Mocks completions, so it needs no secrets. |
| CI gate on every PR | `.github/workflows/ci.yml` → `typecheck` + `build:server` + `build` + `test` | Green today. Read-only perms. |
| **Verification system + auto-revert** | `server/src/verification/*`, `verification.yml` (nightly, has secrets), `post-merge-verify.yml` (auto-reverts regressions) | **The natural home for output-quality evals.** |
| Model quality scripts | `scripts/model-bench.mjs`, `source-model-validate.mjs` | Connectivity / latency / cost only — **not** output-quality evals. |
| Live model catalog + ranked priority | `server/src/ai/autoRouter.ts` (`STRONG_CODING_PRIORITY`, `CODING_MODEL_PRIORITY`, `FREE_TEXT_PRIORITY`), `modelCatalog.ts` (stale-while-revalidate) | Building blocks for difficulty routing already exist. |
| Full agentic build loop | `server/src/ai/studio/buildAgent.ts` (`plan → run → observe → fix`), `studioBuildService.ts`, `studio-worker/` (Cloudflare sandbox) | **Already implemented**, just gated behind `VITE_STUDIO_LIVE_ENABLED`. |
| Generation constitution + design charter + repair | `studio/constitution.ts`, `studio/designSystem.ts`, `studio/studioGenerate.ts`, `verifyApp.ts` | Strong scaffolding; the holes are in *where it grades*. |
| Supabase persistence | `studio_runs/projects/files/versions`, `studioRepository.ts`; **unused `metadata` jsonb** on `studio_runs` | Additive home for traces + shared state. |
| Swarm trace UI | `apiTypes.ts` (`SwarmTraceArtifact`), `components/chat/artifacts/SwarmTraceCard.tsx` | Renders confidence/flags — but state is **ephemeral** (discarded after the response). |

**Bottom line:** the foundation is good. The gaps are narrow and well-defined.

---

## 2. The diagnosis (grounded)

### 2.1 Chat swarm — `server/src/ai/agents/`

The flow is `plan → run all agents in parallel → "verify" → synthesize → done`
(`orchestrator.ts:148-342`). Concrete failure modes:

| Failure | Evidence | Effect |
|---|---|---|
| **Agents never collaborate** | `orchestrator.ts:208` `Promise.all`; findings joined with `\n\n` (`:289-291`) | Run in isolation, glued by a 5th model → contradictions blended smooth, not surfaced. |
| **Verifier is toothless** | `verify.ts` — regex confidence score passed as *text* to the synthesizer | It can *label* "unverified" but cannot **reject** or **retry**. Bad claim ships with a badge. |
| **No feedback loop** | `orchestrator.ts` is strictly linear — no replanning/retry | If agents err or hallucinate, the answer still stands. |
| **Cheap models do the thinking** | planner + agents on `pickTextModel({preferFree:true})` (`orchestrator.ts:171,222`), **1,400-token** budget (`:228`); only synthesis uses the user model (`:303`) | Underpowered cognition + truncation = guessing. |
| **Planner can't sequence dependencies** | planner prompt `orchestrator.ts:37-47`; no dependency model | "find top-3 startups → get their prices" runs in parallel → finance agent hallucinates tickers. |
| **Thin prompts** | `registry.ts` — finance ~320 lines & strong; news/weather/research are one-liners | No "say I don't know" rule → agents fabricate context. |

### 2.2 Code Studio — `server/src/ai/studio/` + `routes/studio.ts`

**Surprise: this is not a toy.** It has a constitution, a design charter, a structured
JSON output contract, parser-retry, a 3-pass static repair loop, a completeness review,
*and* a real container build loop. The sophistication just has holes in the wrong places:

| Failure | Evidence | Why "build a login page" fails |
|---|---|---|
| **Default path never runs the code** | `/api/studio/generate` is pure LLM; only the opt-in **Build & run** (`buildAgent.ts`, flag-gated) executes | `verifyApp.ts` is *static* — can't see an unwired input, an empty submit handler, or a faked API call. Compiles ≠ works. |
| **Agents review without running** | `runStudioAgentsParallel` reads source, never executes | Sees `<Spinner>` + `isLoading`, scores 8/10 — but `setIsLoading` is never called. |
| **Scope undefined** | `constitution.ts:24` "build EXACTLY what was requested" — but "a login page" is ambiguous | Model guesses the *minimal* read: a bare form, no auth/OAuth/error states. |
| **No backend contract** | prompt never says where credentials go | Hardcodes `password==="test"` or calls a nonexistent endpoint; in Sandpack `process.env` is undefined → form hangs. |
| **Greedy JSON parse** | `extractAppObject` uses `indexOf('{')`/`lastIndexOf('}')` | Prose around the JSON → wrong braces → truncated files. |
| **Cost-only model routing** | `studioModelSelection.ts` picks by `costPref`; defaults to `quality` but drops to `free` on budget cap | Hard build on a weak model → garbage. |

### 2.3 The cross-cutting truths

1. **No output-quality eval exists** (`model-bench.mjs` is connectivity, not quality). We are tuning blind.
2. **Routing is cost-only** — there is *zero* difficulty-aware routing (`autoRouter.ts`).
3. **All agent/run state is request-scoped** — swarm findings, build events, traces all evaporate after the HTTP response. No Redis-backed shared state; no trace tables.

---

## 3. The bar (principles every stage is measured against)

1. **Closed loop against reality** — run it, verify it, feed errors back, retry (bounded).
2. **Capable models on hard steps** — route by *difficulty*, not just cost.
3. **Structured I/O contracts** — schema-validated, reject-and-retry, never scrape free text.
4. **Shared memory + synthesis** — agents read each other; reconcile, don't concatenate.
5. **Measured, not guessed** — a golden-task scoreboard gates every change.

---

## 4. The staged roadmap

Each stage **ships something that works on its own** and de-risks the next. We never
hold a half-broken system. Every new behavior lands **behind a feature flag** (§7) and
every stage ends with the **quality gates** in §6.

### Stage 0 — The Scoreboard (eval harness) · _foundation; do first_

**Why first:** you cannot fix what you cannot measure. Today "it feels broken" — after
Stage 0 it is "login-page scores 2/10, here is exactly where."

**Build:**
- `server/src/verification/goldenTasks.ts` — a fixed task set for **both** surfaces:
  - *Studio:* "build a minimal login page", "todo app w/ localStorage", "fix this broken component".
  - *Swarm:* "compare 3 stocks' P/E", "research X and cite sources".
- `scripts/golden-task-eval.mjs` — modeled on `model-bench.mjs`. For each task, calls the **real** agent/studio path (not mocked) and **auto-scores**:
  - *Studio:* parses? typechecks (in-process `tsc`)? builds? render-probe? contains required elements (form has `<input type=password>` + a wired submit)? → 0–10.
  - *Swarm:* answered the question? every figure carries a citation? no internal contradiction? → 0–10.
- New verification check kind `golden_task_eval` in `verification/types.ts` + `registry.ts` (reuse the existing `CheckImpl` pattern).
- New table `golden_task_runs` (Supabase) for trend/regression history.

**Wire-in:**
- `ci.yml` (PR): run `--dry-run` only (zero API cost, validates task defs).
- `verification.yml` (nightly, has secrets): full run, persist results.
- `post-merge-verify.yml`: **later** (Stage 4) becomes a regression gate that auto-reverts a score drop.

**Ship criteria:** a committed baseline score per task. **Gates:** unit tests for the scorer + `/code-review` + PR.

---

### Stage 1 — Close the loop against reality · _highest impact_

Two independent sub-tracks (can run in parallel).

**1A · Code Studio: validate-and-repair by default.**
- Add an **in-process "reality check" tier** that does **not** need the Cloudflare worker:
  parse → virtual `tsc` typecheck → (optional) headless render probe. Feed real errors
  into the **existing** `repairUntilClean` loop (`studioGenerate.ts`). This is the
  workaround for "the build worker is external and unavailable in CI/sandbox" (§5).
- Promote the **real** build loop (`buildAgent.ts`) to the default path **when
  `liveConfigured`**, with **graceful fallback** to the in-process tier otherwise
  (today it silently errors — see §2.2). Detect via `GET /api/studio/status`.
- Make the agent team review the **validated artifact + its errors**, not raw source.
- Harden `extractAppObject` → robust structured parse + schema validation + one retry.

**1B · Chat swarm: a verifier with teeth + a shared blackboard.**
- Upgrade `verify.ts` from *labeler* → *critic that can **reject*** a finding and trigger
  a **bounded** agent re-run (max 2). This is the missing feedback loop.
- Add a **shared in-request blackboard** so agents can read peers' findings. Start
  **in-memory within the single request** — no Redis/DB needed (the swarm runs inside
  one request; `orchestrator.ts`). This unblocks collaboration with zero infra.

**Ship criteria:** login-page eval jumps materially; swarm groundedness score rises.
**Gates:** `/code-review` + **`/security-review`** (Studio executes generated code; the swarm re-runs tools — both security-sensitive) + `/verify` + PR.

---

### Stage 2 — Fix the cognition (models + prompts)

**2A · Difficulty-aware routing** (extends, doesn't replace, `autoRouter.ts`):
- Add `difficulty?: 'weak'|'capable'|'strong'|'frontier'` to model annotations
  (`catalogAnnotations.ts`): manual overrides for ~30 notable models + heuristic
  (in `STRONG_CODING_PRIORITY` ⇒ `frontier`).
- Add a lightweight `classifyTaskDifficulty()` (prompt length/keywords/scope).
- Extend `pickTextModel`/`pickCodingModel` to take `difficulty` and route the **hard
  steps** (planner, agents, generation, synthesis) to capable models; keep cheap models
  for classification/routing/summarizing only. Raise the 1,400-token agent budget.
- **Cost guardrail:** clamp against `PROVIDER_BUDGETS` so a misfire can't send a trivial
  task to a frontier model; PR CI eval stays `--dry-run`.

**2B · Prompt hardening:**
- Bring thin agent prompts (news/weather/research in `registry.ts`) up to the
  finance-prompt standard; add explicit **"fail safe / say I don't know"** rules.
- Studio prompt: add **scope-clarification**, a **backend contract** ("assume
  `POST /auth/login`; read `VITE_API_URL`; scaffold `/.env.example`"), and
  **login-specific design** guidance (primary submit, masked password, real error states).

**Ship criteria:** eval rises again on both surfaces; cost-per-task stays within budget.
**Gates:** `/code-review` + `/verify` + PR.

---

### Stage 3 — Real collaboration · _only after 1 & 2 are proven_

- **Dependency-aware planner:** let the planner emit a small DAG so dependent subtasks
  run in sequence (find tickers → then prices) instead of blind parallel.
- **Persist the blackboard** to Supabase (`swarm_runs` / `swarm_findings`) so
  collaboration and tracing share one store (the in-memory blackboard from 1B graduates).
- **Reconciling synthesis:** prompt the synthesizer to **surface contradictions** and
  prefer sourced claims, not blend.

**Ship criteria:** multi-step/comparison tasks improve in the eval. **Gates:** full set + PR.

---

### Stage 4 — Enterprise hardening

- **Decision-level tracing:** persist `swarm_traces` / `swarm_agent_traces` (model, tokens,
  tool calls, why) — use the unused `studio_runs.metadata` and new tables; add a
  trace/replay endpoint + a small dashboard.
- **Reliability:** budgets + loop caps everywhere, graceful degradation, idempotency,
  provider fallback chains (`pickTextModelChain` already exists).
- **Add an ESLint gate** (none exists today) to CI.
- **Regression gate:** wire golden-task evals into `post-merge-verify.yml` so a score
  drop auto-reverts (reuse the existing pattern).
- Guardrails + human-in-the-loop for high-stakes actions. **Then** alpha → beta.

---

## 5. Issues, errors & workarounds (the realistic part)

| Constraint (real) | Where it bites | Workaround baked into the plan |
|---|---|---|
| **All 48 API keys unset in sandbox** (`NO_MODEL_KEY`) | Can't run real models or `/verify` here | Logic dev/tests stay mocked (existing pattern); **real-model evals run in CI** (`verification.yml` has secrets) or locally via `.env.studio-tools.example`. Eval harness supports `--dry-run`. |
| **Build worker is an external Cloudflare deploy** | No live builds in CI/sandbox; today it errors instead of falling back | Stage 1A adds an **in-process reality-check tier** (`tsc`/render probe) so a closed loop exists without the worker; real loop is used only `when liveConfigured`, with graceful fallback. |
| **No Redis for shared state** (`REDIS_URL` only rate-limit/queue) | Shared swarm memory | Stage 1B blackboard is **in-request in-memory** (swarm is one request); persist to **Supabase** in Stage 3 — never block on Redis. |
| **All run/trace state is request-scoped & ephemeral** | Tracing, regression analysis | Stage 4 adds **additive** trace tables; no teardown of existing flow. |
| **CI is read-only (`contents: read`)** | Evals can't auto-commit fixes | Use the existing **`post-merge-verify` auto-revert** instead of auto-commit. |
| **Server `tsconfig` `strict:false`** | Weaker type safety on new server code | New modules opt into stricter local types; security-sensitive paths get `/security-review`. |
| **No lint anywhere** | Drift in new code | Add ESLint in Stage 4 (not a launch blocker). |
| **Difficulty routing could misfire → cost spike** | Stage 2 | Clamp to `PROVIDER_BUDGETS`; PR eval is `--dry-run`; telemetry tunes thresholds. |
| **Feature regressions** | Every stage | Every behavior change ships behind a **flag** (§7) + the golden-task scoreboard catches drops. |

---

## 6. Quality gates per stage (where the slash-commands earn their keep)

These operate on a **diff/PR**, so they belong **at the end of each stage**, not up front:

| Gate | When | What it guards |
|---|---|---|
| `/code-review` | End of **every** stage | Correctness bugs + reuse/simplification in the new diff. |
| `/security-review` | Stages **1, 2, 4** | Code execution (Studio), tool re-runs (swarm), auth/login generation, SSRF, secrets. |
| `/verify` | End of every stage **(needs keys/env)** | The change actually works against a running path — not just green tests. |
| `/simplify` | After `/code-review` finds cleanups | Trim the new code before PR. |
| `/review` | On each stage PR | Full PR review pass. |
| golden-task eval | End of every stage | The **objective** delta — did the score go up? |

> `/debug` is not a command in this harness — debugging happens inline when errors hit.

---

## 7. Feature-flag & rollback strategy

Mirror the existing flag pattern (`VITE_STUDIO_LIVE_ENABLED`, `studioFlags.ts`):

- `STUDIO_REALITY_CHECK_DEFAULT` — gate Stage 1A default validation.
- `SWARM_VERIFIER_ENFORCE` / `SWARM_BLACKBOARD` — gate Stage 1B critic + shared memory.
- `ROUTER_DIFFICULTY_AWARE` — gate Stage 2A routing.
- `SWARM_COLLAB_MODE` — gate Stage 3 dependency planner + persisted blackboard.

Each flag defaults **off**, ships dark, is validated by the eval, then flipped on. Any
regression → flip off (instant) or let `post-merge-verify` auto-revert.

---

## 8. Sequencing & dependencies

```
Stage 0 (scoreboard) ──► Stage 1 (close the loop) ──► Stage 2 (cognition)
                                          │                    │
                                          └──────► Stage 3 (collaboration) ──► Stage 4 (harden)
```

- **Stage 0 blocks everything** — without it we can't prove any later stage helped.
- **Stage 1 before Stage 3** — a reliable single agent in a closed loop must exist
  before we make agents collaborate (collaboration multiplies errors otherwise).
- **Stage 2 is independent of Stage 1** but both should land before Stage 3.
- **Stage 4 is last** — hardening a moving target wastes effort.

---

## 9. First concrete step

**Stage 0, slice 1:** add `goldenTasks.ts` + `golden-task-eval.mjs` with the single task
"build a minimal login page" and an auto-scorer, run it once to capture the **baseline**,
and commit it behind the nightly workflow. That baseline number is the first honest
measurement of where we actually stand — and the reference every later stage is judged by.
