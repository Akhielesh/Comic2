import React, { useId } from 'react';
import { useMountFlag } from './motion';

// Dependency-free SVG data-viz gauges shared across cards (weather UV/AQI/humidity/
// pressure, KPI tiles, etc.). All themeable via a color or color-band function and
// sized by a single prop. Respect prefers-reduced-motion through the kit-draw class.

const POLAR = (cx: number, cy: number, r: number, deg: number) => {
  const rad = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)] as const;
};

/** A 270° radial gauge with a value arc, centered readout and caption. */
export const RadialGauge: React.FC<{
  value: number;
  max: number;
  min?: number;
  label?: string;
  unit?: string;
  display?: string;
  color?: string;
  track?: string;
  size?: number;
}> = ({ value, max, min = 0, label, unit, display, color = '#3B82F6', track = 'var(--ds-hairline)', size = 76 }) => {
  const r = size / 2 - 7;
  const cx = size / 2;
  const cy = size / 2;
  const C = 2 * Math.PI * r;
  const arc = 0.75; // 270°
  const frac = Math.max(0, Math.min(1, (value - min) / (max - min || 1)));
  return (
    <div className="flex flex-col items-center" style={{ width: size }}>
      <svg width={size} height={size * 0.84} viewBox={`0 0 ${size} ${size}`}>
        <g transform={`rotate(135 ${cx} ${cy})`}>
          <circle cx={cx} cy={cy} r={r} fill="none" stroke={track} strokeWidth="7" strokeDasharray={`${arc * C} ${C}`} strokeLinecap="round" />
          <circle
            cx={cx}
            cy={cy}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="7"
            strokeDasharray={`${frac * arc * C} ${C}`}
            strokeLinecap="round"
            style={{ transition: 'stroke-dasharray 0.7s ease-out' }}
          />
        </g>
        <text x={cx} y={cy - 1} textAnchor="middle" fontSize={size * 0.26} fontWeight="600" fill="var(--ds-ink)" style={{ letterSpacing: '-0.02em' }}>
          {display ?? Math.round(value)}
        </text>
        {unit && (
          <text x={cx} y={cy + size * 0.16} textAnchor="middle" fontSize={size * 0.13} fill="var(--ds-muted)" fontWeight="600">
            {unit}
          </text>
        )}
      </svg>
      {label && <span className="-mt-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--ds-muted)]">{label}</span>}
    </div>
  );
};

interface Band {
  /** Upper bound of this band as a fraction of the track (0–1). */
  to: number;
  color: string;
}

