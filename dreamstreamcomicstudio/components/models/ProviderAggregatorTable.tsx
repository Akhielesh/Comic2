import React, { useMemo, useState } from 'react';
import { ExternalLink, ArrowUpDown, Search } from 'lucide-react';
import type { CatalogModel } from '../../services/modelCatalog';
import { getModelVendor, availableVendors } from '../../services/modelVendors';
import { searchModels } from '../../services/modelSearch';
import { ProviderIcon } from './ProviderIcon';
import { getModelSize } from '../../services/modelParams';
import { getModelBenchmarks } from '../../services/modelBenchmarks';

type SortKey = 'vendor' | 'name' | 'context' | 'inPrice' | 'outPrice' | 'image' | 'elo';
type Modality = 'all' | 'text' | 'image';

const perMillion = (perToken: number) => (perToken > 0 ? `$${(perToken * 1_000_000).toFixed(2)}` : '—');
const ctxLabel = (ctx?: number) => (ctx ? `${Math.round(ctx / 1000)}K` : '—');
const eloOf = (m: CatalogModel) => getModelBenchmarks(m.id)?.scores.arena_elo ?? 0;
const releasedOf = (m: CatalogModel): string => getModelBenchmarks(m.id)?.asOf
  ?? (m.createdAt ? new Date(m.createdAt * 1000).toISOString().slice(0, 7) : '—');

const infoUrl = (m: CatalogModel): string | undefined =>
  m.source === 'openrouter' ? `https://openrouter.ai/${m.id}` : getModelVendor(m).url;

