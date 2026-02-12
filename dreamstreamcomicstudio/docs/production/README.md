# Production Playbook

This folder contains the deployment and operations artifacts for launching DreamStream Comic Studio safely.

## Phase Artifacts

1. `docs/production/part1-hardening.md`
2. `docs/production/deployment-runbook.md`
3. `docs/production/go-live-checklist.md`
4. `docs/production/alerting-thresholds.md`
5. `docs/production/scaling-and-cost.md`
6. `docs/production/load-test-plan.md`
7. `docs/production/supabase-auth-checklist.md`

## Suggested Execution Order

1. Complete Part 1 hardening and pass all gate checks.
2. Deploy frontend and backend using the runbook.
3. Complete the go-live checklist before opening traffic.
4. Apply alert thresholds and budget alerts.
5. Run staged load tests and update scaling thresholds.
