// Program 3 ST-A: the console says which key builds spend on (or that it isn't set, and then nothing can be built),
// shows this month's spend against the app cap and the key's OpenRouter limit as the last build start saw it, and
// "Seed styles" selects every style preview and anchor with the $15 seed budget. Opening the page asks nothing of
// OpenRouter: only the server's manifest is read.
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { LibraryManifestView } from '../../../../shared/comic/library';
import type { LibraryStartResult } from '../../../../services/adminLibrary';

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

  it('a key with no limit of its own but a budget that blocks first names the budget, not a limit', async () => {
    api.getLibraryManifest.mockResolvedValue(manifest({ billing: { key: 'modeltest', monthSpentUsd: 3.1, monthCapUsd: 20, limitUsd: null, remainingUsd: 1.5, checkedAt: Date.parse('2026-11-05T10:02:00Z') } }));
    render(<LibraryConsole />);
    await screen.findByText('Model-test key ready');
    const text = document.querySelector('[data-library-billing]')!.textContent || '';
    expect(text).toMatch(/OpenRouter budget: \$1\.50 left \(checked /);
    expect(text).not.toMatch(/limit none/);
  });

  it('the client service types the start warning (ST-A #11): LibraryStartResult.warning is an optional string', () => {
    expectTypeOf<LibraryStartResult['warning']>().toEqualTypeOf<string | undefined>();
    const out: LibraryStartResult = { run: null, quote: { usd: 0, worstCaseUsd: 0, images: 0, lines: [], skipped: [] }, message: 'Build ready.', warning: 'Only the app cap applies.' };
    expect(out.warning).toBe('Only the app cap applies.');
  });

  it('an unlimited key starts the build but the notice is a warning, not a green check', async () => {
    const warning = "The model-test key has no OpenRouter limit, so only the app's $20.00 monthly cap applies. Set a monthly limit on the key in OpenRouter.";
    const run = { id: '11111111-1111-4111-8111-111111111111', status: 'running' as const, budgetUsd: 5, spentUsd: 0, counts: { total: 2, done: 0, published: 0, review: 0, failed: 0, skipped: 0, pending: 2 }, assets: [] };
    api.startLibraryBuild.mockResolvedValue({ run, quote: { usd: 0.0732, worstCaseUsd: 0.22, images: 2, lines: [], skipped: [] }, message: `Build ready: 2 images. ${warning}`, warning });
    api.stepLibraryRun.mockReturnValue(new Promise(() => undefined)); // the drive loop waits; the start notice stays
    render(<LibraryConsole />);
    fireEvent.click(await screen.findByRole('button', { name: /Build library/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Build \d/ }));
    const notice = await screen.findByRole('status');
    await waitFor(() => expect(notice.textContent).toContain(warning));
    expect(notice.getAttribute('data-tone')).toBe('warn');
  });

  it('a start without a warning stays a calm ok notice', async () => {
    api.startLibraryBuild.mockResolvedValue({ run: null, quote: { usd: 0, worstCaseUsd: 0, images: 0, lines: [], skipped: [] }, message: 'Nothing selected to build.' });
    render(<LibraryConsole />);
    fireEvent.click(await screen.findByRole('button', { name: /Build library/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Build \d/ }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Nothing selected to build.'));
    expect(screen.getByRole('status').getAttribute('data-tone')).toBe('ok');
  });

  it('the asset drawer says a Regenerate note is published; a regenerate on an unlimited key warns', async () => {
    const warning = "The model-test key has no OpenRouter limit, so only the app's $20.00 monthly cap applies. Set a monthly limit on the key in OpenRouter.";
    api.regenerateLibraryAsset.mockResolvedValue({ run: null, quote: { usd: 0, worstCaseUsd: 0, images: 0, lines: [], skipped: [] }, message: `Build ready. ${warning}`, warning });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<LibraryConsole />);
    fireEvent.click((await screen.findAllByRole('button', { name: /style\.noir-ink/ }))[0]);
    expect(screen.getByLabelText('Art-director note (optional; a Regenerate note becomes part of the published prompt)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Regenerate/ }));
    await waitFor(() => expect(api.regenerateLibraryAsset).toHaveBeenCalledWith('style.noir-ink', {}));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(`Regenerating style.noir-ink. ${warning}`));
    expect(screen.getByRole('status').getAttribute('data-tone')).toBe('warn');
    confirm.mockRestore();
  });

  it('a step refused because the server now spends on another key says to cancel, without promising Resume', async () => {
    const run = { id: '11111111-1111-4111-8111-111111111111', status: 'running' as const, budgetUsd: 5, spentUsd: 0, counts: { total: 2, done: 0, published: 0, review: 0, failed: 0, skipped: 0, pending: 2 }, assets: [] };
    api.startLibraryBuild.mockResolvedValue({ run, quote: { usd: 0.0732, worstCaseUsd: 0.22, images: 2, lines: [], skipped: [] }, message: 'Build ready: 2 images.' });
    const refusal = 'This build started on the model-test key; the server now spends on the platform OpenRouter key. Cancel it and start a new build. Nothing more was spent.';
    api.stepLibraryRun.mockRejectedValue(Object.assign(new Error(refusal), { status: 409 }));
    render(<LibraryConsole />);
    fireEvent.click(await screen.findByRole('button', { name: /Build library/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Build \d/ }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(refusal));
    expect(screen.getByRole('status').textContent).not.toMatch(/Resume continues/);
    expect(api.stepLibraryRun).toHaveBeenCalledTimes(1);
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
