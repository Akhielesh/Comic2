// Admin → Library console: quotes for free, builds only after an explicit confirm, then drives the
// run step by step until it finishes; an existing run is never resumed without a click.
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryManifestView, LibraryRunView, LibraryStepView } from '../../../../shared/comic/library';

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

const runView = (over: Partial<LibraryRunView> = {}): LibraryRunView => ({
  id: '11111111-1111-4111-8111-111111111111',
  status: 'running',
  budgetUsd: 5,
  spentUsd: 0,
  counts: { total: 2, done: 0, published: 0, review: 0, failed: 0, skipped: 0, pending: 2 },
  assets: [],
  ...over
});

const manifest = (over: Partial<LibraryManifestView> = {}): LibraryManifestView => ({
  manifestVersion: 1,
  bucket: 'comic-assets',
  platformKey: true,
  tableReady: true,
  entries: [
    { id: 'style.noir-ink', kind: 'style_preview', model: 'nano-banana-2.1', resolution: '1K', aspect: '4:5', theme: 'any', presetId: 'noir-ink', promptHash: 'h1', alt: 'Noir', estimateUsd: 0.0366 },
    { id: 'empty.cast', kind: 'empty_state', model: 'nano-banana-2.1', resolution: '1K', aspect: '1:1', theme: 'light', promptHash: 'h2', alt: 'Cast', estimateUsd: 0.0366 }
  ],
  ...over
});

const quote = { usd: 0.0732, worstCaseUsd: 0.2246, images: 2, lines: [{ kind: 'style_preview' as const, count: 1, usd: 0.0366 }, { kind: 'empty_state' as const, count: 1, usd: 0.0366 }], skipped: [] };

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.getLibraryManifest.mockResolvedValue(manifest());
  api.quoteLibraryBuild.mockResolvedValue({ quote, tableReady: true });
});

