// Platform asset library manifest (assets.md §3, contract §11.6). Owned by P1-LIBRARY.
//
// Every library image is generated FRESH from the prompts below: no user's image, upload,
// reference or comic is ever read, reused or attached (the only reference an edit pass may
// attach is the library's own previous candidate, under library/…). Prompts describe
// drawable traits only; the lint (manifest.test.ts) forbids artist, studio and brand names.
// Style previews are compiled from STYLE_PRESETS so a preset edit changes the prompt hash and
// the next build's quote shows that the preview will be redrawn.
// Every preset gets three core samples (styles.md §5–§6.2, Program 3 ST-4): the shared scene
// (`style.<id>`), the same original character as a bust (`style.<id>.cast`) and a content-neutral
// swatch (`anchor.<id>`), all 1K 4:5 so a Styles card can cross-fade between them.

import type { AspectRatio, Resolution } from '../../../../shared/comic/doc.js';
import { hashString } from '../../../../shared/comic/doc.js';
import {
  LIBRARY_ID_RE,
  LIBRARY_MANIFEST_VERSION,
  LIBRARY_MIN_SCORE,
  styleAnchorId,
  styleCastId,
  stylePreviewId,
  type LibraryKind,
  type LibraryTheme
} from '../../../../shared/comic/library.js';
import { STYLE_PRESETS, spotAccentOf, type StylePreset } from '../../../../shared/comic/stylePresets.js';

export interface LibraryManifestEntry {
  /** LIBRARY_ID_RE, e.g. "style.watercolor-storybook". */
  id: string;
  kind: LibraryKind;
  /** Fully composed prompt (the run may append an admin note or corrections). */
  prompt: string;
  /** Image registry id (shared/comic/models.ts); must support `aspect` and `resolution`. */
  model: string;
  resolution: Resolution;
  aspect: AspectRatio;
  theme: LibraryTheme;
  presetId?: string;
  genre?: string;
  tags: string[];
  /** Human-written alt text; the vision caption may refine it, never blank it. */
  alt: string;
  /** Text that MUST appear (covers); undefined ⇒ the image must be text-free. */
  expectedText?: string[];
  /** Panels a genre page must show (checked by the vision pass). */
  panels?: number;
  /** The subject sentence (moved first when the brief match is weak). */
  subject?: string;
  /** Must-have subjects (repeated as a checklist when the brief match is weak). */
  mustHave?: string[];
  /** Per-asset acceptance threshold (never below LIBRARY_MIN_SCORE). */
  minScore?: number;
  /** sharp post-process. */
  post?: 'seamless_tile';
  /** Not built unless explicitly requested (ids, kinds or includeOptional). */
  optional?: boolean;
}

// ── Shared text blocks (assets.md §3.2) ──────────────────────────────────────

export const SAMPLE_SCENE =
  'A small girl in a raincoat and her scruffy little terrier pause on an old stone footbridge over a quiet canal at dusk. ' +
  'She points down at a folded paper boat drifting on the water; a warmly lit bakery window and two hanging lanterns glow behind them, ' +
  'rooftops and a church spire in the distance. Medium-wide shot, three-quarter view, the pair in the left third, the bridge arch leading the eye.';

export const NO_TEXT =
  'No text, no letters, no numbers, no speech balloons, no captions, no signage lettering, no logos, no signature, no watermark.';

export const HOUSE_STYLE =
  'Calm editorial spot illustration: fine warm-graphite linework, soft flat fills in warm off-white and stone grey, ' +
  'a single terracotta accent (#D97757) used sparingly, generous negative space, gentle paper grain, friendly and quiet, no harsh shadows.';

export const HOUSE_STYLE_DARK =
  'Calm editorial spot illustration on a deep warm charcoal (#1F1E1D) ground with soft cream linework, ' +
  'a single terracotta accent (#D97757) used sparingly, generous negative space, low contrast, no pure white areas, friendly and quiet.';

