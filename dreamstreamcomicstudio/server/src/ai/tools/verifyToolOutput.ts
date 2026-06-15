import type { ToolExecResult } from './types.js';

// A pure, deterministic post-check on a structured tool's result. It catches SILENT
// degradation — where a tool returns a success-shaped result that's actually mangled —
// and returns a capability `notice` the chat loop surfaces (notice-only: it never
// retries, mutates artifacts, or changes control flow, so it's safe to run on every
// tool result). The swarm/research paths have a verifier (agents/verify.ts); the default
// chat loop had none.
//
// Every check is a RAW-args-vs-RENDERED-artifact diff or an exact sentinel match — never
// a heuristic on the output's plausibility — so it cannot fire on well-formed data
// (genuine zeros, legitimately-empty results, real errors the tool already noticed).

/** The exact "did nothing" sentinel run_python emits (runPython.ts). */
const PY_NO_OUTPUT = 'The code ran but printed nothing and produced no /output files.';

/**
 * Count raw chart points whose `y` is PRESENT but non-finite — render_chart coerces those
 * to 0 (`Number.isFinite(y) ? y : 0`), producing confidently-wrong flat/zero bars. A
 * missing `y` key (malformed input, handled upstream) and a genuine 0 are NOT counted.
 */
const countCoercedY = (rawSeries: unknown[]): number => {
  let n = 0;
  for (const s of rawSeries) {
    const pts = (s as Record<string, unknown>)?.points;
    if (!Array.isArray(pts)) continue;
    for (const p of pts) {
      const y = (p as Record<string, unknown>)?.y;
      if (y === undefined || y === null) continue; // missing key — not a coercion
      if (!Number.isFinite(Number(y))) n += 1;
    }
  }
  return n;
};

const countPoints = (series: unknown[]): number => {
  let n = 0;
  for (const s of series) {
    const pts = (s as Record<string, unknown>)?.points;
    if (Array.isArray(pts)) n += pts.length;
  }
  return n;
};

export const verifyToolOutput = (
  toolName: string,
  args: Record<string, unknown>,
  out: ToolExecResult
): { level: 'warn'; message: string } | null => {
  // Never double-flag a tool that already self-reported a problem (degraded mode,
  // missing key, empty result, real error).
  if (out?.notice) return null;

  if (toolName === 'render_chart') {
    const artifact = out.artifacts?.find((a) => a.type === 'chart');
    // No artifact → the tool already returned "no usable chart data"; nothing to diff.
    if (!artifact) return null;
    const rawSeries = Array.isArray(args?.series) ? (args.series as unknown[]) : [];
    if (!rawSeries.length) return null;
    const renderedSeries = Array.isArray((artifact.data as Record<string, unknown>)?.series)
      ? ((artifact.data as Record<string, unknown>).series as unknown[])
      : [];
    const coercedY = countCoercedY(rawSeries);
    const droppedPoints = Math.max(0, countPoints(rawSeries) - countPoints(renderedSeries));
    const issues: string[] = [];
    if (coercedY > 0) issues.push(`coerced ${coercedY} non-numeric y-value${coercedY === 1 ? '' : 's'} to 0`);
    if (droppedPoints > 0) issues.push(`dropped ${droppedPoints} point${droppedPoints === 1 ? '' : 's'} with an empty x-label`);
    if (issues.length) {
      return {
        level: 'warn',
        message: `render_chart ${issues.join(' and ')} — the chart may be misleading; re-check the data you charted before relying on it.`
      };
    }
    return null;
  }

  if (toolName === 'run_python') {
    // Empty output, no error (would carry a notice), and no produced image — the code
    // did nothing useful. Exact sentinel match so a script that prints "0"/"[]" is fine.
    if ((out.images?.length ?? 0) === 0 && typeof out.content === 'string' && out.content.startsWith(PY_NO_OUTPUT)) {
      return {
        level: 'warn',
        message:
          'run_python produced no stdout, no files and no error — the code likely did nothing useful (a missing print()/save, or a no-op). Re-examine the code and re-run if a result was expected.'
      };
    }
    return null;
  }

  return null;
};
