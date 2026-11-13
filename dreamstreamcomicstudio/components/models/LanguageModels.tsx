import React, { useDeferredValue, useMemo, useState } from 'react';
import { ArrowRight, Search } from 'lucide-react';
import type { CatalogModel } from '../../services/modelCatalog';
import { sourceLabel } from '../../services/modelCatalog';
import type { ModelSpeed } from '../../services/modelSpeed';
import { Button } from '../ds/Button';
import { Input } from '../ds/Input';
import { Select } from '../ds/Select';
import { Checkbox } from '../ds/Checkbox';
import { EmptyState } from '../ds/EmptyState';
import { MUTED, FOCUS_RING, RADIUS_CONTROL } from '../chat/studioDesign';
import { ProviderIcon } from './ProviderIcon';
import { FEATURED_MAKERS, focusedTextModels, recentModelsByMaker, modelMaker, modelKey, modelPrice, knownTokenPrice, formatContext, formatLatency } from './workspaceData';

interface Props {
  models: CatalogModel[];
  speeds: Record<string, ModelSpeed>;
  loading: boolean;
  selected: string[];
  onToggle: (model: CatalogModel) => void;
  onOpen: (model: CatalogModel) => void;
}

export function LanguageModels({ models, speeds, loading, selected, onToggle, onOpen }: Props) {
  const [maker, setMaker] = useState('all');
  const [query, setQuery] = useState('');
  const search = useDeferredValue(query.trim().toLowerCase());
  const [sort, setSort] = useState('recent');
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState(0);
  const focused = useMemo(() => focusedTextModels(models), [models]);
  const counts = useMemo(() => new Map(FEATURED_MAKERS.map((m) => [m.id, focused.filter((model) => modelMaker(model).id === m.id).length])), [focused]);
  const rows = useMemo(() => {
    let list = focused.filter((m) => (maker === 'all' || modelMaker(m).id === maker)
      && (!search || `${m.name} ${m.id} ${sourceLabel(m.source)} ${modelMaker(m).label}`.toLowerCase().includes(search)));
    if (!expanded && maker === 'all' && !search) list = recentModelsByMaker(list);
    return list.sort((a, b) => sort === 'price' ? (knownTokenPrice(a, 'output') ?? Infinity) - (knownTokenPrice(b, 'output') ?? Infinity)
      : sort === 'speed' ? (speeds[a.id]?.p50Ms ?? Infinity) - (speeds[b.id]?.p50Ms ?? Infinity)
      : sort === 'context' ? (b.contextLength ?? 0) - (a.contextLength ?? 0)
      : (b.createdAt ?? 0) - (a.createdAt ?? 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [focused, maker, search, sort, expanded, speeds]);
  const pages = Math.max(1, Math.ceil(rows.length / 20));
  const currentPage = Math.min(page, pages - 1);
  const shown = rows.slice(currentPage * 20, currentPage * 20 + 20);
  const selectMaker = (id: string) => { setMaker(id); setPage(0); };

  return <div className="grid min-w-0 gap-7 lg:grid-cols-[190px_minmax(0,1fr)]">
    <aside aria-label="Featured model providers" className="min-w-0">
      <p className={`mb-3 text-xs font-medium ${MUTED}`}>10 featured providers</p>
      <div className="hidden space-y-1 lg:block">
        <Button variant={maker === 'all' ? 'secondary' : 'ghost'} className="w-full justify-between" onClick={() => selectMaker('all')}>All providers<span className="text-xs tabular-nums">{focused.length}</span></Button>
        {FEATURED_MAKERS.map((item) => <button key={item.id} type="button" aria-pressed={maker === item.id} onClick={() => selectMaker(item.id)} className={`flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-sm ${RADIUS_CONTROL} ${FOCUS_RING} ${maker === item.id ? 'bg-[var(--ds-hover)] font-semibold' : 'hover:bg-[var(--ds-hover)]'}`}><ProviderIcon vendorId={item.id} className="size-4 shrink-0" /><span className="min-w-0 flex-1">{item.label.split(' · ')[0]}</span><span className={`text-xs tabular-nums ${MUTED}`}>{counts.get(item.id) || '—'}</span></button>)}
      </div>
      <Select aria-label="Model provider" className="lg:hidden" wrapperClassName="lg:hidden" value={maker} onChange={(e) => selectMaker(e.target.value)} options={[{ value: 'all', label: 'All 10 providers' }, ...FEATURED_MAKERS.map((m) => ({ value: m.id, label: m.label }))]} />
      <p className={`mt-5 hidden text-xs leading-relaxed lg:block ${MUTED}`}>A focused selection of model makers. The serving connection is shown beneath each model.</p>
    </aside>

    <section className="min-w-0" aria-label="Language model comparison">
      <div className="mb-5 flex flex-wrap gap-3">
        <div className="relative min-w-0 flex-1 basis-60"><Search aria-hidden="true" className={`absolute left-3 top-3 size-4 ${MUTED}`} /><Input aria-label="Search language models" placeholder="Search models…" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} className="pl-9" /></div>
        <Select aria-label="Sort language models" wrapperClassName="w-full sm:w-48" value={sort} onChange={(e) => { setSort(e.target.value); setPage(0); }} options={[{ value: 'recent', label: 'Newest listed' }, { value: 'price', label: 'Lowest output price' }, { value: 'speed', label: 'Fastest observed' }, { value: 'context', label: 'Largest context' }]} />
      </div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2"><p className={`text-xs ${MUTED}`}>{loading ? 'Refreshing catalog…' : `${rows.length} models`} · USD per 1M tokens</p>{maker === 'all' && !search && <Button size="sm" variant="ghost" onClick={() => { setExpanded(!expanded); setPage(0); }}>{expanded ? 'Show recent selection' : 'Show all from these providers'}</Button>}</div>
      {!shown.length ? <EmptyState title={loading ? 'Loading models' : 'No models match'} description={loading ? 'Fetching the latest available catalog.' : 'Try another provider or search term.'} action={!loading ? { label: 'Clear filters', onClick: () => { setQuery(''); selectMaker('all'); } } : undefined} /> : <>
        <div className="hidden overflow-x-auto md:block">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Language models, token prices, context window, and median full-response time from platform Chat observations.</caption>
            <thead><tr className={`border-y border-[var(--ds-hairline)] text-xs ${MUTED}`}><th className="w-10 px-3 py-3"><span className="sr-only">Compare</span></th><th className="min-w-48 py-3 font-medium">Model</th><th className="px-4 py-3 text-right font-medium">Input</th><th className="px-4 py-3 text-right font-medium">Output</th><th className="px-4 py-3 text-right font-medium">Context</th><th className="py-3 pl-4 text-right font-medium">Response time</th><th className="w-10"><span className="sr-only">Details</span></th></tr></thead>
            <tbody>{shown.map((model) => <tr key={modelKey(model)} className="group border-b border-[var(--ds-hairline)] hover:bg-[var(--ds-hover)]">
              <td className="px-3 py-5"><Checkbox aria-label={`Compare ${model.name} via ${sourceLabel(model.source)}`} checked={selected.includes(modelKey(model))} disabled={selected.length >= 3 && !selected.includes(modelKey(model))} onCheckedChange={() => onToggle(model)} /></td>
              <th scope="row" className="max-w-80 py-4 font-normal"><button className={`flex min-h-11 w-full items-center gap-3 text-left ${FOCUS_RING} ${RADIUS_CONTROL}`} onClick={() => onOpen(model)}><ProviderIcon vendorId={modelMaker(model).id} className="size-5 shrink-0" /><span className="min-w-0"><span className="block font-medium [overflow-wrap:anywhere]">{model.name}</span><span className={`mt-1 block text-xs ${MUTED}`}>via {sourceLabel(model.source)}{model.catalogOrigin === 'curated' ? ' · Reference listing' : ''}</span></span></button></th>
              <td className="px-4 text-right tabular-nums">{modelPrice(model, 'input')}</td><td className="px-4 text-right tabular-nums">{modelPrice(model, 'output')}</td><td className="px-4 text-right tabular-nums">{formatContext(model.contextLength)}</td>
              <td className="py-4 pl-4 text-right tabular-nums">{formatLatency(speeds[model.id]?.p50Ms)}<span className={`mt-1 block text-xs ${MUTED}`}>{speeds[model.id] ? `${speeds[model.id].samples} observations` : 'No measurement'}</span></td>
              <td className="pl-2"><Button variant="ghost" size="icon" aria-label={`Details for ${model.name}`} onClick={() => onOpen(model)}><ArrowRight /></Button></td>
            </tr>)}</tbody>
          </table>
        </div>
        <div className="divide-y divide-[var(--ds-hairline)] border-y border-[var(--ds-hairline)] md:hidden">{shown.map((model) => <article key={modelKey(model)} className="py-5">
          <div className="flex items-start gap-3"><ProviderIcon vendorId={modelMaker(model).id} className="mt-1 size-5 shrink-0" /><button className={`min-w-0 flex-1 text-left ${FOCUS_RING}`} onClick={() => onOpen(model)}><h3 className="text-sm font-semibold [overflow-wrap:anywhere]">{model.name}</h3><p className={`mt-1 text-xs ${MUTED}`}>via {sourceLabel(model.source)}</p></button><Checkbox aria-label={`Compare ${model.name} via ${sourceLabel(model.source)}`} checked={selected.includes(modelKey(model))} disabled={selected.length >= 3 && !selected.includes(modelKey(model))} onCheckedChange={() => onToggle(model)} /></div>
          <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm">{[['Input / 1M', modelPrice(model, 'input')], ['Output / 1M', modelPrice(model, 'output')], ['Context', formatContext(model.contextLength)], ['Response time', formatLatency(speeds[model.id]?.p50Ms)]].map(([label, value]) => <div key={label}><dt className={`text-xs ${MUTED}`}>{label}</dt><dd className="mt-1 tabular-nums">{value}</dd></div>)}</dl>
        </article>)}</div>
        <footer className="mt-4 flex items-center justify-between gap-3 text-xs"><span className={MUTED}>{currentPage * 20 + 1}–{Math.min((currentPage + 1) * 20, rows.length)} of {rows.length}</span><div className="flex gap-2"><Button size="sm" variant="ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button><Button size="sm" variant="ghost" disabled={currentPage === pages - 1} onClick={() => setPage(currentPage + 1)}>Next</Button></div></footer>
      </>}
      <p className={`mt-5 max-w-3xl text-xs leading-relaxed ${MUTED}`}>Response time is the median of recorded Chat responses without tools, pooled across serving connections. Prompts and output lengths vary; this is not a controlled quality benchmark. Unknown prices stay unreported.</p>
    </section>
  </div>;
}