describe('LibraryConsole', () => {
  it('shows the manifest grouped by kind with procedural art, and quotes without building', async () => {
    render(<LibraryConsole />);
    expect(await screen.findByText('Platform asset library')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Style previews' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Empty states' })).toBeInTheDocument();
    expect(document.querySelector('[data-preset-thumb="noir-ink"]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Get a quote/ }));
    expect(await screen.findByText(/2 images · about \$0.07/)).toBeInTheDocument();
    expect(screen.getByText(/nothing is generated until you confirm/)).toBeInTheDocument();
    expect(api.startLibraryBuild).not.toHaveBeenCalled();
    expect(api.stepLibraryRun).not.toHaveBeenCalled();
  });

  it('builds only after the confirm, then steps the run to completion', async () => {
    api.startLibraryBuild.mockResolvedValue({ run: runView(), quote, message: 'Build ready: 2 images.' });
    const step = (over: Partial<LibraryStepView>): LibraryStepView => ({ ...runView(), message: 'Drew 1.', waitMs: 0, ...over });
    api.stepLibraryRun
      .mockResolvedValueOnce(step({ counts: { total: 2, done: 1, published: 1, review: 0, failed: 0, skipped: 0, pending: 1 } }))
      .mockResolvedValueOnce(step({ status: 'completed', message: 'Build finished.', counts: { total: 2, done: 2, published: 2, review: 0, failed: 0, skipped: 0, pending: 0 } }));
    render(<LibraryConsole />);
    fireEvent.click(await screen.findByRole('button', { name: /Build library/ }));
    const confirm = await screen.findByRole('dialog', { name: 'Confirm the build' });
    expect(api.startLibraryBuild).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Build 2' }));
    await waitFor(() => expect(api.stepLibraryRun).toHaveBeenCalledTimes(2));
    expect(api.startLibraryBuild).toHaveBeenCalledWith({ budgetUsd: 5 });
    expect(api.stepLibraryRun).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 3);
    expect(await screen.findByText('Build finished.')).toBeInTheDocument();
    expect(confirm).not.toBeInTheDocument();
  });

  it('never resumes an existing run on its own: Resume is a click', async () => {
    api.getLibraryManifest.mockResolvedValue(manifest({ activeRun: runView({ counts: { total: 2, done: 1, published: 1, review: 0, failed: 0, skipped: 0, pending: 1 } }) }));
    api.stepLibraryRun.mockResolvedValue({ ...runView({ status: 'completed' }), message: 'Build finished.', waitMs: 0 });
    render(<LibraryConsole />);
    expect(await screen.findByText(/Build paused/)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 30));
    expect(api.stepLibraryRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Resume/ }));
    await waitFor(() => expect(api.stepLibraryRun).toHaveBeenCalledTimes(1));
  });

  it('is honest when the platform key or the tables are missing', async () => {
    api.getLibraryManifest.mockResolvedValue(manifest({ platformKey: false, tableReady: false }));
    render(<LibraryConsole />);
    expect(await screen.findByText('No platform image key')).toBeInTheDocument();
    expect(screen.getByText('Tables not installed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Build library/ })).toBeDisabled();
  });

  it('Pause says it is finishing the current step and stops the loop after it', async () => {
    let finishStep: (v: LibraryStepView) => void = () => undefined;
    api.getLibraryManifest.mockResolvedValue(manifest({ activeRun: runView() }));
    api.stepLibraryRun.mockImplementation(() => new Promise<LibraryStepView>((resolve) => (finishStep = resolve)));
    render(<LibraryConsole />);
    fireEvent.click(await screen.findByRole('button', { name: /Resume/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Pause$/ }));
    expect(await screen.findByText('Pausing after this step…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Pausing/ })).toBeDisabled();
    finishStep({ ...runView(), message: 'Drew 1.', waitMs: 0 });
    expect(await screen.findByRole('button', { name: /Resume/ })).toBeInTheDocument();
    expect(api.stepLibraryRun).toHaveBeenCalledTimes(1);
  });

  it('a live image can be taken down from its drawer (after a confirm), and selection boxes are labelled', async () => {
    const live = {
      ...manifest().entries[0],
      row: {
        status: 'published' as const, score: 0.9, rev: 1, attempts: 1, costUsd: 0.04, issues: [], upToDate: true,
        published: { rev: 1, url: 'https://cdn.test/library/v1/style.noir-ink/1.webp', at: 1 },
        candidates: [{ rev: 1, url: 'https://cdn.test/library/v1/style.noir-ink/1.webp', w: 800, h: 1000, score: 0.9, issues: [], strategy: 'first' as const, at: 1, current: true }]
      }
    };
    api.getLibraryManifest.mockResolvedValue(manifest({ entries: [live, manifest().entries[1]] }));
    api.rejectLibraryAsset.mockResolvedValue(live);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<LibraryConsole />);
    expect(await screen.findByRole('checkbox', { name: 'Select style.noir-ink' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /style\.noir-ink/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Take down/ }));
    await waitFor(() => expect(api.rejectLibraryAsset).toHaveBeenCalledWith('style.noir-ink', undefined, { unpublish: true }));
    expect(confirmSpy).toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('the status pill over an entry\'s art is an opaque tone surface (readable on any image), the page chips stay tints', async () => {
    const failed = {
      ...manifest().entries[0],
      row: { status: 'failed' as const, score: 0, rev: 1, attempts: 1, costUsd: 0.04, issues: [], upToDate: true, candidates: [] }
    };
    api.getLibraryManifest.mockResolvedValue(manifest({ entries: [failed, manifest().entries[1]] }));
    render(<LibraryConsole />);
    await screen.findByRole('checkbox', { name: 'Select style.noir-ink' });
    const pills = [...document.querySelectorAll<HTMLElement>('[data-status-pill]')];
    expect(pills.map((p) => p.textContent)).toEqual(['Failed', 'Not built']);
    const [failedPill, notBuilt] = pills;
    // TONE_CHIP_ON_ART: the 10 % tint mixed into the opaque raised surface, not into transparency.
    expect(failedPill.className).toContain('bg-[color:color-mix(in_srgb,var(--ds-danger-mark)_10%,var(--ds-raised))]');
    expect(failedPill.className).toContain('text-[var(--ds-danger-text)]');
    expect(failedPill.className).not.toMatch(/_10%,transparent\)|backdrop-blur/);
    expect(notBuilt.className).toContain('bg-[var(--ds-raised)]');
    expect(notBuilt.className).not.toContain('well-strong');
  });

  it('the stat labels wrap instead of being cut off, and the values line up along the bottom of each cell', async () => {
    render(<LibraryConsole />);
    await screen.findByText('Platform asset library');
    const stats = document.querySelector<HTMLElement>('[data-library-stats]')!;
    // As many columns as fit a 5.75rem cell (three from about 350 px, two on the narrowest phones), never a squeezed third.
    expect(stats.className).toContain('grid-cols-[repeat(auto-fit,minmax(5.75rem,1fr))]');
    expect(stats.className).not.toMatch(/(^| )grid-cols-3( |$)/);
    const labels = [...stats.querySelectorAll('dt')];
    expect(labels.map((dt) => dt.textContent)).toEqual(['Published', 'Needs review', 'Spent (all builds)']);
    for (const dt of labels) {
      expect(dt.className).not.toContain('truncate');
      expect(dt.parentElement!.className).toContain('flex-col');
      expect(dt.nextElementSibling!.className).toContain('mt-auto');
    }
  });

  it('shows a load error with a retry', async () => {
    api.getLibraryManifest.mockRejectedValueOnce(new Error('Admins only.'));
    render(<LibraryConsole />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Admins only.');
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByText('Platform asset library')).toBeInTheDocument();
  });
});
