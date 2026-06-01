import { GoogleGenAI } from '@google/genai';
import { GEMINI_BASE_URL, NVIDIA_TEXT_MODEL } from '../config.js';
import { geminiSchemaToJsonSchema } from './schemaConvert.js';
import { getProvider, resolveProviderContext } from './gateway.js';
import { TEXT_FALLBACK } from './autoRouter.js';
import type { AIProviderId, ChatMessage } from './providers/types.js';

const isOpenRouterKey = (key: string) => key.startsWith('sk-or-');
// NVIDIA Build keys are prefixed `nvapi-`. They route through the same OpenAI-compatible
// gateway shim as OpenRouter, so every analyze/world/panel/continuity stage works unchanged.
const isNvidiaKey = (key: string) => key.startsWith('nvapi-');

const partsToText = (parts: any): string =>
  Array.isArray(parts) ? parts.map((p: any) => p?.text || '').join('\n') : '';

/**
 * Map Gemini `contents` (string | {parts} | array of {role,parts}) to OpenRouter chat
 * messages, preserving multi-turn roles (model → assistant) and an optional system
 * instruction. The old behaviour flattened everything into one user turn, which lost
 * the conversation structure that story-tool relies on for "follow instructions exactly".
 */
const buildMessages = (contents: any, systemInstruction?: string): ChatMessage[] => {
  const messages: ChatMessage[] = [];
  if (typeof systemInstruction === 'string' && systemInstruction.trim()) {
    messages.push({ role: 'system', content: systemInstruction });
  }
  if (typeof contents === 'string') {
    messages.push({ role: 'user', content: contents });
  } else if (Array.isArray(contents)) {
    for (const c of contents) {
      if (typeof c === 'string') {
        messages.push({ role: 'user', content: c });
      } else {
        const role: ChatMessage['role'] =
          c?.role === 'model' ? 'assistant' : c?.role === 'system' ? 'system' : 'user';
        messages.push({ role, content: partsToText(c?.parts) });
      }
    }
  } else if (contents?.parts) {
    messages.push({ role: 'user', content: partsToText(contents.parts) });
  } else {
    messages.push({ role: 'user', content: String(contents ?? '') });
  }
  return messages.length ? messages : [{ role: 'user', content: '' }];
};

/**
 * Minimal gateway-backed shim that matches the subset of the Gemini client our text
 * pipeline uses: `models.generateContent({ model, contents, config })` →
 * `{ text, usageMetadata }`. This lets the existing analyze/world/panel/continuity
 * functions run through ANY OpenAI-compatible provider (OpenRouter or NVIDIA Build)
 * unchanged (their parsing/grounding is untouched). The Gemini `responseSchema` is
 * converted to JSON Schema for json_schema output.
 */
const createGatewayTextClient = (apiKey: string, providerId: AIProviderId, fallbackModel: string) => ({
  models: {
    generateContent: async (req: any) => {
      // Use a real provider model id (contains a '/'); otherwise fall back to the default.
      const model = typeof req?.model === 'string' && req.model.includes('/') ? req.model : fallbackModel;
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

      const result = await getProvider(providerId).generateText(
        {
          model,
          messages: buildMessages(req?.contents, typeof cfg.systemInstruction === 'string' ? cfg.systemInstruction : undefined),
          jsonSchema: schema ? { name: 'response', schema, strict: false } : undefined,
          temperature: typeof cfg.temperature === 'number' ? cfg.temperature : undefined,
          retries: 3,
          fallbackModel
        },
        resolveProviderContext(apiKey, providerId)
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
  // OpenRouter / NVIDIA key → unified gateway shim (text). Gemini key → real Google SDK client.
  if (isOpenRouterKey(apiKey)) {
    return createGatewayTextClient(apiKey, 'openrouter', TEXT_FALLBACK) as unknown as GoogleGenAI;
  }
  if (isNvidiaKey(apiKey)) {
    return createGatewayTextClient(apiKey, 'nvidia', NVIDIA_TEXT_MODEL) as unknown as GoogleGenAI;
  }
  // @ts-ignore - The SDK might support baseUrl in options
  return new GoogleGenAI({ apiKey, baseUrl: GEMINI_BASE_URL });
};
