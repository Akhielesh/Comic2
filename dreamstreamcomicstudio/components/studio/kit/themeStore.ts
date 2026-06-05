// Active Code Studio theme — a tiny persisted store + the `useStudioTheme()` hook every
// studio surface reads. Persists to localStorage (Code-Studio-scoped key) so the choice
// sticks across reloads. Dependency-free (no app settings coupling).

import { create } from 'zustand';
import {
  STUDIO_THEMES,
  DEFAULT_STUDIO_THEME,
  type StudioThemeId,
  type StudioThemeTokens,
} from './theme';

const STORAGE_KEY = 'studio.theme';

const isThemeId = (v: unknown): v is StudioThemeId => v === 'black' || v === 'light' || v === 'brand';

const readInitial = (): StudioThemeId => {
  if (typeof window === 'undefined') return DEFAULT_STUDIO_THEME;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isThemeId(v) ? v : DEFAULT_STUDIO_THEME;
  } catch {
    return DEFAULT_STUDIO_THEME;
  }
};

const persist = (id: StudioThemeId) => {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
};

interface StudioThemeState {
  id: StudioThemeId;
  setTheme: (id: StudioThemeId) => void;
}

export const useStudioThemeStore = create<StudioThemeState>((set) => ({
  id: readInitial(),
  setTheme: (id) => { persist(id); set({ id }); },
}));

/** The active theme's tokens. Re-renders consumers when the theme changes. */
export const useStudioTheme = (): StudioThemeTokens => STUDIO_THEMES[useStudioThemeStore((s) => s.id)];
