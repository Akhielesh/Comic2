# Phase 1 — Studio Worker

**Status:** 🟡 scaffolded (PR #76), not validated · **Depends on:** Phase 0 to deploy · **Effort:** 1–2 days

## Goal
A standalone Cloudflare Worker that, given a project's files, runs it in a per-user
container and returns a tokenized **live preview URL**.

## Already done (scaffold in `studio-worker/`)
- `wrangler.jsonc` (container `standard-3` + Durable Object + wildcard route).
- `Dockerfile` (Node-only base; pin tag to the SDK version).
- `src/index.ts` — HMAC-guarded `launch` (writeFile → npm install → start dev →
  `exposePort`) and `stop`.
- `tsconfig.json`, `package.json`, `README.md` (deploy steps).
- Isolated from the app build (`tsconfig` exclude) — app CI unaffected.

## Tasks (to finish/validate)
1. From `studio-worker/`: `npm install` (or init from the official Sandbox template to
   pin correct versions), then `npm run typecheck`.
2. **Validate the SDK calls** against the installed `@cloudflare/sandbox` version —
   confirm `writeFile`, `exec`, `startProcess`, `exposePort`, `stop` signatures + return
   shapes; adjust `src/index.ts` if the API differs.
3. Set `STUDIO_HMAC_SECRET` (`wrangler secret put`).
4. Swap the placeholder domain in `wrangler.jsonc` for the real one (from Phase 0).
5. `wrangler deploy`; smoke-test with a signed request that launches a tiny hardcoded
   Vite app and returns a working preview URL.
6. Add `logs` streaming (`execStream`) for the dev server (used by the control plane).
7. Add idle-sleep config + per-instance guards.

## Flow
```
POST / (HMAC)  { action:'launch', sandboxId:'u_<uid>_<pid>', files:[…], port }
  → writeFile each → exec 'npm install' → startProcess 'npm run dev' → exposePort
  → { status:'starting', previewUrl, sandboxId, port }
POST / (HMAC)  { action:'stop', sandboxId } → { status:'stopped' }
```

## Acceptance criteria
- A signed `launch` with a minimal React/Vite project returns a preview URL that loads
  the running app in a browser (any device).
- `stop` sleeps the container (billing stops).
- Unsigned/invalid-HMAC requests are rejected (401).
- `studio-worker` typechecks on its own; app CI remains green.

## Risks
- SDK version drift → method tweaks (flagged in code).
- Cold-start latency → mitigate later with a pre-warmed image (Dockerfile cache).

## When done → unblocks
Phase 2 can call a real Worker; Phase 3 can show a real preview.
