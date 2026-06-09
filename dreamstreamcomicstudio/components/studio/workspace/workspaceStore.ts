// Code Studio workspace state (Sprint 1).
//
// The single source of truth for the editor: the working copy of every file, which tabs are
// open, the active tab, and per-file dirty state (working copy vs. the loaded baseline). Kept
// in a zustand store so the editor, tabs, file tree, run action and (later) the command
// palette all read/write the same state without prop-drilling.

import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
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
  /** Persisted project id (set when opening a saved project or after a Build). */
  projectId: string | null;
  /** Client-generated session id for the current editing session. */
  sessionId: string | null;
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
  /** Create a new file (opens it). No-op if it already exists. */
  addFile: (path: string, content?: string) => void;
  /** Delete a file (closes its tab; focuses a neighbour). */
  deleteFile: (path: string) => void;
  /** Rename a file, preserving content + dirty state. No-op if the target exists. */
  renameFile: (from: string, to: string) => void;
  /** Set the persisted project id (e.g. from a Build's start event). */
  setProjectId: (id: string | null) => void;
  /** Set the project + session id together (a brand-new project identity). */
  setIdentity: (projectId: string, sessionId: string) => void;
  /** Replace the whole file set as a fresh clean baseline (e.g. restoring a version). */
  replaceFiles: (files: { path: string; content: string }[]) => void;
  /** Clear everything. */
  reset: () => void;
}

/** Normalise a studio file path: leading slash, collapsed slashes, no traversal. '' if invalid. */
export const normalizeStudioPath = (raw: string): string => {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  const path = ('/' + trimmed.replace(/^\/+/, '')).replace(/\/{2,}/g, '/').replace(/\/$/, '');
  const segs = path.split('/').filter(Boolean);
  if (segs.length === 0) return '';
  if (segs.some((s) => s === '.' || s === '..')) return '';
  return '/' + segs.join('/');
};

/** Resolve a new base-name within the same directory as `path`. */
export const renameInDir = (path: string, newName: string): string => {
  const dir = path.slice(0, path.lastIndexOf('/'));
  return normalizeStudioPath(`${dir}/${newName.trim()}`);
};

// Persisted to sessionStorage (continuity, not durability): a reload — F5, Chrome
// discarding the background tab, a crashed renderer — restores the working copy, open
// tabs and session identity instead of dumping the user back on the start screen with
// their in-progress app gone. Session-scoped on purpose: closing the tab still starts
// clean, and projects' durable home remains the server (saved on Build).
export const useStudioWorkspace = create<WorkspaceState>()(persist((set, get) => ({
  loadedKey: null,
  projectId: null,
  sessionId: null,
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
      projectId: (artifact as { id?: string }).id ?? null,
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

  addFile: (rawPath, content = '') => set((s) => {
    const path = normalizeStudioPath(rawPath);
    if (!path || s.files[path] !== undefined) return s;
    return {
      files: { ...s.files, [path]: content },
      paths: [...s.paths, path].sort((a, b) => a.localeCompare(b)),
      openPaths: s.openPaths.includes(path) ? s.openPaths : [...s.openPaths, path],
      activePath: path,
    };
  }),

  deleteFile: (path) => set((s) => {
    if (s.files[path] === undefined) return s;
    const files = { ...s.files }; delete files[path];
    const baseline = { ...s.baseline }; delete baseline[path];
    const idx = s.openPaths.indexOf(path);
    const openPaths = s.openPaths.filter((p) => p !== path);
    let activePath = s.activePath;
    if (s.activePath === path) activePath = openPaths[Math.min(idx, openPaths.length - 1)] ?? null;
    return { files, baseline, paths: s.paths.filter((p) => p !== path), openPaths, activePath };
  }),

  renameFile: (from, to) => set((s) => {
    const next = normalizeStudioPath(to);
    if (s.files[from] === undefined || !next || next === from || s.files[next] !== undefined) return s;
    const files = { ...s.files }; files[next] = files[from]; delete files[from];
    const baseline = { ...s.baseline };
    if (baseline[from] !== undefined) { baseline[next] = baseline[from]; delete baseline[from]; }
    return {
      files,
      baseline,
      paths: s.paths.filter((p) => p !== from).concat(next).sort((a, b) => a.localeCompare(b)),
      openPaths: s.openPaths.map((p) => (p === from ? next : p)),
      activePath: s.activePath === from ? next : s.activePath,
    };
  }),

  setProjectId: (id) => set({ projectId: id }),
  setIdentity: (projectId, sessionId) => set({ projectId, sessionId }),

  replaceFiles: (fileArr) => set((s) => {
    const files: Record<string, string> = {};
    const paths: string[] = [];
    for (const f of fileArr) { files[f.path] = f.content; paths.push(f.path); }
    paths.sort((a, b) => a.localeCompare(b));
    const entry = pickEntry(paths);
    return {
      files,
      baseline: { ...files },
      paths,
      openPaths: entry ? [entry] : [],
      activePath: entry,
      loadedKey: `${s.title}::restore::${Date.now()}`,
    };
  }),

  reset: () => set({ loadedKey: null, projectId: null, sessionId: null, title: '', template: 'react-ts', files: {}, baseline: {}, paths: [], openPaths: [], activePath: null }),
}), {
  name: 'dreamstream_studio_workspace',
  storage: createJSONStorage(() => sessionStorage),
  partialize: (s) => ({
    loadedKey: s.loadedKey,
    projectId: s.projectId,
    sessionId: s.sessionId,
    title: s.title,
    template: s.template,
    files: s.files,
    baseline: s.baseline,
    paths: s.paths,
    openPaths: s.openPaths,
    activePath: s.activePath,
  }),
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
