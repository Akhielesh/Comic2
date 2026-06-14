import React from 'react';
import { Star } from 'lucide-react';
import type { GenerativeUIArtifact, ChartArtifact, DataTableArtifact } from '../../../apiTypes';
import { Surface, SurfaceTitle, SurfaceSubtitle, Sparkline, TrendPill, Badge, LinearGauge, RadialGauge, compactNumber } from './kit';
import { ChartCard } from './ChartCard';
import { DataTableCard } from './DataTableCard';
import { InlineMap } from './InlineMap';

// Renders an agent-composed layout (the `generative_ui` artifact) from a whitelisted
// block tree. Every block maps to a Primitive-Kit element or an existing card — there
// is NO raw-HTML escape hatch here (arbitrary HTML stays in the iframe-sandboxed code
// path). The tree is normalized BEFORE render: unknown blocks are dropped, props are
// coerced/bounded, image sources are allowlisted, and depth/total-node caps stop
// pathological or hostile trees. So this component never throws on bad model output.

const MAX_DEPTH = 6;
const MAX_NODES = 200;

// ---- normalized tree (adds an internal placeholder kind the public union lacks) ----
type NormBlock = NormalizedUIBlock | { kind: '_invalid' };
type NormalizedUIBlock =
  | { kind: 'stack'; gap: number; align: string; children: NormBlock[] }
  | { kind: 'row'; gap: number; align: string; wrap: boolean; children: NormBlock[] }
  | { kind: 'grid'; columns: number; gap: number; children: NormBlock[] }
  | { kind: 'section'; title?: string; accent?: string; children: NormBlock[] }
  | { kind: 'divider' }
  | { kind: 'heading'; text: string; level: number }
  | { kind: 'text'; text: string; tone: string; align: string }
  | { kind: 'badge'; text: string; tone: string }
  | { kind: 'pill'; label?: string; change?: number; changePercent?: number }
  | { kind: 'keyValue'; items: { label: string; value: string }[] }
  | { kind: 'callout'; tone: string; title?: string; text: string }
  | { kind: 'image'; src: string; alt?: string; caption?: string; ratio: string }
  | { kind: 'progress'; value: number; max: number; label?: string; color?: string }
  | { kind: 'metric'; label: string; value: string | number; unit?: string; delta?: number; deltaPercent?: number; spark?: number[] }
  | { kind: 'sparkline'; values: number[]; color?: string }
  | { kind: 'timeline'; items: { title: string; time?: string; text?: string; accent?: string }[] }
  | { kind: 'rating'; value: number; max: number; count?: number; label?: string }
  | { kind: 'tags'; items: string[] }
  | { kind: 'gauge'; value: number; max: number; label?: string; unit?: string; color?: string }
  | { kind: 'bars'; items: { label: string; value: number; color?: string }[]; max?: number }
  | { kind: 'steps'; items: { title: string; text?: string }[] }
  | { kind: 'quote'; text: string; author?: string }
  | { kind: 'map'; markers: { lat: number; lng: number; label: string; category?: string; color?: string }[]; connect: boolean }
  | { kind: 'chart'; chart: ChartArtifact }
  | { kind: 'table'; table: DataTableArtifact };

export interface NormalizedGenerativeUI {
  title?: string;
  subtitle?: string;
  accent?: string;
  palette?: string;
  root: NormBlock;
}

// ---- coercion helpers (treat all model output as untrusted) ----
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = 4000): string | undefined => (typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const oneOf = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback);
const clampInt = (v: unknown, lo: number, hi: number, fallback: number): number => {
  const n = num(v);
  return n === undefined ? fallback : Math.max(lo, Math.min(hi, Math.round(n)));
};
const numArray = (v: unknown, max = 200): number[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.map(num).filter((n): n is number => n !== undefined).slice(0, max);
  return out.length ? out : undefined;
};
// Only allow https images and inline image data URIs — never javascript:, data:text/html, etc.
const safeSrc = (v: unknown): string | undefined => {
  const s = str(v, 8000);
  if (!s) return undefined;
  return /^https:\/\//i.test(s) || /^data:image\//i.test(s) ? s : undefined;
};

