import { PricingConfig } from '../types';
import { normalizePricingConfig } from './pricingConfig';
import { IMAGE_MODEL, TEXT_MODEL } from './modelPolicy';

export interface CostProjectionInput {
  pricingConfig?: PricingConfig;
  pageRange: { min: number; max: number };
  panelsPerPageRange: { min: number; max: number };
  textModel?: string;
  imageModel?: string;
}

export interface CostProjectionResult {
  currency: string;
  minUsd: number;
  maxUsd: number;
  estimatedPanels: {
    min: number;
    max: number;
  };
}

const clampInt = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.floor(value)));

const toUsd = (value: number) => Number(Math.max(0, value).toFixed(4));

const estimateTextCostForPanels = (
  panelCount: number,
  inputPer1k: number,
  outputPer1k: number
) => {
  // Lightweight deterministic assumption:
  // ~220 input tokens + ~110 output tokens per panel planning/generation cycle
  // and ~1.25x multiplier for retries/auxiliary text calls.
  const inputTokens = panelCount * 220 * 1.25;
  const outputTokens = panelCount * 110 * 1.25;
  const inputCost = (inputTokens / 1000) * inputPer1k;
  const outputCost = (outputTokens / 1000) * outputPer1k;
  return inputCost + outputCost;
};

export const estimateStoryCostRange = (input: CostProjectionInput): CostProjectionResult => {
  const pricing = normalizePricingConfig(input.pricingConfig);
  const textModel = input.textModel || TEXT_MODEL;
  const imageModel = input.imageModel || IMAGE_MODEL;

  const pageMin = clampInt(input.pageRange.min || 0, 1, 999);
  const pageMax = clampInt(input.pageRange.max || 0, pageMin, 999);
  const panelsPerPageMin = clampInt(input.panelsPerPageRange.min || 0, 1, 12);
  const panelsPerPageMax = clampInt(input.panelsPerPageRange.max || 0, panelsPerPageMin, 12);

  const panelMin = pageMin * panelsPerPageMin;
  const panelMax = pageMax * panelsPerPageMax;

  const textPricing = pricing.models[textModel] || {};
  const imagePricing = pricing.models[imageModel] || {};
  const inputPer1k = textPricing.inputPer1k || 0;
  const outputPer1k = textPricing.outputPer1k || 0;
  const imagePerOutput = imagePricing.imagePerOutput || 0;

  const fixedPipelineOverheadUsd = 0.03;

  const minText = estimateTextCostForPanels(panelMin, inputPer1k, outputPer1k);
  const maxText = estimateTextCostForPanels(panelMax, inputPer1k, outputPer1k);
  const minImage = panelMin * imagePerOutput;
  const maxImage = panelMax * imagePerOutput;

  return {
    currency: pricing.currency,
    minUsd: toUsd(minText + minImage + fixedPipelineOverheadUsd),
    maxUsd: toUsd(maxText + maxImage + fixedPipelineOverheadUsd),
    estimatedPanels: {
      min: panelMin,
      max: panelMax
    }
  };
};
