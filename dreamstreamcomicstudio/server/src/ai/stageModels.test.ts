import { describe, it, expect, vi, beforeEach } from 'vitest';

const getCatalogMock = vi.hoisted(() => vi.fn());
const pickTextModelMock = vi.hoisted(() => vi.fn());
const pickImageModelMock = vi.hoisted(() => vi.fn());

vi.mock('../services/modelCatalog.js', () => ({ getCatalog: getCatalogMock }));
vi.mock('./autoRouter.js', () => ({
  pickTextModel: pickTextModelMock,
  pickImageModel: pickImageModelMock
}));

import { resolveStageModel } from './stageModels.js';

const model = (id: string, over: Record<string, unknown> = {}): any => ({
  id,
  name: id,
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportedParameters: [],
  pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 },
  isFree: true,
  supportsImageOutput: false,
  supportsImageInput: false,
  supportsJsonOutput: false,
  contextLength: 8000,
  roles: [],
  costBand: 'free',
  drawbacks: [],
  possibilities: [],
  ...over
});

describe('resolveStageModel', () => {
  beforeEach(() => {
    getCatalogMock.mockReset();
    pickTextModelMock.mockReset().mockResolvedValue('auto/text-json');
    pickImageModelMock.mockReset().mockResolvedValue('auto/image');
  });

  it('honors a requested model that meets a stage requirement (structuredJson)', async () => {
    getCatalogMock.mockResolvedValue({ models: [model('vendor/json', { supportsJsonOutput: true })] });
    const res = await resolveStageModel('analyze_script', 'vendor/json');
    expect(res.model).toBe('vendor/json');
    expect(res.downgradedFrom).toBeUndefined();
    expect(pickTextModelMock).not.toHaveBeenCalled();
  });

  it('downgrades a requested model that lacks structuredJson for a structured stage', async () => {
    getCatalogMock.mockResolvedValue({ models: [model('vendor/prose', { supportsJsonOutput: false })] });
    const res = await resolveStageModel('analyze_script', 'vendor/prose');
    expect(res.model).toBe('auto/text-json');
    expect(res.downgradedFrom).toBe('vendor/prose');
    expect(res.reason).toMatch(/structuredJson/);
    expect(pickTextModelMock).toHaveBeenCalledTimes(1);
  });

  it('auto-picks (capability-filtered) when no model is requested', async () => {
    const res = await resolveStageModel('panel_breakdown');
    expect(res.model).toBe('auto/text-json');
    expect(getCatalogMock).not.toHaveBeenCalled(); // no requested model → straight to autoPick
  });

  it('honors any requested model for a no-requirement (prose) stage without a catalog lookup', async () => {
    const res = await resolveStageModel('story_outline', 'vendor/anything');
    expect(res.model).toBe('vendor/anything');
    expect(getCatalogMock).not.toHaveBeenCalled();
  });

  it('honors a requested model the catalog does not know (cannot prove it incapable)', async () => {
    getCatalogMock.mockResolvedValue({ models: [] });
    const res = await resolveStageModel('analyze_script', 'vendor/unknown');
    expect(res.model).toBe('vendor/unknown');
  });

  it('routes image stages through the image picker', async () => {
    const res = await resolveStageModel('image_generation');
    expect(res.model).toBe('auto/image');
    expect(pickImageModelMock).toHaveBeenCalledTimes(1);
  });
});
