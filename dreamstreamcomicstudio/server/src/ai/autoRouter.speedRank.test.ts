import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the catalog + the two speed signals the latency-aware ranker consults.
const catalogMock = vi.hoisted(() => ({ models: [] as any[] }));
const latencyMock = vi.hoisted(() => ({ map: {} as Record<string, { p50Ms: number; samples: number }> }));
const scoreMock = vi.hoisted(() => ({ map: new Map<string, number>() }));

vi.mock('../services/modelCatalog.js', () => ({ getCatalog: async () => catalogMock }));
vi.mock('../services/telemetryAnalytics.js', () => ({ getModelLatency: async () => latencyMock.map }));
vi.mock('../services/modelStats.js', () => ({ loadScoreMap: async () => scoreMock.map }));

import { pickTextModel } from './autoRouter.js';

const model = (over: any) => ({
  id: 'x',
  name: 'x',
  source: 'openrouter',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportedParameters: [],
  pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 },
  isFree: true,
  costClass: 'free_verified',
  supportsImageOutput: false,
  supportsImageInput: false,
  supportsJsonOutput: true,
  roles: [],
  costBand: 'free',
  drawbacks: [],
  possibilities: [],
  ...over
});

describe('autoRouter latency-aware ranking (quality path)', () => {
  beforeEach(() => {
    catalogMock.models = [];
    latencyMock.map = {};
    scoreMock.map = new Map();
  });

  it('prefers a fast measured model over a slower one with a much larger context window', async () => {
    // The old tie-break was "largest context wins", which on a free key selected the huge
    // :free reasoners that queue 30-320s. The fix ranks by measured p50 first.
    catalogMock.models = [
      model({ id: 'slow/huge-context:free', contextLength: 1_000_000 }),
      model({ id: 'fast/small-context:free', contextLength: 32_000 })
    ];
    latencyMock.map = {
      'slow/huge-context:free': { p50Ms: 56_000, samples: 30 },
      'fast/small-context:free': { p50Ms: 2_000, samples: 30 }
    };
    const id = await pickTextModel({ costPref: 'quality' });
    expect(id).toBe('fast/small-context:free');
  });
});
