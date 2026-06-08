# 44 — CI/CD & Release Management

> Part IV · Non-functional / Foundations · Canon: [SPEC-INDEX](../SPEC-INDEX.md) ·
> [Master Plan](../00-MASTER-PLAN.md) (A5 ship, A9 GA gating) ·
> [Enterprise Foundations](../F-ENTERPRISE-FOUNDATIONS.md) (**F5** testing/coverage gate,
> **F6** migrations, **F8** supply-chain security) · [Operating Model](../OPERATING-MODEL.md)
> (the continuous build loop) · [Testing Strategy](./43-testing-strategy.md) (the suites this
> pipeline runs) · [Deploy Adapters](./31-deploy-adapters.md) (the SHIP contract this
> orchestrates) · [Cloudflare Topology](./23-cloudflare-topology.md) (the studio-worker) ·
> repo: `.github/workflows/*`, `dreamstreamcomicstudio/.github/workflows/*`,
> `studio-worker/wrangler.jsonc`, root `docs/production/deployment-runbook.md`.

## 44.1 Scope & stance

This section specs how code moves from a commit to live users: the **PR gate**, the
**deploy targets**, **migrations**, **staged rollout**, **health verification**,
**rollback**, **feature flags**, **versioning/changelog discipline**, and **secrets in
CI** — plus how Claude's continuous build loop ([Operating Model](../OPERATING-MODEL.md))
maps onto all of it.

**House rule for this section: mark shipped vs planned honestly.** Today's release process
is real but thin — a read-only PR CI, a manual two-target deploy, and an unusual
self-healing nightly verification loop. The TARGET pipeline is the enterprise bar the
F-series buys us. We do not pretend the gates exist before F5/F6/F8 land.

| Concern | Status today | Target (owner) |
|---|---|---|
| PR CI (typecheck/build/unit) | **shipped** (root `ci.yml`) | extend with integration + E2E + coverage + security + a11y (F5/F8/F9) |
| Coverage gate | **planned** | **F5** — `@vitest/coverage-v8` + CI threshold, ratcheted |
| Security scans (audit/secrets/CodeQL) | **planned** | **F8** — `npm audit`/Dependabot, gitleaks, CodeQL |
| Migration runner | **planned** (run-by-hand `.sql`) | **F6** — ordered/versioned/idempotent migrations + RLS-coverage check |
| Preview deploy per PR | **partial** (studio-worker preview substrate shipped; PR previews not wired) | managed per-PR preview env |
| Staged rollout + auto-rollback | **partial** (nightly auto-revert exists; no staged %) | health-gated staged rollout + auto-rollback |
| Versioning/changelog | **shipped** (mandatory `STATUS`/`CHANGELOG` per [AGENTS.md](../../AGENTS.md)) | + semver tags + release notes from CHANGELOG |
| studio-worker deploy | **shipped** (manual `wrangler deploy`) | gated CI deploy job, separate from app |

---

## 44.2 Current state — honestly

### 44.2.1 The root PR gate (`/.github/workflows/ci.yml`) — **shipped**

The repo's only enforced-on-PR check. It exists because the *other* workflows live in
`dreamstreamcomicstudio/.github/workflows/` — a **subdirectory GitHub Actions never scans**
— so for a while no CI ran on PRs at all. The root `ci.yml` is deliberately **read-only**:
`permissions: contents: read`, no secrets, no write, no auto-merge.

| Property | Value |
|---|---|
| Triggers | `pull_request`, `push` → `Dreamstrream-v1`, `workflow_dispatch` |
| Working dir | `dreamstreamcomicstudio` |
| Node | 20, npm cache keyed on `dreamstreamcomicstudio/package-lock.json` |
| Steps | `npm ci` → `npm run typecheck` + `npm run build:server` → `npm run build` → `npm test -- --run` |
| Supabase env | **fake placeholders** — `VITE_SUPABASE_URL=https://placeholder.supabase.co`, `VITE_SUPABASE_ANON_KEY=placeholder-anon-key` |

