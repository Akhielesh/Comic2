# Part 1: Production Hardening

## Goal

Harden the API before public traffic by enforcing stricter runtime config validation, security headers, route-level rate limits, strict CORS allowlists, request tracing, and readiness checks.

## Implemented Changes

1. Runtime config validation at startup in `server/src/config.ts`.
2. Strict CORS allowlist support via comma-separated `CORS_ORIGIN` values.
3. Reduced default JSON body limit to `10mb`.
4. `TRUST_PROXY` support for load-balancer/proxy deployments.
5. Route-specific rate limiting for `system`, `text`, `image`, and `vision` API scopes.
6. Consistent 429 response format with retry metadata.
7. Request ID propagation using `X-Request-Id`.
8. Structured request logs with request ID, status, latency, path, and user ID.
9. API security headers, including a baseline CSP.
10. Readiness endpoint `GET /api/system/ready`.
11. Image idempotency support via `Idempotency-Key` header for `/api/image/gemini` and `/api/image/flux`.

## New and Updated Environment Variables

1. `CORS_ORIGIN` (comma-separated allowlist)
2. `MAX_BODY_SIZE`
3. `TRUST_PROXY`
4. `STRICT_ENV_VALIDATION`
5. `RATE_LIMIT_WINDOW_MS`
6. `RATE_LIMIT_MAX_REQUESTS`
7. `RATE_LIMIT_TEXT_MAX_REQUESTS`
8. `RATE_LIMIT_IMAGE_MAX_REQUESTS`
9. `RATE_LIMIT_VISION_MAX_REQUESTS`
10. `RATE_LIMIT_SYSTEM_MAX_REQUESTS`
11. `IDEMPOTENCY_TTL_MS`

## Gate Verification Commands

Run from repository root:

```bash
npm run typecheck
npm run build
npm run build:server
```

Start the app in one terminal:

```bash
npm run dev
```

Validate health and readiness:

```bash
curl -i http://localhost:7071/api/health
curl -i http://localhost:7071/api/system/ready
```

Validate CORS rejection (replace origin with unknown domain):

```bash
curl -i http://localhost:7071/api/system/status \
  -H 'Origin: https://unknown.example.com'
```

Validate rate limit behavior by issuing repeated requests and observing `429` plus `Retry-After`:

```bash
for i in $(seq 1 300); do
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:7071/api/system/status
done
```

## Pass Criteria

1. Build and typecheck commands pass.
2. Unknown CORS origin is denied.
3. Repeated bursts produce HTTP 429.
4. `GET /api/system/ready` reports ready in configured environments.
