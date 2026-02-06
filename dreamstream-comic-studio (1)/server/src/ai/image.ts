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

export const generateGeminiImage = async (
  apiKey: string,
  prompt: string,
  aspectRatio: string,
  resolution: string,
  referenceImages: string[] = []
): Promise<ImageGenerateResponse> => {
  const ai = createClient(apiKey);
  const hasReferences = referenceImages.length > 0;
  const imageSize = supportsImageSize(IMAGE_MODEL) ? (resolution === '4K' ? '2K' : resolution) : undefined;
  const shouldUseGenerateContent = hasReferences || isGeminiImageModel(IMAGE_MODEL);
  const responseModalities = isGeminiImageModel(IMAGE_MODEL)
    ? [Modality.TEXT, Modality.IMAGE]
    : [Modality.IMAGE];

  const requestStart = nowMs();

  if (!shouldUseGenerateContent) {
    const response = await withRetry(
      () => withTimeout(
        ai.models.generateImages({
          model: IMAGE_MODEL,
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
      model: IMAGE_MODEL,
      timings: { apiMs, totalMs: apiMs }
    };
  }

  const textPart = { text: prompt };
  const imageParts = referenceImages.map((img) => fileToGenerativePart(img, 'image/jpeg'));

  const requestImage = (imageConfig?: { aspectRatio?: string; imageSize?: string }) => {
    const config: any = { responseModalities };
    if (imageConfig && Object.keys(imageConfig).length > 0) {
      config.imageConfig = imageConfig;
    }
    return withRetry(
      () => withTimeout(
        ai.models.generateContent({
          model: IMAGE_MODEL,
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

  let response: any;
  let usedConfig: { aspectRatio?: string; imageSize?: string } | undefined;
  let lastError: any;
  const isInvalidArgument = (err: any) => {
    const message = String(err?.message || err || '');
    return message.includes('INVALID_ARGUMENT') || message.toLowerCase().includes('invalid argument');
  };

  for (const cfg of configsToTry) {
    try {
      response = await requestImage(cfg);
      usedConfig = cfg;
      break;
    } catch (err) {
      if (isInvalidArgument(err)) {
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
  const parts = candidate?.content?.parts || [];
  const inlinePart = parts.find((part: any) => part.inlineData?.data);

  if (!inlinePart?.inlineData?.data) {
    const finishReason = candidate?.finishReason || candidate?.finishMessage;
    const blockReason = response.promptFeedback?.blockReason;
    const responseText = parts.map((part: any) => part.text).filter(Boolean).join(' ').trim();
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
    model: IMAGE_MODEL,
    timings: { apiMs, totalMs: apiMs },
  };
};
