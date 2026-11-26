// The card the person is on in the board (SH-C2), kept outside React state. The shell tracks it (board/boardPart.ts
// useBoardPartTracker) but never reads it: only what shows it (the parts tree's current row, the breadcrumb's last
// crumb) subscribes, so moving between cards in a 200-page book re-renders those two and not the studio, the header,
// the strip or every page card. Light on purpose (no card components), so the breadcrumb and the panel can import it.

import { useSyncExternalStore } from 'react';
import type { BoardPart } from '../panel/partsModel';

export interface BoardPartStore {
  /** The card the person is on, or null (none, or bare board space). */
  get: () => BoardPart | null;
  set: (part: BoardPart | null) => void;
  subscribe: (listener: () => void) => () => void;
}

export const samePart = (a: BoardPart | null, b: BoardPart | null): boolean =>
  a === b || (!!a && !!b && a.kind === b.kind && (a.kind === 'cover' || (b.kind !== 'cover' && a.id === b.id)));

export const createBoardPartStore = (): BoardPartStore => {
  let part: BoardPart | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => part,
    set: (next) => {
      if (samePart(part, next)) return;
      part = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }
  };
};

const NONE = (): BoardPart | null => null;
const NO_SUBSCRIPTION = () => () => undefined;

/** The card the person is on, read where it shows; null without a store (a caller with no board). */
export function useBoardPart(store: BoardPartStore | null | undefined): BoardPart | null {
  return useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIPTION, store?.get ?? NONE, store?.get ?? NONE);
}
