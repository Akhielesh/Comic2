// Curated comic art styles. Each `spec` is written as art direction a page model can
// execute: medium, linework, color, shading and what to avoid. Generic phrases like
// "comic style" produce generic art, so every preset names concrete, drawable traits.
// The `swatch` gradient is a UI-only preview used before any image exists.
// Names, taglines and specs never name an artist, studio or brand (the library manifest lint
// and stylePresets.test.ts enforce it): presets describe drawable traits, not someone's IP.

import type { ColorMode, ComicDoc, ComicKind } from './doc.js';

export interface StylePreset {
  id: string;
  name: string;
  /** One-line pitch shown on the card. */
  tagline: string;
  spec: string;
  palette: string[];
  linework: string;
  avoid: string[];
  bestFor: string[];
  kind?: ComicKind;
  colorMode?: ColorMode;
  /** CSS gradient for the preset card before a rendered swatch exists. */
  swatch: string;
}

export const STYLE_PRESETS: StylePreset[] = [
  {
    id: 'modern-heroic',
    name: 'Modern heroic',
    tagline: 'Bold inks, dynamic anatomy, cinematic color',
    spec:
      'Modern American comic book art: confident inked contour lines with tapered brush weight, dynamic foreshortened poses, dramatic rim lighting, cel-shaded digital coloring with soft gradients on skin and metal, saturated but controlled palette, crisp spot blacks.',
    palette: ['#1d3557', '#e63946', '#f1faee', '#ffb703'],
    linework: 'Tapered brush inks, heavy spot blacks',
    avoid: ['photorealism', 'muddy colors', 'sketchy unfinished lines'],
    bestFor: ['action', 'superhero', 'sci-fi'],
    swatch: 'linear-gradient(135deg,#1d3557 0%,#e63946 60%,#ffb703 100%)'
  },
  {
    id: 'noir-ink',
    name: 'Noir ink',
    tagline: 'Stark black & white, rain-slick shadows',
    spec:
      'Hard-boiled noir comic art in high-contrast black and white: heavy chiaroscuro, large solid black shapes, venetian-blind light slashes, rain streaks, feathered hatching for midtones, expressive brush inks, no color except an optional single accent red.',
    palette: ['#0b0b0b', '#f5f5f0', '#9b1c1c'],
    linework: 'Heavy brush, feathering, crosshatching',
    avoid: ['full color', 'soft airbrushing', 'cute proportions'],
    bestFor: ['crime', 'mystery', 'thriller'],
    colorMode: 'bw',
    swatch: 'linear-gradient(135deg,#0b0b0b 0%,#3a3a3a 55%,#9b1c1c 100%)'
  },
  {
    id: 'ligne-claire',
    name: 'Ligne claire',
    tagline: 'Clean even lines, flat bright color, Franco-Belgian adventure feel',
    spec:
      'European ligne claire comic art: uniform clean black outlines of even weight, no hatching, flat bright colors with minimal shading, detailed realistic backgrounds with simplified expressive characters, clear readable staging.',
    palette: ['#2a6fdb', '#f4d35e', '#ee964b', '#f5f1e6'],
    linework: 'Uniform thin outlines, no hatching',
    avoid: ['gradients', 'heavy shadows', 'grunge textures'],
    bestFor: ['adventure', 'kids', 'travel'],
    swatch: 'linear-gradient(135deg,#2a6fdb 0%,#f4d35e 55%,#ee964b 100%)'
  },
  {
    id: 'manga-screentone',
    name: 'Manga',
    tagline: 'Black & white, screentones, expressive eyes',
    spec:
      'Japanese manga art in black and white: fine pen linework, screentone dot shading, speed lines and impact focus lines for motion, expressive large eyes with detailed highlights, dramatic close-ups, clean white backgrounds alternating with dense hatched environments.',
    palette: ['#111111', '#ffffff', '#9a9a9a'],
    linework: 'Fine G-pen lines, screentones, speed lines',
    avoid: ['full color', 'western superhero anatomy', 'painterly textures'],
    bestFor: ['drama', 'action', 'romance', 'slice of life'],
    kind: 'manga',
    colorMode: 'bw',
    swatch: 'linear-gradient(135deg,#111 0%,#777 50%,#eee 100%)'
  },
  {
    id: 'webtoon-cel',
    name: 'Webtoon',
    tagline: 'Soft cel shading, vibrant, made for scrolling',
    spec:
      'Korean webtoon art: clean thin lineart, soft cel shading with gentle airbrushed gradients, vibrant pastel-to-saturated palette, attractive stylized characters with glossy hair highlights, atmospheric lighting and bokeh backgrounds.',
    palette: ['#ff8fab', '#a2d2ff', '#cdb4db', '#fff1e6'],
    linework: 'Thin clean digital lines',
    avoid: ['heavy inks', 'crosshatching', 'gritty textures'],
    bestFor: ['romance', 'fantasy', 'slice of life'],
    kind: 'webtoon',
    swatch: 'linear-gradient(135deg,#ff8fab 0%,#cdb4db 50%,#a2d2ff 100%)'
  },
  {
    id: 'watercolor-storybook',
    name: 'Storybook watercolor',
    tagline: 'Warm washes, gentle pencil, cozy',
    spec:
      "Children's picture-book illustration: soft graphite pencil outlines, transparent watercolor washes with visible paper texture, warm cozy palette, rounded friendly character shapes, gentle natural light, generous negative space.",
    palette: ['#f2cc8f', '#81b29a', '#e07a5f', '#f4f1de'],
    linework: 'Soft pencil, loose',
    avoid: ['harsh blacks', 'neon colors', 'scary imagery'],
    bestFor: ['kids', 'fable', 'family'],
    kind: 'storybook',
    swatch: 'linear-gradient(135deg,#f2cc8f 0%,#81b29a 55%,#e07a5f 100%)'
  },
  {
    id: 'graphic-novel-painterly',
    name: 'Painterly graphic novel',
    tagline: 'Moody painted light, mature tone',
    spec:
      'Painted graphic-novel art: loose confident drawing under rich digital painting, visible brush strokes, cinematic moody lighting with strong color temperature contrast (warm lamps against cool shadows), grounded realistic proportions, atmospheric depth.',
    palette: ['#264653', '#2a9d8f', '#e9c46a', '#e76f51'],
    linework: 'Minimal lines, painted forms',
    avoid: ['flat cartoon colors', 'thick uniform outlines'],
    bestFor: ['drama', 'horror', 'literary', 'historical'],
    swatch: 'linear-gradient(135deg,#264653 0%,#2a9d8f 45%,#e76f51 100%)'
  },
  {
    id: 'retro-pop',
    name: 'Retro pop',
    tagline: '60s halftone dots, primary colors',
    spec:
      'Silver-age 1960s comic art: bold black outlines, Ben-Day halftone dot shading, limited primary palette (red, yellow, blue) on off-white newsprint, square-jawed classic proportions, punchy dramatic poses, slight print misregistration.',
    palette: ['#d62828', '#fcbf49', '#003049', '#f7ede2'],
    linework: 'Bold uniform outlines',
    avoid: ['gradients', 'modern digital glow', 'photo textures'],
    bestFor: ['parody', 'romance', 'retro adventure'],
    colorMode: 'limited',
    swatch: 'linear-gradient(135deg,#d62828 0%,#fcbf49 50%,#003049 100%)'
  },
  {
    id: 'cozy-anime',
    name: 'Cozy anime',
    tagline: 'Warm hand-painted anime-film feel, lush backgrounds',
    spec:
      'Warm hand-painted anime film look: simple clean character designs with soft shading, lush detailed painted backgrounds full of greenery and light, warm golden-hour palette, gentle wind and everyday magic, expressive but restrained faces.',
    palette: ['#90be6d', '#f9c74f', '#577590', '#f8f4e3'],
    linework: 'Clean thin lines, painted backgrounds',
    avoid: ['harsh shadows', 'gritty violence', 'neon cyberpunk'],
    bestFor: ['fantasy', 'slice of life', 'kids'],
    swatch: 'linear-gradient(135deg,#90be6d 0%,#f9c74f 55%,#577590 100%)'
  },
  {
    id: 'indie-risograph',
    name: 'Indie riso',
    tagline: 'Two-color risograph, grainy, artsy',
    spec:
      'Indie zine comic printed in two-color risograph: fluorescent pink and teal ink layers with visible grain and slight misregistration, simple expressive linework, flat shapes, playful exaggerated characters, lots of texture.',
    palette: ['#ff48b0', '#00838a', '#fdf6e3'],
    linework: 'Loose marker lines',
    avoid: ['full-color rendering', 'glossy digital shading'],
    bestFor: ['humor', 'personal stories', 'experimental'],
    colorMode: 'limited',
    swatch: 'linear-gradient(135deg,#ff48b0 0%,#fdf6e3 50%,#00838a 100%)'
  },
  {
    id: 'cartoon-strip',
    name: 'Cartoon strip',
    tagline: 'Newspaper funnies, clean gags',
    spec:
      'Classic newspaper cartoon strip: simple rounded cartoon characters with big expressive faces, clean even outlines, flat cheerful colors, minimal backgrounds that support the gag, clear acting and timing beats.',
    palette: ['#ffd166', '#06d6a0', '#118ab2', '#ef476f'],
    linework: 'Clean rounded outlines',
    avoid: ['realistic anatomy', 'dark grim lighting'],
    bestFor: ['humor', 'kids', 'strips'],
    kind: 'strip',
    swatch: 'linear-gradient(135deg,#ffd166 0%,#06d6a0 50%,#118ab2 100%)'
  },
  {
    id: 'dark-fantasy',
    name: 'Dark fantasy',
    tagline: 'Gothic detail, eerie glow, heavy atmosphere',
    spec:
      'Dark fantasy comic art: intricate gothic detail, heavy textured inks, desaturated palette with eerie glowing accents (sickly green, ember orange), dramatic silhouettes against fog, ornate armor and architecture, ominous low-angle compositions.',
    palette: ['#1b1b2f', '#4e4e6a', '#e43f5a', '#8ac926'],
    linework: 'Textured detailed inks',
    avoid: ['bright cheerful colors', 'cute proportions'],
    bestFor: ['horror', 'fantasy', 'mythology'],
    swatch: 'linear-gradient(135deg,#1b1b2f 0%,#4e4e6a 50%,#e43f5a 100%)'
  }
];

