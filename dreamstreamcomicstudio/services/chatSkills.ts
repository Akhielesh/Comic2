// Slash-command "skills" for the chat composer — the goose-style way to invoke a
// recipe by typing `/research fusion energy` instead of describing it. Each skill maps
// a short command (+ the free text after it) to a built-in recipe and the parameter
// values to run it with. The composer shows a live menu as you type `/`, and the run is
// streamed back into the conversation via /api/recipes/run.
//
// Adding a skill is a single entry here.

export interface ChatSkill {
  /** Canonical command typed after `/` (lowercase, no spaces). */
  command: string;
  /** Extra commands that resolve to the same skill. */
  aliases?: string[];
  label: string;
  description: string;
  /** A simple glyph shown in the menu (kept dependency-free). */
  emoji: string;
  /** The built-in recipe id this skill runs. */
  recipeId: string;
  /** Human name of the main argument (used as the input hint). */
  argName: string;
  /** Whether the skill needs text after the command to run. */
  argRequired: boolean;
  /** Turn the free text after the command into recipe parameter values. */
  buildValues: (arg: string) => Record<string, unknown>;
}

export const CHAT_SKILLS: ChatSkill[] = [
  {
    command: 'research',
    label: 'Research',
    description: 'Multi-agent research → a sourced brief',
    emoji: '🔬',
    recipeId: 'deep-research-brief',
    argName: 'topic',
    argRequired: true,
    buildValues: (arg) => ({ topic: arg, depth: 'standard' })
  },
  {
    command: 'deepresearch',
    aliases: ['deep', 'dr'],
    label: 'Deep research',
    description: 'Exhaustive multi-agent research dossier',
    emoji: '🧠',
    recipeId: 'deep-research-brief',
    argName: 'topic',
    argRequired: true,
    buildValues: (arg) => ({ topic: arg, depth: 'exhaustive' })
  },
  {
    command: 'science',
    label: 'Science',
    description: 'Technical/scientific deep-dive with sources',
    emoji: '⚗️',
    recipeId: 'deep-research-brief',
    argName: 'topic',
    argRequired: true,
    buildValues: (arg) => ({ topic: arg, audience: 'a scientific / technical reader', depth: 'exhaustive' })
  },
  {
    command: 'market',
    aliases: ['markets', 'financial', 'finance'],
    label: 'Market pulse',
    description: 'Live markets terminal: quote · indices · watchlist · heatmap · news',
    emoji: '📈',
    recipeId: 'market-pulse',
    argName: 'focus ticker (optional)',
    argRequired: false,
    buildValues: (arg) => (arg ? { focus: arg } : {})
  },
  {
    command: 'stock',
    aliases: ['ticker', 'quote'],
    label: 'Stock',
    description: 'Deep-dive a single ticker with live data',
    emoji: '💹',
    recipeId: 'market-pulse',
    argName: 'ticker',
    argRequired: true,
    buildValues: (arg) => ({ focus: arg, watchlist: arg })
  },
  {
    command: 'comic',
    label: 'Comic concept',
    description: 'Forge a comic concept: logline · world · cast · beats',
    emoji: '💥',
    recipeId: 'comic-concept-forge',
    argName: 'premise',
    argRequired: true,
    buildValues: (arg) => ({ premise: arg })
  },
  {
    command: 'script',
    aliases: ['panels'],
    label: 'Panel script',
    description: 'Turn a beat into a panel-by-panel comic script',
    emoji: '🎬',
    recipeId: 'panel-script-from-beat',
    argName: 'beat',
    argRequired: true,
    buildValues: (arg) => ({ beat: arg })
  },
  {
    command: 'audit',
    aliases: ['consistency'],
    label: 'Consistency audit',
    description: 'Find continuity breaks in a story bundle',
    emoji: '🔎',
    recipeId: 'world-consistency-audit',
    argName: 'material',
    argRequired: true,
    buildValues: (arg) => ({ material: arg })
  },
  {
    command: 'build',
    aliases: ['app', 'code'],
    label: 'Build',
    description: 'Implement a small app/feature as runnable code',
    emoji: '⚙️',
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
