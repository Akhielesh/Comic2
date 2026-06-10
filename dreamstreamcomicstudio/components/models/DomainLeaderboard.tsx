// Multi-domain leaderboards — OpenRouter/llm-stats-style ranked tables, one per field.
//
// People come from different fields: a coder, a researcher, a math student and a writer
// all need "which model is best for MY work" — not just a coding table. Each tab ranks
// every text model in the catalog by its benchmark-backed strength in that domain
// (services/modelDomains.ts) and shows the underlying raw numbers in sortable,
// right-aligned columns. The COLUMNS adapt per domain (SWE-bench for coding, GPQA for
// science, MATH for math, MMLU for knowledge, Arena Elo for writing); the FRAME —
// header, filters, rank, provider icon, score bar, actions — is identical everywhere.

import React, { useMemo, useState } from 'react';
import { Trophy, Crown, Star, Cpu, Type as TypeIcon, ArrowUpDown, Check, Zap, MessageSquare } from 'lucide-react';
import { sourceLabel, type CatalogModel, type ModelSource } from '../../services/modelCatalog';
import { getModelBenchmarks, formatScore, BENCHMARK_METRICS, type BenchmarkMetricId } from '../../services/modelBenchmarks';
import { domainStrength, DOMAIN_META, type DomainId } from '../../services/modelDomains';
import { setStudioModel } from '../../services/studioModelSelection';
import { setSelectedModel } from '../../services/modelSelection';
import { CODING_RECOMMENDATIONS, recommendedCodingMatch, TIER_LABEL } from '../../services/codingRecommendations';
import { ModelProviderIcon, SourceIcon } from './ProviderIcon';
import { SectionHeader } from './SectionHeader';

type SourceFilter = 'all' | ModelSource;

/** The leaderboard tabs and the raw benchmark columns each one exposes. */
export const LEADERBOARD_DOMAINS: { domain: DomainId; metrics: BenchmarkMetricId[]; blurb: string }[] = [
  { domain: 'coding', metrics: ['swebench', 'humaneval'], blurb: 'Composite of HumanEval + SWE-bench Verified, with a bonus for purpose-built coders.' },
  { domain: 'science', metrics: ['gpqa'], blurb: 'PhD-level science reasoning, backed by GPQA Diamond.' },
  { domain: 'math', metrics: ['math'], blurb: 'Step-by-step mathematical problem solving, backed by the MATH benchmark.' },
  { domain: 'reasoning', metrics: ['gpqa', 'math'], blurb: 'Multi-step logical thinking — explicit reasoning models plus hard-benchmark strength.' },
  { domain: 'writing', metrics: ['arena_elo'], blurb: 'Human-preference Arena ranking — the best proxy for natural, in-character prose.' },
  { domain: 'knowledge', metrics: ['mmlu'], blurb: 'Broad factual knowledge across 57 subjects, backed by MMLU.' }
];

interface Row {
  model: CatalogModel;
  strength: number;
  metrics: (number | null)[];
  contextK: number;
  pricePerM: number | null; // completion $/M tokens; null = unknown, 0 = free
}

type SortKey = 'strength' | `m${number}` | 'context' | 'price';

const isTextModel = (m: CatalogModel): boolean => !m.supportsImageOutput;

const RANK_TONE = ['text-amber-500', 'text-slate-400', 'text-amber-700'];

const Bar: React.FC<{ value: number; tone: string }> = ({ value, tone }) => (
  <div className="h-1.5 w-14 rounded-full bg-slate-200 overflow-hidden">
    <div className={`h-full ${tone}`} style={{ width: `${Math.max(2, Math.min(100, value))}%` }} />
  </div>
);

const BAR_TONE: Partial<Record<DomainId, string>> = {
  coding: 'bg-emerald-500',
  science: 'bg-cyan-500',
  math: 'bg-violet-500',
  reasoning: 'bg-indigo-500',
  writing: 'bg-rose-500',
  knowledge: 'bg-amber-500'
};

const SourceBadge: React.FC<{ source: ModelSource }> = ({ source }) => (
  <span className={`inline-flex items-center gap-1 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border ${source === 'nvidia' ? 'border-emerald-600 text-emerald-700 bg-emerald-50' : 'border-brand-blue text-brand-blue bg-blue-50'}`}>
    <SourceIcon source={source} className="w-2.5 h-2.5" />
    {source === 'nvidia' ? 'NVIDIA' : 'OpenRouter'}
  </span>
);

export interface DomainLeaderboardProps {
  models: CatalogModel[];
  onStartChat?: (model: { id: string; name: string; source: ModelSource }) => void;
}