/**
 * The one original character every style draws (the girl from SAMPLE_SCENE), so the cast samples
 * compare styles on the same face. Invented for the platform; no user content, no existing character.
 */
export const CAST_SUBJECT =
  'A head-and-shoulders character bust of the same small girl in every style: about eight years old, a short dark bob with a straight fringe, ' +
  'a round face with a few freckles, a hooded raincoat with big toggle buttons, holding a folded paper boat up in both hands. ' +
  'Three-quarter view, a curious half-smile, looking just past the viewer, a plain softly toned background.';

/** "style.<id>.cast" (shared/comic/library.ts): re-exported for the manifest's callers and tests. */
export { styleCastId };

const PAGE_PREFIX = `A complete comic book page. Thin black panel borders, clean white gutters, consistent characters across panels. ${NO_TEXT}`;

const presetById = (id: string): StylePreset => {
  const p = STYLE_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`library manifest: unknown preset ${id}`);
  return p;
};

/** Colour-mode sentence for a preset (b/w and limited-ink presets). */
const colorModeLine = (p: StylePreset): string =>
  p.colorMode === 'bw'
    ? 'Strictly black and white with grey tones only; the raincoat reads as a light grey.'
    : p.colorMode === 'limited'
      ? 'Use only the listed inks.'
      : '';

/**
 * Spot-colour looks say WHERE the one accent goes, as a positive instruction (image models follow
 * those better than prohibitions). `where` names the sample's focal object.
 */
const spotLine = (p: StylePreset, where: string): string => {
  const accent = spotAccentOf(p.palette);
  return accent
    ? `Black ink on paper white with grey tones, and a single spot colour, ${hueName(accent)} (${accent}), used only on ${where}; everything else stays black, white and grey.`
    : 'Strictly black and white with grey tones only.';
};

/** A plain colour word for a hex accent ("red", "blue", …), so the prompt names the hue as well as its code. */
export const hueName = (hex: string): string => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 'accent';
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d < 0.08) return 'grey';
  const h = (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  const names: Array<[number, string]> = [[15, 'red'], [40, 'orange'], [65, 'yellow'], [160, 'green'], [195, 'teal'], [255, 'blue'], [290, 'violet'], [335, 'magenta'], [360, 'red']];
  return names.find(([end]) => h < end)?.[1] || 'red';
};

/** The colour sentence of a style sample: the spot clause for spot-colour looks, else the mode line. */
const sampleColourLine = (p: StylePreset, where: string, bw: string): string =>
  p.tags?.colour === 'spot' ? spotLine(p, where) : p.colorMode === 'bw' ? bw : colorModeLine(p);

/** Style preview prompt, compiled from the preset (assets.md §3.3 A). */
export const stylePreviewPrompt = (p: StylePreset): string =>
  [
    'Comic art style sample: a single illustration, no panel borders.',
    SAMPLE_SCENE,
    `Render it in exactly this style: ${p.spec}`,
    `Linework: ${p.linework}. Key colours: ${p.palette.join(', ')}.`,
    sampleColourLine(p, "the girl's raincoat and the paper boat", colorModeLine(p)),
    `Avoid: ${p.avoid.join(', ')}.`,
    NO_TEXT
  ]
    .filter(Boolean)
    .join('\n');

/** Character bust in the preset's style: the same original girl for every style (styles.md §6.2). */
export const styleCastPrompt = (p: StylePreset): string =>
  [
    'Comic art style sample: a single character portrait, no panel borders.',
    CAST_SUBJECT,
    `Render it in exactly this style: ${p.spec}`,
    `Linework: ${p.linework}. Key colours: ${p.palette.join(', ')}.`,
    sampleColourLine(p, 'the raincoat', 'Strictly black and white with grey tones only; the raincoat reads as a light grey.'),
    `Avoid: ${p.avoid.join(', ')}.`,
    NO_TEXT
  ]
    .filter(Boolean)
    .join('\n');

