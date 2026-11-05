# Request-surface hardening (security plan PR-1, 2026-11-05)

What the backend now refuses or bounds on its public request surface, and the deploy steps it needs.
Companion to `SECURITY_FINDINGS.md`; finding ids are the security plan's.

| Id | Where | What changed |
|---|---|---|
| web-surface-1 | `server/src/lib/mcpRequestServers.ts`, `routes/chat.ts` `prepareChat` | A chat request's `mcpServers` entries are rebuilt from `{id ≤ 64, name ≤ 80, url, headers ≤ 8 × ≤ 4096}`; `trusted` is dropped, only strict-safe https URLs are kept (`isSafeMcpUrl`, no `allowInternal`), at most 10. No request or saved entry replaces an operator server (`STUDIO_*_MCP_URL`) by reusing its URL, so the operator's id (`nango` → `mcp_nango_*`, a connector for the privacy gate), headers and trust stay. The merge runs after the free-turn and connector-tool decisions and before `connectorPrivacy`, which sees every MCP tool name. The tool-side check (`ai/tools/mcpClient.ts`, trust only operator URLs) is the DreamStream session's. |
| abuse-ops-1 (f), abuse-ops-6 | `server/src/middleware/publicDataLimits.ts`, `chatPublicRouter` | After `optionalAuth`, per account or per IPv4 / IPv6 /64 (`server/src/lib/clientKey.ts`): `GET /api/chat/unfurl` 60/min, `GET /api/chat/read-url` 60/min (the news list prefetches an article on hover and focus), `POST /api/chat/tool-refresh` 30/min for everyone plus a daily window of 300 for an anonymous caller and 10,000 for a signed-in account. The daily numbers follow the client's cadence: Dashboards re-runs every data tile of the open board every 5 min (12 calls/h per tile) and a live monitor runs as often as every 30 s (120/h), so 10,000 sits above a 10-tile board plus two 30 s monitors left open all day (8,640); a test drives a 10-tile board plus a monitor for 8 h through the limiter. `find_places` and `video_search` refreshes (paid platform keys) need a signed-in caller (401 `SIGN_IN_REQUIRED`). The client (`services/chatApi.ts`) no longer caches a failed unfurl or reader request, so a refused hover prefetch is retried on click. The fetchers' own caps and provider budgets are the DreamStream session's. |
| abuse-ops-2 | `server/src/services/sqlRunner.ts`, `sqlWorker.ts` | `/api/learn/sql` runs in a fresh worker thread per call: 2 s deadline then `terminate()`, SQLite `hard_heap_limit` 32 MiB, `max_page_count` 16 MiB, `temp_store=MEMORY`, V8 heap 64 MiB, an RSS watchdog (64 MiB growth), ≤ 500 rows kept (all counted), cells ≤ 10 KB, results ≤ 1 MB, empty env. 1 run at a time (the container is 1/4 vCPU, and each run takes CPU from the main event loop), ≤ 8 queued, then "busy"; an account holds at most one of those places ("still running"). `POST /api/learn/sql` also has its own per-account limit, 15/min and 1,000/day (`routes/learn.ts`), on top of the shared `text` limiter. `randomblob`/`zeroblob`/`load_extension` calls, `ATTACH`/`DETACH`/`VACUUM` statements, the size pragmas and huge `printf`/`format` widths are refused up front, matched on SQLite's own tokens (string literals, comments, quoted data and columns such as "Robot Vacuum" or `page_size` are not refused). A run costs about 0.1 s of CPU and wall time even for `SELECT 1` (a fresh isolate plus sql.js); reusing a warm worker for runs that end cleanly is left for later. |
| abuse-ops-9 | `server/src/routes/keys.ts`, `routes/models.ts` | `/api/keys/validate` checks only a key sent in the request's provider header. No header → `missing`, no outbound call (the platform's env keys are never checked). OpenRouter `detail` is at most `{ limitRemaining }` for the user's own key; network errors are not echoed. `/api/models/verify` reads OpenRouter's live key status and credits only for an `X-OpenRouter-Key` the request sent (`liveKey`/`credits` are null otherwise); `connected` still says whether a source is usable. |
| abuse-ops-12 | `data-egress/src/index.ts` | The relay fails closed: no `EGRESS_SHARED_SECRET` → 503 for every request (logged once per isolate); the `x-egress-key` header is compared in constant time (SHA-256 of both). The backend logs `egress_secret_missing` once when `DATA_EGRESS_SECRET` is unset. |
| web-surface-3 / N7 | `functions/_middleware.ts` | Main-app pages get an enforced `Content-Security-Policy: frame-ancestors 'self'; object-src 'none'` and `X-Frame-Options: SAMEORIGIN`; the rest of the main policy stays Report-Only. A route with its own enforced CSP (`/c/*`) keeps its framing and gets no XFO (`/c/<slug>/embed` stays embeddable). The sign-in landing page's frame block turns an existing `frame-ancestors` into `'none'`. Stream Studio's policy and `ENFORCE_LIVE` are unchanged. |

## Deploy order

1. **Owner step O4 before this PR is merged: the merge IS the data-egress deploy.**
   `.github/workflows/deploy-data-egress.yml` deploys the worker on every push to `Dreamstrream-v1`
   that touches `data-egress/**`, so merging deploys the fail-closed worker straight away. Before
   merging, generate a random 32-byte value and set it in three places:
   - the backend's `DATA_EGRESS_SECRET` (D1 `backend_env` or a Worker secret);
   - the `dreamstream-data-egress` Worker's `EGRESS_SHARED_SECRET` (`wrangler secret put EGRESS_SHARED_SECRET`);
   - the `EGRESS_SHARED_SECRET` secret of the `production-deploy` GitHub Environment, which the
     deploy probe sends as `x-egress-key`.
   The probe then checks that a request without the key gets 403 and that a keyed one returns Yahoo
   JSON. A 503 ("Relay not configured") or a refused key fails the job. Merging before the worker
   secret is set turns every relayed market-data fetch into a 503 until both sides are set.
2. Before the Pages deploy, check `csp_reports` for `frame-ancestors` reports from other origins
   (none are expected: nothing in the repo frames `/` from another site).
3. After each deploy, check the Workers and Container logs (`egress_secret_missing`,
   `[data-egress] EGRESS_SHARED_SECRET is not set`, 429s on `chat_*` and `learn_sql*` scopes).

## Open, outside this PR

- **Request-supplied MCP servers' response bodies are read without a byte cap**
  (`server/src/ai/tools/mcpClient.ts` `rpc`: `res.text()` on success and error, only the 15 s timeout).
  A chat body may name up to 10 such servers, discovered in parallel by `buildMcpTools` in
  `prepareChat`, which runs before the usage reservation. This file belongs to the DreamStream
  session; the fix is the streamed byte cap of security plan §4 item 3 (`fetchTextCapped`, about
  1 MiB for `initialize` / `tools/list` and the `MCP_TOOL_OUTPUT_MAX` scale for `tools/call`).