export const getStylePreset = (id?: string) => (id ? STYLE_PRESETS.find((p) => p.id === id) : undefined);

// ── Deterministic ranking (assets.md §9, contract §11.6) ─────────────────────
// `rankPresets` lets the director show a FREE `style_presets` card with the best-fitting looks
// without an LLM guess and without paid style renders. Pure, stable (ties keep catalogue order).

/** Words in a brief that point at a `bestFor` tag (lower-case; matched on word boundaries). */
const TAG_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  action: ['action', 'fight', 'battle', 'chase', 'martial'],
  superhero: ['superhero', 'super hero', 'hero', 'heroes', 'powers', 'villain', 'cape'],
  'sci-fi': ['sci-fi', 'scifi', 'science fiction', 'space', 'robot', 'robots', 'alien', 'aliens', 'future', 'cyber', 'cyberpunk'],
  crime: ['crime', 'heist', 'gangster', 'mob', 'murder', 'detective', 'noir'],
  mystery: ['mystery', 'whodunit', 'detective', 'clue', 'clues', 'case'],
  thriller: ['thriller', 'suspense', 'spy', 'conspiracy'],
  adventure: ['adventure', 'quest', 'journey', 'expedition', 'treasure', 'explore', 'exploring'],
  kids: ['kids', 'kid', 'children', 'child', 'toddler', 'toddlers', 'preschool', 'bedtime', 'picture book', 'nursery'],
  travel: ['travel', 'trip', 'road trip', 'voyage'],
  drama: ['drama', 'dramatic', 'family drama', 'coming of age'],
  romance: ['romance', 'romantic', 'love', 'crush', 'date', 'wedding'],
  'slice of life': ['slice of life', 'everyday', 'daily life', 'school', 'cozy', 'cosy', 'friendship'],
  fantasy: ['fantasy', 'gothic', 'dark fantasy', 'magic', 'magical', 'dragon', 'dragons', 'wizard', 'witch', 'elf', 'fairy', 'enchanted'],
  fable: ['fable', 'fairy tale', 'folk tale', 'moral', 'parable'],
  family: ['family', 'grandma', 'grandpa', 'grandmother', 'grandfather', 'parents', 'siblings'],
  horror: ['horror', 'scary', 'spooky', 'ghost', 'ghosts', 'monster', 'monsters', 'zombie', 'haunted', 'creepy'],
  literary: ['literary', 'memoir', 'introspective', 'poetic'],
  historical: ['historical', 'history', 'period', 'war', 'ancient', 'medieval', 'victorian'],
  parody: ['parody', 'satire', 'spoof'],
  'retro adventure': ['retro', 'pulp', 'vintage', '60s', '1960s'],
  humor: ['humor', 'humour', 'funny', 'comedy', 'gag', 'gags', 'joke', 'jokes', 'silly', 'comic relief'],
  'personal stories': ['personal', 'diary', 'autobiographical', 'my life', 'true story'],
  experimental: ['experimental', 'zine', 'art school', 'abstract'],
  strips: ['strip', 'strips', 'newspaper', 'four panel', '4-panel', 'webcomic'],
  mythology: ['myth', 'mythology', 'mythic', 'gods', 'legend', 'epic']
};

