// Coding leaderboard — an OpenRouter/llm-stats-style ranked table of the catalog's best coders.
//
// Ranks every text model by a composite CODING score (HumanEval + SWE-bench, with a purpose-built
// -coder bonus; see services/modelDomains.ts), and exposes the underlying technical stats — real
// benchmark numbers, context window, token price, source — in sortable columns. "Use in Studio"
// pins the model as Code Studio's coding model (independent of comics/chat); "Use for text" sets it
// as the global text model. Curated recommendations are surfaced as quick chips up top.

import React, { useMemo, useState } from 'react';
import { Code2, Crown, Star, Cpu, Type as TypeIcon, ArrowUpDown, Check, Zap } from 'lucide-react';
import { sourceLabel, type CatalogModel, type ModelSource } from '../../services/modelCatalog';
import { getModelBenchmarks } from '../../services/modelBenchmarks';
import { domainStrength } from '../../services/modelDomains';
import { setStudioModel } from '../../services/studioModelSelection';
import { setSelectedModel } from '../../services/modelSelection';
import { CODING_RECOMMENDATIONS, recommendedCodingMatch, TIER_LABEL } from '../../services/codingRecommendations';

type SortKey = 'coding' | 'swebench' | 'humaneval' | 'context' | 'price';
type SourceFilter = 'all' | ModelSource;

interface Row {
  model: CatalogModel;
  coding: number;
  swebench: number | null;
  humaneval: number | null;
  contextK: number;
  pricePerM: number | null; // completion $/M tokens; null when unknown, 0 when free
  family: string | null;
}

const isCoderText = (m: CatalogModel): boolean => !m.supportsImageOutput;

const buildRow = (m: CatalogModel): Row => {
  const bm = getModelBenchmarks(m.id);
  const out = m.pricing?.completionPerToken;
  return {
    model: m,
    coding: domainStrength(m, 'coding'),
    swebench: bm?.scores.swebench ?? null,
    humaneval: bm?.scores.humaneval ?? null,
    contextK: Math.round((m.contextLength || 0) / 1000),
    pricePerM: m.isFree ? 0 : typeof out === 'number' && out > 0 ? out * 1_000_000 : null,
    family: bm?.family ?? null
  };
};

