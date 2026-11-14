# Catalog maintenance

The repository-root `refresh-model-catalog.yml` (hourly) and `probe-nvidia-availability.yml`
(daily) call the deployed backend. They do not receive Supabase service-role or provider keys.
Those credentials stay in the backend's existing Cloudflare environment.

GitHub grants each job `id-token: write`. `scripts/ops/catalogMaintenance.mjs` requests audience
`urn:dreamstream:catalog-maintenance`, then posts to the fixed operational Workers origin at
`/api/internal/catalog/refresh` or `/api/internal/catalog/probe-nvidia`. No request parameters
are accepted. The backend verifies the RS256 signature against GitHub's fixed JWKS endpoint,
issuer, audience, immutable repository/owner IDs, names, production branch, exact corresponding
workflow path, subject, GitHub-hosted runner, event type, and at most ten minutes of token
lifetime. Pull requests, forks, other branches, reusable workflows, expired tokens and token
replays are rejected. Operations are single-flight, rate limited and cooled down.

The refresh lists OpenRouter and NVIDIA anonymously. Public discovery does **not** validate a
private API key or account-specific access. Other providers refresh only if their platform key
is configured; missing providers are reported `unconfigured`, never as refreshed. Every reported
refresh awaits a strict database write. Empty/fallback lists and database failures fail the job.
`last_seen_at` records model-list observation, not generation or a benchmark measurement.

The NVIDIA probe requires `NVIDIA_API_KEY` in the backend. Without it the endpoint returns 503
`NVIDIA_API_KEY_MISSING`, and Actions fails explicitly. Do not copy a user's personal BYOK into
platform configuration. The existing probe sends a one-token generation per listed text model;
it can consume provider credits. Only successful inference supplies positive platform-account
evidence. Validation errors, account-specific 404s (including "not found for account" and "no
endpoints"), and transient failures remain unknown; they never globally disable another user's
BYOK model selection. Existing `api_callable` records are historical observations,
not a guarantee of a different account's entitlement. `api_callable_checked_at` records only a
conclusive probe, independently of discovery; missing dates or evidence older than 48 hours are
returned as unknown. The additive `server/sql/model_catalog_callability_freshness.sql` must be
applied before deployment. Do not backfill probe dates from catalog observation timestamps.

Release order: deploy the backend with the maintenance router mounted before user authentication,
then run the two production workflows with `workflow_dispatch`. Confirm their sanitized counts
and timestamps, and independently query `model_catalog_cache` by source for `max(last_seen_at)`.
A green deployment alone does not prove scheduled freshness. No endpoint publishes keys,
provider response bodies, user data, or an arbitrary execution interface.

References: [GitHub OIDC trust claims](https://docs.github.com/en/actions/reference/security/oidc),
[GitHub signing metadata](https://token.actions.githubusercontent.com/.well-known/openid-configuration).
