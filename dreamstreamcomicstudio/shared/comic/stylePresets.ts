// Curated comic art styles. Each `spec` is written as art direction a page model can
// execute: medium, linework, color, shading and what to avoid. Generic phrases like
// "comic style" produce generic art, so every preset names concrete, drawable traits.
// The `swatch` gradient is a UI-only preview used before any image exists.
// Names, taglines and specs never name an artist, studio or brand (the library manifest lint
// and stylePresets.test.ts enforce it): presets describe drawable traits, not someone's IP.

import type { ColorMode, ComicDoc, ComicKind } from './doc.js';

// ── Tag taxonomy (styles.md §5: the chips and filters of the "Styles" view) ───────────────────

/** Colour chip: black and white, ink plus one spot colour, a few flat inks, or full colour. */
export type StyleColourTag = 'bw' | 'spot' | 'limited' | 'full';
/** Medium chip: what the art looks made with. */
export type StyleMediumTag = 'ink' | 'watercolour' | 'digital-paint' | 'print' | 'pastel';
export interface StyleTags {
  colour: StyleColourTag;
  medium: StyleMediumTag;
}
/** Chip labels, in filter order. */
export const STYLE_COLOUR_LABELS: Readonly<Record<StyleColourTag, string>> = {
  bw: 'B&W',
  spot: 'Spot colour',
  limited: 'Limited',
  full: 'Full colour'
};
export const STYLE_MEDIUM_LABELS: Readonly<Record<StyleMediumTag, string>> = {
  ink: 'Ink',
  watercolour: 'Watercolour',
  'digital-paint': 'Digital paint',
  print: 'Print',
  pastel: 'Pastel'
};

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
  /** Colour and medium chips (the best-for chip is `bestFor[0]`). */
  tags: StyleTags;
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
    swatch: 'linear-gradient(135deg,#1d3557 0%,#e63946 60%,#ffb703 100%)',
    tags: { colour: 'full', medium: 'ink' }
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
    swatch: 'linear-gradient(135deg,#0b0b0b 0%,#3a3a3a 55%,#9b1c1c 100%)',
    tags: { colour: 'bw', medium: 'ink' }
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
    swatch: 'linear-gradient(135deg,#2a6fdb 0%,#f4d35e 55%,#ee964b 100%)',
    tags: { colour: 'full', medium: 'ink' }
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
    swatch: 'linear-gradient(135deg,#111 0%,#777 50%,#eee 100%)',
    tags: { colour: 'bw', medium: 'ink' }
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
    swatch: 'linear-gradient(135deg,#ff8fab 0%,#cdb4db 50%,#a2d2ff 100%)',
    tags: { colour: 'full', medium: 'digital-paint' }
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
    swatch: 'linear-gradient(135deg,#f2cc8f 0%,#81b29a 55%,#e07a5f 100%)',
    tags: { colour: 'full', medium: 'watercolour' }
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
    swatch: 'linear-gradient(135deg,#264653 0%,#2a9d8f 45%,#e76f51 100%)',
    tags: { colour: 'full', medium: 'digital-paint' }
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
    swatch: 'linear-gradient(135deg,#d62828 0%,#fcbf49 50%,#003049 100%)',
    tags: { colour: 'limited', medium: 'print' }
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
    swatch: 'linear-gradient(135deg,#90be6d 0%,#f9c74f 55%,#577590 100%)',
    tags: { colour: 'full', medium: 'digital-paint' }
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
    swatch: 'linear-gradient(135deg,#ff48b0 0%,#fdf6e3 50%,#00838a 100%)',
    tags: { colour: 'limited', medium: 'print' }
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
    swatch: 'linear-gradient(135deg,#ffd166 0%,#06d6a0 50%,#118ab2 100%)',
    tags: { colour: 'full', medium: 'ink' }
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
    swatch: 'linear-gradient(135deg,#1b1b2f 0%,#4e4e6a 50%,#e43f5a 100%)',
    tags: { colour: 'full', medium: 'ink' }
  },
  // ── Program 3 ST-4: two "black and white plus one colour" looks (owner: "black and white, but
  // colour where needed"), then the ten classic-wizard looks v5 dropped, renamed and IP-free. ──
  {
    id: 'ink-one-colour',
    name: 'Ink + one colour',
    tagline: 'Black & white inks, one accent colour where it matters',
    spec:
      'Black-and-white ink comic art with exactly one accent colour: crisp brush and pen linework, solid spot blacks, clean white paper and grey ink tones for depth, plus a single vivid accent hue reserved for the key object, light or emotion of each scene, so the accent carries the story while everything else stays black, white and grey.',
    palette: ['#111111', '#fafafa', '#d62839'],
    linework: 'Crisp brush and pen inks, solid spot blacks',
    avoid: ['a second accent colour', 'full-colour rendering', 'coloured backgrounds'],
    bestFor: ['drama', 'thriller', 'mystery', 'literary'],
    colorMode: 'limited',
    swatch: 'linear-gradient(135deg,#111111 0%,#3a3a3a 45%,#fafafa 80%,#d62839 100%)',
    tags: { colour: 'spot', medium: 'ink' }
  },
  {
    id: 'mono-wash',
    name: 'Modern mono wash',
    tagline: 'Clean lines, flat grey washes, one cool accent used sparingly',
    spec:
      'Modern monochrome comic art: clean even contour lines, flat grey ink-wash tones in three or four hard-edged steps, lots of open white paper, simple contemporary shapes and calm uncluttered staging, and one cool blue accent used sparingly on a single small detail per scene, with no other colour anywhere.',
    palette: ['#1a1a1a', '#9a9a9a', '#f7f7f5', '#2b59c3'],
    linework: 'Clean even contours, flat stepped grey washes',
    avoid: ['more than one accent colour', 'heavy textures', 'busy crosshatching'],
    bestFor: ['literary', 'slice of life', 'drama'],
    colorMode: 'limited',
    swatch: 'linear-gradient(135deg,#1a1a1a 0%,#9a9a9a 50%,#f7f7f5 85%,#2b59c3 100%)',
    tags: { colour: 'spot', medium: 'ink' }
  },
  {
    id: 'ink-wash',
    name: 'Ink wash (sumi-e)',
    tagline: 'Flowing brush ink, misty grey washes, handmade and timeless',
    spec:
      'Ink wash painting adapted to comics: expressive brush strokes that swell and taper in a single gesture, layered grey washes from pale mist to dense black, soft bleeding edges and dry-brush texture on absorbent paper with visible fibre grain, wide areas of empty paper read as mist or sky, dramatic but controlled contrast that stays handmade even for futuristic subjects.',
    palette: ['#141414', '#5c5c5c', '#a8a8a2', '#f3efe4'],
    linework: 'Swelling brush strokes, dry-brush edges, ink washes',
    avoid: ['hard digital outlines', 'flat vector fills', 'saturated colour'],
    bestFor: ['historical', 'action', 'literary', 'fantasy'],
    colorMode: 'bw',
    swatch: 'linear-gradient(135deg,#141414 0%,#5c5c5c 45%,#f3efe4 100%)',
    tags: { colour: 'bw', medium: 'ink' }
  },
  {
    id: 'indian-miniature',
    name: 'Indian miniature sci-fi',
    tagline: 'Jewel tones, ornamental borders, flat sacred perspective',
    spec:
      'Indian miniature painting fused with science fiction: flat tilted perspective with stacked planes, rich jewel-tone colour (lapis blue, vermilion, emerald, saffron and gold) in opaque gouache-like fills, fine ornamental patterns on fabric, architecture and machines, floral borders around panels, graceful profile and three-quarter faces, symbolic compositions where palaces, gods and starships share one scene.',
    palette: ['#1f3a93', '#c0392b', '#1e8449', '#f1c40f', '#f5ead0'],
    linework: 'Fine brush outlines, ornamental patterning',
    avoid: ['deep western perspective', 'gritty textures', 'muted colours'],
    bestFor: ['mythology', 'indian', 'sci-fi', 'fable'],
    swatch: 'linear-gradient(135deg,#1f3a93 0%,#c0392b 50%,#f1c40f 100%)',
    tags: { colour: 'full', medium: 'watercolour' }
  },
  {
    id: 'woodcut',
    name: 'Woodcut / linocut',
    tagline: 'Carved black lines, raw print texture, stark contrast',
    spec:
      'Woodcut and linocut relief-print look: bold carved black shapes with chiselled gouge marks, parallel cut lines for shading, sky and water, rough uneven ink coverage with paper showing through, stark black on warm cream paper with no midtones, heavy simplified forms and the graphic punch of a printed broadside.',
    palette: ['#111111', '#3b3b38', '#efe6d2'],
    linework: 'Carved gouge marks, parallel cut lines',
    avoid: ['smooth gradients', 'soft airbrushing', 'thin delicate lines'],
    bestFor: ['dystopia', 'historical', 'horror', 'thriller'],
    colorMode: 'bw',
    swatch: 'linear-gradient(135deg,#111111 0%,#3b3b38 50%,#efe6d2 100%)',
    tags: { colour: 'bw', medium: 'print' }
  },
  {
    id: 'dieselpunk',
    name: 'Dieselpunk deco',
    tagline: 'Art deco machines, soot and chrome, an alternate 1930s',
    spec:
      'Dieselpunk art deco comic art: an alternate 1920s to 1940s world of riveted airships, streamlined locomotives and towering stepped skyscrapers, strong vertical geometry and sunburst motifs, a smoky sepia and gunmetal palette with brass and chrome highlights, hard rim light through soot and haze, confident inked contours with poster-like simplification.',
    palette: ['#2b2b2b', '#6b5b45', '#b08d57', '#d9c7a1'],
    linework: 'Confident inks, streamlined geometry',
    avoid: ['cute proportions', 'pastel colours', 'modern gadgets'],
    bestFor: ['alternate history', 'adventure', 'dystopia'],
    swatch: 'linear-gradient(135deg,#2b2b2b 0%,#6b5b45 45%,#b08d57 100%)',
    tags: { colour: 'full', medium: 'digital-paint' }
  },
  {
    id: 'brutalist',
    name: 'Brutalist graphic',
    tagline: 'Harsh geometry, heavy negative space, cold and controlled',
    spec:
      'Brutalist graphic-novel art: harsh rectilinear geometry, massive raw-concrete architecture, small figures dwarfed by heavy blocks and wide empty space, a limited cold palette of concrete grey, black and one muted ochre signal colour, flat hard-edged shapes with almost no texture, rigid symmetrical framing, cold, controlled and quietly unsettling.',
    palette: ['#1a1a1a', '#8c8c88', '#d6d4ce', '#c49a2c'],
    linework: 'Hard straight edges, minimal line, flat shapes',
    avoid: ['organic curves', 'warm cosy lighting', 'busy ornament'],
    // Not 'thriller': a plain, spy or revenge thriller stays with Noir ink; "brutalist" and the
    // dystopia words still lead here.
    bestFor: ['dystopia', 'literary'],
    colorMode: 'limited',
    swatch: 'linear-gradient(135deg,#1a1a1a 0%,#8c8c88 55%,#d6d4ce 100%)',
    tags: { colour: 'limited', medium: 'print' }
  },
  {
    id: 'surreal-dream',
    name: 'Dream-logic surreal',
    tagline: 'Impossible spaces, floating symbols, uncanny calm',
    spec:
      'Surreal dream-logic comic art: impossible architecture and staircases that loop back into themselves, oversized moons and floating everyday objects, gently stretched proportions, symbolic props that repeat and transform from panel to panel, smooth soft-edged painting with crisp contours, a twilight palette of violet, teal and peach, uncanny calm rather than horror.',
    palette: ['#2e1f4f', '#3aa6a0', '#f4a582', '#f7e7ce'],
    linework: 'Crisp clean contours, soft painted forms',
    avoid: ['gore', 'photorealism', 'cluttered detail'],
    bestFor: ['surreal', 'literary', 'experimental', 'sci-fi'],
    swatch: 'linear-gradient(135deg,#2e1f4f 0%,#3aa6a0 50%,#f4a582 100%)',
    tags: { colour: 'full', medium: 'digital-paint' }
  },
  {
    id: 'chalk-pastel',
    name: 'Chalk pastel noir',
    tagline: 'Dusty pastels on dark paper, moody haze, memory-heavy',
    spec:
      'Chalk and soft-pastel noir: dusty pastel strokes on dark toned paper, soft smudged edges and visible paper grain, moody haze glowing around lamps and windows, muted rose, slate blue and bone highlights over deep charcoal, loose hand-drawn contour lines, quiet atmospheric scenes heavy with memory and night air.',
    palette: ['#22252b', '#5d6d8a', '#c98e9a', '#e8dfd0'],
    linework: 'Loose chalk contours, smudged edges',
    avoid: ['crisp vector lines', 'saturated neon', 'glossy shading'],
    bestFor: ['mystery', 'drama', 'literary'],
    swatch: 'linear-gradient(135deg,#22252b 0%,#5d6d8a 50%,#c98e9a 100%)',
    tags: { colour: 'full', medium: 'pastel' }
  },
  {
    id: 'retrofuturism',
    name: 'Retro-future poster',
    tagline: '60s–70s space-age optimism in bright poster colours',
    spec:
      'Retro-futurist 1960s to 1970s poster art: an optimistic space-age future of rounded rockets, monorails, bubble domes and sleek jumpsuits, bold flat shapes with fine screen-print grain, a bright sunny palette of orange, teal, mustard and cream, sunburst and orbit-ring motifs, clean confident outlines and slightly stylised figures.',
    palette: ['#e4572e', '#17bebb', '#ffc914', '#f6f0e1', '#2e282a'],
    linework: 'Clean confident outlines, flat poster shapes',
    avoid: ['grim dystopian grit', 'muddy colours', 'photo textures'],
    bestFor: ['sci-fi', 'retro adventure', 'humor'],
    swatch: 'linear-gradient(135deg,#e4572e 0%,#ffc914 50%,#17bebb 100%)',
    tags: { colour: 'full', medium: 'print' }
  },
  {
    id: 'mythic-icon',
    name: 'Mythic icon',
    tagline: 'Halos, sacred geometry, epic scale',
    spec:
      'Mythic iconographic comic art: frontal, deity-like poses in symmetrical compositions, glowing halos and sacred-geometry rings behind key figures, gold-leaf highlights against deep lapis blue and crimson, flattened decorative space with patterned backgrounds, monumental contrasts of scale and solemn faces, the gravity of devotional painting applied to myth and science fiction.',
    palette: ['#14213d', '#9d0208', '#d4a017', '#f5ecd7'],
    linework: 'Firm contour lines, gilded ornament',
    avoid: ['casual snapshots', 'grunge textures', 'cartoon proportions'],
    bestFor: ['mythology', 'fantasy', 'sci-fi'],
    swatch: 'linear-gradient(135deg,#14213d 0%,#9d0208 50%,#d4a017 100%)',
    tags: { colour: 'full', medium: 'digital-paint' }
  },
  {
    id: 'cyberpunk',
    name: 'Neon cyber',
    tagline: 'Neon glow, rain-slick streets, high-tech grit',
    spec:
      'Neon cyberpunk comic art: dense night cities of stacked towers, glowing light strips and rain-slick streets reflecting magenta and cyan, digital painting with hard rim lights and deep shadows, gritty high-tech details such as cables, visors and drones, saturated neon against near-black, cinematic low camera angles.',
    palette: ['#0b0c1a', '#ff2e88', '#00e5ff', '#7b2cbf'],
    linework: 'Sharp digital lines under painted light',
    avoid: ['daylight pastels', 'flat cheerful colours', 'rustic textures'],
    // Not 'thriller'/'crime': plain crime and heist thrillers stay with Noir ink. "Cyberpunk",
    // "cyber" and "neon" still lead here (sci-fi synonyms and this look's own name words).
    bestFor: ['sci-fi', 'action'],
    swatch: 'linear-gradient(135deg,#0b0c1a 0%,#7b2cbf 45%,#ff2e88 75%,#00e5ff 100%)',
    tags: { colour: 'full', medium: 'digital-paint' }
  }
];

