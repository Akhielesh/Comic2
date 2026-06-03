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
import { toToolSpec, type ChatTool } from './tools/registry.js';

export type ChatReasoningLevel = 'none' | 'low' | 'medium' | 'high';

export interface ChatToolEvent {
  tool: string;
  query?: string;
  ok: boolean;
  summary?: string;
}

export interface ChatToolImage {
  url: string;
  title?: string;
  thumbnail?: string;
  source?: string;
}

/** Max model⇄tool round-trips before we force a final answer. */
const MAX_TOOL_ITERATIONS = 4;

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
  /**
   * Pre-sanitized DreamStream workspace context (JSON string). Present only when the
   * user enabled the DreamStream connector for the session. Injected as a guardrailed
   * block so the model can help with the user's own projects but can't act or leak.
   */
  dreamstreamContextJson?: string;
  /** Agentic tools the model may call (DuckDuckGo, etc.). OpenRouter only. */
  tools?: ChatTool[];
  /** Abort signal for in-flight tool calls. */
  signal?: AbortSignal;
}

// Guardrail framing for the DreamStream connector. The context is read-only and
// already allowlist-sanitized server-side; the model may discuss/assist with it but
// has no tools to modify the workspace and must never expose secrets or other users' data.
const dreamstreamBlock = (json: string): string => `

DreamStream workspace access is ENABLED for this conversation. You are operating inside the DreamStream Comic Studio product and may use the sanitized context below to help the user with their own projects, account and usage.
Guardrails:
- Only reference the user's own data shown in the context. Never claim access to other users' data.
- Never reveal or request secrets (API keys, tokens, passwords).
- This access is read-only — you cannot create, edit, generate or delete anything; if the user asks you to act, explain how to do it in the app instead.
- If something isn't present in the context, say you don't have it rather than guessing or fabricating project details.

Sanitized DreamStream context (JSON):
${json}`;

