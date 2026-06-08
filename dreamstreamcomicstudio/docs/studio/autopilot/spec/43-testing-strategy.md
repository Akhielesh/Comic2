# 43 — Quality & Testing Strategy

> Part IV · Non-functional / Foundations · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> Realizes [F-ENTERPRISE-FOUNDATIONS](../F-ENTERPRISE-FOUNDATIONS.md) **F5** (testing &
> quality gates), with hard ties to **F1** (provider contract tests),
> **F7** (OpenAPI contract), **F9** (visual regression + a11y), **F6** (RLS-coverage check),
> **F8** (supply-chain/security gates), and **F20/§20** (accessibility). ·
> Engine-under-test: [24 — The Autonomous Engine](./24-autonomous-engine.md). ·
> Load source of truth: [`../../../production/load-test-plan.md`](../../../production/load-test-plan.md). ·
> CI/CD wiring is owned by [44 — CI/CD & release management](./44-cicd-release.md);
> this section defines *what* we test and *to what bar*, §44 defines *how the pipeline runs it*.
> Build/verify commands match [`../../../../CLAUDE.md`](../../../../CLAUDE.md).

## 43.1 What this section is (and what it is not)

This is the **quality engineering specification** for the existing DreamStream product *and*
the Autopilot venture layer built on top of it. It defines the test pyramid we hold to, the
honest current state (audited 2026-06-07, with file refs), the **target** state F5 commits to,
per-layer coverage targets, the special discipline required to test an *autonomous* engine, and
how test data and environments are managed.

Three honesty rules govern this section — the same three the rest of the spec lives by:

1. **Audited, not aspirational.** Where coverage exists and is good, we say so and protect it.
   Where it is absent, we name the gap plainly. Every "current" claim cites a file or a count.
2. **Shipped vs planned is marked.** The unit layer is **shipped**. Integration, E2E, contract,
   visual, load, security, and a11y layers are **planned (F5)** — this document specifies them;
   it does not claim they run today.
3. **No test is its own reward.** Each layer must catch a class of defect the cheaper layer
   below it cannot. We do not add E2E for what a unit test proves, and we do not pretend a unit
   test proves cross-tenant isolation.

This section does **not** define the CI pipeline mechanics (runners, caching, gating order,
auto-revert) — that is [§44](./44-cicd-release.md), cross-referenced throughout. It does define
the **coverage threshold gate** and the **RLS/contract gates** as *requirements* §44 must enforce.

---

## 43.2 The test pyramid

We hold to the classic pyramid: many fast, cheap, deterministic tests at the base; few slow,
expensive, end-to-end tests at the top. The width of each band is the *relative count* of tests;
the cost annotation is *relative wall-clock + flake risk*. Autopilot adds two cross-cutting
bands that are not strictly "above" or "below" — contract and the engine-specific deterministic
tick tests — drawn alongside the layer they protect.

```
                         ▲  fewer, slower, higher-fidelity, more flake-prone
                         │
            ┌────────────────────────┐
            │   LOAD / SOAK (k6)      │   §43.9  — capacity & stability, off the PR path
            └────────────────────────┘
          ┌──────────────────────────────┐
          │   E2E (Playwright)           │   §43.6  — critical user flows, real browser
          └──────────────────────────────┘
       ┌────────────────────────────────────┐
       │  INTEGRATION (Express + test DB)    │  §43.5  — routes · auth · RLS isolation
       └────────────────────────────────────┘
   ┌──────────────┐                ┌────────────────────────┐
   │ CONTRACT     │  §43.7         │  VISUAL REGRESSION      │  §43.8
   │ (provider +  │  (cross-cuts:  │  (gallery snapshots)    │  (cross-cuts the UI;
   │  OpenAPI)    │   ties F1/F7)  └────────────────────────┘   ties F9)
   └──────────────┘
┌──────────────────────────────────────────────────────────────┐
│  UNIT (vitest) — 124 files today; the broad, fast base        │  §43.4  ◄ SHIPPED
└──────────────────────────────────────────────────────────────┘
                         │
                         ▼  more, faster, deterministic, cheap to run on every commit
   ── plus two cross-cutting disciplines that sit beside their target ──
   • ENGINE TESTS (§43.10): deterministic tick · budget/checkpoint/kill · crash-resume · golden builds · eval harness
   • SECURITY (§43.11) + A11Y (§43.12): RLS/authz/SSRF/injection · axe — run as integration/E2E gates
```