/** Content-neutral swatch usable as a style board (assets.md §3.3 G); core since ST-4. */
export const styleAnchorPrompt = (p: StylePreset): string =>
  [
    'A style reference swatch sheet with no characters: a teacup, a potted plant, a window with curtains, a folded cloth and a stone step, arranged as a still life.',
    `Rendered in exactly this style: ${p.spec}`,
    `Linework: ${p.linework}. Key colours: ${p.palette.join(', ')}.`,
    sampleColourLine(p, 'the teacup', 'Strictly black and white with grey tones only.'),
    NO_TEXT
  ]
    .filter(Boolean)
    .join('\n');

const STYLE_TAGS: Record<string, string[]> = {
  'modern-heroic': ['action', 'bold-ink'],
  'noir-ink': ['bw', 'crime'],
  'ligne-claire': ['clean-line', 'adventure'],
  'manga-screentone': ['bw', 'manga'],
  'webtoon-cel': ['webtoon', 'soft-cel'],
  'watercolor-storybook': ['kids', 'watercolor'],
  'graphic-novel-painterly': ['painterly', 'mature'],
  'retro-pop': ['halftone', '60s'],
  'cozy-anime': ['anime', 'cozy'],
  'indie-risograph': ['riso', 'zine'],
  'cartoon-strip': ['strip', 'humor'],
  'dark-fantasy': ['gothic', 'fantasy'],
  'ink-one-colour': ['spot-colour', 'ink'],
  'mono-wash': ['spot-colour', 'wash'],
  'ink-wash': ['bw', 'brush'],
  'indian-miniature': ['miniature', 'mythology'],
  woodcut: ['bw', 'printmaking'],
  dieselpunk: ['deco', 'retro'],
  brutalist: ['geometric', 'limited'],
  'surreal-dream': ['surreal', 'dream'],
  'chalk-pastel': ['pastel', 'moody'],
  retrofuturism: ['retro', 'poster'],
  'mythic-icon': ['mythic', 'iconic'],
  cyberpunk: ['neon', 'sci-fi']
};

/** Index tags of a style sample: kind word, preset id, look words and the taxonomy chips' keys. */
const styleTags = (p: StylePreset, ...lead: string[]): string[] =>
  [...new Set([...lead, p.id, ...(STYLE_TAGS[p.id] || []), ...(p.tags ? [p.tags.colour, p.tags.medium] : [])])];

const styleEntries = (): LibraryManifestEntry[] =>
  STYLE_PRESETS.map((p) => ({
    id: stylePreviewId(p.id),
    kind: 'style_preview',
    prompt: stylePreviewPrompt(p),
    model: 'nano-banana-2.1',
    resolution: '1K',
    aspect: '4:5',
    theme: 'any',
    presetId: p.id,
    tags: styleTags(p, 'style'),
    alt: `${p.name} style sample: a girl and her dog on a canal bridge at dusk`,
    subject: 'A small girl in a raincoat and her scruffy little terrier on an old stone footbridge over a canal at dusk.',
    mustHave: ['a small girl in a raincoat', 'a small scruffy terrier', 'a stone footbridge over a canal', 'a folded paper boat on the water'],
    minScore: LIBRARY_MIN_SCORE
  }));

const castEntries = (): LibraryManifestEntry[] =>
  STYLE_PRESETS.map((p) => ({
    id: styleCastId(p.id),
    kind: 'style_preview',
    prompt: styleCastPrompt(p),
    model: 'nano-banana-2.1',
    resolution: '1K',
    aspect: '4:5',
    theme: 'any',
    presetId: p.id,
    tags: styleTags(p, 'style', 'cast'),
    alt: `${p.name} style sample: a portrait of a girl in a hooded raincoat holding a paper boat`,
    subject: CAST_SUBJECT,
    mustHave: ['one small girl, head and shoulders', 'a hooded raincoat', 'a folded paper boat'],
    minScore: LIBRARY_MIN_SCORE
  }));

