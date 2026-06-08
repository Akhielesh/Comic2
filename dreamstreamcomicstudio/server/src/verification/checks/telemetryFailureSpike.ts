// Built-in check: surface recurring user-facing failures captured by the telemetry
// pipeline (telemetry_events, severity error/critical) so the existing
// verification -> auto-fix workflow can act on real breakages, not just synthetic
// invariants. Groups similar failures by a normalized signature and files a finding
// for any signature seen >= a threshold within the window.
//
// Config (verification_checks.config): { windowHours?: number, minCount?: number }.

import crypto from 'node:crypto';
import type { CheckImpl, RawFinding, Severity } from '../types.js';
import { failureSignature } from '../../lib/failureSignature.js';

const fp = (parts: string[]) => crypto.createHash('sha256').update(parts.join('::')).digest('hex').slice(0, 16);

export const telemetryFailureSpike: CheckImpl = {
  builtinId: 'telemetry_failure_spike',
  description: 'Recurring user-facing failures captured in telemetry_events exceed a threshold.',
  kind: 'deterministic',
  target: 'custom',
  severity: 'high',
  async run(record, ctx) {
    const findings: RawFinding[] = [];
    const config = (record?.config || {}) as Record<string, unknown>;
    const windowHours = Math.max(1, Math.min(168, Number(config.windowHours) || 24));
    const minCount = Math.max(2, Math.min(1000, Number(config.minCount) || 5));
    const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();

    let rows: Array<Record<string, unknown>> = [];
    try {
      const { data, error } = await ctx.admin
        .from('telemetry_events')
        .select('event_type, source, surface, severity, message')
        .in('severity', ['error', 'critical'])
        .gte('created_at', since)
        .limit(5000);
      if (error) {
        ctx.log('telemetry_failure_spike: query failed (table may not exist yet)', { error: error.message });
        return findings;
      }
      rows = (data || []) as Array<Record<string, unknown>>;
    } catch (err) {
      ctx.log('telemetry_failure_spike: query threw', { error: (err as Error).message });
      return findings;
    }

    interface Group {
      eventType: string;
      source: string;
      surfaces: Set<string>;
      sample: string;
      count: number;
      critical: number;
    }
    const groups = new Map<string, Group>();
    for (const row of rows) {
      const eventType = String(row.event_type || 'error');
      const source = String(row.source || 'unknown');
      const key = failureSignature(eventType, source, row.message);
      const existing = groups.get(key) || {
        eventType,
        source,
        surfaces: new Set<string>(),
        sample: String(row.message || '').slice(0, 300),
        count: 0,
        critical: 0
      };
      existing.count += 1;
      if (String(row.severity) === 'critical') existing.critical += 1;
      if (row.surface) existing.surfaces.add(String(row.surface));
      groups.set(key, existing);
    }

    for (const [key, g] of groups) {
      if (g.count < minCount) continue;
      // Escalate severity with volume / any critical members.
      const severity: Severity = g.critical > 0 || g.count >= minCount * 4 ? 'critical' : 'high';
      findings.push({
        fingerprint: fp(['telemetry_failure_spike', key]),
        title: `Recurring failure: ${g.eventType} from ${g.source} (${g.count}× in ${windowHours}h)`,
        detail: {
          eventType: g.eventType,
          source: g.source,
          surfaces: Array.from(g.surfaces).slice(0, 10),
          count: g.count,
          criticalCount: g.critical,
          windowHours,
          threshold: minCount,
          sampleMessage: g.sample,
          evidence: `telemetry_events recorded ${g.count} '${g.eventType}' failures from '${g.source}' in the last ${windowHours}h.`,
          suggestedFix:
            'Open the Admin → Feedback & Telemetry Analytics view, filter to this source/type, and drill into a session flow to reproduce. Then fix the failing path and confirm the rate drops.'
        },
        severity,
        confidence: 1
      });
    }

    ctx.log('telemetry_failure_spike: evaluated', { rows: rows.length, groups: groups.size, findings: findings.length });
    return findings;
  }
};
