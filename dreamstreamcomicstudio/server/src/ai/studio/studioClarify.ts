// Code Studio — the CLARIFY stage of the build flow.
//
// Before building, a senior product-engineer persona decides what it genuinely needs to know to
// build the RIGHT app, and asks 0–4 high-signal questions (the user answers by picking options or
// typing a custom answer). For anything obvious it makes smart assumptions instead of asking, so
// simple ideas build straight away. Pure prompt + tolerant parser (model call injected → testable).

import { extractJson } from '../json.js';
import type { StudioClarifyResult, StudioClarifyQuestion, StudioClarifyOption, StudioQuestionKind } from '../../../../apiTypes.js';

export const buildClarifyPrompt = (prompt: string): string =>
  `You are a senior product engineer kicking off a new build in a code studio. Before writing any code, decide what you GENUINELY need to know from the user to build the RIGHT application — the way a thoughtful engineer would ask a few sharp questions, not a long form.

USER'S IDEA:
${prompt}

Rules:
- Ask ONLY high-signal questions that would change what you build (scope, key features, data source, audience, style, auth, platform). Ask 0 to 4 — fewer is better.
- For anything obvious or low-stakes, DO NOT ask — make a sensible assumption and list it under "assumptions".
- Each question offers 2–5 concrete options the user can pick from; set "allowCustom": true so they can also type their own answer.
- Use "kind":"single" when one choice fits, "multi" when several can apply.
- If the idea is already clear enough to build well, return an empty "questions" array and just list your assumptions.

Return ONLY a JSON object — no prose, no markdown:
{"questions":[{"id":"scope","question":"...","kind":"single","options":[{"label":"...","value":"...","hint":"..."}],"allowCustom":true}],"assumptions":["..."]}`;

const KINDS: StudioQuestionKind[] = ['single', 'multi'];

const sanitizeOptions = (raw: unknown): StudioClarifyOption[] => {
  if (!Array.isArray(raw)) return [];
  const out: StudioClarifyOption[] = [];
  for (const o of raw.slice(0, 6)) {
    const r = (o || {}) as { label?: unknown; value?: unknown; hint?: unknown };
    const label = typeof r.label === 'string' ? r.label.trim().slice(0, 80) : '';
    if (!label) continue;
    const value = typeof r.value === 'string' && r.value.trim() ? r.value.trim().slice(0, 120) : label;
    out.push({ label, value, hint: typeof r.hint === 'string' ? r.hint.trim().slice(0, 140) : undefined });
  }
  return out;
};

/** Parse + harden the model's clarify JSON. Tolerant of noise; never throws. */
export const parseClarify = (text: string): StudioClarifyResult => {
  let parsed: { questions?: unknown; assumptions?: unknown } | null = null;
  try {
    parsed = extractJson(text);
  } catch {
    return { questions: [], assumptions: [] };
  }
  const rawQuestions = Array.isArray(parsed?.questions) ? (parsed!.questions as unknown[]) : [];
  const questions: StudioClarifyQuestion[] = [];
  let i = 0;
  for (const q of rawQuestions.slice(0, 4)) {
    const r = (q || {}) as Record<string, unknown>;
    const question = typeof r.question === 'string' ? r.question.trim().slice(0, 240) : '';
    if (!question) continue;
    const options = sanitizeOptions(r.options);
    // A question with no options is useless unless it explicitly invites a custom answer.
    const allowCustom = r.allowCustom !== false;
    if (!options.length && !allowCustom) continue;
    const kind: StudioQuestionKind = KINDS.includes(r.kind as StudioQuestionKind) ? (r.kind as StudioQuestionKind) : 'single';
    const id = (typeof r.id === 'string' && r.id.trim() ? r.id : `q${i + 1}`)
      .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || `q${i + 1}`;
    questions.push({ id, question, kind, options, allowCustom });
    i += 1;
  }
  const assumptions = Array.isArray(parsed?.assumptions)
    ? (parsed!.assumptions as unknown[]).filter((a): a is string => typeof a === 'string').map((a) => a.trim().slice(0, 200)).filter(Boolean).slice(0, 8)
    : [];
  return { questions, assumptions };
};

/** Compose prompt → model → parsed clarify result. `complete` is the injected model call. */
export const runClarify = async (
  prompt: string,
  complete: (prompt: string) => Promise<string>
): Promise<StudioClarifyResult> => parseClarify(await complete(buildClarifyPrompt(prompt)));
