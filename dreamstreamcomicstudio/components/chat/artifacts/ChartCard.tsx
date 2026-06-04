import React, { useMemo, useState } from 'react';
import type { ChartArtifact, DataChartSeries } from '../../../apiTypes';
import { Surface, resolveTheme, withAlpha } from './kit';
import type { PaletteName } from './kit';

// The universal, schema-driven data-viz card. One artifact shape renders line, area,
// bar (plain / grouped / stacked), pie, donut and scatter — with a toggleable legend,
// hover tooltips, and axes. Dependency-free SVG so it adds nothing to the bundle and
// gives the model a structured way to visualize ANY data (not just markets).

const W = 560;
const fmt = (n: number, unit?: string): string => {
  const s = Math.abs(n) >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 1 }) : `${Math.round(n * 100) / 100}`;
  return unit ? `${s}${unit}` : s;
};

const niceLabel = (x: number | string): string => (typeof x === 'number' ? String(x) : x);

// Polar helper for pie/donut.
const arcPath = (cx: number, cy: number, r: number, a0: number, a1: number, inner = 0): string => {
  const p = (ang: number, rad: number) => [cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)];
  const [x0, y0] = p(a0, r);
  const [x1, y1] = p(a1, r);
  const large = a1 - a0 > Math.PI ? 1 : 0;
  if (inner <= 0) return `M${cx},${cy} L${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} Z`;
  const [ix1, iy1] = p(a1, inner);
  const [ix0, iy0] = p(a0, inner);
  return `M${x0},${y0} A${r},${r} 0 ${large} 1 ${x1},${y1} L${ix1},${iy1} A${inner},${inner} 0 ${large} 0 ${ix0},${iy0} Z`;
};

