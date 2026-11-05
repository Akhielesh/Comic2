# Request-surface hardening (security plan PR-1, 2026-11-05)

What the backend now refuses or bounds on its public request surface, and the deploy steps it needs.
Companion to `SECURITY_FINDINGS.md`; finding ids are the security plan's.

| Id | Where | What changed |
|---|---|---|
| web-surface-1 | `server/src/lib/mcpRequestServers.ts`, `routes/chat.ts` `prepareChat` | A chat request's `mcpServers` entries are rebuilt from `{id ≤ 64, name ≤ 80, url, headers ≤ 8 × ≤ 4096}`; `trusted` is dropped, only strict-safe https URLs are kept (`isSafeMcpUrl`, no `allowInternal`), at most 10. No request or saved entry replaces an operator server (`STUDIO_*_MCP_URL`) by reusing its URL, so the operator's id (`nango` → `mcp_nango_*`, a connector for the privacy gate), headers and trust stay. The merge runs after the free-turn and connector-tool decisions and before `connectorPrivacy`, which sees every MCP tool name. The tool-side check (`ai/tools/mcpClient.ts`, trust only operator URLs) is the DreamStream session's. |
| abuse-ops-1 (f), abuse-ops-6 | `server/src/middleware/publicDataLimits.ts`, `chatPublicRouter` | After `optionalAuth`, per account or per IPv4 / IPv6 /64 (`server/src/lib/clientKey.ts`): `GET /api/chat/unfurl` 60/min, `GET /api/chat/read-url` 20/min, `POST /api/chat/tool-refresh` 30/min and 300/day. `find_places` and `video_search` refreshes (paid platform keys) need a signed-in caller (401 `SIGN_IN_REQUIRED`). The fetchers' own caps and provider budgets are the DreamStream session's. |
| abuse-ops-2 | `server/src/services/sqlRunner.ts`, `sqlWorker.ts` | `/api/learn/sql` runs in a fresh worker thread per call: 2 s deadline then `terminate()`, SQLite `hard_heap_limit` 32 MiB, `max_page_count` 16 MiB, `temp_store=MEMORY`, V8 heap 64 MiB, an RSS watchdog (64 MiB growth), ≤ 500 rows kept (all counted), cells ≤ 10 KB, results ≤ 1 MB, empty env. ≤ 2 runs at once, ≤ 16 queued, then "busy". `randomblob`, `zeroblob`, `ATTACH`/`VACUUM`, the size pragmas and huge `printf` widths are refused up front. ~50 ms per run for the worker. |
| abuse-ops-9 | `server/src/routes/keys.ts` | `/api/keys/validate` checks only a key sent in the request's provider header. No header → `missing`, no outbound call (the platform's env keys are never checked). OpenRouter `detail` is at most `{ limitRemaining }` for the user's own key; network errors are not echoed. |
| abuse-ops-12 | `data-egress/src/index.ts` | The relay fails closed: no `EGRESS_SHARED_SECRET` → 503 for every request (logged once per isolate); the `x-egress-key` header is compared in constant time (SHA-256 of both). The backend logs `egress_secret_missing` once when `DATA_EGRESS_SECRET` is unset. |
| web-surface-3 / N7 | `functions/_middleware.ts` | Main-app pages get an enforced `Content-Security-Policy: frame-ancestors 'self'; object-src 'none'` and `X-Frame-Options: SAMEORIGIN`; the rest of the main policy stays Report-Only. A route with its own enforced CSP (`/c/*`) keeps its framing and gets no XFO (`/c/<slug>/embed` stays embeddable). The sign-in landing page's frame block turns an existing `frame-ancestors` into `'none'`. Stream Studio's policy and `ENFORCE_LIVE` are unchanged. |

## Deploy order

1. **Owner step O4 before the data-egress deploy.** Generate a random 32-byte value; set it as the
   backend's `DATA_EGRESS_SECRET` (D1 `backend_env` or a Worker secret) and as the
   `dreamstream-data-egress` Worker's `EGRESS_SHARED_SECRET` (`wrangler secret put EGRESS_SHARED_SECRET`).
   Deploying the worker first turns every relayed market-data fetch into a 503 until both are set.
2. Before the Pages deploy, check `csp_reports` for `frame-ancestors` reports from other origins
   (none are expected: nothing in the repo frames `/` from another site).
3. After each deploy, check the Workers and Container logs (`egress_secret_missing`,
   `[data-egress] EGRESS_SHARED_SECRET is not set`, 429s on `chat_*` scopes).
