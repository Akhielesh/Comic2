// In-studio app generation — the prompt + parser behind POST /api/studio/generate.
//
// This is what lets Code Studio build an app from a plain-language idea WITHOUT bouncing the
// user to chat: the route feeds buildGeneratePrompt() to a coding model, then parses the
// model's JSON back into a CodeStudioArtifact. Generation is pure LLM (no sandbox/worker), so
// it works as soon as a coding key is configured — the live cloud run is a separate upgrade.
//
// Kept pure + dependency-injected (the model call lives in the route) so prompt/parse logic is
// unit-testable.

import type { CodeStudioArtifact, CodeStudioFile, CodeStudioTemplate, StudioBuildPlan, StudioAnswer } from '../../../../apiTypes.js';
import { renderPlanForBuild } from './studioPlan.js';
import { buildDesignDirective } from './designSystem.js';
import { STUDIO_CONSTITUTION } from './constitution.js';
import { verifyGeneratedApp, formatIssues, type AppIssue } from './verifyApp.js';

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript',
  js: 'javascript', jsx: 'javascript',
  html: 'html', css: 'css', scss: 'css', less: 'css',
  json: 'json', md: 'markdown', mdx: 'markdown',
  py: 'python', go: 'go', rs: 'rust', rb: 'ruby',
  java: 'java', kt: 'kotlin', swift: 'swift',
  sh: 'shell', bash: 'shell', yaml: 'yaml', yml: 'yaml',
  toml: 'toml', sql: 'sql', graphql: 'graphql',
};

const extToLanguage = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_LANG[ext] ?? ext;
};

export const VALID_TEMPLATES: CodeStudioTemplate[] = ['react-ts', 'react', 'vanilla-ts', 'vanilla', 'static'];

const normalizeTemplate = (t: unknown, fallback: CodeStudioTemplate = 'react-ts'): CodeStudioTemplate =>
  VALID_TEMPLATES.includes(t as CodeStudioTemplate) ? (t as CodeStudioTemplate) : fallback;

export interface GenerateInput {
  /** The user's plain-language app idea, or the change to apply. */
  prompt: string;
  /** Preferred framework template (defaults to react-ts). */
  template?: string;
  /** When iterating: the project's current files. Triggers "refine" mode. */
  currentFiles?: { path: string; content: string }[];
  /** Current project title (refine), for continuity. */
  currentTitle?: string;
  /** Build plan to follow (new-app flow) — produced by the PLAN stage. */
  plan?: StudioBuildPlan;
  /** The user's clarifying answers (new-app flow). */
  answers?: StudioAnswer[];
  /** Optional user-pinned design-system preset id (overrides the heuristic pick). */
  designPreset?: string;
}

