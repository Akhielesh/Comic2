import { GenerationArtifact, PricingConfig, Project, ProjectReport } from "../types";
import { normalizePricingConfig } from "./pricingConfig";

const estimateTokensFromText = (text?: string) => {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.33);
};

const base64Bytes = (dataUrl: string) => {
  const base64 = dataUrl.split(",")[1] || "";
  return Math.floor((base64.length * 3) / 4);
};

const summarizeUsage = (artifact: GenerationArtifact) => {
  const usage = artifact.usage || {};
  const promptTokens = usage.promptTokens ?? estimateTokensFromText(artifact.prompt);
  const candidatesTokens =
    usage.candidatesTokens ??
    estimateTokensFromText(artifact.responseText || "");
  const totalTokens = usage.totalTokens ?? promptTokens + candidatesTokens;
  return { promptTokens, candidatesTokens, totalTokens };
};

const calculateArtifactCost = (
  artifact: GenerationArtifact,
  pricing: PricingConfig
) => {
  const modelPricing = pricing.models[artifact.model] || {};
  const { promptTokens, candidatesTokens } = summarizeUsage(artifact);
  let cost = 0;
  let isEstimated = false;

  if (artifact.type === "image") {
    if (typeof modelPricing.imagePerOutput === "number") {
      cost += modelPricing.imagePerOutput;
    } else {
      isEstimated = true;
    }
    if (typeof modelPricing.inputPer1k === "number") {
      cost += (promptTokens / 1000) * modelPricing.inputPer1k;
    }
    if (typeof modelPricing.outputPer1k === "number" && candidatesTokens > 0) {
      cost += (candidatesTokens / 1000) * modelPricing.outputPer1k;
    }
  }

  if (artifact.type === "text") {
    if (typeof modelPricing.inputPer1k === "number") {
      cost += (promptTokens / 1000) * modelPricing.inputPer1k;
    } else {
      isEstimated = true;
    }
    if (typeof modelPricing.outputPer1k === "number") {
      cost += (candidatesTokens / 1000) * modelPricing.outputPer1k;
    } else {
      isEstimated = true;
    }
  }

  if (artifact.type === "system") {
    isEstimated = true;
  }

  return { cost, isEstimated };
};

export const buildProjectReport = async (
  project: Project,
  artifacts: GenerationArtifact[],
  images: Record<string, string>,
  pricingConfig?: PricingConfig
): Promise<ProjectReport> => {
  const pricing = normalizePricingConfig(pricingConfig);

  const byModel: Record<string, { tokens: number; cost: number }> = {};
  const byStage: Record<string, { tokens: number; cost: number }> = {};
  const byType: Record<string, { tokens: number; cost: number }> = {};
  let totalCost = 0;
  let totalTokens = 0;
  let estimatedCount = 0;

  const artifactDetails = artifacts.map((artifact) => {
    const usage = summarizeUsage(artifact);
    const { cost, isEstimated } = calculateArtifactCost(artifact, pricing);
    totalCost += cost;
    totalTokens += usage.totalTokens;
    if (isEstimated) estimatedCount += 1;

    const modelBucket = byModel[artifact.model] || { tokens: 0, cost: 0 };
    modelBucket.tokens += usage.totalTokens;
    modelBucket.cost += cost;
    byModel[artifact.model] = modelBucket;

    const stage = artifact.stage || "unknown";
    const stageBucket = byStage[stage] || { tokens: 0, cost: 0 };
    stageBucket.tokens += usage.totalTokens;
    stageBucket.cost += cost;
    byStage[stage] = stageBucket;

    const typeBucket = byType[artifact.type] || { tokens: 0, cost: 0 };
    typeBucket.tokens += usage.totalTokens;
    typeBucket.cost += cost;
    byType[artifact.type] = typeBucket;

    return {
      id: artifact.id,
      stage,
      type: artifact.type,
      model: artifact.model,
      provider: artifact.provider,
      promptChars: artifact.usage?.promptChars ?? artifact.prompt.length,
      promptTokens: usage.promptTokens,
      candidatesTokens: usage.candidatesTokens,
      totalTokens: usage.totalTokens,
      outputImageId: artifact.outputImageId,
      inputImageIds: artifact.inputImageIds,
      success: artifact.success,
      error: artifact.error,
      aspectRatio: artifact.aspectRatio,
      resolution: artifact.resolution,
      timings: artifact.timings,
      meta: artifact.meta,
      cost: { currency: pricing.currency, value: Number(cost.toFixed(6)), isEstimated }
    };
  });

  const imageCount = Object.keys(images).length;
  const imageBytes = Object.values(images).reduce((sum, dataUrl) => sum + base64Bytes(dataUrl), 0);

  let storageEstimate: Record<string, unknown> = {};
  if (typeof navigator !== "undefined" && navigator.storage?.estimate) {
    try {
      const estimate = await navigator.storage.estimate();
      storageEstimate = {
        quota: estimate.quota,
        usage: estimate.usage
      };
    } catch {
      storageEstimate = {};
    }
  }

  return {
    ai_usage: {
      totalArtifacts: artifacts.length,
      totalTokens,
      byModel,
      byStage,
      byType,
      artifacts: artifactDetails
    },
    cost_summary: {
      currency: pricing.currency,
      totalCost: Number(totalCost.toFixed(6)),
      estimatedArtifactCount: estimatedCount,
      byModel,
      byStage,
      byType
    },
    storage: {
      imageCount,
      imageBytes,
      artifactsCount: artifacts.length,
      panelsCount: project.state.panels.length,
      indexedDb: storageEstimate
    }
  };
};

export const estimateTokensFromTextInput = estimateTokensFromText;
