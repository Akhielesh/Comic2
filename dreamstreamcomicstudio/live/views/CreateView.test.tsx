import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, probeLiveWorker } from '../api';
import type { Nav } from '../nav';
import { CreateView } from './CreateView';

vi.mock('../api', () => ({
  createEvent: vi.fn(),
  probeLiveWorker: vi.fn(),
}));

vi.mock('../events', () => ({
  addMyEvent: vi.fn(),
}));

vi.mock('../sync', () => ({
  pushEventToCloud: vi.fn(),
}));

const nav: Nav = {
  dashboard: vi.fn(),
  create: vi.fn(),
  settings: vi.fn(),
  studio: vi.fn(),
  viewer: vi.fn(),
  event: vi.fn(),
  summary: vi.fn(),
};

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

describe('CreateView live-worker readiness gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('blocks event creation when the deployment routes live-worker calls to a challenge or app shell', async () => {
    vi.mocked(probeLiveWorker).mockResolvedValue(blockedProbe);

    render(<CreateView nav={nav} push={vi.fn()} />);

    expect(await screen.findByText(/Streaming backend check failed/i)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /Streaming backend unavailable/i });
    expect(submit).toBeDisabled();

    fireEvent.click(submit);
    expect(createEvent).not.toHaveBeenCalled();
  });

  it('lets the host retry the readiness probe without losing the filled-out event form', async () => {
    vi.mocked(probeLiveWorker)
      .mockResolvedValueOnce(blockedProbe)
      .mockResolvedValueOnce(reachableProbe);

    render(<CreateView nav={nav} push={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/Title/i), {
      target: { value: 'Launch rehearsal' },
    });
    expect(await screen.findByText(/Streaming backend check failed/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Retry check/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /Create event/i })).toBeEnabled());
    expect(screen.getByLabelText(/Title/i)).toHaveValue('Launch rehearsal');
    expect(screen.queryByText(/Streaming backend check failed/i)).toBeNull();
  });
});