// Core since ST-4 (the Styles card's third sample and the preset style board), and drawn at 4:5 like
// the other two samples: production has no library rows yet, so the aspect change redraws nothing.
const anchorEntries = (): LibraryManifestEntry[] =>
  STYLE_PRESETS.map((p) => ({
    id: styleAnchorId(p.id),
    kind: 'style_anchor',
    prompt: styleAnchorPrompt(p),
    model: 'nano-banana-2.1',
    resolution: '1K',
    aspect: '4:5',
    theme: 'any',
    presetId: p.id,
    tags: styleTags(p, 'anchor'),
    alt: `${p.name} style swatch: a still life of a teacup, a plant and a window`,
    mustHave: ['a teacup', 'a potted plant', 'a window with curtains'],
    minScore: LIBRARY_MIN_SCORE
  }));

interface GenreSpec {
  slug: string;
  preset: string;
  model: 'nano-banana-pro' | 'nano-banana-2.1';
  aspect: AspectRatio;
  panels: number;
  audience: string;
  body: string;
  alt: string;
  mustHave: string[];
}

const GENRES: GenreSpec[] = [
  {
    slug: 'kids-storybook',
    preset: 'watercolor-storybook',
    model: 'nano-banana-pro',
    aspect: '4:5',
    panels: 4,
    audience: 'kids',
    body:
      '4 panels: row 1 one wide panel; row 2 two equal panels; row 3 one wide panel. A cheerful toddler in a striped onesie sits on the grassy bank of a lily-pad lake. ' +
      'P1: three fluffy yellow ducklings waddle up to the toddler. P2: a small green frog hops onto a lily pad; the toddler claps and giggles. ' +
      'P3: a brown bunny peeks out from the reeds. P4: at sunset the toddler, ducklings, frog and bunny sit together watching fireflies over the water. ' +
      'The toddler and each animal look identical in every panel.',
    alt: 'A four-panel storybook page: a toddler by a lily-pad lake meets ducklings, a frog and a bunny, then watches fireflies at sunset',
    mustHave: ['a toddler in a striped onesie', 'three yellow ducklings', 'a green frog', 'a brown bunny']
  },
  {
    slug: 'manga-action',
    preset: 'manga-screentone',
    model: 'nano-banana-pro',
    aspect: '2:3',
    panels: 5,
    audience: 'teen',
    body:
      '5 panels, right-to-left reading composition. Two rival swordsmen face off on a rain-soaked rooftop at night. P1 wide establishing shot of the rooftop and city; ' +
      "P2 extreme close-up of one fighter's narrowed eyes; P3 diagonal panel, a blade clash with speed lines; P4 an impact panel with radial focus lines and rain spray; " +
      'P5 a quiet panel, both fighters back to back, breathing.',
    alt: 'A five-panel black-and-white action page: two swordsmen duel on a rainy rooftop at night',
    mustHave: ['two swordsmen', 'a rain-soaked rooftop at night', 'speed lines']
  },
  {
    slug: 'superhero',
    preset: 'modern-heroic',
    model: 'nano-banana-pro',
    aspect: '2:3',
    panels: 5,
    audience: 'teen',
    body:
      '5 panels, one large dominant panel. A hero in a teal-and-orange suit catches a runaway tram car as it tips off a harbor bridge at golden hour. ' +
      'P1 commuters gasping inside the tilting tram; P2 (largest) the hero braced beneath the tram, cape snapping, sparks; P3 close-up of gritted teeth; ' +
      'P4 the tram set gently back on the rails; P5 a child waving through the tram window.',
    alt: 'A five-panel action page: a hero in a teal-and-orange suit catches a tram tipping off a harbor bridge',
    mustHave: ['a hero in a teal-and-orange suit', 'a tram car', 'a harbor bridge']
  },
  {
    slug: 'noir',
    preset: 'noir-ink',
    model: 'nano-banana-pro',
    aspect: '2:3',
    panels: 6,
    audience: 'teen',
    body:
      '6 panels in a 2×3 grid. A trench-coated woman detective enters a rain-soaked jazz bar. P1 a dark street, rain, her silhouette; ' +
      'P2 venetian-blind light across her face; P3 a saxophonist in shadow; P4 a matchbook on the bar with a single red lipstick mark (the only colour); ' +
      "P5 the bartender's wary glance; P6 her hand sliding a photograph across the bar.",
    alt: 'A six-panel noir page: a detective in a trench coat walks into a rainy jazz bar',
    mustHave: ['a woman detective in a trench coat', 'a jazz bar', 'venetian-blind light']
  },
  {
    slug: 'webtoon',
    preset: 'webtoon-cel',
    model: 'nano-banana-2.1',
    aspect: '9:16',
    panels: 3,
    audience: 'teen',
    body:
      '3 tall stacked panels with generous vertical white space between them, made for vertical scrolling. Two high-school students under a blossoming cherry tree. ' +
      "P1 wide shot, petals falling; P2 an umbrella slips from one student's hand; P3 close-up, both reach for it at once, a shy blush, soft bokeh.",
    alt: 'A tall three-panel scrolling page: two students under a cherry tree reach for the same umbrella',
    mustHave: ['two high-school students', 'a blossoming cherry tree', 'an umbrella']
  },
  {
    slug: 'romance-retro',
    preset: 'retro-pop',
    model: 'nano-banana-pro',
    aspect: '2:3',
    panels: 4,
    audience: 'teen',
    body:
      '4 panels, 1960s romance comic page. P1 a young woman in a red coat on a rainy city corner; P2 close-up, a single tear, halftone dots on her cheek; ' +
      'P3 a man running across the street holding flowers; P4 the two under one umbrella, primary colours, slight print misregistration.',
    alt: 'A four-panel retro romance page: a woman in a red coat in the rain and a man running to her with flowers',
    mustHave: ['a young woman in a red coat', 'a man holding flowers', 'an umbrella']
  },
  {
    slug: 'slice-of-life',
    preset: 'cozy-anime',
    model: 'nano-banana-pro',
    aspect: '4:5',
    panels: 4,
    audience: 'all',
    body:
      "4 panels. A grandmother and her young grandson make dumplings in a sunny kitchen. P1 flour-dusted table, steam, a cat on the windowsill; P2 the boy's lopsided dumpling; " +
      'P3 grandma laughing, showing him how to pleat; P4 the two eating together at golden hour, the cat stealing a bite.',
    alt: 'A four-panel page: a grandmother teaches her grandson to make dumplings while a cat watches',
    mustHave: ['a grandmother', 'a young boy', 'dumplings', 'a cat']
  },
  {
    slug: 'gag-strip',
    preset: 'cartoon-strip',
    model: 'nano-banana-2.1',
    aspect: '4:1',
    panels: 4,
    audience: 'all',
    body:
      'A 4-panel newspaper gag strip in one row. An office worker versus a coffee machine. P1 he presses the button confidently; P2 the machine sputters; ' +
      'P3 it gives him a thimble-sized cup; P4 his coworker gets a giant overflowing mug from the same machine.',
    alt: 'A four-panel gag strip: an office worker gets a tiny coffee while his coworker gets a giant mug',
    mustHave: ['an office worker', 'a coffee machine', 'a tiny cup', 'a giant mug']
  }
];

