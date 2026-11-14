// Read-only Models evidence. Public artwork comes only from published platform-library snapshots.
// Authenticated owners may also see their own generated assets through the separately scoped owner reader.
// Unpublished library candidates, Model Lab runs and generation calls are never used here.
import { isAdminSpendCallKind, sanitizeLibraryProvenance, type LibraryIndex } from '../../../shared/comic/library.js';
import { getImageModel, type ImageModelSpec } from '../../../shared/comic/models.js';
import {
  MODEL_SHOWCASE_IDS,
  type ModelShowcaseExample,
  type ModelShowcaseMetric,
  type ModelShowcaseResponse,
  type ModelShowcaseRow
} from '../../../shared/modelShowcase.js';
import { createDefaultLibraryDeps, publicIndex } from '../comic/library/index.js';
import { createSupabaseImageCallsDb, MIN_PLATFORM_USERS, type PlatformStatRow } from '../comic/models/index.js';
import { qualityEntriesFor } from '../comic/models/quality.js';
import { logger } from '../lib/logger.js';
import { getSupabaseCapabilityStatus } from './supabase.js';
import { readOwnerModelExamples } from './modelShowcaseOwner.js';

export const SHOWCASE_WINDOW_DAYS = 30 as const;
export const SHOWCASE_EXAMPLES_PER_MODEL = 3;
const READ_TIMEOUT_MS = 6_000;
const IMAGE_KINDS = new Set(['page', 'cover', 'sheet', 'place', 'style_option', 'edit']);
const finiteNonnegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const count = (v: unknown): v is number => finiteNonnegative(v) && Number.isSafeInteger(v);
const isoDate = (v: string | null): string | null => v && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : null;

export interface ModelShowcaseDeps {
  /** Null means storage is not configured; [] / an empty index means a successful empty read. */
  publishedLibrary(): Promise<LibraryIndex | null>;
  platformStats(sinceIso: string): Promise<PlatformStatRow[] | null>;
  ownExamples?(userId: string): Promise<ModelShowcaseExample[] | null>;
  now?: () => number;
}

const defaults: ModelShowcaseDeps = {
  async publishedLibrary() {
    if (!getSupabaseCapabilityStatus().storagePersistenceEnabled) return null;
    // This helper reads listPublished only. Constructing deps does not read a key or run a build.
    return (await publicIndex(createDefaultLibraryDeps())).index;
  },
  async platformStats(sinceIso) {
    const calls = createSupabaseImageCallsDb();
    return calls ? calls.platformStats(sinceIso) : null;
  },
  ownExamples: readOwnerModelExamples
};

