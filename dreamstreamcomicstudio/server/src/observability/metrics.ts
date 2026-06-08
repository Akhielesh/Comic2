// Minimal in-process metrics registry (Epic F0). Dependency-free counters with optional labels
// + a snapshot, so the platform can finally count things the audit said nothing was measuring:
// per-provider requests/errors/rate-limits, autonomous-tick outcomes, etc. A /metrics endpoint or
// dashboard surfacing (and a Prometheus/Sentry exporter) build on this; this is the substrate.

export type Labels = Record<string, string>;

const counters = new Map<string, number>();

const keyOf = (name: string, labels?: Labels): string => {
  if (!labels) return name;
  const parts = Object.entries(labels)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${v}"`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
};

/** Increment a counter (default +1). */
export const incr = (name: string, labels?: Labels, by = 1): void => {
  const k = keyOf(name, labels);
  counters.set(k, (counters.get(k) ?? 0) + by);
};

export const getCounter = (name: string, labels?: Labels): number => counters.get(keyOf(name, labels)) ?? 0;

/** A flat snapshot of every counter (for a dashboard or /metrics serialization). */
export const snapshot = (): Record<string, number> => Object.fromEntries(counters);

/** Test/maintenance helper. */
export const _resetMetrics = (): void => counters.clear();
