import { StoryMood } from '../types';

/**
 * Deterministic story-mood classifier.
 *
 * The pipeline used to lose the story's emotional tone entirely: script analysis is
 * style-neutral, the style suggester just asked for "something creative", and the
 * recommended styles were a fixed list skewed toward dark/dystopian looks — so a happy
 * story would routinely come back dark and moody. This reads the script (weighting the
 * author's creative direction heavily) into a mood profile that drives:
 *   - which preset styles we recommend,
 *   - the AI style-suggestion instruction,
 *   - a lighting/palette guardrail injected into every image prompt.
 *
 * It is intentionally a pure, dependency-free heuristic: fast, offline, testable, and
 * re-derivable from the script for later analysis (no model call needed).
 *
 * Style ids referenced here are the preset ids in components/steps/StyleSelection.tsx.
 */

interface MoodDef {
  key: string;
  label: string;
  brightness: StoryMood['brightness'];
  energy: StoryMood['energy'];
  palette: string;
  lighting: string;
  promptGuidance: string;
  recommendedStyleIds: string[];
  /** Lower-cased keywords; matched on word boundaries. */
  keywords: string[];
}

// Order matters only as a stable tiebreaker (earlier wins on equal score).
const MOODS: MoodDef[] = [
  {
    key: 'bright_joyful',
    label: 'Bright & Joyful',
    brightness: 'bright',
    energy: 'high',
    palette: 'warm, sunny, saturated colours',
    lighting: 'bright, soft natural daylight',
    promptGuidance: 'Overall mood is upbeat and joyful: use a warm, bright, saturated palette with cheerful natural lighting. Avoid grim, desaturated, noir, or oppressive tones.',
    recommendedStyleIds: ['webtoon', 'ligne-claire', 'western-comic', 'watercolor', 'retrofuturism'],
    keywords: ['happy', 'happiness', 'joy', 'joyful', 'cheer', 'cheerful', 'delight', 'celebrat', 'festival', 'party', 'laugh', 'laughter', 'smile', 'smiling', 'fun', 'playful', 'sunny', 'sunshine', 'bright', 'hope', 'hopeful', 'uplifting', 'wholesome', 'friendship', 'friends', 'triumph', 'victory', 'win', 'wonderful', 'delightful', 'warm', 'optimis']
  },
  {
    key: 'whimsical',
    label: 'Whimsical & Playful',
    brightness: 'bright',
    energy: 'neutral',
    palette: 'soft pastels, candy colours',
    lighting: 'soft, even, storybook lighting',
    promptGuidance: 'Mood is whimsical and lighthearted: soft pastel palette, gentle even lighting, a storybook feel. Avoid dark, gritty, or menacing tones.',
    recommendedStyleIds: ['watercolor', 'webtoon', 'chalk-pastel', 'ligne-claire', 'retrofuturism'],
    keywords: ['whimsical', 'magical', 'magic', 'fairy', 'fairytale', 'wonder', 'silly', 'goofy', 'cartoon', 'childhood', 'kid', 'kids', 'children', 'toy', 'candy', 'dream', 'dreamy', 'quirky', 'cozy', 'cute', 'adorable']
  },
  {
    key: 'romantic',
    label: 'Romantic & Tender',
    brightness: 'bright',
    energy: 'calm',
    palette: 'warm, soft, blush tones',
    lighting: 'soft golden-hour lighting',
    promptGuidance: 'Mood is romantic and tender: warm soft palette with gentle golden-hour lighting. Avoid harsh contrast or grim tones.',
    recommendedStyleIds: ['watercolor', 'webtoon', 'chalk-pastel', 'ligne-claire'],
    keywords: ['love', 'romance', 'romantic', 'kiss', 'lover', 'beloved', 'heart', 'tender', 'affection', 'wedding', 'date', 'embrace', 'sweetheart', 'crush', 'longing']
  },
  {
    key: 'adventure_epic',
    label: 'Epic & Adventurous',
    brightness: 'neutral',
    energy: 'high',
    palette: 'vivid, bold, cinematic colours',
    lighting: 'dramatic but clear high-key lighting',
    promptGuidance: 'Mood is epic and adventurous: vivid, bold, cinematic colour with dramatic yet clear lighting. Heroic scale, not grim or washed-out.',
    recommendedStyleIds: ['western-comic', 'mythic-icon', 'retrofuturism', 'ligne-claire', 'indian-miniature'],
    keywords: ['adventure', 'quest', 'journey', 'hero', 'heroic', 'epic', 'legend', 'legendary', 'explore', 'discovery', 'treasure', 'voyage', 'destiny', 'champion', 'kingdom', 'myth']
  },
  {
    key: 'tense_action',
    label: 'Tense & Action-Packed',
    brightness: 'neutral',
    energy: 'high',
    palette: 'high-contrast, punchy colours',
    lighting: 'dynamic, high-contrast lighting',
    promptGuidance: 'Mood is tense and action-driven: punchy high-contrast colour and dynamic lighting with strong motion. Energetic, not murky.',
    recommendedStyleIds: ['western-comic', 'manga-bw', 'cyberpunk', 'dieselpunk', 'noir'],
    keywords: ['fight', 'battle', 'war', 'chase', 'explos', 'gun', 'attack', 'combat', 'race', 'escape', 'danger', 'enemy', 'soldier', 'weapon', 'clash', 'showdown', 'hunt', 'pursuit', 'crash', 'strike']
  },
  {
    key: 'horror',
    label: 'Dark Horror',
    brightness: 'dark',
    energy: 'high',
    palette: 'desaturated with sickly accents',
    lighting: 'low-key, deep shadows',
    promptGuidance: 'Mood is dark horror: desaturated palette with deep shadows and unsettling low-key lighting. Tension and dread are intended here.',
    recommendedStyleIds: ['noir', 'ink-wash', 'woodcut', 'brutalist'],
    keywords: ['horror', 'terror', 'nightmare', 'monster', 'demon', 'ghost', 'haunt', 'blood', 'gore', 'corpse', 'undead', 'zombie', 'evil', 'cursed', 'dread', 'scream', 'creepy', 'sinister', 'macabre', 'possess']
  },
  {
    key: 'dark_somber',
    label: 'Dark & Somber',
    brightness: 'dark',
    energy: 'calm',
    palette: 'muted, desaturated, cold tones',
    lighting: 'low, overcast, shadowed lighting',
    promptGuidance: 'Mood is somber and heavy: muted, desaturated, cool palette with low overcast lighting. A grim, melancholy tone is intended.',
    recommendedStyleIds: ['ink-wash', 'noir', 'brutalist', 'woodcut', 'chalk-pastel'],
    keywords: ['death', 'die', 'dead', 'grief', 'mourn', 'funeral', 'tragedy', 'tragic', 'despair', 'hopeless', 'suffer', 'pain', 'loss', 'betray', 'dystop', 'oppress', 'ruin', 'decay', 'apocalyp', 'bleak', 'grim', 'sorrow', 'lonely', 'abandon']
  },
  {
    key: 'mysterious',
    label: 'Mysterious & Noir',
    brightness: 'dark',
    energy: 'neutral',
    palette: 'shadowy, limited palette with accents',
    lighting: 'moody, directional, pools of light',
    promptGuidance: 'Mood is mysterious and noir: shadowy limited palette with moody directional lighting and pools of light. Intrigue and shadow are intended.',
    recommendedStyleIds: ['noir', 'ink-wash', 'chalk-pastel', 'brutalist'],
    keywords: ['mystery', 'mysterious', 'detective', 'crime', 'murder', 'clue', 'secret', 'investigat', 'noir', 'shadow', 'conspiracy', 'suspect', 'vanish', 'disappear', 'stalk', 'whisper']
  },
  {
    key: 'melancholic',
    label: 'Wistful & Melancholic',
    brightness: 'neutral',
    energy: 'calm',
    palette: 'muted, soft, cool pastels',
    lighting: 'soft, diffuse, overcast lighting',
    promptGuidance: 'Mood is wistful and reflective: muted soft cool palette with gentle diffuse lighting. Quietly emotional, not harsh or grim.',
    recommendedStyleIds: ['watercolor', 'ink-wash', 'chalk-pastel', 'ligne-claire'],
    keywords: ['memory', 'memories', 'nostalg', 'wistful', 'melanchol', 'bitterswe', 'longing', 'rain', 'autumn', 'farewell', 'goodbye', 'remember', 'fading', 'quiet', 'gentle', 'reflect']
  },
  {
    key: 'futuristic',
    label: 'Futuristic & Tech',
    brightness: 'neutral',
    energy: 'high',
    palette: 'cool neons and chrome',
    lighting: 'glowing artificial light',
    promptGuidance: 'Mood is sleek and futuristic: cool palette with glowing neon/artificial light and high-tech surfaces.',
    recommendedStyleIds: ['cyberpunk', 'retrofuturism', 'dieselpunk', 'mythic-icon', 'western-comic'],
    keywords: ['robot', 'cyber', 'android', 'spaceship', 'space', 'galaxy', 'alien', 'neon', 'futur', 'tech', 'machine', 'ai ', 'hologram', 'mech', 'laser', 'orbit', 'planet', 'station']
  }
];

