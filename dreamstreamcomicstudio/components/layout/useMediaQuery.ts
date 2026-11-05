import { useSyncExternalStore } from 'react';

/** The phone layout (below Tailwind's `sm`): where the header collapses and floating chrome steps aside. */
export const PHONE_QUERY = '(max-width: 639.98px)';
/** The desktop navigation row (Tailwind's `lg`); below it the header shows the menu button. */
export const DESKTOP_NAV_QUERY = '(min-width: 1024px)';

const mediaList = (query: string): MediaQueryList | null => {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query) : null;
  } catch {
    return null;
  }
};

/**
 * Whether a media query matches, kept current as the window resizes or rotates. Read synchronously on the
 * first render (no flash of the wrong layout); false where matchMedia is missing.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = mediaList(query);
      if (!list) return () => undefined;
      // Safari < 14 only has the deprecated listener API.
      if (typeof list.addEventListener === 'function') {
        list.addEventListener('change', onChange);
        return () => list.removeEventListener('change', onChange);
      }
      list.addListener?.(onChange);
      return () => list.removeListener?.(onChange);
    },
    () => mediaList(query)?.matches ?? false,
    () => false
  );
}

/** The phone layout (below `sm`). */
export const usePhoneViewport = (): boolean => useMediaQuery(PHONE_QUERY);
