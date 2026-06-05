// Output guardrail layer (Phase 11) — defense beyond prompt instructions.
//
// The persona tells the model to be honest; this is the check that runs AFTER it
// answers and catches the cases prompts miss. A lightweight, dependency-free,
// fully-synchronous post-generation pass over the final text + what tools ran:
//
//   1. Secret/PII leak  — the answer echoes an API key, token, private key or email.
//   2. Fabrication      — it states prices/market figures with NO tool call to back them.
//   3. Missing citation — it claims a source ("according to…", "[1]") but carries none.
//
// Findings become `CapabilityNotice`s, so they (a) surface to the user through the
// existing notices channel — no new UI — and (b) are written to the capability audit
// log via `logCapabilityNotice`. The layer never edits the model's text; it annotates.

import type { CapabilityNotice } from '../../../apiTypes.js';
import { logCapabilityNotice } from './capabilities.js';

export type GuardrailFlagType =
  | 'secret_leak'
  | 'pii_email'
  | 'unverified_figures'
  | 'missing_citations';

export interface GuardrailFlag {
  type: GuardrailFlagType;
  level: 'info' | 'warn' | 'error';
  message: string;
  /** A redacted sample of what tripped the check (never the raw secret). */
  sample?: string;
}

export interface GuardrailScanInput {
  /** The model's final answer text. */
  text: string;
  /** Whether ANY tool ran this turn (figures are "verified" only if one did). */
  toolRan: boolean;
  /** How many citations the answer carries. */
  citationCount: number;
}

export interface GuardrailResult {
  flags: GuardrailFlag[];
}

// --- Secret / credential patterns. Each is high-signal (a real key shape), so a
// match is worth flagging even though the model is told never to emit one. ---------
const SECRET_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'OpenAI/OpenRouter key', re: /\bsk-(?:or-v1-)?[A-Za-z0-9]{20,}\b/g },
  { label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { label: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { label: 'Stripe secret key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { label: 'Private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { label: 'Bearer token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g }
];

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

// Monetary / market figures the model should only state from a tool result: a
// currency-prefixed amount, an explicit price/quote claim, or a "trading at N" form.
// Deliberately narrow — generic numbers (math, counts, years) must NOT trip this.
// Non-global so `.test()` is stateless across calls; a global clone is used for samples.
const MONEY_RE = /(?:[$€£¥]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:USD|EUR|GBP|dollars))\b/;
const MONEY_RE_G = new RegExp(MONEY_RE.source, 'g');
const PRICE_CLAIM_RE =
  /\b(?:trading|priced?|closed|opened|quoted|valued|up|down)\s+(?:at|around|near)?\s*[$€£]?\s?\d[\d,]*(?:\.\d+)?/i;

// Source-claiming language that should be backed by a real citation.
const SOURCE_CLAIM_RE =
  /\b(?:according to|as reported by|sources? say|cited|per the|\[\d+\]|\(source:)/i;

/** Mask a matched secret so the flag never echoes the credential itself. */
const redactSecret = (match: string): string => {
  if (match.length <= 8) return '••••';
  return `${match.slice(0, 4)}…${match.slice(-2)} (${match.length} chars)`;
};

const uniqueLimited = (values: string[], n: number): string[] => Array.from(new Set(values)).slice(0, n);

/** Pure scan: produce flags for a finished answer. No side effects. */
export const scanOutput = (input: GuardrailScanInput): GuardrailResult => {
  const text = typeof input.text === 'string' ? input.text : '';
  const flags: GuardrailFlag[] = [];
  if (!text.trim()) return { flags };

  // 1) Secret / credential leak — highest severity.
  for (const { label, re } of SECRET_PATTERNS) {
    const found = text.match(re);
    if (found && found.length) {
      flags.push({
        type: 'secret_leak',
        level: 'error',
        message: `Output appears to contain a credential (${label}). It was flagged for review; never share secrets in answers.`,
        sample: redactSecret(found[0])
      });
    }
  }

  // 2) Email / PII — lower severity (emails are often legitimately part of an answer).
  const emails = text.match(EMAIL_RE);
  if (emails && emails.length) {
    flags.push({
      type: 'pii_email',
      level: 'info',
      message: `Output contains ${emails.length === 1 ? 'an email address' : `${emails.length} email addresses`}. Make sure it is the user's own data, not someone else's.`,
      sample: uniqueLimited(emails, 2).join(', ')
    });
  }

  // 3) Fabrication of figures — money/market numbers stated with no tool call to back them.
  if (!input.toolRan && (MONEY_RE.test(text) || PRICE_CLAIM_RE.test(text))) {
    const samples = uniqueLimited(text.match(MONEY_RE_G) || [], 3);
    flags.push({
      type: 'unverified_figures',
      level: 'warn',
      message:
        'The answer states monetary/market figures but no live tool ran this turn — treat these as from memory and possibly outdated, not verified.',
      sample: samples.join(', ') || undefined
    });
  }

  // 4) Missing citations — claims a source but carries none.
  if (input.citationCount === 0 && SOURCE_CLAIM_RE.test(text)) {
    flags.push({
      type: 'missing_citations',
      level: 'info',
      message: 'The answer refers to sources but no citations were attached. Verify the claim before relying on it.'
    });
  }

  return { flags };
};

/** Map guardrail flags to the platform's capability-notice shape (the UI + audit channel). */
export const flagsToNotices = (flags: GuardrailFlag[]): CapabilityNotice[] =>
  flags.map((f) => ({
    tool: `guardrail:${f.type}`,
    level: f.level,
    message: f.sample ? `${f.message} (${f.sample})` : f.message
  }));

/**
 * Run the scan and emit/log notices. Returns the notices to merge into the response so
 * they reach the user; also writes them to the capability audit log. Best-effort and
 * never throws — a guardrail problem must never break a reply.
 */
export const applyGuardrails = (input: GuardrailScanInput): CapabilityNotice[] => {
  try {
    const { flags } = scanOutput(input);
    if (!flags.length) return [];
    const notices = flagsToNotices(flags);
    for (const n of notices) logCapabilityNotice(n);
    return notices;
  } catch {
    return [];
  }
};
