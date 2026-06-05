// S0.4 acceptance: the Code Studio route renders the workspace shell for admins and shows a
// gated private-preview state for everyone else.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { CodeStudioArtifact } from '../../apiTypes';

// Isolate the view from the API client (which constructs a Supabase client at import time
// and throws when env is unset). We only need the launch/stop + projects signatures here.
vi.mock('../../services/studioApi', () => ({
  launchLiveStudio: vi.fn(async () => ({ sandboxId: 's', projectId: 'p' })),
  stopLiveStudio: vi.fn(async () => ({ status: 'stopped' })),
  listStudioProjects: vi.fn(async () => []),
  getStudioProject: vi.fn(async () => ({ id: 'p', title: 'P', template: 'react-ts', files: [] })),
  deleteStudioProject: vi.fn(async () => {}),
  listStudioVersions: vi.fn(async () => []),
  getStudioVersionFiles: vi.fn(async () => []),
}));
vi.mock('../../services/studioLauncher', () => ({
  downloadArtifactZip: vi.fn(async () => {}),
}));
vi.mock('../../services/studioBuildApi', () => ({
  streamStudioBuild: vi.fn(async () => {}),
}));
// Monaco loads from a CDN at runtime — stub it so the editor renders synchronously in jsdom.
vi.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: (props: { value?: string }) => <textarea data-testid="monaco" defaultValue={props.value} />,
}));

import { CodeStudioView } from './CodeStudioView';
import { useStudioWorkspace } from './workspace';

beforeEach(() => {
  useStudioWorkspace.getState().reset();
});

const artifact: CodeStudioArtifact = {
  title: 'Counter App',
  description: 'A tiny counter',
  template: 'react-ts',
  files: [
    { path: '/App.tsx', content: 'export const App = () => <div>hi</div>;' },
    { path: '/index.tsx', content: 'console.log("boot")' },
  ],
};

describe('CodeStudioView', () => {
  it('renders the workspace shell for admins (Run live enabled, files listed)', () => {
    render(<CodeStudioView artifact={artifact} isAdmin onBack={vi.fn()} onNavigate={vi.fn()} />);
    // Shell panes
    expect(screen.getByText('Code')).toBeInTheDocument();
    expect(screen.getByText('Live preview')).toBeInTheDocument();
    // Hand-off project name + files from the explorer tree (App.tsx also appears as a tab)
    expect(screen.getByText('Counter App')).toBeInTheDocument();
    expect(screen.getAllByText('App.tsx').length).toBeGreaterThan(0);
    expect(screen.getByText('index.tsx')).toBeInTheDocument();
    // Run live is available to admins and not gated
    expect(screen.getByRole('button', { name: /^build$/i })).toBeEnabled();
    expect(screen.queryByText(/private preview/i)).not.toBeInTheDocument();
  });

  it('gates non-admins behind a private-preview notice with Run live disabled', () => {
    render(<CodeStudioView artifact={null} isAdmin={false} onBack={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByText(/private preview/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^build$/i })).toBeDisabled();
  });

  it('shows the projects start screen when nothing is loaded (Run live disabled)', () => {
    render(<CodeStudioView artifact={null} isAdmin onBack={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByText('Your projects')).toBeInTheDocument();
    // Run live is disabled until an app is loaded
    expect(screen.getByRole('button', { name: /^build$/i })).toBeDisabled();
  });
});
