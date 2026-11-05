// useStudioMode — the Easy/Pro VIEW (contract §13.1, §13.5; softwarefirst.md §5.3).
//
// Mode is a view, never a permission: every free edit works in both modes and the director is
// not mode-aware. The user's pick lives in localStorage `comicstudio.mode` (try/catch: private
// windows and blocked storage simply don't persist), else `caps.defaultMode`. Pro needs
// `caps.proEditor` (decisions-final #1: true for everyone today; one flag makes it a paid perk).
// Other tabs of the same browser follow a change through the `storage` event.

import { useCallback, useEffect, useState } from 'react';
import type { StudioCaps, StudioMode } from '../../shared/comic/capabilities';

/** localStorage key of the Easy/Pro view (contract §13.5). */
export const MODE_STORAGE_KEY = 'comicstudio.mode';

const asMode = (v: unknown): StudioMode | null => (v === 'easy' || v === 'pro' ? v : null);

export const readStoredMode = (): StudioMode | null => {
  try {
    return typeof window !== 'undefined' ? asMode(window.localStorage.getItem(MODE_STORAGE_KEY)) : null;
  } catch {
    return null;
  }
};

const writeStoredMode = (mode: StudioMode): void => {
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    /* not persisted (private mode, blocked storage) — the view still switches for this session */
  }
};

/** The view a user gets: their pick, else the plan default; Pro needs the proEditor capability. */
export const resolveStudioMode = (stored: StudioMode | null, caps: StudioCaps): StudioMode => {
  const mode = stored ?? caps.defaultMode;
  return mode === 'pro' && !caps.proEditor ? 'easy' : mode;
};

export interface StudioModeState {
  /** The view to render (already gated by caps.proEditor). */
  mode: StudioMode;
  /** The user's explicit pick, if any (null ⇒ following caps.defaultMode). */
  stored: StudioMode | null;
  setMode(mode: StudioMode): void;
}

export function useStudioMode(caps: StudioCaps): StudioModeState {
  const [stored, setStored] = useState<StudioMode | null>(readStoredMode);

  const setMode = useCallback((next: StudioMode) => {
    const mode = asMode(next);
    if (!mode) return;
    writeStoredMode(mode);
    setStored(mode);
  }, []);

  // Another tab switched the view: follow it (no network, no timer).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onStorage = (e: StorageEvent) => {
      if (e.key !== MODE_STORAGE_KEY) return;
      setStored(asMode(e.newValue));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  return { mode: resolveStudioMode(stored, caps), stored, setMode };
}
