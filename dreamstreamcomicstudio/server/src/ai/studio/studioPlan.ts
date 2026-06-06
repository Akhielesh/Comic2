// Code Studio — the PLAN stage of the build flow.
//
// A tech-lead persona turns the idea (+ the user's clarifying answers) into a concrete build plan
// for a COMPLETE, multi-file application: summary, stack, a real feature list, a planned file tree
// with each file's purpose, and any real data sources. The plan is shown to the user before any
// code is written, and the build stage is driven by it (so the output is structured, not one file).

import { extractJson } from '../json.js';
import type { StudioBuildPlan, StudioPlanFile, StudioAnswer } from '../../../../apiTypes.js';

const renderAnswers = (answers?: StudioAnswer[]): string => {
  if (!answers || !answers.length) return '';
  return `\n\nThe user answered these clarifying questions:\n${answers
    .map((a) => `- ${a.question} → ${a.answer}`)
    .join('\n')}`;
};

export const buildPlanPrompt = (prompt: string, answers?: StudioAnswer[]): string =>
  `You are the tech lead planning a new build in a code studio. Produce a concrete, buildable plan for a COMPLETE application — the kind you'd write before assigning work to a team. Be specific and ambitious but realistic; this plan will directly drive the build.

USER'S IDEA:
${prompt}${renderAnswers(answers)}

FIRST, RESEARCH (use your tools before deciding): study how this kind of app is built well — use the
DeepWiki tools to read/ask about RELEVANT, POPULAR GitHub repos in this domain and borrow their proven
structure and patterns, and verify real packages/APIs (npm/pypi/web). Reference what you learned in "notes".

Produce:
- title: a short product name.
- summary: 1–2 sentences describing what the app does and for whom.
- appType: e.g. "React dashboard", "Express REST API", "Python CLI".
- stack: the concrete technologies (framework, language, key libraries, styling).
- features: 6–12 concrete, user-visible features the build will implement (not vague).
- files: the planned file tree — a REAL app is many files, not one. List each file path and its purpose
  (entry, each significant component, hooks/logic, types, styles, data layer, manifest, README as needed).
- dataSources: real APIs/data the app uses (only if relevant; prefer free/public/CORS-friendly).
- notes: key decisions, assumptions, or risks worth surfacing.

Return ONLY a JSON object — no prose, no markdown:
{"title":"...","summary":"...","appType":"...","stack":["..."],"features":["..."],"files":[{"path":"/src/App.tsx","purpose":"..."}],"dataSources":["..."],"notes":["..."]}`;

const strArray = (raw: unknown, max: number, cap = 200): string[] =>
  Array.isArray(raw)
    ? raw.filter((x): x is string => typeof x === 'string').map((s) => s.trim().slice(0, cap)).filter(Boolean).slice(0, max)
    : [];

const sanitizeFiles = (raw: unknown): StudioPlanFile[] => {
  if (!Array.isArray(raw)) return [];
  const out: StudioPlanFile[] = [];
  for (const f of raw.slice(0, 40)) {
    const r = (f || {}) as { path?: unknown; purpose?: unknown };
    const path = typeof r.path === 'string' ? r.path.trim().slice(0, 200) : '';
    if (!path) continue;
    out.push({ path: path.startsWith('/') ? path : `/${path}`, purpose: typeof r.purpose === 'string' ? r.purpose.trim().slice(0, 200) : '' });
  }
  return out;
};

/** Parse + harden the model's plan JSON, or null when unusable. */
export const parsePlan = (text: string): StudioBuildPlan | null => {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = extractJson(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim().slice(0, 100) : '';
  const summary = typeof parsed.summary === 'string' ? parsed.summary.trim().slice(0, 600) : '';
  const features = strArray(parsed.features, 16);
  const files = sanitizeFiles(parsed.files);
  // A usable plan needs at least a title/summary and some substance (features or files).
  if (!title && !summary) return null;
  if (!features.length && !files.length) return null;
  return {
    title: title || 'App',
    summary: summary || '',
    appType: typeof parsed.appType === 'string' ? parsed.appType.trim().slice(0, 80) : '',
    stack: strArray(parsed.stack, 12, 80),
    features,
    files,
    dataSources: strArray(parsed.dataSources, 10, 160),
    notes: strArray(parsed.notes, 10)
  };
};

/** Render the plan as a compact spec block to drive the build stage. */
export const renderPlanForBuild = (plan: StudioBuildPlan): string => {
  const lines: string[] = [];
  lines.push(`TITLE: ${plan.title}`);
  if (plan.summary) lines.push(`SUMMARY: ${plan.summary}`);
  if (plan.appType) lines.push(`TYPE: ${plan.appType}`);
  if (plan.stack.length) lines.push(`STACK: ${plan.stack.join(', ')}`);
  if (plan.features.length) lines.push(`FEATURES:\n${plan.features.map((f) => `- ${f}`).join('\n')}`);
  if (plan.files.length) lines.push(`FILES TO CREATE:\n${plan.files.map((f) => `- ${f.path}${f.purpose ? ` — ${f.purpose}` : ''}`).join('\n')}`);
  if (plan.dataSources?.length) lines.push(`DATA SOURCES: ${plan.dataSources.join(', ')}`);
  if (plan.notes?.length) lines.push(`NOTES:\n${plan.notes.map((n) => `- ${n}`).join('\n')}`);
  return lines.join('\n');
};

/** Compose prompt → model → parsed plan, with one stricter retry when the first answer is unusable. */
export const runPlan = async (
  prompt: string,
  answers: StudioAnswer[] | undefined,
  complete: (prompt: string) => Promise<string>
): Promise<StudioBuildPlan | null> => {
  const p = buildPlanPrompt(prompt, answers);
  let plan = parsePlan(await complete(p));
  if (!plan) {
    plan = parsePlan(await complete(`${p}\n\nIMPORTANT: Output ONLY the JSON object — begin with "{" and end with "}".`));
  }
  return plan;
};
