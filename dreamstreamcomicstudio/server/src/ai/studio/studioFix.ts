// Phase 4 — agentic build loop: the FIX stage.
//
// Server-side counterpart of the client's studio/aiFix.ts, but driven by a structured
// BuildObservation instead of a raw log. Builds a focused prompt (errors first, minimal
// diffs) and parses the model's JSON file list back out. The actual model call is injected
// so the prompt/parse logic stays pure + unit-testable; the live wiring supplies a real
// `complete()` backed by the platform AI client.

import { extractJson } from '../json.js';
import type { BuildObservation } from './observation.js';
import { DESIGN_FIX_NOTE } from './designSystem.js';

export type StudioFiles = Record<string, string>;

export interface StudioFixResult {
  files: StudioFiles; // only the files the model changed (path → full content)
  note?: string; // one-line description of the fix
  /** Optional guardrailed install command the agent wants the sandbox to run next. */
  install?: string;
  /** Optional guardrailed dev/start command. */
  dev?: string;
}

// Binaries the agent is allowed to invoke in the sandbox (package managers + build/run tools).
const ALLOWED_CMD_BINS = new Set([
  'npm', 'pnpm', 'yarn', 'npx', 'node', 'vite', 'tsc', 'next', 'nuxt', 'astro', 'vue-cli-service',
  'react-scripts', 'webpack', 'rollup', 'esbuild', 'parcel', 'serve', 'http-server',
  'python', 'python3', 'pip', 'pip3', 'uv', 'uvicorn', 'flask', 'gunicorn', 'go', 'cargo', 'deno', 'bun'
]);

/**
 * Guardrail a model-proposed install/dev command before it can run in the sandbox: it must start
 * with a whitelisted build/run binary and contain NO shell metacharacters (no chaining, piping,
 * redirection, substitution, globs, or escapes). Returns the cleaned command, or undefined if
 * it's empty/unsafe. This is what lets agents control the terminal *with* guardrails.
 */
export const sanitizeStudioCommand = (cmd: unknown): string | undefined => {
  if (typeof cmd !== 'string') return undefined;
  const c = cmd.trim().slice(0, 300);
  if (!c) return undefined;
  // Conservative charset: word chars, @ . / : ^ ~ - and spaces (^/~ for version ranges like
  // axios@^1.6.0). Everything else (; & | $ > < ` * ? {} () [] = \ etc.) is rejected.
  if (!/^[\w@.:\/^~ -]+$/.test(c)) return undefined;
  const bin = c.split(/\s+/)[0];
  if (!ALLOWED_CMD_BINS.has(bin)) return undefined;
  return c;
};

/** Render the observation's errors as a concise, model-friendly list. */
const renderErrors = (observation: BuildObservation): string => {
  if (!observation.errors.length) return '(no structured errors — inspect the code for obvious issues)';
  return observation.errors
    .map((e, i) => {
      const loc = e.file ? ` (${e.file}${e.line ? `:${e.line}` : ''})` : '';
      const mod = e.module ? ` [${e.module}]` : '';
      return `${i + 1}. [${e.kind}]${mod} ${e.message}${loc}`;
    })
    .join('\n');
};

export const buildFixPrompt = (files: StudioFiles, observation: BuildObservation): string => {
  const fileBlock = Object.entries(files)
    .map(([p, c]) => `FILE: ${p}\n\`\`\`\n${c}\n\`\`\``)
    .join('\n\n');

  return `You are a senior engineer fixing an app that failed to build or run in a sandbox. Diagnose from the OBSERVED ERRORS and return the MINIMAL set of changed files needed to make it build and run cleanly.

OBSERVED ERRORS (phase: ${observation.phase}):
${renderErrors(observation)}

Rules:
- Change as few files as possible. Return the COMPLETE content of each file you change — never truncate, never leave placeholders.
- Missing dependency: add it to /package.json (create /package.json if the project needs npm packages beyond the default scaffold). Never invent packages that do not exist on npm.
- Unresolved relative import: fix the path, or create the missing file.
- Type/syntax error: correct it in place.
- Do not include files you did not change.
- You CONTROL the sandbox terminal (with guardrails): if the fix needs a package installed or a
  different start command, also return an "install" and/or "dev" command. Use ONLY a package
  manager or build/run tool (npm/pnpm/yarn/npx/node/vite/python/pip/go/…). NO shell operators,
  pipes, redirects, env-assignments, or command chaining — those are rejected.
- ${DESIGN_FIX_NOTE}

PROJECT FILES:

${fileBlock}

Return ONLY a JSON object of this exact shape — no prose, no markdown outside the JSON:
{"note":"one short sentence on what you fixed","files":[{"path":"<path>","content":"<full corrected file content>"}],"install":"<optional install command>","dev":"<optional dev/start command>"}`;
};

/** Parse the model's JSON answer into changed files. Tolerant of noise/no-JSON. */
export const parseFixResponse = (text: string): StudioFixResult => {
  let parsed: { note?: unknown; files?: unknown } | null = null;
  try {
    parsed = extractJson(text);
  } catch {
    return { files: {} };
  }
  const rawFiles = Array.isArray(parsed?.files) ? (parsed!.files as unknown[]) : [];
  const files: StudioFiles = {};
  for (const f of rawFiles) {
    const entry = f as { path?: unknown; content?: unknown };
    if (typeof entry?.path === 'string' && typeof entry?.content === 'string') {
      files[entry.path.replace(/^\/+/, '')] = entry.content;
    }
  }
  return {
    files,
    note: typeof parsed?.note === 'string' ? parsed.note : undefined,
    install: sanitizeStudioCommand((parsed as { install?: unknown })?.install),
    dev: sanitizeStudioCommand((parsed as { dev?: unknown })?.dev)
  };
};

/** Compose prompt → model → parsed fix. `complete` is the injected model call. */
export const requestStudioFix = async (
  files: StudioFiles,
  observation: BuildObservation,
  complete: (prompt: string) => Promise<string>
): Promise<StudioFixResult> => parseFixResponse(await complete(buildFixPrompt(files, observation)));
