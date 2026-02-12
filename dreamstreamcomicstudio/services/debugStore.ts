export type DebugChannel = 'gemini' | 'flux';

export type DebugState = {
  gemini: {
    keyPresent?: boolean;
    keySuffix?: string;
    keySource?: 'localStorage' | 'env' | 'none';
    lastRequestAt?: number;
    lastRequestType?: string;
    lastError?: string;
  };
  flux: {
    keyPresent?: boolean;
    keySuffix?: string;
    keySource?: 'localStorage' | 'env' | 'none';
    lastRequestAt?: number;
    lastRequestType?: string;
    lastError?: string;
  };
};

const state: DebugState = {
  gemini: {},
  flux: {}
};

const listeners = new Set<(next: DebugState) => void>();

const notify = () => {
  listeners.forEach((fn) => fn({ ...state, gemini: { ...state.gemini }, flux: { ...state.flux } }));
};

export const getDebugState = () => ({ ...state, gemini: { ...state.gemini }, flux: { ...state.flux } });

export const updateDebugState = (channel: DebugChannel, patch: Partial<DebugState[DebugChannel]>) => {
  state[channel] = { ...state[channel], ...patch };
  if (import.meta.env.DEV) {
    (globalThis as any).__debug = state;
  }
  notify();
};

export const subscribeDebugState = (fn: (next: DebugState) => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
