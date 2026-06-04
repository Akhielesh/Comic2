export type DebugChannel = 'gemini' | 'flux' | 'ideogram';

type DebugChannelState = {
  keyPresent?: boolean;
  keySuffix?: string;
  keySource?: 'localStorage' | 'env' | 'none';
  lastRequestAt?: number;
  lastRequestType?: string;
  lastError?: string;
};

export type DebugState = {
  gemini: DebugChannelState;
  flux: DebugChannelState;
  ideogram: DebugChannelState;
};

const state: DebugState = {
  gemini: {},
  flux: {},
  ideogram: {}
};

const listeners = new Set<(next: DebugState) => void>();

const snapshot = (): DebugState => ({
  gemini: { ...state.gemini },
  flux: { ...state.flux },
  ideogram: { ...state.ideogram }
});

const notify = () => {
  listeners.forEach((fn) => fn(snapshot()));
};

export const getDebugState = () => snapshot();

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