const ALIGNS = ['start', 'center', 'end', 'stretch', 'baseline'] as const;
const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
const TONES = ['neutral', 'good', 'warn', 'bad', 'info'] as const;
const CALLOUT_TONES = ['info', 'good', 'warn', 'bad'] as const;
const TEXT_TONES = ['default', 'muted', 'strong'] as const;
const RATIOS = ['1:1', '4:3', '16:9'] as const;

const normChildren = (v: unknown, depth: number, ctx: { n: number }): NormBlock[] => {
  if (!Array.isArray(v)) return [];
  const out: NormBlock[] = [];
  for (const child of v) {
    if (ctx.n >= MAX_NODES) break;
    const nb = normBlock(child, depth + 1, ctx);
    if (nb) out.push(nb);
  }
  return out;
};

function normBlock(raw: unknown, depth: number, ctx: { n: number }): NormBlock | null {
  if (depth > MAX_DEPTH || ctx.n >= MAX_NODES) return null;
  if (!isObj(raw) || typeof raw.kind !== 'string') return null;
  ctx.n += 1;
  const kind = raw.kind;
  switch (kind) {
    case 'stack':
      return { kind, gap: clampInt(raw.gap, 0, 4, 2), align: oneOf(raw.align, ALIGNS, 'stretch'), children: normChildren(raw.children, depth, ctx) };
    case 'row':
      return { kind, gap: clampInt(raw.gap, 0, 4, 2), align: oneOf(raw.align, ALIGNS, 'center'), wrap: raw.wrap !== false, children: normChildren(raw.children, depth, ctx) };
    case 'grid':
      return { kind, columns: clampInt(raw.columns, 1, 4, 2), gap: clampInt(raw.gap, 0, 4, 2), children: normChildren(raw.children, depth, ctx) };
    case 'section':
      return { kind, title: str(raw.title, 200), accent: str(raw.accent, 16), children: normChildren(raw.children, depth, ctx) };
    case 'divider':
      return { kind };
    case 'heading': {
      const text = str(raw.text, 400);
      return text ? { kind, text, level: clampInt(raw.level, 1, 3, 2) } : { kind: '_invalid' };
    }
    case 'text': {
      const text = str(raw.text, 8000);
      return text ? { kind, text, tone: oneOf(raw.tone, TEXT_TONES, 'default'), align: oneOf(raw.align, TEXT_ALIGNS, 'left') } : { kind: '_invalid' };
    }
    case 'badge': {
      const text = str(raw.text, 80);
      return text ? { kind, text, tone: oneOf(raw.tone, TONES, 'neutral') } : { kind: '_invalid' };
    }
    case 'pill':
      return { kind, label: str(raw.label, 80), change: num(raw.change), changePercent: num(raw.changePercent) };
    case 'keyValue': {
      const items = Array.isArray(raw.items)
        ? raw.items
            .filter(isObj)
            .map((it) => ({ label: str(it.label, 200) ?? '', value: str(it.value, 400) ?? '' }))
            .filter((it) => it.label || it.value)
            .slice(0, 50)
        : [];
      return items.length ? { kind, items } : { kind: '_invalid' };
    }
    case 'callout': {
      const text = str(raw.text, 4000);
      return text ? { kind, tone: oneOf(raw.tone, CALLOUT_TONES, 'info'), title: str(raw.title, 200), text } : { kind: '_invalid' };
    }
    case 'image': {
      const src = safeSrc(raw.src);
      return src ? { kind, src, alt: str(raw.alt, 200), caption: str(raw.caption, 400), ratio: oneOf(raw.ratio, RATIOS, '16:9') } : { kind: '_invalid' };
    }
    case 'progress': {
      const value = num(raw.value);
      return value === undefined ? { kind: '_invalid' } : { kind, value, max: num(raw.max) ?? 100, label: str(raw.label, 200), color: str(raw.color, 16) };
    }
    case 'metric': {
      const label = str(raw.label, 200);
      const value = typeof raw.value === 'number' ? raw.value : str(raw.value, 80);
      return label && value !== undefined
        ? { kind, label, value, unit: str(raw.unit, 24), delta: num(raw.delta), deltaPercent: num(raw.deltaPercent), spark: numArray(raw.spark) }
        : { kind: '_invalid' };
    }
    case 'sparkline': {
      const values = numArray(raw.values);
      return values && values.length > 1 ? { kind, values, color: str(raw.color, 16) } : { kind: '_invalid' };
    }
    case 'timeline': {
      const items = Array.isArray(raw.items)
        ? raw.items
            .filter(isObj)
            .map((it) => ({ title: str(it.title, 200) ?? '', time: str(it.time, 80), text: str(it.text, 1000), accent: str(it.accent, 16) }))
            .filter((it) => it.title || it.text)
            .slice(0, 40)
        : [];
      return items.length ? { kind, items } : { kind: '_invalid' };
    }
    case 'rating': {
      const value = num(raw.value);
      return value === undefined ? { kind: '_invalid' } : { kind, value: Math.max(0, value), max: clampInt(raw.max, 1, 10, 5), count: num(raw.count), label: str(raw.label, 80) };
    }
    case 'tags': {
      const items = Array.isArray(raw.items) ? raw.items.map((t) => str(t, 60)).filter((t): t is string => !!t).slice(0, 40) : [];
      return items.length ? { kind, items } : { kind: '_invalid' };
    }
    case 'gauge': {
      const value = num(raw.value);
      return value === undefined ? { kind: '_invalid' } : { kind, value, max: num(raw.max) ?? 100, label: str(raw.label, 80), unit: str(raw.unit, 24), color: str(raw.color, 16) };
    }
    case 'bars': {
      const items = Array.isArray(raw.items)
        ? raw.items
            .filter(isObj)
            .map((it) => ({ label: str(it.label, 120) ?? '', value: num(it.value) ?? 0, color: str(it.color, 16) }))
            .filter((it) => it.label)
            .slice(0, 40)
        : [];
      return items.length ? { kind, items, max: num(raw.max) } : { kind: '_invalid' };
    }
    case 'steps': {
      const items = Array.isArray(raw.items)
        ? raw.items
            .filter(isObj)
            .map((it) => ({ title: str(it.title, 200) ?? '', text: str(it.text, 1000) }))
            .filter((it) => it.title || it.text)
            .slice(0, 30)
        : [];
      return items.length ? { kind, items } : { kind: '_invalid' };
    }
    case 'quote': {
      const text = str(raw.text, 2000);
      return text ? { kind, text, author: str(raw.author, 120) } : { kind: '_invalid' };
    }
    case 'map': {
      const markers = Array.isArray(raw.markers)
        ? raw.markers
            .filter(isObj)
            .map((m) => ({ lat: num(m.lat), lng: num(m.lng), label: str(m.label, 120) ?? '', category: str(m.category, 40), color: str(m.color, 16) }))
            .filter((m) => m.lat !== undefined && m.lng !== undefined)
            .map((m) => ({ lat: m.lat as number, lng: m.lng as number, label: m.label, category: m.category, color: m.color }))
            .slice(0, 40)
        : [];
      return markers.length ? { kind, markers, connect: raw.connect === true } : { kind: '_invalid' };
    }
    case 'chart':
      return isObj(raw.chart) && Array.isArray((raw.chart as Record<string, unknown>).series)
        ? { kind, chart: raw.chart as unknown as ChartArtifact }
        : { kind: '_invalid' };
    case 'table':
      return isObj(raw.table) && Array.isArray((raw.table as Record<string, unknown>).columns)
        ? { kind, table: raw.table as unknown as DataTableArtifact }
        : { kind: '_invalid' };
    default:
      return { kind: '_invalid' };
  }
}

