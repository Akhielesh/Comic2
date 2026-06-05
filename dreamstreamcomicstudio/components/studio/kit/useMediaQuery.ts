// Small matchMedia hook for responsive studio layout decisions. matchMedia-safe (jsdom/SSR).

import { useEffect, useState } from 'react';

export const useMediaQuery = (query: string): boolean => {
  const read = () => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    try { return window.matchMedia(query).matches; } catch { return false; }
  };
  const [matches, setMatches] = useState<boolean>(read);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else mql.removeListener(onChange);
    };
  }, [query]);

  return matches;
};

/** Tailwind `lg` breakpoint (≥1024px) — the threshold for the resizable multi-pane layout. */
export const useIsWide = (): boolean => useMediaQuery('(min-width: 1024px)');
