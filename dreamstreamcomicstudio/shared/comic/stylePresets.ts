// Curated comic art styles. Each `spec` is written as art direction a page model can
// execute: medium, linework, color, shading and what to avoid. Generic phrases like
// "comic style" produce generic art, so every preset names concrete, drawable traits.
// The `swatch` gradient is a UI-only preview used before any image exists.

import type { ColorMode, ComicKind } from './doc.js';

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
    tagline: 'Clean even lines, flat bright color (Tintin-like)',
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
    tagline: 'Ghibli-esque warmth, lush backgrounds',
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