export const getStylePreset = (id?: string) => (id ? STYLE_PRESETS.find((p) => p.id === id) : undefined);

// ── Ink + one colour (styles.md §5; PROGRAM3 A20, D7) ────────────────────────────────────────
// The owner's "black and white, but colour where needed": black ink, paper white and ONE accent.
// The accent is the user's to pick (written to `style.palette`); the palette shape
// `[ink, paper, accent]` is what the page prompt's spot-colour clause recognises.

export const INK_ONE_COLOUR_PRESET_ID = 'ink-one-colour';
export const SPOT_INK = '#111111';
export const SPOT_PAPER = '#fafafa';
export const DEFAULT_SPOT_ACCENT = '#d62839';

const HEX6_RE = /^#[0-9a-f]{6}$/i;
const channels = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
/** A neutral (black, white or grey) colour: the channels sit within a few steps of each other. */
export const isNeutralHex = (hex: string): boolean => {
  if (!HEX6_RE.test(hex)) return false;
  const c = channels(hex);
  return Math.max(...c) - Math.min(...c) < 16;
};

/** `style.palette` for Ink + one colour with the user's accent; a missing, malformed or grey accent keeps the default. */
export const spotColourPalette = (accent?: string): string[] => [
  SPOT_INK,
  SPOT_PAPER,
  typeof accent === 'string' && HEX6_RE.test(accent.trim()) && !isNeutralHex(accent.trim()) ? accent.trim().toLowerCase() : DEFAULT_SPOT_ACCENT
];

