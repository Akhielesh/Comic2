// Whether the page is in dark mode right now, read from the `dark` class on <html> that services/theme.ts (and the QA
// app's theme switch) set. A MutationObserver keeps it live, so a theme change swaps the landing's pictures to the
// matching set; no timer, no polling. Server render and test DOMs without <html> read as light.
import { useSyncExternalStore } from 'react';

const read = (): boolean => typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

const subscribe = (onChange: () => void): (() => void) => {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
};

export const useDarkClass = (): boolean => useSyncExternalStore(subscribe, read, () => false);
