import { GoogleGenAI } from '@google/genai';
import { GEMINI_BASE_URL, OPENROUTER_TEXT_MODEL } from '../config.js';
import { geminiSchemaToJsonSchema } from './schemaConvert.js';
import { getProvider, resolveProviderContext } from './gateway.js';

const isOpenRouterKey = (key: string) => key.startsWith('sk-or-');

/** Flatten Gemini `contents` (string | parts | array) to a single user message. */
const flattenContents = (contents: any): string => {
  if (typeof contents === 'string') return contents;
  if (Array.isArray(contents)) {
    return contents
      .map((c) => (typeof c === 'string' ? c : (c?.parts || []).map((p: any) => p?.text || '').join('\n')))
      .join('\n\n');
  }
  if (contents?.parts) return contents.parts.map((p: any) => p?.text || '').join('\n');
  return String(contents ?? '');
};

/**
 * Minimal OpenRouter-backed shim that matches the subset of the Gemini client our
 * text pipeline uses: `models.generateContent({ model, contents, config })` →
 * `{ text, usageMetadata }`. This lets the existing analyze/world/panel/continuity
 * functions run through OpenRouter unchanged (their parsing/grounding is untouched).
 * The Gemini `responseSchema` is converted to JSON Schema for json_schema output.
 */
const createOpenRouterTextClient = (apiKey: string) => ({
  models: {
    generateContent: async (req: any) => {
      // Use a real OpenRouter model id (contains a '/'); otherwise fall back to the default.
      const model = typeof req?.model === 'string' && req.model.includes('/') ? req.model : OPENROUTER_TEXT_MODEL;
      const cfg = req?.config || {};
      const schema = cfg.responseSchema ? geminiSchemaToJsonSchema(cfg.responseSchema) : undefined;
      const result = await getProvider('openrouter').generateText(
        {
          model,
          messages: [{ role: 'user', content: flattenContents(req?.contents) }],
          jsonSchema: schema ? { name: 'response', schema, strict: false } : undefined,
          temperature: typeof cfg.temperature === 'number' ? cfg.temperature : undefined,
          retries: 3
        },
        resolveProviderContext(apiKey)
      );
      return { text: result.text, usageMetadata: undefined };
    },
    generateImages: async () => {
      throw new Error('OpenRouter text client does not support image generation.');
    }
  }
});

export const createClient = (apiKey: string) => {
  if (!apiKey) {
    throw new Error('AI API key not found.');
  }
  // OpenRouter key → unified gateway shim (text). Gemini key → real Google SDK client.
  if (isOpenRouterKey(apiKey)) {
    return createOpenRouterTextClient(apiKey) as unknown as GoogleGenAI;
  }
  // @ts-ignore - The SDK might support baseUrl in options
  return new GoogleGenAI({ apiKey, baseUrl: GEMINI_BASE_URL });
};
