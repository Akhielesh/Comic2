// Copy style / Paste style (⌘⌥C / ⌘⌥V; agent-editor plan §3 C2): one copied look per tab, in memory. It is the
// editor's own clipboard (never the system one, which would need a permission prompt and could leak text), and it is
// cleared with the tab. The inspector, the Arrange tab and the keyboard all read it here.

import { useSyncExternalStore } from 'react';
import type { StyleClip } from '../../lettering/styleOps';

let clip: StyleClip | null = null;
const listeners = new Set<() => void>();

export const styleClip = (): StyleClip | null => clip;

export const setStyleClip = (next: StyleClip | null): void => {
  clip = next;
  for (const l of listeners) l();
};

export const subscribeStyleClip = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** The copied look (re-renders when it changes). */
export const useStyleClip = (): StyleClip | null => useSyncExternalStore(subscribeStyleClip, styleClip, styleClip);

/** ⌘⌥C / Ctrl+Alt+C copies, ⌘⌥V / Ctrl+Alt+V pastes (`e.code` too: Alt changes the typed letter on a Mac). */
export const styleClipboardKey = (e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): 'copy' | 'paste' | null => {
  if (!(e.metaKey || e.ctrlKey) || !e.altKey || e.shiftKey) return null;
  const k = (e.key || '').toLowerCase();
  if (e.code === 'KeyC' || k === 'c' || k === 'ç') return 'copy';
  if (e.code === 'KeyV' || k === 'v' || k === '√') return 'paste';
  return null;
};