// Default persona. Heavy emphasis on well-structured, component-friendly Markdown so
// the client's rich renderer can surface tables, code, links, images and lists cleanly.
export const CHAT_SYSTEM_PROMPT = `You are DreamStream Chat, a helpful, knowledgeable AI assistant.

Answer clearly and accurately. If you are unsure, say so rather than inventing facts.

Always reply in well-structured GitHub-Flavored Markdown so the answer renders richly:
- Use **headings**, short paragraphs, and bullet/numbered lists to organize information.
- Use Markdown **tables** whenever you compare options, list structured data, or present multiple attributes.
- Use fenced code blocks with a language tag for any code, config, or commands.
- When you output code or files, give each file its own fenced block and start it with a comment naming the file (e.g. \`// src/app.ts\` or \`# main.py\`) so it can be saved/zipped correctly. Use a separate block per file.
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

const dedupeCitations = (citations: { url: string; title?: string }[]) => {
  const seen = new Set<string>();
  const out: { url: string; title?: string }[] = [];
  for (const c of citations) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
  }
  return out;
};

export const runChat = async (
  params: RunChatParams
): Promise<{
  text: string;
  usage: ReturnType<typeof buildUsage>;
  model: string;
  reasoning?: string;
  citations?: { url: string; title?: string }[];
  toolEvents?: ChatToolEvent[];
  images?: ChatToolImage[];
}> => {
  // A custom persona / durable user memory augments the rich-format base prompt
  // rather than replacing it, so structured-Markdown rules always hold.
  const extra = params.systemPrompt?.trim();
  let systemContent = extra ? `${CHAT_SYSTEM_PROMPT}\n\nAdditional instructions:\n${extra}` : CHAT_SYSTEM_PROMPT;
  if (params.dreamstreamContextJson) {
    systemContent += dreamstreamBlock(params.dreamstreamContextJson);
  }

  const messages: ChatMessage[] = [{ role: 'system', content: systemContent }, ...params.messages];

  const useReasoning =
    params.provider === 'openrouter' && params.reasoningLevel && params.reasoningLevel !== 'none';
  const useWeb = params.provider === 'openrouter' && Boolean(params.webSearch);
  // Agentic tools are OpenRouter-only (function-calling + tool_calls parsing).
  const tools = params.provider === 'openrouter' ? params.tools || [] : [];
  const toolSpecs = tools.length ? tools.map(toToolSpec) : undefined;

  const ctx = resolveProviderContext(params.apiKey, params.provider);
  const baseReq = {
    model: params.model,
    temperature: typeof params.temperature === 'number' ? params.temperature : 0.7,
    maxTokens: params.maxTokens ?? reasoningMaxTokens(params.reasoningLevel),
    timeoutMs: params.timeoutMs,
    retries: 2,
    fallbackModel: params.fallbackModel,
    ...(useReasoning ? { reasoningEffort: params.reasoningLevel as 'low' | 'medium' | 'high' } : {}),
    ...(useWeb ? { webSearch: true } : {})
  };

  const toolEvents: ChatToolEvent[] = [];
  const images: ChatToolImage[] = [];
  const citations: { url: string; title?: string }[] = [];

  // Agentic loop: call the model, run any tools it asks for, feed results back, repeat.
  // A single call (no tools enabled) collapses to one iteration with no tool round-trips.
  let result = await getProvider(params.provider).generateText(
    { ...baseReq, messages, ...(toolSpecs ? { tools: toolSpecs } : {}) },
    ctx
  );

  let iterations = 0;
  while (result.toolCalls && result.toolCalls.length && iterations < MAX_TOOL_ITERATIONS) {
    iterations += 1;
    if (result.citations) citations.push(...result.citations);

    messages.push({
      role: 'assistant',
      content: result.text || '',
      tool_calls: result.toolCalls.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: c.arguments }
      }))
    });

    for (const call of result.toolCalls) {
      const tool = tools.find((t) => t.name === call.name);
      let parsed: Record<string, unknown> = {};
      try {
        parsed = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        parsed = {};
      }
      const query = typeof parsed.query === 'string' ? parsed.query : undefined;

      if (!tool) {
        toolEvents.push({ tool: call.name, query, ok: false, summary: 'Unknown tool' });
        messages.push({ role: 'tool', tool_call_id: call.id, content: `Unknown tool: ${call.name}` });
        continue;
      }
      try {
        const out = await tool.execute(parsed, params.signal);
        if (out.images) images.push(...out.images);
        if (out.citations) citations.push(...out.citations);
        toolEvents.push({ tool: call.name, query, ok: true, summary: out.content.slice(0, 160) });
        messages.push({ role: 'tool', tool_call_id: call.id, content: out.content });
      } catch (err) {
        const message = (err as Error)?.message || 'tool failed';
        toolEvents.push({ tool: call.name, query, ok: false, summary: message });
        messages.push({ role: 'tool', tool_call_id: call.id, content: `Error: ${message}` });
      }
    }

    // Next turn. On the final allowed iteration, drop tools to force a written answer.
    const allowMoreTools = iterations < MAX_TOOL_ITERATIONS;
    result = await getProvider(params.provider).generateText(
      { ...baseReq, messages, ...(toolSpecs && allowMoreTools ? { tools: toolSpecs } : {}) },
      ctx
    );
  }

  if (result.citations) citations.push(...result.citations);

  // Build a usage record from the last user turn's text + final response (provider usage
  // is attached separately by the route's settlement).
  const lastUserText = [...params.messages].reverse().find((m) => m.role === 'user');
  const promptSeed =
    typeof lastUserText?.content === 'string'
      ? lastUserText.content
      : Array.isArray(lastUserText?.content)
        ? lastUserText!.content.map((p) => ('text' in p ? p.text : '')).join(' ')
        : '';

  const mergedCitations = dedupeCitations(citations);

  return {
    text: result.text,
    usage: buildUsage(promptSeed, result.text, undefined),
    model: result.model || params.model,
    reasoning: result.reasoning,
    citations: mergedCitations.length ? mergedCitations : undefined,
    toolEvents: toolEvents.length ? toolEvents : undefined,
    images: images.length ? images : undefined
  };
};
