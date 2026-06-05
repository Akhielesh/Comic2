import type { AssistantMessage, UniversalAssistantContext } from '../../../apiTypes.js';
import { ASSISTANT_REQUEST_TIMEOUT_MS } from '../config.js';
import { pickTextModel, TEXT_FALLBACK } from './autoRouter.js';
import { buildPublicKnowledgeBlock } from './assistantKnowledge.js';
import { buildUsage } from './usage.js';
import { getProvider, resolveProviderContext } from './gateway.js';
import { PERSONA_TONE, PERSONA_HONESTY } from './persona.js';
import type { ChatMessage } from './providers/types.js';

const safeContextJson = (context: UniversalAssistantContext) => {
  try {
    const raw = JSON.stringify(context || {});
    return raw.length > 12_000 ? `${raw.slice(0, 12_000)}…` : raw;
  } catch {
    return '{}';
  }
};

// The Universal Assistant runs on a FREE OpenRouter model through the gateway.
// Guardrails: the system prompt below + route-level off-topic blocking and context
// sanitization (see routes/assistant.ts and ai/assistantPolicy.ts).
export const queryUniversalAssistant = async (
  apiKey: string,
  userMessage: string,
  history: AssistantMessage[],
  context: UniversalAssistantContext,
  modelOverride?: string
): Promise<{ text: string; usage?: ReturnType<typeof buildUsage>; model: string }> => {
  const model = modelOverride?.trim() || (await pickTextModel({ preferFree: true }));
  const knowledgeBase = buildPublicKnowledgeBlock();

  const systemPrompt = `
You are the "DreamStream Universal Assistant" — the in-app face of DreamStream's one brand voice.
${PERSONA_TONE}
${PERSONA_HONESTY}
You only support DreamStream Comic Studio product questions and troubleshooting.
You may answer meta questions about who you are, what you can do, and your platform safety limits.

Hard safety rules:
1. Answer only platform-specific questions related to DreamStream.
2. Never reveal or request secrets (API keys, tokens, passwords, session credentials).
3. Never expose private/confidential user data, and never infer data outside the provided safe context.
4. If context is missing, say what is unavailable and give safe next steps.
5. For broad/unclear questions, ask a clarifying question and steer to app-relevant help.
6. Be accurate. If you are unsure or the answer is not in the platform knowledge or safe
   context below, say you don't have that information rather than guessing. Never fabricate
   features, prices, limits, or steps.
7. Keep responses concise and practical.

Public platform knowledge:
${knowledgeBase}

Safe user context (already sanitized/allowlisted):
${safeContextJson(context)}

Response format (Markdown):
**Summary:** 1-2 sentence answer.
**Steps:** Use a numbered list only if the user asked for actions or a process.
**Warnings:** Only if there's a risk or confusion.
**Next:** 1-2 next actions or suggestions if helpful.
Use **bold** for labels, *italics* for emphasis, and <u>underline</u> very sparingly for critical highlights.
Keep it concise and avoid unnecessary sections.
  `;

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history.map((item) => ({
      role: item.role === 'user' ? ('user' as const) : ('assistant' as const),
      content: item.text
    })),
    { role: 'user', content: userMessage }
  ];

  const result = await getProvider('openrouter').generateText(
    {
      model,
      messages,
      temperature: 0.3,
      maxTokens: 1200,
      timeoutMs: ASSISTANT_REQUEST_TIMEOUT_MS,
      retries: 2,
      fallbackModel: TEXT_FALLBACK
    },
    resolveProviderContext(apiKey)
  );

  return {
    text: result.text,
    usage: buildUsage(userMessage, result.text, undefined),
    model: result.model || model
  };
};