const genreEntries = (): LibraryManifestEntry[] =>
  GENRES.map((g) => {
    const p = presetById(g.preset);
    return {
      id: `genre.${g.slug}`,
      kind: 'genre_example',
      prompt: [PAGE_PREFIX, g.body, `Style: ${p.spec}`, colorModeLine(p).replace(/; the raincoat reads as a light grey\./, '.'), `Avoid: ${p.avoid.join(', ')}.`]
        .filter(Boolean)
        .join('\n'),
      model: g.model,
      resolution: '2K',
      aspect: g.aspect,
      theme: 'any',
      presetId: p.id,
      genre: g.slug,
      tags: ['genre', g.slug, p.id, g.audience],
      alt: g.alt,
      panels: g.panels,
      subject: g.body.split('. ').find((s) => /^(A|Two) /.test(s.trim())) || undefined,
      mustHave: g.mustHave,
      minScore: 0.8
    };
  });

const coverEntries = (): LibraryManifestEntry[] => {
  const kids = presetById('watercolor-storybook');
  const hero = presetById('modern-heroic');
  return [
    {
      id: 'cover.kids-storybook',
      kind: 'cover_example',
      prompt: [
        "Picture-book cover. A toddler and three ducklings, a frog and a bunny on a grassy lake bank at sunset, framed by reeds. The title 'THE LITTLE LAKE' hand-lettered in warm brown at the top, nothing else written.",
        `Style: ${kids.spec}`,
        'No other text, no logos, no signature, no watermark, no barcode.'
      ].join('\n'),
      model: 'nano-banana-pro',
      resolution: '2K',
      aspect: '4:5',
      theme: 'any',
      presetId: kids.id,
      genre: 'kids-storybook',
      tags: ['cover', 'kids', kids.id],
      alt: "Picture-book cover titled 'The Little Lake': a toddler with ducklings, a frog and a bunny by a lake at sunset",
      expectedText: ['THE LITTLE LAKE'],
      mustHave: ['a toddler', 'ducklings', 'a lake at sunset'],
      minScore: LIBRARY_MIN_SCORE
    },
    {
      id: 'cover.superhero',
      kind: 'cover_example',
      prompt: [
        "Comic book cover. The teal-and-orange hero mid-leap above a harbor bridge at golden hour, a tram glinting below. The title 'HARBOR LIGHT' in bold heroic block letters across the top, nothing else written.",
        `Style: ${hero.spec}`,
        'No other text, no logos, no signature, no watermark, no barcode, no price box.'
      ].join('\n'),
      model: 'nano-banana-pro',
      resolution: '2K',
      aspect: '2:3',
      theme: 'any',
      presetId: hero.id,
      genre: 'superhero',
      tags: ['cover', 'superhero', hero.id],
      alt: "Comic cover titled 'Harbor Light': a hero in teal and orange leaping above a harbor bridge at golden hour",
      expectedText: ['HARBOR LIGHT'],
      mustHave: ['a hero in a teal-and-orange suit', 'a harbor bridge'],
      minScore: LIBRARY_MIN_SCORE
    }
  ];
};

