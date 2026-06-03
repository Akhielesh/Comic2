import React from 'react';
import {
  Code2, Atom, Sigma, Brain, PenLine, GraduationCap, Eye, Image as ImageIcon,
  Languages, Wrench, ScrollText, ExternalLink, BarChart3, type LucideIcon
} from 'lucide-react';
import type { CatalogModel } from '../../services/modelCatalog';
import { getModelDomains, topDomains, DOMAIN_META, type DomainId, type DomainStrength } from '../../services/modelDomains';
import { getModelBenchmarks, BENCHMARK_METRICS, normalizeScore, formatScore, type BenchmarkMetricId } from '../../services/modelBenchmarks';
import { InfoTooltip, InfoDot } from '../common/InfoTooltip';

// Visual building blocks for the richer Model Library: domain tags, a benchmark bar chart with
// honest source attribution, and a radar/spider chart of domain strengths. All read from the
// curated benchmark + domain layers and degrade gracefully when a model has no data.

const ICONS: Record<string, LucideIcon> = {
  Code2, Atom, Sigma, Brain, PenLine, GraduationCap, Eye, ImageIcon, Languages, Wrench, ScrollText
};

const strengthWord = (s: number): string => (s >= 85 ? 'Elite' : s >= 70 ? 'Strong' : s >= 55 ? 'Capable' : 'Basic');

// ── Domain tags ──────────────────────────────────────────────────────────────
export const DomainTags: React.FC<{ model: CatalogModel; limit?: number; threshold?: number }> = ({ model, limit = 3, threshold = 55 }) => {
  const domains = topDomains(model, limit, threshold);
  if (!domains.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {domains.map((d) => {
        const meta = DOMAIN_META[d.id];
        const Icon = ICONS[meta.icon] || Code2;
        return (
          <InfoTooltip
            key={d.id}
            content={{ title: `${meta.label} · ${strengthWord(d.strength)} (${d.strength}/100)`, body: meta.blurb, scale: d.basis === 'benchmark' ? 'Scored from public benchmarks' : d.basis === 'capability' ? 'From live capability data' : 'Inferred from the model family' }}
          >
            <span className={`flex items-center gap-1 rounded border border-black px-1.5 py-0.5 text-[10px] font-bold uppercase ${meta.tone}`}>
              <Icon className="h-2.5 w-2.5" /> {meta.label}
            </span>
          </InfoTooltip>
        );
      })}
    </div>
  );
};

