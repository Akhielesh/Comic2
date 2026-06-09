import React, { useMemo, useState } from 'react';
import { ExternalLink, ArrowUpDown } from 'lucide-react';
import type { CatalogModel } from '../../services/modelCatalog';
import { getModelVendor } from '../../services/modelVendors';
import { getModelSize } from '../../services/modelParams';
import { getModelBenchmarks } from '../../services/modelBenchmarks';

type SortKey = 'vendor' | 'name' | 'context' | 'inPrice' | 'outPrice' | 'image' | 'elo';

const perMillion = (perToken: number) => (perToken > 0 ? `$${(perToken * 1_000_000).toFixed(2)}` : '—');
const ctxLabel = (ctx?: number) => (ctx ? `${Math.round(ctx / 1000)}K` : '—');
const eloOf = (m: CatalogModel) => getModelBenchmarks(m.id)?.scores.arena_elo ?? 0;
const releasedOf = (m: CatalogModel): string => getModelBenchmarks(m.id)?.asOf
  ?? (m.createdAt ? new Date(m.createdAt * 1000).toISOString().slice(0, 7) : '—');

// The most useful "more info" link: the model's own page on its source, else the vendor homepage.
const infoUrl = (m: CatalogModel): string | undefined =>
  m.source === 'openrouter' ? `https://openrouter.ai/${m.id}` : getModelVendor(m).url;

const Th: React.FC<{ id: SortKey; label: string; sort: SortKey; dir: 1 | -1; onSort: (k: SortKey) => void; className?: string }> =
  ({ id, label, sort, dir, onSort, className = '' }) => (
    <th className={`py-2 px-2 text-left whitespace-nowrap ${className}`}>
      <button onClick={() => onSort(id)} className={`inline-flex items-center gap-1 hover:text-black ${sort === id ? 'text-black' : 'text-slate-500'}`}>
        {label}
        <ArrowUpDown className="w-3 h-3" />
        {sort === id && <span className="text-[9px]">{dir === 1 ? '▲' : '▼'}</span>}
      </button>
    </th>
  );

/**
 * Provider aggregator — every model in one sortable table with full data points (provider, context,
 * size/params, the four price axes, Arena Elo, modalities, release, link). Complements the card grid
 * for users who want to scan and compare the whole landscape at a glance.
 */
export const ProviderAggregatorTable: React.FC<{ models: CatalogModel[] }> = ({ models }) => {
  const [sort, setSort] = useState<SortKey>('vendor');
  const [dir, setDir] = useState<1 | -1>(1);
  const [limit, setLimit] = useState(75);

  const onSort = (k: SortKey) => {
    if (k === sort) setDir((d) => (d === 1 ? -1 : 1));
    else { setSort(k); setDir(k === 'elo' || k === 'context' ? -1 : 1); }
  };

  const sorted = useMemo(() => {
    const val = (m: CatalogModel): number | string => {
      switch (sort) {
        case 'vendor': return getModelVendor(m).label.toLowerCase();
        case 'name': return m.name.toLowerCase();
        case 'context': return m.contextLength || 0;
        case 'inPrice': return m.pricing.promptPerToken || 0;
        case 'outPrice': return m.pricing.completionPerToken || 0;
        case 'image': return m.pricing.imagePerImage || 0;
        case 'elo': return eloOf(m);
      }
    };
    return [...models].sort((a, b) => {
      const av = val(a); const bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return a.name.localeCompare(b.name);
    });
  }, [models, sort, dir]);

  const shown = sorted.slice(0, limit);

  return (
    <div className="mt-4 border-2 border-black rounded-xl bg-white shadow-comic overflow-hidden">
      <div className="p-4 border-b-2 border-black flex items-center gap-2 flex-wrap">
        <span className="font-display text-lg">Provider aggregator</span>
        <span className="text-[11px] text-slate-500">{models.length} models · every data point · click a header to sort</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px] border-collapse">
          <thead>
            <tr className="text-[10px] font-bold uppercase border-b-2 border-black bg-slate-50">
              <Th id="vendor" label="Provider" sort={sort} dir={dir} onSort={onSort} />
              <Th id="name" label="Model" sort={sort} dir={dir} onSort={onSort} />
              <Th id="context" label="Context" sort={sort} dir={dir} onSort={onSort} />
              <th className="py-2 px-2 text-left whitespace-nowrap text-slate-500">Size / params</th>
              <Th id="inPrice" label="In $/M" sort={sort} dir={dir} onSort={onSort} />
              <Th id="outPrice" label="Out $/M" sort={sort} dir={dir} onSort={onSort} />
              <Th id="image" label="$/img" sort={sort} dir={dir} onSort={onSort} />
              <Th id="elo" label="Arena" sort={sort} dir={dir} onSort={onSort} />
              <th className="py-2 px-2 text-left whitespace-nowrap text-slate-500 hidden lg:table-cell">In → Out</th>
              <th className="py-2 px-2 text-left whitespace-nowrap text-slate-500 hidden md:table-cell">Released</th>
              <th className="py-2 px-2 text-slate-500"></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((m) => {
              const vendor = getModelVendor(m);
              const size = getModelSize(m.id);
              const elo = eloOf(m);
              const url = infoUrl(m);
              return (
                <tr key={m.id} className="border-b border-dashed border-slate-200 hover:bg-brand-yellow/5">
                  <td className="py-1.5 px-2"><span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border border-black ${vendor.color}`}>{vendor.label}</span></td>
                  <td className="py-1.5 px-2"><span className="font-bold">{m.name}</span></td>
                  <td className="py-1.5 px-2 font-mono whitespace-nowrap">{ctxLabel(m.contextLength)}</td>
                  <td className="py-1.5 px-2 whitespace-nowrap text-slate-600">{size?.params ?? '—'}</td>
                  <td className="py-1.5 px-2 font-mono whitespace-nowrap">{perMillion(m.pricing.promptPerToken)}</td>
                  <td className="py-1.5 px-2 font-mono whitespace-nowrap">{perMillion(m.pricing.completionPerToken)}</td>
                  <td className="py-1.5 px-2 font-mono whitespace-nowrap">{m.pricing.imagePerImage > 0 ? `$${m.pricing.imagePerImage.toFixed(3)}` : '—'}</td>
                  <td className="py-1.5 px-2 font-mono whitespace-nowrap">{elo || '—'}</td>
                  <td className="py-1.5 px-2 text-slate-500 hidden lg:table-cell whitespace-nowrap">{m.inputModalities.join('+')} → {m.outputModalities.join('+')}</td>
                  <td className="py-1.5 px-2 text-slate-500 hidden md:table-cell whitespace-nowrap">{releasedOf(m)}</td>
                  <td className="py-1.5 px-2">
                    {url && <a href={url} target="_blank" rel="noopener noreferrer" className="text-slate-400 hover:text-brand-blue inline-flex" title="More info"><ExternalLink className="w-3.5 h-3.5" /></a>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sorted.length > limit && (
        <div className="p-3 border-t-2 border-black text-center">
          <button onClick={() => setLimit((l) => l + 100)} className="text-xs font-bold px-3 py-1.5 rounded border-2 border-black bg-white hover:bg-slate-100">
            Show more ({sorted.length - limit} remaining)
          </button>
        </div>
      )}
      <div className="px-4 py-2 text-[10px] text-slate-500 border-t border-dashed border-slate-200">
        Prices are per 1M tokens (input/output) or per image, from the live catalog. Arena Elo &amp; release are approximate, point-in-time.
      </div>
    </div>
  );
};
