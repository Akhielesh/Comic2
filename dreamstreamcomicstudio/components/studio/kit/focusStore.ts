// Studio layout focus (Sprint 2): which pane the user wants to dedicate the screen to —
// "split" (prompt · code · preview, the default), "code" (review/edit the code), or "preview"
// (review the running app). Persisted to localStorage so the choice sticks across reloads.
// Lets the user maximize the real estate for whatever they're doing. Dependency-free.

import { create } from 'zustand';

export type StudioFocus = 'split' | 'code' | 'preview';

export const STUDIO_FOCUS_ORDER: StudioFocus[] = ['code', 'split', 'preview'];

const STORAGE_KEY = 'studio.focus';
const DEFAULT_FOCUS: StudioFocus = 'split';

const isFocus = (v: unknown): v is StudioFocus => v === 'split' || v === 'code' || v === 'preview';

const readInitial = (): StudioFocus => {
  if (typeof window === 'undefined') return DEFAULT_FOCUS;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isFocus(v) ? v : DEFAULT_FOCUS;
  } catch {
    return DEFAULT_FOCUS;
  }
};

const persist = (f: StudioFocus) => {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(STORAGE_KEY, f); } catch { /* ignore */ }
};

interface FocusState {
  focus: StudioFocus;
  setFocus: (f: StudioFocus) => void;
}

export const useStudioFocus = create<FocusState>((set) => ({
  focus: readInitial(),
  setFocus: (f) => { persist(f); set({ focus: f }); },
}));