const SourceBadge: React.FC<{ source: ModelSource }> = ({ source }) => (
  <span className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${source === 'nvidia' ? 'border-emerald-600 text-emerald-700 bg-emerald-50' : 'border-brand-blue text-brand-blue bg-blue-50'}`}>
    {source === 'nvidia' ? 'NVIDIA' : 'OpenRouter'}
  </span>
);

const Bar: React.FC<{ value: number }> = ({ value }) => (
  <div className="h-1.5 w-14 rounded-full bg-slate-200 overflow-hidden">
    <div className="h-full bg-emerald-500" style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
  </div>
);

export interface CodingLeaderboardProps {
  models: CatalogModel[];
  onStartChat?: (model: { id: string; name: string; source: ModelSource }) => void;
}

export const CodingLeaderboard: React.FC<CodingLeaderboardProps> = ({ models, onStartChat }) => {
  const [sortBy, setSortBy] = useState<SortKey>('coding');
  const [freeOnly, setFreeOnly] = useState(false);
  const [source, setSource] = useState<SourceFilter>('all');
  const [recent, setRecent] = useState<{ id: string; kind: 'studio' | 'text' } | null>(null);

  const rows = useMemo(() => {
    let list = models.filter(isCoderText).map(buildRow).filter((r) => r.coding > 0);
    if (freeOnly) list = list.filter((r) => r.model.isFree);
    if (source !== 'all') list = list.filter((r) => r.model.source === source);
    const cmp: Record<SortKey, (a: Row, b: Row) => number> = {
      coding: (a, b) => b.coding - a.coding,
      swebench: (a, b) => (b.swebench ?? -1) - (a.swebench ?? -1),
      humaneval: (a, b) => (b.humaneval ?? -1) - (a.humaneval ?? -1),
      context: (a, b) => b.contextK - a.contextK,
      price: (a, b) => (a.pricePerM ?? Infinity) - (b.pricePerM ?? Infinity)
    };
    return [...list].sort(cmp[sortBy]);
  }, [models, sortBy, freeOnly, source]);

  const useStudio = (m: CatalogModel) => { setStudioModel(m.id, m.source); setRecent({ id: m.id, kind: 'studio' }); };
  const useText = (m: CatalogModel) => { setSelectedModel('text', m.id, 'specific', m.source); setRecent({ id: m.id, kind: 'text' }); };

  // Resolve a curated recommendation to a concrete catalog model (prefer free) for the quick chips.
  const recToModel = (key: string): CatalogModel | null => {
    const pick = CODING_RECOMMENDATIONS.find((p) => p.key === key);
    if (!pick) return null;
    const hits = models.filter((m) => isCoderText(m) && pick.match.test(m.id.toLowerCase()));
    if (!hits.length) return null;
    return [...hits].sort((a, b) => (a.isFree === b.isFree ? domainStrength(b, 'coding') - domainStrength(a, 'coding') : a.isFree ? -1 : 1))[0];
  };

  const SortHeader: React.FC<{ k: SortKey; label: string; className?: string }> = ({ k, label, className = '' }) => (
    <th className={`px-2 py-2 font-bold ${className}`}>
      <button onClick={() => setSortBy(k)} className={`inline-flex items-center gap-1 hover:underline ${sortBy === k ? 'text-black' : 'text-slate-500'}`}>
        {label}<ArrowUpDown className="w-3 h-3" />
      </button>
    </th>
  );

  return (
    <div className="mt-4">
      {/* Methodology + recommended */}
      <div className="bg-gradient-to-r from-emerald-500/10 to-brand-blue/10 border-2 border-black rounded-xl p-4">
        <div className="flex items-center gap-2 font-display text-lg"><Code2 className="w-5 h-5 text-emerald-600" /> Coding leaderboard</div>
        <p className="text-xs text-slate-600 mt-1 max-w-3xl">
          Every text model in your sources, ranked by a composite <span className="font-bold">coding score</span> (HumanEval + SWE-bench
          Verified, with a bonus for purpose-built coders). Sort by any column for the raw numbers. <span className="font-bold">Use in Studio</span>
          {' '}pins a model as Code Studio's coder — independent of your comics &amp; chat model.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {CODING_RECOMMENDATIONS.slice(0, 8).map((p) => {
            const m = recToModel(p.key);
            return (
              <button
                key={p.key}
                disabled={!m}
                onClick={() => m && useStudio(m)}
                title={m ? `${p.blurb} — Use in Studio` : `${p.label} isn't in your live catalog right now`}
                className={`inline-flex items-center gap-1 rounded-full border-2 px-2.5 py-1 text-[11px] font-bold ${m ? 'border-black bg-white hover:translate-x-[1px] hover:translate-y-[1px] transition-transform' : 'border-slate-300 text-slate-400 cursor-not-allowed'}`}
              >
                {p.tier === 'flagship' && <Crown className="w-3 h-3 text-amber-500" />}
                {p.label}
                {p.hasFreeVariant && <span className="text-emerald-600">·free</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Filters */}
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <button onClick={() => setFreeOnly((v) => !v)} className={`inline-flex items-center gap-1 rounded-full border-2 border-black px-3 py-1.5 font-bold ${freeOnly ? 'bg-green-500 text-white' : 'bg-white'}`}>
          <Zap className="w-3.5 h-3.5" /> Free only
        </button>
        {(['all', 'openrouter', 'nvidia'] as SourceFilter[]).map((s) => (
          <button key={s} onClick={() => setSource(s)} className={`rounded-full border-2 border-black px-3 py-1.5 font-bold ${source === s ? 'bg-black text-white' : 'bg-white'}`}>
            {s === 'all' ? 'All sources' : sourceLabel(s)}
          </button>
        ))}
        <span className="ml-auto text-slate-500">{rows.length} model{rows.length === 1 ? '' : 's'}</span>
      </div>

      {/* Ranked table */}
      <div className="mt-3 overflow-x-auto border-2 border-black rounded-xl bg-white">
        <table className="w-full text-xs min-w-[760px]">
          <thead className="bg-slate-100 border-b-2 border-black text-left">
            <tr>
              <th className="px-2 py-2 font-bold w-10">#</th>
              <th className="px-2 py-2 font-bold">Model</th>
              <SortHeader k="coding" label="Coding" />
              <SortHeader k="swebench" label="SWE-bench" />
              <SortHeader k="humaneval" label="HumanEval" />
              <SortHeader k="context" label="Context" />
              <SortHeader k="price" label="$/M out" />
              <th className="px-2 py-2 font-bold text-right">Use</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-500">No coding-capable models match these filters yet.</td></tr>
            )}
            {rows.map((r, i) => {
              const rec = recommendedCodingMatch(r.model.id);
              const justSet = recent?.id === r.model.id;
              return (
                <tr key={`${r.model.source}:${r.model.id}`} className="border-b border-slate-100 hover:bg-slate-50 align-middle">
                  <td className="px-2 py-2 font-mono text-slate-400">{i + 1}</td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {rec?.tier === 'flagship' && <Crown className="w-3.5 h-3.5 text-amber-500 shrink-0" aria-label="Recommended flagship coder" />}
                      <span className="font-bold">{r.model.name}</span>
                      <SourceBadge source={r.model.source} />
                      {r.model.isFree && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-green-500 text-white">Free</span>}
                      {rec && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border border-amber-500 text-amber-700 bg-amber-50 inline-flex items-center gap-0.5"><Star className="w-2.5 h-2.5" />{TIER_LABEL[rec.tier]}</span>}
                    </div>
                    <div className="text-[10px] text-slate-400 font-mono truncate max-w-[260px]">{r.model.id}{r.family ? ` · ${r.family}` : ''}</div>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-1.5"><span className="font-bold tabular-nums w-6">{r.coding}</span><Bar value={r.coding} /></div>
                  </td>
                  <td className="px-2 py-2 tabular-nums">{r.swebench != null ? `${r.swebench}%` : <span className="text-slate-300">—</span>}</td>
                  <td className="px-2 py-2 tabular-nums">{r.humaneval != null ? `${r.humaneval}%` : <span className="text-slate-300">—</span>}</td>
                  <td className="px-2 py-2 tabular-nums">{r.contextK ? `${r.contextK}K` : <span className="text-slate-300">—</span>}</td>
                  <td className="px-2 py-2 tabular-nums">{r.pricePerM === 0 ? <span className="text-green-600 font-bold">free</span> : r.pricePerM != null ? `$${r.pricePerM.toFixed(2)}` : <span className="text-slate-300">—</span>}</td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        onClick={() => useStudio(r.model)}
                        title="Pin as Code Studio's coding model (independent of comics & chat)"
                        className="inline-flex items-center gap-1 rounded-full border-2 border-black px-2 py-1 font-bold bg-violet-500 text-white hover:translate-x-[1px] hover:translate-y-[1px] transition-transform"
                      >
                        {justSet && recent?.kind === 'studio' ? <Check className="w-3 h-3" /> : <Cpu className="w-3 h-3" />} Studio
                      </button>
                      <button
                        onClick={() => useText(r.model)}
                        title="Use as the global text model (chat & comics)"
                        className="inline-flex items-center gap-1 rounded-full border-2 border-black px-2 py-1 font-bold bg-white hover:bg-slate-100"
                      >
                        {justSet && recent?.kind === 'text' ? <Check className="w-3 h-3" /> : <TypeIcon className="w-3 h-3" />} Text
                      </button>
                      {onStartChat && (
                        <button
                          onClick={() => onStartChat({ id: r.model.id, name: r.model.name, source: r.model.source })}
                          title="Try this model in chat"
                          className="hidden sm:inline-flex items-center rounded-full border-2 border-black px-2 py-1 font-bold bg-white hover:bg-slate-100"
                        >
                          Chat
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-slate-400">
        Coding score = normalized HumanEval + SWE-bench Verified (+ purpose-built-coder bonus). Benchmark figures are a curated,
        source-attributed snapshot (see each model's detail card) and are approximate — verify at the source links.
      </p>
    </div>
  );
};
