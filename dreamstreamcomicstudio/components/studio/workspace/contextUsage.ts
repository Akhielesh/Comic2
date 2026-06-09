// Context-usage estimation for the Code Studio "context bar".
//
// Every refine sends the WHOLE project (all files) + the build conversation to the coding model.
// As an app grows, that payload eats into the model's context window — and once it's close to the
// ceiling the model starts dropping detail, which is a real cause of "it forgot half my app".
// This gives the user an honest, live read on how full that window is so nothing is a surprise.
//
// Token counts are an estimate (we don't ship a tokenizer): ~4 chars/token is the well-worn rule
// of thumb across GPT/Claude/Llama tokenizers for English+code. It's deliberately approximate — the
// bar is a "how full are we" gauge, not a billing meter.

export interface ContextUsage {
  /** Estimated tokens the next refine would send (files + conversation + overhead). */
  tokens: number;
  /** The selected model's context window in tokens. */
  window: number;
  /** tokens / window, clamped 0–1. */
  pct: number;
  /** 'ok' < 0.6, 'warn' 0.6–0.85, 'high' > 0.85 — drives the bar colour + advice. */
  level: 'ok' | 'warn' | 'high';
}

/** ~4 characters per token (GPT/Claude/Llama all land near this for English + code). */
export const estimateTokens = (text: string | undefined | null): number =>
  text ? Math.ceil(text.length / 4) : 0;

/** Best-effort context window (tokens) for a coding model id. Conservative when unknown. */
export const contextWindowFor = (modelId?: string | null): number => {
  const id = (modelId || '').toLowerCase();
  if (!id) return 128_000; // "auto" — assume a solid modern coder
  if (id.includes('gemini')) return 1_000_000;
  if (id.includes('claude')) return 200_000;
  if (id.includes('gpt-4.1') || id.includes('gpt-4o') || id.includes('o3') || id.includes('o4')) return 128_000;
  if (id.includes('deepseek')) return 128_000;
  if (id.includes('qwen')) return id.includes('coder') ? 128_000 : 32_000;
  if (id.includes('llama') || id.includes('mistral') || id.includes('mixtral')) return 128_000;
  if (id.includes('grok')) return 128_000;
  return 128_000;
};

const levelOf = (pct: number): ContextUsage['level'] => (pct > 0.85 ? 'high' : pct > 0.6 ? 'warn' : 'ok');

/**
 * Estimate how full the model's context window is for the NEXT refine. We count the project files
 * and the conversation text, plus a fixed system/instruction overhead the build prompts always add.
 */
export const computeContextUsage = (
  files: { content?: string }[],
  messages: { text?: string }[],
  modelId?: string | null,
  /** Rough fixed cost of the studio's build/system prompt + tool schemas. */
  overheadTokens = 1500,
): ContextUsage => {
  const fileTokens = files.reduce((n, f) => n + estimateTokens(f.content), 0);
  const chatTokens = messages.reduce((n, m) => n + estimateTokens(m.text), 0);
  const tokens = fileTokens + chatTokens + overheadTokens;
  const window = contextWindowFor(modelId);
  const pct = window > 0 ? Math.min(1, tokens / window) : 0;
  return { tokens, window, pct, level: levelOf(pct) };
};

/** Compact "12.4k" style token label. */
export const formatTokens = (n: number): string => {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};