/** A horizontal bar gauge with optional colored bands and a value marker. */
export const LinearGauge: React.FC<{
  value: number;
  min?: number;
  max: number;
  bands?: Band[];
  color?: string;
  height?: number;
  showMarker?: boolean;
}> = ({ value, min = 0, max, bands, color = '#3B82F6', height = 8, showMarker = false }) => {
  const id = useId().replace(/:/g, '');
  const frac = Math.max(0, Math.min(1, (value - min) / (max - min || 1)));
  // Grow the fill in from 0 on mount (and animate on value changes) for a little life.
  const grown = useMountFlag([]);
  return (
    <div className="relative w-full overflow-hidden rounded-full bg-[var(--ds-hairline)]" style={{ height }}>
      {bands ? (
        <div className="absolute inset-0 flex">
          {bands.map((b, i) => {
            const prev = i === 0 ? 0 : bands[i - 1].to;
            return <div key={`${id}-${i}`} style={{ width: `${(b.to - prev) * 100}%`, backgroundColor: b.color, opacity: 0.55 }} />;
          })}
        </div>
      ) : (
        <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${(grown ? frac : 0) * 100}%`, backgroundColor: color, transition: 'width 0.7s ease-out' }} />
      )}
      {(showMarker || bands) && (
        <div
          className="absolute top-1/2 h-[140%] w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[var(--ds-raised)] bg-[var(--ds-ink)]"
          style={{ left: `${frac * 100}%` }}
        />
      )}
    </div>
  );
};

/** A wind compass: cardinal ticks, a needle pointing the wind direction, speed in the hub. */
export const Compass: React.FC<{
  direction?: number;
  speed: number;
  unit?: string;
  color?: string;
  size?: number;
}> = ({ direction, speed, unit = 'km/h', color = '#3B82F6', size = 84 }) => {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 4;
  const [tx, ty] = POLAR(cx, cy, r - 6, direction ?? 0);
  const [bx, by] = POLAR(cx, cy, r - 16, (direction ?? 0) + 180);
  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={cx} cy={cy} r={r} fill="var(--ds-well)" stroke="var(--ds-hairline)" strokeWidth="1.5" />
        {[0, 90, 180, 270].map((d) => {
          const [x1, y1] = POLAR(cx, cy, r, d);
          const [x2, y2] = POLAR(cx, cy, r - 5, d);
          return <line key={d} x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--ds-faint)" strokeWidth="1.5" />;
        })}
        {(['N', 'E', 'S', 'W'] as const).map((c, i) => {
          const [lx, ly] = POLAR(cx, cy, r - 11, i * 90);
          return (
            <text key={c} x={lx} y={ly + 3} textAnchor="middle" fontSize="8" fontWeight="800" fill={c === 'N' ? color : 'var(--ds-muted)'}>
              {c}
            </text>
          );
        })}
        {typeof direction === 'number' && (
          <g>
            <line x1={bx} y1={by} x2={tx} y2={ty} stroke={color} strokeWidth="2.5" strokeLinecap="round" />
            <polygon
              points={`${tx},${ty} ${POLAR(cx, cy, r - 13, direction - 8).join(',')} ${POLAR(cx, cy, r - 13, direction + 8).join(',')}`}
              fill={color}
            />
          </g>
        )}
        <circle cx={cx} cy={cy} r="13" fill="var(--ds-raised)" stroke="var(--ds-hairline)" />
        <text x={cx} y={cy - 1} textAnchor="middle" fontSize="11" fontWeight="800" fill="var(--ds-ink)">
          {Math.round(speed)}
        </text>
        <text x={cx} y={cy + 8} textAnchor="middle" fontSize="5.5" fill="var(--ds-muted)" fontWeight="700">
          {unit}
        </text>
      </svg>
    </div>
  );
};

/** A sunrise→sunset arc with the sun positioned by the current time of day. */
export const SunArc: React.FC<{ sunrise?: string; sunset?: string; now?: number; color?: string }> = ({
  sunrise,
  sunset,
  now = Date.now(),
  color = '#f59e0b'
}) => {
  const rise = sunrise ? new Date(sunrise).getTime() : NaN;
  const set = sunset ? new Date(sunset).getTime() : NaN;
  const w = 220;
  const h = 64;
  const pad = 14;
  const frac = Number.isFinite(rise) && Number.isFinite(set) && set > rise ? Math.max(0, Math.min(1, (now - rise) / (set - rise))) : 0.5;
  const ax = pad + frac * (w - pad * 2);
  // Parabolic arc height.
  const ay = h - 6 - Math.sin(frac * Math.PI) * (h - 18);
  const isUp = frac > 0 && frac < 1;
  const fmt = (t: number) => (Number.isFinite(t) ? new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ maxHeight: h }}>
      <path d={`M${pad},${h - 6} Q${w / 2},${-h + 22} ${w - pad},${h - 6}`} fill="none" stroke="var(--ds-hairline)" strokeWidth="2" strokeDasharray="3 4" />
      <line x1={pad} y1={h - 6} x2={w - pad} y2={h - 6} stroke="var(--ds-hairline)" strokeWidth="1" />
      <circle cx={ax} cy={ay} r={isUp ? 6 : 4} fill={isUp ? color : 'var(--ds-faint)'} stroke="var(--ds-raised)" strokeWidth="1.5" />
      <text x={pad} y={h - 12} textAnchor="start" fontSize="9" fontWeight="700" fill="var(--ds-muted)">↑ {fmt(rise)}</text>
      <text x={w - pad} y={h - 12} textAnchor="end" fontSize="9" fontWeight="700" fill="var(--ds-muted)">↓ {fmt(set)}</text>
    </svg>
  );
};
