import { post } from './apiClient';
import { AspectRatio, ImageResolution } from '../types';
import { LayoutAnalysisResponse, StyleAnalysisResponse } from '../apiTypes';

/**
 * PageStudio service — the single-sheet generation engine.
 *
 * It deliberately talks to the existing provider-agnostic image endpoint
 * (`/api/image/openrouter`, which accepts reference images and works regardless
 * of the AI_PROVIDER flag) and the vision endpoints for style/layout intake.
 * No per-panel orchestration, no continuity bible — one page, then edits.
 */

export type StyleAnalysisInput = {
  images?: string[];
  textHint?: string;
  projectId?: string;
};

export const analyzeStyle = (input: StyleAnalysisInput) =>
  post<StyleAnalysisInput, StyleAnalysisResponse>('/api/vision/analyze-style', {
    images: input.images || [],
    textHint: input.textHint,
    projectId: input.projectId
  });

export type LayoutAnalysisInput = {
  images: string[];
  projectId?: string;
};

export const analyzeLayout = (input: LayoutAnalysisInput) =>
  post<LayoutAnalysisInput, LayoutAnalysisResponse>('/api/vision/analyze-layout', {
    images: input.images,
    projectId: input.projectId
  });

export type PageImageResult = {
  /** Persisted URL when storage === 'project'. */
  imageUrl?: string;
  imageId?: string;
  /** Inline data URL — always present for storage === 'test' samples. */
  dataUrl?: string;
  mimeType?: string;
  model?: string;
};

type ImageApiResponse = {
  imageUrl?: string;
  imageId?: string;
  dataUrl?: string;
  mimeType?: string;
  model?: string;
};

export type GeneratePageInput = {
  prompt: string;
  aspectRatio: AspectRatio;
  resolution: ImageResolution;
  /** Style + layout reference images as data URLs. */
  referenceImages?: string[];
  projectId?: string;
  /** 'test' returns an inline sample without persisting; 'project' persists to storage. */
  storage?: 'project' | 'test';
  signal?: AbortSignal;
};

const callImage = async (body: Record<string, unknown>, signal?: AbortSignal): Promise<PageImageResult> => {
  const res = await post<Record<string, unknown>, ImageApiResponse>('/api/image/openrouter', body, {
    signal,
    stage: 'page_generation'
  });
  return {
    imageUrl: res.imageUrl,
    imageId: res.imageId,
    dataUrl: res.dataUrl,
    mimeType: res.mimeType,
    model: res.model
  };
};

/** Generate one full comic page (panels, gutters, lettering baked into a single image). */
export const generatePage = (input: GeneratePageInput): Promise<PageImageResult> =>
  callImage(
    {
      prompt: input.prompt,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      referenceImages: input.referenceImages || [],
      projectId: input.projectId,
      storage: input.storage || 'project'
    },
    input.signal
  );

export type EditPageInput = {
  instruction: string;
  /** The current page image (data URL or fetched-as-data-url) to edit. */
  currentImage: string;
  /** Optional extra references (style/layout) to keep consistency during the edit. */
  extraReferences?: string[];
  aspectRatio: AspectRatio;
  resolution: ImageResolution;
  projectId?: string;
  signal?: AbortSignal;
};

/**
 * Patch a specific part of an existing page using an image-editing-capable model.
 * The current page is passed as the primary reference so the model edits it in place
 * rather than starting from scratch.
 */
export const editPage = (input: EditPageInput): Promise<PageImageResult> =>
  callImage(
    {
      prompt:
        `Edit the provided comic page image. Apply ONLY this change and keep everything else identical ` +
        `(same panels, layout, characters, style, lettering): ${input.instruction.trim()}`,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      referenceImages: [input.currentImage, ...(input.extraReferences || [])],
      projectId: input.projectId,
      storage: 'project'
    },
    input.signal
  );

export type LayoutPreset = {
  id: string;
  label: string;
  description: string;
  /** Prompt fragment describing the panel grid for the generator. */
  promptFragment: string;
};

export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    id: 'classic-6',
    label: 'Classic 6-panel',
    description: 'A 2×3 grid of equal panels — the traditional comic page.',
    promptFragment: 'a classic 2 columns by 3 rows grid of six equal rectangular panels with clean gutters'
  },
  {
    id: 'splash-plus-3',
    label: 'Splash + 3',
    description: 'A large hero panel on top, three smaller panels beneath.',
    promptFragment: 'one large wide hero panel across the top half, and three smaller equal panels in a row beneath it'
  },
  {
    id: 'dynamic-5',
    label: 'Dynamic 5',
    description: 'Five panels with varied sizes and a diagonal, action-oriented flow.',
    promptFragment: 'five panels of varied sizes arranged dynamically with a diagonal reading flow for action pacing'
  },
  {
    id: 'webtoon-strip',
    label: 'Vertical strip',
    description: 'Tall stacked panels for vertical / webtoon reading.',
    promptFragment: 'tall vertically stacked panels of varying heights designed for vertical webtoon scrolling'
  },
  {
    id: 'full-splash',
    label: 'Full splash',
    description: 'A single full-page illustration with no internal panel borders.',
    promptFragment: 'a single full-page splash illustration with no internal panel borders'
  }
];

/**
 * Compose the full-page generation prompt from the confirmed brief, style and layout.
 * This is the single place where "user needs → page" is assembled.
 */
export const composePagePrompt = (params: {
  brief: string;
  styleBrief?: string;
  stylePrompt?: string;
  styleTags?: string[];
  layoutBrief?: string;
  layoutFragment?: string;
}): string => {
  const styleLine = [params.styleBrief, params.stylePrompt].filter(Boolean).join(' ');
  const tags = params.styleTags?.length ? `Style tags: ${params.styleTags.join(', ')}.` : '';
  const layoutLine =
    params.layoutBrief?.trim() ||
    (params.layoutFragment ? `Lay the page out as ${params.layoutFragment}.` : 'Use a clear, readable multi-panel comic layout.');

  return [
    'Create ONE complete, print-ready comic book page as a single image.',
    `Story / scene for this page: ${params.brief.trim()}`,
    layoutLine,
    styleLine ? `Art style to follow exactly: ${styleLine}` : '',
    tags,
    'Render multiple panels with clean gutters and panel borders on the page. Include speech bubbles, captions and ' +
      'lettering where appropriate, with legible text. Keep characters and style consistent across every panel. ' +
      'High detail, sharp, professional comic art.'
  ]
    .filter(Boolean)
    .join('\n');
};
