// Live "agentic activity" state for generation (Sprint 1): the synchronous feed the user
// watches while the AI builds — coarse phases ("Designing…", "Writing files…") plus each file
// as it's written ("✎ /App.tsx" → "✓ /App.tsx 1.2 KB"). Driven by the SSE generate stream.
// Studio-scoped, dependency-free.

import { create } from 'zustand';

export type StudioActivityKind = 'phase' | 'file';
export type StudioFileState = 'writing' | 'written';
export type StudioFileChange = 'new' | 'modified';
export type StudioActivityStatus = 'idle' | 'running' | 'done' | 'error';

export interface StudioActivityItem {
  id: string;
  kind: StudioActivityKind;
  /** Phase text, or the file path for file items. */
  label: string;
  path?: string;
  state?: StudioFileState;
  bytes?: number;
  /** Whether this file is brand-new or an edit of an existing one (refine). */
  change?: StudioFileChange;
  /** Diff stats vs the pre-edit version (refine), filled in when the edit resolves. */
  added?: number;
  removed?: number;
  ts: number;
}

export interface UpsertFileInput {
  path: string;
  status: StudioFileState;
  bytes?: number;
  change?: StudioFileChange;
  added?: number;
  removed?: number;
}

interface ActivityState {
  status: StudioActivityStatus;
  collapsed: boolean;
  items: StudioActivityItem[];
  summary: string | null;
  /** Epoch ms when the run started / ended — drives the elapsed-time marker. */
  startedAt: number | null;
  endedAt: number | null;

  begin: () => void;
  pushPhase: (label: string) => void;
  upsertFile: (f: UpsertFileInput) => void;
  finish: (status: 'done' | 'error', summary: string) => void;
  setCollapsed: (collapsed: boolean) => void;
  reset: () => void;
}

let seq = 0;
const nextId = (): string => `a${Date.now().toString(36)}_${seq++}`;

/** Count of distinct files touched in the current run. */
export const fileCount = (items: StudioActivityItem[]): number =>
  items.filter((i) => i.kind === 'file').length;

/** Aggregate +added/−removed across all file items (for the header diff marker). */
export const diffTotals = (items: StudioActivityItem[]): { added: number; removed: number } =>
  items.reduce(
    (acc, i) => (i.kind === 'file' ? { added: acc.added + (i.added ?? 0), removed: acc.removed + (i.removed ?? 0) } : acc),
    { added: 0, removed: 0 }
  );

export const useStudioActivity = create<ActivityState>((set) => ({
  status: 'idle',
  // Compact by default: the header line already shows live progress ("Building · N files"
  // + spinner), so the detail pane never auto-expands and pushes the composer around.
  collapsed: true,
  items: [],
  summary: null,
  startedAt: null,
  endedAt: null,

  // Respect the user's expand/collapse choice across runs — starting a build must NOT
  // auto-expand the detail pane (explicit user feedback). They can open it any time.
  begin: () => set({ status: 'running', items: [], summary: null, startedAt: Date.now(), endedAt: null }),

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
            {
              id: nextId(), kind: 'file', label: f.path, path: f.path,
              state: f.status, bytes: f.bytes, change: f.change, added: f.added, removed: f.removed,
              ts: Date.now(),
            },
          ],
        };
      }
      const items = s.items.slice();
      const prev = items[idx];
      items[idx] = {
        ...prev,
        state: f.status,
        bytes: f.bytes ?? prev.bytes,
        change: f.change ?? prev.change,
        added: f.added ?? prev.added,
        removed: f.removed ?? prev.removed,
      };
      return { items };
    }),

  // Finishing never yanks the pane around either: success keeps whatever state the user
  // chose (the summary line tells the story), and only a FAILURE auto-expands — that's
  // the one moment the detail genuinely needs attention.
  finish: (status, summary) =>
    set((s) => ({ status, summary, collapsed: status === 'error' ? false : s.collapsed, endedAt: Date.now() })),

  setCollapsed: (collapsed) => set({ collapsed }),

  reset: () => set((s) => ({ status: 'idle', collapsed: s.collapsed, items: [], summary: null, startedAt: null, endedAt: null })),
}));
