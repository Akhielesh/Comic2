// Code Studio workspace state (Sprint 1).
//
// The single source of truth for the editor: the working copy of every file, which tabs are
// open, the active tab, and per-file dirty state (working copy vs. the loaded baseline). Kept
// in a zustand store so the editor, tabs, file tree, run action and (later) the command
// palette all read/write the same state without prop-drilling.

import { create } from 'zustand';
import type { CodeStudioArtifact } from '../../../apiTypes';

const PREFERRED_ENTRY = /\/(App|index|main)\.(t|j)sx?$/;

/** Pick a sensible first file to open (an App/index/main entry, else the first file). */
const pickEntry = (paths: string[]): string | null => {
  if (paths.length === 0) return null;
  return paths.find((p) => PREFERRED_ENTRY.test(p)) ?? paths.find((p) => /\.(t|j)sx?$/.test(p)) ?? paths[0];
};

interface WorkspaceState {
  /** Loaded artifact id-ish (title) so we only reload on a genuinely new app. */
  loadedKey: string | null;
  /** Project name of the loaded app. */
  title: string;
  /** Template of the loaded app (drives the runtime). */
  template: CodeStudioArtifact['template'];
  /** Working copy: path → current content. */
  files: Record<string, string>;
  /** Baseline content per path (for dirty detection). */
  baseline: Record<string, string>;
  /** Ordered list of file paths present (for the tree). */
  paths: string[];
  /** Open tab paths, in tab order. */
  openPaths: string[];
  /** The focused tab. */
  activePath: string | null;

  /** Load an artifact's files as the working copy (no-op if already loaded). */
  loadArtifact: (artifact: CodeStudioArtifact) => void;
  /** Open a file in a tab (and focus it). */
  openFile: (path: string) => void;
  /** Close a tab; focus a neighbour. */
  closeFile: (path: string) => void;
  /** Focus an open tab. */
  setActive: (path: string) => void;
  /** Edit a file's working copy. */
  updateContent: (path: string, content: string) => void;
  /** Revert a file to its baseline. */
  revertFile: (path: string) => void;
  /** Clear everything. */
  reset: () => void;
}

export const useStudioWorkspace = create<WorkspaceState>((set, get) => ({
  loadedKey: null,
  title: '',
  template: 'react-ts',
  files: {},
  baseline: {},
  paths: [],
  openPaths: [],
  activePath: null,

  loadArtifact: (artifact) => {
    const key = `${artifact.title}::${artifact.files.length}`;
    if (get().loadedKey === key) return;
    const files: Record<string, string> = {};
    const paths: string[] = [];
    for (const f of artifact.files) {
      files[f.path] = f.content;
      paths.push(f.path);
    }
    paths.sort((a, b) => a.localeCompare(b));
    const entry = pickEntry(paths);
    set({
      loadedKey: key,
      title: artifact.title,
      template: artifact.template,
      files,
      baseline: { ...files },
      paths,
      openPaths: entry ? [entry] : [],
      activePath: entry,
    });
  },

  openFile: (path) => set((s) => ({
    openPaths: s.openPaths.includes(path) ? s.openPaths : [...s.openPaths, path],
    activePath: path,
  })),

  closeFile: (path) => set((s) => {
    const idx = s.openPaths.indexOf(path);
    const openPaths = s.openPaths.filter((p) => p !== path);
    let activePath = s.activePath;
    if (s.activePath === path) {
      activePath = openPaths[Math.min(idx, openPaths.length - 1)] ?? null;
    }
    return { openPaths, activePath };
  }),

  setActive: (path) => set({ activePath: path }),

  updateContent: (path, content) => set((s) => ({ files: { ...s.files, [path]: content } })),

  revertFile: (path) => set((s) => ({
    files: { ...s.files, [path]: s.baseline[path] ?? s.files[path] },
  })),

  reset: () => set({ loadedKey: null, title: '', template: 'react-ts', files: {}, baseline: {}, paths: [], openPaths: [], activePath: null }),
}));

// ---- Pure selectors / helpers (unit-testable without React) ----------------------------

export const isPathDirty = (s: Pick<WorkspaceState, 'files' | 'baseline'>, path: string): boolean =>
  (s.files[path] ?? '') !== (s.baseline[path] ?? '');

export const dirtyPaths = (s: Pick<WorkspaceState, 'files' | 'baseline' | 'paths'>): string[] =>
  s.paths.filter((p) => isPathDirty(s, p));

/** Build an artifact from the current working copy (so edits are what get run). */
export const workspaceToArtifact = (
  base: CodeStudioArtifact,
  s: Pick<WorkspaceState, 'files' | 'paths'>
): CodeStudioArtifact => ({
  ...base,
  files: s.paths.map((path) => ({ path, content: s.files[path] ?? '' })),
});

/** Build a runnable artifact purely from the store (title/template + working copy). */
export const workspaceCurrentArtifact = (
  s: Pick<WorkspaceState, 'title' | 'template' | 'files' | 'paths'>
): CodeStudioArtifact => ({
  title: s.title || 'Untitled project',
  template: s.template,
  files: s.paths.map((path) => ({ path, content: s.files[path] ?? '' })),
});