/** The one accent of a spot-colour palette (its last non-neutral entry), if there is one. */
export const spotAccentOf = (palette: readonly string[] | undefined): string | undefined =>
  [...(palette || [])].reverse().find((c) => typeof c === 'string' && HEX6_RE.test(c) && !isNeutralHex(c));

/** Up to 3 card chips: colour, medium, best-for (styles.md §5 "Label"). */
export const styleChips = (p: Pick<StylePreset, 'tags' | 'bestFor'>): string[] => {
  const best = p.bestFor[0];
  return [
    p.tags ? STYLE_COLOUR_LABELS[p.tags.colour] : '',
    p.tags ? STYLE_MEDIUM_LABELS[p.tags.medium] : '',
    best ? best.charAt(0).toUpperCase() + best.slice(1) : ''
  ].filter(Boolean).slice(0, 3);
};

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
  mythology: ['myth', 'mythology', 'mythic', 'gods', 'legend', 'epic'],
  // Tags of the looks restored in ST-4 (new keys only, so the twelve older looks score as before).
  indian: ['indian', 'india', 'south asian', 'desi', 'mahabharata', 'ramayana', 'mughal', 'rajput', 'vedic'],
  dystopia: ['dystopia', 'dystopian', 'totalitarian', 'authoritarian', 'regime', 'propaganda', 'revolution', 'rebellion', 'uprising', 'surveillance'],
  surreal: ['surreal', 'surrealist', 'dream', 'dreams', 'dreamlike', 'dream logic', 'nightmare', 'multiverse', 'hallucination', 'subconscious'],
  'alternate history': ['alternate history', 'alternate timeline', 'alt history', 'dieselpunk', 'art deco', 'zeppelin', 'airship', 'airships', '1920s', '1930s', '1940s', 'interwar']
};

