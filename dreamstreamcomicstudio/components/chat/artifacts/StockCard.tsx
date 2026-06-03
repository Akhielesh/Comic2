import React, { useMemo } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { StockQuoteArtifact, StockPoint } from '../../../apiTypes';

// Build an SVG line + area path for the closing-price series. Dependency-free —
// no charting library, so it adds nothing to the bundle.
const buildPaths = (series: StockPoint[], w: number, h: number, pad = 2) => {
  if (series.length < 2) return null;
  const closes = series.map((p) => p.close);
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const stepX = (w - pad * 2) / (series.length - 1);
  const pts = closes.map((c, i) => {
    const x = pad + i * stepX;
    const y = pad + (h - pad * 2) * (1 - (c - min) / span);
    return [x, y] as const;
  });
  const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`;
  return { line, area };
};

const fmt = (n?: number): string =>
  typeof n === 'number'
    ? n.toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 })
    : '—';

const fmtVol = (n?: number): string | undefined => {
  if (typeof n !== 'number' || n <= 0) return undefined;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
};

export const StockCard: React.FC<{ data: StockQuoteArtifact }> = ({ data }) => {
  const up = data.change > 0;
  const down = data.change < 0;
  const accent = up ? 'text-emerald-600' : down ? 'text-red-600' : 'text-slate-500';
  const stroke = up ? '#059669' : down ? '#dc2626' : '#64748b';
  const W = 280;
  const H = 64;
  const paths = useMemo(() => (data.series ? buildPaths(data.series, W, H) : null), [data.series]);
  const Icon = up ? TrendingUp : down ? TrendingDown : Minus;
  const gradId = `sg-${data.symbol.replace(/[^a-z0-9]/gi, '')}`;

  const vol = fmtVol(data.volume);
  const stats: [string, string | undefined][] = [
    ['Open', data.open !== undefined ? fmt(data.open) : undefined],
    ['High', data.high !== undefined ? fmt(data.high) : undefined],
    ['Low', data.low !== undefined ? fmt(data.low) : undefined],
    ['Prev', data.previousClose !== undefined ? fmt(data.previousClose) : undefined],
    ['Vol', vol]
  ];

  return (
    <div className="my-2 border-2 border-black rounded-xl bg-white shadow-comic overflow-hidden animate-fade-in">
      <div className="flex items-start justify-between p-3 pb-1">
        <div className="min-w-0">
          <div className="text-sm font-extrabold truncate">{data.name || data.symbol}</div>
          <div className="text-[11px] text-slate-500 font-semibold">{data.symbol}{data.asOf ? ` · ${data.asOf}` : ''}</div>
        </div>
        <div className="text-right shrink-0 ml-2">
          <div className="text-xl font-display leading-none">{fmt(data.price)}</div>
          <div className={`text-[12px] font-bold flex items-center gap-0.5 justify-end ${accent}`}>
            <Icon className="w-3.5 h-3.5" />
            {data.change >= 0 ? '+' : ''}{fmt(data.change)} ({data.changePercent >= 0 ? '+' : ''}{data.changePercent.toFixed(2)}%)
          </div>
        </div>
      </div>

      {paths && (
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-16 px-1">
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
              <stop offset="100%" stopColor={stroke} stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={paths.area} fill={`url(#${gradId})`} />
          <path d={paths.line} fill="none" stroke={stroke} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
        </svg>
      )}

      <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 py-2 border-t-2 border-black/10 text-[11px]">
        {stats.filter(([, v]) => v).map(([label, v]) => (
          <span key={label} className="text-slate-500">
            {label} <span className="font-bold text-slate-800">{v}</span>
          </span>
        ))}
      </div>
    </div>
  );
};
