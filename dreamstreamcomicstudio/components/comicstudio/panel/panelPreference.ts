// Whether the side panel is open or a slim rail where it docks (SH-C1). One choice for the whole Comic Studio (the
// frame around My comics, New comic and Images, and the studio), remembered per viewer in localStorage. Every read and
// write is guarded: a private window, a full quota or blocked storage keeps the choice for this session in memory, so
// the frame and the studio still agree, and nothing throws.

import { useCallback, useState } from 'react';

export const PANEL_PREFERENCE_KEY = 'dreamstream.comic-panel';
/**
 * "Wide desktop": from this width the studio starts with the panel open until the viewer chooses (below, the rail keeps
 * the conversation and the board their room). The frame around My comics, New comic and Images starts open wherever it
 * docks, as it always has (its own minimum, WORKSPACE_NAV_DRAWER_BELOW).
 */
export const PANEL_OPEN_BY_DEFAULT_MIN = 1280;

const keyFor = (accountId?: string | null) => (accountId ? `${PANEL_PREFERENCE_KEY}.${accountId}` : PANEL_PREFERENCE_KEY);
/** This session's choices, by key, kept only when storage could not keep them. */
const session = new Map<string, boolean>();

/** The viewer's choice, or the width's default when there is none (or storage cannot be read). */
export function readPanelOpen(accountId: string | null | undefined, width: number, openFrom = PANEL_OPEN_BY_DEFAULT_MIN): boolean {
  const key = keyFor(accountId);
  // A choice storage could not keep is the latest one.
  const unsaved = session.get(key);
  if (unsaved !== undefined) return unsaved;
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === 'open') return true;
    if (stored === 'closed') return false;
  } catch {
    /* Storage unavailable: the default. */
  }
  return width >= openFrom;
}

export function writePanelOpen(accountId: string | null | undefined, open: boolean): void {
  const key = keyFor(accountId);
  try {
    window.localStorage.setItem(key, open ? 'open' : 'closed');
    session.delete(key);
  } catch {
    // Kept for this session only.
    session.set(key, open);
  }
}

/** The panel's open state for this viewer, read once on mount; setting it remembers the choice. */
export function usePanelOpen(accountId: string | null | undefined, width: number, openFrom = PANEL_OPEN_BY_DEFAULT_MIN): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => readPanelOpen(accountId, width, openFrom));
  const choose = useCallback(
    (next: boolean) => {
      writePanelOpen(accountId, next);
      setOpen(next);
    },
    [accountId]
  );
  return [open, choose];
}

/** Tests: forget this session's in-memory choices. */
export const resetPanelPreferenceForTests = (): void => session.clear();