/** Audience words → the tags that suit it (young readers get gentle looks). */
const YOUNG_AUDIENCE_RE = /\b(kids?|child(?:ren)?|toddlers?|preschool(?:ers)?|bedtime|picture[- ]book|ages?\s*[1-8]\b|[1-8]\s*[-–]\s*[1-9]\b|family|young readers?)\b/i;
const YOUNG_TAGS = ['kids', 'family', 'fable'];
/** Presets whose look is too grim for very young readers (still allowed when asked for by name). */
const GRIM_FOR_KIDS = new Set(['noir-ink', 'dark-fantasy', 'graphic-novel-painterly', 'woodcut', 'brutalist', 'dieselpunk', 'chalk-pastel', 'cyberpunk']);

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

/**
 * Distinctive words of a preset's own name/id ("noir", "manga", "watercolor", "riso"…). Common
 * story words in a name are not distinctive: "future" and "poster" ("Retro-future poster") would
 * hand a sunny look every "dystopian future" brief.
 */
const NAME_STOP_WORDS = new Set(['style', 'modern', 'graphic', 'novel', 'cartoon', 'dark', 'colour', 'color', 'future', 'poster']);
const presetNameWords = (p: StylePreset): string[] =>
  [...new Set(`${p.id.replace(/-/g, ' ')} ${p.name}`.toLowerCase().split(/[^a-z0-9]+/))].filter((w) => w.length >= 4 && !NAME_STOP_WORDS.has(w));

