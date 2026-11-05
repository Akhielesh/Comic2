/**
 * In-page jumps on the home page ("Register interest", "Explore the studios", a footer link).
 *
 * No `#hash` navigation on purpose: the app owns the URL (?view= sync, and the Back button walks
 * views), so a hash would add a history entry that Back then has to undo. The jump scrolls the
 * section's heading into view — smoothly unless the reader asked for reduced motion — and moves focus
 * to it (tabIndex -1, no visible ring for a programmatic focus), so keyboard and screen-reader users
 * land where the page moved.
 */
import type React from 'react';

const reducedMotion = (): boolean => {
  try {
    return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

export function scrollToSection(id: string): boolean {
  if (typeof document === 'undefined') return false;
  const section = document.getElementById(id);
  if (!section) return false;
  const target = section.querySelector<HTMLElement>('[data-jump-target]') ?? section;
  target.scrollIntoView?.({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
  return true;
}

/** onClick for an `<a href="#id">`: a plain click jumps in place; a modified click is left alone. */
export const jumpTo = (id: string) => (event: React.MouseEvent<HTMLAnchorElement>) => {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (scrollToSection(id)) event.preventDefault();
};
