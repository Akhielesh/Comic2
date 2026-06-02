import { Modality } from '@google/genai';
import { LayoutAnalysisResponse } from '../../../apiTypes.js';
import { createClient } from './client.js';
import { buildUsage } from './usage.js';
import { TEXT_MODEL, TEXT_REQUEST_TIMEOUT_MS, OPENROUTER_TEXT_MODEL } from '../config.js';
import { withRetry, withTimeout } from './utils.js';
import { getProvider, resolveProviderContext } from './gateway.js';
import type { MessagePart, ProviderUsage } from './providers/types.js';

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

export const STYLE_TAG_MARKER = 'TAGS:';

/** Build the art-director prompt that turns a reference into a reusable style brief. */
export const buildStylePrompt = (textHint?: string): string => {
  const hintBlock = textHint?.trim()
    ? `\n\nThe user also described the style they want: "${textHint.trim()}". Reconcile this with what you see.`
    : '';
  const base = textHint?.trim() && true
    ? 'You are an art director. Describe the visual STYLE the user wants so another AI can reproduce it on a brand-new comic page. '
    : 'You are an art director. Study the reference and describe its visual STYLE precisely so another AI can reproduce it on a brand-new comic page. ';
  return (
    base +
    'Focus only on style — never on the specific subjects/characters. ' +
    'Cover: medium & linework, color palette & shading, rendering technique, era/genre influence, lettering/caption ' +
    'treatment, panel-border and gutter feel, mood/lighting. Write 3-5 tight sentences as a reusable style brief. ' +
    `Then on a final line output "${STYLE_TAG_MARKER} tag1, tag2, tag3, ..." with 4-8 short descriptive tags.` +
    hintBlock
  );
};

/** Parse the art-director response into a brief + tags. */
export const parseStyleResponse = (responseText: string): { brief: string; tags: string[] } => {
  const text = (responseText || '').trim();
  const markerIdx = text.toUpperCase().lastIndexOf(STYLE_TAG_MARKER);
  if (markerIdx < 0) return { brief: text, tags: [] };
  const brief = text.slice(0, markerIdx).trim();
  const tags = text
    .slice(markerIdx + STYLE_TAG_MARKER.length)
    .split(',')
    .map((t) => t.trim().replace(/^[#•\-\s]+/, ''))
    .filter(Boolean)
    .slice(0, 8);
  return { brief, tags };
};

export type VisionResult = { text: string; usage: ProviderUsage; model: string };

/**
 * Provider-agnostic vision analysis used by PageStudio (style + layout intake).
 * Runs through the OpenRouter gateway so it shares the SAME key as image generation —
 * the user never needs a separate Gemini key. Works with an empty image list (text-only).
 */
export const analyzeImagesViaOpenRouter = async (
  apiKey: string,
  images: string[],
  instruction: string,
  modelOverride?: string
): Promise<VisionResult> => {
  const model = modelOverride?.trim() || OPENROUTER_TEXT_MODEL;
  const parts: MessagePart[] = [
    { type: 'text', text: instruction },
    ...images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))
  ];
  const result = await getProvider('openrouter').generateText(
    {
      model,
      messages: [{ role: 'user', content: parts }],
      temperature: 0.4,
      timeoutMs: TEXT_REQUEST_TIMEOUT_MS
    },
    resolveProviderContext(apiKey)
  );
  return { text: result.text || '', usage: result.usage, model: result.model || model };
};