const renderFiles = (files: { path: string; content: string }[]): string =>
  files
    .map((f) => `FILE: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``)
    .join('\n\n');

const OUTPUT_CONTRACT = `Return ONLY a single JSON object — no prose, no markdown fences around it — of EXACTLY this shape:
{"title":"<short name>","description":"<one sentence>","template":"react-ts|react|vanilla-ts|vanilla|static","files":[{"path":"/App.tsx","content":"<full file content>"}]}

Rules:
- Emit COMPLETE, runnable code in every file. Never truncate, never write "// TODO" or placeholder comments.
- Use the RIGHT language and project layout for the idea — you are NOT limited to web apps. For example:
  - Web UI → React (root component = DEFAULT export of /App.tsx or /src/App.tsx) or a static /index.html.
  - Mobile app → Expo + React Native (/App.tsx using react-native components + /app.json). Keep "template":"react-ts"; the studio auto-detects React Native, previews it on web via react-native-web, and runs it on device via "npm run native". Prefer core RN components + react-native-reusables; build it cross-platform.
  - Presentation / slide deck → a web slides app (reveal.js, or a keyboard-navigable slide component with arrow-key + dot navigation and a clean theme).
  - HTTP API / backend → Node/Express (/server.js + /package.json) or Python (/main.py + /requirements.txt).
  - Script · CLI · data/automation → Python (/main.py + /requirements.txt), Node (/index.js), or Go (/main.go).
- Build a COMPLETE, well-structured, MULTI-FILE application — never cram everything into one file. Split it
  into a sensible tree: an entry file, a SEPARATE file for each significant component/screen, hooks/logic,
  shared types, a small data layer, and styles as appropriate (a real app is typically 5–15 files). Include
  the language's manifest when you need dependencies (/package.json, /requirements.txt, /go.mod, …). For any
  non-web project add a short /README.md with the exact run commands.
- "template" must be one of the listed web templates: use "react-ts"/"react" for React, and "static" for
  everything else (plain HTML/CSS, or any non-web project). The studio detects the real language from your
  file extensions, so "static" is correct for Python/Go/Node-API/etc.
- Paths start with "/". Do not invent packages that do not exist.

Quality bar (write like a senior engineer shipping to production):
- Every relative import MUST resolve to a file you also emit. No dangling imports, no missing components.
- Polished, modern UI by default: sensible layout, spacing, typography and color; responsive; tasteful
  empty/loading/error states; accessible (labels, alt text, keyboard focus). Avoid unstyled scaffolding.
- Real behavior, not a stub: wire up the interactions the idea implies and seed realistic sample data so
  it looks alive on first load.
- IMPLEMENT THE CORE MECHANIC FOR REAL — this is the #1 requirement, before any visual polish. Whatever
  the request centers on must actually work end-to-end: an interactive app or game needs a real
  update/animation loop (requestAnimationFrame or setInterval), input handlers (keyboard/touch/mouse)
  wired to state, and the actual rules (movement, collision, scoring, win/lose, levels). NEVER write a
  comment that DESCRIBES behavior in place of the code (e.g. "// game loop, setInterval, etc." or
  "// initialization logic here"), never leave a handler empty, never ship a static mock of a dynamic
  feature. If you reference a flag like "gameOver", it must be a real boolean derived from real game
  state — not an unused function. A skeleton that renders but does nothing is a FAILURE.
- Robust code: handle edge cases and errors; for TypeScript use precise types (no stray "any"); keep
  components small and readable. No dead code, no console spam.`;

export const buildGeneratePrompt = (input: GenerateInput): string => {
  const template = normalizeTemplate(input.template);
  const refining = Array.isArray(input.currentFiles) && input.currentFiles.length > 0;

  if (refining) {
    return `${STUDIO_CONSTITUTION}

You are a senior engineer iterating on an existing app in a live code studio. Apply the requested change and return the COMPLETE updated project (every file), so it can replace the current files.

CURRENT APP${input.currentTitle ? ` ("${input.currentTitle}")` : ''} — template: ${template}

${renderFiles(input.currentFiles!)}

REQUESTED CHANGE:
${input.prompt}

${buildDesignDirective({ prompt: input.prompt, refining: true })}

${OUTPUT_CONTRACT}`;
  }

  // Plan-driven build (new "engineering team" flow): follow the approved plan so the output is a
  // structured, multi-file app — not a one-shot single file.
  if (input.plan) {
    const answersBlock = input.answers?.length
      ? `\n\nThe user's answers to clarifying questions (honor these):\n${input.answers.map((a) => `- ${a.question} → ${a.answer}`).join('\n')}`
      : '';
    return `${STUDIO_CONSTITUTION}

You are a senior engineer implementing an APPROVED build plan in a live code studio (multi-language editor + instant web preview). Build the COMPLETE application and make it run cleanly on first load.

PROJECT IDEA:
${input.prompt}${answersBlock}

APPROVED BUILD PLAN — this defines the GOAL: the product, every feature, the stack and the data. Implement EVERY listed feature for real. You have FULL FREEDOM over HOW you build it: design the file structure, components and architecture yourself, exactly as a senior engineer would. Any file list in the plan is only a rough suggestion — create, split, rename, add or omit files however is best for a clean, well-organized, complete app. Do not feel bound to the suggested paths.
${renderPlanForBuild(input.plan)}

Default web stack if the plan doesn't imply another: ${template}.

${buildDesignDirective({ prompt: input.prompt, presetId: input.designPreset })}

${OUTPUT_CONTRACT}`;
  }

  return `${STUDIO_CONSTITUTION}

You are a senior engineer building a complete, runnable project from a one-line idea, to open in a live code studio (multi-language editor + instant web preview). Pick the language and stack that best fit the idea — a web UI, a backend API, a CLI, a script, or a data task — don't force everything into a web app.

PROJECT IDEA:
${input.prompt}

Default web stack if the idea is a UI and doesn't imply another: ${template}.

${buildDesignDirective({ prompt: input.prompt, presetId: input.designPreset })}

${OUTPUT_CONTRACT}`;
};