The placeholder env is a deliberate hack, not a secret: `services/supabase.ts` throws at
import if the URL is empty, so a syntactically valid dummy URL lets the suite *load*. The
tests never contact Supabase. (This is the env-coupling F5 will make hermetic.) Net: this
gate proves the app **typechecks, builds, and passes unit tests** — nothing about
integration, RLS, E2E, coverage, security, or accessibility yet.

### 44.2.2 The subdirectory workflows — **shipped, but a different machine**

These are not classic CI; they are a scheduled **self-healing verification loop** with
write access and secrets. They never run on arbitrary PRs (the subdir invisibility is why
the root `ci.yml` had to exist), only on schedule, dispatch, or pushes to
`Dreamstrream-v1`.

| Workflow | Trigger | What it does |
|---|---|---|
| `verification.yml` | nightly `03:15 UTC` + dispatch | `npm ci` → typecheck (client + `server/tsconfig.json`) → tests → run all enabled **verification checks**; files findings to the DB |
| `auto-fix.yml` | issue `labeled: auto-fix`, PR events, dispatch | guards (kill-switch `AUTO_FIX_DISABLED`, authorized-labeller) → dispatch **Claude Code Action** (`issue_to_pr`) → `auto-merge` job: protected-path regex (billing/auth/migrations/workflows), `MAX_DIFF_LINES=600`, re-run the originally-failing check, then squash auto-merge |
| `post-merge-verify.yml` | push → `Dreamstrream-v1` (commit msg contains `verification-fix`) | reinstall + typecheck + tests → re-run all checks → on regression, **`git revert -m 1` and push** (auto-rollback of source) |
| `daily-billing-check.yml` | `03:30 UTC` + dispatch | `npm run billing:reconcile:check` |
| `daily-pricing-check.yml` | scheduled + dispatch | pricing drift check |
| `refresh-model-catalog.yml` | hourly `:30` + dispatch | `npm run catalog:refresh` (keeps public `/models` fresh; uses platform keys) |

Two things matter here for release management. First, **a real auto-revert already
exists** (`post-merge-verify.yml`) — the staged-rollout/auto-rollback target below
generalizes this from "revert the source commit" to "roll back the deploy." Second, the
auto-fix system is *itself* a CI-driven autonomy loop with hard brakes (kill switch,
protected paths, diff cap, post-merge revert) — a working precedent for the safety pattern
Autopilot's SHIP step (A5) inherits.

### 44.2.3 Deploy targets & the production branch — **shipped (manual)**

Production is the **`Dreamstrream-v1`** branch. Two independent build systems watch it:

| Target | Builds from | Command / output | Notes |
|---|---|---|---|
| **Cloudflare Pages** (frontend) | `Dreamstrream-v1`, root `dreamstreamcomicstudio` | `npm run build` → `dist/`; then `npm run verify:world-contract` | static Vite bundle; purge CF cache after deploy |
| **Railway** (backend) | same repo/commit | repo `Dockerfile`, port `7071` | Express/TS API; deploy **first** so frontend never points at an older API |
| **Supabase** | — | DB/Auth/Storage | migrations applied by hand today (F6 fixes this) |
| **studio-worker** | `studio-worker/` | `wrangler deploy` (manual, separate) | owns the Sandbox DO + Container + preview URLs |

Per the [deployment runbook](../../../production/deployment-runbook.md): pin both targets to
the same commit SHA, **deploy backend first**, verify `/api/system/version` reports the
target `gitSha`, then deploy the frontend from the same SHA, purge cache, and confirm
`gitSha` matches across runtime diagnostics. Releasing = fast-forward/merge the feature
branch into `Dreamstrream-v1` and push (it diverges between sessions, so fetch + merge
first). **Never force-push production.**

### 44.2.4 The flag-gated / no-op-until-configured ship pattern — **shipped**

The standing rule is *ship to production every completed change* ([CLAUDE.md](../../../../CLAUDE.md)).
That is only safe because every infra-dependent feature is **flag-gated or a no-op until
configured**, so merging to `Dreamstrream-v1` cannot change live behavior until the owner
flips a switch:

