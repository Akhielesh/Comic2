// Balloon selection for the page editor: single, Shift-click additive, marquee/set, Tab cycling.
// Mirrored to `studio.setSelection` so the composer can say "2 balloons selected on page 1" and send it
// as the message focus ("make THIS bubble bigger" then resolves without guessing).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StudioSelection } from '../types';

export interface LetteringSelection {
  /** Selected line ids, primary first. */
  ids: string[];
  /** The balloon the handles and the inline editor belong to. */
  primary: string | null;
  isSelected(id: string): boolean;
  /** Select one balloon; `additive` toggles it in a multi-selection (Shift-click). null clears. */
  select(id: string | null, opts?: { additive?: boolean }): void;
  set(ids: readonly string[]): void;
  clear(): void;
  /** Move the primary selection to the next/previous id in `order` (Tab / Shift+Tab). */
  cycle(order: readonly string[], dir: 1 | -1): string | null;
}

/** The selection holds overlays or panels on this page (an empty balloon selection must not wipe it). */
export const holdsOverlaysOn = (sel: StudioSelection | null | undefined, pageId: string): boolean =>
  !!sel && sel.pageId === pageId && ((sel.layerIds?.length ?? 0) > 0 || (sel.panelIds?.length ?? 0) > 0);

/** Pure reducer step for `select` (tested). */
export const nextSelection = (current: readonly string[], id: string | null, additive = false): string[] => {
  if (id === null) return [];
  if (!additive) return [id];
  return current.includes(id) ? current.filter((x) => x !== id) : [id, ...current];
};

export function useLetteringSelection(opts: {
  pageId: string;
  /** Ids that still exist on the page (others are dropped). */
  validIds?: readonly string[];
  setStudioSelection?: (sel: StudioSelection | null) => void;
  panelOf?: (lineId: string) => number | undefined;
  /**
   * The selection the editor opens with, read once on mount: the balloons a "Show me" (the conflict card, agent-editor
   * plan §3 A3) asked to see. Ids not on the page are dropped.
   */
  initial?: readonly string[];
  /**
   * The studio's current selection (PE-SHELL (m)). While it holds overlays or panels on this page (the Layers part
   * selects them with no balloon), an empty balloon selection does not clear it; closing the editor still does.
   */
  studioSelection?: StudioSelection | null;
}): LetteringSelection {
  const { pageId, validIds, setStudioSelection, panelOf } = opts;
  const [ids, setIds] = useState<string[]>(() => [...new Set(opts.initial ?? [])].filter((id) => !validIds || validIds.includes(id)));
  const validKey = validIds ? validIds.join('|') : '';

  // Drop ids whose line was deleted (undo, director edits, another tab).
  useEffect(() => {
    if (!validIds) return;
    setIds((cur) => {
      const next = cur.filter((id) => validIds.includes(id));
      return next.length === cur.length ? cur : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validKey]);

  // Mirror to the studio (chat focus). Cleared when the editor closes.
  const sync = useRef(setStudioSelection);
  sync.current = setStudioSelection;
  const panelOfRef = useRef(panelOf);
  panelOfRef.current = panelOf;
  const studioSelRef = useRef(opts.studioSelection);
  studioSelRef.current = opts.studioSelection;
  useEffect(() => {
    const set = sync.current;
    if (!set) return;
    if (!ids.length) {
      if (!holdsOverlaysOn(studioSelRef.current, pageId)) set(null);
    } else {
      const panels = new Set(ids.map((id) => panelOfRef.current?.(id)).filter((n): n is number => typeof n === 'number'));
      set({ pageId, lineIds: ids, surface: 'page_editor', ...(panels.size === 1 ? { panelN: [...panels][0] } : {}) });
    }
  }, [ids, pageId]);
  useEffect(() => () => sync.current?.(null), []);

  const select = useCallback((id: string | null, o?: { additive?: boolean }) => setIds((cur) => nextSelection(cur, id, o?.additive)), []);
  const set = useCallback((next: readonly string[]) => setIds([...new Set(next)]), []);
  const clear = useCallback(() => setIds([]), []);
  const cycle = useCallback(
    (order: readonly string[], dir: 1 | -1) => {
      if (!order.length) return null;
      const cur = ids[0] ? order.indexOf(ids[0]) : -1;
      const next = order[(cur + dir + order.length) % order.length] ?? order[0];
      setIds([next]);
      return next;
    },
    [ids]
  );
  return useMemo(
    () => ({ ids, primary: ids[0] ?? null, isSelected: (id: string) => ids.includes(id), select, set, clear, cycle }),
    [ids, select, set, clear, cycle]
  );
}

export default useLetteringSelection;
