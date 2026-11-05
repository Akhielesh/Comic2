// Popularity panel (Models Phase 0, C2): with the server's k-anonymity floor most windows have no rows
// today, so the panel shows a calm empty state instead of disappearing; rows render as before. Only a
// list known to be empty gets the privacy explanation: a null answer (services/modelPopularity returns
// null for an empty list AND for a failed read) gets neutral words, and is retried on the next visit.
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelPopularity } from '../../services/modelPopularity';

const fetchModelPopularity = vi.hoisted(() => vi.fn<(w: string) => Promise<ModelPopularity | null>>());
vi.mock('../../services/modelPopularity', () => ({ fetchModelPopularity }));

const { ModelPopularityPanel, ModelPopularityCard } = await import('./ModelPopularityPanel');

const RANKING: ModelPopularity = {
  window: 'week',
  generatedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  models: [
    { model: 'anthropic/claude-sonnet-4.5', provider: 'openrouter', requests: 1200, users: 42, sharePct: 61.5 },
    { model: 'google/gemini-2.5-flash', provider: 'openrouter', requests: 750, users: 25, sharePct: 38.5 }
  ]
};

afterEach(() => {
  cleanup();
  fetchModelPopularity.mockReset();
});

describe('ModelPopularityPanel', () => {
  it('a window read as an empty list: the calm empty state, with why (the k-anonymity floor)', async () => {
    fetchModelPopularity.mockResolvedValue({ window: 'week', generatedAt: '', models: [] });
    render(<ModelPopularityPanel />);
    expect(await screen.findByText('No rankings to show yet')).toBeInTheDocument();
    expect(screen.getByText(/enough different people have used it/)).toBeInTheDocument();
    // The panel stays, with its title and window tabs.
    expect(screen.getByText('What DreamStream users run')).toBeInTheDocument();
    expect(fetchModelPopularity).toHaveBeenCalledWith('week');
  });

  it('a null answer (empty or failed, not told apart): neutral words with no reason, and it is asked again', async () => {
    fetchModelPopularity.mockResolvedValueOnce(null);
    render(<ModelPopularityPanel />);
    expect(await screen.findByText('No rankings to show right now')).toBeInTheDocument();
    expect(screen.queryByText(/enough different people/)).toBeNull();
    expect(screen.queryByText('No rankings to show yet')).toBeNull();
    // Away and back: the week is read again (a null is never kept), and this time it answers.
    fetchModelPopularity.mockResolvedValueOnce(null).mockResolvedValueOnce(RANKING);
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    await waitFor(() => expect(fetchModelPopularity).toHaveBeenCalledWith('month'));
    fireEvent.click(screen.getByRole('button', { name: 'Weekly' }));
    expect(await screen.findByText('anthropic/claude-sonnet-4.5')).toBeInTheDocument();
    expect(fetchModelPopularity.mock.calls.map(([w]) => w)).toEqual(['week', 'month', 'week']);
  });

  it('renders the ranking and its freshness when rows come back', async () => {
    fetchModelPopularity.mockResolvedValue(RANKING);
    render(<ModelPopularityPanel />);
    expect(await screen.findByText('anthropic/claude-sonnet-4.5')).toBeInTheDocument();
    expect(screen.getByText(/updated/)).toBeInTheDocument();
    expect(screen.queryByText('No rankings to show yet')).toBeNull();
  });

  it('keeps each window separately: an empty month after a full week, and the week is not read twice', async () => {
    fetchModelPopularity.mockImplementation(async (w) => (w === 'week' ? RANKING : { window: 'month', generatedAt: '', models: [] }));
    render(<ModelPopularityPanel />);
    await screen.findByText('anthropic/claude-sonnet-4.5');
    fireEvent.click(screen.getByRole('button', { name: 'Monthly' }));
    expect(await screen.findByText('No rankings to show yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Weekly' }));
    expect(await screen.findByText('anthropic/claude-sonnet-4.5')).toBeInTheDocument();
    expect(fetchModelPopularity.mock.calls.map(([w]) => w)).toEqual(['week', 'month']);
  });

  it('the card reads an empty list the same way', () => {
    render(<ModelPopularityCard data={{ window: 'all', generatedAt: '', models: [] }} />);
    expect(screen.getByText('No rankings to show yet')).toBeInTheDocument();
  });
});
