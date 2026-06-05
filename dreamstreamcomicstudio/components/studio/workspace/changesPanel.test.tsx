import React from 'react';
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ChangesPanel } from './ChangesPanel';
import { useStudioWorkspace } from './workspaceStore';
import type { CodeStudioArtifact } from '../../../apiTypes';

const artifact: CodeStudioArtifact = {
  title: 'Demo', template: 'react-ts',
  files: [{ path: '/index.tsx', content: 'hello' }, { path: '/App.tsx', content: 'app' }],
};

beforeEach(() => useStudioWorkspace.getState().reset());

describe('ChangesPanel', () => {
  it('renders nothing when there are no changes', () => {
    useStudioWorkspace.getState().loadArtifact(artifact);
    const { container } = render(<ChangesPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists dirty files and reverts them', () => {
    const ws = useStudioWorkspace.getState();
    ws.loadArtifact(artifact);
    ws.updateContent('/index.tsx', 'hello world');
    render(<ChangesPanel />);
    expect(screen.getByText('index.tsx')).toBeInTheDocument();
    // revert all → working copy matches baseline → panel disappears
    fireEvent.click(screen.getByTitle(/Revert all/i));
    expect(screen.queryByText('index.tsx')).not.toBeInTheDocument();
    expect(useStudioWorkspace.getState().files['/index.tsx']).toBe('hello');
  });
});
