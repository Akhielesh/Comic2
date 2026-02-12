import { PricingConfig } from "../types";
import { IMAGE_MODEL, TEXT_MODEL } from "./modelPolicy";

export const PRICING_AS_OF = "2026-02-02 UTC";
export const FLASH_MODEL = "gemini-2.5-flash";
export const FLASH_LITE_MODEL = "gemini-2.5-flash-lite";
export const FLASH_20_MODEL = "gemini-2.0-flash";
export const BANANA_PRO_IMAGE_MODEL = "gemini-3-pro-image-preview";
export const FLUX_SCHNELL_MODEL = "pixazo/flux-1-schnell";

const perMillionToPer1k = (value: number) => value / 1000;

export const FLASH_LITE_PRICING = {
  inputPer1k: perMillionToPer1k(0.10),
  outputPer1k: perMillionToPer1k(0.40)
};

export const FLASH_PRICING = {
  inputPer1k: perMillionToPer1k(0.30),
  outputPer1k: perMillionToPer1k(2.50)
};

export const FLASH_IMAGE_STANDARD = 0.039;
export const FLASH_IMAGE_BATCH = 0.0195;

export const BANANA_PRO_IMAGE_1K = 0.134;
export const BANANA_PRO_IMAGE_4K = 0.24;

export const DEFAULT_PRICING_CONFIG: PricingConfig = {
  currency: "USD",
  models: {
    [TEXT_MODEL]: {
      inputPer1k: FLASH_PRICING.inputPer1k,
      outputPer1k: FLASH_PRICING.outputPer1k
    },
    [FLASH_LITE_MODEL]: {
      inputPer1k: FLASH_LITE_PRICING.inputPer1k,
      outputPer1k: FLASH_LITE_PRICING.outputPer1k
    },
    [FLASH_20_MODEL]: {
      inputPer1k: FLASH_PRICING.inputPer1k,
      outputPer1k: FLASH_PRICING.outputPer1k
    },
    [IMAGE_MODEL]: {
      imagePerOutput: FLASH_IMAGE_STANDARD,
      inputPer1k: 0,
      outputPer1k: 0
    },
    [BANANA_PRO_IMAGE_MODEL]: {
      imagePerOutput: BANANA_PRO_IMAGE_1K
    },
    [FLUX_SCHNELL_MODEL]: {
      imagePerOutput: 0
    }
  }
};

export const normalizePricingConfig = (config?: PricingConfig): PricingConfig => {
  if (!config) return structuredClone(DEFAULT_PRICING_CONFIG);
  const normalized: PricingConfig = {
    currency: config.currency || DEFAULT_PRICING_CONFIG.currency,
    models: { ...DEFAULT_PRICING_CONFIG.models, ...config.models }
  };
  return normalized;
};
