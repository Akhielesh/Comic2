// Agentic build trace state (Sprint 2): the live plan→run→observe→fix→done timeline streamed
// from /api/studio/build. Drives the BuildTrace UI and feeds the run status + logs.

import { create } from 'zustand';
import type { BuildEvent, BuildResult, BuildStage } from '../../../services/studioBuildApi';

interface BuildState {
  running: boolean;
  stage: BuildStage | 'idle';
  iteration: number;
  events: BuildEvent[];
  result: BuildResult | null;
  error: string | null;

  begin: () => void;
  pushEvent: (e: BuildEvent) => void;
  finish: (r: BuildResult) => void;
  fail: (message: string) => void;
  reset: () => void;
}

export const useStudioBuild = create<BuildState>((set) => ({
  running: false,
  stage: 'idle',
  iteration: 0,
  events: [],
  result: null,
  error: null,

  begin: () => set({ running: true, stage: 'plan', iteration: 0, events: [], result: null, error: null }),
  pushEvent: (e) => set((s) => ({ events: [...s.events, e], stage: e.stage, iteration: e.iteration })),
  finish: (r) => set({ running: false, result: r, stage: 'done', error: r.ok ? null : (r.reason || null) }),
  fail: (message) => set({ running: false, error: message, stage: 'stopped' }),
  reset: () => set({ running: false, stage: 'idle', iteration: 0, events: [], result: null, error: null }),
}));