/** Audience words → the tags that suit it (young readers get gentle looks). */
const YOUNG_AUDIENCE_RE = /\b(kids?|child(?:ren)?|toddlers?|preschool(?:ers)?|bedtime|picture[- ]book|ages?\s*[1-8]\b|[1-8]\s*[-–]\s*[1-9]\b|family|young readers?)\b/i;
const YOUNG_TAGS = ['kids', 'family', 'fable'];
/** Presets whose look is too grim for very young readers (still allowed when asked for by name). */
const GRIM_FOR_KIDS = new Set(['noir-ink', 'dark-fantasy', 'graphic-novel-painterly']);

const lowerText = (...parts: Array<string | undefined>): string =>
  parts
    .filter((p): p is string => typeof p === 'string' && !!p.trim())
    .join(' \n ')
    .toLowerCase()
    .slice(0, 4000);

const hasWord = (text: string, word: string): boolean => {
  if (!text || !word) return false;
  const escaped = word.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(text);
};

/** Distinctive words of a preset's own name/id ("noir", "manga", "watercolor", "riso"…). */
const presetNameWords = (p: StylePreset): string[] =>
  [...new Set(`${p.id.replace(/-/g, ' ')} ${p.name}`.toLowerCase().split(/[^a-z0-9]+/))].filter(
    (w) => w.length >= 4 && !['style', 'modern', 'graphic', 'novel', 'cartoon', 'dark'].includes(w)
  );

