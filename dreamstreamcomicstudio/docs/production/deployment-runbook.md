# Part 2: Deployment Runbook

## Target Architecture

1. Frontend: Cloudflare Pages (static Vite build).
2. Backend: Railway (Dockerized Node API on port `7071`).
3. Database/Auth/Storage: Supabase.
4. DNS: Cloudflare.

## Production Domains

1. `app.yourdomain.com` for frontend.
2. `api.yourdomain.com` for backend.

## Source Of Truth (Pinning)

1. Deploy frontend and backend from the same repo:
`https://github.com/Akhielesh/Comic2`
2. Use project root:
`/Users/Akhielesh/Coding Projects/Neural graph/Comic2/dreamstreamcomicstudio`
3. Pin both deploy targets to the same commit SHA before release.
4. Set build metadata env vars in deploy targets:
`APP_VERSION=<package_version>`
`GIT_SHA=<commit_sha>`
`BUILD_TIMESTAMP=<ISO8601_utc_timestamp>`

## Deployment Order (Required)

1. Deploy backend (Railway) first.
2. Verify backend reports the target commit SHA via `/api/system/version`.
3. Deploy frontend (Cloudflare Pages) second from the exact same commit SHA.
4. Purge Cloudflare cache immediately after frontend deploy.
5. Verify frontend and backend `gitSha` now match in runtime diagnostics.

## Frontend Deployment (Cloudflare Pages)

1. Connect repo and select project root:
`/Users/Akhielesh/Coding Projects/Neural graph/Comic2/dreamstreamcomicstudio`
2. Build command:
`npm run build`
2.1. Contract verification command (run after build):
`npm run verify:world-contract`
3. Output directory:
`dist`
4. Environment variables:
`VITE_API_BASE_URL=https://api.yourdomain.com`
`VITE_SUPABASE_URL=<your_supabase_url>`
`VITE_SUPABASE_ANON_KEY=<your_supabase_anon_key>`
`VITE_AUTH_REDIRECT_URL=https://app.yourdomain.com/auth/callback`

## Backend Deployment (Railway)

1. Create Railway service from the same repo.
2. Use existing `Dockerfile` at repo root.
3. Set port variable:
`PORT=7071`
4. Set required env vars:
`CORS_ORIGIN=https://app.yourdomain.com`
`VITE_SUPABASE_URL=<your_supabase_url>`
`VITE_SUPABASE_ANON_KEY=<your_supabase_anon_key>`
5. Set optional server/provider vars:
`SUPABASE_SERVICE_ROLE_KEY=<service_role_key>`
`GEMINI_API_KEY=<optional_server_key>`
`PIXAZO_API_KEY=<optional_server_key>`
`BILLING_ENABLED=true`
`STRIPE_SECRET_KEY=<stripe_secret>`
`STRIPE_WEBHOOK_SECRET=<stripe_webhook_secret>`
`STRIPE_PRICE_ID_CREATOR=<creator_monthly_price_id>`
`STRIPE_PRICE_ID_CREATOR_ANNUAL=<creator_annual_price_id>`
`STRIPE_PRICE_ID_STUDIO=<studio_monthly_price_id>`
`STRIPE_PRICE_ID_STUDIO_ANNUAL=<studio_annual_price_id>`
`STRIPE_PRICE_ID_CREDIT_PACK_10=<one_time_pack_10_price_id>`
`STRIPE_PRICE_ID_CREDIT_PACK_25=<one_time_pack_25_price_id>`
`STRIPE_PRICE_ID_CREDIT_PACK_100=<one_time_pack_100_price_id>`
`STRIPE_WEBHOOK_MAX_AGE_SECONDS=86400`
`STRIPE_BILLING_PORTAL_RETURN_URL=https://app.yourdomain.com/settings?tab=billing`
`TRUST_PROXY=true`
`STRICT_ENV_VALIDATION=true`
`MAX_BODY_SIZE=10mb`
`RATE_LIMIT_WINDOW_MS=60000`
`RATE_LIMIT_TEXT_MAX_REQUESTS=120`
`RATE_LIMIT_IMAGE_MAX_REQUESTS=40`
`RATE_LIMIT_VISION_MAX_REQUESTS=120`
`RATE_LIMIT_SYSTEM_MAX_REQUESTS=240`
`IDEMPOTENCY_TTL_MS=900000`

## DNS Setup (Cloudflare)

1. Add CNAME `app` -> Cloudflare Pages domain.
2. Add CNAME `api` -> Railway service domain.
3. Keep proxy enabled unless troubleshooting requires direct mode.

## Smoke Test After Deploy

1. Verify API health:
`curl -i https://api.yourdomain.com/api/health`
2. Verify readiness:
`curl -i https://api.yourdomain.com/api/system/ready`
3. Verify version endpoint:
`curl -i https://api.yourdomain.com/api/system/version`
3.1 Verify `worldExtractionContractVersion >= 3`.
3.2 Verify `gitSha` equals the expected release commit.
4. Verify frontend bundle contract before publish:
`npm run build && npm run verify:world-contract`
4.1 Confirm this check is run against the exact commit deployed to Railway.
5. Verify `extract-world` rejects missing script:
`curl -i -X POST https://api.yourdomain.com/api/text/extract-world -H 'Content-Type: application/json' -H 'Authorization: Bearer <token>' -d '{\"scenes\":[]}'`
Expected: `400` with `SCRIPT_REQUIRED_FOR_WORLD_EXTRACTION`.
6. Purge Cloudflare cache and hard-refresh `app.yourdomain.com`.
6.1 Confirm browser network payload for `/api/text/extract-world` includes both `scenes` and `script`.
6. Verify frontend loads and can call API.
7. Verify auth login flow.
8. Verify text generation and image generation success.
9. Verify Stripe webhook receives events at `/api/webhook/stripe`.

## Monitoring and Alerts

1. Uptime ping every 60s on `https://api.yourdomain.com/api/health`.
2. Error alert on 5xx rate above threshold.
3. Latency alert on p95 threshold.
4. Budget alerts in Supabase, Railway, Google AI, Pixazo/Flux.

## Rollback Procedure

1. Frontend rollback: redeploy previous Cloudflare Pages deployment.
2. Backend rollback: redeploy previous Railway image/deployment.
3. Verify post-rollback health and readiness endpoints.
4. Verify login and one generation flow before closing incident.
