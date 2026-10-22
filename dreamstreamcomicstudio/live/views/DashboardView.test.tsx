import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, probeLiveWorker } from '../api';
import { addMyEvent, hydrateMyEvents, listMyRecordings, type MyEvent } from '../events';
import type { Nav } from '../nav';
import { takeScheduleRequest, takeStudioIntent } from '../quickStart';
import { fetchStudioAccess, syncMyEvents } from '../sync';
import { DashboardView } from './DashboardView';

vi.mock('../api', () => ({
  probeLiveWorker: vi.fn(),
  createEvent: vi.fn(),
  SignInRequiredError: class SignInRequiredError extends Error {},
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

vi.mock('../account', () => ({
  useAccount: () => ({ status: 'member', name: 'Akhil Rao', userId: 'u1' }),
  openAuth: vi.fn(),
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
  monitor: vi.fn(),
  nursery: vi.fn(),
  monitorCamera: vi.fn(),
  monitorWatch: vi.fn(),
  calls: vi.fn(),
});

describe('DashboardView live-worker readiness gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(fetchStudioAccess).mockResolvedValue({ allowed: true, signedIn: false, scope: 'full' });
    vi.mocked(syncMyEvents).mockResolvedValue(undefined);
    vi.mocked(hydrateMyEvents).mockResolvedValue([]);
    vi.mocked(listMyRecordings).mockReturnValue([]);
  });

  it('lets hosts retry a failed backend probe and re-enables the quick starts when the live worker recovers', async () => {
    vi.mocked(probeLiveWorker)
      .mockResolvedValueOnce(blockedProbe)
      .mockResolvedValueOnce(reachableProbe);
    const nav = createNav();

    render(<DashboardView nav={nav} push={vi.fn()} />);

    expect(await screen.findByText(/Streaming backend check failed/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Backend blocked/i })[0]).toBeDisabled();
    expect(screen.getAllByRole('button', { name: /Instant meeting/i })[0]).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Retry check/i }));

    await waitFor(() => expect(screen.getAllByRole('button', { name: /Go live now/i })[0]).toBeEnabled());
    expect(screen.queryByText(/Streaming backend check failed/i)).toBeNull();

    // "Schedule…" opens Create with Advanced → Schedule ready.
    fireEvent.click(screen.getByRole('button', { name: /Schedule…/i }));
    expect(nav.create).toHaveBeenCalledTimes(1);
    expect(takeScheduleRequest()).toBe(true);
  }, 15_000); // renders the whole dashboard twice; slow under a loaded parallel run

  it('starts an Instant meeting straight from the dashboard', async () => {
    vi.mocked(probeLiveWorker).mockResolvedValue(reachableProbe);
    vi.mocked(createEvent).mockResolvedValue({ id: 'ev9', hostKey: 'hk9' });
    const nav = createNav();

    render(<DashboardView nav={nav} push={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: /Instant meeting/i })[0]).toBeEnabled());
    fireEvent.click(screen.getAllByRole('button', { name: /Instant meeting/i })[0]);

    await waitFor(() => expect(nav.studio).toHaveBeenCalledWith('ev9', 'hk9'));
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'meeting', access: 'open', scheduledAt: null, title: expect.stringMatching(/^Akhil’s meeting · /) }));
    expect(addMyEvent).toHaveBeenCalledWith(expect.objectContaining({ id: 'ev9', kind: 'meeting' }));
    expect(takeStudioIntent('ev9')).toBe('meeting');
  }, 15_000);

  it('labels meetings in the event list', async () => {
    vi.mocked(probeLiveWorker).mockResolvedValue(reachableProbe);
    const meeting: MyEvent = { id: 'm1', hostKey: 'k', title: 'Team sync', createdAt: Date.now(), scheduledAt: null, status: 'idle', kind: 'meeting' };
    vi.mocked(hydrateMyEvents).mockResolvedValue([meeting]);

    render(<DashboardView nav={createNav()} push={vi.fn()} />);

    expect(await screen.findByText('Team sync')).toBeInTheDocument();
    expect(screen.getByText('Meeting')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rejoin' })).toBeInTheDocument();
  }, 15_000);
});
