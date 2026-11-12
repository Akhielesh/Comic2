/**
 * PF-1: the classic wizard's Book/PDF export awaits the on-demand loader (services/legacyPdfLoader.ts)
 * instead of reading window globals that index.html no longer provides, and a load that fails is a calm
 * status line, not an unhandled rejection.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStep, type ComicPanel, type ComicState, type Project } from '../../types';

const { loadLegacyPdfMock, downloadBlobMock, html2canvasMock, jsPdfInstances } = vi.hoisted(() => ({
  loadLegacyPdfMock: vi.fn(),
  downloadBlobMock: vi.fn(),
  html2canvasMock: vi.fn(),
  jsPdfInstances: [] as Array<{ args: unknown[]; addImage: ReturnType<typeof vi.fn>; output: ReturnType<typeof vi.fn> }>
}));

vi.mock('../../services/legacyPdfLoader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/legacyPdfLoader')>()),
  loadLegacyPdf: loadLegacyPdfMock
}));

vi.mock('../../services/download', () => ({ downloadBlob: downloadBlobMock }));

vi.mock('../../services/db', () => ({
  exportProject: vi.fn(),
  getImageUrl: vi.fn(async () => undefined),
  getImageDataUrl: vi.fn(async (id: string) => `data:image/png;base64,${id}`),
  loadArtifactsForProject: vi.fn(async () => []),
  saveArtifact: vi.fn(async () => undefined)
}));

vi.mock('../../services/reporting', () => ({
  buildProjectReport: vi.fn(async () => ({ cost_summary: { totalCost: 0 }, ai_usage: { totalArtifacts: 0 }, storage: {} }))
}));

vi.mock('../../services/billing', () => ({
  getComicCost: vi.fn(async () => ({ totalActualCt: 0, totalBillableUsd: 0, totalProviderCostUsd: 0, byStage: {}, byModel: {} }))
}));

vi.mock('../../services/geminiService', () => ({ runContinuityAudit: vi.fn() }));
vi.mock('../../services/generationManager', () => ({ regenerateSinglePanel: vi.fn() }));
vi.mock('../../services/appSettings', () => ({ getModelForTask: vi.fn(() => 'test-image-model') }));
vi.mock('../../services/imageModels', () => ({ getImageModelById: vi.fn(() => ({ label: 'Test Image Model' })) }));

import { LEGACY_PDF_MESSAGES, LegacyPdfLoadError } from '../../services/legacyPdfLoader';
import { ReviewExport } from './ReviewExport';

class FakeJsPdf {
  args: unknown[];
  internal = { pageSize: { getWidth: () => 297, getHeight: () => 210 } };
  addImage = vi.fn();
  addPage = vi.fn();
  save = vi.fn();
  output = vi.fn(() => new Blob(['%PDF-1.3'], { type: 'application/pdf' }));
  constructor(...args: unknown[]) {
    this.args = args;
    jsPdfInstances.push(this);
  }
}

const panels: ComicPanel[] = [
  { id: 'panel-1', sceneId: 1, description: 'Maya opens the glowing door.', dialogue: 'Maya: "Whoa."', imageId: 'panel-image-1', imageUrl: 'https://example.com/panel.png', imageIdHistory: ['panel-image-1'] }
];

const state: ComicState = {
  step: AppStep.REVIEW_EXPORT,
  maxStepReached: AppStep.REVIEW_EXPORT,
  flowVersion: 4,
  script: 'Maya opens a glowing attic door.',
  scenes: [{ id: 1, rawText: 'Maya opens a glowing attic door.', synopsis: 'Maya opens a glowing attic door.', characters: ['Maya'], setting: 'Attic' }],
  continuitySummary: '',
  overview: '',
  comments: [],
  isFeatured: false,
  coverPrompt: '',
  styleVariants: [],
  selectedStyleId: undefined,
  stylePrompt: 'clean comic style',
  styleCategory: 'Ligne Claire',
  styleAspectRatio: '1:1',
  customAspectRatioEnabled: false,
  imageResolution: '1K',
  characters: [],
  items: [],
  locations: [],
  layoutType: 'grid',
  panels,
  // Only the book is requested, so the auto-prepare pass has nothing else to build here.
  agentSettings: { confirmPolicy: 'never', outputTargets: ['book'], autoPageCount: true }
};

const project: Project = { id: 'project-1', name: 'Maya and the Door', createdAt: Date.now(), updatedAt: Date.now(), state };

const renderExport = (onUpdateProject = vi.fn()) =>
  render(
    <ReviewExport
      project={project}
      onUpdateProject={onUpdateProject}
      projectId="project-1"
      projectName="Maya and the Door"
      panels={panels}
      state={state}
      onReturnToPreview={vi.fn()}
      onUpdatePanel={vi.fn()}
    />
  );

beforeEach(() => {
  loadLegacyPdfMock.mockReset();
  downloadBlobMock.mockReset();
  html2canvasMock.mockReset();
  jsPdfInstances.length = 0;
  const canvas = document.createElement('canvas');
  canvas.width = 800;
  canvas.height = 600;
  vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
  html2canvasMock.mockResolvedValue(canvas);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ReviewExport Book/PDF on the on-demand loader', () => {
  it('loads nothing until the button is pressed, then awaits the loader and downloads the PDF', async () => {
    const onUpdateProject = vi.fn();
    renderExport(onUpdateProject);
    expect(loadLegacyPdfMock).not.toHaveBeenCalled();

    loadLegacyPdfMock.mockResolvedValue({ jsPDF: FakeJsPdf, html2canvas: html2canvasMock });
    fireEvent.click(screen.getByRole('button', { name: /Book\/PDF/ }));

    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1));
    expect(loadLegacyPdfMock).toHaveBeenCalledTimes(1);
    expect(html2canvasMock).toHaveBeenCalledWith(document.getElementById('comic-render-area'), expect.objectContaining({ scale: 2 }));
    expect(jsPdfInstances).toHaveLength(1);
    expect(jsPdfInstances[0].args).toEqual(['l', 'mm', 'a4']);
    expect(jsPdfInstances[0].addImage).toHaveBeenCalled();
    const [blob, name] = downloadBlobMock.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(name).toBe('Maya_and_the_Door.pdf');
    expect(screen.queryByRole('status')).toBeNull();
    // The render area's height is restored after the capture.
    expect(document.getElementById('comic-render-area')!.style.height).toBe('');
  });

  it('a load that fails is a calm status line, downloads nothing, and the button works again', async () => {
    renderExport();
    loadLegacyPdfMock.mockRejectedValueOnce(new LegacyPdfLoadError('network', 'jspdf'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const button = screen.getByRole('button', { name: /Book\/PDF/ });
    fireEvent.click(button);

    const notice = await screen.findByRole('status');
    expect(notice).toHaveTextContent(LEGACY_PDF_MESSAGES.network);
    expect(notice.className).not.toMatch(/red|brand-red/);
    expect(downloadBlobMock).not.toHaveBeenCalled();
    expect(html2canvasMock).not.toHaveBeenCalled();
    expect(button).toBeEnabled();
    warn.mockRestore();

    loadLegacyPdfMock.mockResolvedValue({ jsPDF: FakeJsPdf, html2canvas: html2canvasMock });
    fireEvent.click(button);
    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a second press while the tools are loading starts nothing new', async () => {
    renderExport();
    let release: (libs: unknown) => void = () => {};
    loadLegacyPdfMock.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const button = screen.getByRole('button', { name: /Book\/PDF/ });
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    fireEvent.click(button);
    expect(loadLegacyPdfMock).toHaveBeenCalledTimes(1);
    release({ jsPDF: FakeJsPdf, html2canvas: html2canvasMock });
    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button).toBeEnabled());
  });
});