const Th: React.FC<{ id: SortKey; label: string; sort: SortKey; dir: 1 | -1; onSort: (k: SortKey) => void; align?: 'left' | 'right' }> =
  ({ id, label, sort, dir, onSort, align = 'left' }) => (
    <th className={`py-2 px-2 whitespace-nowrap ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button onClick={() => onSort(id)} className={`inline-flex items-center gap-1 hover:text-black ${sort === id ? 'text-black' : 'text-slate-500'}`}>
        {label}<ArrowUpDown className="w-3 h-3" />{sort === id && <span className="text-[9px]">{dir === 1 ? '▲' : '▼'}</span>}
      </button>
    </th>
  );

/**
 * Provider aggregator — every model in one sortable table with full data points (provider, context,
 * size/params, the four price axes, Arena Elo, modalities, release, link), with a LEFT filter rail
 * (provider checkboxes, modality, free-only, search) so the whole landscape is scannable at a glance.
 */
export const ProviderAggregatorTable: React.FC<{ models: CatalogModel[] }> = ({ models }) => {
  const [sort, setSort] = useState<SortKey>('vendor');
  const [dir, setDir] = useState<1 | -1>(1);
  const [limit, setLimit] = useState(75);
  const [vendorSel, setVendorSel] = useState<Set<string>>(new Set());
  const [modality, setModality] = useState<Modality>('all');
  const [freeOnly, setFreeOnly] = useState(false);
  const [q, setQ] = useState('');

  const vendorOptions = useMemo(() => availableVendors(models), [models]);

  const onSort = (k: SortKey) => {
    if (k === sort) setDir((d) => (d === 1 ? -1 : 1));
    else { setSort(k); setDir(k === 'elo' || k === 'context' ? -1 : 1); }
  };

  const filtered = useMemo(() => {
    // Ranked, typo-tolerant search first; the structural filters narrow the ranked list.
    return searchModels(models, q).filter((m) => {
      if (vendorSel.size && !vendorSel.has(getModelVendor(m).id)) return false;
      if (modality === 'text' && !m.outputModalities.includes('text')) return false;
      if (modality === 'image' && !m.supportsImageOutput) return false;
      if (freeOnly && !m.isFree) return false;
      return true;
    });
  }, [models, vendorSel, modality, freeOnly, q]);

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
    return [...filtered].sort((a, b) => {
      const av = val(a); const bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return a.name.localeCompare(b.name);
    });
  }, [filtered, sort, dir]);

  const shown = sorted.slice(0, limit);
  const toggleVendor = (id: string) => setVendorSel((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  return (
    <div className="mt-4 lg:flex lg:gap-4 items-start">
      {/* Left filter rail */}
      <aside className="lg:w-60 lg:shrink-0 border-2 border-black rounded-xl bg-white shadow-comic p-4 space-y-4 mb-4 lg:mb-0 lg:sticky lg:top-4">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="pl-8 pr-2 py-1.5 border-2 border-black rounded-lg text-sm w-full focus:outline-none focus:bg-brand-yellow/10" />
        </div>

        <div>
          <div className="text-[10px] font-bold uppercase text-slate-500 mb-1.5">Modality</div>
          <div className="inline-flex rounded-lg border-2 border-black overflow-hidden text-xs font-bold w-full">
            {(['all', 'text', 'image'] as Modality[]).map((m) => (
              <button key={m} onClick={() => setModality(m)} className={`flex-1 px-2 py-1 capitalize ${modality === m ? 'bg-brand-blue text-white' : 'bg-white hover:bg-slate-100'} ${m !== 'all' ? 'border-l-2 border-black' : ''}`}>{m}</button>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm font-bold cursor-pointer">
          <input type="checkbox" checked={freeOnly} onChange={(e) => setFreeOnly(e.target.checked)} className="accent-green-600 w-4 h-4" />
          Free only
        </label>

        <div>
          <div className="text-[10px] font-bold uppercase text-slate-500 mb-1.5">Provider</div>
          <div className="space-y-1 max-h-72 overflow-y-auto pr-1">
            {vendorOptions.map(({ vendor, count }) => (
              <label key={vendor.id} className="flex items-center gap-2 text-[12px] cursor-pointer hover:bg-slate-50 rounded px-1 py-0.5">
                <input type="checkbox" checked={vendorSel.has(vendor.id)} onChange={() => toggleVendor(vendor.id)} className="accent-brand-blue w-3.5 h-3.5" />
                <ProviderIcon vendorId={vendor.id} className="w-3.5 h-3.5 shrink-0" />
                <span className={`text-[8px] font-bold uppercase px-1 py-0.5 rounded border border-black ${vendor.color}`}>{vendor.label}</span>
                <span className="ml-auto font-mono text-[10px] text-slate-400">{count}</span>
              </label>
            ))}
          </div>
        </div>

        {(vendorSel.size > 0 || modality !== 'all' || freeOnly || q) && (
          <button onClick={() => { setVendorSel(new Set()); setModality('all'); setFreeOnly(false); setQ(''); }} className="text-[11px] font-bold px-2.5 py-1 rounded border-2 border-black bg-white hover:bg-slate-100 w-full">Reset filters</button>
        )}
      </aside>

      {/* Right: full-data table */}
      <div className="flex-1 min-w-0 border-2 border-black rounded-xl bg-white shadow-comic overflow-hidden">
        <div className="p-4 border-b-2 border-black flex items-center gap-2 flex-wrap">
          <span className="font-display text-lg">Provider aggregator</span>
          <span className="text-[11px] text-slate-500">{filtered.length} of {models.length} models · click a header to sort</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] border-collapse">
            <thead>
              <tr className="text-[10px] font-bold uppercase border-b-2 border-black bg-slate-50">
                <Th id="vendor" label="Provider" sort={sort} dir={dir} onSort={onSort} />
                <Th id="name" label="Model" sort={sort} dir={dir} onSort={onSort} />
                <Th id="context" label="Context" sort={sort} dir={dir} onSort={onSort} align="right" />
                <th className="py-2 px-2 text-left whitespace-nowrap text-slate-500">Size / params</th>
                <Th id="inPrice" label="In $/M" sort={sort} dir={dir} onSort={onSort} align="right" />
                <Th id="outPrice" label="Out $/M" sort={sort} dir={dir} onSort={onSort} align="right" />
                <Th id="image" label="$/img" sort={sort} dir={dir} onSort={onSort} align="right" />
                <Th id="elo" label="Arena" sort={sort} dir={dir} onSort={onSort} align="right" />
                <th className="py-2 px-2 text-left whitespace-nowrap text-slate-500 hidden md:table-cell">Released</th>
                <th className="py-2 px-2"></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((m) => {
                const vendor = getModelVendor(m);
                const size = getModelSize(m.id);
                const elo = eloOf(m);
                const url = infoUrl(m);
                return (
                  <tr key={`${m.source}:${m.id}`} className="border-b border-dashed border-slate-200 hover:bg-brand-yellow/5">
                    <td className="py-1.5 px-2">
                      <span className="inline-flex items-center gap-1.5">
                        <ProviderIcon vendorId={vendor.id} className="w-4 h-4 shrink-0" />
                        <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border border-black ${vendor.color}`}>{vendor.label}</span>
                      </span>
                    </td>
                    <td className="py-1.5 px-2">
                      <span className="font-bold">{m.name}</span>
                      {m.isFree && <span className="ml-1.5 text-[8px] font-bold uppercase px-1 py-0.5 rounded bg-green-500 text-white align-middle">Free</span>}
                      {m.apiCallable === false && <span className="ml-1.5 text-[8px] font-bold uppercase px-1 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-400 align-middle" title="Download-only — not callable on the hosted API">DL-only</span>}
                    </td>
                    <td className="py-1.5 px-2 font-mono whitespace-nowrap text-right">{ctxLabel(m.contextLength)}</td>
                    <td className="py-1.5 px-2 whitespace-nowrap text-slate-600">{size?.params ?? '—'}</td>
                    <td className="py-1.5 px-2 font-mono whitespace-nowrap text-right">{perMillion(m.pricing.promptPerToken)}</td>
                    <td className="py-1.5 px-2 font-mono whitespace-nowrap text-right">{perMillion(m.pricing.completionPerToken)}</td>
                    <td className="py-1.5 px-2 font-mono whitespace-nowrap text-right">{m.pricing.imagePerImage > 0 ? `$${m.pricing.imagePerImage.toFixed(3)}` : '—'}</td>
                    <td className="py-1.5 px-2 font-mono whitespace-nowrap text-right">{elo || '—'}</td>
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
            <button onClick={() => setLimit((l) => l + 100)} className="text-xs font-bold px-3 py-1.5 rounded border-2 border-black bg-white hover:bg-slate-100">Show more ({sorted.length - limit} remaining)</button>
          </div>
        )}
        <div className="px-4 py-2 text-[10px] text-slate-500 border-t border-dashed border-slate-200">Prices are per 1M tokens (input/output) or per image, from the live catalog. Arena Elo &amp; release are approximate.</div>
      </div>
    </div>
  );
};
