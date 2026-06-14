import React from 'react';

// Custom weather icons — a cohesive, dependency-free SVG set that replaces the
// OS-dependent emoji glyphs (☀️🌧️❄️) which render differently on every platform and
// never matched the calm-studio language. One 24×24 viewBox, a shared rounded-stroke
// cloud, tasteful semantic colour (amber sun, slate cloud, sky rain, indigo night),
// and a couple of gentle ambient animations (sun spin, twinkle) that respect
// prefers-reduced-motion via the global `wx-*` keyframes already in index.css.
//
// Mapping is by WMO weather code (Open-Meteo), the same source skyOf() uses.

export type WeatherKind =
  | 'clear-day'
  | 'clear-night'
  | 'partly-day'
  | 'partly-night'
  | 'cloudy'
  | 'fog'
  | 'drizzle'
  | 'rain'
  | 'sleet'
  | 'snow'
  | 'thunder';

/** WMO code → icon kind (day/night aware for the clear & partly-cloudy bands). */
export const weatherKind = (code: number, isDay = true): WeatherKind => {
  if (code === 0) return isDay ? 'clear-day' : 'clear-night';
  if (code <= 2) return isDay ? 'partly-day' : 'partly-night';
  if (code === 3) return 'cloudy';
  if (code <= 48) return 'fog';
  if (code <= 57) return 'drizzle';
  if (code <= 67) return 'rain';
  if (code <= 77) return 'snow';
  if (code <= 82) return 'rain';
  if (code <= 86) return 'sleet';
  return 'thunder';
};

const SUN = '#f5a623';
const MOON = '#c4c2f0';
const CLOUD = '#9aa6b8';
const CLOUD_DARK = '#6b7686';
const RAIN = '#5ab0f0';
const SNOW = '#cfe3f2';
const BOLT = '#f5c542';

// Shared cloud body (a soft rounded blob) reused by every cloudy condition.
const Cloud: React.FC<{ fill?: string; cx?: number; cy?: number }> = ({ fill = CLOUD, cx = 0, cy = 0 }) => (
  <path
    transform={`translate(${cx} ${cy})`}
    d="M7.4 17.5a3.6 3.6 0 0 1-.3-7.2 5 5 0 0 1 9.6-1.1 3.9 3.9 0 0 1 .5 7.8 2 2 0 0 1-.4 0H7.4Z"
    fill={fill}
  />
);

const Rays: React.FC<{ color: string; cx: number; cy: number; r: number }> = ({ color, cx, cy, r }) => (
  <g stroke={color} strokeWidth={1.6} strokeLinecap="round">
    {Array.from({ length: 8 }).map((_, i) => {
      const a = (i * Math.PI) / 4;
      return <line key={i} x1={cx + Math.cos(a) * (r + 1.5)} y1={cy + Math.sin(a) * (r + 1.5)} x2={cx + Math.cos(a) * (r + 4)} y2={cy + Math.sin(a) * (r + 4)} />;
    })}
  </g>
);

const Drops: React.FC<{ color: string; y: number }> = ({ color, y }) => (
  <g fill={color}>
    {[8, 12, 16].map((x, i) => (
      <path key={i} className="wx-fall" style={{ animationDelay: `${i * 0.2}s` }} d={`M${x} ${y}c.9 1.2 1.4 2 1.4 2.7a1.4 1.4 0 0 1-2.8 0c0-.7.5-1.5 1.4-2.7Z`} />
    ))}
  </g>
);

const Flakes: React.FC<{ color: string; y: number }> = ({ color, y }) => (
  <g fill={color}>
    {[8, 12, 16].map((x, i) => (
      <circle key={i} className="wx-fall" style={{ animationDelay: `${i * 0.25}s` }} cx={x} cy={y + 1} r={1.1} />
    ))}
  </g>
);

export interface WeatherIconProps {
  code: number;
  isDay?: boolean;
  size?: number;
  className?: string;
  /** Disable the ambient animation (lists, dense rows). */
  still?: boolean;
}

export const WeatherIcon: React.FC<WeatherIconProps> = ({ code, isDay = true, size = 24, className = '', still = false }) => {
  const kind = weatherKind(code, isDay);
  const spin = still ? '' : 'wx-spin';

  const body = (() => {
    switch (kind) {
      case 'clear-day':
        return (
          <g className={spin} style={{ transformOrigin: '12px 12px' }}>
            <Rays color={SUN} cx={12} cy={12} r={4} />
            <circle cx={12} cy={12} r={4.4} fill={SUN} />
          </g>
        );
      case 'clear-night':
        return <path d="M20 14.2A8 8 0 1 1 9.8 4 6.4 6.4 0 0 0 20 14.2Z" fill={MOON} />;
      case 'partly-day':
        return (
          <>
            <g className={spin} style={{ transformOrigin: '8.5px 8.5px' }}>
              <Rays color={SUN} cx={8.5} cy={8.5} r={3} />
              <circle cx={8.5} cy={8.5} r={3.3} fill={SUN} />
            </g>
            <Cloud fill={CLOUD} cx={2.5} cy={2} />
          </>
        );
      case 'partly-night':
        return (
          <>
            <path d="M14 8.4A5.6 5.6 0 1 1 7 1.2 4.5 4.5 0 0 0 14 8.4Z" fill={MOON} />
            <Cloud fill={CLOUD} cx={2.5} cy={2} />
          </>
        );
      case 'cloudy':
        return (
          <>
            <Cloud fill={CLOUD_DARK} cx={-1} cy={-1.5} />
            <Cloud fill={CLOUD} cx={2.5} cy={1.5} />
          </>
        );
      case 'fog':
        return (
          <>
            <Cloud fill={CLOUD} cx={0} cy={-2} />
            <g stroke={CLOUD_DARK} strokeWidth={1.6} strokeLinecap="round">
              <line x1={5} y1={18} x2={17} y2={18} />
              <line x1={7} y1={21} x2={19} y2={21} />
            </g>
          </>
        );
      case 'drizzle':
        return (
          <>
            <Cloud fill={CLOUD} cx={0} cy={-2} />
            <Drops color={RAIN} y={17} />
          </>
        );
      case 'rain':
        return (
          <>
            <Cloud fill={CLOUD_DARK} cx={0} cy={-2} />
            <Drops color={RAIN} y={17} />
          </>
        );
      case 'sleet':
        return (
          <>
            <Cloud fill={CLOUD} cx={0} cy={-2} />
            <Drops color={RAIN} y={17} />
            <Flakes color={SNOW} y={20} />
          </>
        );
      case 'snow':
        return (
          <>
            <Cloud fill={CLOUD} cx={0} cy={-2} />
            <Flakes color={SNOW} y={17} />
          </>
        );
      case 'thunder':
        return (
          <>
            <Cloud fill={CLOUD_DARK} cx={0} cy={-2} />
            <path className={still ? '' : 'wx-flash'} d="M12.5 15.5 9 20h2.4l-1 3.4 4-5h-2.3l1-2.9Z" fill={BOLT} />
          </>
        );
    }
  })();

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label={kind.replace('-', ' ')}
      style={{ display: 'inline-block', flexShrink: 0 }}
    >
      {body}
    </svg>
  );
};