- `VENTURES_ENABLED` defaults **false** — nothing autonomous runs in prod until A9 GA.
- `VITE_STUDIO_LIVE_ENABLED` gates the live studio-worker substrate (default off; the
  frontend rebuilds with it on).
- `BILLING_ENABLED` (`server/src/config.ts:40`) gates Stripe paths.
- New tables/migrations are additive; BYO creds live only in Nango, never in code.

This is the release-safety invariant the whole "always ship" rule rests on: **prod
behavior is unchanged until a flag/config is set.**

---

## 44.3 The TARGET pipeline

```
            ┌──────────────────────────────────────────────────────────────────────┐
            │                        DEVELOPER / CLAUDE LOOP                         │
            │   pick task → branch (claude/*) → implement (small, flag-gated)        │
            └───────────────────────────────┬──────────────────────────────────────┘
                                             │ open / push PR
                                             ▼
   ┌─────────────────────────────────────────────────────────────────────────────────┐
   │ STAGE 1 — PR CI  (required checks, read-only, fake Supabase env)                   │
   │  ┌───────────┐ ┌─────────┐ ┌──────────────────────────┐ ┌───────────┐ ┌────────┐ │
   │  │ typecheck │ │  build  │ │ unit + integration + E2E │ │ coverage  │ │ a11y   │ │
   │  │ +build:srv│ │ (vite)  │ │   (RLS isolation, auth)  │ │ gate (F5) │ │ axe(F9)│ │
   │  └───────────┘ └─────────┘ └──────────────────────────┘ └───────────┘ └────────┘ │
   │  ┌──────────────────────── SECURITY (F8) ───────────────────────────┐            │
   │  │ npm audit / Dependabot · gitleaks secret scan · CodeQL            │            │
   │  └──────────────────────────────────────────────────────────────────┘            │
   └───────────────────────────────────────┬─────────────────────────────────────────┘
                                            │ all green
                                            ▼
                          ┌────────────────────────────────┐
                          │ STAGE 2 — PREVIEW DEPLOY (per PR)│  ephemeral env + preview URL
                          │ CF Pages preview · isolated DB   │  (managed; auto-torn-down)
                          └───────────────┬─────────────────┘
                                          │ review + approve → merge to Dreamstrream-v1
                                          ▼
   ┌─────────────────────────────────────────────────────────────────────────────────┐
   │ STAGE 3 — RELEASE (on push to Dreamstrream-v1)                                     │
   │  migrations (F6 runner, ordered/idempotent + RLS-coverage check)                   │
   │       │                                                                            │
   │       ▼                                                                            │
   │  deploy BACKEND (Railway) ──► verify /api/system/version gitSha == target          │
   │       │                                                                            │
   │       ▼                                                                            │
   │  deploy FRONTEND (CF Pages, same SHA) ──► verify:world-contract ──► purge cache    │
   │       │                                                                            │
   │       ▼                                                                            │
   │  STAGED ROLLOUT  ──►  HEALTH VERIFY  ──►  [healthy?]──yes──► promote 100%           │
   │  (5% → 25% → 100%)    /health /ready          │                                    │
   │  via flags/canary     5xx · p95 · err budget  └──no──► AUTO-ROLLBACK (prev deploy  │
   │                                                          + revert source, F37 SLO) │
   └───────────────────────────────────────┬─────────────────────────────────────────┘
                                            ▼
                          ┌────────────────────────────────┐
                          │ studio-worker deploy (separate) │  wrangler deploy (gated job;
                          │  Sandbox DO + Container + preview│  own typecheck, never in app CI)
                          └────────────────────────────────┘
```

### 44.3.1 Stage 1 — PR CI

Extends today's read-only `ci.yml`. Every job is a **required status check** on PRs into
`Dreamstrream-v1`:

