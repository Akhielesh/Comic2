import React, { useState } from 'react';
import { Database, Play, Loader2, AlertTriangle, Table2, ChevronDown, ChevronUp, RotateCcw, Copy, Check } from 'lucide-react';
import { runSqlExercise, type SqlRunResult } from '../../../services/learnApi';
import type { SqlExerciseArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, Badge } from './kit';

// An interactive SQL playground the AI generates for learning. The user writes SQL and
// runs it against a sandboxed in-memory database (server-side sql.js) — real results,
// real SQLite errors — so they actually practice rather than just read.

export const SqlPlayground: React.FC<{ data: SqlExerciseArtifact }> = ({ data }) => {
  const [query, setQuery] = useState(data.starterSql || 'SELECT * FROM ');
  const [result, setResult] = useState<SqlRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [showSchema, setShowSchema] = useState(false);
  const [copied, setCopied] = useState(false);

  const starter = data.starterSql || 'SELECT * FROM ';
  const copy = async () => {
    try { await navigator.clipboard.writeText(query); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard unavailable */ }
  };

  const run = async () => {
    if (!query.trim() || running) return;
    setRunning(true);
    try {
      setResult(await runSqlExercise(data.schema || '', query));
    } catch (e) {
      setResult({ columns: [], rows: [], rowCount: 0, truncated: false, error: (e as Error)?.message || 'Could not run the query.' });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Surface
      accent="#0284c7"
      header={
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0 rounded-lg bg-black/[0.04] p-1.5 text-[#6e6a60]">
            <Database className="w-4 h-4" />
          </span>
          <SurfaceTitle>{data.title || 'SQL practice'}</SurfaceTitle>
        </div>
      }
      right={<Badge color="#0284c7">SQLite · sandboxed</Badge>}
    >
      <div className="px-3 pb-3 space-y-3">
        {data.instructions && <p className="text-sm text-[#6e6a60]">{data.instructions}</p>}
        {data.task && (
          <div className="text-sm text-[#1a1915] rounded-xl bg-black/[0.03] p-2.5">
            <span className="font-semibold text-sky-800">Task:</span> {data.task}
          </div>
        )}

        {/* Collapsible schema so the learner can see the tables/data. */}
        {data.schema && (
          <div>
            <button onClick={() => setShowSchema((v) => !v)} className="flex items-center gap-1 text-[11px] font-semibold text-[#6e6a60] transition-colors duration-200 hover:text-[#1a1915]">
              {showSchema ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />} Database schema
            </button>
            {showSchema && (
              <pre className="mt-1 text-[11px] whitespace-pre-wrap break-words bg-black/[0.03] border border-black/5 rounded-xl p-2 max-h-40 overflow-y-auto font-mono text-[#1a1915]">{data.schema}</pre>
            )}
          </div>
        )}

        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run(); } }}
          rows={Math.min(10, Math.max(3, query.split('\n').length))}
          spellCheck={false}
          className="w-full font-mono text-[13px] border border-black/10 rounded-xl p-2.5 bg-slate-900 text-slate-100 focus:outline-none focus:border-black/25 resize-y"
          placeholder="Write SQL here…"
        />

        <div className="flex items-center gap-2">
          <button
            onClick={() => void run()}
            disabled={running || !query.trim()}
            className="flex items-center gap-1.5 text-sm font-semibold rounded-lg px-4 py-1.5 bg-[#D97757] text-white transition-colors duration-200 hover:bg-[#c2643f] disabled:opacity-40"
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Run
          </button>
          <span className="text-[11px] text-[#6e6a60]">⌘/Ctrl + Enter</span>
          <button onClick={copy} title="Copy SQL" className="ml-auto flex items-center gap-1 rounded-lg border border-black/10 bg-white/70 px-2 py-1 text-[11px] font-semibold text-[#6e6a60] transition-colors duration-200 hover:bg-black/5 hover:text-[#1a1915]">
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          <button onClick={() => setQuery(starter)} title="Reset to starter query" className="flex items-center gap-1 rounded-lg border border-black/10 bg-white/70 px-2 py-1 text-[11px] font-semibold text-[#6e6a60] transition-colors duration-200 hover:bg-black/5 hover:text-[#1a1915]">
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Result: error, a table, or "no rows". */}
        {result && (
          result.error ? (
            <div className="flex items-start gap-1.5 text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-xl p-2.5 font-mono">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {result.error}
            </div>
          ) : (
            <div className="border border-black/10 rounded-xl overflow-hidden">
              <div className="bg-black/[0.03] px-2.5 py-1.5 text-[11px] font-semibold text-[#6e6a60] flex items-center gap-1.5 border-b border-black/5">
                <Table2 className="w-3.5 h-3.5" /> {result.rowCount} row{result.rowCount === 1 ? '' : 's'}{result.truncated ? ` (showing first ${result.rows.length})` : ''}
              </div>
              {result.rows.length > 0 ? (
                <div className="overflow-x-auto max-h-72">
                  <table className="text-[12px] w-full border-collapse">
                    {result.columns.length > 0 && (
                      <thead>
                        <tr>{result.columns.map((c, i) => <th key={i} className="text-left font-semibold text-[#1a1915] px-2.5 py-1 bg-white border-b border-black/10 sticky top-0">{c}</th>)}</tr>
                      </thead>
                    )}
                    <tbody>
                      {result.rows.map((row, ri) => (
                        <tr key={ri} className="odd:bg-white even:bg-black/[0.02]">
                          {row.map((cell, ci) => <td key={ci} className="px-2.5 py-1 border-b border-black/5 font-mono whitespace-pre-wrap break-words text-[#1a1915]">{cell === null ? <span className="text-[#6e6a60] italic">NULL</span> : String(cell)}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="px-2.5 py-2 text-[12px] text-[#6e6a60]">No rows returned.</div>
              )}
            </div>
          )
        )}
      </div>
    </Surface>
  );
};
