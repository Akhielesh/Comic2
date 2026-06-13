import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AppStep, type ComicPanel, type ComicState, type Project } from '../../types';

const { saveArtifactMock, getImageDataUrlMock } = vi.hoisted(() => ({
  saveArtifactMock: vi.fn(async () => undefined),
  getImageDataUrlMock: vi.fn(async (id: string) => `data:image/png;base64,${id}`)
}));

vi.mock('../../services/db', () => ({
  exportProject: vi.fn(),
  getImageUrl: vi.fn(async () => undefined),
  getImageDataUrl: getImageDataUrlMock,
  loadArtifactsForProject: vi.fn(async () => []),
  saveArtifact: saveArtifactMock
}));

vi.mock('../../services/reporting', () => ({
  buildProjectReport: vi.fn(async () => ({
    cost_summary: { totalCost: 0 },
    ai_usage: { totalArtifacts: 0 },
    storage: {}
  }))
}));

vi.mock('../../services/billing', () => ({
  getComicCost: vi.fn(async () => ({
    totalActualCt: 0,
    totalBillableUsd: 0,
    totalProviderCostUsd: 0,
    byStage: {},
    byModel: {}
  }))
}));

vi.mock('../../services/geminiService', () => ({
  runContinuityAudit: vi.fn()
}));

vi.mock('../../services/generationManager', () => ({
  regenerateSinglePanel: vi.fn()
}));

vi.mock('../../services/appSettings', () => ({
  getModelForTask: vi.fn(() => 'test-image-model')
}));

vi.mock('../../services/imageModels', () => ({
  getImageModelById: vi.fn(() => ({ label: 'Test Image Model' }))
}));

import { ReviewExport } from './ReviewExport';

type SavedArtifactCall = [{
  meta?: { target?: string };
  responseText?: string;
}];

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

describe('ReviewExport auto prepare', () => {
  it('prepares requested comic, book, and HTML artifacts on review load', async () => {
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

    await waitFor(() => {
      const artifactCalls = saveArtifactMock.mock.calls as unknown as SavedArtifactCall[];
      const targets = artifactCalls.map(([artifact]) => artifact.meta?.target).sort();
      expect(targets).toEqual(['book', 'comic', 'html']);
    });

    const artifactCalls = saveArtifactMock.mock.calls as unknown as SavedArtifactCall[];
    const htmlArtifact = artifactCalls.find(([artifact]) => artifact.meta?.target === 'html')?.[0];
    expect(htmlArtifact).toBeTruthy();
    expect(htmlArtifact?.responseText).toContain('<!DOCTYPE html>');
    expect(htmlArtifact?.responseText).toContain('data:image/png;base64,panel-image-1');
    expect(getImageDataUrlMock).toHaveBeenCalledWith('cover-image-1');
  });
});
