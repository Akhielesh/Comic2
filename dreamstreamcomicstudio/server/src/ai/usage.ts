import { ApiUsage } from '../../../apiTypes.js';

const estimateTokens = (text?: string) => {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.33);
};

export const buildUsage = (
  prompt: string,
  responseText?: string,
  usageMetadata?: any
): ApiUsage => {
  if (usageMetadata) {
    return {
      promptTokens: usageMetadata.promptTokenCount,
      candidatesTokens: usageMetadata.candidatesTokenCount,
      totalTokens: usageMetadata.totalTokenCount,
      promptChars: prompt.length,
      // OpenRouter reports a real per-call cost (Gemini does not); pass it through so
      // billing settles on the exact provider cost instead of a token estimate.
      ...(typeof usageMetadata.costUsd === 'number' ? { providerCostUsd: usageMetadata.costUsd } : {})
    };
  }
  return {
    promptChars: prompt.length,
    estimatedTokens: estimateTokens(prompt) + estimateTokens(responseText)
  };
};
