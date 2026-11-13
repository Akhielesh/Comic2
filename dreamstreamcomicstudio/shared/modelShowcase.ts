// Models workspace: published platform artwork and measured, privacy-approved image-call data.
// Registry list prices are dated reference prices, never measured generation costs or a live quote.
import type { AspectRatio, Resolution } from './comic/doc.js';
import type { ImageModelSpec, Quality4 } from './comic/models.js';
import type { QualityEntry } from './comic/modelCatalog.js';

export const MODEL_SHOWCASE_IDS = [
  'nano-banana-2.1',
  'nano-banana-pro',
  'gpt-image-2.6-sunburst',
  'gpt-image-2.6-flare',
  'flux-3'
] as const;

export interface ModelShowcaseExample {
  id: string;
  url: string;
  thumbnailUrl: string;
  alt: string;
  width: number;
  height: number;
  generatedAt: number;
  resolution: string;
  source: 'platform_library' | 'your_comic';
  /** Present only for the authenticated owner's own output. Never part of a public sample. */
  projectId?: string;
  title?: string;
  readingLink?: string;
  /** Server-written provenance of this published revision, never inferred from the artwork. */
  modelId: string;
  providerModelId: string | null;
}

export interface ModelShowcaseMetric {
  kind: string;
  resolution: string | null;
  calls: number;
  successfulCalls: number;
  failedCalls: number;
  /** Median of the newest at most 20 provider-priced successful calls in this group. */
  medianCostUsd: number | null;
  costSamples: number;
  costFrom: string | null;
  costTo: string | null;
  /** The existing privacy-approved aggregate does not publish latency. Never substitute an estimate. */
  medianLatencyMs: null;
  latencySamples: 0;
}

export interface ModelShowcaseRow {
  modelId: string;
  providerModelId: string | null;
  name: string;
  vendor: ImageModelSpec['vendor'];
  lifecycle: ImageModelSpec['lifecycle'];
  studioSupported: boolean;
  catalogOnly: boolean;
  factsAsOf: string;
  /** Exact-model public benchmark entries, each with its original source and date; never platform results. */
  quality?: QualityEntry[];
  capabilities: {
    references: number;
    resolutions: Resolution[];
    aspects: AspectRatio[];
    editing: Quality4;
    lettering: Quality4;
    pageComposition: Quality4;
  };
  listPrices: Array<{ resolution: Resolution; usd: number; basis: ImageModelSpec['priceBasis'] }>;
  examples: ModelShowcaseExample[];
  /** Count of attributed, currently published library images; not a count of customer generations. */
  publishedExampleCount: number;
  /** Owner examples returned from their most recently updated comics (bounded, not a lifetime count). */
  ownExampleCount: number;
  sampleState: 'available' | 'not_recorded' | 'source_unavailable';
  metrics: ModelShowcaseMetric[];
  metricState: 'available' | 'insufficient_data' | 'source_unavailable';
}

export interface ModelShowcaseResponse {
  generatedAt: string;
  windowDays: 30;
  windowStart: string;
  scope: 'platform' | 'platform_and_yours';
  sourceStatus: {
    samples: 'ready' | 'unavailable';
    metrics: 'ready' | 'unavailable';
    ownSamples: 'ready' | 'unavailable' | 'not_requested';
  };
  rows: ModelShowcaseRow[];
}
