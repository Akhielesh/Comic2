import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Loader2, AlertTriangle, Download, RotateCcw, FlaskConical } from 'lucide-react';
import {
  startBench,
  listBenchRuns,
  getBenchRunById,
  benchRunToCsv,
  downloadBlob,
  type BenchPhase,
  type BenchRecord,
  type BenchRun,
  type BenchRunSummary,
  type BenchSource
} from '../../services/modelBench';

// The in-app model bench (admin only): ONE button tests every model on the connected
// sources and renders the raw numbers as a plain table — no charts, no decoration.
// Heavy lifting happens server-side (modelBenchRunner) on the dedicated
// DREAMSTREAMSTUDIO_MODELTEST key; this panel just starts a run and polls it.

const POLL_MS = 2_500;
const ALL_PHASES: BenchPhase[] = ['echo', 'context', 'reasoning'];

const fmtMs = (ms: number | null | undefined): string =>
  ms === null || ms === undefined ? '—' : ms >= 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
const fmtUsd = (v: number | null | undefined): string =>
  v === null || v === undefined || v === 0 ? '—' : `$${v.toFixed(5)}`;

type ModelRows = { key: string; source: BenchSource; model: string; rows: BenchRecord[] };

const groupByModel = (results: BenchRecord[]): ModelRows[] => {
  const map = new Map<string, ModelRows>();
  for (const r of results) {
    const key = `${r.source}:${r.model}`;
    const entry = map.get(key);
    if (entry) entry.rows.push(r);
    else map.set(key, { key, source: r.source, model: r.model, rows: [r] });
  }
  const hasFailure = (g: ModelRows) => g.rows.some((r) => !r.ok && r.errorClass !== 'skipped');
  const echoTotal = (g: ModelRows) => g.rows.find((r) => r.phase === 'echo')?.totalMs ?? 0;
  return [...map.values()].sort((a, b) => {
    const fa = hasFailure(a);
    const fb = hasFailure(b);
    if (fa !== fb) return fa ? -1 : 1; // failures first
    return echoTotal(b) - echoTotal(a); // then slowest
  });
};

const phaseCell = (rows: BenchRecord[], phase: BenchPhase): { label: string; cls: string } => {
  const r = rows.find((x) => x.phase === phase);
  if (!r) return { label: '—', cls: 'text-slate-400' };
  if (r.errorClass === 'skipped') return { label: 'skip', cls: 'text-slate-400' };
  if (!r.ok) return { label: `✗ ${r.errorClass}`, cls: 'text-brand-red font-bold' };
  return r.pass ? { label: '✓', cls: 'text-green-700 font-bold' } : { label: '✗ wrong', cls: 'text-amber-700 font-bold' };
};