/** Only public platform-library objects, never user lanes, signed private URLs or inline content. */
const libraryUrl = (raw: unknown): string | null => {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
    if (!/^\/storage\/v1\/object\/public\/[^/]+\/library\/.+/.test(url.pathname)) return null;
    if (/%|\\|[\u0000-\u001f]/.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
};

function examplesFor(index: LibraryIndex | null, spec: ImageModelSpec): ModelShowcaseExample[] {
  const seen = new Set<string>();
  const examples: ModelShowcaseExample[] = [];
  for (const asset of index?.assets ?? []) {
    const provenance = sanitizeLibraryProvenance(asset.provenance);
    if (!provenance || provenance.model !== spec.id) continue;
    // Conflicting provider provenance is not evidence for this row. Older snapshots may omit providerModel.
    if (provenance.providerModel && provenance.providerModel !== spec.routes[provenance.route]) continue;
    const url = libraryUrl(asset.url);
    if (!url || seen.has(url) || !finiteNonnegative(asset.w) || !finiteNonnegative(asset.h) || !asset.w || !asset.h) continue;
    if (!finiteNonnegative(provenance.generatedAt) || provenance.generatedAt === 0) continue;
    seen.add(url);
    examples.push({
      id: asset.id,
      url,
      thumbnailUrl: libraryUrl(asset.thumbs?.[640]) ?? libraryUrl(asset.thumbs?.[320]) ?? url,
      alt: asset.alt || `Platform artwork generated with ${spec.nickname}`,
      width: asset.w,
      height: asset.h,
      generatedAt: provenance.generatedAt,
      resolution: provenance.resolution,
      source: 'platform_library',
      modelId: spec.id,
      providerModelId: provenance.providerModel ?? null
    });
  }
  return examples.sort((a, b) => b.generatedAt - a.generatedAt || a.id.localeCompare(b.id));
}

function metricsFor(stats: PlatformStatRow[] | null, modelId: string): ModelShowcaseMetric[] {
  return (stats ?? []).filter((s) =>
    s.modelId === modelId && count(s.distinctUsers) && s.distinctUsers >= MIN_PLATFORM_USERS &&
    !isAdminSpendCallKind(s.kind) && IMAGE_KINDS.has(s.kind) &&
    count(s.calls) && count(s.ok) && count(s.failed) && s.calls >= MIN_PLATFORM_USERS && s.ok + s.failed <= s.calls
  ).map((s) => {
    // The RPC separately applies the five-user floor to the newest <=20 priced calls.
    const priced = count(s.costN) && s.costN >= MIN_PLATFORM_USERS && s.costN <= 20 && s.costN <= s.ok && finiteNonnegative(s.medianCostUsd);
    return {
      kind: s.kind,
      resolution: s.res,
      calls: s.calls,
      successfulCalls: s.ok,
      failedCalls: s.failed,
      medianCostUsd: priced ? s.medianCostUsd : null,
      costSamples: priced ? s.costN : 0,
      costFrom: priced ? isoDate(s.costFrom) : null,
      costTo: priced ? isoDate(s.costTo) : null,
      medianLatencyMs: null,
      latencySamples: 0
    } satisfies ModelShowcaseMetric;
  }).sort((a, b) => `${a.kind}|${a.resolution ?? ''}`.localeCompare(`${b.kind}|${b.resolution ?? ''}`));
}

async function boundedRead<T>(source: 'samples' | 'metrics' | 'ownSamples', read: () => Promise<T | null>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('read_timeout')), READ_TIMEOUT_MS); })
    ]);
  } catch {
    logger.warn('model_showcase_source_unavailable', { source });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getModelShowcase(userId?: string, deps: ModelShowcaseDeps = defaults): Promise<ModelShowcaseResponse> {
  const now = (deps.now ?? Date.now)();
  const windowStart = new Date(now - SHOWCASE_WINDOW_DAYS * 86_400_000).toISOString();
  const [library, stats, own] = await Promise.all([
    boundedRead('samples', () => deps.publishedLibrary()),
    boundedRead('metrics', () => deps.platformStats(windowStart)),
    userId ? boundedRead('ownSamples', () => deps.ownExamples ? deps.ownExamples(userId) : Promise.resolve(null)) : Promise.resolve(null)
  ]);
  const rows: ModelShowcaseRow[] = MODEL_SHOWCASE_IDS.flatMap((id) => {
    const spec = getImageModel(id);
    if (!spec) return [];
    const published = examplesFor(library, spec);
    const personal = (own ?? []).filter((example) => example.modelId === id && example.source === 'your_comic');
    const examples = [...personal, ...published];
    const metrics = metricsFor(stats, id);
    return [{
      modelId: spec.id,
      providerModelId: spec.routes.openrouter ?? spec.routes.gemini ?? null,
      name: spec.nickname,
      vendor: spec.vendor,
      lifecycle: spec.lifecycle,
      studioSupported: spec.pickable,
      catalogOnly: !spec.pickable,
      factsAsOf: spec.factsAsOf,
      // Read the committed dated snapshot only: this endpoint never refreshes/persists a benchmark.
      // Exact provider id means GPT 2.6 cannot inherit GPT 2.5's rankings.
      quality: qualityEntriesFor(spec.routes.openrouter).sort((a, b) => {
        const order = ['lmarena_t2i', 'aa_t2i', 'lmarena_edit', 'aa_edit', 'lmarena_multi_image', 'design_arena'];
        return order.indexOf(a.board) - order.indexOf(b.board);
      }),
      capabilities: {
        references: spec.refs.total,
        resolutions: [...spec.resolutions],
        aspects: [...spec.aspects],
        editing: spec.edit,
        lettering: spec.text,
        pageComposition: spec.pages
      },
      listPrices: spec.resolutions.flatMap((resolution) => {
        const usd = spec.priceUsd[resolution];
        return finiteNonnegative(usd) ? [{ resolution, usd, basis: spec.priceBasis }] : [];
      }),
      examples: examples.slice(0, SHOWCASE_EXAMPLES_PER_MODEL),
      publishedExampleCount: published.length,
      ownExampleCount: personal.length,
      sampleState: examples.length ? 'available' : library === null && (!userId || own === null) ? 'source_unavailable' : 'not_recorded',
      metrics,
      metricState: stats === null ? 'source_unavailable' : metrics.length ? 'available' : 'insufficient_data'
    }];
  });
  return {
    generatedAt: new Date(now).toISOString(),
    windowDays: SHOWCASE_WINDOW_DAYS,
    windowStart,
    scope: userId ? 'platform_and_yours' : 'platform',
    sourceStatus: {
      samples: library === null ? 'unavailable' : 'ready',
      metrics: stats === null ? 'unavailable' : 'ready',
      ownSamples: !userId ? 'not_requested' : own === null ? 'unavailable' : 'ready'
    },
    rows
  };
}
