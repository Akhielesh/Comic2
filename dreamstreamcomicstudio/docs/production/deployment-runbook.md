# Part 2: Deployment Runbook

## Target Architecture

1. Frontend: Cloudflare Pages (static Vite build).
2. Backend: Railway (Dockerized Node API on port `7071`).
3. Database/Auth/Storage: Supabase.
4. DNS: Cloudflare.

## Production Domains

1. `app.yourdomain.com` for frontend.
2. `api.yourdomain.com` for backend.

## Frontend Deployment (Cloudflare Pages)

1. Connect repo and select project root:
`/Users/Akhielesh/Coding Projects/Neural graph/Comic2/dreamstream-comic-studio (1)`
2. Build command:
`npm run build`
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
`STRIPE_PRICE_ID_PRO=<pro_monthly_price_id>`
`STRIPE_PRICE_ID_PRO_ANNUAL=<pro_annual_price_id>`
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
3. Verify frontend loads and can call API.
4. Verify auth login flow.
5. Verify text generation and image generation success.
6. Verify Stripe webhook receives events at `/api/webhook/stripe`.

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
