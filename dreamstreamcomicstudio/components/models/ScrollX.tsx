import React, { useCallback, useEffect, useRef, useState } from 'react';

// Sideways scroller for the Model Library's wide tables and toolbars. On a narrow screen (390 px) the
// content scrolls inside this box, never the page, and the edge that hides more content gets a soft fade,
// plus (for tables) a one-line "scroll sideways" hint, so a clipped column reads as "swipe" not "missing".
// Nothing extra renders when the content fits.

type Fade = 'white' | 'surface';

const FADE_FROM: Record<Fade, string> = {
  white: 'from-white',
  surface: 'from-[var(--ds-surface)]'
};

export const ScrollX: React.FC<{
  children: React.ReactNode;
  /** Accessible name of the scroll region (it becomes keyboard-scrollable while it overflows). */
  label: string;
  /** Classes for the outer wrapper (margins, width). */
  className?: string;
  /** Classes for the clipping box around the scroller (borders, rounding); the fades sit inside it. */
  boxClassName?: string;
  /** Classes for the scrolling element itself (e.g. a max height for a vertically scrolling table). */
  scrollClassName?: string;
  /** Text under the box while it overflows; omit for toolbars, where the fade alone is enough. */
  hint?: string;
  /** Background the fade melts into. */
  fade?: Fade;
}> = ({ children, label, className = '', boxClassName = '', scrollClassName = '', hint, fade = 'white' }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 2;
    const end = el.scrollWidth - el.clientWidth - el.scrollLeft > 2;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [measure]);

  const overflowing = edges.start || edges.end;

  return (
    <div className={`max-w-full ${className}`}>
      <div className={`relative ${boxClassName}`}>
        <div
          ref={ref}
          onScroll={measure}
          role="region"
          aria-label={label}
          tabIndex={overflowing ? 0 : undefined}
          className={`overflow-x-auto overscroll-x-contain ${scrollClassName}`}
        >
          {children}
        </div>
        {edges.start && (
          <div aria-hidden className={`pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r ${FADE_FROM[fade]} to-transparent`} />
        )}
        {edges.end && (
          <div aria-hidden className={`pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l ${FADE_FROM[fade]} to-transparent`} />
        )}
      </div>
      {hint && overflowing && (
        <div className="mt-1 px-1 text-[10px] font-bold text-slate-400 text-right" aria-hidden>
          {hint} →
        </div>
      )}
    </div>
  );
};
