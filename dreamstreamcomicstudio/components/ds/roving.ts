/**
 * Roving focus for a one-dimensional group (Segmented's radios, Tabs' tabs): the arrow keys move to the
 * next / previous enabled item and wrap, Home / End jump to the ends. Left and Right follow the reading
 * direction (mirrored in a right-to-left layout); Up and Down always mean previous / next.
 */
export function nextRovingIndex(key: string, current: number, enabled: readonly boolean[], rtl = false): number | null {
  const indices = enabled.map((on, i) => (on ? i : -1)).filter((i) => i >= 0);
  if (!indices.length) return null;
  if (key === 'Home') return indices[0];
  if (key === 'End') return indices[indices.length - 1];
  const forward = key === 'ArrowDown' || key === (rtl ? 'ArrowLeft' : 'ArrowRight');
  const backward = key === 'ArrowUp' || key === (rtl ? 'ArrowRight' : 'ArrowLeft');
  if (!forward && !backward) return null;
  const at = indices.indexOf(current);
  if (at < 0) return forward ? indices[0] : indices[indices.length - 1];
  const step = forward ? 1 : -1;
  return indices[(at + step + indices.length) % indices.length];
}

/** Whether an element lays out right-to-left (its computed direction). */
export function isRtl(el: Element | null): boolean {
  if (!el || typeof window === 'undefined') return false;
  return window.getComputedStyle(el).direction === 'rtl';
}