// "Black and white" in a brief (not "noir": noir is a genre, not a colour request).
const BW_WORDS_RE = /(?:black[\s-]*(?:and|&|n)[\s-]*white|(?:^|[^\p{L}\p{N}])b\s*[&/]\s*w(?:$|[^\p{L}\p{N}])|monochrom|gr[ae]yscale|ink[\s-]only)/u;
const HUE_WORDS = 'colou?rs?|red|blue|yellow|green|orange|pink|purple|violet|gold|golden|teal|cyan|magenta|crimson|scarlet|amber';
// One accent: "one colour", "a splash of red", "spot colour", "colour only where it's needed", "red accents".
// No bare digit: "chapter 1 red herring" is a story noun, not an accent request.
const ACCENT_WORDS_RE = new RegExp(
  [
    `\\b(?:one|single|lone|sole)\\s+(?:accent\\s+|spot\\s+|pop\\s+of\\s+)?(?:${HUE_WORDS}|hue|accent)\\b`,
    '\\b(?:spot|accent|selective)\\s+colou?rs?\\b',
    `\\b(?:splash|pop|touch|hint|dash|flash)(?:es|s)?\\s+of\\s+(?:${HUE_WORDS})\\b`,
    `\\b(?:${HUE_WORDS})\\s+accents?\\b`,
    '\\bcolou?rs?\\b[^.;\\n]{0,24}\\b(?:where|when)\\b[^.;\\n]{0,20}\\b(?:needed|necessary|important|matters?|counts?)\\b'
  ].join('|')
);

