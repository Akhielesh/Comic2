# Railway deployment (backend API)

The Express/TypeScript API in this folder is what runs on Railway. The frontend
(Vite/React) is built and served separately on Cloudflare Pages.

## One-time Railway service settings

1. **Root directory:** `dreamstreamcomicstudio`
   The Dockerfile and `package.json` live here, not at the repo root. Without
   this, the build can't find `package.json`.
2. **Builder:** Dockerfile (pinned by `railway.json` — no manual change needed).
3. **Branch:** deploy from `Dreamstrream-v1` (the repo's default branch).
4. **Healthcheck:** `/api/health` (pinned by `railway.json`).

`PORT` is injected by Railway automatically; the server binds to it.

## Environment variables to set in Railway → Variables

Already known (Supabase public config — safe to paste):

```
VITE_SUPABASE_URL=https://bdjfmxfmhqhzvgrhbbzm.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJkamZteGZtaHFoenZncmhiYnptIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA0MTMzNjgsImV4cCI6MjA4NTk4OTM2OH0.Pvv2PXaWtRt6_o5JIyis7ZZycRRDnxOce-3gciBP5Pk
```

Secrets you must provide (never committed):

```
SUPABASE_SERVICE_ROLE_KEY=<Supabase dashboard → Project Settings → API → service_role>
DREAMSTREAMSTUDIO_ALL=<OpenRouter key #1>       # serves ALL user traffic; per-user spend is
                                                # hard-capped by the monthly platform allowance
                                                # (PLATFORM_MONTHLY_ALLOWANCE_USD, default $5/user)
DREAMSTREAMSTUDIO_MODELTEST=<OpenRouter key #2> # model testing only (bench:models, validate:sources,
                                                # smoketest, verify:run) — never serves users, so test
                                                # spend stays separate and auditable per key
CORS_ORIGIN=<your frontend origin, e.g. https://dreamstreamstudio.ai>
```

Create both keys in the OpenRouter dashboard (name them `dreamstreamstudio_all` and
`dreamstreamstudio_modeltest` there too, and consider a per-key spend cap on each).
`OPENROUTER_API_KEY` still works as a legacy fallback when `DREAMSTREAMSTUDIO_ALL`
is unset. Keys live only in Railway's variable store — they are never logged and
never sent to the client.

Optional / has-defaults:

```
AI_PROVIDER=openrouter        # default 'gemini'; set to 'openrouter' to use the new gateway
GEMINI_API_KEY=<...>          # only if AI_PROVIDER=gemini
PIXAZO_API_KEY=<...>          # only if using the legacy Pixazo image path
ASSISTANT_GEMINI_API_KEY=<...>
REDIS_URL=<redis url>         # OR set COMICFORGE_ENABLED=false if you have no Redis
COMICFORGE_ENABLED=false      # disable the ComicForge worker when REDIS_URL is unset
FOURSQUARE_API_KEY=<key>      # enables rich local search (ratings/price/photos) in chat;
                              # without it, find_places falls back to keyless OpenStreetMap
FOURSQUARE_API_VERSION=2025-06-17  # only if Foursquare changes the required version date
```

The server boots in **degraded mode** if these are missing (it logs warnings and
`/api/health` still returns 200), so the deploy will go green before everything
is filled in — features simply activate as you add keys.

## Cloudflare Pages (frontend) build env

The client needs these at **build time**:

```
VITE_SUPABASE_URL=https://bdjfmxfmhqhzvgrhbbzm.supabase.co
VITE_SUPABASE_ANON_KEY=<same anon key as above>
VITE_API_BASE_URL=<your Railway backend public URL, e.g. https://comic2-production.up.railway.app>
VITE_AUTH_REDIRECT_URL=<your frontend origin>
```
