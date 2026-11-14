import { useEffect, useState, type RefObject } from 'react';

/** Native touch/trackpad momentum, mouse-wheel support, and explicit smooth step controls. */
export function useTimelineScroll(ref: RefObject<HTMLDivElement | null>, shown: boolean, reducedMotion: boolean) {
  const [edges, setEdges] = useState({ earlier: false, later: false });
  useEffect(() => {
    const rail = ref.current;
    if (!shown || !rail) return;
    const measure = () => {
      const earlier = rail.scrollLeft > 1;
      const later = rail.scrollLeft + rail.clientWidth < rail.scrollWidth - 1;
      setEdges((old) => old.earlier === earlier && old.later === later ? old : { earlier, later });
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rail.clientWidth : 1;
      const next = Math.max(0, Math.min(rail.scrollWidth - rail.clientWidth, rail.scrollLeft + event.deltaY * scale));
      if (next === rail.scrollLeft) return;
      event.preventDefault();
      rail.scrollLeft = next;
      measure();
    };
    measure();
    rail.addEventListener('scroll', measure, { passive: true });
    rail.addEventListener('wheel', wheel, { passive: false });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(rail);
    if (rail.firstElementChild) observer?.observe(rail.firstElementChild);
    return () => {
      rail.removeEventListener('scroll', measure);
      rail.removeEventListener('wheel', wheel);
      observer?.disconnect();
    };
  }, [shown, ref]);

  const scroll = (direction: -1 | 1) => {
    const rail = ref.current;
    if (!rail) return;
    const left = Math.max(0, Math.min(rail.scrollWidth - rail.clientWidth, rail.scrollLeft + direction * Math.max(120, rail.clientWidth * 0.8)));
    if (typeof rail.scrollTo === 'function') rail.scrollTo({ left, behavior: reducedMotion ? 'auto' : 'smooth' });
    else rail.scrollLeft = left;
  };
  return { ...edges, scroll };
}