| Job | What it runs | Foundation |
|---|---|---|
| typecheck | `npm run typecheck` + `npm run build:server` | (shipped) |
| build | `npm run build` (frontend, bundles `studio.html`) | (shipped) |
| unit | `npx vitest run` | (shipped) |
| **integration** | boot Express + test DB; auth, key routes, **RLS isolation (user A ≠ user B)** | **F5** |
| **E2E** | Playwright: sign-in, chat, build, deploy, billing happy-paths | **F5** |
| **coverage gate** | `@vitest/coverage-v8` + threshold (start realistic, ratchet) — RLS regression fails CI | **F5** |
| **security** | `npm audit`/Dependabot, gitleaks/trufflehog secret scan, CodeQL | **F8** |
| **a11y** | axe automated checks on the component gallery | **F9** |
| contract | recorded OpenRouter/NVIDIA fixtures — a response-shape drift fails CI | **F1/F5** |

Until F5/F8/F9 land, only the first three are real; the rest are the acceptance criteria of
those epics ("CI runs unit + integration + E2E + coverage gate; an RLS regression fails CI;
CI blocks on a known vuln or committed secret").

### 44.3.2 Stage 2 — Preview deploy

The studio-worker already mints isolated preview URLs
(`<port>-<id>-<token>.dreamstreamstudio.ai`); the target generalizes this to a **per-PR
managed preview**: a Cloudflare Pages preview deployment plus an isolated DB branch, posted
as a PR comment, auto-torn-down on merge/close. This is also where a human (or Claude's PR
subscription) reviews the running change before it touches production.

### 44.3.3 Stage 3 — Release, staged rollout, health verify, auto-rollback

On push to `Dreamstrream-v1`:

1. **Migrations (F6).** The migration runner applies ordered, versioned, idempotent
   migrations *before* the new code serves traffic; the RLS-coverage check fails the
   release if any table lacks a policy. No "run this SQL by hand" step remains. Migrations
   are **expand/contract** (additive first, backfill, then drop) so old and new code
   coexist during rollout — the discipline F6 buys.
2. **Deploy backend first** (Railway), verify `/api/system/version.gitSha == target`.
3. **Deploy frontend** (CF Pages, same SHA), `verify:world-contract`, purge cache, confirm
   `gitSha` matches across diagnostics.
4. **Staged rollout** — promote behind a flag/canary `5% → 25% → 100%` (today's path is
   "flip a flag," which is the simplest staged rollout; A9 adds graduated cohorts).
5. **Health verify** — poll `/api/health` + `/api/system/ready`; watch 5xx rate, p95
   latency, and the error budget (the F0 metrics feeding the [SRE SLOs](./37-reliability-sre.md)).
6. **Auto-rollback** on breach — redeploy the previous Railway image and previous CF Pages
   deployment (per the runbook's manual rollback, automated), and revert the source. This
   *promotes* the existing `post-merge-verify.yml` auto-revert from "revert the bad commit"
   to "roll back the deploy and the commit."

---

## 44.4 Environments

| Env | Branch / trigger | Frontend | Backend | Data | Purpose |
|---|---|---|---|---|---|
| **dev** | local | `vite` | `npm run dev` | local/placeholder Supabase | inner loop; the four verify commands |
| **preview** | per-PR (Stage 2) | CF Pages preview | ephemeral Railway/CF | isolated DB branch | review a running change; E2E target |
| **staging** | pre-prod (planned) | CF Pages staging | Railway staging | staging Supabase | migration dry-run + smoke before prod |
| **prod** | `Dreamstrream-v1` | CF Pages | Railway | prod Supabase | live users; flag-gated rollout |

`APP_VERSION` / `GIT_SHA` / `BUILD_TIMESTAMP` are set per target so `/api/system/version`
is the cross-environment source of truth for "what's actually running."

---

## 44.5 Feature flags & progressive rollout

Flags are the release-safety mechanism that makes "always ship to prod" survivable and that
turn a deploy into a *gradual* exposure rather than a big-bang.

| Flag | Default | Gates | Scope |
|---|---|---|---|
| `VENTURES_ENABLED` | **false** | all Autopilot autonomy | server (A9 GA) |
| `VITE_STUDIO_LIVE_ENABLED` | false | live studio-worker substrate | frontend build |
| `BILLING_ENABLED` | env-driven | Stripe paths (`config.ts:40`) | server |
| `AUTO_FIX_DISABLED` (repo var) | unset | kill-switch for the auto-fix loop | CI |

**Progressive rollout = flag + cohort.** New surfaces ship **dark** (flag off, code merged
and tested), enable for **internal/owner** first, then a **percentage cohort**, then 100% —
each step gated on the health signals in §44.3.3. A bad release is killed by flipping the
flag (instant, no redeploy) before auto-rollback is even needed. This is why the **brakes
(A0) ship before the engine** and why nothing autonomous is wired to real builds/deploys
until A0–A2 are tested ([Operating Model](../OPERATING-MODEL.md) safety defaults).

---

## 44.6 Release versioning & changelog discipline

Versioning here is **doc-first and mandatory**, not optional release hygiene. Per
[AGENTS.md](../../AGENTS.md) §3, every change MUST:

1. Update **`STATUS.md`** — phase status, next step, blockers, "last updated" (the owner's
   single resume anchor; a stale STATUS means the loop is broken).
2. Append to **`CHANGELOG.md`** (newest first) — date, what changed, files touched,
   follow-ups.
3. Update **`OWNER-ACTIONS.md`** when a new owner action / deferred validation appears.

| Artifact | Source of truth | Cadence |
|---|---|---|
| `STATUS.md` / spec index ticks | per task | every commit |
| `CHANGELOG.md` | per task | every commit |
| `package.json` version | semver bump | per release |
| Git tag `vX.Y.Z` on `Dreamstrream-v1` | release commit SHA | per release (target) |
| Release notes | generated from CHANGELOG entries since last tag | per release (target) |
| `/api/system/version` (`APP_VERSION`/`GIT_SHA`/`BUILD_TIMESTAMP`) | deploy env | per deploy |

The target adds **semver tags** + **CHANGELOG-derived release notes** on top of the
existing mandatory STATUS/CHANGELOG discipline — turning the loop's per-task journal into
auditable, attributable releases.

---

## 44.7 The studio-worker deploy (separate)

The studio-worker (`studio-worker/`, owns the Sandbox Durable Object + Container + preview
URLs) is **excluded from the app's `tsconfig` and CI** (AGENTS.md §4) and deploys on its own
track:

| Aspect | Detail |
|---|---|
| Deploy | `wrangler deploy` (`studio-worker/package.json` → `deploy`) |
| Config | `studio-worker/wrangler.jsonc` — `nodejs_compat`, container `standard-3` (≤50 instances), Sandbox DO binding, migration tag `v1` |
| Routes | wildcard `*.dreamstreamstudio.ai/*`; control endpoint on `*.workers.dev` (Railway's `STUDIO_WORKER_URL`) |
| Verify | `cd studio-worker && npm run typecheck` (its own `npm install`) |
| Owner prereq | `dreamstreamstudio.ai` added as a Cloudflare zone in the account |

**Target:** a gated CI deploy job that runs `studio-worker` typecheck and `wrangler deploy`
on changes under `studio-worker/`, with the same staged-rollout/health discipline — kept
strictly separate from the app pipeline so a worker change never blocks an app release and
vice-versa.

---

## 44.8 Secrets management in CI

| Rule | Mechanism |
|---|---|
| Read-only PR CI holds **no secrets** | root `ci.yml` uses **fake** Supabase placeholders; `permissions: contents: read` |
| Real secrets only in trusted, scheduled/post-merge jobs | `VITE_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `ANTHROPIC_API_KEY` via `secrets.*` in `verification.yml` / `auto-fix.yml` / `refresh-model-catalog.yml` |
| Anthropic key never touches the app | held only by the Claude Code Action; the app never calls the Anthropic API |
| **Never in logs** | reuse `guardrails.ts` redaction; structured logger (F0/pino) with secret redaction; no `echo`-ing env into job output |
| Secret scanning blocks commits | gitleaks/trufflehog + GitHub `run_secret_scanning` (F8) |
| BYO creds never in CI/repo | live only in Nango ([Operating Model](../OPERATING-MODEL.md) safety defaults) |
| Production env vars | set in deploy targets (Railway/CF Pages), per the [runbook](../../../production/deployment-runbook.md) — not in the repo |

The defensive default — **the PR gate has no secrets at all** — is deliberate: it means an
untrusted PR can never exfiltrate credentials through CI, at the cost of using placeholder
env for tests (the coupling F5 makes hermetic).

---

## 44.9 How Claude's continuous build loop maps onto this

The [Operating Model](../OPERATING-MODEL.md) build loop —
`pick → branch → implement → verify → update docs → commit → PR/ship → repeat` — *is* the
front half of this pipeline. The mapping is one-to-one:

| Build-loop step | CI/CD stage |
|---|---|
| pick next task (STATUS → first non-done epic) | — (governance) |
| branch (`claude/*`) | — |
| implement (small, reversible, flag-gated) | feeds Stage 1 |
| **verify** locally (`typecheck && build:server && vitest run && build`) | mirrors Stage 1 jobs |
| update docs (STATUS/CHANGELOG/OWNER-ACTIONS) | §44.6 versioning |
| commit + open/refresh draft PR | triggers Stage 1 + Stage 2 |
| **ship** (merge to `Dreamstrream-v1`) | triggers Stage 3 |
| subscribe to PR activity → auto-fix/iterate | the `auto-fix.yml` loop |
| **STOP & ASK** on owner-gated decisions | the human gate before merge |

The runtime loop and the build loop are **mirror images by design**: the same brakes we
spec for Autopilot's SHIP step (flag-gated, small reversible steps, durable state in docs,
auto-revert on regression, stop at human-gated decisions) are the brakes the build loop
already follows — and `auto-fix.yml` + `post-merge-verify.yml` are a *working
implementation* of that pattern in CI today. A0–A2's brakes must ship and be tested before
the loop wires real autonomous builds/deploys (A4/A5); `VENTURES_ENABLED` stays false in
prod until A9 GA gating and the owner flips it.

---

## 44.10 Acceptance & foundation mapping

| Foundation | This section's gate / artifact | Acceptance |
|---|---|---|
| **F5** Testing & quality gates | Stage 1 integration + E2E + coverage gate; contract tests | CI runs unit + integration + E2E + coverage; an RLS regression fails CI; a provider shape change fails CI |
| **F6** Schema & migrations | Stage 3 migration step + RLS-coverage check | one command applies all migrations in order on a fresh DB; CI fails if a table lacks RLS; no "run SQL by hand" remains |
| **F8** Supply-chain security | Stage 1 security jobs; secrets discipline (§44.8) | CI blocks on a known vuln or committed secret; no default-admin; secrets never logged |
| **A5** Deploy / SHIP | Stage 3 deploy + adapters ([§31](./31-deploy-adapters.md)) | a verified build ships to a live URL behind the prod checkpoint; staged + reversible |
| **A9** GA gating | feature flags + progressive rollout (§44.5) | nothing autonomous in prod until flags flipped; graduated cohorts; instant flag kill |
| **F0/F37** signals (referenced) | health verify + auto-rollback (§44.3.3) | rollout is gated on real 5xx/p95/error-budget signals; breach auto-rolls-back |

**Net:** today we have a real-but-thin gate (read-only typecheck/build/unit) plus an
unusual self-healing nightly verify+auto-revert loop, manual two-target deploys to
`Dreamstrream-v1`, and a flag-gated ship pattern that makes "always ship" safe. The target
turns that into an enterprise pipeline — PR CI with coverage/security/a11y, per-PR
previews, runner-driven migrations, staged rollout with health-gated auto-rollback, and
semver/changelog-driven releases — built on top of (not in place of) the brakes that
already exist.
