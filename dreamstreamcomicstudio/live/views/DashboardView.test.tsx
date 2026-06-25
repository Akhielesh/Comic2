import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probeLiveWorker } from '../api';
import { hydrateMyEvents, listMyRecordings } from '../events';
import type { Nav } from '../nav';
import { fetchStudioAccess, syncMyEvents } from '../sync';
import { DashboardView } from './DashboardView';

vi.mock('../api', () => ({
  probeLiveWorker: vi.fn(),
}));

vi.mock('../events', () => ({
  addMyEvent: vi.fn(),
  hydrateMyEvents: vi.fn(),
  listMyRecordings: vi.fn(),
}));

vi.mock('../sync', () => ({
  fetchStudioAccess: vi.fn(),
  pushEventToCloud: vi.fn(),
  syncMyEvents: vi.fn(),
}));

const blockedProbe = {
  ok: false,
  baseUrl: 'https://dreamstreamstudio.ai/live-api',
  httpStatus: 403,
  detail: 'Cloudflare security verification returned instead of live-worker JSON',
};

const reachableProbe = {
  ok: true,
  baseUrl: 'https://dreamstream-live.akhieleshsrirangam.workers.dev',
  httpStatus: 404,
  detail: 'live-worker route reachable (missing-event probe returned JSON 404)',
};

const createNav = (): Nav => ({
  dashboard: vi.fn(),
  create: vi.fn(),
  settings: vi.fn(),
  studio: vi.fn(),
  viewer: vi.fn(),
  event: vi.fn(),
  summary: vi.fn(),
});

describe('DashboardView live-worker readiness gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.mocked(fetchStudioAccess).mockResolvedValue({ allowed: true, signedIn: false, scope: 'full' });
    vi.mocked(syncMyEvents).mockResolvedValue(undefined);
    vi.mocked(hydrateMyEvents).mockResolvedValue([]);
    vi.mocked(listMyRecordings).mockReturnValue([]);
  });

  it('lets hosts retry a failed backend probe and re-enables event creation when the live worker recovers', async () => {
    vi.mocked(probeLiveWorker)
      .mockResolvedValueOnce(blockedProbe)
      .mockResolvedValueOnce(reachableProbe);
    const nav = createNav();

    render(<DashboardView nav={nav} push={vi.fn()} />);

    expect(await screen.findByText(/Streaming backend check failed/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Backend blocked/i })[0]).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Retry check/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /New event/i })).toBeEnabled());
    expect(screen.queryByText(/Streaming backend check failed/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /New event/i }));
    expect(nav.create).toHaveBeenCalledTimes(1);
  });
});
