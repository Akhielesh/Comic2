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
import { getProvider, resolveProviderContext } from '../gateway.js';

export interface ImageKeys {
  geminiKey?: string | null;
  ideogramKey?: string | null;
  pixazoKey?: string | null;
  /** OpenAI image generation (gpt-image-1) when the user has connected an OpenAI key. */
  openaiKey?: string | null;
  /** xAI image generation (grok-2-image) when the user has connected an xAI key. */
  xaiKey?: string | null;
}

export const imageGenAvailable = (k: ImageKeys): boolean =>
  Boolean(k.geminiKey || k.ideogramKey || k.pixazoKey || k.openaiKey || k.xaiKey);

// Default image model per direct provider (OpenAI-compatible /images/generations).
const OPENAI_IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1';
const XAI_IMAGE_MODEL = process.env.XAI_IMAGE_MODEL || 'grok-2-image';

const ASPECTS = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);

// Pixel size per aspect ratio for the free fallback (Pollinations renders to a size).
const ASPECT_SIZE: Record<string, [number, number]> = {
  '1:1': [1024, 1024], '16:9': [1280, 720], '9:16': [720, 1280],
  '4:3': [1152, 864], '3:4': [864, 1152], '3:2': [1200, 800], '2:3': [800, 1200]
};

// Free, no-key image generation fallback (https://pollinations.ai — open source).
// We hand the client a direct image URL (Pollinations renders it on first load); nothing
// is fetched server-side, so there is no SSRF surface. `nologo` strips the watermark.
export const pollinationsUrl = (prompt: string, aspectRatio: string): string => {
  const [w, h] = ASPECT_SIZE[aspectRatio] || ASPECT_SIZE['1:1'];
  const seed = Math.floor(Math.random() * 1_000_000_000);
  return `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true&seed=${seed}`;
};

/** Build the per-request generate_image tool bound to the user's image keys. */
export const makeImageTool = (keys: ImageKeys): ChatTool => ({
  name: 'generate_image',
  description:
    "Generate a real image from a text prompt. Works for free out of the box (Pollinations, no key); when the user has connected an image key (Gemini / Ideogram / Flux / OpenAI / xAI) it generates through their own account at higher fidelity. Use for illustrations, hero/cover images, icons, OG/share images, or to replace placeholder art with real visuals. Be descriptive (subject, style, palette, mood). The image is shown to the user.",
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
      } else if (keys.openaiKey) {
        provider = 'OpenAI';
        dataUrl = (await getProvider('openai').generateImage(
          { model: OPENAI_IMAGE_MODEL, prompt: `${prompt}\n\n(Aspect ratio: ${aspectRatio})` },
          resolveProviderContext(keys.openaiKey, 'openai')
        )).imageDataUrl;
      } else if (keys.xaiKey) {
        provider = 'xAI';
        dataUrl = (await getProvider('xai').generateImage(
          { model: XAI_IMAGE_MODEL, prompt: `${prompt}\n\n(Aspect ratio: ${aspectRatio})` },
          resolveProviderContext(keys.xaiKey, 'xai')
        )).imageDataUrl;
      } else {
        // No BYOK key → free, no-key fallback so image generation works out of the box.
        return {
          content: `Generated a ${aspectRatio} image (free, via Pollinations) for: "${prompt.slice(0, 120)}". It is shown to the user. Tip: connect a Gemini / Ideogram / Flux / OpenAI / xAI key in Settings for higher-fidelity images through your own account.`,
          images: [{ url: pollinationsUrl(prompt, aspectRatio), title: prompt.slice(0, 80), source: 'Pollinations (free)' }],
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
