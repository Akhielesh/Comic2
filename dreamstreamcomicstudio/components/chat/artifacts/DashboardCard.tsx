// DashboardCard — the customizable glass widget board ("build me a dashboard for X").
//
// macOS-glass treatment: frosted translucent cards (backdrop-blur + hairline borders +
// soft inner highlight) floating over a slow aurora gradient. Widgets are LIVE (clock,
// countdown), draggable (HTML5 DnD — drop a card on another to swap; order persists per
// dashboard in localStorage), and dependency-free: charts ride the artifact kit, the
// globe is an inline-SVG orthographic projection with great-circle-ish arcs.

import React, { useEffect, useMemo, useState } from 'react';
import { GripVertical, Clock, Hourglass, ListChecks, Globe2, StickyNote, Link2, RotateCcw } from 'lucide-react';
import type { DashboardArtifact, DashboardWidget, DashboardGlobePoint } from '../../../apiTypes';
import { Chart, Sparkline, TrendPill, RadialGauge, safeHref } from './kit';

const STORAGE_PREFIX = 'ds_dashboard_layout:';

const layoutKey = (d: DashboardArtifact): string =>
  STORAGE_PREFIX + `${d.title}:${d.widgets.map((w) => w.id).sort().join(',')}`.slice(0, 180);

const loadOrder = (key: string): string[] | null => {
  try {
    const raw = window.localStorage.getItem(key);
    const arr = raw ? (JSON.parse(raw) as unknown) : null;
    return Array.isArray(arr) && arr.every((x) => typeof x === 'string') ? (arr as string[]) : null;
  } catch { return null; }
};
const saveOrder = (key: string, order: string[]): void => {
  try { window.localStorage.setItem(key, JSON.stringify(order)); } catch { /* private mode */ }
};

// ---------- live widgets ----------

const useNow = (tickMs: number): Date => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), tickMs);
    return () => clearInterval(t);
  }, [tickMs]);
  return now;
};

