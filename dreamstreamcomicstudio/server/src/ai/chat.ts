// AI Chat Platform — free-form multi-turn chat on any catalog model.
//
// Unlike the Universal Assistant (which is platform-scoped and locked to a free
// OpenRouter model), this powers the standalone "AI Chat Platform" product: the
// user picks any model from the catalog and chats with it directly. It reuses the
// same provider gateway, so model choice, pricing, BYOK and usage metering all
// flow through one control plane.

import type { ChatMessage } from './providers/types.js';
import { getProvider, resolveProviderContext } from './gateway.js';
import { buildUsage } from './usage.js';
import type { AIProviderId } from './providers/types.js';

export type ChatReasoningLevel = 'none' | 'low' | 'medium' | 'high';

export interface RunChatParams {
  provider: AIProviderId;
  /** Resolved key for the chosen provider (BYOK header or platform env). */
  apiKey: string;
  model: string;
  /** Already-mapped conversation turns (user/assistant), most recent last. */
  messages: ChatMessage[];
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  reasoningLevel?: ChatReasoningLevel;
  webSearch?: boolean;
  fallbackModel?: string;
  timeoutMs?: number;
}

// Default persona. Heavy emphasis on well-structured, component-friendly Markdown so
// the client's rich renderer can surface tables, code, links, images and lists cleanly.
export const CHAT_SYSTEM_PROMPT = `You are DreamStream Chat, a helpful, knowledgeable AI assistant.

Answer clearly and accurately. If you are unsure, say so rather than inventing facts.

Always reply in well-structured GitHub-Flavored Markdown so the answer renders richly:
- Use **headings**, short paragraphs, and bullet/numbered lists to organize information.
- Use Markdown **tables** whenever you compare options, list structured data, or present multiple attributes.
- Use fenced code blocks with a language tag for any code, config, or commands.
- Use Markdown links [label](url) when you cite sources or point to resources.
- Use Markdown images ![alt](url) only when you have a real, valid image URL.
- Use blockquotes for callouts and \`inline code\` for identifiers, filenames and values.
- Use LaTeX-style \`$...$\` / \`$$...$$\` sparingly for math when helpful.

Keep responses focused and skimmable. Prefer structure over long walls of text.`;

const reasoningMaxTokens = (level?: ChatReasoningLevel): number => {
  switch (level) {
    case 'high':
      return 4096;
    case 'medium':
      return 3072;
    default:
      return 2048;
  }
};

export const runChat = async (
  params: RunChatParams
): Promise<{ text: string; usage: ReturnType<typeof buildUsage>; model: string }> => {
  // A custom persona / durable user memory augments the rich-format base prompt
  // rather than replacing it, so structured-Markdown rules always hold.
  const extra = params.systemPrompt?.trim();
  const systemContent = extra ? `${CHAT_SYSTEM_PROMPT}\n\nAdditional instructions:\n${extra}` : CHAT_SYSTEM_PROMPT;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemContent },
    ...params.messages
  ];

  const useReasoning =
    params.provider === 'openrouter' && params.reasoningLevel && params.reasoningLevel !== 'none';
  const useWeb = params.provider === 'openrouter' && Boolean(params.webSearch);

  const result = await getProvider(params.provider).generateText(
    {
      model: params.model,
      messages,
      temperature: typeof params.temperature === 'number' ? params.temperature : 0.7,
      maxTokens: params.maxTokens ?? reasoningMaxTokens(params.reasoningLevel),
      timeoutMs: params.timeoutMs,
      retries: 2,
      fallbackModel: params.fallbackModel,
      ...(useReasoning ? { reasoningEffort: params.reasoningLevel as 'low' | 'medium' | 'high' } : {}),
      ...(useWeb ? { webSearch: true } : {})
    },
    resolveProviderContext(params.apiKey, params.provider)
  );

  // Build a usage record from the last user turn's text + response, mirroring the
  // assistant path (provider usage is attached separately by the route's settlement).
  const lastUserText = [...params.messages]
    .reverse()
    .find((m) => m.role === 'user');
  const promptSeed =
    typeof lastUserText?.content === 'string'
      ? lastUserText.content
      : Array.isArray(lastUserText?.content)
        ? lastUserText!.content.map((p) => ('text' in p ? p.text : '')).join(' ')
        : '';

  return {
    text: result.text,
    usage: buildUsage(promptSeed, result.text, undefined),
    model: result.model || params.model
  };
};
