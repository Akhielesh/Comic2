import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, FlaskConical, Gauge, Zap } from 'lucide-react';
import { Surface, SurfaceTitle, SurfaceSubtitle, BULL, BEAR, withAlpha } from '../chat/artifacts/kit';
import { fetchBenchScores, type BenchScores, type BenchScore } from '../../services/modelBenchScores';

// DRS Benchmark Scores — the public, OpenRouter-style view of the latest published
// bench run: one 0–100 score per model (with a horizontal bar), per-phase pass/fail
// dots, and two top-10 "leaderboard bar" charts (fastest TTFT, highest throughput).
// Built from the calm-studio Primitive Kit (Surface, --ds-* tokens, inline bars —
// no chart libraries). Degrades gracefully: skeleton while loading, a quiet
// "No benchmark run published yet" card when there's nothing to show.

const ACCENT = '#D97757'; // theme-invariant terracotta accent (see studioDesign.ts)

const SOURCE_LABEL: Record<string, string> = { openrouter: 'OpenRouter', nvidia: 'NVIDIA' };

// Canonical phase order first (mirrors the bench runner), unknown phases after.
const PHASE_ORDER = ['echo', 'context', 'reasoning'];
const sortPhases = (keys: string[]): string[] =>
  [...keys].sort((a, b) => {
    const ia = PHASE_ORDER.indexOf(a);
    const ib = PHASE_ORDER.indexOf(b);
    return (ia === -1 ? PHASE_ORDER.length : ia) - (ib === -1 ? PHASE_ORDER.length : ib) || a.localeCompare(b);
  });

const fmtMs = (ms: number | null): string =>
  ms === null ? '—' : ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
const fmtTps = (tps: number | null): string => (tps === null ? '—' : `${Math.round(tps)} tok/s`);

/** Fastest first-token latency across the model's phases (lower is better). */
const bestTtft = (s: BenchScore): number | null => {
  const vals = Object.values(s.phases).map((p) => p.ttftMs).filter((v): v is number => v !== null);
  return vals.length ? Math.min(...vals) : null;
};
/** Peak streaming throughput across the model's phases (higher is better). */
const bestTps = (s: BenchScore): number | null => {
  const vals = Object.values(s.phases).map((p) => p.tokensPerSec).filter((v): v is number => v !== null);
  return vals.length ? Math.max(...vals) : null;
};

// ── Per-phase pass/fail dots ──────────────────────────────────────────────────
const PhaseDots: React.FC<{ score: BenchScore; phaseKeys: string[] }> = ({ score, phaseKeys }) => (
  <span className="inline-flex items-center gap-1.5">
    {phaseKeys.map((phase) => {
      const stat = score.phases[phase];
      const state = stat?.pass === true ? 'pass' : stat?.pass === false ? 'fail' : 'untested';
      const tip = stat
        ? `${phase}: ${state} · TTFT ${fmtMs(stat.ttftMs)} · ${fmtTps(stat.tokensPerSec)}`
        : `${phase}: not tested`;
      return (
        <span
          key={phase}
          title={tip}
          aria-label={tip}
          className="h-2.5 w-2.5 rounded-full"
          style={
            state === 'pass'
              ? { background: BULL }
              : state === 'fail'
                ? { background: BEAR }
                : { background: 'var(--ds-well)', boxShadow: 'inset 0 0 0 1px var(--ds-hairline)' }
          }
        />
      );
    })}
  </span>
);

// ── Top-10 leaderboard bars (the "small chart") ───────────────────────────────
interface BarRow {
  key: string;
  label: string;
  sub?: string;
  /** Bar length, already normalized so the leader reads full-width. */
  frac: number;
  display: string;
}

