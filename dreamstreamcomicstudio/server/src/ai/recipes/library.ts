// The built-in recipe library — the "what ships" set, analogous to the 8 built-in
// swarm specialists in agents/registry.ts. These are authored in-code (trusted), but
// still pass through sanitizeRecipe on read so the runtime treats them exactly like
// user/distilled recipes (same allowlist, same rules).
//
// Each recipe is a reusable, parameterized skill. Together they demonstrate the
// full surface: single-agent and swarm runs, typed parameters with defaults and
// selects, tool allowlists, activities, and structured (json_schema) output.

import type { Recipe } from './schema.js';
import { RECIPE_SCHEMA_VERSION } from './schema.js';
import { sanitizeRecipe } from './validate.js';

const AUTHOR = { contact: 'DreamStream', metadata: { builtin: true } };

// Raw definitions. Kept as Recipe so types are checked at authoring time; they are
// re-sanitized on access (BUILTIN_RECIPES) so they obey the live tool/agent allowlist.
const RAW: Recipe[] = [
  {
    version: RECIPE_SCHEMA_VERSION,
    id: 'deep-research-brief',
    title: 'Deep Research Brief',
    description: 'Multi-agent research on any topic, synthesized into a sourced executive brief.',
    swarm: true,
    agents: ['research', 'news'],
    instructions:
      'You are producing a rigorous, decision-ready research brief on: {{ topic }}.\n' +
      "Audience: {{ audience | default('a busy executive') }}. Depth: {{ depth | default('standard') }}.\n" +
      'Lead with the bottom line, then key findings (each with a source), then open questions and risks. ' +
      'Prefer primary/reputable sources, include dates, and flag anything you could not verify.',
    prompt: 'Research {{ topic }} and write the brief.',
    parameters: [
      { key: 'topic', input_type: 'string', requirement: 'required', description: 'What to research.' },
      { key: 'audience', input_type: 'string', requirement: 'optional', description: 'Who the brief is for.', default: 'a busy executive' },
      { key: 'depth', input_type: 'select', requirement: 'optional', description: 'How deep to go.', default: 'standard', options: ['quick', 'standard', 'exhaustive'] }
    ],
    activities: ['Turn this into a one-slide summary', 'What are the strongest counter-arguments?', 'Who are the key players to watch?'],
    author: AUTHOR
  },
  {
    version: RECIPE_SCHEMA_VERSION,
    id: 'comic-concept-forge',
    title: 'Comic Concept Forge',
    description: 'Forge a complete comic concept: logline, world, a cast bible, and the first 6 beats.',
    instructions:
      'You are a senior comic showrunner and world-builder for DreamStream Comic Studio. ' +
      'Develop a vivid, internally-consistent comic concept and return it as the requested JSON.\n\n' +
      'Premise: {{ premise }}\nGenre: {{ genre | default("sci-fi") }}\nTone: {{ tone | default("hopeful, cinematic") }}\n' +
      "Target length: {{ issues | default('a 6-issue limited series') }}.\n\n" +
      'Build: a one-line logline; a setting bible (world rules, factions, the central tension); a cast of 3–5 ' +
      'characters (name, role, want vs. need, a visual signature that stays consistent across panels); and a ' +
      'beat outline for the first arc. Keep names, designs and rules consistent — consistency is what makes a ' +
      'series feel real. Be concrete and visual; this feeds image generation later.',
    parameters: [
      { key: 'premise', input_type: 'string', requirement: 'required', description: 'The core idea or what-if.' },
      { key: 'genre', input_type: 'string', requirement: 'optional', default: 'sci-fi' },
      { key: 'tone', input_type: 'string', requirement: 'optional', default: 'hopeful, cinematic' },
      { key: 'issues', input_type: 'string', requirement: 'optional', default: 'a 6-issue limited series' }
    ],
    activities: ['Expand issue 1 into a panel-by-panel script', 'Design a cover concept', 'Write character visual prompts for image generation'],
    response: {
      json_schema: {
        type: 'object',
        required: ['logline', 'world', 'cast', 'beats'],
        properties: {
          logline: { type: 'string' },
          world: { type: 'string', description: 'Setting bible: rules, factions, central tension.' },
          cast: {
            type: 'array',
            items: {
              type: 'object',
              required: ['name', 'role', 'visualSignature'],
              properties: {
                name: { type: 'string' },
                role: { type: 'string' },
                want: { type: 'string' },
                need: { type: 'string' },
                visualSignature: { type: 'string', description: 'Consistent visual identity for panels.' }
              }
            }
          },
          beats: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    author: AUTHOR
  },
  {
    version: RECIPE_SCHEMA_VERSION,
    id: 'panel-script-from-beat',
    title: 'Panel Script From Beat',
    description: 'Turn a single story beat into a shot-listed, panel-by-panel comic script with art + dialogue.',
    instructions:
      'You are a comics writer. Break the beat below into {{ panels | default("4-6") }} panels for a single page. ' +
      'For each panel give: SHOT (wide/medium/close/insert), ART (what we see — staging, expression, lighting; ' +
      'keep character designs consistent), and DIALOGUE/CAPTION. Honor the established tone and keep continuity ' +
      'with what came before. Be filmable and concrete.\n\nBeat: {{ beat }}\nSeries context: {{ context | default("(none provided)") }}',
    parameters: [
      { key: 'beat', input_type: 'string', requirement: 'required', description: 'The story beat to dramatize.' },
      { key: 'context', input_type: 'string', requirement: 'optional', description: 'Cast/world context for continuity.' },
      { key: 'panels', input_type: 'string', requirement: 'optional', default: '4-6' }
    ],
    activities: ['Generate image prompts for each panel', 'Tighten the dialogue', 'Suggest a page layout'],
    author: AUTHOR
  },
  {
    version: RECIPE_SCHEMA_VERSION,
    id: 'world-consistency-audit',
    title: 'World Consistency Audit',
    description: 'Audit a story bundle for continuity breaks: character, world-rule, and timeline contradictions.',
    instructions:
      'You are a continuity editor. Audit the material below for inconsistencies: character traits/designs that ' +
      'drift, world rules that contradict each other, timeline/causality errors, and naming inconsistencies. ' +
      'Return a prioritized list — each item: what breaks, where, and the smallest fix that restores consistency. ' +
      'Be precise; do not invent problems that are not in the text.\n\nMaterial:\n{{ material }}',
    parameters: [
      { key: 'material', input_type: 'string', requirement: 'required', description: 'The story bible / script / panels to audit.' }
    ],
    activities: ['Apply the highest-priority fixes', 'Produce a clean canon summary'],
    author: AUTHOR
  },
  {
    version: RECIPE_SCHEMA_VERSION,
    id: 'ship-ready-feature',
    title: 'Ship-Ready Feature',
    description: 'Implement a small, self-contained app or feature as complete, runnable code.',
    instructions:
      'You are a senior engineer. Build exactly what is asked as complete, production-quality, runnable code — ' +
      'no placeholders, no truncation. When it is a multi-file app, call generate_app with every file fully ' +
      "written. Stack preference: {{ stack | default('React + TypeScript') }}. Use web_search only if you need " +
      'current API/package details. Write the code first, then a short note on key decisions.',
    prompt: 'Build: {{ spec }}',
    tools: ['generate_app', 'web_search'],
    parameters: [
      { key: 'spec', input_type: 'string', requirement: 'required', description: 'What to build.' },
      { key: 'stack', input_type: 'string', requirement: 'optional', default: 'React + TypeScript' }
    ],
    activities: ['Add tests', 'Explain the architecture', 'Make it responsive'],
    author: AUTHOR
  },
  {
    version: RECIPE_SCHEMA_VERSION,
    id: 'market-pulse',
    title: 'Market Pulse',
    description: 'Assemble a live markets terminal — focus quote, index ribbon, watchlist, sector heatmap and news.',
    swarm: true,
    agents: ['finance'],
    instructions:
      'Build a live market terminal. Focus ticker: {{ focus | default("^GSPC") }}. ' +
      'Watchlist: {{ watchlist | default("AAPL, MSFT, NVDA, AMZN, GOOGL") }}. ' +
      'Use build_finance_terminal for the dashboard, then add a short, insightful read (breadth, leaders vs ' +
      'laggards, what the news explains). Every figure must come from a live tool call — never from memory.',
    prompt: 'Give me a market pulse on {{ focus | default("the S&P 500") }} and my watchlist.',
    parameters: [
      { key: 'focus', input_type: 'string', requirement: 'optional', description: 'Focus ticker (e.g. NVDA or ^GSPC).', default: '^GSPC' },
      { key: 'watchlist', input_type: 'string', requirement: 'optional', default: 'AAPL, MSFT, NVDA, AMZN, GOOGL' }
    ],
    activities: ['Zoom into the biggest mover', "What's driving the leaders?", 'Compare to last week'],
    author: AUTHOR
  },
  {
    version: RECIPE_SCHEMA_VERSION,
    id: 'self-retrospective',
    title: 'Agent Self-Retrospective',
    description: 'Review a completed run, score it, and propose a reusable recipe + durable learnings — the self-improvement loop.',
    instructions:
      'You are a meta-agent improving the system. Given a completed run (goal + transcript + outcome), do three ' +
      'things and return them as JSON: (1) score the run 0–1 on whether it fully achieved the goal, with a one-' +
      'line justification; (2) extract durable LEARNINGS — concise, reusable lessons that would make the next ' +
      'similar run better; (3) if the run represents a repeatable workflow, propose a RECIPE (title, description, ' +
      'instructions with {{parameters}}, and the parameter list) that captures it so it can be re-run later. Be ' +
      'honest: if the run was weak, say so and focus the learnings on what to change.\n\n' +
      'Goal: {{ goal }}\n\nTranscript / outcome:\n{{ transcript }}',
    parameters: [
      { key: 'goal', input_type: 'string', requirement: 'required', description: 'What the run was trying to do.' },
      { key: 'transcript', input_type: 'string', requirement: 'required', description: 'The run transcript / final output.' }
    ],
    response: {
      json_schema: {
        type: 'object',
        required: ['score', 'justification', 'learnings'],
        properties: {
          score: { type: 'number' },
          justification: { type: 'string' },
          learnings: { type: 'array', items: { type: 'string' } },
          proposedRecipe: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              description: { type: 'string' },
              instructions: { type: 'string' },
              parameters: { type: 'array', items: { type: 'object' } }
            }
          }
        }
      }
    },
    activities: ['Save the proposed recipe', 'Apply the learnings to my profile'],
    author: AUTHOR
  }
];

/** The built-in recipes, re-sanitized so they obey the live tool/agent allowlist. */
export const BUILTIN_RECIPES: Recipe[] = RAW.map((r) => sanitizeRecipe(r, r.id)).filter((r): r is Recipe => r !== null);

export const getBuiltinRecipe = (id: string): Recipe | undefined =>
  BUILTIN_RECIPES.find((r) => r.id === id);

/** Compact catalog for a planner / model to pick a recipe from. */
export const recipeCatalogLine = (r: Recipe): string => `- ${r.id}: ${r.title} — ${r.description}`;