const ClockWidget: React.FC<{ w: DashboardWidget }> = ({ w }) => {
  const now = useNow(1000);
  const zones = w.timeZones?.length ? w.timeZones : [{ label: 'Local', tz: Intl.DateTimeFormat().resolvedOptions().timeZone }];
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-2">
      {zones.slice(0, 4).map((z) => {
        let time = '—'; let date = '';
        try {
          time = now.toLocaleTimeString('en-US', { timeZone: z.tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
          date = now.toLocaleDateString('en-US', { timeZone: z.tz, weekday: 'short', month: 'short', day: 'numeric' });
        } catch { /* bad tz from the model — show a dash */ }
        return (
          <div key={z.label}>
            <div className="text-[28px] font-semibold tabular-nums leading-none tracking-tight">{time}</div>
            <div className="text-[11px] text-[var(--ds-muted)] mt-1">{z.label} · {date}</div>
          </div>
        );
      })}
    </div>
  );
};

const pad2 = (n: number) => String(Math.max(0, n)).padStart(2, '0');

const CountdownWidget: React.FC<{ w: DashboardWidget }> = ({ w }) => {
  const now = useNow(1000);
  const target = w.target ? new Date(w.target) : null;
  if (!target || Number.isNaN(target.getTime())) return <div className="text-sm text-[var(--ds-muted)]">No target date.</div>;
  const ms = target.getTime() - now.getTime();
  const past = ms <= 0;
  const s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (
    <div>
      <div className="flex items-baseline gap-2 tabular-nums">
        {d > 0 && <span className="text-[26px] font-semibold">{d}<span className="text-[12px] text-[var(--ds-muted)] ml-0.5">d</span></span>}
        <span className="text-[26px] font-semibold">{pad2(h)}<span className="text-[12px] text-[var(--ds-muted)] ml-0.5">h</span></span>
        <span className="text-[26px] font-semibold">{pad2(m)}<span className="text-[12px] text-[var(--ds-muted)] ml-0.5">m</span></span>
        <span className="text-[26px] font-semibold">{pad2(sec)}<span className="text-[12px] text-[var(--ds-muted)] ml-0.5">s</span></span>
      </div>
      <div className="text-[11px] text-[var(--ds-muted)] mt-1">
        {past ? 'since ' : 'until '}{target.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>
  );
};

const StatWidget: React.FC<{ w: DashboardWidget }> = ({ w }) => (
  <div>
    <div className="flex items-baseline gap-1.5">
      <span className="text-[30px] font-semibold tabular-nums leading-none tracking-tight">{w.value ?? '—'}</span>
      {w.unit && <span className="text-[13px] text-[var(--ds-muted)]">{w.unit}</span>}
      {(w.delta != null || w.deltaPercent != null) && <TrendPill change={w.delta} changePercent={w.deltaPercent} />}
    </div>
    {Array.isArray(w.spark) && w.spark.length > 1 && (
      <div className="mt-2"><Sparkline values={w.spark} width={180} height={36} /></div>
    )}
  </div>
);

const ListWidget: React.FC<{ w: DashboardWidget }> = ({ w }) => {
  const [done, setDone] = useState<Set<number>>(() => new Set((w.items ?? []).flatMap((it, i) => (it.done ? [i] : []))));
  const toggle = (i: number) => setDone((p) => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n; });
  return (
    <ul className="space-y-1.5">
      {(w.items ?? []).slice(0, 10).map((it, i) => (
        <li key={i} className="flex items-start gap-2 text-[13px] leading-snug">
          <button
            onClick={() => toggle(i)}
            aria-label={done.has(i) ? 'Mark not done' : 'Mark done'}
            className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full border transition-colors ${done.has(i) ? 'bg-emerald-500 border-emerald-500' : 'border-[var(--ds-faint)] hover:border-emerald-500'}`}
          />
          <span className={done.has(i) ? 'line-through text-[var(--ds-muted)]' : ''}>{it.text}</span>
          {it.meta && <span className="ml-auto text-[11px] text-[var(--ds-muted)] shrink-0 tabular-nums">{it.meta}</span>}
        </li>
      ))}
    </ul>
  );
};

// ---------- minimalist globe (orthographic projection, pure SVG) ----------

const project = (lat: number, lon: number, r: number, cx: number, cy: number): { x: number; y: number; front: boolean } => {
  const la = (lat * Math.PI) / 180;
  const lo = (lon * Math.PI) / 180;
  // Center the view on the mean longitude of the points (set by caller via rotation).
  return { x: cx + r * Math.cos(la) * Math.sin(lo), y: cy - r * Math.sin(la), front: Math.cos(la) * Math.cos(lo) >= 0 };
};

const GlobeWidget: React.FC<{ w: DashboardWidget }> = ({ w }) => {
  const pts = (w.globePoints ?? []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)).slice(0, 12);
  const size = 190, cx = size / 2, cy = size / 2, r = size / 2 - 8;
  // Rotate so the mean point longitude faces the viewer.
  const meanLon = pts.length ? pts.reduce((s, p) => s + p.lon, 0) / pts.length : 0;
  const shifted = pts.map((p) => ({ ...p, lon: p.lon - meanLon }));
  const byLabel = new Map<string, DashboardGlobePoint>(shifted.map((p) => [p.label, p]));
  const arcs = (w.globeArcs ?? [])
    .map(([a, b]) => [byLabel.get(a), byLabel.get(b)] as const)
    .filter((x): x is readonly [DashboardGlobePoint, DashboardGlobePoint] => Boolean(x[0] && x[1]));

  return (
    <div className="flex items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0" aria-label="Globe">
        <defs>
          <radialGradient id="ds-globe-sheen" cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#dbeafe" />
            <stop offset="100%" stopColor="#93c5fd" />
          </radialGradient>
        </defs>
        <circle cx={cx} cy={cy} r={r} fill="url(#ds-globe-sheen)" stroke="#1e3a5f" strokeOpacity="0.35" />
        {/* graticule: meridians + parallels for the minimalist wireframe look */}
        {[-60, -30, 0, 30, 60].map((lat) => {
          const y = cy - r * Math.sin((lat * Math.PI) / 180);
          const rx = r * Math.cos((lat * Math.PI) / 180);
          return <ellipse key={`p${lat}`} cx={cx} cy={y} rx={rx} ry={rx * 0.16} fill="none" stroke="#1e3a5f" strokeOpacity="0.14" />;
        })}
        {[-60, -30, 0, 30, 60].map((lon) => (
          <ellipse key={`m${lon}`} cx={cx} cy={cy} rx={Math.abs(r * Math.sin((lon * Math.PI) / 180)) || 0.5} ry={r} fill="none" stroke="#1e3a5f" strokeOpacity="0.14" />
        ))}
        {/* great-circle-ish arcs (quadratic bezier lifted toward the rim) */}
        {arcs.map(([a, b], i) => {
          const pa = project(a.lat, a.lon, r, cx, cy);
          const pb = project(b.lat, b.lon, r, cx, cy);
          if (!pa.front && !pb.front) return null;
          const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2;
          const dx = mx - cx, dy = my - cy;
          const d = Math.hypot(dx, dy) || 1;
          const lift = Math.min(28, Math.hypot(pb.x - pa.x, pb.y - pa.y) * 0.25);
          const qx = mx + (dx / d) * lift, qy = my + (dy / d) * lift;
          return <path key={i} d={`M ${pa.x} ${pa.y} Q ${qx} ${qy} ${pb.x} ${pb.y}`} fill="none" stroke="#2563eb" strokeWidth="1.6" strokeDasharray="4 3" strokeLinecap="round" />;
        })}
        {shifted.map((p) => {
          const pt = project(p.lat, p.lon, r, cx, cy);
          return (
            <g key={p.label} opacity={pt.front ? 1 : 0.25}>
              <circle cx={pt.x} cy={pt.y} r="3.4" fill="#1d4ed8" stroke="#fff" strokeWidth="1.2" />
            </g>
          );
        })}
      </svg>
      <ul className="min-w-0 space-y-1">
        {pts.map((p) => (
          <li key={p.label} className="text-[12px] flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-blue-600 shrink-0" />
            <span className="truncate">{p.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

const LinksWidget: React.FC<{ w: DashboardWidget }> = ({ w }) => (
  <ul className="space-y-1.5">
    {(w.links ?? []).slice(0, 8).map((l, i) => (
      <li key={i}>
        <a href={safeHref(l.url) ?? '#'} target="_blank" rel="noopener noreferrer" className="text-[13px] text-blue-700 hover:underline inline-flex items-center gap-1.5">
          <Link2 className="w-3 h-3 shrink-0" />{l.label}
        </a>
      </li>
    ))}
  </ul>
);

// ---------- widget shell + board ----------

const KIND_ICON: Partial<Record<string, React.FC<{ className?: string }>>> = {
  clock: Clock, countdown: Hourglass, list: ListChecks, globe: Globe2, note: StickyNote, links: Link2
};

const spanClass = (w: DashboardWidget): string =>
  w.size === 'lg' ? 'sm:col-span-2 lg:col-span-3' : w.size === 'md' ? 'sm:col-span-2' : '';

const WidgetBody: React.FC<{ w: DashboardWidget }> = ({ w }) => {
  switch (w.kind) {
    case 'clock': return <ClockWidget w={w} />;
    case 'countdown': return <CountdownWidget w={w} />;
    case 'stat': return <StatWidget w={w} />;
    case 'progress': {
      const p = w.progress;
      if (!p || !Number.isFinite(p.value) || !Number.isFinite(p.max) || p.max <= 0) return <div className="text-sm text-[var(--ds-muted)]">No progress data.</div>;
      return (
        <div className="flex items-center gap-3">
          <RadialGauge value={p.value} max={p.max} size={72} />
          <div className="text-[13px] text-[var(--ds-muted)]">{p.label ?? `${Math.round((p.value / p.max) * 100)}% of ${p.max}`}</div>
        </div>
      );
    }
    case 'chart': {
      const pts = (w.points ?? []).filter((p) => Number.isFinite(p.y));
      if (pts.length < 2) return <div className="text-sm text-[var(--ds-muted)]">Not enough data to chart.</div>;
      return <Chart points={pts.map((p) => ({ label: String(p.x), value: p.y }))} variant={w.chartVariant === 'line' ? 'line' : 'area'} color="#3B82F6" height={120} />;
    }
    case 'list': return <ListWidget w={w} />;
    case 'globe': return <GlobeWidget w={w} />;
    case 'links': return <LinksWidget w={w} />;
    case 'note':
    default:
      return <p className="text-[13px] leading-relaxed whitespace-pre-wrap">{w.text ?? ''}</p>;
  }
};

export const DashboardCard: React.FC<{ data: DashboardArtifact }> = ({ data }) => {
  const widgets = useMemo(() => (Array.isArray(data.widgets) ? data.widgets.filter((w) => w && w.id && w.kind) : []), [data.widgets]);
  const key = useMemo(() => layoutKey(data), [data]);
  const [order, setOrder] = useState<string[]>(() => {
    const saved = loadOrder(key);
    const ids = widgets.map((w) => w.id);
    return saved && saved.length === ids.length && saved.every((id) => ids.includes(id)) ? saved : ids;
  });
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const ordered = useMemo(() => {
    const byId = new Map(widgets.map((w) => [w.id, w]));
    return order.map((id) => byId.get(id)).filter((w): w is DashboardWidget => Boolean(w));
  }, [order, widgets]);

  const swap = (a: string, b: string) => {
    if (a === b) return;
    setOrder((prev) => {
      const next = [...prev];
      const ia = next.indexOf(a), ib = next.indexOf(b);
      if (ia < 0 || ib < 0) return prev;
      next.splice(ia, 1);
      next.splice(ib, 0, a);
      saveOrder(key, next);
      return next;
    });
  };
  const customized = order.join() !== widgets.map((w) => w.id).join();

  if (!widgets.length) return null;

  return (
    <div className="my-2 animate-fade-in relative overflow-hidden rounded-2xl border border-[var(--ds-hairline)] shadow-[0_1px_2px_rgba(0,0,0,0.04),0_8px_24px_var(--ds-hairline)]">
      {/* aurora backdrop — slow, GPU-cheap, behind everything */}
      <div className="absolute inset-0 bg-gradient-to-br from-sky-100 via-indigo-50 to-rose-100" aria-hidden />
      <div className="absolute -top-20 -left-16 h-64 w-64 rounded-full bg-sky-300/40 blur-3xl" aria-hidden />
      <div className="absolute -bottom-24 -right-10 h-72 w-72 rounded-full bg-fuchsia-300/30 blur-3xl" aria-hidden />

      <div className="relative p-4">
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold tracking-tight text-[var(--ds-ink)] leading-tight">{data.title}</h3>
            {data.subtitle && <p className="text-[11px] text-[var(--ds-muted)] mt-0.5">{data.subtitle}</p>}
          </div>
          {customized && (
            <button
              onClick={() => { setOrder(widgets.map((w) => w.id)); saveOrder(key, widgets.map((w) => w.id)); }}
              className="shrink-0 inline-flex items-center gap-1 text-[11px] font-semibold text-[var(--ds-ink)] px-2 py-1 rounded-lg border border-[var(--ds-hairline)] bg-[var(--ds-surface-soft)] backdrop-blur transition-colors duration-200 hover:bg-[var(--ds-surface-strong)]"
              title="Reset to the original layout"
            >
              <RotateCcw className="w-3 h-3" /> Reset layout
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {ordered.map((w) => {
            const Icon = KIND_ICON[w.kind];
            return (
              <section
                key={w.id}
                draggable
                onDragStart={(e) => { setDragId(w.id); e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={(e) => { e.preventDefault(); setOverId(w.id); }}
                onDragLeave={() => setOverId((o) => (o === w.id ? null : o))}
                onDrop={(e) => { e.preventDefault(); if (dragId) swap(dragId, w.id); setDragId(null); setOverId(null); }}
                onDragEnd={() => { setDragId(null); setOverId(null); }}
                className={`group rounded-xl border border-white/70 bg-white/55 backdrop-blur-md shadow-[inset_0_1px_0_rgba(255,255,255,0.8),0_4px_16px_rgba(15,23,42,0.08)] p-3 transition-all duration-200 ${spanClass(w)} ${dragId === w.id ? 'opacity-50 scale-[0.98]' : ''} ${overId === w.id && dragId && dragId !== w.id ? 'ring-2 ring-blue-400 ring-offset-1' : ''}`}
              >
                <header className="flex items-center gap-1.5 mb-2 text-[var(--ds-muted)]">
                  {Icon && <Icon className="w-3.5 h-3.5" />}
                  <span className="text-[10px] font-semibold uppercase tracking-wider truncate">{w.title ?? w.kind}</span>
                  <GripVertical className="w-3.5 h-3.5 ml-auto text-[var(--ds-faint)] group-hover:text-[var(--ds-faint)] cursor-grab" aria-label="Drag to rearrange" />
                </header>
                <WidgetBody w={w} />
              </section>
            );
          })}
        </div>
        <p className="mt-2 text-[10px] text-[var(--ds-muted)]">Drag any card to rearrange — your layout is remembered on this device.</p>
      </div>
    </div>
  );
};
