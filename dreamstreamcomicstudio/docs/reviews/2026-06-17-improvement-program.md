# Enterprise Improvement Program — Status & Plan (2026-06-17)

A phased program to fix the production pain points found in a four-agent **council
review** grounded in **7 days of live data** from the `Comic` Supabase project
(83 chat turns, 39 critical `server_error`, 16 `chat_failed`, plus the security/
performance advisors). The app is architecturally sound; the problems are in
**model routing, resilience, cost metering, error hygiene, and one auth hole**.

---

## Diagnosis (evidence)

| # | Finding | Evidence |
|---|---------|----------|
| 1 | **Auto picks slow free models.** Router's only tie-break was "largest context window", which on a free/unfunded key selects the huge `:free` reasoners that queue 30–320s. | **55% of chat turns ran >25s**, 0 under 1s. Workhorse `nex-agi/nex-n2-pro:free` = 62/83 turns, avg 56s, p90 109s, max 320s. `model_bench_scores` shows 100/100 models at ~0.6–2s TTFT that were never selected. |
| 2 | **Single un-pooled key, no failover.** Shared OpenRouter key hit its spend cap; failures surfaced as raw provider JSON / generic 500s. | 11× `403 Key limit exceeded`; "Unexpected server error" mislabels in `server_error`. |
| 3 | **Raw errors reach users.** SSE error path streamed `error.message`; client had no backstop for key-limit/credits/DB strings. | `chat_failed` telemetry with provider JSON + Postgres `uuid` errors. |
| 4 | **`demo-connection` 500.** Gallery demo placeholder hit a Postgres `uuid` column unguarded. | 3× `invalid input syntax for type uuid`. |
| 5 | **P0 auth hole.** `admin_reset_user` (and sibling `SECURITY DEFINER` fns) executable by `anon`. | Supabase security advisor. |
| 6 | Under-metering + no global budget guard; no prompt caching; no long-wait UX; a11y gaps; studio containers never idle-stop. | Cost/UX/a11y advisors. |

---

## Plan (M1–M11) and status

| Major | Theme | Status |
|------|-------|--------|
| **M1** | Latency-aware model routing (rank by measured p50 + bench quality; health-filter quality/free-only paths) | ✅ **Shipped (Batch 1)** |
| **M2** | Resilience: provider error tagging (done); KeyPool + CircuitBreaker into chat path | ◑ Partial (tagging shipped) |
| **M3** | Accurate token/cost metering + global budget guard | ☐ Planned (Batch 2) |
| **M4** | Error sanitization (SSE + client backstop) | ✅ **Shipped (Batch 1)** |
| **M5** | Security DDL: lock down anon-executable definer fns, `notifications` policy | ◑ Surgical apply — see "Held" |
| **M6** | Per-tier prompt/latency budgets | ☐ Planned (Batch 3) |
| **M7** | Prompt caching | ☐ Planned (Batch 3) |
| **M8** | Long-wait chat UX | ☐ Planned (Batch 3) |
| **M9** | Accessibility pass | ☐ Planned (Batch 3) |
| **M10** | Hardening: connector uuid guard (done); model-id validation; image-asset ownership; studio idle auto-stop | ◑ Partial (uuid guard shipped) |
| **M11** | RLS init-plan rewrite (perf) | ☐ Planned |

---

## Batch 1 — shipped to `Dreamstrream-v1` (this change)

- **M1** `server/src/ai/autoRouter.ts`: `loadSpeedSignals()` over `getModelLatency` +
  `loadScoreMap`; rank by measured speed → bench quality → context. Health filter
  (`isModelDown` / `isTimeoutProneFree`) applied to the `quality` and `free-only` paths.
- **M4 + M2(partial)** `ai/providers/errors.ts`, `openrouter.ts`, `routes/chat.ts`,
  `services/chatErrors.ts`: `makeProviderError()` (status + `publicMessage`),
  `safeClientMessage()` on both SSE paths, `friendlyChatError()` backstop.
- **M10(partial)** `server/src/lib/uuid.ts` + `connectors/store.ts`: `getConnection()`
  guards non-UUID ids → clean 404.
- **Verified**: client + server typecheck, **1646 tests pass** (268 files), frontend
  build, CI `verify` green.

---

## Held (require explicit sign-off / dashboard access)

1. **Production security DDL (M5).** Apply surgically: lock `admin_reset_user` and
   sibling definer functions to `service_role`; tighten `notifications` policy. The
   login-affecting `resolve_email_from_username` revoke is **held** until it's moved
   behind a rate-limited backend endpoint (revoking `anon` would break username login).
   Idempotent SQL lands in `server/sql/` regardless.
2. **Env / dashboard** (cannot be set from code): fund/rotate the OpenRouter key,
   enable Supabase leaked-password protection, worker secrets.
3. **Deploy** of subsequent batches — same gated review as this one.