interface EmptySpec {
  slug: string;
  aspect: AspectRatio;
  themes: Array<'light' | 'dark'>;
  subject: string;
  alt: string;
  used: string;
}

const EMPTIES: EmptySpec[] = [
  {
    slug: 'studio-hero',
    aspect: '4:3',
    themes: ['light', 'dark'],
    subject:
      'A tidy drafting desk seen from above: a blank comic page with faint pencil panel rectangles, a pencil, a cup of tea, and an empty speech-balloon shape floating above the page like an invitation.',
    alt: 'A drafting desk with a blank comic page, a pencil and a cup of tea',
    used: 'studio'
  },
  {
    slug: 'dashboard',
    aspect: '16:9',
    themes: ['light', 'dark'],
    subject: 'A short stack of comic books with blank pages fanning out of the top one, a few loose panel sketches drifting.',
    alt: 'A small stack of comic books with blank pages fanning out',
    used: 'dashboard'
  },
  {
    slug: 'reader-missing',
    aspect: '1:1',
    themes: ['light', 'dark'],
    subject: 'A closed comic book resting on a table with a small ribbon bookmark tied in a bow, soft light.',
    alt: 'A closed comic book with a ribbon bookmark',
    used: 'reader'
  },
  {
    slug: 'cast',
    aspect: '1:1',
    themes: ['light'],
    subject: 'Three blank character silhouettes standing on a model-sheet grid, a pencil leaning on the grid.',
    alt: 'Three blank character silhouettes on a model-sheet grid',
    used: 'cast'
  },
  {
    slug: 'pages',
    aspect: '3:4',
    themes: ['light'],
    subject: 'A page of six thumbnail panel roughs in loose pencil, one being inked.',
    alt: 'A page of six pencil thumbnail panels, one being inked',
    used: 'pages'
  },
  {
    slug: 'style',
    aspect: '1:1',
    themes: ['light'],
    subject: 'A palette of four paint swatches, a round brush and a fine pen laid out on paper.',
    alt: 'Four paint swatches, a brush and a pen on paper',
    used: 'style'
  }
];

