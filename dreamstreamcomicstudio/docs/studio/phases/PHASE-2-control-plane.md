# Phase 2 — Railway control plane (`/api/studio/*`)

**Status:** 📋 planned — **buildable & testable in-repo now** · **Depends on:** Phase 1 to wire live · **Effort:** 2–3 days

## Goal
A backend control plane that authenticates the user, meters usage, enforces caps, and
brokers signed requests to the Studio Worker. Browsers never call the Worker directly.

## Tasks
1. New router `server/src/routes/studio.ts`, mounted at `/api/studio` in `server/src/index.ts`.
2. Endpoints:
   - `POST /api/studio/launch` — auth → `reserveForOperation('studio.run')` → HMAC-sign
     `{action:'launch', sandboxId:'u_<userId>_<projectId>', files, install, dev, port}` →
     POST to `STUDIO_WORKER_URL` → return `{previewUrl, sandboxId}`. Record a `studio_runs`
     row. Settle usage.
   - `POST /api/studio/:id/stop` — stop the container; close the `studio_runs` row; release reservation.
   - `GET /api/studio/:id/logs` — proxy the Worker's SSE log stream to the client.
3. Config: add `STUDIO_WORKER_URL` + `STUDIO_HMAC_SECRET` to `server/src/config.ts` + `.env.example`.
4. HMAC signer util (matches the Worker's verify): `sha256` HMAC of the raw JSON body →
   `x-studio-signature: sha256=<hex>`.
5. **Caps** (cost safety): per-user concurrent sandboxes (≤2), idle-sleep (≤5 min),
   max session (≤30 min), daily build-minute cap — enforced here + via `usageEnforcer`.
6. Add `studio.run` to the usage/billing operation set so compute shows in dashboards.

## Acceptance criteria
- Authenticated `launch` returns a preview URL; unauth → 401; over-cap → 402/429 with a
  clear message (reuse `formatLimitErrorResponse`).
- A `studio_runs` row is created/closed per session with `awake_seconds` + `cost_usd`.
- HMAC signature verified by the Worker (round-trip works once Phase 1 is deployed).
- Server typechecks (`npm run build:server`); unit tests for the signer + cap logic.

## Testable now (without Cloudflare)
- Unit-test the HMAC signer, cap logic, and request shaping.
- Mock the Worker endpoint to test the full route (reserve→sign→settle→record) end to end.

## Files
- new: `server/src/routes/studio.ts`, `server/src/services/studioSign.ts` (+ tests)
- edit: `server/src/index.ts`, `server/src/config.ts`, `server/.env.example`
- new migration: `server/sql/studio_tables.sql` (see `06-DATA-MODEL.md`)

## When done → unblocks
Phase 3 (UI calls these endpoints) and Phase 4 (the agent loop launches via this plane).
