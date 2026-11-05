// Catalog fixtures for the Model Library tests: realistic list prices, both providers, text and image
// rows (enough of each to band), a :free row, OpenRouter's -1 "variable" router, a model whose own
// description quotes vendor prices, and a token-billed image model annotated by the REAL server
// annotateModel (so its "$0 per image" drawback and editorial note are exactly what the catalog serves).
import type { CatalogModel } from '../../../services/modelCatalog';
import { annotateModel } from '../../../server/src/ai/catalogAnnotations';

export const catalogModel = (over: Partial<CatalogModel> & { id: string }): CatalogModel => ({
  name: over.id,
  source: 'openrouter',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportedParameters: [],
  pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: 0, requestFlat: 0 },
  isFree: false,
  costClass: 'paid',
  supportsImageOutput: false,
  supportsImageInput: false,
  supportsJsonOutput: false,
  roles: [],
  costBand: 'medium',
  drawbacks: [],
  possibilities: [],
  ...over
});

const perM = (usdPerMillion: number) => usdPerMillion / 1_000_000;

const textModel = (id: string, name: string, inUsd: number, outUsd: number, over: Partial<CatalogModel> = {}): CatalogModel =>
  catalogModel({
    id,
    name,
    contextLength: 128_000,
    pricing: { promptPerToken: perM(inUsd), completionPerToken: perM(outUsd), imagePerImage: 0, requestFlat: 0 },
    costBand: outUsd >= 5 ? 'high' : outUsd >= 1 ? 'medium' : 'low',
    possibilities: ['Long-form writing'],
    drawbacks: ['Can be verbose'],
    ...over
  });

const imageModel = (id: string, name: string, usd: number): CatalogModel =>
  catalogModel({
    id,
    name,
    inputModalities: ['text', 'image'],
    outputModalities: ['image'],
    supportsImageOutput: true,
    supportsImageInput: true,
    costClass: 'per_image_only',
    costBand: usd >= 0.05 ? 'high' : 'medium',
    pricing: { promptPerToken: 0, completionPerToken: 0, imagePerImage: usd, requestFlat: 0 },
    possibilities: ['Panel art']
  });

/** Gemini "Nano Banana": $0 per image on the list, billed per token (shared/pricing zero_priced_token_billed). */
export const TOKEN_BILLED_IMAGE_MODEL: CatalogModel = annotateModel({
  id: 'google/gemini-2.5-flash-image',
  name: 'Google: Gemini 2.5 Flash Image (Nano Banana)',
  source: 'openrouter',
  inputModalities: ['text', 'image'],
  outputModalities: ['image', 'text'],
  supportedParameters: [],
  pricing: { promptPerToken: perM(0.3), completionPerToken: perM(2.5), imagePerImage: 0, requestFlat: 0 },
  isFree: false,
  costClass: 'zero_priced_token_billed',
  supportsImageOutput: true,
  supportsImageInput: true,
  supportsJsonOutput: false
}) as CatalogModel;

/** An upstream description that quotes the vendor's prices (OpenRouter descriptions often do). */
export const PRICED_DESCRIPTION =
  'Anthropic’s balanced frontier model. It is priced at $3 per million input tokens and $15 per million output tokens. Strong at coding and long documents.';

export const FIXTURE_CATALOG: CatalogModel[] = [
  textModel('anthropic/claude-sonnet-4.5', 'Anthropic: Claude Sonnet 4.5', 3, 15, { description: PRICED_DESCRIPTION }),
  textModel('openai/gpt-4o', 'OpenAI: GPT-4o', 2.5, 10),
  textModel('google/gemini-2.5-flash', 'Google: Gemini 2.5 Flash', 0.3, 2.5),
  textModel('deepseek/deepseek-chat', 'DeepSeek: DeepSeek V3', 0.27, 1.1),
  textModel('meta-llama/llama-3.3-70b-instruct', 'Meta: Llama 3.3 70B Instruct', 0.12, 0.3),
  textModel('qwen/qwen-2.5-72b-instruct', 'Qwen2.5 72B Instruct', 0.35, 0.4),
  textModel('meta/llama-3.1-405b-instruct', 'Llama 3.1 405B Instruct', 1, 3, { source: 'nvidia' }),
  textModel('meta-llama/llama-3.3-70b-instruct:free', 'Meta: Llama 3.3 70B Instruct (free)', 0, 0, {
    isFree: true,
    costClass: 'free_verified',
    costBand: 'free'
  }),
  catalogModel({
    id: 'openrouter/auto',
    name: 'Auto Router',
    pricing: { promptPerToken: -1, completionPerToken: -1, imagePerImage: 0, requestFlat: 0 }
  }),
  imageModel('openai/gpt-image-1', 'OpenAI: GPT Image 1', 0.04),
  imageModel('black-forest-labs/flux-1.1-pro', 'Black Forest Labs: FLUX 1.1 Pro', 0.04),
  imageModel('google/imagen-4', 'Google: Imagen 4', 0.06),
  imageModel('stability/sd-3.5-large', 'Stability: SD 3.5 Large', 0.065),
  TOKEN_BILLED_IMAGE_MODEL
];
