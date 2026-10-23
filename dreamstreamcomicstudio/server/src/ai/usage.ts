import { ApiUsage } from '../../../apiTypes.js';
import type { ProviderUsage } from './providers/types.js';

const estimateTokens = (text?: string) => {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.33);
};

export const buildUsage = (
  prompt: string,
  responseText?: string,
  usageMetadata?: any
): ApiUsage => {
  if (usageMetadata) {
    return {
      promptTokens: usageMetadata.promptTokenCount,
      candidatesTokens: usageMetadata.candidatesTokenCount,
      totalTokens: usageMetadata.totalTokenCount,
      promptChars: prompt.length,
      // OpenRouter reports a real per-call cost (Gemini does not); pass it through so
      // billing settles on the exact provider cost instead of a token estimate.
      ...(typeof usageMetadata.costUsd === 'number' ? { providerCostUsd: usageMetadata.costUsd } : {})
    };
  }
  return {
    promptChars: prompt.length,
    estimatedTokens: estimateTokens(prompt) + estimateTokens(responseText)
  };
};

// ── Usage meter (S9) ────────────────────────────────────────────────────────────────────────────
// One chat turn can make many provider calls: the first call, every tool round, a timeout or
// empty-answer retry, and the nested agent calls a meta-tool (swarm / delegate / deep research)
// makes. Billing must settle on ALL of them, so every call is added here. The provider's own
// token counts and cost are used when it reports them; a call that reports no tokens is
// estimated from what was actually sent (chars / 4), never from the last user message alone.

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);
const charsToTokens = (chars: number) => Math.ceil(Math.max(0, chars) / 4);
const roundUsd = (usd: number) => Math.round(usd * 1e9) / 1e9;

export interface UsageMeter {
  /** Provider calls (and nested runs that reported usage) recorded so far. */
  readonly calls: number;
  /**
   * One provider call: its reported usage, how many characters were sent (the whole context,
   * tool specs included) and how many came back — the last two only matter when the provider
   * reported no token counts.
   */
  addCall(usage: ProviderUsage | undefined, sentChars: number, replyChars: number): void;
  /** Usage a tool reported for the model calls it made itself (meta-tools). */
  addNested(usage: ApiUsage | undefined): void;
  /**
   * The summed usage. `providerCostUsd` is present only when EVERY recorded call reported a
   * cost (a partial sum would under-count); otherwise settlement prices the summed tokens.
   */
  usage(promptSeed: string): ApiUsage;
}

export const createUsageMeter = (): UsageMeter => {
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let costUsd = 0;
  let costComplete = true;

  return {
    get calls() {
      return calls;
    },
    addCall(usage, sentChars, replyChars) {
      calls += 1;
      const total = num(usage?.totalTokens);
      const completion = num(usage?.completionTokens);
      const prompt = num(usage?.promptTokens) ?? (total !== undefined && completion !== undefined ? Math.max(0, total - completion) : undefined);
      promptTokens += prompt ?? charsToTokens(sentChars);
      completionTokens += completion ?? (total !== undefined && prompt !== undefined ? Math.max(0, total - prompt) : charsToTokens(replyChars));
      const cost = num(usage?.costUsd);
      if (cost === undefined) costComplete = false;
      else costUsd += cost;
    },
    addNested(usage) {
      if (!usage || typeof usage !== 'object') return;
      const prompt = num(usage.promptTokens);
      const candidates = num(usage.candidatesTokens);
      const total = num(usage.totalTokens) ?? num(usage.estimatedTokens);
      const cost = num(usage.providerCostUsd);
      // A tool that made no model call reports nothing — nothing to add.
      if (prompt === undefined && candidates === undefined && total === undefined && cost === undefined) return;
      calls += 1;
      if (prompt !== undefined || candidates !== undefined) {
        promptTokens += prompt ?? 0;
        completionTokens += candidates ?? Math.max(0, (total ?? 0) - (prompt ?? 0));
      } else if (total !== undefined) {
        const input = Math.ceil(total * 0.4);
        promptTokens += input;
        completionTokens += Math.max(0, total - input);
      }
      if (cost === undefined) costComplete = false;
      else costUsd += cost;
    },
    usage(promptSeed) {
      return buildUsage(promptSeed || '', undefined, {
        promptTokenCount: promptTokens,
        candidatesTokenCount: completionTokens,
        totalTokenCount: promptTokens + completionTokens,
        ...(calls > 0 && costComplete ? { costUsd: roundUsd(costUsd) } : {})
      });
    }
  };
};

/**
 * Attach what a failed run had already spent to its error, so the route settles that spend
 * instead of releasing the hold (a turn that fails on round 2 still paid for round 1).
 * Non-enumerable: it never reaches a log line or a client payload by accident.
 */
export const withSpentUsage = <E>(err: E, usage: ApiUsage): E | Error => {
  const target: object = err && typeof err === 'object' ? (err as unknown as object) : new Error(String(err ?? 'request failed'));
  try {
    Object.defineProperty(target, 'spentUsage', { value: usage, enumerable: false, configurable: true, writable: true });
  } catch {
    /* frozen error object: nothing to attach */
  }
  return target as E | Error;
};

/**
 * The usage a failed run had already spent, when there is something worth settling: a real
 * reported cost above $0, or (no cost reported) a positive token count. Undefined otherwise.
 */
export const spentUsageOf = (err: unknown): ApiUsage | undefined => {
  const usage = (err as { spentUsage?: ApiUsage } | null | undefined)?.spentUsage;
  if (!usage || typeof usage !== 'object') return undefined;
  if (typeof usage.providerCostUsd === 'number') return usage.providerCostUsd > 0 ? usage : undefined;
  return (num(usage.totalTokens) ?? 0) > 0 ? usage : undefined;
};
