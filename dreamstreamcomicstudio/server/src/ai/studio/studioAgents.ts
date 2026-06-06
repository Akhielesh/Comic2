// Multi-agent Code Studio refinement.
//
// A team of specialist agents — Architect, Code Engineer, Frontend, UI/UX, Visual Design,
// Data & Live APIs, Security, Verification/QA — collaboratively reviews and refines a generated
// app. The user picks which agents to run (their "preferences"); enabled agents run SEQUENTIALLY
// in a canonical order so each builds on the previous one's improvements. Each agent returns
// MINIMAL file diffs in the same JSON shape as the build-loop FIX stage (parser reused), gated
// through the same path/size safety checks before merging.
//
// Crucially, the `data` agent is wired with live web/data TOOLS, so it can research real public
// APIs and wire LIVE data into the app (replacing mocks with real fetches) — and other agents can
// be given tools too. This is what makes the studio "agentic + live-data" capable.

import { parseFixResponse, type StudioFiles } from './studioFix.js';
import { sanitizeFixFiles, canonicalStudioPath } from '../../services/studioFiles.js';

export interface StudioAgentDef {
  id: string;
  name: string;
  /** Shown in the UI. */
  description: string;
  /** Role-specific guidance injected into the prompt (server-only). */
  focus: string;
  /** Live-data / web tools this agent may call (must be in the tool allowlist). */
  toolNames: string[];
  /** Enabled by default. */
  default: boolean;
  /** Lucide icon name (resolved on the client). */
  icon: string;
}

export const STUDIO_AGENTS: Record<string, StudioAgentDef> = {
  architecture: {
    id: 'architecture', name: 'Architect', icon: 'Building2', default: true, toolNames: [],
    description: 'Project structure, module boundaries, state management and scalability.',
    focus: `Review the project's ARCHITECTURE: file/module structure, separation of concerns, component and state boundaries, data flow, and scalability. Extract reusable pieces, untangle dependencies, and make the structure clean and idiomatic for the stack. Do not change the visual design or behavior — only the structure.`
  },
  code: {
    id: 'code', name: 'Code Engineer', icon: 'Code2', default: true, toolNames: ['web_search', 'npm_package', 'github_repo'],
    description: 'Code quality, correctness, completeness and idiomatic patterns.',
    focus: `Review CODE QUALITY: correctness, completeness (no TODOs/placeholders/stubs), idiomatic patterns, dead code, naming, and obvious bugs. Make the code production-quality and fully runnable. Use web_search/npm_package only to confirm a real package name or API signature — never invent packages.`
  },
  frontend: {
    id: 'frontend', name: 'Frontend Engineer', icon: 'MonitorSmartphone', default: true, toolNames: [],
    description: 'Framework correctness, hooks, rendering performance and build config.',
    focus: `Review FRONTEND engineering: framework correctness (React hooks/effects/keys, state updates), rendering performance, proper loading/error states, and build/runtime configuration. Fix anti-patterns and ensure the app compiles and runs cleanly in the browser.`
  },
  ui: {
    id: 'ui', name: 'UI / UX', icon: 'Layout', default: true, toolNames: [],
    description: 'Layout, interaction, accessibility and responsive design.',
    focus: `Review UI/UX: layout, spacing, visual hierarchy, interaction feedback, empty/loading/error states, keyboard accessibility (a11y), and full RESPONSIVE behavior across mobile and desktop. Improve usability and polish without breaking behavior.`
  },
  design: {
    id: 'design', name: 'Visual Design', icon: 'Palette', default: false, toolNames: [],
    description: 'Typography, color, spacing system and overall aesthetic polish.',
    focus: `Review VISUAL DESIGN: typography scale, color palette and contrast, consistent spacing/radius/shadows, and overall aesthetic polish. Apply a cohesive, modern, attractive look. Keep the structure and behavior — change styling only.`
  },
  data: {
    id: 'data', name: 'Data & Live APIs', icon: 'Database', default: false,
    toolNames: ['web_search', 'wiki_lookup', 'get_news', 'get_stock', 'crypto_price', 'exchange_rate', 'get_weather', 'find_places', 'github_repo', 'npm_package'],
    description: 'Wires real, LIVE data sources and robust fetching into the app.',
    focus: `Wire REAL, LIVE DATA into the app. Where it uses mock/placeholder/hard-coded data, replace it with real data from a suitable public API: use your tools to FIND and VERIFY real, free, CORS-friendly endpoints and their actual response shapes, then implement proper fetch + loading/error/empty states and typed parsing. Prefer keyless/public APIs; if a key is required, read it from an environment variable and document it in /.env.example. Do NOT invent endpoints — only use ones you verified with your tools.`
  },
  security: {
    id: 'security', name: 'Security', icon: 'ShieldCheck', default: true, toolNames: ['web_search'],
    description: 'Input validation, secrets handling, XSS/injection and safe defaults.',
    focus: `Review SECURITY: input validation/sanitization, output encoding (XSS), unsafe HTML/eval, secrets hard-coded in client code (move to env vars), risky dependencies, and safe-by-default configuration. Fix real vulnerabilities; do not bolt on heavyweight auth the app didn't ask for.`
  },
  verification: {
    id: 'verification', name: 'Verification / QA', icon: 'CheckCircle2', default: true, toolNames: [],
    description: 'Correctness, edge cases, error handling — does it actually run.',
    focus: `Act as QA / VERIFICATION (run LAST): trace the app end-to-end for correctness and edge cases (empty inputs, errors, async races), make sure it actually builds and runs, and fix any remaining defects with the smallest changes possible. If everything is solid, change nothing.`
  }
};