const BarList: React.FC<{ rows: BarRow[]; color: string }> = ({ rows, color }) => (
  <div className="space-y-2 px-3 pb-3">
    {rows.map((row, i) => (
      <div key={row.key} className="flex items-center gap-2.5">
        <span className="w-5 shrink-0 text-right text-[11px] font-semibold tabular-nums text-[var(--ds-muted)]">{i + 1}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className="min-w-0 truncate text-[12px] font-medium text-[var(--ds-ink)]" title={row.label}>
              {row.label}
              {row.sub && <span className="ml-1.5 text-[10px] text-[var(--ds-muted)]">{row.sub}</span>}
            </span>
            <span className="shrink-0 text-[11px] font-semibold tabular-nums text-[var(--ds-ink)]">{row.display}</span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[var(--ds-well)]">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${Math.max(2, row.frac * 100)}%`, background: color }}
            />
          </div>
        </div>
      </div>
    ))}
  </div>
);

// ── Main panel ────────────────────────────────────────────────────────────────
export const DrsBenchScores: React.FC = () => {
  const [data, setData] = useState<BenchScores | null>(null);
  const [loading, setLoading] = useState(true);
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');

  useEffect(() => {
    let on = true;
    void fetchBenchScores().then((res) => {
      if (!on) return;
      setData(res);
      setLoading(false);
    });
    return () => {
      on = false;
    };
  }, []);

  const phaseKeys = useMemo(
    () => sortPhases([...new Set((data?.scores ?? []).flatMap((s) => Object.keys(s.phases)))]),
    [data]
  );

  const sorted = useMemo(() => {
    const list = [...(data?.scores ?? [])];
    list.sort((a, b) => (sortDir === 'desc' ? b.score - a.score : a.score - b.score));
    return list;
  }, [data, sortDir]);

  // Fastest models: lowest TTFT wins, bars sized so the FASTEST reads full-width.
  const ttftRows = useMemo<BarRow[]>(() => {
    const withTtft = (data?.scores ?? [])
      .map((s) => ({ s, ttft: bestTtft(s) }))
      .filter((x): x is { s: BenchScore; ttft: number } => x.ttft !== null && x.ttft > 0)
      .sort((a, b) => a.ttft - b.ttft)
      .slice(0, 10);
    const fastest = withTtft[0]?.ttft ?? 1;
    return withTtft.map(({ s, ttft }) => ({
      key: `${s.source}:${s.model}`,
      label: s.model,
      sub: SOURCE_LABEL[s.source] ?? s.source,
      frac: fastest / ttft, // inverse scale: lower latency → longer bar
      display: fmtMs(ttft)
    }));
  }, [data]);

  // Throughput: highest tokens/sec wins.
  const tpsRows = useMemo<BarRow[]>(() => {
    const withTps = (data?.scores ?? [])
      .map((s) => ({ s, tps: bestTps(s) }))
      .filter((x): x is { s: BenchScore; tps: number } => x.tps !== null && x.tps > 0)
      .sort((a, b) => b.tps - a.tps)
      .slice(0, 10);
    const top = withTps[0]?.tps ?? 1;
    return withTps.map(({ s, tps }) => ({
      key: `${s.source}:${s.model}`,
      label: s.model,
      sub: SOURCE_LABEL[s.source] ?? s.source,
      frac: tps / top,
      display: fmtTps(tps)
    }));
  }, [data]);

  const runDate = data?.runAt ? new Date(data.runAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null;
  const hasScores = sorted.length > 0;

  const header = (
    <>
      <SurfaceTitle>
        <span className="inline-flex items-center gap-1.5">
          <Gauge className="h-3.5 w-3.5" style={{ color: ACCENT }} />
          DRS Benchmark Scores
        </span>
      </SurfaceTitle>
      <SurfaceSubtitle>
        Live in-app benchmark of every connected model{runDate ? ` · run ${runDate}` : ''}
      </SurfaceSubtitle>
    </>
  );

  if (loading) {
    return (
      <Surface accent={ACCENT} header={header}>
        <div className="animate-pulse space-y-2.5 px-3 pb-3 pt-1" aria-label="Loading benchmark scores">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2.5">
              <div className="h-3 w-40 rounded bg-[var(--ds-well)]" />
              <div className="h-3 flex-1 rounded bg-[var(--ds-well)]" />
              <div className="h-3 w-16 rounded bg-[var(--ds-well)]" />
            </div>
          ))}
        </div>
      </Surface>
    );
  }

  if (!hasScores) {
    return (
      <Surface accent={ACCENT} header={header}>
        <div className="flex items-center gap-2 px-3 pb-4 text-[12px] text-[var(--ds-muted)]">
          <FlaskConical className="h-4 w-4 shrink-0" />
          No benchmark run published yet — scores will appear here after the next run.
        </div>
      </Surface>
    );
  }

  return (
    <div>
      {/* Score table */}
      <Surface accent={ACCENT} header={header}>
        <div className="max-h-[30rem] overflow-y-auto px-1 pb-2">
          <table className="w-full text-[12px]">
            <thead className="sticky top-0 z-10 bg-[var(--ds-surface)]">
              <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-[var(--ds-muted)]">
                <th className="px-2 py-1.5 font-semibold">Model</th>
                <th className="px-2 py-1.5 font-semibold">Source</th>
                <th className="px-2 py-1.5 font-semibold">
                  <button
                    onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}
                    className="inline-flex items-center gap-1 uppercase tracking-wide text-[var(--ds-muted)] hover:text-[var(--ds-ink)] transition-colors"
                    title="Sort by DRS score"
                  >
                    DRS score
                    {sortDir === 'desc' ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />}
                  </button>
                </th>
                <th className="px-2 py-1.5 font-semibold">Phases</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((s) => (
                <tr key={`${s.source}:${s.model}`} className="border-t border-[var(--ds-hairline-soft)] hover:bg-[var(--ds-hover)] transition-colors">
                  <td className="max-w-[22rem] truncate px-2 py-1.5 font-medium text-[var(--ds-ink)]" title={s.model}>{s.model}</td>
                  <td className="whitespace-nowrap px-2 py-1.5 text-[11px] text-[var(--ds-muted)]">{SOURCE_LABEL[s.source] ?? s.source}</td>
                  <td className="w-44 px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--ds-well)]">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${Math.max(2, s.score)}%`, background: `linear-gradient(90deg, ${withAlpha(ACCENT, 0.65)}, ${ACCENT})` }}
                        />
                      </div>
                      <span className="w-8 shrink-0 text-right font-semibold tabular-nums text-[var(--ds-ink)]">{Math.round(s.score)}</span>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-2 py-1.5"><PhaseDots score={s} phaseKeys={phaseKeys} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-[var(--ds-hairline-soft)] bg-[var(--ds-well)] px-3 py-1.5 text-[10px] text-[var(--ds-muted)]">
          Score is the DRS composite (0–100) from the latest published run · dots are per-phase pass/fail — hover one for TTFT and throughput.
        </div>
      </Surface>

      {/* Speed leaderboards — top-10 bars, like OpenRouter's model charts. */}
      <div className="grid gap-x-3 md:grid-cols-2">
        {ttftRows.length > 0 && (
          <Surface
            header={
              <>
                <SurfaceTitle>
                  <span className="inline-flex items-center gap-1.5">
                    <Zap className="h-3.5 w-3.5" style={{ color: ACCENT }} />
                    Fastest models (TTFT)
                  </span>
                </SurfaceTitle>
                <SurfaceSubtitle>Time to first token — lower is better</SurfaceSubtitle>
              </>
            }
          >
            <BarList rows={ttftRows} color={ACCENT} />
          </Surface>
        )}
        {tpsRows.length > 0 && (
          <Surface
            header={
              <>
                <SurfaceTitle>
                  <span className="inline-flex items-center gap-1.5">
                    <Gauge className="h-3.5 w-3.5" style={{ color: BULL }} />
                    Throughput (tokens/sec)
                  </span>
                </SurfaceTitle>
                <SurfaceSubtitle>Streaming speed — higher is better</SurfaceSubtitle>
              </>
            }
          >
            <BarList rows={tpsRows} color={BULL} />
          </Surface>
        )}
      </div>
    </div>
  );
};
