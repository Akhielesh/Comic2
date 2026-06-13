import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStep, type ComicState } from '../../types';

const { generateImageMock, suggestCoverConceptsMock } = vi.hoisted(() => ({
  generateImageMock: vi.fn(),
  suggestCoverConceptsMock: vi.fn()
}));

vi.mock('../../services/imageService', () => ({
  generateImage: generateImageMock
}));

vi.mock('../../services/geminiService', () => ({
  suggestCoverConcepts: suggestCoverConceptsMock
}));

import { CoverDesigner } from './CoverDesigner';

const makeState = (): ComicState => ({
  step: AppStep.COVER,
  maxStepReached: AppStep.COVER,
  flowVersion: 4,
  script: 'Maya finds a glowing door in the attic.',
  creativeDirection: 'Warm mystery for young readers.',
  scenes: [
    {
      id: 1,
      rawText: 'Maya finds a glowing door in the attic.',
      synopsis: 'Maya discovers a glowing attic door.',
      characters: ['Maya'],
      setting: 'Dusty attic'
    }
  ],
  continuitySummary: '',
  overview: '',
  comments: [],
  isFeatured: false,
  coverPrompt: '',
  styleVariants: [
    {
      id: 'style-1',
      styleId: 'ligne-claire',
      imageId: 'style-image-1',
      imageUrl: 'data:image/png;base64,AA==',
      prompt: 'clean line art',
      category: 'Ligne Claire',
      aspectRatio: '1:1',
      resolution: '1K'
    }
  ],
  selectedStyleId: 'style-1',
  stylePrompt: 'clean line art',
  styleCategory: 'Ligne Claire',
  styleAspectRatio: '1:1',
  customAspectRatioEnabled: false,
  imageResolution: '1K',
  characters: [
    {
      id: 'char-1',
      name: 'Maya',
      bio: 'Curious child',
      description: 'Curious child with a yellow jacket',
      referenceImageIds: []
    }
  ],
  items: [],
  locations: [],
  layoutType: 'grid',
  panels: []
});

describe('CoverDesigner autopilot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    suggestCoverConceptsMock.mockResolvedValue([
      {
        name: 'Moon Door',
        brief: 'Maya stands before a glowing attic door.',
        typography: 'Clean friendly masthead'
      }
    ]);
    generateImageMock.mockResolvedValue({
      imageId: 'cover-image-1',
      imageUrl: 'data:image/png;base64,cover'
    });
  });

  it('generates, selects, and confirms a cover in auto-spend mode', async () => {
    const onUpdate = vi.fn();
    const onConfirm = vi.fn();

    render(
      <CoverDesigner
        state={makeState()}
        projectId="project-1"
        projectName="Maya and the Door"
        agentSettings={{ confirmPolicy: 'never', outputTargets: ['comic', 'book', 'html'], autoPageCount: true }}
        onUpdate={onUpdate}
        onConfirm={onConfirm}
      />
    );

    await waitFor(() => {
      expect(generateImageMock).toHaveBeenCalledTimes(1);
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({
        coverImageId: 'cover-image-1',
        coverImageUrl: 'data:image/png;base64,cover',
        coverTemplateId: 'ai:Moon Door'
      }));
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });

  it('does not generate or confirm automatically in guided mode', async () => {
    const onUpdate = vi.fn();
    const onConfirm = vi.fn();

    render(
      <CoverDesigner
        state={makeState()}
        projectId="project-1"
        projectName="Maya and the Door"
        agentSettings={{ confirmPolicy: 'big_spends', outputTargets: ['comic', 'book', 'html'], autoPageCount: true }}
        onUpdate={onUpdate}
        onConfirm={onConfirm}
      />
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(generateImageMock).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ coverImageId: 'cover-image-1' }));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
