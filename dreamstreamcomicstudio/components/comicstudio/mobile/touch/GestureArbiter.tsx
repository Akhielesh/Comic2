// GestureArbiter (mobile.md §5.2): one gesture owner at a time on a canvas.
//
// A balloon drag or a Mark-up box `claim`s the arbiter with a CANCEL callback (revert the draft,
// commit nothing). When a second finger lands, TouchCanvas `preempt`s: the current owner's cancel
// runs and the pinch takes over — fixing "pointercancel commits a half-dragged balloon". Pen
// activity is tracked here too, for palm rejection.

import React, { createContext, useContext, useMemo } from 'react';
import { isPalmTouch } from './pointerPolicy';

export interface GestureArbiterApi {
  /** Take ownership; returns a token for release(). An existing owner is preempted. */
  claim(owner: string, cancel: () => void): number;
  /** Give ownership back (no cancel). Stale tokens are ignored. */
  release(token: number): void;
  /** Cancel the current owner (its draft reverts) so `by` can take over. True when someone was cancelled. */
  preempt(by: string): boolean;
  /** Current owner name, or null. */
  current(): string | null;
  /** Pen down/up (palm rejection). */
  notePen(down: boolean, at?: number): void;
  /** Is this pointer the palm resting while a pen draws? */
  isPalm(pointerType: string, at?: number): boolean;
}

export const createGestureArbiter = (): GestureArbiterApi => {
  let owner: { token: number; name: string; cancel: () => void } | null = null;
  let seq = 0;
  let penDown = false;
  let lastPenUpAt = -Infinity;
  const api: GestureArbiterApi = {
    claim(name, cancel) {
      if (owner) api.preempt(name);
      seq += 1;
      owner = { token: seq, name, cancel };
      return seq;
    },
    release(token) {
      if (owner && owner.token === token) owner = null;
    },
    preempt() {
      if (!owner) return false;
      const { cancel } = owner;
      owner = null;
      try {
        cancel();
      } catch (err) {
        console.error('[comicstudio] gesture cancel failed', err);
      }
      return true;
    },
    current: () => owner?.name ?? null,
    notePen(down, at = Date.now()) {
      penDown = down;
      if (!down) lastPenUpAt = at;
    },
    isPalm: (pointerType, at = Date.now()) => isPalmTouch(pointerType, penDown, lastPenUpAt, at)
  };
  return api;
};

/** Outside any TouchCanvas, gestures still arbitrate against each other through this default. */
const defaultArbiter = createGestureArbiter();

export const GestureArbiterContext = createContext<GestureArbiterApi>(defaultArbiter);

export const useGestureArbiter = (): GestureArbiterApi => useContext(GestureArbiterContext);

/** A fresh arbiter for a subtree (TouchCanvas mounts one per canvas). */
export const GestureArbiterProvider: React.FC<{ children: React.ReactNode; arbiter?: GestureArbiterApi }> = ({ children, arbiter }) => {
  const value = useMemo(() => arbiter ?? createGestureArbiter(), [arbiter]);
  return <GestureArbiterContext.Provider value={value}>{children}</GestureArbiterContext.Provider>;
};

export default GestureArbiterProvider;
