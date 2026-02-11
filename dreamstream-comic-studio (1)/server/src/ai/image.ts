import { Modality } from '@google/genai';
import { ImageGenerateResponse } from '../../../apiTypes.js';
import { createClient } from './client.js';
import { buildUsage } from './usage.js';
import { IMAGE_MODEL, IMAGE_REQUEST_TIMEOUT_MS } from '../config.js';
import { withRetry, withTimeout, nowMs } from './utils.js';

const isGeminiImageModel = (model: string) => model.startsWith('gemini-');
const supportsImageSize = (model: string) => model.includes('3-pro-image');

const getMimeTypeFromDataUrl = (dataUrl: string, fallback: string) => {
  const match = dataUrl.match(/^data:(.*?);base64,/);
  return match?.[1] || fallback;
};

const fileToGenerativePart = (dataUrl: string, fallbackMime: string) => ({
  inlineData: {
    data: dataUrl.split(',')[1],
    mimeType: getMimeTypeFromDataUrl(dataUrl, fallbackMime)
  }
});


type GeminiInlineData = {
  data?: string;
  mimeType?: string;
};

type GeminiContentPart = {
  text?: string;
  inlineData?: GeminiInlineData;
};

type GeminiCandidate = {
  content?: { parts?: GeminiContentPart[] };
  finishReason?: string;
  finishMessage?: string;
};

type GeminiPromptFeedback = {
  blockReason?: string;
};

type GeminiUsageMetadata = Record<string, unknown>;

type GeminiGenerateContentResponse = {
  candidates?: GeminiCandidate[];
  promptFeedback?: GeminiPromptFeedback;
  usageMetadata?: GeminiUsageMetadata;
};

