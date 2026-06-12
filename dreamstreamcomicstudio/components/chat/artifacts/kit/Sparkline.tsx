import React, { useEffect, useId, useMemo, useRef } from 'react';
import { withAlpha, BEAR } from './theme';
import { prefersReducedMotion, useMeasure, useSeriesMorph } from './Chart';

// Dependency-free mini line+area chart — the glance-size sibling of Chart. No axes,
// no hover. Container-responsive: a ResizeObserver measures the wrapper and the SVG
// renders at the real pixel width (the `width` prop is just the pre-measure
// fallback), so strokes stay crisp instead of stretching a fixed viewBox. The line
// draws itself in on mount (~500ms ease-out, reduced-motion aware) and value updates
// morph smoothly. The under-line gradient tints from the line color, or — when the
// consumer passes `direction` — accent for up days, rose for down days.

export const Sparkline: React.FC<{
  values: number[];
  color?: string;
  width?: number;
  height?: number;
  fill?: boolean;
  className?: string;
  /** Gradient tint hint: 'up' keeps the line's accent, 'down' goes rose. */
  direction?: 'up' | 'down';
}> = ({ values, color = '#3B82F6', width = 280, height = 48, fill = true, className, direction }) => {
  const gradId = useId().replace(/:/g, '');
  const [attachWrap, size] = useMeasure<HTMLDivElement>();
  const lineRef = useRef<SVGPathElement>(null);
  const drawnRef = useRef(false);

  const W = size.width || width;
  const display = useSeriesMorph(values, 320);

  const paths = useMemo(() => {
    if (!display || display.length < 2 || W <= 0) return null;
    const pad = 2;
    const min = Math.min(...display);
    const max = Math.max(...display);
    const span = max - min || 1;
    const stepX = (W - pad * 2) / (display.length - 1);
    const pts = display.map((v, i) => {
      const x = pad + i * stepX;
      const y = pad + (height - pad * 2) * (1 - (v - min) / span);
      return [x, y] as const;
    });
    const line = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${height} L${pts[0][0].toFixed(1)},${height} Z`;
    return { line, area };
  }, [display, W, height]);

  // Subtle draw-in on first real layout.
  useEffect(() => {
    if (drawnRef.current || size.width <= 0 || !paths) return;
    drawnRef.current = true;
    if (prefersReducedMotion()) return;
    const line = lineRef.current;
    if (!line || typeof line.animate !== 'function' || typeof line.getTotalLength !== 'function') return;
    try {
      const len = line.getTotalLength();
      if (!Number.isFinite(len) || len <= 0) return;
      line.style.strokeDasharray = `${len}`;
      const anim = line.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], {
        duration: 500,
        easing: 'cubic-bezier(0.33, 1, 0.68, 1)'
      });
      anim.onfinish = () => {
        line.style.strokeDasharray = 'none';
        line.style.strokeDashoffset = '0';
      };
    } catch {
      /* non-browser environment — skip the flourish */
    }
  }, [size.width, paths]);

  if (!values || values.length < 2) return null;

  const tint = direction === 'down' ? BEAR : color;

  return (
    <div ref={attachWrap} className={`relative w-full ${className ?? ''}`} style={{ height }}>
      {paths && (
        <svg width={W} height={height} viewBox={`0 0 ${W} ${height}`} className="absolute inset-0 block" aria-hidden>
          {fill && (
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={withAlpha(tint, 0.28)} />
                <stop offset="100%" stopColor={withAlpha(tint, 0)} />
              </linearGradient>
            </defs>
          )}
          {fill && <path d={paths.area} fill={`url(#${gradId})`} />}
          <path
            ref={lineRef}
            d={paths.line}
            fill="none"
            stroke={color}
            strokeWidth="1.75"
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{ transition: 'stroke 300ms ease' }}
          />
        </svg>
      )}
    </div>
  );
};
