# Load Test Plan

## Objective

Validate stability and latency targets at user-load tiers: 100, 300, 600, and 1000 users.

## Test Scenarios

1. Auth-only scenario: login and token validation flow.
2. Text generation scenario: sustained `/api/text/*` traffic.
3. Image generation scenario: controlled `/api/image/*` traffic.
4. Mixed scenario: realistic ratio across `text`, `image`, `vision`, and `system`.
5. Burst scenario: short spikes to verify rate-limit and retry behavior.

## Measurements

1. p50, p95, p99 latency by endpoint class.
2. 2xx, 4xx, 5xx response ratios.
3. 429 ratio and top keys/IPs.
4. Provider timeout/failure ratios.
5. CPU and memory saturation during each stage.

## Acceptance Criteria

1. 5xx ratio under 1% during sustained load.
2. p95 under 2.5s for non-image endpoints.
3. Controlled 429 behavior under bursts with no service crash.
4. No persistent memory growth over 30-minute sustained test.

## Execution Notes

1. Run against staging first, production only in controlled windows.
2. Start with conservative image concurrency due provider-cost impact.
3. Capture logs and metrics snapshots before and after each run.
