// Pure-logic coverage for the workspace store (Sprint 1): tree building, dirty detection,
// working-copy → artifact, and the store's open/close/edit lifecycle.

import { describe, it, expect, beforeEach } from 'vitest';
import { useStudioWorkspace, isPathDirty, dirtyPaths, workspaceToArtifact, normalizeStudioPath, renameInDir } from './workspaceStore';
import { buildTree } from './FileTree';
import type { CodeStudioArtifact } from '../../../apiTypes';

const artifact: CodeStudioArtifact = {
  title: 'Demo',
  template: 'react-ts',
  files: [
    { path: '/src/App.tsx', content: 'A' },
    { path: '/src/components/Button.tsx', content: 'B' },
    { path: '/index.tsx', content: 'I' },
    { path: '/package.json', content: '{}' },
  ],
};

describe('buildTree', () => {
  it('nests files under folders, folders before files', () => {
    const root = buildTree(['/src/App.tsx', '/src/components/Button.tsx', '/index.tsx', '/package.json']);
    const names = root.children.map((c) => `${c.name}${c.isFile ? '' : '/'}`);
    // folder "src" first, then the two root files alphabetically
    expect(names).toEqual(['src/', 'index.tsx', 'package.json']);
    const src = root.children.find((c) => c.name === 'src')!;
    expect(src.isFile).toBe(false);
    expect(src.children.map((c) => c.name)).toContain('App.tsx');
    // nested folder
    const comp = src.children.find((c) => c.name === 'components')!;
    expect(comp.children[0].path).toBe('/src/components/Button.tsx');
  });
});

describe('workspace store lifecycle', () => {
  beforeEach(() => useStudioWorkspace.getState().reset());

  it('loads an artifact and opens a sensible entry file', () => {
    useStudioWorkspace.getState().loadArtifact(artifact);
    const s = useStudioWorkspace.getState();
    expect(s.paths.length).toBe(4);
    expect(s.activePath).toBe('/index.tsx'); // index entry preferred, sorts before /src
    expect(s.openPaths).toEqual(['/index.tsx']);
  });

  it('is idempotent for the same artifact (keeps edits)', () => {
    const ws = useStudioWorkspace.getState();
    ws.loadArtifact(artifact);
    ws.updateContent('/index.tsx', 'EDITED');
    ws.loadArtifact(artifact); // same key → no reload
    expect(useStudioWorkspace.getState().files['/index.tsx']).toBe('EDITED');
  });

  it('tracks dirty files against the baseline', () => {
    const ws = useStudioWorkspace.getState();
    ws.loadArtifact(artifact);
    expect(dirtyPaths(useStudioWorkspace.getState())).toEqual([]);
    ws.updateContent('/src/App.tsx', 'A-edited');
    const s = useStudioWorkspace.getState();
    expect(isPathDirty(s, '/src/App.tsx')).toBe(true);
    expect(dirtyPaths(s)).toEqual(['/src/App.tsx']);
    ws.revertFile('/src/App.tsx');
    expect(isPathDirty(useStudioWorkspace.getState(), '/src/App.tsx')).toBe(false);
  });

  it('opens and closes tabs, refocusing a neighbour', () => {
    const ws = useStudioWorkspace.getState();
    ws.loadArtifact(artifact);
    ws.openFile('/src/App.tsx');
    ws.openFile('/package.json');
    expect(useStudioWorkspace.getState().openPaths).toEqual(['/index.tsx', '/src/App.tsx', '/package.json']);
    ws.closeFile('/package.json');
    const s = useStudioWorkspace.getState();
    expect(s.openPaths).toEqual(['/index.tsx', '/src/App.tsx']);
    expect(s.activePath).toBe('/src/App.tsx'); // focus fell back to neighbour
  });

  it('builds an artifact from the working copy', () => {
    const ws = useStudioWorkspace.getState();
    ws.loadArtifact(artifact);
    ws.updateContent('/index.tsx', 'NEW');
    const out = workspaceToArtifact(artifact, useStudioWorkspace.getState());
    expect(out.files.find((f) => f.path === '/index.tsx')?.content).toBe('NEW');
    expect(out.files.length).toBe(4);
    expect(out.title).toBe('Demo');
  });
});

