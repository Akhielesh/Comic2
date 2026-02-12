import type { TokenEstimateRequest, TokenEstimateResponse, TokenBreakdownLine } from '../../../shared/types/billing.js';
import { CT_USD, DEFAULT_MARKUP, resolveModelPricing } from './pricingCatalog.js';

const estimateTokensFromText = (text?: string) => {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.33);
};

const collectStrings = (value: unknown, bucket: string[] = []): string[] => {
  if (typeof value === 'string' && value.trim()) {
    bucket.push(value);
    return bucket;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectStrings(entry, bucket));
    return bucket;
  }
  if (value && typeof value === 'object') {
    Object.values(value).forEach((entry) => collectStrings(entry, bucket));
  }
  return bucket;
};

const toCt = (usd: number) => Math.max(0, Math.ceil(usd / CT_USD));

const resolveNumber = (value: unknown, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const buildEstimateFromRequestBody = (
  provider: TokenEstimateRequest['provider'],
  model: string,
  operation: string,
  body: unknown,
  explicit?: Partial<TokenEstimateRequest>
): TokenEstimateRequest => {
  const strings = collectStrings(body);
  const aggregateText = strings.join('\n');
  const roughInputTokens = estimateTokensFromText(aggregateText.slice(0, 8_000));
  const roughOutputTokens = Math.max(80, Math.ceil(roughInputTokens * 0.6));

  const isImageOperation = operation.includes('image') || operation.includes('panel') || operation.includes('cover');
  const imageUnits = explicit?.imageUnits ?? (isImageOperation ? 1 : 0);

  return {
    provider,
    model,
    operation,
    inputTokens: resolveNumber(explicit?.inputTokens, roughInputTokens),
    outputTokens: resolveNumber(explicit?.outputTokens, roughOutputTokens),
    imageUnits,
    otherBillableUnits: resolveNumber(explicit?.otherBillableUnits, 0),
    otherBillableUnitPriceUsd: resolveNumber(explicit?.otherBillableUnitPriceUsd, 0),
    projectId: explicit?.projectId,
    comicId: explicit?.comicId,
    stage: explicit?.stage,
    byok: explicit?.byok === true,
    metadata: explicit?.metadata
  };
};

export const estimateCharge = async (
  request: TokenEstimateRequest,
  options?: { markup?: number }
): Promise<TokenEstimateResponse> => {
  const markup = Number.isFinite(options?.markup) ? Number(options?.markup) : DEFAULT_MARKUP;
  const pricing = await resolveModelPricing(request.provider, request.model);

  const inputTokens = resolveNumber(request.inputTokens, 0);
  const outputTokens = resolveNumber(request.outputTokens, 0);
  const imageUnits = resolveNumber(request.imageUnits, 0);
  const otherUnits = resolveNumber(request.otherBillableUnits, 0);
  const otherUnitPrice = resolveNumber(request.otherBillableUnitPriceUsd, 0);

  const lines: TokenBreakdownLine[] = [];

  const addLine = (kind: TokenBreakdownLine['kind'], quantity: number, unitPriceUsd: number) => {
    if (!quantity || !unitPriceUsd) return;
    const providerCostUsd = quantity * unitPriceUsd;
    const billableUsd = providerCostUsd * markup;
    lines.push({
      kind,
      quantity,
      unitPriceUsd,
      providerCostUsd,
      billableUsd,
      ct: toCt(billableUsd)
    });
  };

  addLine('input_tokens', inputTokens / 1000, pricing.inputPer1kUsd);
  addLine('output_tokens', outputTokens / 1000, pricing.outputPer1kUsd);
  addLine('image_units', imageUnits, pricing.imagePerOutputUsd);
  addLine('other_billable', otherUnits, otherUnitPrice);

  const estimatedProviderCostUsd = lines.reduce((sum, line) => sum + line.providerCostUsd, 0);
  const estimatedBillableUsd = lines.reduce((sum, line) => sum + line.billableUsd, 0);

  return {
    currency: 'USD',
    ctPerUsd: Math.round(1 / CT_USD),
    markup,
    estimatedProviderCostUsd: Number(estimatedProviderCostUsd.toFixed(6)),
    estimatedBillableUsd: Number(estimatedBillableUsd.toFixed(6)),
    estimatedCt: toCt(estimatedBillableUsd),
    lines,
    modelPricing: {
      provider: pricing.provider,
      model: pricing.model,
      inputPer1kUsd: pricing.inputPer1kUsd,
      outputPer1kUsd: pricing.outputPer1kUsd,
      imagePerOutputUsd: pricing.imagePerOutputUsd,
      source: pricing.source,
      confidence: pricing.confidence,
      status: pricing.status,
      effectiveFrom: pricing.effectiveFrom
    }
  };
};

export type UsagePayload = {
  promptTokens?: number;
  candidatesTokens?: number;
  totalTokens?: number;
  estimatedTokens?: number;
};

export const buildSettleEstimateFromUsage = async (
  seed: TokenEstimateRequest,
  usage?: UsagePayload,
  options?: { markup?: number; imageUnits?: number }
): Promise<TokenEstimateResponse> => {
  const promptTokens = resolveNumber(usage?.promptTokens, 0);
  const candidatesTokens = resolveNumber(usage?.candidatesTokens, 0);
  const totalTokens = resolveNumber(usage?.totalTokens, 0);
  const estimatedTokens = resolveNumber(usage?.estimatedTokens, 0);

  const inputTokens = promptTokens || Math.ceil((totalTokens || estimatedTokens) * 0.4);
  const outputTokens = candidatesTokens || Math.max(0, (totalTokens || estimatedTokens) - inputTokens);

  return estimateCharge(
    {
      ...seed,
      inputTokens,
      outputTokens,
      imageUnits: resolveNumber(options?.imageUnits, seed.imageUnits || 0)
    },
    options
  );
};
