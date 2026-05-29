import { GoogleGenAI } from '@google/genai';
import { GEMINI_BASE_URL } from '../config.js';
import { geminiSchemaToJsonSchema } from './schemaConvert.js';
import { getProvider, resolveProviderContext } from './gateway.js';
import { TEXT_FALLBACK } from './autoRouter.js';

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
      const model = typeof req?.model === 'string' && req.model.includes('/') ? req.model : TEXT_FALLBACK;
      const cfg = req?.config || {};
      let schema = cfg.responseSchema ? geminiSchemaToJsonSchema(cfg.responseSchema) : undefined;

      // OpenAI-style structured outputs (which OpenRouter forwards to the upstream
      // provider, e.g. Azure) require the ROOT json_schema to be an object. Gemini
      // accepts a top-level array (e.g. analyzeScript, generatePanelBreakdown), so wrap
      // such schemas as { items: [...] } here and unwrap the reply below — keeping
      // callers, which expect a bare JSON array in `response.text`, unchanged.
      const rootIsArray = Boolean(schema && schema.type === 'array');
      if (rootIsArray) {
        schema = { type: 'object', properties: { items: schema }, required: ['items'] };
      }

      const result = await getProvider('openrouter').generateText(
        {
          model,
          messages: [{ role: 'user', content: flattenContents(req?.contents) }],
          jsonSchema: schema ? { name: 'response', schema, strict: false } : undefined,
          temperature: typeof cfg.temperature === 'number' ? cfg.temperature : undefined,
          retries: 3,
          fallbackModel: TEXT_FALLBACK
        },
        resolveProviderContext(apiKey)
      );

      let text = result.text;
      if (rootIsArray) {
        // The model should reply with our { items: [...] } wrapper, but tolerate a bare
        // array or a differently-named single array property so minor shape drift from
        // weaker models doesn't surface as a hard 500 downstream.
        const j = result.json as any;
        if (Array.isArray(j)) {
          text = JSON.stringify(j);
        } else if (j && typeof j === 'object') {
          const arr = Array.isArray(j.items) ? j.items : Object.values(j).find((v) => Array.isArray(v));
          if (Array.isArray(arr)) text = JSON.stringify(arr);
        }
      }

      // Surface the provider's real usage (incl. cost) and the model actually used, so
      // the text pipeline bills on exact OpenRouter cost instead of a token estimate.
      // buildUsage reads the *TokenCount fields and costUsd; the Gemini SDK path keeps
      // reporting its own usageMetadata unchanged.
      const u = result.usage;
      const usageMetadata =
        u && (typeof u.costUsd === 'number' || typeof u.totalTokens === 'number' || typeof u.promptTokens === 'number')
          ? {
              promptTokenCount: u.promptTokens,
              candidatesTokenCount: u.completionTokens,
              totalTokenCount: u.totalTokens,
              costUsd: u.costUsd
            }
          : undefined;
      return { text, usageMetadata, model: result.model };
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
