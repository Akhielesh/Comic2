import React, { useMemo, useState } from 'react';
import { ChevronDown, ExternalLink, AlertTriangle, ShieldCheck } from 'lucide-react';
import { MODEL_BENCHMARKS } from '../../services/modelBenchmarks';
import { IMAGE_MODEL_RANKING } from '../../services/imageModelRanking';
import { isStale } from '../../services/modelDataAudit';

interface Row { label: string; asOf: string; source: string; sourceUrl: string }

const SourceTable: React.FC<{ title: string; rows: Row[] }> = ({ title, rows }) => (
  <div>
    <div className="text-[10px] font-bold uppercase text-slate-500 mb-1.5">{title}</div>
    <div className="overflow-x-auto">
      <table className="w-full text-[12px] border-collapse">
        <tbody>
          {rows.map((r) => {
            const stale = isStale(r.asOf);
            return (
              <tr key={r.label} className="border-b border-dashed border-slate-200">
                <td className="py-1.5 pr-2 font-bold">{r.label}</td>
                <td className="py-1.5 px-2 font-mono whitespace-nowrap text-slate-600">{r.asOf}</td>
                <td className="py-1.5 px-2 whitespace-nowrap">
                  {stale
                    ? <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-400"><AlertTriangle className="w-3 h-3" /> Review</span>
                    : <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-green-100 text-green-800 border border-green-400"><ShieldCheck className="w-3 h-3" /> Current</span>}
                </td>
                <td className="py-1.5 px-2 text-slate-500 truncate max-w-[16rem]">{r.source}</td>
                <td className="py-1.5 px-2">
                  <a href={r.sourceUrl} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-brand-blue inline-flex" title="Open source"><ExternalLink className="w-3.5 h-3.5" /></a>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  </div>
);

/**
 * Transparency panel for the curated datasets behind the rankings (benchmarks + image ranking).
 * Lists every entry's snapshot quarter and source link, and flags anything past the freshness
 * cutoff as "Review" — so the curated numbers are auditable instead of taken on faith.
 */
export const ModelDataSources: React.FC<{ defaultOpen?: boolean }> = ({ defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);

  const benchRows: Row[] = useMemo(
    () => MODEL_BENCHMARKS.map((b) => ({ label: b.family, asOf: b.asOf, source: b.source, sourceUrl: b.sourceUrl })),
    []
  );
  const imageRows: Row[] = useMemo(
    () => IMAGE_MODEL_RANKING.map((m) => ({ label: m.name, asOf: m.asOf, source: m.source, sourceUrl: m.sourceUrl })),
    []
  );
  const staleCount = useMemo(
    () => [...benchRows, ...imageRows].filter((r) => isStale(r.asOf)).length,
    [benchRows, imageRows]
  );

  return (
    <div className="mt-4 border-2 border-black rounded-xl bg-white shadow-comic overflow-hidden">
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-2 p-4 text-left hover:bg-brand-yellow/10 transition-colors">
        <ShieldCheck className="w-4 h-4 shrink-0" />
        <span className="font-display text-lg">Data &amp; sources</span>
        <span className="hidden sm:inline text-[11px] text-slate-500 font-normal">curated snapshots — verify at the source</span>
        {staleCount > 0 && (
          <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-400">{staleCount} to review</span>
        )}
        <ChevronDown className={`w-4 h-4 ml-auto shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-4">
          <p className="text-[11px] text-slate-500">
            Benchmarks (Arena Elo etc.), image rankings, and parameter sizes are hand-curated, point-in-time snapshots
            from public model cards &amp; leaderboards — approximate, not contracts. Entries older than 2025-Q3 are
            flagged <span className="font-bold text-amber-700">Review</span>. Always verify at the source link.
          </p>
          <SourceTable title="Text benchmarks" rows={benchRows} />
          <SourceTable title="Image model ranking" rows={imageRows} />
        </div>
      )}
    </div>
  );
};
