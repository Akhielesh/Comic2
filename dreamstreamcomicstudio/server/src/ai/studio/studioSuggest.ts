// Code Studio — the SUGGEST stage: real "what should I build next?" recommendations.
//
// After an app is built/refined, a senior product engineer looks at the ACTUAL code and proposes
// the 3–5 highest-value next steps — concrete features, the obvious missing piece, a meaningful
// polish, or "ship it" — each as a ready-to-run refine prompt. This replaces the old hardcoded
// chips ("Polish UI / Dark mode / Responsive…") with genuine, app-specific insight.
//
// Pure prompt + tolerant parser (the model call is injected → testable, and any failure yields an
// empty list so the client falls back to its local heuristic).

import { extractJson } from '../json.js';
import type { StudioSuggestion, StudioSuggestResult } from '../../../../apiTypes.js';

export interface SuggestInput {
  title?: string;
  files: { path: string; content: string }[];
}

const KINDS: NonNullable<StudioSuggestion['kind']>[] = ['feature', 'polish', 'fix', 'data', 'ship'];

/** A compact, token-bounded view of the project the model reasons over (paths + trimmed content). */
const renderProject = (input: SuggestInput): string => {
  const files = input.files.slice(0, 40);
  const blocks = files.map((f) => {
    // Keep each file small; we want breadth (what exists) over depth.
    const body = (f.content || '').slice(0, 1200);
    return `--- ${f.path} ---\n${body}`;
  });
  let text = blocks.join('\n\n');
  if (text.length > 24_000) text = text.slice(0, 24_000); // hard cap the whole payload
  return text;
};

export const buildSuggestPrompt = (input: SuggestInput): string =>
  `You are a senior product engineer reviewing an app a user just built in a code studio. Propose the BEST next steps — the things that would most improve THIS specific app.

APP TITLE: ${input.title || '(untitled)'}

PROJECT FILES (trimmed):
${renderProject(input)}

Rules:
- Look at what the app ACTUALLY does and what's missing. Be specific to this app — never generic filler.
- Return 3 to 5 suggestions, ordered by value. Prefer: the obvious missing core feature, a high-impact new feature, one meaningful polish, and (if the app already looks complete) a "ship it / connect a backend" step.
- Each "prompt" must be a complete, ready-to-run instruction the build agent can execute to make that change (imperative, concrete).
- "label" is a short chip (2–5 words). "why" is one short sentence on the value. "kind" is one of: feature, polish, fix, data, ship.

Return ONLY JSON — no prose, no markdown:
{"suggestions":[{"label":"...","prompt":"...","why":"...","kind":"feature"}]}`;

/** Parse + harden the model's suggestion JSON. Tolerant of noise; never throws. */
export const parseSuggest = (text: string): StudioSuggestResult => {
  let parsed: { suggestions?: unknown } | null = null;
  try {
    parsed = extractJson(text);
  } catch {
    return { suggestions: [] };
  }
  const raw = Array.isArray(parsed?.suggestions) ? (parsed!.suggestions as unknown[]) : [];
  const suggestions: StudioSuggestion[] = [];
  for (const s of raw.slice(0, 6)) {
    const r = (s || {}) as Record<string, unknown>;
    const label = typeof r.label === 'string' ? r.label.trim().slice(0, 60) : '';
    const prompt = typeof r.prompt === 'string' ? r.prompt.trim().slice(0, 600) : '';
    if (!label || !prompt) continue;
    const why = typeof r.why === 'string' ? r.why.trim().slice(0, 160) : undefined;
    const kind = KINDS.includes(r.kind as never) ? (r.kind as StudioSuggestion['kind']) : undefined;
    suggestions.push({ label, prompt, why, kind });
  }
  return { suggestions: suggestions.slice(0, 5) };
};

/** Compose prompt → model → parsed suggestions. `complete` is the injected model call. */
export const runSuggest = async (
  input: SuggestInput,
  complete: (prompt: string) => Promise<string>,
): Promise<StudioSuggestResult> => parseSuggest(await complete(buildSuggestPrompt(input)));
