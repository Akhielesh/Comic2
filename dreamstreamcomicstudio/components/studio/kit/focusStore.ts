// Studio right-pane view: the workspace is a fixed 30/70 two-pane layout — a full-height chat
// on the LEFT and a single workspace pane on the RIGHT that toggles between the live Preview and
// the Code editor. (The old three-pane "split" was retired: users wanted 30/70 with one toggle,
// not three columns fighting for room.) Persisted to localStorage so the choice sticks.
// Dependency-free.

import { create } from 'zustand';

/** Which view the right (70%) pane shows. */
export type StudioFocus = 'preview' | 'code';

/** Toggle order for the segmented control. Preview-first — most people want to see the app. */
export const STUDIO_FOCUS_ORDER: StudioFocus[] = ['preview', 'code'];

const STORAGE_KEY = 'studio.focus';
const DEFAULT_FOCUS: StudioFocus = 'preview';

const isFocus = (v: unknown): v is StudioFocus => v === 'preview' || v === 'code';

const readInitial = (): StudioFocus => {
  if (typeof window === 'undefined') return DEFAULT_FOCUS;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    // Migrate the retired 'split' value to the new default rather than crashing on it.
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