// Canonical run order: foundations → quality → presentation → data → safety → QA last.
export const STUDIO_AGENT_ORDER = ['architecture', 'code', 'frontend', 'ui', 'design', 'data', 'security', 'verification'];

export const DEFAULT_STUDIO_AGENTS = STUDIO_AGENT_ORDER.filter((id) => STUDIO_AGENTS[id].default);

/** Validate + order a requested agent id list; falls back to the default team when empty. */
export const sanitizeAgentIds = (raw: unknown): string[] => {
  const ids = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
  const set = new Set(ids);
  const picked = STUDIO_AGENT_ORDER.filter((id) => set.has(id) && STUDIO_AGENTS[id]);
  return picked.length ? picked : DEFAULT_STUDIO_AGENTS;
};

/** Public, prompt-free catalog for the client UI. */
export const studioAgentCatalog = (): { id: string; name: string; description: string; icon: string; default: boolean; hasTools: boolean }[] =>
  STUDIO_AGENT_ORDER.map((id) => {
    const a = STUDIO_AGENTS[id];
    return { id: a.id, name: a.name, description: a.description, icon: a.icon, default: a.default, hasTools: a.toolNames.length > 0 };
  });

const renderFiles = (files: StudioFiles): string =>
  Object.entries(files).map(([p, c]) => `FILE: ${p}\n\`\`\`\n${c}\n\`\`\``).join('\n\n');

export const buildAgentPrompt = (def: StudioAgentDef, files: StudioFiles, preferences: string): string =>
  `You are the ${def.name} on a team of specialist agents collaboratively refining an app in a live code studio. Work ONLY within your specialty; other agents handle the rest.

YOUR FOCUS:
${def.focus}

Rules:
- Make REAL, surgical improvements in your area. Do not rewrite everything; change only what your specialty calls for.
- Keep the app runnable. Return the COMPLETE content of each file you change — never truncate, never leave placeholders or TODOs.
- If the project is already solid in your area, return an empty files array with a short note.
- Only include files you actually changed.
${preferences ? `\nUSER PREFERENCES / GOAL (honor these):\n${preferences}\n` : ''}
PROJECT FILES:

${renderFiles(files)}

Return ONLY a JSON object — no prose, no markdown outside the JSON:
{"note":"one short sentence on what you improved (or why no change was needed)","files":[{"path":"/path","content":"<full updated file content>"}]}`;

export type StudioAgentStatus = 'running' | 'done' | 'skipped' | 'error';

export interface StudioAgentEvent {
  stage: 'agent' | 'done';
  agentId?: string;
  name?: string;
  status?: StudioAgentStatus;
  note?: string;
  changed?: string[];
  index?: number;
  total?: number;
}

export interface RunStudioAgentsDeps {
  /** Injected model call. `toolNames` lets data/research agents use live tools. Returns raw text. */
  complete: (prompt: string, toolNames: string[]) => Promise<string>;
  onEvent?: (e: StudioAgentEvent) => void;
  signal?: AbortSignal;
}

export interface StudioAgentTraceEntry {
  id: string;
  name: string;
  status: 'done' | 'skipped' | 'error';
  note?: string;
  changed: string[];
}

export interface StudioAgentRunResult {
  files: StudioFiles;
  trace: StudioAgentTraceEntry[];
}

/**
 * Run the enabled agents sequentially, each refining the working file set. Pure orchestration:
 * the model call is injected so this is unit-testable. Diffs are safety-gated (path/size) before
 * merge, and keys are canonicalized so changes overwrite rather than duplicate files.
 */
export const runStudioAgents = async (
  initialFiles: StudioFiles,
  agentIds: string[],
  preferences: string,
  deps: RunStudioAgentsDeps
): Promise<StudioAgentRunResult> => {
  let working: StudioFiles = {};
  for (const [p, c] of Object.entries(initialFiles)) working[canonicalStudioPath(p)] = c;

  const ordered = sanitizeAgentIds(agentIds);
  const total = ordered.length;
  const trace: StudioAgentTraceEntry[] = [];

  for (let i = 0; i < ordered.length; i += 1) {
    if (deps.signal?.aborted) break;
    const def = STUDIO_AGENTS[ordered[i]];
    deps.onEvent?.({ stage: 'agent', agentId: def.id, name: def.name, status: 'running', index: i, total });
    try {
      const text = await deps.complete(buildAgentPrompt(def, working, preferences), def.toolNames);
      const parsed = parseFixResponse(text);
      const safe = sanitizeFixFiles(parsed.files, { maxFiles: 30 });
      const changed = Object.keys(safe.files);
      if (changed.length) working = { ...working, ...safe.files };
      const status: 'done' | 'skipped' = changed.length ? 'done' : 'skipped';
      trace.push({ id: def.id, name: def.name, status, note: parsed.note, changed });
      deps.onEvent?.({ stage: 'agent', agentId: def.id, name: def.name, status, note: parsed.note, changed, index: i, total });
    } catch (err) {
      const note = (err as Error)?.message || 'agent failed';
      trace.push({ id: def.id, name: def.name, status: 'error', note, changed: [] });
      deps.onEvent?.({ stage: 'agent', agentId: def.id, name: def.name, status: 'error', note, changed: [], index: i, total });
    }
  }

  deps.onEvent?.({ stage: 'done', total });
  return { files: working, trace };
};
