/**
 * useSelection — picking several things in a grid or a list (redesign plan §4: the Library bulk actions, the
 * Pages multi-select, the Assets bulk bar). One model for all of them:
 *
 *   - selection mode is explicit (`selecting`): outside it a tap opens the card; inside it a tap toggles it,
 *     the arrow keys move between cards (CardGrid) and the SelectionBar shows the count;
 *   - Shift extends a range from the last item toggled (the anchor), in the order of `ids`;
 *   - ids that leave the list (a filter, a delete) leave the selection too, so a bulk action never acts on
 *     something the person can no longer see;
 *   - clearing the last item does not leave selection mode on its own; `clear()` does, and Esc in CardGrid
 *     calls it.
 *
 * The reducer is pure and exported, so the rules are unit-tested without React.
 */
import { useCallback, useEffect, useMemo, useReducer } from 'react';

export interface SelectionState<Id extends string = string> {
  selecting: boolean;
  selected: readonly Id[];
  /** The last item toggled on its own: the start of a Shift range. */
  anchor: Id | null;
}

export type SelectionAction<Id extends string = string> =
  | { type: 'start'; id?: Id }
  | { type: 'toggle'; id: Id }
  | { type: 'range'; id: Id; order: readonly Id[] }
  | { type: 'set'; ids: readonly Id[] }
  | { type: 'all'; order: readonly Id[] }
  | { type: 'clear' }
  | { type: 'prune'; order: readonly Id[] };

export const EMPTY_SELECTION: SelectionState<string> = { selecting: false, selected: [], anchor: null };

export function selectionReducer<Id extends string>(state: SelectionState<Id>, action: SelectionAction<Id>): SelectionState<Id> {
  switch (action.type) {
    case 'start':
      if (action.id === undefined) return state.selecting ? state : { ...state, selecting: true };
      return { selecting: true, selected: state.selected.includes(action.id) ? state.selected : [...state.selected, action.id], anchor: action.id };
    case 'toggle': {
      const on = state.selected.includes(action.id);
      return { selecting: true, selected: on ? state.selected.filter((x) => x !== action.id) : [...state.selected, action.id], anchor: action.id };
    }
    case 'range': {
      const to = action.order.indexOf(action.id);
      const from = state.anchor === null ? -1 : action.order.indexOf(state.anchor);
      if (to < 0) return state;
      if (from < 0) return selectionReducer(state, { type: 'toggle', id: action.id });
      const [a, b] = from <= to ? [from, to] : [to, from];
      const span = action.order.slice(a, b + 1);
      const merged = [...state.selected, ...span.filter((x) => !state.selected.includes(x))];
      return { selecting: true, selected: merged, anchor: state.anchor };
    }
    case 'set':
      return { selecting: true, selected: Array.from(new Set(action.ids)), anchor: action.ids[action.ids.length - 1] ?? null };
    case 'all':
      return { selecting: true, selected: [...action.order], anchor: state.anchor };
    case 'clear':
      return EMPTY_SELECTION as SelectionState<Id>;
    case 'prune': {
      const keep = state.selected.filter((x) => action.order.includes(x));
      const anchor = state.anchor !== null && action.order.includes(state.anchor) ? state.anchor : null;
      if (keep.length === state.selected.length && anchor === state.anchor) return state;
      return { ...state, selected: keep, anchor };
    }
  }
}

export interface Selection<Id extends string = string> {
  selecting: boolean;
  /** Selected ids, in the order of `ids` (the order a bulk action works through them). */
  selected: Id[];
  count: number;
  isSelected(id: Id): boolean;
  /** Enter selection mode, optionally with a first item (long press, the card's checkbox). */
  start(id?: Id): void;
  toggle(id: Id): void;
  /** Shift-click: select from the anchor to `id`. */
  extend(id: Id): void;
  set(ids: readonly Id[]): void;
  selectAll(): void;
  /** Empty the selection and leave selection mode. */
  clear(): void;
}

/** Selection over `ids` (the items currently shown, in display order). */
export function useSelection<Id extends string = string>(ids: readonly Id[]): Selection<Id> {
  const [state, dispatch] = useReducer(selectionReducer<Id>, EMPTY_SELECTION as SelectionState<Id>);
  const order = useMemo(() => ids.slice(), [ids]);
  const orderKey = order.join('\u0000');

  useEffect(() => {
    dispatch({ type: 'prune', order });
    // orderKey: prune only when the visible ids really change.
  }, [orderKey]);

  const selected = useMemo(() => order.filter((id) => state.selected.includes(id)), [order, state.selected]);
  const isSelected = useCallback((id: Id) => state.selected.includes(id), [state.selected]);
  const start = useCallback((id?: Id) => dispatch({ type: 'start', id }), []);
  const toggle = useCallback((id: Id) => dispatch({ type: 'toggle', id }), []);
  const extend = useCallback((id: Id) => dispatch({ type: 'range', id, order }), [order]);
  const set = useCallback((next: readonly Id[]) => dispatch({ type: 'set', ids: next }), []);
  const selectAll = useCallback(() => dispatch({ type: 'all', order }), [order]);
  const clear = useCallback(() => dispatch({ type: 'clear' }), []);

  return { selecting: state.selecting, selected, count: selected.length, isSelected, start, toggle, extend, set, selectAll, clear };
}
