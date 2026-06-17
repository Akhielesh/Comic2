# Part 3: Scaling and Cost Control

> ⚠️ **Superseded for current operations (2026-06).** This describes a multi-instance,
> always-on growth model (100–1000 users). The app currently runs at **single-user scale**
> on a **scale-to-zero** model: one Railway backend with **App-Sleeping ON**, **no Redis**
> on the backend, Cloudflare Pages + 5 Workers (mostly free). For how cost actually works
> today and how to keep it down, use **[`../infrastructure/COST_RUNBOOK.md`](../infrastructure/COST_RUNBOOK.md)**.
> Keep this doc as the reference for *if/when* you scale to many users.

## Growth Stages

1. Stage A (up to 100 active users): 1 backend instance.
2. Stage B (100 to 500 active users): 2 backend instances.
3. Stage C (500 to 1000 active users): 2 to 3 API instances, evaluate async image queue.

## Scaling Triggers and Actions

1. Trigger: p95 latency > 2.5s for 10 minutes.
Action: scale backend instance size or add one replica.
2. Trigger: CPU > 70% for 15 minutes.
Action: add one API replica.
3. Trigger: 429 ratio > 8% and user complaints increase.
Action: tune per-route limits and add capacity.
4. Trigger: image endpoint timeout ratio > 10%.
Action: queue/worker architecture decision and retry tuning.

## Cost Controls

1. Keep BYOK available for high-usage users.
2. Keep strict image route rate limits.
3. Keep idempotency keys on image routes to avoid duplicate provider calls.
4. Disable legacy image data URL response in production (`IMAGE_INCLUDE_DATA_URL_LEGACY=false`).
5. Use CDN caching for static frontend assets.

## Weekly Review Metrics

1. Total requests by endpoint class (`text`, `image`, `vision`, `system`).
2. Success rate and error rate by endpoint class.
3. p50/p95 latency by endpoint class.
4. 429 rate by endpoint class and top offending IPs.
5. AI provider failures and timeout rates.
6. Supabase request/storage growth.
7. Infrastructure and AI provider spend deltas week-over-week.

## Queue Architecture Decision Point

Adopt async image queue when either condition is true:

1. p95 for `/api/image/*` remains above 30s after vertical/horizontal scaling.
2. API worker saturation impacts non-image endpoints.

## Queue Rollout Expectations

1. API receives image request and enqueues job.
2. API returns job ID with pending state.
3. Worker processes provider call and stores result.
4. Client polls/subscribes for completion.
