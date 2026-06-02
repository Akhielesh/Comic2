import { Modality } from '@google/genai';
import { LayoutAnalysisResponse, StyleAnalysisResponse } from '../../../apiTypes.js';
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

const STYLE_TAG_MARKER = 'TAGS:';

/**
 * Understand the *art style* of a reference image (and/or a text hint) and turn it into a
 * reusable creative brief for the single-sheet generator. Returns a human-readable brief
 * (shown to the user to confirm the direction) plus a short list of descriptive tags.
 */
export const analyzeStyleFromImages = async (
  apiKey: string,
  images: string[],
  textHint?: string,
  modelOverride?: string
): Promise<StyleAnalysisResponse> => {
  const ai = createClient(apiKey);
  const model = resolveTextModel(modelOverride);
  const imageParts = images.map((img) => fileToGenerativePart(img, 'image/jpeg'));
  const hintBlock = textHint?.trim()
    ? `\n\nThe user also described the style they want: "${textHint.trim()}". Reconcile this with what you see.`
    : '';
  const prompt =
    'You are an art director. Study the reference and describe its visual STYLE precisely so another AI ' +
    'can reproduce it on a brand-new comic page. Focus only on style — never on the specific subjects/characters. ' +
    'Cover: medium & linework, color palette & shading, rendering technique, era/genre influence, lettering/caption ' +
    'treatment, panel-border and gutter feel, mood/lighting. Write 3-5 tight sentences as a reusable style brief. ' +
    `Then on a final line output "${STYLE_TAG_MARKER} tag1, tag2, tag3, ..." with 4-8 short descriptive tags.` +
    hintBlock;

  const contents = imageParts.length > 0
    ? [{ role: 'user', parts: [{ text: prompt }, ...imageParts] }]
    : [{ role: 'user', parts: [{ text: prompt }] }];

  const response = await withRetry(
    () => withTimeout(
      ai.models.generateContent({
        model,
        contents,
        config: { responseModalities: [Modality.TEXT] }
      }),
      TEXT_REQUEST_TIMEOUT_MS,
      'Analyze style'
    ),
    3,
    2000,
    'Analyze Style'
  );

  const responseText = (response.text || '').trim();
  const markerIdx = responseText.toUpperCase().lastIndexOf(STYLE_TAG_MARKER);
  let brief = responseText;
  let tags: string[] = [];
  if (markerIdx >= 0) {
    brief = responseText.slice(0, markerIdx).trim();
    tags = responseText
      .slice(markerIdx + STYLE_TAG_MARKER.length)
      .split(',')
      .map((t) => t.trim().replace(/^[#•\-\s]+/, ''))
      .filter(Boolean)
      .slice(0, 8);
  }

  return {
    brief: brief || 'Could not analyze style. Try a clearer reference image or describe the style in text.',
    tags,
    prompt,
    responseText,
    usage: buildUsage(prompt, responseText, response.usageMetadata),
    model
  };
};
