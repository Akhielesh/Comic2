import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const listStudioVersions = vi.fn();
const getStudioVersionFiles = vi.fn();
vi.mock('../../../services/studioApi', () => ({
  listStudioVersions: (...a: unknown[]) => listStudioVersions(...a),
  getStudioVersionFiles: (...a: unknown[]) => getStudioVersionFiles(...a),
}));

import { HistoryPanel } from './HistoryPanel';
import { useStudioWorkspace } from './workspaceStore';

beforeEach(() => {
  vi.clearAllMocks();
  useStudioWorkspace.getState().reset();
});

describe('HistoryPanel', () => {
  it('prompts to Build when no project is loaded', () => {
    render(<HistoryPanel />);
    expect(screen.getByText(/appear after your first build/i)).toBeInTheDocument();
    expect(listStudioVersions).not.toHaveBeenCalled();
  });

  it('lists versions when expanded and restores one into the workspace', async () => {
    useStudioWorkspace.getState().setProjectId('p1');
    listStudioVersions.mockResolvedValue([
      { id: 'v1', label: 'agentic build', createdBy: 'agent', createdAt: new Date().toISOString() },
    ]);
    getStudioVersionFiles.mockResolvedValue([{ path: '/A.tsx', content: 'AA' }]);

    render(<HistoryPanel />);
    fireEvent.click(screen.getByRole('button', { name: /history/i })); // expand
    expect(await screen.findByText('agentic build')).toBeInTheDocument();
    await waitFor(() => expect(listStudioVersions).toHaveBeenCalledWith('p1'));

    fireEvent.click(screen.getByRole('button', { name: /restore/i }));
    await waitFor(() => expect(getStudioVersionFiles).toHaveBeenCalledWith('p1', 'v1'));
    await waitFor(() => expect(useStudioWorkspace.getState().paths).toContain('/A.tsx'));
  });
});