// ── Benchmark bars ───────────────────────────────────────────────────────────
export const BenchmarkBars: React.FC<{ model: CatalogModel }> = ({ model }) => {
  const bm = getModelBenchmarks(model.id);
  if (!bm) {
    return (
      <div className="rounded-lg border-2 border-dashed border-slate-300 p-3 text-[11px] text-slate-400">
        No public benchmark data for this model yet. (Benchmarks cover the major model families — image-only models aren't scored on text benchmarks.)
      </div>
    );
  }
  const entries = (Object.keys(bm.scores) as BenchmarkMetricId[])
    .filter((k) => bm.scores[k] != null)
    .sort((a, b) => normalizeScore(b, bm.scores[b]!) - normalizeScore(a, bm.scores[a]!));

  return (
    <div className="space-y-2">
      {entries.map((k) => {
        const metric = BENCHMARK_METRICS[k];
        const value = bm.scores[k]!;
        const pct = normalizeScore(k, value);
        return (
          <div key={k}>
            <div className="flex items-center justify-between text-[11px]">
              <span className="flex items-center gap-1 font-bold text-slate-700">
                {metric.label} <InfoDot term={metric.glossary} />
              </span>
              <span className="font-mono text-slate-600">{formatScore(k, value)}</span>
            </div>
            <div className="mt-0.5 h-2.5 w-full overflow-hidden rounded-full border border-black bg-slate-100">
              <div
                className={`h-full rounded-full ${pct >= 75 ? 'bg-emerald-500' : pct >= 50 ? 'bg-brand-blue' : pct >= 30 ? 'bg-brand-yellow' : 'bg-brand-red'}`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        );
      })}
      <div className="flex items-center justify-between pt-1 text-[10px] text-slate-400">
        <span>Family: <span className="font-bold text-slate-500">{bm.family}</span> · as of {bm.asOf}</span>
        <a href={bm.sourceUrl} target="_blank" rel="noreferrer" className="flex items-center gap-0.5 font-bold text-brand-blue underline">
          {bm.source} <ExternalLink className="h-2.5 w-2.5" />
        </a>
      </div>
      <p className="text-[10px] leading-snug text-slate-400">
        Curated from public leaderboards &amp; model cards — point-in-time and approximate. Verify at the source.
      </p>
    </div>
  );
};

// ── Domain radar (spider chart) ──────────────────────────────────────────────
const RADAR_AXES: DomainId[] = ['coding', 'science', 'math', 'reasoning', 'knowledge', 'writing'];

export const DomainRadar: React.FC<{ model: CatalogModel; size?: number }> = ({ model, size = 180 }) => {
  const profile = getModelDomains(model);
  const byId = new Map<DomainId, DomainStrength>(profile.map((d) => [d.id, d]));
  const present = RADAR_AXES.filter((a) => byId.has(a));
  if (present.length < 3) return null; // not enough to draw a meaningful shape (e.g. image-only models)

  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 26;
  const n = RADAR_AXES.length;
  const angle = (i: number) => (Math.PI * 2 * i) / n - Math.PI / 2;
  const point = (i: number, frac: number) => ({ x: cx + r * frac * Math.cos(angle(i)), y: cy + r * frac * Math.sin(angle(i)) });

  const dataPoly = RADAR_AXES.map((a, i) => { const p = point(i, (byId.get(a)?.strength ?? 0) / 100); return `${p.x},${p.y}`; }).join(' ');
  const rings = [0.25, 0.5, 0.75, 1];

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="mx-auto">
      {rings.map((ring) => (
        <polygon
          key={ring}
          points={RADAR_AXES.map((_, i) => { const p = point(i, ring); return `${p.x},${p.y}`; }).join(' ')}
          fill="none" stroke="#e2e8f0" strokeWidth={1}
        />
      ))}
      {RADAR_AXES.map((_, i) => { const p = point(i, 1); return <line key={i} x1={cx} y1={cy} x2={p.x} y2={p.y} stroke="#e2e8f0" strokeWidth={1} />; })}
      <polygon points={dataPoly} fill="rgba(59,130,246,0.30)" stroke="#3B82F6" strokeWidth={2} />
      {RADAR_AXES.map((a, i) => { const p = point(i, (byId.get(a)?.strength ?? 0) / 100); return <circle key={a} cx={p.x} cy={p.y} r={2.5} fill="#3B82F6" />; })}
      {RADAR_AXES.map((a, i) => {
        const p = point(i, 1.16);
        return (
          <text key={a} x={p.x} y={p.y} textAnchor="middle" dominantBaseline="middle" className="fill-slate-500" style={{ fontSize: 9, fontWeight: 700 }}>
            {DOMAIN_META[a].label.split(' ')[0]}
          </text>
        );
      })}
    </svg>
  );
};

// ── Combined "Strengths & benchmarks" panel for the detail modal ──────────────
export const ModelInsightsPanel: React.FC<{ model: CatalogModel }> = ({ model }) => {
  const hasBench = !!getModelBenchmarks(model.id);
  return (
    <div className="rounded-lg border-2 border-black p-3">
      <h3 className="mb-2 flex items-center gap-1 text-xs font-bold uppercase">
        <BarChart3 className="h-4 w-4" /> Strengths &amp; benchmarks
      </h3>
      <div className={`grid gap-4 ${hasBench ? 'sm:grid-cols-[180px_1fr]' : ''}`}>
        {hasBench && (
          <div className="flex flex-col items-center">
            <DomainRadar model={model} />
            <div className="text-[10px] font-bold uppercase text-slate-400">Domain profile</div>
          </div>
        )}
        <BenchmarkBars model={model} />
      </div>
    </div>
  );
};
