// StudioStart coverage (S1.7): lists saved projects, opens one into the workspace, deletes one.

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const listStudioProjects = vi.fn();
const getStudioProject = vi.fn();
const deleteStudioProject = vi.fn();

vi.mock('../../services/studioApi', () => ({
  listStudioProjects: (...a: unknown[]) => listStudioProjects(...a),
  getStudioProject: (...a: unknown[]) => getStudioProject(...a),
  deleteStudioProject: (...a: unknown[]) => deleteStudioProject(...a),
}));

import { StudioStart } from './StudioStart';
import { useStudioWorkspace } from './workspace';

beforeEach(() => {
  vi.clearAllMocks();
  useStudioWorkspace.getState().reset();
  listStudioProjects.mockResolvedValue([
    { id: 'p1', name: 'My Todo App', template: 'react-ts', updatedAt: new Date().toISOString() },
  ]);
  getStudioProject.mockResolvedValue({
    id: 'p1', title: 'My Todo App', template: 'react-ts',
    files: [{ path: '/App.tsx', content: 'export default 1' }],
  });
  deleteStudioProject.mockResolvedValue(undefined);
});

describe('StudioStart', () => {
  it('lists saved projects', async () => {
    render(<StudioStart onNavigate={vi.fn()} />);
    expect(await screen.findByText('My Todo App')).toBeInTheDocument();
    expect(screen.getByText(/React \+ TS/i)).toBeInTheDocument();
  });

  it('opens a project into the workspace', async () => {
    render(<StudioStart onNavigate={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /open/i }));
    await waitFor(() => expect(getStudioProject).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(useStudioWorkspace.getState().paths).toContain('/App.tsx'));
    expect(useStudioWorkspace.getState().title).toBe('My Todo App');
  });

  it('shows an empty state when there are no projects', async () => {
    listStudioProjects.mockResolvedValue([]);
    render(<StudioStart onNavigate={vi.fn()} />);
    expect(await screen.findByText(/no saved projects yet/i)).toBeInTheDocument();
  });

  it('loads a starter template into the workspace', () => {
    render(<StudioStart onNavigate={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Counter/i }));
    const s = useStudioWorkspace.getState();
    expect(s.title).toBe('Counter');
    expect(s.paths).toContain('/src/App.tsx');
  });

  it('duplicates a project as a fresh untitled copy', async () => {
    render(<StudioStart onNavigate={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText(/Duplicate My Todo App/i));
    await waitFor(() => expect(getStudioProject).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(useStudioWorkspace.getState().title).toBe('Copy of My Todo App'));
    expect(useStudioWorkspace.getState().projectId).toBeNull();
  });
});
