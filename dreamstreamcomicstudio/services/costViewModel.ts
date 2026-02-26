import { PricingConfig } from '../types';
import { normalizePricingConfig } from './pricingConfig';
import { IMAGE_MODEL, TEXT_MODEL } from './modelPolicy';

export interface CostViewModelInput {
  accruedUsd: number;
  estimatedTokens: number;
  pendingPanelCount: number;
  pricingConfig?: PricingConfig;
  textModel?: string;
  imageModel?: string;
}

export interface CostViewModel {
  currency: string;
  accruedUsd: number;
  projectedRemainingUsd: number;
  totalProjectedUsd: number;
}

export const buildCostViewModel = (input: CostViewModelInput): CostViewModel => {
  const pricing = normalizePricingConfig(input.pricingConfig);
  const textModel = input.textModel || TEXT_MODEL;
  const imageModel = input.imageModel || IMAGE_MODEL;
  const textPricing = pricing.models[textModel] || {};
  const imagePricing = pricing.models[imageModel] || {};

  const textCost = ((textPricing.inputPer1k || 0) + (textPricing.outputPer1k || 0)) * (Math.max(0, input.estimatedTokens) / 1000);
  const imageCost = (imagePricing.imagePerOutput || 0) * Math.max(0, input.pendingPanelCount);
  const projectedRemainingUsd = Number((textCost + imageCost).toFixed(4));
  const accruedUsd = Number(Math.max(0, input.accruedUsd || 0).toFixed(4));
  return {
    currency: pricing.currency,
    accruedUsd,
    projectedRemainingUsd,
    totalProjectedUsd: Number((accruedUsd + projectedRemainingUsd).toFixed(4))
  };
};