type ErrorWithMessage = { message?: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isGeminiContentPart = (value: unknown): value is GeminiContentPart => {
  if (!isRecord(value)) return false;
  const inlineData = value.inlineData;
  if (inlineData !== undefined && !isRecord(inlineData)) return false;
  return true;
};

const toGeminiGenerateContentResponse = (value: unknown): GeminiGenerateContentResponse => {
  if (!isRecord(value)) return {};
  const candidates = Array.isArray(value.candidates)
    ? value.candidates.filter((candidate): candidate is GeminiCandidate => isRecord(candidate))
    : undefined;
  const promptFeedback = isRecord(value.promptFeedback) ? value.promptFeedback as GeminiPromptFeedback : undefined;
  const usageMetadata = isRecord(value.usageMetadata) ? value.usageMetadata : undefined;
  return {
    candidates,
    promptFeedback,
    usageMetadata
  };
};

const isInvalidArgumentError = (err: unknown) => {
  const message = String((isRecord(err) ? (err as ErrorWithMessage).message : err) || '');
  return message.includes('INVALID_ARGUMENT') || message.toLowerCase().includes('invalid argument');
};

export const generateGeminiImage = async (
  apiKey: string,
  prompt: string,
  aspectRatio: string,
  resolution: string,
  referenceImages: string[] = [],
  modelId?: string
): Promise<ImageGenerateResponse> => {
  const ai = createClient(apiKey);
  const hasReferences = referenceImages.length > 0;
  const effectiveModel = modelId || IMAGE_MODEL;

  const imageSize = supportsImageSize(effectiveModel) ? (resolution === '4K' ? '2K' : resolution) : undefined;
  const shouldUseGenerateContent = hasReferences || isGeminiImageModel(effectiveModel);
  const responseModalities = isGeminiImageModel(effectiveModel)
    ? [Modality.TEXT, Modality.IMAGE]
    : [Modality.IMAGE];

  const requestStart = nowMs();

  if (!shouldUseGenerateContent) {
    const response = await withRetry(
      () => withTimeout(
        ai.models.generateImages({
          model: effectiveModel,
          prompt,
          config: {
            numberOfImages: 1,
            aspectRatio,
            ...(imageSize ? { imageSize } : {})
          }
        }),
        IMAGE_REQUEST_TIMEOUT_MS,
        'Image generation'
      ),
      2,
      5000,
      'Generate Image'
    );

    const apiMs = Math.round(nowMs() - requestStart);
    const generated = response.generatedImages?.[0];
    const imageBytes = generated?.image?.imageBytes;
    if (!imageBytes) {
      const reason = generated?.raiFilteredReason ? `raiFilteredReason=${generated.raiFilteredReason}` : null;
      throw new Error(`Image generation returned no image.${reason ? ` ${reason}` : ''}`);
    }
    const mimeType = generated?.image?.mimeType || 'image/png';
    const dataUrl = `data:${mimeType};base64,${imageBytes}`;
    return {
      dataUrl,
      mimeType,
      prompt,
      usage: buildUsage(prompt, undefined, undefined),
      model: effectiveModel,
      timings: { apiMs, totalMs: apiMs }
    };
  }

  const textPart = { text: prompt };
  const imageParts = referenceImages.map((img) => fileToGenerativePart(img, 'image/jpeg'));

  const requestImage = (imageConfig?: { aspectRatio?: string; imageSize?: string }) => {
    const config: { responseModalities: Modality[]; imageConfig?: { aspectRatio?: string; imageSize?: string } } = {
      responseModalities
    };
    if (imageConfig && Object.keys(imageConfig).length > 0) {
      config.imageConfig = imageConfig;
    }
    return withRetry(
      () => withTimeout(
        ai.models.generateContent({
          model: effectiveModel,
          contents: [
            {
              role: 'user',
              parts: [textPart, ...imageParts]
            }
          ],
          config
        }),
        IMAGE_REQUEST_TIMEOUT_MS,
        'Image generation'
      ),
      2,
      5000,
      'Generate Image'
    );
  };

  const configsToTry: Array<{ aspectRatio?: string; imageSize?: string } | undefined> = [];
  const baseConfig = {
    ...(aspectRatio ? { aspectRatio } : {}),
    ...(imageSize ? { imageSize } : {})
  };
  if (Object.keys(baseConfig).length > 0) configsToTry.push(baseConfig);
  if (aspectRatio && !configsToTry.some((cfg) => cfg?.aspectRatio === aspectRatio && !cfg?.imageSize)) {
    configsToTry.push({ aspectRatio });
  }
  configsToTry.push(undefined);

  let response: GeminiGenerateContentResponse | undefined;
  let lastError: unknown;

  for (const cfg of configsToTry) {
    try {
      response = toGeminiGenerateContentResponse(await requestImage(cfg));
      break;
    } catch (err) {
      if (isInvalidArgumentError(err)) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  if (!response) {
    throw lastError || new Error('Image generation failed with no response.');
  }

  const apiMs = Math.round(nowMs() - requestStart);
  const candidate = response.candidates?.[0];
  const parts = (candidate?.content?.parts || []).filter(isGeminiContentPart);
  const inlinePart = parts.find((part) => part.inlineData?.data);

  if (!inlinePart?.inlineData?.data) {
    const finishReason = candidate?.finishReason || candidate?.finishMessage;
    const blockReason = response.promptFeedback?.blockReason;
    const responseText = parts.map((part) => part.text).filter((text): text is string => typeof text === 'string').join(' ').trim();
    const details = [
      finishReason ? `finishReason=${finishReason}` : null,
      blockReason ? `blockReason=${blockReason}` : null,
      responseText ? `text=${responseText.slice(0, 200)}` : null
    ].filter(Boolean).join(' | ');
    const message = details
      ? `Image generation returned no image. ${details}`
      : 'Image generation returned no image.';
    throw new Error(message);
  }

  const mimeType = inlinePart.inlineData?.mimeType || 'image/png';
  const dataUrl = `data:${mimeType};base64,${inlinePart.inlineData.data}`;

  return {
    dataUrl,
    mimeType,
    prompt,
    usage: buildUsage(prompt, undefined, response.usageMetadata),
    model: effectiveModel,
    timings: { apiMs, totalMs: apiMs },
  };
};