type RawApp = { title?: unknown; description?: unknown; template?: unknown; files?: unknown };

const tryParseObject = (s: string): RawApp | null => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as RawApp) : null;
  } catch {
    return null;
  }
};

// Pull the app object out of the model's reply. Tolerant of ```json fences and of prose
// wrapped around the JSON. Prefers the OUTERMOST object (extractJson in ../json.ts greedily
// matches the inner `files` array first when there is surrounding prose, losing title/template).
const extractAppObject = (text: string): RawApp | null => {
  const stripped = text.replace(/```json\s*|```/g, '').trim();
  const whole = tryParseObject(stripped);
  if (whole) return whole;
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first >= 0 && last > first) return tryParseObject(stripped.slice(first, last + 1));
  return null;
};

/** Parse the model's JSON answer into a runnable artifact. Tolerant of surrounding noise; returns null if unusable. */
export const parseGeneratedApp = (text: string, fallbackTemplate?: string): CodeStudioArtifact | null => {
  const parsed = extractAppObject(text);
  if (!parsed) return null;

  const rawFiles = Array.isArray(parsed.files) ? (parsed.files as unknown[]) : [];
  const files: CodeStudioFile[] = rawFiles
    .map((f) => f as { path?: unknown; content?: unknown })
    .filter((f) => typeof f?.path === 'string' && typeof f?.content === 'string')
    .slice(0, 50)
    .map((f) => ({
      path: (f.path as string).startsWith('/') ? (f.path as string) : `/${f.path as string}`,
      content: f.content as string,
      language: extToLanguage(f.path as string),
    }));

  if (!files.length) return null;

  const title = typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim().slice(0, 100) : 'App';
  const description =
    typeof parsed.description === 'string' && parsed.description.trim()
      ? parsed.description.trim().slice(0, 300)
      : undefined;
  const template = normalizeTemplate(parsed.template, normalizeTemplate(fallbackTemplate));

  return { title, description, files, template };
};

export const STRICT_JSON_REMINDER =
  '\n\nIMPORTANT: Output ONLY the JSON object described above — no prose, no markdown fences, no explanation. Begin your reply with "{" and end with "}".';

/** Refine prompt that feeds verifier issues back for a one-pass auto-repair (parity with the stream path). */
const buildRepairPrompt = (input: GenerateInput, artifact: CodeStudioArtifact, issues: AppIssue[]): string =>
  buildGeneratePrompt({
    prompt: `The generated project has these issues. Fix them and return the COMPLETE updated project so it is correct, complete and runs cleanly:\n${formatIssues(issues)}`,
    template: input.template,
    currentFiles: artifact.files.map((f) => ({ path: f.path, content: f.content })),
    currentTitle: artifact.title
  });

/**
 * Loop the static verifier + auto-repair until the app is clean or the pass budget is spent. This is
 * what makes the studio actually VERIFY the code (rather than ship the first answer): each pass feeds
 * the remaining issues back to the model and re-checks. Returns the cleanest artifact it reached.
 * Shared by both the blocking generate ({@link runGenerate}) and the SSE stream route.
 */
