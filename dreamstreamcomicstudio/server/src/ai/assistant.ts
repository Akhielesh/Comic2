import type { AssistantMessage, UniversalAssistantContext } from '../../../apiTypes.js';
import { ASSISTANT_REQUEST_TIMEOUT_MS, TEXT_MODEL } from '../config.js';
import { createClient } from './client.js';
import { buildPublicKnowledgeBlock } from './assistantKnowledge.js';
import { buildUsage } from './usage.js';
import { withRetry, withTimeout } from './utils.js';

const resolveTextModel = (modelOverride?: string) => {
  const candidate = modelOverride?.trim();
  return candidate || TEXT_MODEL;
};

const safeContextJson = (context: UniversalAssistantContext) => {
  try {
    const raw = JSON.stringify(context || {});
    return raw.length > 12_000 ? `${raw.slice(0, 12_000)}…` : raw;
  } catch {
    return '{}';
  }
};

export const queryUniversalAssistant = async (
  apiKey: string,
  userMessage: string,
  history: AssistantMessage[],
  context: UniversalAssistantContext,
  modelOverride?: string
): Promise<{ text: string; usage?: ReturnType<typeof buildUsage>; model: string }> => {
  const ai = createClient(apiKey);
  const model = resolveTextModel(modelOverride);
  const knowledgeBase = buildPublicKnowledgeBlock();

  const systemPrompt = `
You are the "DreamStream Universal Assistant".
You only support DreamStream Comic Studio product questions and troubleshooting.

Hard safety rules:
1. Answer only platform-specific questions related to DreamStream.
2. Never reveal or request secrets (API keys, tokens, passwords, session credentials).
3. Never expose private/confidential user data, and never infer data outside the provided safe context.
4. If context is missing, say what is unavailable and give safe next steps.
5. Keep responses concise and practical.

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

  const response = await withRetry(
    () => withTimeout(
      ai.models.generateContent({
        model,
        contents: [
          { role: 'user', parts: [{ text: systemPrompt }] },
          ...history.map((item) => ({ role: item.role, parts: [{ text: item.text }] })),
          { role: 'user', parts: [{ text: userMessage }] }
        ]
      }),
      ASSISTANT_REQUEST_TIMEOUT_MS,
      'Universal assistant response'
    ),
    2,
    1000,
    'Universal Assistant Query'
  );

  const responseText = response.text || '';
  return {
    text: responseText,
    usage: buildUsage(userMessage, responseText, response.usageMetadata),
    model
  };
};
