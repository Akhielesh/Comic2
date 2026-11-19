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
import { logger } from '../../lib/logger.js';

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

/** Why a picture could not be made, in the three ways the person can act on. */
export type ImageFailureKind = 'refused' | 'credit' | 'busy';

const FAILURE_WORDS: Record<ImageFailureKind, string> = {
  refused: 'it was refused',
  credit: 'it is out of credit',
  busy: 'the service is busy'
};

const CREDIT_RE = /\b402\b|credit|quota|billing|insufficient|payment|balance|spending limit|key limit/i;
/** What turns a 429 into an empty balance rather than a wait. */
const CREDIT_429_RE = /insufficient_quota|billing|credit/i;
const REFUSED_RE =
  /refus|reject|safety|content.?policy|moderation|blocked|prohibited|invalid[^.]{0,20}key|api key not valid|unauthori[sz]ed|forbidden|permission|not allowed/i;

const httpStatus = (value: unknown): number | undefined => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 100 && n < 600 ? n : undefined;
};

/**
 * The vendor's HTTP status of a failure: `.vendorStatus` (vendorHttpError; its `.status` is our
 * own mapped answer), else a tagged `.status`, else the code in "failed: NNN" / "failed (NNN …)".
 */
const statusOfFailure = (err: unknown, message: string): number | undefined => {
  const e = err as { status?: unknown; vendorStatus?: unknown } | undefined;
  const tagged = httpStatus(e?.vendorStatus) ?? httpStatus(e?.status);
  if (tagged !== undefined) return tagged;
  const m = /failed:?\s*\(?(\d{3})\b/i.exec(message);
  return m ? Number(m[1]) : undefined;
};

/** Sort a provider failure into refused / out of credit / busy. Never reads more than the class. */
export const imageFailureKind = (err: unknown): ImageFailureKind => {
  const message = String((err as Error | undefined)?.message ?? err ?? '');
  const status = statusOfFailure(err, message);
  // A 429 is a wait ("Rate limit exceeded", Gemini's "check quota"), unless it names an empty balance.
  if (status === 429) return CREDIT_429_RE.test(message) ? 'credit' : 'busy';
  if (status === 402 || CREDIT_RE.test(message)) return 'credit';
  if (status === 400 || status === 401 || status === 403 || REFUSED_RE.test(message)) return 'refused';
  return 'busy';
};

/**
 * The one sentence a failed picture returns. Fixed per class: the raw error can carry a vendor's
 * echo of the key or its own wording, and this text goes back to the model and the chat.
 */
export const imageFailureSentence = (vendor: string, kind: ImageFailureKind): string =>
  `That picture couldn't be made with your ${vendor} key: ${FAILURE_WORDS[kind]}. Try again, or pick another picture model.`;

/** Build the per-request generate_image tool bound to the user's image keys. */
export const makeImageTool = (keys: ImageKeys): ChatTool => ({
  name: 'generate_image',
  description:
    "Generate a real image from a text prompt using the user's own image-generation account (BYOK: Gemini / Ideogram / Flux / OpenAI / xAI). Use for illustrations, hero/cover images, icons, OG/share images, or to replace placeholder art with real visuals. Be descriptive (subject, style, palette, mood). The image is shown to the user.",
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
    let provider = '';
    // The company whose key the person saved (Settings names them this way).
    let vendor = '';
    try {
      let dataUrl: string | undefined;
      if (keys.geminiKey) {
        provider = 'Gemini';
        vendor = 'Google';
        dataUrl = (await generateGeminiImage(keys.geminiKey, prompt, aspectRatio, '1K')).dataUrl;
      } else if (keys.ideogramKey) {
        provider = 'Ideogram';
        vendor = 'Ideogram';
        dataUrl = (await generateIdeogramImage(keys.ideogramKey, { prompt, aspectRatio, resolution: '1024x1024' })).dataUrl;
      } else if (keys.pixazoKey) {
        provider = 'Flux';
        vendor = 'Pixazo';
        dataUrl = (await generateFluxImage(keys.pixazoKey, { prompt, aspectRatio, resolution: '1024x1024' })).dataUrl;
      } else if (keys.openaiKey) {
        provider = 'OpenAI';
        vendor = 'OpenAI';
        dataUrl = (await getProvider('openai').generateImage(
          { model: OPENAI_IMAGE_MODEL, prompt: `${prompt}\n\n(Aspect ratio: ${aspectRatio})` },
          resolveProviderContext(keys.openaiKey, 'openai')
        )).imageDataUrl;
      } else if (keys.xaiKey) {
        provider = 'xAI';
        vendor = 'xAI';
        dataUrl = (await getProvider('xai').generateImage(
          { model: XAI_IMAGE_MODEL, prompt: `${prompt}\n\n(Aspect ratio: ${aspectRatio})` },
          resolveProviderContext(keys.xaiKey, 'xai')
        )).imageDataUrl;
      } else {
        return {
          content: 'No image-generation key is configured for your account. Add a Gemini, Ideogram, Flux/Pixazo, OpenAI or xAI key in Settings to generate images.',
          notice: { level: 'warn', message: 'No image-generation key', fix: 'Add an image key in Settings → API Configuration.' },
        };
      }
      if (!dataUrl) return { content: 'Image generation returned no image — try a more specific prompt.' };
      return {
        content: `Generated a ${aspectRatio} image with ${provider} for: "${prompt.slice(0, 120)}". It is shown to the user.`,
        images: [{ url: dataUrl, title: prompt.slice(0, 80), source: provider }],
      };
    } catch (err) {
      const kind = imageFailureKind(err);
      // The class and status only: the raw message stays out of the log line and the chat.
      logger.warn('chat_image_tool_failed', { vendor, kind, status: statusOfFailure(err, String((err as Error)?.message ?? '')) ?? null });
      return { content: imageFailureSentence(vendor || 'image', kind) };
    }
  },
});

/** Tool name, for the client allowlist + catalog. */
export const IMAGE_TOOL_NAME = 'generate_image';
