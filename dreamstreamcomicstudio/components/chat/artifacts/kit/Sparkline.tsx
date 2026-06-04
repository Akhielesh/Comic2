import React, { useId, useMemo } from 'react';
import { withAlpha } from './theme';

// Dependency-free mini line+area chart, extracted from the original StockCard so any
// card (KPI tiles, news trends, finance) can drop in a sparkline. No axes, no hover.

export const Sparkline: React.FC<{
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  fill?: boolean;
  className?: string;
}> = ({ values, color = '#3B82F6', width = 280, height = 48, fill = true, className }) => {
  const gradId = useId().replace(/:/g, '');
  const paths = useMemo(() => {
    if (!values || values.length < 2) return null;
    const pad = 2;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const stepX = (width - pad * 2) / (values.length - 1);
    const pts = values.map((v, i) => {
      const x = pad + i * stepX;
      const y = pad + (height - pad * 2) * (1 - (v - min) / span);
      return [x, y] as const;
    });
    const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;
    return { line, area };
  }, [values, width, height]);

  if (!paths) return null;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className={`w-full ${className ?? ''}`} style={{ height }}>
      {fill && (
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={withAlpha(color, 0.28)} />
            <stop offset="100%" stopColor={withAlpha(color, 0)} />
          </linearGradient>
        </defs>
      )}
      {fill && <path d={paths.area} fill={`url(#${gradId})`} />}
      <path d={paths.line} fill="none" stroke={color} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
};
