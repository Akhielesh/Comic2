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
  getStudioStatus: vi.fn(async () => ({ liveConfigured: false })),
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
vi.mock('../../services/studioGenerateApi', () => ({
  generateStudioApp: vi.fn(async () => ({ title: 'P', template: 'react-ts', files: [] })),
  streamGenerateStudioApp: vi.fn(async () => {}),
}));
vi.mock('../../services/studioAgentsApi', () => ({
  streamStudioAgents: vi.fn(async () => {}),
}));
vi.mock('../../services/studioPlanApi', () => ({
  clarifyStudioApp: vi.fn(async () => ({ questions: [], assumptions: [] })),
  planStudioApp: vi.fn(async () => ({ title: 'P', summary: '', appType: '', stack: [], features: ['x'], files: [] })),
}));
// Monaco loads from a CDN at runtime — stub it so the editor renders synchronously in jsdom.
vi.mock('@monaco-editor/react', () => ({
  __esModule: true,
  default: (props: { value?: string }) => <textarea data-testid="monaco" defaultValue={props.value} />,
}));

import { CodeStudioView } from './CodeStudioView';
import { useStudioWorkspace } from './workspace';
import { useStudioFocus } from './kit';

beforeEach(() => {
  useStudioWorkspace.getState().reset();
  useStudioFocus.setState({ focus: 'preview' }); // default right-pane view
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
  it('renders the 30/70 workspace shell for admins (preview by default + a Code/Preview toggle)', () => {
    render(<CodeStudioView artifact={artifact} isAdmin onBack={vi.fn()} onNavigate={vi.fn()} />);
    // The right (70%) pane defaults to the live Preview.
    expect(screen.getByText('Live preview')).toBeInTheDocument();
    // The two-view toggle is present (it controls the right pane — no third "split" column).
    expect(screen.getAllByRole('radio', { name: /preview view/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('radio', { name: /code view/i }).length).toBeGreaterThan(0);
    // Hand-off project name.
    expect(screen.getByText('Counter App')).toBeInTheDocument();
    // Back is contextual — with a project open it returns to the projects list.
    expect(screen.getByRole('button', { name: /projects/i })).toBeInTheDocument();
    // There is no redundant top "Build" button (building happens via the prompt).
    expect(screen.queryByRole('button', { name: /^build$/i })).not.toBeInTheDocument();
    // Admins aren't shown the instant-preview notice.
    expect(screen.queryByText(/your app runs right here in the browser/i)).not.toBeInTheDocument();
  });

  it('toggling to the Code view reveals the editor + file tree', () => {
    useStudioFocus.setState({ focus: 'code' });
    render(<CodeStudioView artifact={artifact} isAdmin onBack={vi.fn()} onNavigate={vi.fn()} />);
    // The file explorer only renders in the Code view (App.tsx also appears as an editor tab).
    expect(screen.getAllByText('App.tsx').length).toBeGreaterThan(0);
    expect(screen.getByText('index.tsx')).toBeInTheDocument();
  });

  it('gates non-admins behind a private-preview notice with Run live disabled', () => {
    render(<CodeStudioView artifact={null} isAdmin={false} onBack={vi.fn()} onNavigate={vi.fn()} />);
    // Non-admins build with the instant in-browser preview; there's no top "Build" button.
    expect(screen.getByText(/your app runs right here in the browser/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^build$/i })).not.toBeInTheDocument();
  });

  it('shows the projects start screen when nothing is loaded (Run live disabled)', () => {
    render(<CodeStudioView artifact={null} isAdmin onBack={vi.fn()} onNavigate={vi.fn()} />);
    expect(screen.getByText('Your projects')).toBeInTheDocument();
    // No top "Build" button — building happens through the prompt.
    expect(screen.queryByRole('button', { name: /^build$/i })).not.toBeInTheDocument();
  });
});
