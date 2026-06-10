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
    id: 'guided-learning-course',
    title: 'Guided Learning Course',
    description: 'Design a complete, progress-tracked course on any topic — modules, lessons, practice and checkpoints.',
    swarm: false,
    agents: [],
    instructions:
      'Design a guided learning course on: {{ topic }}. Learner level: {{ level | default("beginner") }}. ' +
      'Time budget: {{ timeframe | default("2 weeks, ~30 min/day") }}.\n' +
      'First, briefly assess what mastering this topic requires. Then call create_learning_path with 3–6 modules of ' +
      '3–6 steps each: rich markdown lessons in read steps, hands-on practice steps, and quiz/flashcards checkpoints ' +
      'with a ready-to-send `prompt` (e.g. "Quiz me on module 2 of {{ topic }}"). Make outcomes concrete and the ' +
      'pacing realistic for the time budget. After the tool call, add a short paragraph on how to use the course.',
    prompt: 'Teach me {{ topic }} — build me a guided course.',
    parameters: [
      { key: 'topic', input_type: 'string', requirement: 'required', description: 'What to learn.' },
      { key: 'level', input_type: 'select', requirement: 'optional', description: 'Starting level.', default: 'beginner', options: ['beginner', 'intermediate', 'advanced'] },
      { key: 'timeframe', input_type: 'string', requirement: 'optional', description: 'Time budget, e.g. "1 month, 1h/day".', default: '2 weeks, ~30 min/day' }
    ],
    activities: ['Start module 1 with me now', 'Quiz me on the first module', 'Adapt the course to weekends only'],
    author: AUTHOR
  },
  {
    version: RECIPE_SCHEMA_VERSION,
    id: 'travel-planner',
    title: 'Travel Planner',
    description: 'Plan a complete trip — researched day-by-day itinerary with live map, weather, budget and packing list.',
    swarm: false,
    agents: [],
    instructions:
      'Plan a trip to {{ destination }} for {{ days | default("3") }} days. Style: {{ style | default("balanced") }}. ' +
      'Budget hint: {{ budget | default("mid-range") }}.\n' +
      'Ground the plan in live data first: use get_weather for the destination and find_places for standout food and ' +
      'sights. Then call plan_trip with realistic days (logical geography, opening hours, 3–6 stops/day with times and ' +
      'short notes), budget lines in the local currency, useful tips and a packing list informed by the live forecast. ' +
      'After the tool call, summarize the trip in 2–3 sentences and flag anything to book early.',
    prompt: 'Plan {{ days | default("3") }} days in {{ destination }}.',
    parameters: [
      { key: 'destination', input_type: 'string', requirement: 'required', description: 'Where to go, e.g. "Tokyo".' },
      { key: 'days', input_type: 'string', requirement: 'optional', description: 'Trip length in days.', default: '3' },
      { key: 'style', input_type: 'select', requirement: 'optional', description: 'Travel style.', default: 'balanced', options: ['balanced', 'foodie', 'culture', 'outdoors', 'family', 'budget', 'luxury'] },
      { key: 'budget', input_type: 'string', requirement: 'optional', description: 'Budget hint, e.g. "$1500 total".', default: 'mid-range' }
    ],
    activities: ['Swap day 2 for a day trip', 'Find me flights and a hotel shortlist', 'Make a kid-friendly version'],
    author: AUTHOR
  },
  {
    version: RECIPE_SCHEMA_VERSION,
    id: 'goal-coach',
    title: 'Goal Coach',
    description: 'Turn any goal into a tracked plan — target date, measurable metric, checkable milestones and this week\'s next actions.',
    swarm: false,
    agents: [],
    instructions:
      'You are a pragmatic goal coach. The user\'s goal: {{ goal }}. Timeframe hint: {{ timeframe | default("none given — infer a realistic one") }}.\n' +
      'First, restate the goal as one concrete, measurable outcome (pick the measurable yourself if the user was vague — distance, amount saved, words written). ' +
      'If the goal involves something verifiable (a race date, an exam syllabus, typical training plans), you may use web_search to ground the plan. ' +
      'Then call create_goal_tracker with: a sharp title, why it matters (from the user\'s words), a realistic targetDate, a cadence, the metric (start → target with unit), ' +
      '4–8 sequenced milestones (the FIRST startable today, each verifiable, with due dates spread across the timeframe), and 2–3 nextActions for this week. ' +
      'After the tool call, add 2–3 sentences: the single biggest risk to this goal and how the cadence beats it. No pep-talk filler.',
    prompt: 'Coach me on this goal: {{ goal }}',
    tools: ['create_goal_tracker', 'web_search'],
    parameters: [
      { key: 'goal', input_type: 'string', requirement: 'required', description: 'The goal in the user\'s words.' },
      { key: 'timeframe', input_type: 'string', requirement: 'optional', description: 'When they want it done, e.g. "by October".' }
    ],
    activities: ['Make the milestones easier', 'Add a weekly check-in plan', 'What should I do today?'],
    author: AUTHOR
  },
  {
    version: RECIPE_SCHEMA_VERSION,
    id: 'code-review',
    title: 'Code Review',
    description: 'Review code or a GitHub PR against the REAL diff — verdict card with severity-graded findings, file:line and suggested fixes.',
    swarm: false,
    agents: [],
    instructions:
      'You are a senior engineer doing a rigorous, kind code review. Focus: {{ focus | default("all") }}.\n' +
      'The review target is below. If it is a GitHub PR / commit URL (or "owner/repo#123"), you MUST call fetch_github_pr first and review the REAL diff it returns — ' +
      'never review a linked PR from memory. If it is pasted code/diff, review that text directly. Use web_search only to verify an API contract you are unsure about.\n' +
      'Review for correctness first (bugs, edge cases, races), then security, performance, tests and readability. Cite the actual file and line for every finding and ' +
      'propose the smallest concrete fix (as code) where you can. Be honest about severity — do not inflate nits.\n' +
      'Finish by calling render_code_review with: verdict (approve / approve-with-nits / request-changes), a 2–3 sentence summary, dimension scores, the findings ' +
      '(severity, title, detail, file, line, suggestion, category), diff stats when known, and at least one genuine positive. After the card, give your overall take in ≤2 sentences.\n\n' +
      'Review target:\n{{ target }}',
    prompt: 'Review this: {{ target }}',
    tools: ['fetch_github_pr', 'render_code_review', 'web_search'],
    parameters: [
      { key: 'target', input_type: 'string', requirement: 'required', description: 'Pasted code/diff, or a GitHub PR / commit URL.' },
      { key: 'focus', input_type: 'select', requirement: 'optional', description: 'What to weight most.', default: 'all', options: ['all', 'correctness', 'security', 'performance', 'readability', 'testing'] }
    ],
    activities: ['Apply the suggested fixes', 'Explain the most severe finding', 'Re-review after my changes'],
    author: AUTHOR
  },
  {
    version: RECIPE_SCHEMA_VERSION,
    id: 'live-monitor',
    title: 'Live Monitor',
    description: 'Loop one live-data widget on an interval — the card keeps refreshing itself on screen (stocks, weather, news, crypto, sentiment…).',
    swarm: false,
    agents: [],
    instructions:
      'Set up a live monitor for: {{ request }}. Refresh cadence: every {{ interval_sec | default("300") }} seconds.\n' +
      'Map the request to exactly ONE refreshable live-data tool and its args — get_stock {"symbol"} for an equity/index/commodity, crypto_price {"coin"} for a coin, ' +
      'get_weather {"location"}, get_news {"query"} or {"topic"}, get_ticker_tape {"symbols":[…]} for several tickers, get_market_sentiment {} for fear & greed, ' +
      'get_yield_curve {} for treasury yields, convert_currency {"from","to"} for an FX rate, build_portfolio {"holdings":[…]} for listed positions. ' +
      'Then call create_monitor with that tool, those args, intervalSec = {{ interval_sec | default("300") }}, and a short label like "NVDA · every 5 min". ' +
      'After the tool call, confirm what is being watched and the cadence in ONE sentence. If the request maps to no live tool, say so and suggest the closest watchable thing instead.',
    prompt: 'Monitor {{ request }} for me.',
    tools: ['create_monitor'],
    parameters: [
      { key: 'request', input_type: 'string', requirement: 'required', description: 'What to watch, e.g. "NVDA", "weather in Tokyo", "AI chip news".' },
      { key: 'interval_sec', input_type: 'number', requirement: 'optional', description: 'Refresh cadence in seconds (30–3600).', default: 300 }
    ],
    activities: ['Make it refresh faster', 'Monitor something else too', 'Stop after an hour — remind me'],
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
