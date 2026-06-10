// Slash-command "skills" for the chat composer — the goose-style way to invoke a
// recipe by typing `/research fusion energy` instead of describing it. Each skill maps
// a short command (+ the free text after it) to a built-in recipe and the parameter
// values to run it with. The composer shows a live menu as you type `/`, and the run is
// streamed back into the conversation via /api/recipes/run.
//
// Curation rule: every skill is a real feature with its own backing recipe — no thin
// parameter presets. (The old /deepresearch, /science and /stock variants were folded
// into /research and /market: `research` now reads depth cues like "deep …" from the
// argument itself, and `market` takes the ticker directly.)
//
// Adding a skill is a single entry here.

export type SkillCategory = 'create' | 'research' | 'learn' | 'life' | 'build';

export interface ChatSkill {
  /** Canonical command typed after `/` (lowercase, no spaces). */
  command: string;
  /** Extra commands that resolve to the same skill. */
  aliases?: string[];
  label: string;
  description: string;
  /** A simple glyph shown in the menu (kept dependency-free). */
  emoji: string;
  /** Which shelf the skill sits on (Skills page sections, menu badge). */
  category: SkillCategory;
  /** The built-in recipe id this skill runs. */
  recipeId: string;
  /** Human name of the main argument (used as the input hint). */
  argName: string;
  /** Whether the skill needs text after the command to run. */
  argRequired: boolean;
  /** Turn the free text after the command into recipe parameter values. */
  buildValues: (arg: string) => Record<string, unknown>;
}

/** Display order + labels for the Skills page sections. */
export const SKILL_CATEGORIES: { id: SkillCategory; label: string }[] = [
  { id: 'create', label: 'Create' },
  { id: 'research', label: 'Research' },
  { id: 'learn', label: 'Learn' },
  { id: 'life', label: 'Life' },
  { id: 'build', label: 'Build' }
];

