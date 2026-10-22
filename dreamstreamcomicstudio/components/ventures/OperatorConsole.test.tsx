import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../services/apiClient';

const api = vi.hoisted(() => ({
  listVentures: vi.fn(),
  getVenture: vi.fn(),
  listGoals: vi.fn(),
  listEvents: vi.fn(),
  createIntake: vi.fn(),
  approveRoadmap: vi.fn(),
  setVentureStatus: vi.fn(),
  resolveCheckpoint: vi.fn()
}));
vi.mock('../../services/venturesApi', () => api);

import { OperatorConsole } from './OperatorConsole';

const venture = (status: string, pauseReason: string | null) => ({
  id: 'v1',
  name: 'Night Shift Habits',
  summary: 'A habit tracker for night-shift nurses.',
  scope: null,
  status,
  pauseReason,
  deployUrl: null,
  createdAt: '2026-10-22T10:00:00.000Z',
  updatedAt: '2026-10-22T10:00:00.000Z'
});

const showVenture = async (status: string, pauseReason: string | null) => {
  const v = venture(status, pauseReason);
  api.listVentures.mockResolvedValue([v]);
  api.getVenture.mockResolvedValue({ venture: v, budget: null, budgetAlert: 'ok', openCheckpoints: [] });
  render(<OperatorConsole />);
  fireEvent.click(await screen.findByText('Night Shift Habits'));
  await screen.findByRole('heading', { name: 'Night Shift Habits' });
};

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listGoals.mockResolvedValue([]);
  api.listEvents.mockResolvedValue([]);
});

describe('OperatorConsole with the build stage retired', () => {
  it('always shows the retired banner', async () => {
    api.listVentures.mockResolvedValue([]);
    render(<OperatorConsole />);
    expect(await screen.findByRole('note')).toHaveTextContent(/Build stage retired/);
  });

  it('offers no Resume for a build_retired venture and labels the pause plainly', async () => {
    await showVenture('paused', 'build_retired');
    expect(screen.queryByRole('button', { name: /resume/i })).not.toBeInTheDocument();
    expect(screen.getByText('build stage retired')).toBeInTheDocument();
  });

  it('approves the roadmap without promising to activate it', async () => {
    await showVenture('roadmap_pending', null);
    expect(screen.queryByRole('button', { name: /activate/i })).not.toBeInTheDocument();
    api.approveRoadmap.mockResolvedValue({ ok: true, status: 'paused', pauseReason: 'build_retired', approved: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Approve roadmap' }));
    await waitFor(() => expect(api.approveRoadmap).toHaveBeenCalledWith('v1'));
  });

  it('explains a 410 VENTURES_BUILD_RETIRED instead of showing a raw error', async () => {
    await showVenture('active', null);
    api.setVentureStatus.mockRejectedValue(
      new ApiError('raw server text', 410, { error: { message: 'raw server text', code: 'VENTURES_BUILD_RETIRED' } })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByText(/can't be resumed/)).toBeInTheDocument();
    expect(screen.queryByText('raw server text')).not.toBeInTheDocument();
  });
});
