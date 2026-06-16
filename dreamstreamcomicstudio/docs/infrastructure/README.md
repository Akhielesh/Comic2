# Infrastructure docs — start here

Authoritative, **live-verified** documentation of all cloud infrastructure for
DreamStream Comic Studio. Created from a full audit on **2026-06-16** (Railway +
Supabase + Cloudflare live APIs cross-checked against repo config).

| Doc | What it answers |
|---|---|
| **[INFRA_MAP.md](./INFRA_MAP.md)** | What exists and what depends on what — every service, worker, binding, external API, MCP server, data flow, deploy path. The dependency map. |
| **[COST_RUNBOOK.md](./COST_RUNBOOK.md)** | Where money goes and how to keep it down — per-service cost model, optimization levers, monthly checklist. |
| **[ENV_MATRIX.md](./ENV_MATRIX.md)** | Every env var → its consumer → required/optional → cost impact. |
| **[SECURITY_FINDINGS.md](./SECURITY_FINDINGS.md)** | Live security posture — Supabase advisor results + worker hardening to-dos. |

## Why this exists

Before this set, infra/cost knowledge was scattered across 5+ docs (some
contradictory, some aspirational), there was **no single dependency map**, and **no
executable cost runbook**. The result was recurring surprise cloud bills. These four
docs are the fix.

## Maintenance convention ("keep recording these")

- **Same-PR rule:** any change that adds/removes a service, worker, binding, external
  API/provider, MCP server, or env var **must** update `INFRA_MAP.md` + `ENV_MATRIX.md`
  (and `COST_RUNBOOK.md` if a paid resource or plan tier changes) in the *same* PR.
- **Re-verify quarterly:** re-run the live audit (Railway `list_projects` /
  `environment_status` / `service_metrics`; Supabase `list_projects` / `get_advisors`;
  Cloudflare `workers_list` / `r2_buckets_list` / `d1_databases_list`) and bump the
  "Last verified" date + change log in each doc.
- **Each doc has a change-log table at the bottom** — append, don't overwrite.
- Treat `docs/studio/autopilot/**` as **target design**, not current state
  (see `INFRA_MAP.md` §10).