export const CHAT_SKILLS: ChatSkill[] = [
  {
    command: 'learn',
    aliases: ['course', 'teach', 'study'],
    label: 'Guided learning',
    description: 'Turn any topic into a progress-tracked course — modules, lessons, hands-on practice, quiz checkpoints',
    emoji: '🎓',
    category: 'learn',
    recipeId: 'guided-learning-course',
    argName: 'topic',
    argRequired: true,
    buildValues: (arg) => ({ topic: arg })
  },
  {
    command: 'trip',
    aliases: ['travel', 'itinerary', 'vacation'],
    label: 'Trip planner',
    description: 'A researched day-by-day itinerary with live map, real weather, budget in local currency & packing list',
    emoji: '🧳',
    category: 'life',
    recipeId: 'travel-planner',
    argName: 'destination (e.g. "Tokyo, 5 days")',
    argRequired: true,
    buildValues: (arg) => {
      // "Tokyo, 5 days" / "5 days in Tokyo" → destination + days
      const m = arg.match(/(\d+)\s*(?:days?|d)\b/i);
      const destination = arg
        .replace(/(\d+)\s*(?:days?|d)\b/i, '')
        .replace(/\b(in|for|to)\b/gi, ' ')
        .replace(/[,·]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return { destination: destination || arg, ...(m ? { days: m[1] } : {}) };
    }
  },
  {
    command: 'research',
    aliases: ['deepresearch', 'deep', 'dr', 'investigate'],
    label: 'Deep research',
    description: 'Multi-agent investigation that reads real sources → a cited, decision-ready brief. Say "deep …" for the exhaustive dossier',
    emoji: '🔬',
    category: 'research',
    recipeId: 'deep-research-brief',
    argName: 'topic (prefix "deep" or "quick" to set depth)',
    argRequired: true,
    buildValues: (arg) => {
      // Depth cues live in the argument: "/research deep dive on fusion" → exhaustive,
      // "/research quick look at fusion" → quick. Default stays 'standard'.
      const DEEP = /^(?:deep(?:[\s-]?dive)?|deeply|exhaustive(?:ly)?|thorough(?:ly)?|comprehensive|in[\s-]?depth)\b[:,]?\s*/i;
      const QUICK = /^(?:quick(?:ly)?|brief(?:ly)?|fast)\b[:,]?\s*/i;
      let topic = arg.trim();
      let depth: 'quick' | 'standard' | 'exhaustive' = 'standard';
      if (DEEP.test(topic)) {
        depth = 'exhaustive';
        topic = topic.replace(DEEP, '');
      } else if (QUICK.test(topic)) {
        depth = 'quick';
        topic = topic.replace(QUICK, '');
      }
      if (depth !== 'standard') {
        // Strip the leftover connector: "deep research on X" → "X", "quick look at Y" → "Y".
        topic = topic.replace(/^(?:research|dive|dig|look)?\s*(?:into|on|about|at)\s+/i, '').trim();
      }
      return { topic: topic || arg.trim(), depth };
    }
  },
  {
    command: 'market',
    aliases: ['markets', 'stock', 'stocks', 'ticker', 'quote', 'finance', 'financial'],
    label: 'Market pulse',
    description: 'A live markets terminal — focus quote, index ribbon, watchlist, sector heatmap & the news behind the moves',
    emoji: '📈',
    category: 'research',
    recipeId: 'market-pulse',
    argName: 'ticker (optional, e.g. NVDA)',
    argRequired: false,
    buildValues: (arg) => (arg ? { focus: arg.trim() } : {})
  },
  {
    command: 'comic',
    aliases: ['concept', 'series'],
    label: 'Comic concept forge',
    description: 'Forge a complete series concept — logline, world bible, cast with consistent visual signatures, first-arc beats',
    emoji: '💥',
    category: 'create',
    recipeId: 'comic-concept-forge',
    argName: 'premise',
    argRequired: true,
    buildValues: (arg) => ({ premise: arg })
  },
  {
    command: 'script',
    aliases: ['panels', 'page'],
    label: 'Panel script',
    description: 'Direct a story beat into a shot-listed page — SHOT, ART and DIALOGUE for every panel, continuity kept',
    emoji: '🎬',
    category: 'create',
    recipeId: 'panel-script-from-beat',
    argName: 'beat',
    argRequired: true,
    buildValues: (arg) => ({ beat: arg })
  },
  {
    command: 'audit',
    aliases: ['consistency', 'continuity'],
    label: 'Continuity audit',
    description: 'Hunt down continuity breaks — character drift, contradicted world rules, timeline errors — each with its smallest fix',
    emoji: '🔎',
    category: 'create',
    recipeId: 'world-consistency-audit',
    argName: 'material to audit',
    argRequired: true,
    buildValues: (arg) => ({ material: arg })
  },
  {
    command: 'build',
    aliases: ['app', 'code', 'ship'],
    label: 'Ship a feature',
    description: 'Implement a small app or feature as complete, runnable code — full files, no placeholders, notes on key decisions',
    emoji: '⚙️',
    category: 'build',
    recipeId: 'ship-ready-feature',
    argName: 'spec',
    argRequired: true,
    buildValues: (arg) => ({ spec: arg })
  }
];

const byName = new Map<string, ChatSkill>();
for (const s of CHAT_SKILLS) {
  byName.set(s.command, s);
  for (const a of s.aliases || []) byName.set(a, s);
}

export const findSkill = (command: string): ChatSkill | undefined =>
  byName.get(command.trim().toLowerCase());

/** True while the user is typing a command (a leading `/` with no space yet). */
export const isSlashQuery = (text: string): boolean => /^\/[a-zA-Z]*$/.test(text);

/** The partial command being typed (chars after `/`, before any space). */
export const slashQuery = (text: string): string => (isSlashQuery(text) ? text.slice(1).toLowerCase() : '');

/** Skills whose command/alias/label match the partial query (for the menu). */
export const filterSkills = (query: string): ChatSkill[] => {
  const q = query.trim().toLowerCase();
  if (!q) return CHAT_SKILLS;
  const hit = (s: ChatSkill) =>
    s.command.startsWith(q) ||
    (s.aliases || []).some((a) => a.startsWith(q)) ||
    s.label.toLowerCase().includes(q);
  // Prefix matches on the command rank first.
  return CHAT_SKILLS.filter(hit).sort((a, b) => Number(b.command.startsWith(q)) - Number(a.command.startsWith(q)));
};

/** Parse a full composer string `/command rest...` into a skill + its argument. */
export const parseSkillInput = (text: string): { skill: ChatSkill; arg: string } | null => {
  const m = text.match(/^\/([a-zA-Z]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const skill = findSkill(m[1]);
  if (!skill) return null;
  return { skill, arg: (m[2] || '').trim() };
};
