import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openAuth } from '../account';
import { createEvent, probeLiveWorker } from '../api';
import type { Nav } from '../nav';
import { takeStudioIntent } from '../quickStart';
import { CreateView } from './CreateView';

vi.mock('../api', () => ({
  createEvent: vi.fn(),
  probeLiveWorker: vi.fn(),
  SignInRequiredError: class SignInRequiredError extends Error {},
}));

vi.mock('../events', () => ({
  addMyEvent: vi.fn(),
}));

vi.mock('../sync', () => ({
  pushEventToCloud: vi.fn(),
}));

// Mutable so a test can sign the host out.
const accountState = vi.hoisted(() => ({ current: { status: 'member', name: 'Host' } as { status: string; name?: string } }));
vi.mock('../account', () => ({
  useAccount: () => accountState.current,
  openAuth: vi.fn(),
}));

const nav: Nav = {
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

const openAdvanced = () => fireEvent.click(screen.getByRole('button', { name: /^Advanced/ }));

describe('CreateView live-worker readiness gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    accountState.current = { status: 'member', name: 'Host' };
  });

  it('blocks event creation when the deployment routes live-worker calls to a challenge or app shell', async () => {
    vi.mocked(probeLiveWorker).mockResolvedValue(blockedProbe);

    render(<CreateView nav={nav} push={vi.fn()} />);

    expect(await screen.findByText(/Streaming backend check failed/i)).toBeInTheDocument();
    const meeting = screen.getByRole('button', { name: /Instant meeting/i });
    const live = screen.getByRole('button', { name: /Go live now/i });
    expect(meeting).toBeDisabled();
    expect(live).toBeDisabled();
    fireEvent.click(meeting);
    fireEvent.click(live);

    openAdvanced();
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

    await waitFor(() => expect(screen.getByRole('button', { name: /Instant meeting/i })).toBeEnabled());
    expect(screen.getByLabelText(/Title/i)).toHaveValue('Launch rehearsal');
    expect(screen.queryByText(/Streaming backend check failed/i)).toBeNull();
  });
});

describe('CreateView quick start', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    accountState.current = { status: 'member', name: 'Host' };
    vi.mocked(probeLiveWorker).mockResolvedValue(reachableProbe);
    vi.mocked(createEvent).mockResolvedValue({ id: 'id', hostKey: 'key' });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('leads with the two one-tap cards and keeps every other option folded under Advanced', async () => {
    render(<CreateView nav={nav} push={vi.fn()} />);
    expect(screen.getByRole('heading', { name: 'Start now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Instant meeting/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Go live now/i })).toBeInTheDocument();
    expect(screen.getByText(/720p · Anyone with the link · up to 100 viewers · not recording/)).toBeInTheDocument();

    const adv = screen.getByRole('button', { name: /^Advanced/ });
    expect(adv).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Viewer cap')).toBeNull();

    fireEvent.click(adv);
    expect(adv).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Viewer cap')).toBeInTheDocument();
    // …and it stays open next time.
    expect(localStorage.getItem('ds-live-create-advanced')).toBe('1');
  });

  it('starts an Instant meeting in one tap: auto title, open access, now — straight into the studio', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 9, 22, 12, 0, 0));
    render(<CreateView nav={nav} push={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Instant meeting/i }));

    await waitFor(() => expect(nav.studio).toHaveBeenCalledWith('id', 'key'));
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Host’s meeting · Oct 22', access: 'open', scheduledAt: null, kind: 'meeting', maxViewers: 100 }),
    );
    // The studio is told — once, via sessionStorage, never the URL — to open the Invite sheet.
    expect(takeStudioIntent('id')).toBe('meeting');
    expect(takeStudioIntent('id')).toBeNull();
  });

  it('keeps a typed title when going live now', async () => {
    render(<CreateView nav={nav} push={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/Title/i), { target: { value: 'Friday sketch jam' } });

    fireEvent.click(screen.getByRole('button', { name: /Go live now/i }));

    await waitFor(() => expect(nav.studio).toHaveBeenCalledWith('id', 'key'));
    expect(createEvent).toHaveBeenCalledWith(expect.objectContaining({ title: 'Friday sketch jam', kind: 'broadcast', scheduledAt: null }));
    expect(takeStudioIntent('id')).toBe('live');
  });

  it('asks a signed-out host to sign in instead of creating anything', async () => {
    accountState.current = { status: 'signed_out' };
    render(<CreateView nav={nav} push={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /Instant meeting/i }));

    expect(openAuth).toHaveBeenCalledWith('signin', expect.stringMatching(/Sign in/));
    expect(createEvent).not.toHaveBeenCalled();
    expect(nav.studio).not.toHaveBeenCalled();
  });

  it('refuses to "schedule" without a date in the future', async () => {
    render(<CreateView nav={nav} push={vi.fn()} />);
    await waitFor(() => expect(probeLiveWorker).toHaveBeenCalled());
    openAdvanced();
    fireEvent.click(screen.getByRole('radio', { name: /Schedule/i }));

    expect(screen.getByText(/Pick a date and time in the future to schedule/)).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: /Schedule event/i });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);

    // A date in the past is just as invalid.
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2001-01-01' } });
    expect(screen.getByRole('button', { name: /Schedule event/i })).toBeDisabled();
    expect(createEvent).not.toHaveBeenCalled();
  });
});