/** Validate + bound an untrusted `generative_ui` payload into a render-safe tree. */
export function normalizeGenerativeUI(raw: unknown): NormalizedGenerativeUI | null {
  if (!isObj(raw)) return null;
  const ctx = { n: 0 };
  const root = normBlock(raw.root, 0, ctx);
  if (!root || root.kind === '_invalid') return null;
  return {
    title: str(raw.title, 200),
    subtitle: str(raw.subtitle, 400),
    accent: str(raw.accent, 16),
    palette: str(raw.palette, 24),
    root
  };
}

// ---- rendering ----
const GAP: Record<number, string> = { 0: 'gap-0', 1: 'gap-1', 2: 'gap-2', 3: 'gap-3', 4: 'gap-4' };
const ALIGN: Record<string, string> = { start: 'items-start', center: 'items-center', end: 'items-end', stretch: 'items-stretch', baseline: 'items-baseline' };
const COLS: Record<number, string> = { 1: 'sm:grid-cols-1', 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-4' };
const RATIO: Record<string, string> = { '1:1': 'aspect-square', '4:3': 'aspect-[4/3]', '16:9': 'aspect-video' };
const TONE_COLOR: Record<string, string> = { neutral: 'var(--ds-muted)', good: '#059669', warn: '#d97706', bad: '#dc2626', info: '#3B82F6' };
const HEADING: Record<number, string> = { 1: 'text-lg', 2: 'text-base', 3: 'text-sm' };
const TEXT_TONE: Record<string, string> = { default: 'text-[var(--ds-ink)]', muted: 'text-[var(--ds-muted)]', strong: 'text-[var(--ds-ink)] font-semibold' };
const TEXT_ALIGN: Record<string, string> = { left: 'text-left', center: 'text-center', right: 'text-right' };

const formatMetric = (v: string | number): string =>
  typeof v !== 'number' ? v : Math.abs(v) >= 1_000_000 ? compactNumber(v) : v.toLocaleString();

const Block: React.FC<{ block: NormBlock }> = ({ block }) => {
  switch (block.kind) {
    case '_invalid':
      return <span className="inline-block rounded-md bg-[var(--ds-well-strong)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--ds-muted)]">unsupported block</span>;

    case 'stack':
      return (
        <div className={`flex flex-col ${GAP[block.gap]} ${ALIGN[block.align]}`}>
          {block.children.map((c, i) => <Staggered key={i} index={i}><Block block={c} /></Staggered>)}
        </div>
      );
    case 'row':
      return (
        <div className={`flex flex-row ${block.wrap ? 'flex-wrap' : ''} ${GAP[block.gap]} ${ALIGN[block.align]}`}>
          {block.children.map((c, i) => <Staggered key={i} index={i} className="min-w-0"><Block block={c} /></Staggered>)}
        </div>
      );
    case 'grid':
      return (
        <div className={`grid grid-cols-1 ${COLS[block.columns]} ${GAP[block.gap]}`}>
          {block.children.map((c, i) => <Staggered key={i} index={i} className="min-w-0"><Block block={c} /></Staggered>)}
        </div>
      );
    case 'section':
      return (
        <div className="rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] p-3">
          {block.title && (
            <div className="mb-2 flex items-center gap-2">
              {block.accent && <span className="h-3 w-1 rounded-full" style={{ backgroundColor: block.accent }} />}
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{block.title}</div>
            </div>
          )}
          <div className="flex flex-col gap-2">{block.children.map((c, i) => <Block key={i} block={c} />)}</div>
        </div>
      );
    case 'divider':
      return <hr className="border-t border-[var(--ds-hairline-soft)]" />;

    case 'heading':
      return <div className={`font-semibold tracking-tight text-[var(--ds-ink)] ${HEADING[block.level]}`}>{block.text}</div>;
    case 'text':
      return <p className={`text-sm ${TEXT_TONE[block.tone]} ${TEXT_ALIGN[block.align]} whitespace-pre-wrap break-words`}>{block.text}</p>;
    case 'badge':
      return <Badge color={TONE_COLOR[block.tone]}>{block.text}</Badge>;
    case 'pill':
      return (
        <span className="inline-flex items-center gap-1.5">
          {block.label && <span className="text-xs font-semibold text-[var(--ds-ink)]">{block.label}</span>}
          <TrendPill change={block.change} changePercent={block.changePercent} size="sm" />
        </span>
      );
    case 'keyValue':
      return (
        <dl className="divide-y divide-[var(--ds-hairline-soft)]">
          {block.items.map((it, i) => (
            <div key={i} className="flex items-baseline justify-between gap-3 py-1">
              <dt className="text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{it.label}</dt>
              <dd className="text-right text-sm font-semibold text-[var(--ds-ink)]">{it.value}</dd>
            </div>
          ))}
        </dl>
      );
    case 'callout': {
      const c = TONE_COLOR[block.tone];
      return (
        <div className="rounded-xl border-l-4 p-3" style={{ borderColor: c, backgroundColor: `${c}12` }}>
          {block.title && <div className="text-xs font-semibold" style={{ color: c }}>{block.title}</div>}
          <div className="text-sm text-[var(--ds-ink)] whitespace-pre-wrap break-words">{block.text}</div>
        </div>
      );
    }
    case 'image':
      return (
        <figure className="overflow-hidden rounded-xl border border-[var(--ds-hairline)]">
          <img src={block.src} alt={block.alt ?? ''} loading="lazy" className={`w-full object-cover ${RATIO[block.ratio]}`} />
          {block.caption && <figcaption className="bg-[var(--ds-well)] px-2 py-1 text-[11px] text-[var(--ds-muted)]">{block.caption}</figcaption>}
        </figure>
      );
    case 'progress': {
      const pct = Math.round((block.value / (block.max || 1)) * 100);
      return (
        <div>
          <div className="mb-1 flex items-baseline justify-between gap-2">
            {block.label && <span className="text-xs font-semibold text-[var(--ds-ink)]">{block.label}</span>}
            <span className="text-xs font-semibold text-[var(--ds-muted)] tabular-nums">{pct}%</span>
          </div>
          <LinearGauge value={block.value} max={block.max} color={block.color ?? '#3B82F6'} height={8} />
        </div>
      );
    }
    case 'metric': {
      const trend = typeof block.delta === 'number' ? block.delta : block.deltaPercent;
      const sparkColor = typeof trend === 'number' ? (trend >= 0 ? '#059669' : '#dc2626') : '#3B82F6';
      return (
        <div className="rounded-xl border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] p-3">
          <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{block.label}</div>
          <div className="mt-0.5 flex items-baseline gap-1">
            <span className="text-2xl font-semibold tracking-tight leading-none text-[var(--ds-ink)] tabular-nums">{formatMetric(block.value)}</span>
            {block.unit && <span className="text-xs font-medium text-[var(--ds-muted)]">{block.unit}</span>}
          </div>
          {(typeof block.delta === 'number' || typeof block.deltaPercent === 'number') && (
            <div className="mt-1"><TrendPill change={block.delta} changePercent={block.deltaPercent} size="sm" /></div>
          )}
          {block.spark && block.spark.length > 1 && (
            <div className="mt-2"><Sparkline values={block.spark} color={sparkColor} height={28} /></div>
          )}
        </div>
      );
    }
    case 'sparkline':
      return <Sparkline values={block.values} color={block.color ?? '#3B82F6'} height={40} />;
    case 'timeline':
      return (
        <ol className="relative ml-1 border-l border-[var(--ds-hairline)] pl-4">
          {block.items.map((it, i) => (
            <li key={i} className="relative pb-3 last:pb-0">
              <span
                className="absolute -left-[1.32rem] top-1 h-2.5 w-2.5 rounded-full border-2 border-[var(--ds-surface)]"
                style={{ backgroundColor: it.accent || 'var(--ds-accent)' }}
              />
              <div className="flex items-baseline justify-between gap-2">
                {it.title && <span className="text-sm font-semibold text-[var(--ds-ink)]">{it.title}</span>}
                {it.time && <span className="shrink-0 text-[10px] font-medium tabular-nums text-[var(--ds-muted)]">{it.time}</span>}
              </div>
              {it.text && <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-[var(--ds-muted)]">{it.text}</p>}
            </li>
          ))}
        </ol>
      );
    case 'rating': {
      const full = Math.round(block.value);
      return (
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-flex">
            {Array.from({ length: block.max }, (_, i) => (
              <Star key={i} className="h-3.5 w-3.5" style={{ color: i < full ? '#f59e0b' : 'var(--ds-faint)', fill: i < full ? '#f59e0b' : 'transparent' }} />
            ))}
          </span>
          <span className="text-xs font-semibold tabular-nums text-[var(--ds-ink)]">{block.value.toFixed(1)}</span>
          {typeof block.count === 'number' && <span className="text-[11px] text-[var(--ds-muted)]">({compactNumber(block.count)})</span>}
          {block.label && <span className="text-[11px] text-[var(--ds-muted)]">{block.label}</span>}
        </span>
      );
    }
    case 'tags':
      return (
        <div className="flex flex-wrap gap-1.5">
          {block.items.map((t, i) => (
            <span key={i} className="rounded-full border border-[var(--ds-hairline)] bg-[var(--ds-well)] px-2 py-0.5 text-[11px] font-medium text-[var(--ds-ink)]">
              {t}
            </span>
          ))}
        </div>
      );
    case 'gauge':
      return (
        <div className="flex justify-center">
          <RadialGauge value={block.value} max={block.max} label={block.label} unit={block.unit} color={block.color ?? '#3B82F6'} size={92} />
        </div>
      );
    case 'bars': {
      const max = block.max ?? Math.max(...block.items.map((b) => b.value), 1);
      return (
        <div className="flex flex-col gap-1.5">
          {block.items.map((b, i) => (
            <div key={i}>
              <div className="mb-0.5 flex items-baseline justify-between gap-2">
                <span className="truncate text-xs text-[var(--ds-ink)]">{b.label}</span>
                <span className="shrink-0 text-xs font-semibold tabular-nums text-[var(--ds-muted)]">{formatMetric(b.value)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-[var(--ds-well-strong)]">
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.max(2, Math.min(100, (b.value / (max || 1)) * 100))}%`, backgroundColor: b.color || 'var(--ds-accent)' }}
                />
              </div>
            </div>
          ))}
        </div>
      );
    }
    case 'steps':
      return (
        <ol className="flex flex-col gap-2">
          {block.items.map((it, i) => (
            <li key={i} className="flex gap-2.5">
              <span className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#D97757]/12 text-[11px] font-bold text-[var(--ds-accent)]">{i + 1}</span>
              <div className="min-w-0">
                {it.title && <div className="text-sm font-semibold text-[var(--ds-ink)]">{it.title}</div>}
                {it.text && <p className="whitespace-pre-wrap break-words text-xs text-[var(--ds-muted)]">{it.text}</p>}
              </div>
            </li>
          ))}
        </ol>
      );
    case 'quote':
      return (
        <blockquote className="rounded-r-xl border-l-2 border-[var(--ds-accent)] bg-[var(--ds-well)] px-3 py-2">
          <p className="whitespace-pre-wrap break-words text-sm italic text-[var(--ds-ink)]">“{block.text}”</p>
          {block.author && <footer className="mt-1 text-[11px] font-medium text-[var(--ds-muted)]">— {block.author}</footer>}
        </blockquote>
      );
    case 'map':
      return (
        <div className="overflow-hidden rounded-xl border border-[var(--ds-hairline)]">
          <InlineMap
            data={{ markers: block.markers, route: block.connect && block.markers.length > 1 ? block.markers.map((m) => ({ lat: m.lat, lng: m.lng })) : undefined }}
            height={200}
          />
        </div>
      );
    case 'chart':
      return <ChartCard data={block.chart} />;
    case 'table':
      return <DataTableCard data={block.table} />;
    default:
      return null;
  }
};

// A light, dependency-free staggered reveal that matches the house `animate-fade-in`
// style — direct children of a container fade in sequence so a composed layout feels
// "assembled" rather than popping in at once. Capped so deep lists don't lag.
const Staggered: React.FC<{ index: number; className?: string; children: React.ReactNode }> = ({ index, className, children }) => (
  <div className={`animate-fade-in ${className ?? ''}`} style={{ animationDelay: `${Math.min(index, 10) * 40}ms` }}>
    {children}
  </div>
);

export const GenerativeUICard: React.FC<{ data: GenerativeUIArtifact }> = ({ data }) => {
  const ui = normalizeGenerativeUI(data);
  if (!ui) return null;
  const header = ui.title ? (
    <div>
      <SurfaceTitle>{ui.title}</SurfaceTitle>
      {ui.subtitle && <SurfaceSubtitle>{ui.subtitle}</SurfaceSubtitle>}
    </div>
  ) : undefined;
  return (
    <Surface header={header} accent={ui.accent}>
      <div className="p-3">
        <Block block={ui.root} />
      </div>
    </Surface>
  );
};
