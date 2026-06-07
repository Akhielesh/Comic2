// generate_image — BYOK image generation as an agent tool.
//
// Uses the END USER's own image-generation account keys (req.apiKeys: Gemini / Ideogram / Flux-Pixazo,
// resolved by middleware/keys.ts from X-*-Key headers), so generation runs "through their accounts".
// Built PER-REQUEST with the resolved keys (like the swarm tool) — never a global tool — so a key is
// never baked into the registry. Mirrors the exact provider calls the /api/image route uses.

import type { ChatTool, ToolExecResult } from './types.js';
import { generateGeminiImage } from '../image.js';
import { generateIdeogramImage } from '../ideogram.js';
import { generateFluxImage } from '../flux.js';

export interface ImageKeys {
  geminiKey?: string | null;
  ideogramKey?: string | null;
  pixazoKey?: string | null;
}

export const imageGenAvailable = (k: ImageKeys): boolean => Boolean(k.geminiKey || k.ideogramKey || k.pixazoKey);

const ASPECTS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);

/** Build the per-request generate_image tool bound to the user's image keys. */
export const makeImageTool = (keys: ImageKeys): ChatTool => ({
  name: 'generate_image',
  description:
    "Generate a real image from a text prompt using the user's own image-generation account (BYOK: Gemini / Ideogram / Flux). Use for illustrations, hero/cover images, icons, OG/share images, or to replace placeholder art with real visuals. Be descriptive (subject, style, palette, mood). The image is shown to the user.",
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'What to generate — describe subject, style, palette and mood.' },
      aspectRatio: { type: 'string', description: 'One of 1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3 (default 1:1).' },
    },
    required: ['prompt'],
  },
  execute: async (args): Promise<ToolExecResult> => {
    const prompt = String(args?.prompt || '').trim();
    if (!prompt) return { content: 'Provide a prompt describing the image to generate.' };
    const aspectRatio = ASPECTS.has(String(args?.aspectRatio)) ? String(args.aspectRatio) : '1:1';
    try {
      let dataUrl: string | undefined;
      let provider = '';
      if (keys.geminiKey) {
        provider = 'Gemini';
        dataUrl = (await generateGeminiImage(keys.geminiKey, prompt, aspectRatio, '1K')).dataUrl;
      } else if (keys.ideogramKey) {
        provider = 'Ideogram';
        dataUrl = (await generateIdeogramImage(keys.ideogramKey, { prompt, aspectRatio, resolution: '1024x1024' })).dataUrl;
      } else if (keys.pixazoKey) {
        provider = 'Flux';
        dataUrl = (await generateFluxImage(keys.pixazoKey, { prompt, aspectRatio, resolution: '1024x1024' })).dataUrl;
      } else {
        return {
          content: 'No image-generation key is configured for your account. Add a Gemini, Ideogram, or Flux/Pixazo key in Settings to generate images.',
          notice: { level: 'warn', message: 'No image-generation key', fix: 'Add an image key in Settings → API Configuration.' },
        };
      }
      if (!dataUrl) return { content: 'Image generation returned no image — try a more specific prompt.' };
      return {
        content: `Generated a ${aspectRatio} image with ${provider} for: "${prompt.slice(0, 120)}". It is shown to the user.`,
        images: [{ url: dataUrl, title: prompt.slice(0, 80), source: provider }],
      };
    } catch (err) {
      return { content: `Image generation failed: ${(err as Error)?.message || 'unknown error'}` };
    }
  },
});

/** Tool name, for the client allowlist + catalog. */
export const IMAGE_TOOL_NAME = 'generate_image';
