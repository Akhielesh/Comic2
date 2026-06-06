// Live "agentic activity" state for generation (Sprint 1): the synchronous feed the user
// watches while the AI builds — coarse phases ("Designing…", "Writing files…") plus each file
// as it's written ("✎ /App.tsx" → "✓ /App.tsx 1.2 KB"). Driven by the SSE generate stream.
// Studio-scoped, dependency-free.

import { create } from 'zustand';

export type StudioActivityKind = 'phase' | 'file';
export type StudioFileState = 'writing' | 'written';
export type StudioActivityStatus = 'idle' | 'running' | 'done' | 'error';

export interface StudioActivityItem {
  id: string;
  kind: StudioActivityKind;
  /** Phase text, or the file path for file items. */
  label: string;
  path?: string;
  state?: StudioFileState;
  bytes?: number;
  ts: number;
}

interface ActivityState {
  status: StudioActivityStatus;
  collapsed: boolean;
  items: StudioActivityItem[];
  summary: string | null;

  begin: () => void;
  pushPhase: (label: string) => void;
  upsertFile: (f: { path: string; status: StudioFileState; bytes?: number }) => void;
  finish: (status: 'done' | 'error', summary: string) => void;
  setCollapsed: (collapsed: boolean) => void;
  reset: () => void;
}

let seq = 0;
const nextId = (): string => `a${Date.now().toString(36)}_${seq++}`;

/** Count of distinct files touched in the current run. */
export const fileCount = (items: StudioActivityItem[]): number =>
  items.filter((i) => i.kind === 'file').length;

export const useStudioActivity = create<ActivityState>((set) => ({
  status: 'idle',
  collapsed: false,
  items: [],
  summary: null,

  begin: () => set({ status: 'running', collapsed: false, items: [], summary: null }),

  pushPhase: (label) =>
    set((s) => {
      // Don't repeat an identical consecutive phase.
      const last = s.items[s.items.length - 1];
      if (last && last.kind === 'phase' && last.label === label) return s;
      return { items: [...s.items, { id: nextId(), kind: 'phase', label, ts: Date.now() }] };
    }),

  upsertFile: (f) =>
    set((s) => {
      const idx = s.items.findIndex((i) => i.kind === 'file' && i.path === f.path);
      if (idx === -1) {
        return {
          items: [
            ...s.items,
            { id: nextId(), kind: 'file', label: f.path, path: f.path, state: f.status, bytes: f.bytes, ts: Date.now() },
          ],
        };
      }
      const items = s.items.slice();
      items[idx] = { ...items[idx], state: f.status, bytes: f.bytes ?? items[idx].bytes };
      return { items };
    }),

  // On success, auto-collapse to the summary line (it "can be collapsed later"); keep errors open.
  finish: (status, summary) =>
    set({ status, summary, collapsed: status === 'done' }),

  setCollapsed: (collapsed) => set({ collapsed }),

  reset: () => set({ status: 'idle', collapsed: false, items: [], summary: null }),
}));
