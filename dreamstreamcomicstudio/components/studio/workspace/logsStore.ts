// Studio logs (Sprint 1, S1.5): a capped buffer of console/run lifecycle lines. The Run
// action pushes lifecycle entries now; the worker's streamed install/dev/runtime logs feed
// in here once that wiring lands.

import { create } from 'zustand';

export type LogLevel = 'system' | 'info' | 'warn' | 'error' | 'success';

export interface LogEntry {
  id: number;
  level: LogLevel;
  text: string;
  ts: number;
}

// Keep a deep buffer so the FULL console is available to read + analyze (not just recent lines).
export const MAX_LOG_ENTRIES = 5000;

let seq = 0;
/** Reset the id sequence (tests only). */
export const __resetLogSeq = () => { seq = 0; };

interface LogsState {
  entries: LogEntry[];
  append: (level: LogLevel, text: string) => void;
  clear: () => void;
}

export const useStudioLogs = create<LogsState>((set) => ({
  entries: [],
  append: (level, text) => set((s) => {
    const next = [...s.entries, { id: ++seq, level, text, ts: Date.now() }];
    return { entries: next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next };
  }),
  clear: () => set({ entries: [] }),
}));