export const ChartCard: React.FC<{ data: ChartArtifact; embedded?: boolean }> = ({ data, embedded }) => {
  const theme = resolveTheme({ palette: (data.palette as PaletteName) || 'brand' });
  const colorOf = (s: DataChartSeries, i: number) => s.color || theme.series[i % theme.series.length];
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [hover, setHover] = useState<{ i: number; cat: number } | null>(null);

  const series = data.series ?? [];
  const visible = series.map((s, i) => ({ s, i })).filter(({ i }) => !hidden.has(i));
  const isRadial = data.variant === 'pie' || data.variant === 'donut';
  const isScatter = data.variant === 'scatter';
  const isStacked = data.variant === 'stacked-bar';
  const isBar = data.variant === 'bar' || data.variant === 'grouped-bar' || data.variant === 'stacked-bar';

  // Categories from the longest series (cartesian, non-scatter).
  const cats = useMemo(() => {
    const longest = series.reduce<DataChartSeries | null>((a, b) => (!a || b.points.length > a.points.length ? b : a), null);
    return (longest?.points ?? []).map((p) => niceLabel(p.x));
  }, [series]);

  const H = isRadial ? 240 : 220;

  // y-domain.
  const { yMin, yMax } = useMemo(() => {
    let lo = 0;
    let hi = 0;
    if (isStacked) {
      cats.forEach((_, ci) => {
        const sum = visible.reduce((acc, { s }) => acc + (s.points[ci]?.y ?? 0), 0);
        hi = Math.max(hi, sum);
      });
    } else {
      visible.forEach(({ s }) => s.points.forEach((p) => { hi = Math.max(hi, p.y); lo = Math.min(lo, p.y); }));
    }
    if (hi === lo) hi = lo + 1;
    return { yMin: lo, yMax: hi };
  }, [visible, cats, isStacked]);

  if (!series.length) return null;

  // --- Cartesian geometry ---
  const padL = 42;
  const padB = 28;
  const padT = 8;
  const padR = 12;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const yTo = (v: number) => padT + plotH * (1 - (v - yMin) / (yMax - yMin || 1));
  const ticks = 4;

  const Legend = (
    <div className="flex flex-wrap gap-x-3 gap-y-1 px-3 pt-1">
      {(isRadial ? (series[0]?.points ?? []).map((p) => niceLabel(p.x)) : series.map((s, i) => s.name || `Series ${i + 1}`)).map((name, i) => {
        const off = !isRadial && hidden.has(i);
        const col = isRadial ? theme.series[i % theme.series.length] : colorOf(series[i], i);
        return (
          <button
            key={i}
            onClick={() => !isRadial && setHidden((prev) => { const n = new Set(prev); n.has(i) ? n.delete(i) : n.add(i); return n; })}
            className={`flex items-center gap-1 text-[11px] font-bold transition-opacity ${off ? 'opacity-40' : ''} ${isRadial ? 'cursor-default' : ''}`}
          >
            <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: col }} />
            {name}
          </button>
        );
      })}
    </div>
  );

  return (
    <Surface
      embedded={embedded}
      accent={theme.accent}
      header={
        data.title ? (
          <div>
            <div className="text-sm font-extrabold">{data.title}</div>
            {data.subtitle && <div className="text-[11px] font-semibold text-slate-500">{data.subtitle}</div>}
          </div>
        ) : undefined
      }
    >
      {(series.length > 1 || isRadial) && Legend}

      <div className="relative px-2 pb-2 pt-1">
        {isRadial ? (
          // --- Pie / Donut ---
          (() => {
            const pts = series[0]?.points ?? [];
            const total = pts.reduce((a, p) => a + Math.max(0, p.y), 0) || 1;
            const cx = W / 2;
            const cy = H / 2;
            const r = Math.min(H, 260) / 2 - 16;
            let a = -Math.PI / 2;
            return (
              <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: H }}>
                {pts.map((p, i) => {
                  const frac = Math.max(0, p.y) / total;
                  const a0 = a;
                  const a1 = a + frac * Math.PI * 2;
                  a = a1;
                  const mid = (a0 + a1) / 2;
                  const isH = hover?.cat === i;
                  const ox = isH ? Math.cos(mid) * 6 : 0;
                  const oy = isH ? Math.sin(mid) * 6 : 0;
                  return (
                    <path
                      key={i}
                      d={arcPath(cx + ox, cy + oy, r, a0, a1, data.variant === 'donut' ? r * 0.58 : 0)}
                      fill={theme.series[i % theme.series.length]}
                      stroke="#fff"
                      strokeWidth="2"
                      onMouseEnter={() => setHover({ i: 0, cat: i })}
                      onMouseLeave={() => setHover(null)}
                    />
                  );
                })}
                {hover && pts[hover.cat] && (
                  <text x={cx} y={cy} textAnchor="middle" className="font-display" fontSize="18" fill="#0f172a">
                    {Math.round((Math.max(0, pts[hover.cat].y) / total) * 100)}%
                  </text>
                )}
              </svg>
            );
          })()
        ) : (
          // --- Cartesian (line / area / bar / scatter) ---
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: H }} onMouseLeave={() => setHover(null)}>
            {/* y gridlines + labels */}
            {Array.from({ length: ticks + 1 }).map((_, i) => {
              const v = yMin + ((yMax - yMin) * i) / ticks;
              const y = yTo(v);
              return (
                <g key={i}>
                  <line x1={padL} x2={W - padR} y1={y} y2={y} stroke="#e2e8f0" strokeWidth="1" />
                  <text x={padL - 4} y={y + 3} textAnchor="end" fontSize="9" fill="#94a3b8">{fmt(v, data.unit)}</text>
                </g>
              );
            })}

            {/* bars */}
            {isBar &&
              cats.map((cat, ci) => {
                const slot = plotW / cats.length;
                const groupX = padL + slot * ci;
                const inner = slot * 0.7;
                const n = visible.length || 1;
                let stackTop = yTo(0);
                return (
                  <g key={ci}>
                    <rect x={groupX} y={padT} width={slot} height={plotH} fill={hover?.cat === ci ? '#0f172a' : 'transparent'} fillOpacity={hover?.cat === ci ? 0.04 : 0} onMouseEnter={() => setHover({ i: 0, cat: ci })} />
                    {visible.map(({ s, i }, vi) => {
                      const val = s.points[ci]?.y ?? 0;
                      if (isStacked) {
                        const h = (plotH * val) / (yMax - yMin || 1);
                        const y = stackTop - h;
                        stackTop = y;
                        return <rect key={i} x={groupX + slot * 0.15} y={y} width={inner} height={Math.max(0, h)} fill={colorOf(s, i)} rx="1.5" />;
                      }
                      const bw = inner / n;
                      const y = yTo(val);
                      return <rect key={i} x={groupX + slot * 0.15 + bw * vi} y={y} width={Math.max(1, bw - 1)} height={Math.max(0, yTo(0) - y)} fill={colorOf(s, i)} rx="1.5" />;
                    })}
                  </g>
                );
              })}

            {/* area / line */}
            {!isBar && !isScatter &&
              visible.map(({ s, i }) => {
                const stepX = plotW / Math.max(1, (s.points.length - 1));
                const pts = s.points.map((p, pi) => [padL + pi * stepX, yTo(p.y)] as const);
                const line = pts.map(([x, y], pi) => `${pi === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
                const col = colorOf(s, i);
                return (
                  <g key={i}>
                    {data.variant === 'area' && <path d={`${line} L${pts[pts.length - 1][0]},${yTo(0)} L${pts[0][0]},${yTo(0)} Z`} fill={withAlpha(col, 0.18)} />}
                    <path d={line} fill="none" stroke={col} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" className="kit-draw-line" />
                    {pts.map(([x, y], pi) => <circle key={pi} cx={x} cy={y} r={hover?.cat === pi ? 3.5 : 0} fill={col} stroke="#fff" strokeWidth="1.5" />)}
                  </g>
                );
              })}

            {/* scatter */}
            {isScatter &&
              visible.map(({ s, i }) => {
                const xs = s.points.map((p) => Number(p.x));
                const xMin = Math.min(...xs);
                const xMax = Math.max(...xs) || xMin + 1;
                return s.points.map((p, pi) => {
                  const x = padL + plotW * ((Number(p.x) - xMin) / (xMax - xMin || 1));
                  return <circle key={`${i}-${pi}`} cx={x} cy={yTo(p.y)} r="4" fill={withAlpha(colorOf(s, i), 0.75)} stroke={colorOf(s, i)} />;
                });
              })}

            {/* x hover hit areas (line/area) + crosshair */}
            {!isBar && !isScatter &&
              cats.map((_, ci) => {
                const stepX = plotW / Math.max(1, cats.length - 1);
                const x = padL + ci * stepX;
                return <rect key={ci} x={x - stepX / 2} y={padT} width={stepX} height={plotH} fill="transparent" onMouseEnter={() => setHover({ i: 0, cat: ci })} />;
              })}
            {hover && !isScatter && !isBar && (
              <line x1={padL + (plotW / Math.max(1, cats.length - 1)) * hover.cat} x2={padL + (plotW / Math.max(1, cats.length - 1)) * hover.cat} y1={padT} y2={padT + plotH} stroke="#0f172a" strokeOpacity="0.2" strokeWidth="1" />
            )}

            {/* x labels */}
            {cats.map((cat, ci) => {
              if (cats.length > 12 && ci % Math.ceil(cats.length / 8) !== 0) return null;
              const x = isBar ? padL + (plotW / cats.length) * (ci + 0.5) : padL + (plotW / Math.max(1, cats.length - 1)) * ci;
              return <text key={ci} x={x} y={H - 10} textAnchor="middle" fontSize="9" fill="#64748b">{cat.length > 8 ? `${cat.slice(0, 7)}…` : cat}</text>;
            })}
          </svg>
        )}

        {/* Tooltip */}
        {hover && !isScatter && (
          <div className="pointer-events-none absolute left-1/2 top-1 -translate-x-1/2 rounded-md border-2 border-black bg-white px-2 py-1 text-[11px] shadow-comic-hover">
            <div className="font-bold text-slate-500">
              {isRadial ? niceLabel(series[0].points[hover.cat]?.x) : cats[hover.cat]}
            </div>
            {isRadial ? (
              <div className="font-extrabold">{fmt(series[0].points[hover.cat]?.y ?? 0, data.unit)}</div>
            ) : (
              visible.map(({ s, i }) => (
                <div key={i} className="flex items-center gap-1 font-semibold">
                  <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: colorOf(s, i) }} />
                  {s.name || `S${i + 1}`}: <span className="font-extrabold">{fmt(s.points[hover.cat]?.y ?? 0, data.unit)}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {(data.xLabel || data.yLabel) && (
        <div className="flex justify-between px-3 pb-2 text-[10px] font-bold uppercase tracking-wide text-slate-400">
          <span>{data.yLabel}</span>
          <span>{data.xLabel}</span>
        </div>
      )}
    </Surface>
  );
};