export const MAX_REPAIR_PASSES = 3;
export const repairUntilClean = async (
  complete: (prompt: string) => Promise<string>,
  input: GenerateInput,
  artifact: CodeStudioArtifact,
  opts: { maxPasses?: number; onPass?: (info: { pass: number; issues: AppIssue[] }) => void } = {}
): Promise<CodeStudioArtifact> => {
  const maxPasses = opts.maxPasses ?? MAX_REPAIR_PASSES;
  let current = artifact;
  let issues = verifyGeneratedApp(current);
  let pass = 0;
  while (issues.length && pass < maxPasses) {
    pass += 1;
    opts.onPass?.({ pass, issues });
    const repaired = parseGeneratedApp(await complete(buildRepairPrompt(input, current, issues)), input.template);
    if (!repaired) break; // unparseable repair → keep the best version we have
    current = repaired;
    issues = verifyGeneratedApp(current);
  }
  return current;
};

/** A model self-review against the ORIGINAL request — the "does it actually work?" quality gate. */
export const buildCompletenessReviewPrompt = (originalPrompt: string, artifact: CodeStudioArtifact): string =>
  `You generated this project for the request:
"${originalPrompt}"

${renderFiles(artifact.files)}

Review it CRITICALLY, as if you were the user trying to use it. It must be a COMPLETE, WORKING implementation, not a skeleton:
- The core behaviour/mechanic actually works end-to-end (for a game: a real loop, input handling, movement, collision, scoring, win/lose; for an app: the real interactions + data flow the request implies).
- No placeholder logic, no comment standing in for missing code, no empty/no-op handlers, no static mock of a dynamic feature.
- It runs and is usable on first load.

If it is already complete and correct, return it UNCHANGED. Otherwise return the COMPLETE corrected project with every gap implemented for real.

${OUTPUT_CONTRACT}`;

/** Run one completeness self-review; keep the original unless the review parses AND is no more broken. */
export const reviewCompleteness = async (
  complete: (prompt: string) => Promise<string>,
  originalPrompt: string,
  artifact: CodeStudioArtifact,
  template?: string
): Promise<CodeStudioArtifact> => {
  try {
    const reviewed = parseGeneratedApp(await complete(buildCompletenessReviewPrompt(originalPrompt, artifact)), template);
    if (
      reviewed &&
      reviewed.files.length >= artifact.files.length &&
      verifyGeneratedApp(reviewed).length <= verifyGeneratedApp(artifact).length
    ) {
      return reviewed;
    }
  } catch {
    /* best-effort — keep the original on any failure */
  }
  return artifact;
};

/**
 * Generate an app: parse (with ONE stricter retry on unparseable output), then AUTO-REPAIR any static
 * issues the verifier finds (empty/placeholder/stub markers, a comment-only game loop, missing default
 * export, bad JSON, unresolved imports), then run ONE functional completeness self-review for NEW apps
 * — so the user gets a working app, not a skeleton, without clicking "fix". `complete` is injected so
 * this stays unit-testable; `review` can be disabled (defaults on for new apps, off for refine).
 */
export const runGenerate = async (
  complete: (prompt: string) => Promise<string>,
  input: GenerateInput,
  opts: { review?: boolean } = {}
): Promise<CodeStudioArtifact | null> => {
  const prompt = buildGeneratePrompt(input);
  let artifact = parseGeneratedApp(await complete(prompt), input.template);
  if (!artifact) {
    artifact = parseGeneratedApp(await complete(prompt + STRICT_JSON_REMINDER), input.template);
  }
  if (!artifact) return null;

  // Verify + repair in a loop (not a single pass) so the app keeps getting fixed until it's clean.
  artifact = await repairUntilClean(complete, input, artifact);

  const review = opts.review ?? !(input.currentFiles && input.currentFiles.length);
  if (review) artifact = await reviewCompleteness(complete, input.prompt, artifact, input.template);

  return artifact;
};
