import React, { useState } from 'react';
import { Database, Play, Loader2, AlertTriangle, Table2, ChevronDown, ChevronUp } from 'lucide-react';
import { runSqlExercise, type SqlRunResult } from '../../../services/learnApi';
import type { SqlExerciseArtifact } from '../../../apiTypes';

// An interactive SQL playground the AI generates for learning. The user writes SQL and
// runs it against a sandboxed in-memory database (server-side sql.js) — real results,
// real SQLite errors — so they actually practice rather than just read.

export const SqlPlayground: React.FC<{ data: SqlExerciseArtifact }> = ({ data }) => {
  const [query, setQuery] = useState(data.starterSql || 'SELECT * FROM ');
  const [result, setResult] = useState<SqlRunResult | null>(null);
  const [running, setRunning] = useState(false);
  const [showSchema, setShowSchema] = useState(false);

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
    <div className="border-2 border-black rounded-xl bg-white shadow-comic overflow-hidden animate-fade-in">
      <div className="bg-sky-700 text-white px-4 py-2.5 flex items-center gap-2">
        <Database className="w-5 h-5" />
        <div className="font-display text-lg leading-none truncate flex-1">{data.title || 'SQL practice'}</div>
        <span className="text-[10px] font-bold uppercase tracking-wide bg-white/20 px-1.5 py-0.5 rounded">SQLite · sandboxed</span>
      </div>

      <div className="p-4 space-y-3">
        {data.instructions && <p className="text-sm text-slate-600">{data.instructions}</p>}
        {data.task && (
          <div className="text-sm bg-sky-50 border-2 border-sky-200 rounded-lg p-2.5">
            <span className="font-bold text-sky-800">Task:</span> {data.task}
          </div>
        )}

        {/* Collapsible schema so the learner can see the tables/data. */}
        {data.schema && (
          <div>
            <button onClick={() => setShowSchema((v) => !v)} className="flex items-center gap-1 text-[11px] font-bold text-slate-600 hover:text-black">
              {showSchema ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />} Database schema
            </button>
            {showSchema && (
              <pre className="mt-1 text-[11px] whitespace-pre-wrap break-words bg-slate-50 border border-slate-200 rounded p-2 max-h-40 overflow-y-auto font-mono">{data.schema}</pre>
            )}
          </div>
        )}

        <textarea
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void run(); } }}
          rows={Math.min(10, Math.max(3, query.split('\n').length))}
          spellCheck={false}
          className="w-full font-mono text-[13px] border-2 border-black rounded-lg p-2.5 bg-slate-900 text-slate-100 focus:outline-none resize-y"
          placeholder="Write SQL here…"
        />

        <div className="flex items-center gap-2">
          <button
            onClick={() => void run()}
            disabled={running || !query.trim()}
            className="flex items-center gap-1.5 text-sm font-bold border-2 border-black rounded-md px-4 py-1.5 bg-brand-yellow hover:bg-black hover:text-brand-yellow transition-colors disabled:opacity-40"
          >
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Run
          </button>
          <span className="text-[11px] text-slate-400">⌘/Ctrl + Enter</span>
        </div>

        {/* Result: error, a table, or "no rows". */}
        {result && (
          result.error ? (
            <div className="flex items-start gap-1.5 text-[13px] text-red-700 bg-red-50 border-2 border-red-300 rounded-lg p-2.5 font-mono">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {result.error}
            </div>
          ) : (
            <div className="border-2 border-black rounded-lg overflow-hidden">
              <div className="bg-slate-100 px-2.5 py-1.5 text-[11px] font-bold flex items-center gap-1.5 border-b-2 border-black">
                <Table2 className="w-3.5 h-3.5" /> {result.rowCount} row{result.rowCount === 1 ? '' : 's'}{result.truncated ? ` (showing first ${result.rows.length})` : ''}
              </div>
              {result.rows.length > 0 ? (
                <div className="overflow-x-auto max-h-72">
                  <table className="text-[12px] w-full border-collapse">
                    {result.columns.length > 0 && (
                      <thead>
                        <tr>{result.columns.map((c, i) => <th key={i} className="text-left font-bold px-2.5 py-1 bg-slate-50 border-b border-slate-200 sticky top-0">{c}</th>)}</tr>
                      </thead>
                    )}
                    <tbody>
                      {result.rows.map((row, ri) => (
                        <tr key={ri} className="odd:bg-white even:bg-slate-50">
                          {row.map((cell, ci) => <td key={ci} className="px-2.5 py-1 border-b border-slate-100 font-mono whitespace-pre-wrap break-words">{cell === null ? <span className="text-slate-400 italic">NULL</span> : String(cell)}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="px-2.5 py-2 text-[12px] text-slate-500">No rows returned.</div>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
};
