// Program 3 ST-A: the console says which key builds spend on (or that it isn't set, and then nothing can be built),
// shows this month's spend against the app cap and the key's OpenRouter limit as the last build start saw it, and
// "Seed styles" selects every style preview and anchor with the $15 seed budget. Opening the page asks nothing of
// OpenRouter: only the server's manifest is read.
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryManifestView } from '../../../../shared/comic/library';

const api = vi.hoisted(() => ({
  getLibraryManifest: vi.fn(),
  quoteLibraryBuild: vi.fn(),
  startLibraryBuild: vi.fn(),
  stepLibraryRun: vi.fn(),
  cancelLibraryRun: vi.fn(),
  publishLibraryAsset: vi.fn(),
  rejectLibraryAsset: vi.fn(),
  regenerateLibraryAsset: vi.fn(),
  purgeLibraryCandidates: vi.fn(),
  listLibraryRuns: vi.fn(),
  getLibraryRun: vi.fn()
}));
vi.mock('../../../../services/adminLibrary', () => api);

import { LibraryConsole } from './LibraryConsole';

const manifest = (over: Partial<LibraryManifestView> = {}): LibraryManifestView => ({
  manifestVersion: 1,
  bucket: 'comic-assets',
  platformKey: true,
  tableReady: true,
  billing: { key: 'modeltest', monthSpentUsd: 3.1, monthCapUsd: 20 },
  entries: [
    { id: 'style.noir-ink', kind: 'style_preview', model: 'nano-banana-2.1', resolution: '1K', aspect: '4:5', theme: 'any', presetId: 'noir-ink', promptHash: 'h1', alt: 'Noir', estimateUsd: 0.0366 },
    { id: 'anchor.noir-ink', kind: 'style_anchor', model: 'nano-banana-2.1', resolution: '1K', aspect: '1:1', theme: 'any', presetId: 'noir-ink', optional: true, promptHash: 'h3', alt: 'Noir swatch', estimateUsd: 0.0366 },
    { id: 'empty.cast', kind: 'empty_state', model: 'nano-banana-2.1', resolution: '1K', aspect: '1:1', theme: 'light', promptHash: 'h2', alt: 'Cast', estimateUsd: 0.0366 }
  ],
  ...over
});

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.getLibraryManifest.mockResolvedValue(manifest());
  api.quoteLibraryBuild.mockResolvedValue({ quote: { usd: 0.0732, worstCaseUsd: 0.22, images: 2, lines: [], skipped: [] }, tableReady: true });
});

describe('LibraryConsole billing (P3-ST1)', () => {
  it('names the model-test key and shows this month against the cap; the limit is checked when a build starts', async () => {
    render(<LibraryConsole />);
    expect(await screen.findByText('Model-test key ready')).toBeInTheDocument();
    const line = document.querySelector('[data-library-billing]') as HTMLElement;
    expect(line).not.toBeNull();
    expect(within(line).getByText('This month $3.10 of $20.00')).toBeInTheDocument();
    expect(within(line).getByText('OpenRouter limit: checked when a build starts')).toBeInTheDocument();
    expect(api.getLibraryManifest).toHaveBeenCalledTimes(1);
  });

  it('shows the limit the last build start saw', async () => {
    api.getLibraryManifest.mockResolvedValue(manifest({ billing: { key: 'modeltest', monthSpentUsd: 3.1, monthCapUsd: 20, limitUsd: 35, remainingUsd: 31.9, checkedAt: Date.parse('2026-11-05T10:02:00Z') } }));
    render(<LibraryConsole />);
    await screen.findByText('Model-test key ready');
    expect(document.querySelector('[data-library-billing]')!.textContent).toMatch(/OpenRouter limit \$35\.00, \$31\.90 left \(checked /);
  });

  it('without the model-test key: says nothing can be built and Build is disabled', async () => {
    api.getLibraryManifest.mockResolvedValue(manifest({ platformKey: false, billing: { key: null, monthSpentUsd: 0, monthCapUsd: 20 } }));
    render(<LibraryConsole />);
    expect(await screen.findByText('Model-test key not set: nothing can be built')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Build library/ })).toBeDisabled();
    expect(screen.queryByText('Model-test key ready')).toBeNull();
  });

  it('the platform escape hatch is named as such', async () => {
    api.getLibraryManifest.mockResolvedValue(manifest({ billing: { key: 'platform', monthSpentUsd: 0, monthCapUsd: 20 } }));
    render(<LibraryConsole />);
    expect(await screen.findByText('Platform key (COMIC_ADMIN_SPEND_KEY=platform)')).toBeInTheDocument();
  });

  it('"Seed styles" selects every style preview and anchor with the $15 seed budget, then quotes for free', async () => {
    render(<LibraryConsole />);
    fireEvent.click(await screen.findByRole('button', { name: /Seed styles/ }));
    expect((screen.getByLabelText(/Budget for this build/) as HTMLInputElement).value).toBe('15');
    fireEvent.click(screen.getByRole('button', { name: /Get a quote/ }));
    await waitFor(() => expect(api.quoteLibraryBuild).toHaveBeenCalledTimes(1));
    expect(api.quoteLibraryBuild).toHaveBeenCalledWith({ ids: ['style.noir-ink', 'anchor.noir-ink'], includeOptional: true, budgetUsd: 15 });
    expect(api.startLibraryBuild).not.toHaveBeenCalled();
  });
});
