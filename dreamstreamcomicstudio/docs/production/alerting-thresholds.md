# Alerting Thresholds

## API Reliability Alerts

1. Critical: 5xx error rate > 3% for 5 minutes.
2. Warning: 5xx error rate > 1% for 10 minutes.
3. Critical: `/api/health` failing for 3 consecutive checks.
4. Warning: `/api/system/ready` returns 503 for 2 consecutive checks.

## API Latency Alerts

1. Warning: p95 latency > 2.5s for 10 minutes.
2. Critical: p95 latency > 5s for 5 minutes.
3. Warning: `/api/image/*` p95 > 30s for 10 minutes.
4. Critical: `/api/image/*` timeout/error ratio > 10% for 10 minutes.

## Capacity Alerts

1. Warning: CPU > 65% for 15 minutes.
2. Critical: CPU > 80% for 10 minutes.
3. Warning: Memory > 70% for 15 minutes.
4. Critical: Memory > 85% for 10 minutes.

## Rate Limit and Abuse Alerts

1. Warning: 429 ratio > 5% sustained for 10 minutes.
2. Critical: 429 ratio > 15% sustained for 10 minutes.
3. Warning: single IP exceeds 10x normal request baseline.

## Cost Alerts

1. Daily spend warning at 60% of expected daily budget.
2. Daily spend critical at 85% of expected daily budget.
3. Monthly spend warning at 70% of monthly budget.
4. Monthly spend critical at 90% of monthly budget.