const emptyEntries = (): LibraryManifestEntry[] =>
  EMPTIES.flatMap((e) =>
    e.themes.map((theme) => ({
      id: e.themes.length > 1 ? `empty.${e.slug}.${theme}` : `empty.${e.slug}`,
      kind: 'empty_state' as const,
      prompt: [e.subject, theme === 'dark' ? HOUSE_STYLE_DARK : HOUSE_STYLE, NO_TEXT].join('\n'),
      model: 'nano-banana-2.1',
      resolution: '1K' as Resolution,
      aspect: e.aspect,
      theme: e.themes.length > 1 ? theme : ('light' as LibraryTheme),
      tags: ['empty', e.used, theme],
      alt: e.alt,
      subject: e.subject,
      minScore: LIBRARY_MIN_SCORE
    }))
  );

const ONBOARDING: Array<{ slug: string; subject: string; alt: string }> = [
  {
    slug: 'talk',
    subject:
      'A person at a laptop chatting with a friendly pencil-shaped helper; empty speech balloons containing tiny doodles of a dragon and a castle float between them.',
    alt: 'A person at a laptop chatting with a friendly pencil-shaped helper'
  },
  { slug: 'plan', subject: 'A cork board with a storyboard of small thumbnail panels pinned in rows, string connecting two of them.', alt: 'A cork board with a storyboard of pinned thumbnail panels' },
  { slug: 'draw', subject: 'One comic page that transitions left-to-right from loose pencil sketch to clean ink to full colour.', alt: 'A comic page going from pencil sketch to ink to full colour' },
  { slug: 'letter', subject: 'Two hands arranging empty speech balloons on a finished comic page.', alt: 'Two hands arranging empty speech balloons on a comic page' }
];

const onboardingEntries = (): LibraryManifestEntry[] =>
  ONBOARDING.map((o) => ({
    id: `onboard.${o.slug}`,
    kind: 'onboarding',
    prompt: [o.subject, HOUSE_STYLE, NO_TEXT].join('\n'),
    model: 'nano-banana-2.1',
    resolution: '1K',
    aspect: '16:9',
    theme: 'light',
    tags: ['onboarding', o.slug],
    alt: o.alt,
    subject: o.subject,
    minScore: LIBRARY_MIN_SCORE
  }));

const TEXTURES: Array<{ slug: string; prompt: string; alt: string }> = [
  {
    slug: 'watercolor-paper',
    prompt: 'Flat, evenly lit macro scan of cold-press watercolor paper, off-white, subtle tooth, no stains, no objects, no vignette, uniform.',
    alt: 'Off-white cold-press watercolor paper texture'
  },
  {
    slug: 'newsprint',
    prompt: 'Flat scan of aged newsprint paper, warm grey-cream, fine fibres, faint uneven tone, no print, no text, uniform, no vignette.',
    alt: 'Warm grey-cream newsprint paper texture'
  },
  {
    slug: 'kraft-cover',
    prompt: 'Flat scan of matte kraft cover stock, warm tan, fine fibres, uniform lighting, no objects, no vignette.',
    alt: 'Warm tan kraft paper texture'
  }
];