export const ModelBenchPanel: React.FC = () => {
  const [source, setSource] = useState<BenchSource | 'all'>('all');
  const [freeOnly, setFreeOnly] = useState(false);
  const [phases, setPhases] = useState<BenchPhase[]>(ALL_PHASES);
  const [budgetUsd, setBudgetUsd] = useState(5);
  const [limit, setLimit] = useState(0);
  const [match, setMatch] = useState('');

  const [run, setRun] = useState<BenchRun | null>(null);
  const [pastRuns, setPastRuns] = useState<BenchRunSummary[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshPastRuns = () => {
    listBenchRuns()
      .then((res) => setPastRuns(res.runs))
      .catch(() => undefined); // list is a convenience — never an error state
  };
  useEffect(() => {
    refreshPastRuns();
    return () => { if (pollTimer.current) clearTimeout(pollTimer.current); };
  }, []);

  const poll = (id: string) => {
    getBenchRunById(id)
      .then((res) => {
        setRun(res.run);
        if (res.run.state === 'running') pollTimer.current = setTimeout(() => poll(id), POLL_MS);
        else refreshPastRuns();
      })
      .catch((err) => {
        setError(err?.message || 'Lost the run — it may have been pruned.');
      });
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const res = await startBench({ source, freeOnly, phases, budgetUsd, limit, match });
      poll(res.run.id);
    } catch (err) {
      setError((err as Error)?.message || 'Failed to start the bench run.');
    } finally {
      setStarting(false);
    }
  };

  const loadRun = (id: string) => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    poll(id);
  };

  const grouped = useMemo(() => (run ? groupByModel(run.results) : []), [run]);
  const running = run?.state === 'running';
  const togglePhase = (p: BenchPhase) =>
    setPhases((prev) => (prev.includes(p) ? (prev.length > 1 ? prev.filter((x) => x !== p) : prev) : [...prev, p]));

  return (
    <div className="mt-4 space-y-4">
      {/* Controls — one trigger, a few honest knobs. */}
      <div className="border-2 border-black rounded-xl bg-white p-4 shadow-comic">
        <div className="flex items-center gap-2 mb-1">
          <FlaskConical className="w-5 h-5 text-brand-blue" />
          <h2 className="font-display text-lg">Model bench — test every model, one trigger</h2>
        </div>
        <p className="text-xs text-slate-600 mb-3">
          Live-tests each model on your sources: echo (instruction-following + latency), context (a code planted in ~6K tokens,
          asked back) and arithmetic. Plain numbers only. Runs on the dedicated <code>MODELTEST</code> key with a hard budget —
          pass/fail means &ldquo;working condition&rdquo;, not a capability ranking.
        </p>
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <label className="flex flex-col gap-1 font-bold">
            Source
            <select value={source} onChange={(e) => setSource(e.target.value as BenchSource | 'all')} className="border-2 border-black rounded px-2 py-1.5 bg-white font-normal">
              <option value="all">All connected</option>
              <option value="openrouter">OpenRouter</option>
              <option value="nvidia">NVIDIA Build</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 font-bold">
            Budget (USD)
            <input type="number" min={0.1} max={25} step={0.5} value={budgetUsd} onChange={(e) => setBudgetUsd(Number(e.target.value))} className="border-2 border-black rounded px-2 py-1.5 w-24 font-normal" />
          </label>
          <label className="flex flex-col gap-1 font-bold">
            Max models <span className="font-normal text-slate-400">(0 = all)</span>
            <input type="number" min={0} max={1000} value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="border-2 border-black rounded px-2 py-1.5 w-24 font-normal" />
          </label>
          <label className="flex flex-col gap-1 font-bold">
            Filter id contains
            <input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="e.g. claude" className="border-2 border-black rounded px-2 py-1.5 w-36 font-normal" />
          </label>
          <label className="flex items-center gap-1.5 font-bold pb-2">
            <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} className="accent-brand-blue" /> Free only
          </label>
          <div className="flex items-center gap-2 pb-2">
            <span className="font-bold">Phases:</span>
            {ALL_PHASES.map((p) => (
              <button key={p} onClick={() => togglePhase(p)} className={`px-2 py-1 rounded border-2 border-black font-bold ${phases.includes(p) ? 'bg-brand-blue text-white' : 'bg-white hover:bg-slate-100'}`}>
                {p}
              </button>
            ))}
          </div>
          <button
            onClick={start}
            disabled={starting || running}
            className="ml-auto flex items-center gap-1.5 px-4 py-2 rounded-lg border-2 border-black bg-green-600 text-white font-bold disabled:opacity-50 hover:translate-x-[1px] hover:translate-y-[1px] transition-transform"
          >
            {starting || running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {running ? 'Running…' : 'Run bench'}
          </button>
        </div>
        {pastRuns.length > 0 && (
          <div className="mt-3 pt-3 border-t border-dashed border-slate-200 flex items-center gap-2 text-xs">
            <RotateCcw className="w-3.5 h-3.5 text-slate-400" />
            <span className="font-bold text-slate-500">Past runs (this server boot):</span>
            {pastRuns.slice(0, 5).map((r) => (
              <button key={r.id} onClick={() => loadRun(r.id)} className={`px-2 py-0.5 rounded border-2 border-black font-mono ${run?.id === r.id ? 'bg-brand-yellow' : 'bg-white hover:bg-slate-100'}`}>
                {new Date(r.startedAt).toLocaleTimeString()} · {r.healthy}/{r.tested}{r.state === 'running' ? ' · running' : ''}
              </button>
            ))}
          </div>
        )}
        {error && (
          <div className="mt-3 text-xs bg-red-100 border-2 border-black rounded-lg p-2 flex items-start gap-1.5">
            <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
          </div>
        )}
      </div>

      {/* Live progress + spend. */}
      {run && (
        <div className="border-2 border-black rounded-xl bg-white p-4 shadow-comic text-xs space-y-2">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-bold">
            <span>{running ? <Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1" /> : null}{run.tested}/{run.planned} models tested</span>
            <span className="text-green-700">{run.healthy} healthy</span>
            <span className={run.anomalyCount > 0 ? 'text-amber-700' : 'text-slate-400'}>{run.anomalyCount} anomalies</span>
            <span className="text-slate-500 font-normal">spend ~${run.spendUsd.toFixed(4)} of ${run.options.budgetUsd} budget</span>
            {run.state === 'error' && <span className="text-brand-red">run failed: {run.error}</span>}
            {run.state === 'done' && (
              <span className="ml-auto flex items-center gap-2">
                <button onClick={() => downloadBlob(JSON.stringify(run, null, 2), `model-bench-${run.id.slice(0, 8)}.json`, 'application/json')} className="flex items-center gap-1 px-2 py-1 rounded border-2 border-black bg-white hover:bg-brand-yellow"><Download className="w-3 h-3" /> JSON</button>
                <button onClick={() => downloadBlob(benchRunToCsv(run), `model-bench-${run.id.slice(0, 8)}.csv`, 'text/csv')} className="flex items-center gap-1 px-2 py-1 rounded border-2 border-black bg-white hover:bg-brand-yellow"><Download className="w-3 h-3" /> CSV</button>
              </span>
            )}
          </div>
          {run.planned > 0 && (
            <div className="h-2 rounded-full bg-slate-100 border border-black overflow-hidden">
              <div className="h-full bg-brand-blue transition-all" style={{ width: `${Math.round((run.tested / run.planned) * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {/* Anomalies — the part worth reading first. */}
      {run && run.anomalies.length > 0 && (
        <details className="border-2 border-black rounded-xl bg-amber-50 p-3 shadow-comic text-xs" open={!running}>
          <summary className="font-bold cursor-pointer flex items-center gap-1.5"><AlertTriangle className="w-4 h-4" /> Anomalies ({run.anomalies.length})</summary>
          <ul className="mt-2 space-y-0.5 font-mono text-[11px] max-h-60 overflow-y-auto">
            {run.anomalies.map((a, i) => <li key={i}>• {a}</li>)}
          </ul>
        </details>
      )}

      {/* Results — the plain table. Click a row for input/output. */}
      {run && grouped.length > 0 && (
        <div className="border-2 border-black rounded-xl bg-white shadow-comic overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="border-b-2 border-black bg-slate-50 text-left">
                {['Model', 'Source', 'Echo', 'TTFT', 'Total', 'tok/s', 'Context', 'Math', 'Cost', 'Error'].map((h) => (
                  <th key={h} className="px-2 py-1.5 font-bold uppercase text-[10px] text-slate-500 whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grouped.map((g) => {
                const echo = g.rows.find((r) => r.phase === 'echo') || g.rows[0];
                const cost = g.rows.reduce((s, r) => s + (r.costUsd || 0), 0);
                const err = g.rows.find((r) => r.errorDetail && r.errorClass !== 'skipped');
                const cells: { label: string; cls: string }[] = [phaseCell(g.rows, 'echo'), phaseCell(g.rows, 'context'), phaseCell(g.rows, 'reasoning')];
                const isOpen = expanded === g.key;
                return (
                  <React.Fragment key={g.key}>
                    <tr onClick={() => setExpanded(isOpen ? null : g.key)} className={`border-t border-slate-100 cursor-pointer hover:bg-brand-yellow/10 ${isOpen ? 'bg-brand-yellow/10' : ''}`}>
                      <td className="px-2 py-1 font-mono max-w-[26rem] truncate" title={g.model}>{g.model}</td>
                      <td className="px-2 py-1 uppercase text-slate-500">{g.source}</td>
                      <td className={`px-2 py-1 whitespace-nowrap ${cells[0].cls}`}>{cells[0].label}</td>
                      <td className="px-2 py-1 tabular-nums">{fmtMs(echo.ttftMs)}</td>
                      <td className={`px-2 py-1 tabular-nums ${(echo.totalMs ?? 0) > 30_000 ? 'text-amber-700 font-bold' : ''}`}>{fmtMs(echo.totalMs)}</td>
                      <td className="px-2 py-1 tabular-nums">{echo.tokensPerSec ?? '—'}</td>
                      <td className={`px-2 py-1 whitespace-nowrap ${cells[1].cls}`}>{cells[1].label}</td>
                      <td className={`px-2 py-1 whitespace-nowrap ${cells[2].cls}`}>{cells[2].label}</td>
                      <td className="px-2 py-1 tabular-nums">{fmtUsd(cost || null)}</td>
                      <td className="px-2 py-1 max-w-[16rem] truncate text-slate-500" title={err?.errorDetail || ''}>{err?.errorDetail || ''}</td>
                    </tr>
                    {isOpen && (
                      <tr className="border-t border-slate-100 bg-slate-50/60">
                        <td colSpan={10} className="px-3 py-2">
                          <div className="grid gap-1.5">
                            {g.rows.map((r) => (
                              <div key={r.phase} className="font-mono text-[10px] leading-relaxed">
                                <span className="font-bold uppercase">{r.phase}</span>
                                {r.servedModel && r.servedModel !== r.model && <span className="text-amber-700"> · served by {r.servedModel}</span>}
                                {r.httpStatus !== null && <span className="text-slate-400"> · HTTP {r.httpStatus}</span>}
                                {r.errorClass === 'skipped' ? (
                                  <span className="text-slate-500"> · skipped: {r.errorDetail}</span>
                                ) : (
                                  <>
                                    <div className="text-slate-500 truncate">in: {r.promptPreview}</div>
                                    <div className={r.pass === false ? 'text-amber-700' : 'text-slate-700'}>out: {r.textPreview ?? `(${r.errorClass}: ${r.errorDetail || 'no response'})`}</div>
                                  </>
                                )}
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