export const DomainLeaderboard: React.FC<DomainLeaderboardProps> = ({ models, onStartChat }) => {
  const [domainIdx, setDomainIdx] = useState(0);
  const [sortBy, setSortBy] = useState<SortKey>('strength');
  const [freeOnly, setFreeOnly] = useState(false);
  const [source, setSource] = useState<SourceFilter>('all');
  const [recent, setRecent] = useState<{ id: string; kind: 'studio' | 'text' } | null>(null);

  const tab = LEADERBOARD_DOMAINS[domainIdx];
  const meta = DOMAIN_META[tab.domain];

  const rows = useMemo(() => {
    let list: Row[] = models
      .filter(isTextModel)
      .filter((m) => m.apiCallable !== false) // download-only models can't actually be used
      .map((m) => {
        const bm = getModelBenchmarks(m.id);
        const out = m.pricing?.completionPerToken;
        return {
          model: m,
          strength: domainStrength(m, tab.domain),
          metrics: tab.metrics.map((id) => bm?.scores[id] ?? null),
          contextK: Math.round((m.contextLength || 0) / 1000),
          pricePerM: m.isFree ? 0 : typeof out === 'number' && out > 0 ? out * 1_000_000 : null
        };
      })
      .filter((r) => r.strength > 0);
    if (freeOnly) list = list.filter((r) => r.model.isFree);
    if (source !== 'all') list = list.filter((r) => r.model.source === source);
    const metricIdx = sortBy.startsWith('m') ? Number(sortBy.slice(1)) : -1;
    list.sort((a, b) => {
      if (sortBy === 'strength') return b.strength - a.strength;
      if (sortBy === 'context') return b.contextK - a.contextK;
      if (sortBy === 'price') return (a.pricePerM ?? Infinity) - (b.pricePerM ?? Infinity);
      return (b.metrics[metricIdx] ?? -1) - (a.metrics[metricIdx] ?? -1);
    });
    return list;
  }, [models, tab, sortBy, freeOnly, source]);

  const useStudio = (m: CatalogModel) => { setStudioModel(m.id, m.source); setRecent({ id: m.id, kind: 'studio' }); };
  const useText = (m: CatalogModel) => { setSelectedModel('text', m.id, 'specific', m.source); setRecent({ id: m.id, kind: 'text' }); };

  // Curated coding recommendations (chips) — coding tab only.
  const recToModel = (key: string): CatalogModel | null => {
    const pick = CODING_RECOMMENDATIONS.find((p) => p.key === key);
    if (!pick) return null;
    const hits = models.filter((m) => isTextModel(m) && m.apiCallable !== false && pick.match.test(m.id.toLowerCase()));
    if (!hits.length) return null;
    return [...hits].sort((a, b) => (a.isFree === b.isFree ? domainStrength(b, 'coding') - domainStrength(a, 'coding') : a.isFree ? -1 : 1))[0];
  };

  const SortHeader: React.FC<{ k: SortKey; label: string; align?: 'left' | 'right' }> = ({ k, label, align = 'right' }) => (
    <th className={`px-2 py-2 font-bold ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button onClick={() => setSortBy(k)} className={`inline-flex items-center gap-1 hover:underline ${sortBy === k ? 'text-black' : 'text-slate-500'}`}>
        {label}<ArrowUpDown className="w-3 h-3" />
      </button>
    </th>
  );

  return (
    <div className="mt-4">
      {/* Domain tabs — one leaderboard per field, same frame for each. */}
      <div className="flex flex-wrap gap-1.5">
        {LEADERBOARD_DOMAINS.map((d, i) => {
          const m = DOMAIN_META[d.domain];
          const active = i === domainIdx;
          return (
            <button
              key={d.domain}
              onClick={() => { setDomainIdx(i); setSortBy('strength'); }}
              className={`text-xs font-bold px-3 py-1.5 rounded-t-lg border-2 border-b-0 border-black ${active ? m.tone : 'bg-white hover:bg-slate-100 text-slate-600'}`}
            >
              {m.label}
            </button>
          );
        })}
      </div>

      <div className="bg-gradient-to-r from-emerald-500/10 to-brand-blue/10 border-2 border-black rounded-xl rounded-tl-none p-4">
        <SectionHeader
          icon={<Trophy className="w-5 h-5 text-amber-500" />}
          title={`${meta.label} leaderboard`}
          count={`${rows.length} ranked`}
          subtitle={<>
            Every text model in your sources, ranked by benchmark-backed <span className="font-bold">{meta.label.toLowerCase()} strength</span>. {tab.blurb}{' '}
            Sort any column for the raw numbers.
          </>}
        />
        {tab.domain === 'coding' && (
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
        )}
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
          <thead className="bg-slate-100 border-b-2 border-black text-left sticky top-0">
            <tr>
              <th className="px-2 py-2 font-bold w-10">#</th>
              <th className="px-2 py-2 font-bold">Model</th>
              <SortHeader k="strength" label={meta.label} align="left" />
              {tab.metrics.map((id, i) => (
                <SortHeader key={id} k={`m${i}` as SortKey} label={BENCHMARK_METRICS[id].label} />
              ))}
              <SortHeader k="context" label="Context" />
              <SortHeader k="price" label="$/M out" />
              <th className="px-2 py-2 font-bold text-right">Use</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={6 + tab.metrics.length} className="px-3 py-6 text-center text-slate-500">No {meta.label.toLowerCase()}-capable models match these filters yet.</td></tr>
            )}
            {rows.map((r, i) => {
              const rec = tab.domain === 'coding' ? recommendedCodingMatch(r.model.id) : null;
              const justSet = recent?.id === r.model.id;
              const family = getModelBenchmarks(r.model.id)?.family;
              return (
                <tr key={`${r.model.source}:${r.model.id}`} className={`border-b border-slate-100 hover:bg-slate-50 align-middle ${i % 2 === 1 ? 'bg-slate-50/40' : ''}`}>
                  <td className="px-2 py-2 font-mono">
                    {i < 3 ? <Trophy className={`w-3.5 h-3.5 ${RANK_TONE[i]}`} aria-label={`Rank ${i + 1}`} /> : <span className="text-slate-400">{i + 1}</span>}
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <ModelProviderIcon model={r.model} className="w-4 h-4 shrink-0" />
                      {rec?.tier === 'flagship' && <Crown className="w-3.5 h-3.5 text-amber-500 shrink-0" aria-label="Recommended flagship coder" />}
                      <span className="font-bold">{r.model.name}</span>
                      <SourceBadge source={r.model.source} />
                      {r.model.isFree && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-green-500 text-white">Free</span>}
                      {rec && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded border border-amber-500 text-amber-700 bg-amber-50 inline-flex items-center gap-0.5"><Star className="w-2.5 h-2.5" />{TIER_LABEL[rec.tier]}</span>}
                    </div>
                    <div className="text-[10px] text-slate-400 font-mono truncate max-w-[260px]">{r.model.id}{family ? ` · ${family}` : ''}</div>
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-1.5"><span className="font-bold tabular-nums w-6">{r.strength}</span><Bar value={r.strength} tone={BAR_TONE[tab.domain] ?? 'bg-emerald-500'} /></div>
                  </td>
                  {tab.metrics.map((id, mi) => (
                    <td key={id} className="px-2 py-2 tabular-nums text-right">
                      {r.metrics[mi] != null ? formatScore(id, r.metrics[mi]!) : <span className="text-slate-300">—</span>}
                    </td>
                  ))}
                  <td className="px-2 py-2 tabular-nums text-right">{r.contextK ? `${r.contextK}K` : <span className="text-slate-300">—</span>}</td>
                  <td className="px-2 py-2 tabular-nums text-right">{r.pricePerM === 0 ? <span className="text-green-600 font-bold">free</span> : r.pricePerM != null ? `$${r.pricePerM.toFixed(2)}` : <span className="text-slate-300">—</span>}</td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-end gap-1">
                      {tab.domain === 'coding' && (
                        <button
                          onClick={() => useStudio(r.model)}
                          title="Pin as Code Studio's coding model (independent of comics & chat)"
                          className="inline-flex items-center gap-1 rounded-full border-2 border-black px-2 py-1 font-bold bg-violet-500 text-white hover:translate-x-[1px] hover:translate-y-[1px] transition-transform"
                        >
                          {justSet && recent?.kind === 'studio' ? <Check className="w-3 h-3" /> : <Cpu className="w-3 h-3" />} Studio
                        </button>
                      )}
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
                          className="hidden sm:inline-flex items-center gap-1 rounded-full border-2 border-black px-2 py-1 font-bold bg-white hover:bg-slate-100"
                        >
                          <MessageSquare className="w-3 h-3" /> Chat
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
        {meta.label} strength is derived from curated, source-attributed benchmark snapshots (see each model's detail card) and is
        approximate — verify at the source links. Download-only models are excluded because they can't be called via the hosted APIs.
      </p>
    </div>
  );
};
