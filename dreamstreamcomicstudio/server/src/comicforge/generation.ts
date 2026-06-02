// Request-independent image generation for the ComicForge worker.
//
// The worker runs as its own BullMQ process with no Express `req`, so it can't reuse
// the request-bound image routes (which resolve BYOK keys + billing from `req`). This
// helper drives the LIVE OpenRouter gateway with the platform key instead, resolving the
// model through the capability-aware stage resolver (NOT the deprecated modelRouter table)
// and persisting each result through the shared image storage pipeline.
//
// Billing note: worker generation is funded by the platform key and is NOT metered through
// the per-request usageEnforcer (there is no request to attach a reservation to). ComicForge
// is feature-flagged + experimental; meter it via a job-level ledger before any GA use.

import { OPENROUTER_API_KEY, OPENROUTER_IMAGE_MODEL } from '../config.js';
import { getProvider, resolveProviderContext } from '../ai/gateway.js';
import { resolveStageModel } from '../ai/stageModels.js';
import { persistGeneratedImage } from '../services/imageStorage.js';
import { readComicForgeState } from './repositories.js';
import { buildNoTextPrompt, assertNoTextPromptContract } from './modelRouter.js';
import type { ComicForgeState } from '../../../types.js';

const MAX_PAGES_PER_JOB = 8;

export type ComicForgeGeneratedPage = {
  pageNumber: number;
  purpose: string;
  imageId: string;
  imageUrl: string;
};

export type ComicForgeGenerationResult = {
  generated: true;
  quality: 'draft' | 'final' | 'thumbnail';
  model: string;
  modelDowngradedFrom?: string;
  pageCount: number;
  pages: ComicForgeGeneratedPage[];
  completedAt: number;
};

type GenerationInput = {
  projectId: string;
  userId: string;
  quality: 'draft' | 'final' | 'thumbnail';
  onProgress?: (progress: number, message: string) => Promise<void> | void;
};

const buildPagePrompt = (state: ComicForgeState, pageNumber: number, purpose: string): string => {
  const styleFragment = state.styleBible?.baseGenerationPromptFragment
    || (state.styleRecommendations?.[0]?.stylePromptSeed
      ? `Comic style: ${state.styleRecommendations[0].stylePromptSeed}`
      : 'Clean modern comic illustration, cinematic framing');

  // Anchor the page to its narrative purpose + the matching scene synopsis when available.
  const sceneSynopsis = state.analysis?.structuredScript?.[pageNumber - 1]?.panels
    ?.map((panel) => panel.description)
    .filter(Boolean)
    .join(' ')
    .slice(0, 600);

  const ratioHint = state.formatSpec
    ? `Target canvas ${state.formatSpec.canvasWidthPx}x${state.formatSpec.canvasHeightPx}px (${state.formatSpec.readingFormat}).`
    : '';

  const base = [
    styleFragment,
    `Comic page ${pageNumber} — narrative purpose: ${purpose}.`,
    sceneSynopsis ? `Scene content: ${sceneSynopsis}` : '',
    ratioHint
  ].filter(Boolean).join('\n\n');

  const prompt = buildNoTextPrompt(
    base,
    'Composition rule: leave the upper-left and lower-third zones uncluttered for lettering overlay.'
  );
  assertNoTextPromptContract(prompt);
  return prompt;
};

/**
 * Generate one image per planned page (capped) for a ComicForge project and persist each.
 * Throws a clear, public-coded error when the platform key is missing so the worker can
 * surface it on the job instead of failing opaquely.
 */
export const generateComicForgeImages = async (
  input: GenerationInput
): Promise<ComicForgeGenerationResult> => {
  if (!OPENROUTER_API_KEY.trim()) {
    const error = new Error('OPENROUTER_API_KEY is not configured for ComicForge generation.') as Error & {
      status?: number;
      publicCode?: string;
    };
    error.status = 503;
    error.publicCode = 'COMICFORGE_PROVIDER_UNAVAILABLE';
    throw error;
  }

  const state = await readComicForgeState(input.projectId, input.userId);

  const pagePlan = state.architecture?.pagePlan?.length
    ? state.architecture.pagePlan
    : [{ pageNumber: 1, purpose: 'setup' as const }];
  const pages = pagePlan.slice(0, MAX_PAGES_PER_JOB);

  // Quality maps to cost preference: drafts/thumbnails favour cheap/free models; finals
  // favour quality. Model selection goes through the LIVE catalog-aware resolver.
  const costPref = input.quality === 'final' ? 'quality' : 'free';
  const { model, downgradedFrom } = await resolveStageModel('image_generation', OPENROUTER_IMAGE_MODEL, { costPref });

  const resolution = input.quality === 'final' ? '2K' : '1K';
  const negativePrompt = state.styleBible?.negativePromptFragment
    || 'no text artifacts, no logos, no speech bubbles, no watermarks';

  const generated: ComicForgeGeneratedPage[] = [];
  const provider = getProvider('openrouter');
  const ctx = resolveProviderContext();

  for (let index = 0; index < pages.length; index += 1) {
    const page = pages[index];
    const prompt = buildPagePrompt(state, page.pageNumber, page.purpose);

    const image = await provider.generateImage(
      { model, prompt, negativePrompt },
      ctx
    );

    const saved = await persistGeneratedImage({
      userId: input.userId,
      projectId: input.projectId,
      dataUrl: image.imageDataUrl,
      source: 'openrouter',
      resolution
    });

    generated.push({
      pageNumber: page.pageNumber,
      purpose: page.purpose,
      imageId: saved.imageId,
      imageUrl: saved.imageUrl
    });

    if (input.onProgress) {
      const progress = 35 + Math.round(((index + 1) / pages.length) * 55); // 35→90 across pages
      await input.onProgress(progress, `Generated page ${page.pageNumber} of ${pages.length}`);
    }
  }

  return {
    generated: true,
    quality: input.quality,
    model,
    modelDowngradedFrom: downgradedFrom,
    pageCount: generated.length,
    pages: generated,
    completedAt: Date.now()
  };
};