const textureEntries = (): LibraryManifestEntry[] =>
  TEXTURES.map((t) => ({
    id: `texture.${t.slug}`,
    kind: 'texture_seed',
    prompt: `${t.prompt}\n${NO_TEXT}`,
    model: 'nano-banana-2.1',
    resolution: '2K',
    aspect: '1:1',
    theme: 'any',
    tags: ['texture', 'paper', t.slug],
    alt: t.alt,
    post: 'seamless_tile',
    minScore: LIBRARY_MIN_SCORE
  }));

/**
 * Every manifest entry, in build order: 98 core (24 style scenes, 9 empty states, 4 onboarding,
 * 3 textures, 8 genre pages, 2 covers, then 24 character busts and 24 swatches). The scenes lead
 * so a run cut short by its budget still fills the tiles people see first.
 */
export const LIBRARY_MANIFEST: readonly LibraryManifestEntry[] = Object.freeze([
  ...styleEntries(),
  ...emptyEntries(),
  ...onboardingEntries(),
  ...textureEntries(),
  ...genreEntries(),
  ...coverEntries(),
  ...castEntries(),
  ...anchorEntries()
]);

export const LIBRARY_CORE_COUNT = LIBRARY_MANIFEST.filter((e) => !e.optional).length;

const BY_ID = new Map(LIBRARY_MANIFEST.map((e) => [e.id, e] as const));
export const manifestEntry = (id: string): LibraryManifestEntry | undefined => (typeof id === 'string' ? BY_ID.get(id) : undefined);
export const manifestOrder = (id: string): number => {
  const i = LIBRARY_MANIFEST.findIndex((e) => e.id === id);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
};

/** Stable hash of what is drawn (prompt, model, resolution, aspect, expected text, post). */
export const promptHash = (e: Pick<LibraryManifestEntry, 'prompt' | 'model' | 'resolution' | 'aspect' | 'expectedText' | 'post'>): string =>
  hashString([`v${LIBRARY_MANIFEST_VERSION}`, e.prompt, e.model, e.resolution, e.aspect, e.expectedText?.join('|') || '', e.post || ''].join('\n'));

/** The image must be text-free (everything but covers). */
export const isTextFree = (e: Pick<LibraryManifestEntry, 'expectedText'>): boolean => !e.expectedText?.length;

export const minScoreOf = (e: Pick<LibraryManifestEntry, 'minScore'>): number =>
  Math.max(LIBRARY_MIN_SCORE, typeof e.minScore === 'number' && Number.isFinite(e.minScore) ? Math.min(1, e.minScore) : LIBRARY_MIN_SCORE);

export interface ManifestSelection {
  entries: LibraryManifestEntry[];
  unknown: string[];
}

/**
 * Entries named by a build request. `ids` and `kinds` narrow the selection; optional entries
 * join only when named by id or kind, or with includeOptional. Unknown ids are reported.
 */
export function selectEntries(
  req: { ids?: unknown; kinds?: unknown; includeOptional?: unknown },
  manifest: readonly LibraryManifestEntry[] = LIBRARY_MANIFEST
): ManifestSelection {
  const ids = Array.isArray(req.ids) ? [...new Set(req.ids.filter((x): x is string => typeof x === 'string').map((x) => x.trim()))].slice(0, 200) : [];
  const kinds = Array.isArray(req.kinds) ? new Set(req.kinds.filter((x): x is string => typeof x === 'string')) : null;
  const known = new Set(manifest.map((e) => e.id));
  const unknown = ids.filter((id) => !LIBRARY_ID_RE.test(id) || !known.has(id));
  const optionalOk = (e: LibraryManifestEntry) => !e.optional || req.includeOptional === true;
  let entries = manifest.filter((e) => {
    if (ids.length) return ids.includes(e.id);
    // A kind named explicitly brings its optional entries (style anchors) along.
    if (kinds && kinds.size) return kinds.has(e.kind);
    return optionalOk(e);
  });
  if (ids.length && kinds && kinds.size) entries = entries.filter((e) => kinds.has(e.kind));
  return { entries, unknown };
}