/** Fit score of one preset for a doc (exported for tests and the director's summary line). */
export const presetFitScore = (p: StylePreset, doc: Pick<ComicDoc, 'brief' | 'format'>): number => {
  const brief = doc.brief || ({} as ComicDoc['brief']);
  const genre = lowerText(brief.genre, brief.tone);
  const audience = lowerText(brief.audience);
  const story = lowerText(brief.premise, brief.logline, brief.setting, ...(brief.themes || []), ...(brief.notes || []));
  let s = 0;
  if (p.kind && p.kind === doc.format?.kind) s += 4;
  for (const tag of p.bestFor) {
    const words = TAG_SYNONYMS[tag] || [tag];
    if (words.some((w) => hasWord(genre, w))) s += 3;
    else if (words.some((w) => hasWord(story, w))) s += 1;
    if (words.some((w) => hasWord(audience, w))) s += 3;
  }
  // The genre names the look itself ("noir thriller", "manga action", "watercolor fable").
  if (presetNameWords(p).some((w) => hasWord(genre, w) || hasWord(audience, w))) s += 3;
  const young = YOUNG_AUDIENCE_RE.test(audience) || YOUNG_AUDIENCE_RE.test(genre);
  if (young) {
    s += p.bestFor.filter((t) => YOUNG_TAGS.includes(t)).length * 2;
    if (GRIM_FOR_KIDS.has(p.id)) s -= 4;
  }
  const mode = doc.format?.colorMode;
  if (mode === 'bw') s += p.colorMode === 'bw' ? 3 : -2;
  else if (p.colorMode === 'bw') s -= 1;
  if (mode === 'limited' && p.colorMode === 'limited') s += 2;
  return s;
};

/**
 * Preset ids, best fit first, scored on `brief.genre`/`tone`, `brief.audience` and `format.kind`
 * (plus light hints from the premise). Deterministic and free: the director's `suggest_presets`
 * uses it instead of paid style options (assets.md §9).
 */
export const rankPresets = (doc: Pick<ComicDoc, 'brief' | 'format'>): string[] =>
  STYLE_PRESETS.map((p, i) => ({ id: p.id, i, s: presetFitScore(p, doc) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.id);
