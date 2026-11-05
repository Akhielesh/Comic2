// P2-PLATFORM: the legacy Review & Export step never shows governed users dollars.
// Governed → shares of their usage ("≈1.2% of your usage"); admins / own key → the dollar report.
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStep, type ComicPanel, type ComicState, type Project } from '../../types';
import type { AllowanceStatus } from '../../services/usageAllowance';

vi.mock('../../services/db', () => ({
  exportProject: vi.fn(),
  getImageUrl: vi.fn(async () => undefined),
  getImageDataUrl: vi.fn(async (id: string) => `data:image/png;base64,${id}`),
  loadArtifactsForProject: vi.fn(async () => []),
  saveArtifact: vi.fn(async () => undefined)
}));

vi.mock('../../services/reporting', () => ({
  buildProjectReport: vi.fn(async () => ({
    cost_summary: { totalCost: 0.25, byModel: {}, byStage: {}, byType: {}, estimatedArtifactCount: 0, currency: 'USD' },
    ai_usage: { totalArtifacts: 0 },
    storage: {}
  }))
}));

const billing = vi.hoisted(() => ({ report: null as unknown }));
vi.mock('../../services/billing', () => ({
  getComicCost: vi.fn(async () => billing.report)
}));

const allowance = vi.hoisted(() => ({ status: null as AllowanceStatus | null }));
vi.mock('../usage/useUsageAllowance', () => ({
  useUsageAllowance: () => allowance.status
}));

vi.mock('../../services/geminiService', () => ({ runContinuityAudit: vi.fn() }));
vi.mock('../../services/generationManager', () => ({ regenerateSinglePanel: vi.fn() }));
vi.mock('../../services/appSettings', () => ({ getModelForTask: vi.fn(() => 'test-image-model') }));
vi.mock('../../services/imageModels', () => ({ getImageModelById: vi.fn(() => ({ label: 'Test Image Model' })) }));

import { ReviewExport } from './ReviewExport';

const panels: ComicPanel[] = [
  {
    id: 'panel-1',
    sceneId: 1,
    description: 'Maya opens the glowing door.',
    dialogue: 'Maya: "Whoa."',
    imageId: 'panel-image-1',
    imageUrl: 'https://example.com/panel.png',
    imageIdHistory: ['panel-image-1']
  }
];

const state: ComicState = {
  step: AppStep.REVIEW_EXPORT,
  maxStepReached: AppStep.REVIEW_EXPORT,
  flowVersion: 4,
  script: 'Maya opens a glowing attic door.',
  scenes: [
    {
      id: 1,
      rawText: 'Maya opens a glowing attic door.',
      synopsis: 'Maya opens a glowing attic door.',
      characters: ['Maya'],
      setting: 'Attic'
    }
  ],
  continuitySummary: '',
  overview: '',
  comments: [],
  isFeatured: false,
  coverPrompt: '',
  coverImageId: 'cover-image-1',
  coverImageUrl: 'https://example.com/cover.png',
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
  agentSettings: {
    confirmPolicy: 'never',
    outputTargets: ['comic', 'book', 'html'],
    autoPageCount: true
  }
};

const project: Project = {
  id: 'project-1',
  name: 'Maya and the Door',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  state
};

const status = (governed: boolean): AllowanceStatus => ({
  enabled: true,
  governed,
  pctUsed: 40,
  pctLeft: 60,
  exhausted: false,
  crossed: [30],
  resetsAt: null,
  friendlyUnits: governed ? { standardPages: 150, draftPages: 300, pctPerStandardPage: 0.5, label: 'about 150 standard comic pages left' } : null,
  usePlatformAllowance: true,
  byokFallbackMode: 'ask',
  byokAvailable: false
});

const DOLLAR_REPORT = {
  comicId: 'project-1',
  totalEstimatedCt: 0,
  totalActualCt: 1300,
  totalBillableUsd: 0.13,
  totalProviderCostUsd: 0.1,
  byStage: { generation: { ct: 1300, usd: 0.13 } },
  byModel: { 'nano-banana': { ct: 1300, usd: 0.13 } },
  events: []
};

const renderStep = () =>
  render(
    <ReviewExport
      project={project}
      onUpdateProject={vi.fn()}
      projectId="project-1"
      projectName="Maya and the Door"
      panels={panels}
      state={state}
      onReturnToPreview={vi.fn()}
      onUpdatePanel={vi.fn()}
    />
  );

const DOLLAR_TEXT = /\$\d/;

describe('ReviewExport spend display', () => {
  beforeEach(() => {
    billing.report = null;
    allowance.status = null;
  });

  it('governed user + governed report: shares of usage and the own-key note, no dollars', async () => {
    allowance.status = status(true);
    billing.report = {
      comicId: 'project-1',
      governed: true,
      usagePct: 1.24,
      byStage: { generation: { usagePct: 1.2 } },
      byModel: { 'nano-banana': { usagePct: 1.24 } },
      ownKeyEvents: 1
    };
    renderStep();
    expect(await screen.findByText('Usage so far')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('≈1.2% of your usage').length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText('Usage breakdown')).toBeTruthy();
    expect(screen.getByText('1 call ran on your own API key (not counted).')).toBeTruthy();
    expect(screen.queryByText(DOLLAR_TEXT)).toBeNull();
  });

  it('governed user + a dollar-shaped report (older backend): still no dollars', async () => {
    allowance.status = status(true);
    billing.report = DOLLAR_REPORT;
    renderStep();
    await waitFor(() => expect(screen.getAllByText(/% of your usage$/).length).toBeGreaterThanOrEqual(2));
    expect(screen.queryByText(DOLLAR_TEXT)).toBeNull();
  });

  it('admin (no limit applies): the dollar report as before', async () => {
    allowance.status = status(false);
    billing.report = DOLLAR_REPORT;
    renderStep();
    expect(await screen.findByText('Cost summary')).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('$0.1300').length).toBeGreaterThanOrEqual(2));
    expect(screen.getByText('Cost breakdown')).toBeTruthy();
  });

  it('ledger unavailable: the local estimate follows the same rule', async () => {
    billing.report = null;
    allowance.status = status(false);
    const { unmount } = renderStep();
    await waitFor(() => expect(screen.getAllByText('$0.2500').length).toBeGreaterThanOrEqual(1));
    unmount();
    allowance.status = status(true);
    renderStep();
    await waitFor(() => expect(screen.getAllByText(/% of your usage$/).length).toBeGreaterThanOrEqual(1));
    expect(screen.queryByText(DOLLAR_TEXT)).toBeNull();
  });
});
