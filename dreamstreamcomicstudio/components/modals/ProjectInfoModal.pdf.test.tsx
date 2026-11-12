/**
 * PF-1 #2: the project modal's PDF export and its "Update Sizes" click await the on-demand loader
 * (services/legacyPdfLoader.ts) instead of reading window globals that index.html no longer provides,
 * and a load that fails says so calmly. Opening the modal fetches nothing (D6: the legacy PDF export is
 * kept, loaded on demand). The automatic 1.2 s refresh runs once per project snapshot and sizes the ZIP;
 * it sizes the PDF only when isLegacyPdfReady('jspdf') says an export already loaded the tools
 * (tests/edge/supplyChain.test.ts pins that call site; docs/decisions/0006 D6).
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStep, type ComicState, type Project } from '../../types';

const { loadJsPdfMock, isLegacyPdfReadyMock, exportProjectMock, downloadBlobMock } = vi.hoisted(() => ({
  loadJsPdfMock: vi.fn(),
  isLegacyPdfReadyMock: vi.fn(() => false),
  exportProjectMock: vi.fn(),
  downloadBlobMock: vi.fn()
}));

vi.mock('../../services/legacyPdfLoader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/legacyPdfLoader')>()),
  loadJsPdf: loadJsPdfMock,
  isLegacyPdfReady: isLegacyPdfReadyMock
}));

vi.mock('../../services/db', () => ({
  exportProject: exportProjectMock,
  loadArtifactsForProject: vi.fn(async () => [])
}));

vi.mock('../../services/download', () => ({ downloadBlob: downloadBlobMock }));

import { LEGACY_PDF_MESSAGES, LegacyPdfLoadError } from '../../services/legacyPdfLoader';
import { ProjectInfoModal } from './ProjectInfoModal';

const state = {
  step: AppStep.REVIEW_EXPORT,
  maxStepReached: AppStep.REVIEW_EXPORT,
  script: 'Maya opens a glowing attic door.',
  scenes: [],
  continuitySummary: '',
  overview: '',
  comments: [],
  isFeatured: false,
  coverPrompt: '',
  styleVariants: [],
  stylePrompt: 'clean comic style',
  styleCategory: 'Ligne Claire',
  styleAspectRatio: '1:1',
  customAspectRatioEnabled: false,
  imageResolution: '1K',
  characters: [],
  items: [],
  locations: [],
  layoutType: 'grid',
  panels: []
} as unknown as ComicState;

const project: Project = { id: 'project-1', name: 'Maya and the Door', createdAt: 1, updatedAt: 2, state };

const openModal = async () => {
  render(<ProjectInfoModal project={project} onClose={vi.fn()} onUpdateProject={vi.fn()} />);
  const update = screen.getByRole('button', { name: /Update Sizes/ });
  await waitFor(() => expect(update).toBeEnabled());
  return update;
};

beforeEach(() => {
  loadJsPdfMock.mockReset();
  isLegacyPdfReadyMock.mockClear();
  downloadBlobMock.mockReset();
  exportProjectMock.mockReset();
  exportProjectMock.mockResolvedValue({ project: { id: 'project-1', name: 'Maya and the Door' }, images: {}, artifacts: [] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProjectInfoModal on the on-demand PDF loader', () => {
  it('opening the modal fetches no PDF tools; the Update Sizes click loads them through the loader', async () => {
    loadJsPdfMock.mockRejectedValue(new LegacyPdfLoadError('network', 'jspdf'));
    const update = await openModal();
    await new Promise((r) => setTimeout(r, 1400));
    expect(loadJsPdfMock).not.toHaveBeenCalled();
    fireEvent.click(update);
    await waitFor(() => expect(loadJsPdfMock).toHaveBeenCalledTimes(1));
  });

  it('the automatic refresh runs once, 1.2 s after opening: it sizes the ZIP and fetches no PDF tools', async () => {
    await openModal();
    const status = screen.getByText(/^Status:/);
    expect(within(status).getByText('Stale')).toBeInTheDocument();
    await waitFor(() => expect(within(status).getByText('Latest')).toBeInTheDocument(), { timeout: 6000 });
    expect(isLegacyPdfReadyMock).toHaveBeenCalledWith('jspdf');
    expect(loadJsPdfMock).not.toHaveBeenCalled();
  }, 20_000);

  it('once an export loaded the PDF tools, the automatic refresh sizes the PDF too, and only once', async () => {
    isLegacyPdfReadyMock.mockReturnValue(true);
    // A load that fails only when the test says so, as a real one would after a moment: the sizes show
    // Updating while it is in flight, then Stale again.
    let failLoad: (e: unknown) => void = () => {};
    loadJsPdfMock.mockImplementation(() => new Promise((_, reject) => (failLoad = reject)));
    try {
      await openModal();
      await waitFor(() => expect(loadJsPdfMock).toHaveBeenCalledTimes(1), { timeout: 6000 });
      await waitFor(() => expect(within(screen.getByText(/^Status:/)).getByText('Updating')).toBeInTheDocument());
      failLoad(new LegacyPdfLoadError('network', 'jspdf'));
      // The refresh failed and the sizes are stale again: the same snapshot never refreshes twice.
      await waitFor(() => expect(within(screen.getByText(/^Status:/)).getByText('Stale')).toBeInTheDocument());
      await new Promise((r) => setTimeout(r, 1500));
      expect(loadJsPdfMock).toHaveBeenCalledTimes(1);
    } finally {
      isLegacyPdfReadyMock.mockReturnValue(false);
    }
  }, 20_000);

  it('a PDF export whose tools fail to load is the loader’s calm sentence and downloads nothing', async () => {
    loadJsPdfMock.mockRejectedValue(new LegacyPdfLoadError('network', 'jspdf'));
    await openModal();
    fireEvent.click(screen.getByRole('button', { name: /Download PDF/ }));
    expect(await screen.findByText(LEGACY_PDF_MESSAGES.network)).toBeInTheDocument();
    expect(loadJsPdfMock).toHaveBeenCalledTimes(1);
    expect(downloadBlobMock).not.toHaveBeenCalled();
    expect(screen.queryByText(/Please retry after refreshing project assets/)).toBeNull();
  });
});