/**
 * The brief asks for black-and-white art with one accent colour — the owner's "black and white,
 * but colour where needed". Black and white comes from the words or from `format.colorMode`
 * (`bw`, or `limited` read together with b/w words); the accent from the words.
 */
export const briefWantsSpotColour = (doc: Pick<ComicDoc, 'brief' | 'format'>): boolean => {
  const b = doc.brief || ({} as ComicDoc['brief']);
  const text = lowerText(b.genre, b.tone, b.audience, b.premise, b.logline, b.setting, ...(b.themes || []), ...(b.notes || []));
  if (!text) return false;
  const mode = doc.format?.colorMode;
  const bw = BW_WORDS_RE.test(text);
  if (mode === 'limited' && bw) return true;
  return (bw || mode === 'bw') && ACCENT_WORDS_RE.test(text);
};

/** Ink + one colour is THE answer to a b/w + accent brief; the other spot-colour look follows. */
const SPOT_LEAD_BONUS = 20;
const SPOT_BONUS = 8;

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
  if (p.tags?.colour === 'spot' && briefWantsSpotColour(doc)) s += p.id === INK_ONE_COLOUR_PRESET_ID ? SPOT_LEAD_BONUS : SPOT_BONUS;
  else if (mode === 'bw') s += p.colorMode === 'bw' ? 3 : -2;
  else if (p.colorMode === 'bw') s -= 1;
  // The spot looks are b/w art too: on a full-colour comic they get the same nudge down.
  else if (p.tags?.colour === 'spot' && mode !== 'limited') s -= 1;
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
