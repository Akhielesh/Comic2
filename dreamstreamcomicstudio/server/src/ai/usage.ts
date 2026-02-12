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
      promptChars: prompt.length
    };
  }
  return {
    promptChars: prompt.length,
    estimatedTokens: estimateTokens(prompt) + estimateTokens(responseText)
  };
};