The intent of the shape, stated plainly:

| Layer | Answers the question | Why it can't move down the pyramid |
|---|---|---|
| Unit | "Is this function correct in isolation?" | n/a — this is the base. |
| Integration | "Do these modules + the DB + RLS behave together?" | A mocked DB cannot prove a Postgres RLS policy isolates tenants. |
| Contract | "Does the upstream/client still match the shape we assume?" | Drift is invisible to our own unit tests; it lives at the boundary. |
| Visual | "Did the rendered pixels regress?" | A DOM assertion passes while the layout is broken. |
| E2E | "Can a real user complete the flow in a real browser?" | Wiring, routing, auth redirects, and SSE only fail end-to-end. |
| Load | "Does it stay within SLO under N users?" | Latency/saturation only emerge under concurrency. |

---

## 43.3 Current state — audited, honest

The base of the pyramid is genuinely strong; everything above it is missing. This matches the
F5 verdict (🟡 partial: "124 unit files but **zero integration/E2E/contract tests, no coverage
gate**").

**What exists and is good (protect it):**

- **Broad unit breadth via vitest** — **124 test files** (`*.test.ts(x)`), split **59 server /
  65 client** (the F5 split; current `git ls-files` shows 59 server, the remainder client).
  Coverage spans the failure-prone core: `ai/guardrails.test.ts`, `ai/autoRouter.coding.test.ts`,
  `ai/studio/buildAgent.test.ts`, `ai/studio/buildGuards.test.ts`, `ai/agents/verify.test.ts`,
  `ai/jsonCoerce.test.ts`, and many more.
- **A coverage-as-contract pattern worth generalizing** — `components/chat/gallery.coverage.test.ts`
  asserts every renderable artifact type (`ARTIFACT_TYPES`) has a live `ComponentGallery` demo
  (`GALLERY_DEMO_TYPES`) and vice-versa. This is a *structural* test that prevents drift between
  two registries; it is the model for the RLS-coverage and OpenAPI-coverage gates below.
- **The CORS config test** — `server/src/config.cors.test.ts` pins allowed origins; complemented
  by the operational probe `scripts/ops/verify-cors.sh` (and `verify-rate-limit.sh`).
- **CI runs the base on every PR** — the root `.github/workflows/ci.yml` runs `npm run typecheck`,
  `npm run build:server`, `npm run build`, and `npm test -- --run` with **fake** Supabase
  placeholders (a syntactically valid dummy URL so the client import doesn't throw). The
  subdirectory workflows add nightly re-verification and post-merge auto-revert.

**The gaps (named plainly):**

| Gap | Evidence | Risk it leaves open |
|---|---|---|
| **No integration tests** | No suite boots Express against a DB; no `supertest`-style route tests | Route wiring, auth middleware, and RLS regressions ship undetected |
| **No E2E tests** | No Playwright; no `*.spec.ts`; no browser in CI | Sign-in / build / deploy / billing flows can break end-to-end with green unit tests |
| **No contract tests** | F1 admits the code "can't verify" provider response shape (`openrouter.ts`); no OpenAPI (F7) | A provider or client shape change silently breaks generation/clients |
| **No coverage gate** | `@vitest/coverage-v8` is not a dependency; no `coverage` config in `vite.config.ts` | Coverage can rot; no objective floor; no ratchet |
| **No visual regression** | No Playwright snapshots; the gallery is asserted structurally, not visually | A CSS/token change can break the design system invisibly (ties F9) |
| **No load test** | `load-test-plan.md` is a *plan*; no executable k6 script | SLOs in the plan have nothing exercising them |
| **No a11y tests** | No `axe` in CI (F9/§20 call for it) | WCAG-AA regressions ship |
| **Env-coupled / non-hermetic suites** | `CLAUDE.md`: "a few suites fail locally only because Supabase env vars are unset — that's environmental, not a regression" | Tests depend on ambient env; flaky locally; CI papers over it with placeholders |
| **Single inline vitest config** | `vite.config.ts` `test:` block (jsdom, globals, one project for client+server) | Client (jsdom) and server (node) share one environment; no project separation, no per-layer config |

**Net:** a wide, fast base with a healthy structural-test habit, sitting on no DB-backed,
no browser-backed, and no boundary-backed layers, with no objective coverage floor. F5 closes
exactly this set.

---

## 43.4 Target — unit (keep and expand)

Unit stays the base and grows. No regression of the 124 files; new code lands with unit tests.

- **Keep** the vitest base; keep the gallery-coverage and CORS-config structural tests.
- **Split the vitest config into projects** (vitest *workspace*): a `client` project
  (`environment: 'jsdom'`, `setupFiles: ./tests/setup.ts`) and a `server` project
  (`environment: 'node'`). Today both run under one jsdom config; the server has no need of a
  DOM and the coupling hides node-only assumptions. This is the prerequisite for clean
  per-project coverage thresholds (§43.13).
- **Expand** unit coverage on pure logic that must never regress: the **budget evaluator**
  (`ventures/budget.ts`, A0), the **checkpoint state machine** (`ventures/checkpoints.ts`),
  the **event writer** (`ventures/events.ts`), the **DECIDE gate** purity, JSON coercion, the
  auto-router, and guardrail redaction.
- **Treat structural/coverage tests as a first-class unit category.** Generalize the
  gallery pattern: a unit test that asserts *every* RLS-bearing table appears in a registry,
  *every* route appears in the OpenAPI spec, *every* artifact has a gallery demo. These are
  cheap, deterministic, and catch whole classes of "you forgot to register X."

---

## 43.5 Target — integration (boot Express + a test DB)

The first new layer, and the highest-ROI gap closed. Integration tests boot the **real Express
app** against a **real Postgres with RLS applied**, and exercise routes through HTTP.

- **Harness:** a `tests/integration/` suite that imports the Express app factory (not a mocked
  router) and drives it with `supertest`. The DB is a **disposable Postgres** — local Supabase
  (`supabase start`) or a containerized Postgres seeded with `server/sql/*.sql` (the same DDL +
  RLS the F6 migration runner applies), so the policy under test is the policy that ships.
- **What it must cover:**
  - **Auth middleware** — a request with no/invalid/expired JWT is rejected; a valid one resolves
    to the right user; admin-gated routes reject non-admins.
  - **Key routes** — happy-path + validation-error shapes for the studio routes today and the
    `/api/ventures/*` surface (A1): list/create/get/update/delete, goals, checkpoints, budget,
    connections, events, runs.
  - **RLS isolation (the headline test)** — seed user A and user B; assert **user A cannot read,
    update, or delete user B's** venture / goal / project / event rows, exercised through the API
    with A's token. This is the test F5's acceptance singles out ("an RLS regression fails CI")
    and what A1/A9 acceptance both demand. It cannot be faked at the unit layer.
  - **Idempotency** (F2) — replaying a mutating request with the same idempotency key is a no-op.
  - **Shared limits** (F2) — rate-limit / concurrency caps enforced through the route.
- **Hermetic** by construction: the DB is created, migrated, seeded, and torn down by the test —
  no ambient Supabase project, no shared state between runs (§43.13).

---

## 43.6 Target — E2E (Playwright, critical flows only)

E2E proves a *real user* can complete the load-bearing journeys in a *real browser*. Kept
deliberately thin — only the flows whose breakage is a P1, because E2E is the slowest and
flakiest band.

- **Tool:** Playwright (`tests/e2e/*.spec.ts`), Chromium primary, with a seeded test account.
- **Critical flows (F5's happy-paths):** sign-in → chat (send a message, render an artifact) →
  build (kick a studio build, see a preview) → deploy (managed preview link) → billing (open
  the portal, see spend). For Autopilot add: intake → approve roadmap → watch a tick advance in
  the live activity stream → approve a production checkpoint.
- **SSE coverage:** the Operator Console's `/api/ventures/:id/stream` event stream is E2E-only
  territory — a unit/integration test cannot prove the browser receives and renders live events.
- **Discipline:** no E2E for anything a unit/integration test already proves. Stable selectors
  (`data-testid`), network-idle / explicit waits (no `sleep`), retry-once on the runner, and a
  quarantine label for any test that flakes twice (it leaves the gate until fixed) — see §44.

---

## 43.7 Target — contract tests (the boundary layer, ties F1 + F7)

Contract tests guard the two boundaries our own tests are blind to: the **providers we call**
and the **clients that call us**.

- **Provider contract (ties F1).** F1 notes the generation code admits it "can't verify"
  upstream response shape (`openrouter.ts`). The fix: **recorded fixtures** (sanitized real
  responses) for OpenRouter and NVIDIA, asserted against the parser the gateway uses. If a
  provider changes its response shape, the fixture test fails *before* production does. Pair with
  the existing `npm run openrouter:smoketest` run **nightly** against the live API (not on the PR
  path — it costs money and needs a key) to catch drift the fixtures can't (new error codes,
  auth changes). This is exactly F1's "provider contract tests (recorded fixtures) … run
  `openrouter:smoketest` in CI nightly."
- **OpenAPI contract (ties F7).** Once F7 generates an **OpenAPI** spec from the zod-validated
  routes (F8), add: (1) a **coverage test** — every Express route appears in the spec (the
  gallery-coverage pattern, applied to routes); (2) a **client contract test** — the
  generated typed client compiles and round-trips against the spec; (3) **response-schema
  validation** in integration tests — actual route responses validate against their OpenAPI
  schema, so the spec can't lie.

Contract tests run on every PR (fixtures are deterministic and offline); the live smoketest runs
nightly.

---

## 43.8 Target — visual regression (gallery snapshots, ties F9)

The `ComponentGallery` is asserted *structurally* today (every type has a demo) but never
*visually*. F9's design-system unification (single token source feeding Tailwind +
`kit/theme.ts`) makes a silent visual regression a real risk — a token change can break every
artifact at once.

- **Tool:** Playwright screenshot snapshots over the gallery (and, per F9, the broader
  app/studio component catalog once the gallery is extended beyond chat artifacts).
- **What it pins:** one snapshot per gallery demo entry; the snapshot set is *defined by*
  `GALLERY_DEMO_TYPES`, so adding a component automatically demands a baseline (the structural
  test already forces a demo to exist; this forces it to *look right*).
- **Discipline:** deterministic rendering (fixed viewport, disabled animations — the house style
  uses `animate-fade-in`; freeze it for snapshots), masked dynamic regions, baselines committed
  and reviewed. A diff is a *reviewable change*, not an automatic failure — but it gates merge.

---

## 43.9 Target — load (k6, from the load-test plan)

Make [`load-test-plan.md`](../../../production/load-test-plan.md) **executable**. F5 calls for an
"executable load test (k6)"; A9 reuses it to verify rate limits + concurrency caps + sandbox
quotas under load.

- **Scenarios (verbatim from the plan):** auth-only; text generation (`/api/text/*`); image
  generation (`/api/image/*`, conservative concurrency for cost); mixed (text/image/vision/system
  ratio); burst (spikes for rate-limit + retry behavior).
- **Tiers:** 100 / 300 / 600 / 1000 virtual users.
- **k6 thresholds encode the plan's acceptance criteria** so a run passes/fails objectively:

  | Plan criterion | k6 threshold |
  |---|---|
  | 5xx ratio < 1% sustained | `rate(http_5xx) < 0.01` |
  | p95 < 2.5s non-image | `p(95) < 2500ms` (tag: non-image) |
  | Controlled 429s under burst, no crash | 429s observed *and* service stays up (5xx flat) |
  | No memory growth over 30 min | soak stage; RSS slope ≈ 0 (from F0 metrics) |
  | Provider failure ratio visible | assert provider error counters (F1/F0) emit |

- **Where it runs:** **off the PR path** — staging on a schedule and before a release window
  (per the plan's "staging first, production only in controlled windows"). It is a release gate
  and a capacity tool, not a per-commit check (§44).

---

## 43.10 Testing the AUTONOMOUS engine specifically

The engine ([§24](./24-autonomous-engine.md)) is the riskiest thing we run: always-on, spends
money, writes and ships code. It demands test disciplines a request/response app does not. The
master plan is explicit — **the brakes (A0) ship and are tested before the engine (A2) runs**;
this subsection is how we prove that.

- **Deterministic tick tests.** A Tick (SENSE→ORIENT→DECIDE→ACT→VERIFY→SHIP→REFLECT) must be
  testable without the LLM, the sandbox, or a provider being live. **Inject** ORIENT's model
  call (a fake that returns a scripted goal), stub ACT (A2 ships ACT as a stub *precisely so the
  governance can be proven in isolation*), and assert: a tick advances a goal; an event is
  appended with the right `what/why/cost/result`; the phase machine transitions correctly. The
  **DECIDE gate is pure** (no LLM) and gets exhaustive unit coverage — a confused model must not
  be able to argue past it.
- **Brakes: budget / checkpoint / kill / no-progress.** One test per guard, each asserting a
  *hard stop*:
  - **Budget breach mid-run** → venture pauses + notifies (no further spend).
  - **Checkpoint required** (prod deploy, spend money, destructive, publish, scope change,
    roadmap approval) → loop pauses on that goal, raises a checkpoint, independent goals continue.
  - **Global kill switch** (`VENTURES_KILL`) → the scheduler stops enqueuing; an in-flight tick
    honors it at the next phase boundary.
  - **No-progress detector** → same goal/error N times → raise a checkpoint instead of looping.
  - **Max ticks/run + wall-clock per tick** → loop terminates; **concurrency cap** → global
    max concurrent ticks holds (cross-instance, ties F2).
  - **Scope guard** → ORIENT proposing an out-of-scope goal raises a scope checkpoint.
- **Crash-resume (durability).** Kill the worker between every pair of phase boundaries and
  assert: resume from the last persisted phase; **never re-charge** for completed work; **never
  double-ship**. This is A2's acceptance ("survives a worker restart") and the core durability
  claim of §24.9. Test it as a matrix over the seven phase boundaries.
- **Golden-path build sims.** End-to-end simulation of a small venture (e.g. "add a landing
  page") with a *recorded* model + a *fake/managed-preview* deploy adapter: assert the backlog
  advances, a passing `studio_version` is produced, cost is metered, and a stuck build triggers
  FIX-within-cap then a checkpoint. Deterministic because the model and provider are recorded.
- **Eval harness for build quality.** Beyond "did it pass" — *was the build good?* A small
  **golden-set** of venture goals, each with an automated scorer (build succeeds, typecheck
  clean, tests pass, no committed secrets, basic Lighthouse/a11y floor). Run nightly; track the
  pass-rate as a quality metric, gate *model/prompt changes* in the build engine on no
  regression. This is how we keep "it builds itself" from silently degrading when a model or
  prompt changes.

---

## 43.11 Security tests (RLS / authz / SSRF / injection)

Security gets dedicated tests, not just incidental coverage, because the master plan's whole
multi-tenant stance (§5) rests on them and A9 makes them a GA gate.

- **RLS / tenant isolation** — the integration test in §43.5, plus an **RLS-coverage check**
  (ties F6): a CI test that fails if *any* `venture_*` or `studio_*` table lacks a policy, and a
  run of Supabase `get_advisors` in CI. "Every table has a policy" is the gallery-coverage
  pattern applied to security.
- **Authz** — every admin/owner-gated route rejects the wrong role; `ADMIN_EMAILS` is required in
  prod (no `admin@test.com` default — F8); plan/role gating on `VENTURES_ENABLED`.
- **SSRF** — the existing user-URL guards (MCP client, search tools) get explicit tests:
  internal/metadata IPs, redirects to private ranges, and DNS-rebind shapes are blocked.
- **Injection** — zod validation (F8) on all mutating routes is asserted (rejects malformed
  bodies with a consistent error shape); the **code-safety scan** before ship (A9) is tested
  against fixtures containing committed secrets and dangerous ops (`rm -rf`, `eval`, exfiltration).
- **Supply chain (F8)** — `npm audit` / Dependabot, secret scanning (gitleaks/trufflehog +
  `run_secret_scanning`), and CodeQL are CI gates owned by §44; this section requires they block
  merge on a known vuln or committed secret.

---

## 43.12 Accessibility tests (axe, ties F9/§20)

Per F9 and [§20 — Accessibility](./20-accessibility.md), automated a11y is a CI gate.

- **Tool:** `axe-core` (via `@axe-core/playwright`) run over key views and over the component
  gallery — pairing naturally with the visual-regression sweep (§43.8) since both walk the
  gallery.
- **Bar:** WCAG-AA — zero `critical`/`serious` axe violations on gated views; contrast and
  keyboard-navigation checks; ARIA coverage targets for interactive components.
- **Scope:** the Operator Console, intake wizard, billing portal, and the artifact gallery.
  Manual screen-reader and full keyboard audits remain a periodic human task (§20), not a CI gate.

---

## 43.13 Coverage tooling + CI threshold gate (ratchet) and hermetic env

**Coverage tooling.** Add `@vitest/coverage-v8`; enable `coverage` in the (now project-split,
§43.4) vitest config with `reporter: ['text', 'lcov', 'json-summary']`. Coverage uploads as a
CI artifact and to the PR.

**The gate is a ratchet, not a cliff.** F5 says "start realistic, ratchet." We set a per-project
floor at *just below current measured coverage*, fail CI on a drop, and raise the floor in small
steps as coverage grows. Never set an aspirational floor that's red on day one — that trains
people to disable the gate.

| Project | Initial floor (set to ~current) | Near-term target | How it ratchets |
|---|---|---|---|
| `server` (lines) | measured baseline − 1% | 70% | +2–3% per quarter, never down |
| `client` (lines) | measured baseline − 1% | 65% | +2–3% per quarter |
| Critical paths* | 90% (hard floor from day one) | 95% | never below 90% |

\* *Critical paths = the brakes and gates: `ventures/budget.ts`, `ventures/checkpoints.ts`,
`ventures/events.ts`, the DECIDE gate, `ai/guardrails.ts`, and auth middleware. These are
spend/security-bearing; they get a high floor immediately regardless of repo-wide numbers.*

**Hermetic test env (fix the Supabase coupling).** `CLAUDE.md` documents the smell: "a few
suites fail locally only because Supabase env vars are unset." Hermetic means a test never
depends on ambient env:

- **Unit:** never touch the network; the Supabase client is **mocked/faked** in `tests/setup.ts`,
  not pointed at a placeholder URL that throws. (CI's fake placeholders are a band-aid for the
  import-time throw, not hermeticity.)
- **Integration:** the **only** DB-touching layer; it owns a disposable Postgres it
  creates/migrates/seeds/tears-down — no shared project, deterministic seed, isolated per run.
- **Outcome (F5 acceptance):** a fresh checkout with **no env vars set** runs the full unit suite
  green; integration spins up its own DB. No suite "fails locally only because env is unset."

---

## 43.14 Test data management

- **Fixtures over live calls.** Provider responses (§43.7), model catalog snapshots, and build
  outputs are **recorded fixtures**, sanitized of secrets/PII (reuse `guardrails.ts` redaction),
  versioned in-repo. Determinism is the goal: the same input → the same test result, offline.
- **Seed builders, not raw SQL dumps.** Integration/E2E use typed seed helpers (`makeUser`,
  `makeVenture`, `makeGoal`) that produce minimal, isolated graphs per test; each test seeds what
  it needs and tears it down — no shared golden DB that drifts.
- **The golden set (engine evals).** §43.10's eval harness keeps a curated set of venture goals
  + expected-quality scorers under version control; changes to the set are reviewed like code.
- **No real secrets, ever.** Test keys are dummies; the secret-scan gate (F8) runs on the test
  tree too, so a real key committed to a fixture fails CI.
- **PII discipline.** Recorded fixtures are scrubbed; synthetic users use clearly-fake emails.

---

## 43.15 CI integration (cross-ref §44)

This section defines *what runs and to what bar*; [§44 — CI/CD & release management](./44-cicd-release.md)
owns the pipeline that runs it. The required gating, by stage:

| Stage / trigger | Layers run | Gate |
|---|---|---|
| **Every PR (fast)** | typecheck (client+server) · build · **unit** · contract (offline fixtures) · **RLS-coverage** structural check · OpenAPI-coverage check · coverage **ratchet** · axe (static views) | **Blocking** |
| **Every PR (DB)** | **integration** (Express + disposable Postgres, incl. RLS isolation) | **Blocking** |
| **Every PR (browser)** | **E2E** critical flows · **visual regression** (gallery) | Blocking (E2E flakes quarantined per §43.6) |
| **PR security gates (F8)** | `npm audit`/Dependabot · secret scan · CodeQL | **Blocking** on vuln/secret |
| **Nightly** | provider live smoketest (`openrouter:smoketest`) · `get_advisors` · **engine eval harness** · full coverage report | Alerts/file findings (auto-fix per existing `verification.yml`) |
| **Pre-release / scheduled** | **k6 load** (staging, tiers 100–1000) · soak | **Release gate** (not per-commit) |

Today CI (root `ci.yml`) runs only the **fast** unit/typecheck/build column. F5 + §44 add the DB,
browser, security, nightly, and release columns. The existing nightly `verification.yml` and the
`post-merge-verify.yml` auto-revert are the foundation the new gates extend, not replace.

---

## 43.16 Mapping to foundations & acceptance

| F-ref | This section delivers | F5 acceptance line satisfied |
|---|---|---|
| **F5** | The whole pyramid: unit (keep) + integration + E2E + contract + coverage gate + visual + load + hermetic env | "CI runs unit + integration + E2E + coverage gate; an RLS regression fails CI; a provider shape change fails CI; load test is runnable" |
| **F1** | Provider contract tests (recorded fixtures) + nightly `openrouter:smoketest` (§43.7) | "a provider shape change fails CI" |
| **F7** | OpenAPI coverage test + generated-client contract test + response-schema validation (§43.7) | every route in the spec; generated client compiles |
| **F9** | Visual-regression gallery snapshots + axe a11y in CI (§43.8, §43.12) | "the catalog covers the app; axe passes in CI" |
| **F6** | RLS-coverage CI check + `get_advisors` (§43.11) | "CI fails if a table lacks RLS" |
| **F8** | Security gates (audit/secret-scan/CodeQL) + zod-validation + code-safety scan tests (§43.11) | "CI blocks on a known vuln or committed secret" |
| **§20** | axe automated a11y gate at WCAG-AA (§43.12) | accessibility regressions gated |
| **A0/A2/A9** | Engine tests: deterministic tick, brakes, crash-resume, golden builds, eval harness (§43.10) | "budget breach pauses; kill switch stops; no-progress raises checkpoint; crash mid-tick resumes" |

**One-line stance:** we have a strong, broad unit base and a healthy structural-test habit; F5
keeps that base, adds the DB-, boundary-, browser-, and load-backed layers it's missing, makes
the suite hermetic, and puts an honest, ratcheting coverage gate plus engine-specific durability
and brake tests in front of the riskiest thing we run — the always-on autonomous loop.
