import { Modality } from '@google/genai';
import { LayoutAnalysisResponse } from '../../../apiTypes.js';
import { createClient } from './client.js';
import { buildUsage } from './usage.js';
import { TEXT_MODEL, TEXT_REQUEST_TIMEOUT_MS } from '../config.js';
import { withRetry, withTimeout } from './utils.js';

const resolveTextModel = (modelOverride?: string) => {
  const candidate = modelOverride?.trim();
  return candidate || TEXT_MODEL;
};

const fileToGenerativePart = (dataUrl: string, fallbackMime: string) => {
  const match = dataUrl.match(/^data:(.*?);base64,/);
  return {
    inlineData: {
      data: dataUrl.split(',')[1],
      mimeType: match?.[1] || fallbackMime
    }
  };
};

export const analyzeLayoutFromImages = async (apiKey: string, images: string[], modelOverride?: string): Promise<LayoutAnalysisResponse> => {
  const ai = createClient(apiKey);
  const model = resolveTextModel(modelOverride);
  const imageParts = images.map((img) => fileToGenerativePart(img, 'image/jpeg'));
  const prompt = 'Analyze these images of comic book pages. Describe the panel layout verbally in a single sentence. This description will be used as a creative brief for a comic generation AI. Example: \'A large horizontal panel at the top, with two smaller square panels underneath it.\'';

  const response = await withRetry(
    () => withTimeout(
      ai.models.generateContent({
        model,
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }, ...imageParts]
          }
        ],
        config: {
          responseModalities: [Modality.TEXT]
        }
      }),
      TEXT_REQUEST_TIMEOUT_MS,
      'Analyze layout'
    ),
    3,
    2000,
    'Analyze Layout'
  );

  const responseText = response.text || '';
  return {
    description: responseText || 'Could not analyze layout.',
    prompt,
    responseText,
    usage: buildUsage(prompt, responseText, response.usageMetadata),
    model
  };
};