const NEUTRAL: MoodDef = {
  key: 'balanced',
  label: 'Balanced',
  brightness: 'neutral',
  energy: 'neutral',
  palette: 'balanced, natural colours',
  lighting: 'natural, even lighting',
  promptGuidance: 'Keep a balanced, natural palette and lighting that fits the scene as written — do not push toward dark/moody unless the scene calls for it.',
  recommendedStyleIds: ['ligne-claire', 'western-comic', 'webtoon', 'ink-wash', 'watercolor'],
  keywords: []
};

const countMatches = (haystack: string, keyword: string): number => {
  // Some keywords are stems (e.g. "celebrat", "explos") so we match a prefix at a word
  // boundary rather than a whole word.
  const re = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g');
  const m = haystack.match(re);
  return m ? m.length : 0;
};

/**
 * Classify a story's mood from its script text. The author's creative direction (when
 * present) is weighted ~3x because it's the clearest statement of intent.
 */
export const classifyStoryMood = (script?: string, creativeDirection?: string): StoryMood => {
  const base = ` ${(script || '').toLowerCase()} `;
  const intent = ` ${(creativeDirection || '').toLowerCase()} `;
  // Weight creative direction by repeating it.
  const haystack = `${base} ${intent} ${intent} ${intent}`;

  let best: MoodDef = NEUTRAL;
  let bestScore = 0;
  let totalScore = 0;

  for (const mood of MOODS) {
    let score = 0;
    for (const kw of mood.keywords) score += countMatches(haystack, kw);
    totalScore += score;
    if (score > bestScore) {
      bestScore = score;
      best = mood;
    }
  }

  const chosen = bestScore > 0 ? best : NEUTRAL;
  // Confidence: how dominant the winning mood is, capped sensibly.
  const confidence = totalScore > 0
    ? Math.min(1, Number((bestScore / totalScore).toFixed(2)) * (bestScore >= 3 ? 1 : 0.7))
    : 0;

  const summary = bestScore > 0
    ? `Detected a ${chosen.label.toLowerCase()} tone (${chosen.brightness} palette, ${chosen.energy} energy).`
    : 'No strong mood signal — using a balanced, neutral look.';

  return {
    key: chosen.key,
    label: chosen.label,
    brightness: chosen.brightness,
    energy: chosen.energy,
    palette: chosen.palette,
    lighting: chosen.lighting,
    promptGuidance: chosen.promptGuidance,
    recommendedStyleIds: [...chosen.recommendedStyleIds],
    summary,
    confidence
  };
};

/** A compact one-liner for injecting into a model instruction / prompt. */
export const moodHintLine = (mood: StoryMood): string =>
  `${mood.label} — palette: ${mood.palette}; lighting: ${mood.lighting}.`;
