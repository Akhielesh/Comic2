// In-studio app generation — the prompt + parser behind POST /api/studio/generate.
//
// This is what lets Code Studio build an app from a plain-language idea WITHOUT bouncing the
// user to chat: the route feeds buildGeneratePrompt() to a coding model, then parses the
// model's JSON back into a CodeStudioArtifact. Generation is pure LLM (no sandbox/worker), so
// it works as soon as a coding key is configured — the live cloud run is a separate upgrade.
//
// Kept pure + dependency-injected (the model call lives in the route) so prompt/parse logic is
// unit-testable.

import type { CodeStudioArtifact, CodeStudioFile, CodeStudioTemplate } from '../../../../apiTypes.js';

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
  - HTTP API / backend → Node/Express (/server.js + /package.json) or Python (/main.py + /requirements.txt).
  - Script · CLI · data/automation → Python (/main.py + /requirements.txt), Node (/index.js), or Go (/main.go).
- Prefer the smallest set of files that runs. Include the language's manifest when you need dependencies
  (/package.json, /requirements.txt, /go.mod, …). For any non-web project add a short /README.md with the
  exact run commands.
- "template" must be one of the listed web templates: use "react-ts"/"react" for React, and "static" for
  everything else (plain HTML/CSS, or any non-web project). The studio detects the real language from your
  file extensions, so "static" is correct for Python/Go/Node-API/etc.
- Paths start with "/". Do not invent packages that do not exist.`;

export const buildGeneratePrompt = (input: GenerateInput): string => {
  const template = normalizeTemplate(input.template);
  const refining = Array.isArray(input.currentFiles) && input.currentFiles.length > 0;

  if (refining) {
    return `You are a senior engineer iterating on an existing app in a live code studio. Apply the requested change and return the COMPLETE updated project (every file), so it can replace the current files.

CURRENT APP${input.currentTitle ? ` ("${input.currentTitle}")` : ''} — template: ${template}

${renderFiles(input.currentFiles!)}

REQUESTED CHANGE:
${input.prompt}

${OUTPUT_CONTRACT}`;
  }

  return `You are a senior engineer building a complete, runnable project from a one-line idea, to open in a live code studio (multi-language editor + instant web preview). Pick the language and stack that best fit the idea — a web UI, a backend API, a CLI, a script, or a data task — don't force everything into a web app.

PROJECT IDEA:
${input.prompt}

Default web stack if the idea is a UI and doesn't imply another: ${template}.

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

/**
 * Generate an app, with ONE stricter retry when the model's first answer can't be parsed
 * (truncation, prose, fence noise). `complete` is injected so this stays unit-testable.
 */
export const runGenerate = async (
  complete: (prompt: string) => Promise<string>,
  input: GenerateInput
): Promise<CodeStudioArtifact | null> => {
  const prompt = buildGeneratePrompt(input);
  let artifact = parseGeneratedApp(await complete(prompt), input.template);
  if (!artifact) {
    artifact = parseGeneratedApp(await complete(prompt + STRICT_JSON_REMINDER), input.template);
  }
  return artifact;
};
