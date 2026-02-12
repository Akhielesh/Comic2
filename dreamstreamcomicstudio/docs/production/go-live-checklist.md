# Go-Live Checklist

## Part 1 Gate: Hardening

- [ ] `npm run typecheck` passes.
- [ ] `npm run build` passes.
- [ ] `npm run build:server` passes.
- [ ] Unknown CORS origins are rejected.
- [ ] Burst test shows HTTP 429 with retry headers.
- [ ] `/api/system/ready` returns 200 in production config.
- [ ] Request logs include request ID and latency.

## Part 2 Gate: Deployment

- [ ] Frontend reachable at `https://app.yourdomain.com`.
- [ ] Backend reachable at `https://api.yourdomain.com`.
- [ ] Health endpoint returns `200`.
- [ ] Readiness endpoint returns `200`.
- [ ] End-to-end auth login works.
- [ ] Text generation flow works.
- [ ] Image generation flow works.
- [ ] Monitoring alerts configured and test-fired.
- [ ] Rollback to previous deployment tested once.

## Part 3 Gate: Scale and Cost

- [ ] Capacity thresholds documented and approved.
- [ ] Budget alerts configured on all paid providers.
- [ ] 100-user synthetic load test complete.
- [ ] 300-user synthetic load test complete.
- [ ] 600-user synthetic load test complete.
- [ ] 1000-user synthetic load test complete.
- [ ] p95 latency and error thresholds met at target load.
- [ ] Incident response path validated for provider failures.

## Final Launch Sign-Off

- [ ] 24-hour soak test complete without critical incidents.
- [ ] On-call owner assigned for first 14 days.
- [ ] Weekly cost review cadence scheduled.