describe('path helpers', () => {
  it('normalizeStudioPath cleans + rejects traversal', () => {
    expect(normalizeStudioPath('src/App.tsx')).toBe('/src/App.tsx');
    expect(normalizeStudioPath('//a///b.tsx')).toBe('/a/b.tsx');
    expect(normalizeStudioPath('../secret')).toBe('');
    expect(normalizeStudioPath('  ')).toBe('');
  });
  it('renameInDir keeps the directory', () => {
    expect(renameInDir('/src/components/Button.tsx', 'Card.tsx')).toBe('/src/components/Card.tsx');
    expect(renameInDir('/index.tsx', 'main.tsx')).toBe('/main.tsx');
  });
});

describe('file ops', () => {
  beforeEach(() => useStudioWorkspace.getState().reset());

  it('adds a new file and focuses it', () => {
    const ws = useStudioWorkspace.getState();
    ws.loadArtifact(artifact);
    ws.addFile('src/New.tsx', 'export const N = 1;');
    const s = useStudioWorkspace.getState();
    expect(s.paths).toContain('/src/New.tsx');
    expect(s.activePath).toBe('/src/New.tsx');
    expect(s.files['/src/New.tsx']).toBe('export const N = 1;');
  });

  it('does not overwrite an existing file', () => {
    const ws = useStudioWorkspace.getState();
    ws.loadArtifact(artifact);
    ws.addFile('/index.tsx', 'X');
    expect(useStudioWorkspace.getState().files['/index.tsx']).toBe('I'); // unchanged
  });

  it('deletes a file and refocuses', () => {
    const ws = useStudioWorkspace.getState();
    ws.loadArtifact(artifact);
    ws.openFile('/src/App.tsx');
    ws.deleteFile('/src/App.tsx');
    const s = useStudioWorkspace.getState();
    expect(s.paths).not.toContain('/src/App.tsx');
    expect(s.files['/src/App.tsx']).toBeUndefined();
    expect(s.activePath).not.toBe('/src/App.tsx');
  });

  it('renames a file, preserving content + tabs', () => {
    const ws = useStudioWorkspace.getState();
    ws.loadArtifact(artifact);
    ws.openFile('/src/App.tsx');
    ws.renameFile('/src/App.tsx', '/src/Main.tsx');
    const s = useStudioWorkspace.getState();
    expect(s.files['/src/Main.tsx']).toBe('A');
    expect(s.files['/src/App.tsx']).toBeUndefined();
    expect(s.openPaths).toContain('/src/Main.tsx');
    expect(s.activePath).toBe('/src/Main.tsx');
  });

  it('rename is a no-op when the target already exists', () => {
    const ws = useStudioWorkspace.getState();
    ws.loadArtifact(artifact);
    ws.renameFile('/src/App.tsx', '/index.tsx');
    const s = useStudioWorkspace.getState();
    expect(s.files['/src/App.tsx']).toBe('A'); // unchanged
    expect(s.files['/index.tsx']).toBe('I');
  });
});

describe('project id + restore', () => {
  beforeEach(() => useStudioWorkspace.getState().reset());

  it('loadArtifact picks up an id when present', () => {
    useStudioWorkspace.getState().loadArtifact({ ...artifact, id: 'proj-1' } as CodeStudioArtifact & { id: string });
    expect(useStudioWorkspace.getState().projectId).toBe('proj-1');
  });

  it('setProjectId updates the id', () => {
    useStudioWorkspace.getState().setProjectId('proj-2');
    expect(useStudioWorkspace.getState().projectId).toBe('proj-2');
  });

  it('replaceFiles swaps the file set as a clean baseline', () => {
    const ws = useStudioWorkspace.getState();
    ws.loadArtifact(artifact);
    ws.updateContent('/index.tsx', 'edited');
    ws.replaceFiles([{ path: '/only.tsx', content: 'X' }]);
    const s = useStudioWorkspace.getState();
    expect(s.paths).toEqual(['/only.tsx']);
    expect(s.files['/only.tsx']).toBe('X');
    expect(dirtyPaths(s)).toEqual([]); // restored = clean
    expect(s.activePath).toBe('/only.tsx');
  });
});
