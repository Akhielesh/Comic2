// Procedural style-preset thumbnail (contract §13.3, assets.md §6; owner P1-LIBRARY).
//
// A tiny painted scene per preset at $0: the SAME composition the library's AI preview uses
// (a girl in a raincoat and her terrier on a stone canal bridge at dusk, a lit bakery window,
// two lanterns, a paper boat, rooftops and a spire), so the procedural tier and the AI tier read
// as one concept. Each preset gets its own treatment (screentone + speed lines for manga, Ben-Day
// dots and CMY misregistration for retro pop, two offset inks and grain for riso, venetian light
// and rain for noir, wet edges and paper grain for watercolor, bokeh for webtoon, …). The 12 looks
// added in Program 3 ST-4 get their own too: ink + one accent, stepped grey washes, misty brush ink,
// an ornamental miniature border, carved woodcut lines, a deco airship and sunburst, concrete blocks,
// a dream moon and floating stairs, chalk streaks on dark paper, a striped retro sun, a halo with
// sacred geometry, and neon edges in the rain. A look's art never depends on another look's code.
// Colours come from the preset's palette (art content, not UI chrome), so the tile looks the
// same — and right — in light and dark themes. Deterministic: no randomness at render time.
// The root keeps the preset's gradient `swatch` as its background (tier 3, under the art).

import React, { useId } from 'react';
import { spotAccentOf, type StylePreset } from '../../../../shared/comic/stylePresets';
import { bokeh, focusLines, luminance, mix, r2, rainPath, rng, screentoneRadius, seedOf, speedLines } from './textures';

export interface PresetThumbProps {
  preset: StylePreset;
  /** Width in px; omitted ⇒ fills its container. */
  size?: number;
}

const W = 160;
const H = 200;

interface Look {
  skyTop: string;
  skyBottom: string;
  city: string;
  wall: string;
  window: string;
  stone: string;
  stoneShade: string;
  water: string;
  waterLine: string;
  coat: string;
  /** The bakery awning; defaults to the coat colour (spot-colour looks keep their accent off it). */
  awning?: string;
  skin: string;
  dog: string;
  ink: string;
  paper: string;
  lamp: string;
  boat: string;
  /** Outline on figures and architecture. */
  line: { color: string; width: number; opacity: number };
  /** Fill filter applied to the painted group ('wet' watercolor edges, 'soft' painterly blur). */
  filter?: 'wet' | 'soft';
}

const pick = (palette: string[], fallback: string, i: number) => palette[i] ?? fallback;

/** Generic roles from any palette: darkest = ink, lightest = paper, the rest accents. */
function baseLook(p: StylePreset): Look {
  const pal = p.palette.filter((c) => /^#[0-9a-f]{6}$/i.test(c));
  const byLum = [...pal].sort((a, b) => luminance(a) - luminance(b));
  const ink = byLum[0] && luminance(byLum[0]) < 0.12 ? byLum[0] : mix(byLum[0] || '#333333', '#141414', 0.6);
  const paper = byLum.at(-1) && luminance(byLum.at(-1)!) > 0.7 ? byLum.at(-1)! : mix(byLum.at(-1) || '#f2efe6', '#ffffff', 0.6);
  const accents = pal.filter((c) => c !== ink && c !== paper);
  const a1 = pick(accents, mix(ink, paper, 0.5), 0);
  const a2 = pick(accents, a1, 1);
  const warmest = [...accents].sort((a, b) => warmth(b) - warmth(a))[0] || mix(paper, '#ffb347', 0.7);
  return {
    skyTop: mix(a1, ink, 0.25),
    skyBottom: mix(a2, paper, 0.35),
    city: mix(ink, a1, 0.25),
    wall: mix(ink, paper, 0.32),
    window: mix(warmest, paper, 0.25),
    stone: mix(ink, paper, 0.55),
    stoneShade: mix(ink, paper, 0.4),
    water: mix(a1, ink, 0.45),
    waterLine: mix(a1, paper, 0.5),
    coat: warmest,
    skin: mix(paper, '#e8b48f', 0.55),
    dog: mix(ink, paper, 0.62),
    ink,
    paper,
    lamp: mix(warmest, '#ffe08a', 0.4),
    boat: paper,
    line: { color: ink, width: 1.1, opacity: 0.9 }
  };
}

/** How warm (red/yellow) a colour is, for picking the lamp and raincoat. */
function warmth(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return r * 1.2 + g * 0.5 - b * 1.1 - Math.abs(r - g) * 0.1;
}

/** Per-preset colour tweaks on top of the generic roles. */
function lookFor(p: StylePreset): Look {
  const L = baseLook(p);
  const [c0, c1, c2, c3] = p.palette;
  switch (p.id) {
    case 'noir-ink':
      return {
        ...L,
        skyTop: '#060606',
        skyBottom: '#2a2a28',
        city: '#0b0b0b',
        wall: '#141414',
        window: mix(L.paper, '#d8d2c0', 0.4),
        stone: '#3a3a38',
        stoneShade: '#232322',
        water: '#0b0b0b',
        waterLine: '#6e6c66',
        coat: '#bdbab2',
        skin: '#d9d5cc',
        dog: '#8f8c85',
        lamp: c2 || '#9b1c1c',
        boat: c2 || '#9b1c1c',
        line: { color: '#000000', width: 1.3, opacity: 1 }
      };
    case 'manga-screentone':
      return {
        ...L,
        skyTop: '#ffffff',
        skyBottom: '#ffffff',
        city: '#d9d9d9',
        wall: '#efefef',
        window: '#ffffff',
        stone: '#f4f4f4',
        stoneShade: '#cfcfcf',
        water: '#ffffff',
        waterLine: '#9a9a9a',
        coat: '#ffffff',
        skin: '#ffffff',
        dog: '#bdbdbd',
        lamp: '#ffffff',
        boat: '#ffffff',
        line: { color: '#111111', width: 1.15, opacity: 1 }
      };
    case 'retro-pop':
      return {
        ...L,
        skyTop: c2 || L.skyTop,
        skyBottom: mix(c3 || L.paper, c1 || '#fcbf49', 0.25),
        city: c2 || L.city,
        wall: mix(c2 || '#003049', '#f7ede2', 0.2),
        window: c1 || L.window,
        stone: mix(c3 || '#f7ede2', '#c9b9a6', 0.5),
        stoneShade: mix(c2 || '#003049', '#f7ede2', 0.45),
        water: mix(c2 || '#003049', '#3a6ea5', 0.35),
        waterLine: c3 || L.paper,
        coat: c0 || L.coat,
        lamp: c1 || L.lamp,
        boat: c3 || L.paper,
        line: { color: '#111111', width: 1.8, opacity: 1 }
      };
    case 'indie-risograph':
      return {
        ...L,
        skyTop: mix(c2 || L.paper, c0 || '#ff48b0', 0.18),
        skyBottom: c2 || L.paper,
        city: mix(c1 || '#00838a', c2 || '#fdf6e3', 0.25),
        wall: mix(c1 || '#00838a', c2 || '#fdf6e3', 0.45),
        window: mix(c0 || '#ff48b0', c2 || '#fdf6e3', 0.35),
        stone: mix(c0 || '#ff48b0', c2 || '#fdf6e3', 0.62),
        stoneShade: mix(c0 || '#ff48b0', c2 || '#fdf6e3', 0.35),
        water: mix(c1 || '#00838a', c2 || '#fdf6e3', 0.2),
        waterLine: c2 || L.paper,
        coat: c0 || L.coat,
        skin: mix(c0 || '#ff48b0', c2 || '#fdf6e3', 0.78),
        dog: mix(c1 || '#00838a', c2 || '#fdf6e3', 0.55),
        lamp: c0 || L.lamp,
        boat: c2 || L.paper,
        line: { color: c1 || '#00838a', width: 1.2, opacity: 0.95 }
      };
    case 'watercolor-storybook':
      return {
        ...L,
        skyTop: mix(c0 || '#f2cc8f', c2 || '#e07a5f', 0.35),
        skyBottom: mix(c0 || '#f2cc8f', c3 || '#f4f1de', 0.5),
        city: mix(c1 || '#81b29a', '#5b6e78', 0.4),
        wall: mix(c2 || '#e07a5f', c3 || '#f4f1de', 0.55),
        window: mix(c0 || '#f2cc8f', '#fff2c4', 0.4),
        stone: mix(c3 || '#f4f1de', '#b9ab95', 0.55),
        stoneShade: mix(c3 || '#f4f1de', '#8f8371', 0.6),
        water: mix(c1 || '#81b29a', '#6f9fb5', 0.5),
        waterLine: c3 || L.paper,
        coat: c0 || L.coat,
        dog: mix('#9a8068', c3 || '#f4f1de', 0.3),
        lamp: mix(c0 || '#f2cc8f', '#ffe7a8', 0.5),
        line: { color: '#5a4a3c', width: 0.8, opacity: 0.55 },
        filter: 'wet'
      };
    case 'graphic-novel-painterly':
      return {
        ...L,
        skyTop: c0 || L.skyTop,
        skyBottom: mix(c1 || '#2a9d8f', c3 || '#e76f51', 0.45),
        city: mix(c0 || '#264653', '#0f1d24', 0.4),
        wall: mix(c0 || '#264653', '#1b2a30', 0.3),
        window: c2 || L.window,
        stone: mix(c0 || '#264653', '#7d8a85', 0.5),
        stoneShade: mix(c0 || '#264653', '#0f1d24', 0.3),
        water: mix(c0 || '#264653', '#0d1a20', 0.35),
        waterLine: mix(c2 || '#e9c46a', c1 || '#2a9d8f', 0.4),
        coat: c3 || L.coat,
        lamp: c2 || L.lamp,
        line: { color: '#0f1d24', width: 0.5, opacity: 0.35 },
        filter: 'soft'
      };
    case 'dark-fantasy':
      return {
        ...L,
        skyTop: c0 || '#1b1b2f',
        skyBottom: mix(c1 || '#4e4e6a', c0 || '#1b1b2f', 0.3),
        city: mix(c0 || '#1b1b2f', '#05050a', 0.5),
        wall: mix(c0 || '#1b1b2f', '#05050a', 0.3),
        window: mix(c3 || '#8ac926', '#e8ffd0', 0.15),
        stone: mix(c1 || '#4e4e6a', c0 || '#1b1b2f', 0.35),
        stoneShade: mix(c0 || '#1b1b2f', '#05050a', 0.4),
        water: mix(c0 || '#1b1b2f', '#05050a', 0.55),
        waterLine: mix(c3 || '#8ac926', c1 || '#4e4e6a', 0.5),
        coat: c2 || L.coat,
        skin: '#c9c1d6',
        dog: mix(c1 || '#4e4e6a', '#9a96a8', 0.35),
        lamp: c3 || L.lamp,
        boat: '#c9c1d6',
        line: { color: '#05050a', width: 1.1, opacity: 0.95 }
      };
    case 'modern-heroic':
      return {
        ...L,
        skyTop: c0 || L.skyTop,
        skyBottom: mix(c1 || '#e63946', c3 || '#ffb703', 0.55),
        city: mix(c0 || '#1d3557', '#0a1426', 0.45),
        wall: mix(c0 || '#1d3557', '#0a1426', 0.25),
        window: c3 || L.window,
        stone: mix(c0 || '#1d3557', '#8b98a8', 0.45),
        stoneShade: mix(c0 || '#1d3557', '#0a1426', 0.35),
        water: mix(c0 || '#1d3557', '#0a1426', 0.4),
        waterLine: c3 || L.waterLine,
        coat: c1 || L.coat,
        lamp: c3 || L.lamp,
        line: { color: '#06080f', width: 1.5, opacity: 1 }
      };
    case 'cozy-anime':
      return {
        ...L,
        skyTop: mix(c2 || '#577590', '#9cc3d5', 0.45),
        skyBottom: mix(c1 || '#f9c74f', c3 || '#f8f4e3', 0.35),
        city: mix(c2 || '#577590', '#8aa0ae', 0.45),
        wall: mix(c3 || '#f8f4e3', '#d9c7a7', 0.55),
        window: mix(c1 || '#f9c74f', '#fff3c4', 0.35),
        stone: mix(c3 || '#f8f4e3', '#bfb29b', 0.55),
        stoneShade: mix(c3 || '#f8f4e3', '#8f8270', 0.55),
        water: mix(c2 || '#577590', '#7fb3c8', 0.45),
        waterLine: c3 || L.paper,
        coat: c1 || L.coat,
        lamp: c1 || L.lamp,
        line: { color: '#3b4a52', width: 0.8, opacity: 0.85 }
      };
    case 'webtoon-cel':
      return {
        ...L,
        skyTop: mix(c2 || '#cdb4db', c1 || '#a2d2ff', 0.4),
        skyBottom: mix(c0 || '#ff8fab', c3 || '#fff1e6', 0.45),
        city: mix(c2 || '#cdb4db', '#7d6e93', 0.4),
        wall: mix(c2 || '#cdb4db', '#8e7aa8', 0.35),
        window: mix(c3 || '#fff1e6', '#ffe0b8', 0.4),
        stone: mix(c3 || '#fff1e6', '#c9b8cf', 0.55),
        stoneShade: mix(c2 || '#cdb4db', '#8e7aa8', 0.35),
        water: mix(c1 || '#a2d2ff', '#6f8fc9', 0.4),
        waterLine: c3 || L.paper,
        coat: c0 || L.coat,
        lamp: mix(c3 || '#fff1e6', '#ffd29e', 0.5),
        line: { color: '#4a3d5c', width: 0.6, opacity: 0.8 }
      };
    case 'cartoon-strip':
      return {
        ...L,
        skyTop: mix(c2 || '#118ab2', '#7cd3f0', 0.35),
        skyBottom: mix(c2 || '#118ab2', '#e9f8ff', 0.75),
        city: mix(c1 || '#06d6a0', '#047a5c', 0.45),
        wall: c3 || L.wall,
        window: c0 || L.window,
        stone: '#e9dcc4',
        stoneShade: '#c8b38f',
        water: c2 || L.water,
        waterLine: '#e9f8ff',
        coat: c0 || L.coat,
        lamp: c0 || L.lamp,
        boat: '#ffffff',
        line: { color: '#1a1a1a', width: 2.2, opacity: 1 }
      };
    case 'ligne-claire':
      return {
        ...L,
        skyTop: c0 || L.skyTop,
        skyBottom: mix(c0 || '#2a6fdb', c3 || '#f5f1e6', 0.6),
        city: mix(c0 || '#2a6fdb', '#24324a', 0.35),
        wall: c2 || L.wall,
        window: c1 || L.window,
        stone: mix(c3 || '#f5f1e6', '#cbb79b', 0.5),
        stoneShade: mix(c3 || '#f5f1e6', '#9c8a70', 0.55),
        water: mix(c0 || '#2a6fdb', '#174a9c', 0.3),
        waterLine: c3 || L.paper,
        coat: c1 || L.coat,
        lamp: c1 || L.lamp,
        line: { color: '#141414', width: 1.5, opacity: 1 }
      };
    // ── ST-4 looks ──
    case 'ink-one-colour': {
      const accent = spotAccentOf(p.palette) || c2 || '#d62839';
      const ink = c0 || '#111111';
      const paper = c1 || '#fafafa';
      return {
        ...L,
        skyTop: mix(paper, ink, 0.16),
        skyBottom: paper,
        city: ink,
        wall: mix(ink, paper, 0.12),
        window: paper,
        stone: mix(paper, ink, 0.04),
        stoneShade: mix(paper, ink, 0.28),
        water: mix(paper, ink, 0.08),
        waterLine: ink,
        coat: accent,
        awning: mix(ink, paper, 0.3),
        skin: paper,
        dog: mix(paper, ink, 0.4),
        ink,
        paper,
        lamp: paper,
        boat: accent,
        line: { color: ink, width: 1.4, opacity: 1 }
      };
    }
    case 'mono-wash': {
      const accent = spotAccentOf(p.palette) || c3 || '#2b59c3';
      const ink = c0 || '#1a1a1a';
      const grey = c1 || '#9a9a9a';
      const paper = c2 || '#f7f7f5';
      return {
        ...L,
        skyTop: mix(grey, paper, 0.55),
        skyBottom: paper,
        city: mix(grey, paper, 0.15),
        wall: mix(grey, ink, 0.35),
        window: paper,
        stone: mix(grey, paper, 0.78),
        stoneShade: mix(grey, paper, 0.4),
        water: mix(grey, paper, 0.5),
        waterLine: paper,
        coat: mix(grey, ink, 0.12),
        awning: mix(grey, ink, 0.55),
        skin: paper,
        dog: mix(grey, paper, 0.3),
        ink,
        paper,
        lamp: paper,
        boat: accent,
        line: { color: ink, width: 0.9, opacity: 1 }
      };
    }
    case 'ink-wash':
      return {
        ...L,
        skyTop: mix(c3 || '#f3efe4', c2 || '#a8a8a2', 0.3),
        skyBottom: c3 || L.paper,
        city: mix(c1 || '#5c5c5c', c3 || '#f3efe4', 0.35),
        wall: c1 || L.wall,
        window: c3 || L.paper,
        stone: mix(c3 || '#f3efe4', c2 || '#a8a8a2', 0.35),
        stoneShade: c2 || L.stoneShade,
        water: mix(c3 || '#f3efe4', c2 || '#a8a8a2', 0.2),
        waterLine: c1 || L.waterLine,
        coat: c0 || L.ink,
        awning: c1 || L.wall,
        skin: c3 || L.paper,
        dog: c2 || L.dog,
        lamp: c3 || L.paper,
        boat: c3 || L.paper,
        line: { color: c0 || '#141414', width: 1.7, opacity: 0.85 },
        filter: 'wet'
      };
    case 'indian-miniature':
      return {
        ...L,
        skyTop: c0 || L.skyTop,
        skyBottom: mix(c0 || '#1f3a93', p.palette[4] || '#f5ead0', 0.35),
        city: c2 || L.city,
        wall: c1 || L.wall,
        window: c3 || L.window,
        stone: mix(p.palette[4] || '#f5ead0', c3 || '#f1c40f', 0.25),
        stoneShade: mix(p.palette[4] || '#f5ead0', c1 || '#c0392b', 0.35),
        water: mix(c0 || '#1f3a93', c2 || '#1e8449', 0.4),
        waterLine: c3 || L.waterLine,
        coat: c3 || L.coat,
        awning: c2 || L.coat,
        skin: mix(p.palette[4] || '#f5ead0', '#c68b59', 0.55),
        dog: mix(p.palette[4] || '#f5ead0', '#8d6e63', 0.5),
        lamp: c3 || L.lamp,
        boat: p.palette[4] || L.paper,
        line: { color: '#3b2412', width: 0.9, opacity: 0.9 }
      };
    case 'woodcut':
      return {
        ...L,
        skyTop: c2 || L.paper,
        skyBottom: c2 || L.paper,
        city: c0 || L.ink,
        wall: c0 || L.ink,
        window: c2 || L.paper,
        stone: c2 || L.paper,
        stoneShade: c0 || L.ink,
        water: c0 || L.ink,
        waterLine: c2 || L.paper,
        coat: c2 || L.paper,
        awning: c2 || L.paper,
        skin: c2 || L.paper,
        dog: c2 || L.paper,
        lamp: c2 || L.paper,
        boat: c2 || L.paper,
        line: { color: c0 || '#111111', width: 1.8, opacity: 1 }
      };
    case 'dieselpunk':
      return {
        ...L,
        skyTop: mix(c1 || '#6b5b45', c0 || '#2b2b2b', 0.35),
        skyBottom: c3 || L.skyBottom,
        city: c0 || L.city,
        wall: mix(c0 || '#2b2b2b', c1 || '#6b5b45', 0.3),
        window: mix(c2 || '#b08d57', '#ffe2a0', 0.4),
        stone: mix(c1 || '#6b5b45', c3 || '#d9c7a1', 0.45),
        stoneShade: c1 || L.stoneShade,
        water: mix(c0 || '#2b2b2b', c1 || '#6b5b45', 0.4),
        waterLine: c2 || L.waterLine,
        coat: c2 || L.coat,
        awning: c1 || L.coat,
        skin: mix(c3 || '#d9c7a1', '#e8b48f', 0.4),
        dog: mix(c1 || '#6b5b45', c3 || '#d9c7a1', 0.4),
        lamp: mix(c2 || '#b08d57', '#ffe2a0', 0.5),
        boat: c3 || L.paper,
        line: { color: '#1a1a1a', width: 1.4, opacity: 1 }
      };
    case 'brutalist':
      return {
        ...L,
        skyTop: c2 || L.paper,
        skyBottom: c2 || L.paper,
        city: c1 || L.city,
        wall: c1 || L.wall,
        window: mix(c0 || '#1a1a1a', c1 || '#8c8c88', 0.45),
        stone: mix(c1 || '#8c8c88', c2 || '#d6d4ce', 0.5),
        stoneShade: c1 || L.stoneShade,
        water: c0 || L.water,
        waterLine: c1 || L.waterLine,
        coat: c3 || L.coat,
        awning: c0 || L.ink,
        skin: c2 || L.paper,
        dog: c1 || L.dog,
        lamp: c2 || L.paper,
        boat: c2 || L.paper,
        line: { color: c0 || '#1a1a1a', width: 0.6, opacity: 0.7 }
      };
    case 'surreal-dream':
      return {
        ...L,
        skyTop: c0 || L.skyTop,
        skyBottom: c2 || L.skyBottom,
        city: mix(c0 || '#2e1f4f', c1 || '#3aa6a0', 0.5),
        wall: mix(c0 || '#2e1f4f', c1 || '#3aa6a0', 0.3),
        window: c3 || L.window,
        stone: mix(c3 || '#f7e7ce', c2 || '#f4a582', 0.3),
        stoneShade: mix(c2 || '#f4a582', c0 || '#2e1f4f', 0.3),
        water: mix(c1 || '#3aa6a0', c0 || '#2e1f4f', 0.4),
        waterLine: c3 || L.waterLine,
        coat: c1 || L.coat,
        awning: c2 || L.coat,
        skin: c3 || L.skin,
        dog: mix(c2 || '#f4a582', c3 || '#f7e7ce', 0.5),
        lamp: c3 || L.lamp,
        boat: c3 || L.paper,
        line: { color: c0 || '#2e1f4f', width: 0.9, opacity: 0.9 }
      };
    case 'chalk-pastel':
      return {
        ...L,
        skyTop: c0 || L.skyTop,
        skyBottom: mix(c1 || '#5d6d8a', c0 || '#22252b', 0.4),
        city: mix(c0 || '#22252b', c1 || '#5d6d8a', 0.4),
        wall: mix(c0 || '#22252b', c1 || '#5d6d8a', 0.25),
        window: mix(c2 || '#c98e9a', c3 || '#e8dfd0', 0.4),
        stone: c1 || L.stone,
        stoneShade: mix(c0 || '#22252b', c1 || '#5d6d8a', 0.3),
        water: mix(c0 || '#22252b', '#2a2e36', 0.5),
        waterLine: c3 || L.waterLine,
        coat: c2 || L.coat,
        skin: c3 || L.skin,
        dog: mix(c1 || '#5d6d8a', c3 || '#e8dfd0', 0.45),
        lamp: c3 || L.lamp,
        boat: c3 || L.paper,
        line: { color: c3 || '#e8dfd0', width: 0.9, opacity: 0.7 }
      };
    case 'retrofuturism':
      return {
        ...L,
        skyTop: c1 || L.skyTop,
        skyBottom: c3 || L.skyBottom,
        city: mix(c1 || '#17bebb', p.palette[4] || '#2e282a', 0.45),
        wall: c0 || L.wall,
        window: c2 || L.window,
        stone: mix(c3 || '#f6f0e1', c2 || '#ffc914', 0.3),
        stoneShade: mix(c0 || '#e4572e', c3 || '#f6f0e1', 0.45),
        water: mix(c1 || '#17bebb', p.palette[4] || '#2e282a', 0.25),
        waterLine: c3 || L.waterLine,
        coat: c2 || L.coat,
        awning: c1 || L.coat,
        skin: mix(c3 || '#f6f0e1', '#e8b48f', 0.5),
        dog: mix(p.palette[4] || '#2e282a', c3 || '#f6f0e1', 0.55),
        lamp: c2 || L.lamp,
        boat: c3 || L.paper,
        line: { color: p.palette[4] || '#2e282a', width: 1.4, opacity: 1 }
      };
    case 'mythic-icon':
      return {
        ...L,
        skyTop: c0 || L.skyTop,
        skyBottom: mix(c0 || '#14213d', c1 || '#9d0208', 0.35),
        city: mix(c0 || '#14213d', '#05070d', 0.4),
        wall: c1 || L.wall,
        window: c2 || L.window,
        stone: mix(c3 || '#f5ecd7', c2 || '#d4a017', 0.3),
        stoneShade: mix(c0 || '#14213d', c3 || '#f5ecd7', 0.45),
        water: c0 || L.water,
        waterLine: c2 || L.waterLine,
        coat: c1 || L.coat,
        awning: c2 || L.coat,
        skin: c3 || L.skin,
        dog: mix(c3 || '#f5ecd7', c0 || '#14213d', 0.4),
        lamp: c2 || L.lamp,
        boat: c3 || L.paper,
        line: { color: '#0a0f1f', width: 1.2, opacity: 1 }
      };
    case 'cyberpunk':
      return {
        ...L,
        skyTop: c0 || L.skyTop,
        skyBottom: mix(c3 || '#7b2cbf', c0 || '#0b0c1a', 0.5),
        city: mix(c0 || '#0b0c1a', '#000000', 0.4),
        wall: mix(c0 || '#0b0c1a', c3 || '#7b2cbf', 0.2),
        window: c2 || L.window,
        stone: mix(c0 || '#0b0c1a', c3 || '#7b2cbf', 0.3),
        stoneShade: c0 || L.stoneShade,
        water: mix(c0 || '#0b0c1a', '#000000', 0.3),
        waterLine: c1 || L.waterLine,
        coat: c1 || L.coat,
        awning: c3 || L.coat,
        skin: '#d7c9f0',
        dog: mix(c3 || '#7b2cbf', '#9a96a8', 0.4),
        lamp: c2 || L.lamp,
        boat: '#d7c9f0',
        line: { color: c2 || '#00e5ff', width: 0.7, opacity: 0.75 }
      };
    default:
      return L;
  }
}

// ── Scene geometry (viewBox 160×200) ─────────────────────────────────────────

const CITY =
  'M0 98V84h12v-7h12v9h13V72l12-9 12 9v15h14V78h15v12h10V70h5l4-25 4 25h5v16h13V74h17v24Z';
const BRIDGE = 'M-2 116H162V154H140C140 132 112 125 80 125C48 125 20 132 20 154H-2Z';
const PARAPET = 'M-2 108H162V116H-2Z';
const COAT = 'M40.5 92.5C38.6 99 37.2 105 35.6 111.2h17.2C51.4 105 49.8 99 47.6 92.5c-2.3-1.3-4.8-1.3-7.1 0Z';
const HOOD = 'M38.9 88.6c0-4.2 2.4-6.9 5.2-6.9s5.2 2.7 5.2 6.9c-1.1-1.6-2.8-2.5-5.2-2.5s-4.1.9-5.2 2.5Z';
const ARM = 'M47.2 96.4l9.8 6.6';
const DOG_BODY = 'M58 111.6c0-3.4 2.9-5.4 7.1-5.4 3.2 0 5.1 1.2 5.9 3.1l-.6 2.6Z';
const DOG_EAR = 'M69.8 103.6l1.1-3 1.3 3.4Z';
const DOG_TAIL = 'M58.4 108.2c-1.8-1.6-2.4-3.6-1.9-5.6';
const BOAT_HULL = 'M89 167h20l-4.2 6h-11.6Z';
const BOAT_SAIL = 'M99.2 157.5v9.5h-6.8Z';
const STONES = 'M8 132h18M30 140h14M114 140h16M134 132h20M6 146h10M146 146h10M40 120v-4M80 120v-4M120 120v-4';

// ── Geometry helpers for the ST-4 treatments (deterministic; every number rounded by r2) ──────

/** Diagonal pen hatching over a box: `n` strokes `gap` apart, each leaning left by `lean` × height. */
const hatchPath = (x: number, y: number, w: number, h: number, gap: number, lean = 0.6): string => {
  const parts: string[] = [];
  for (let i = 0; x + i * gap <= x + w + h * lean; i += 1) parts.push(`M${r2(x + i * gap)} ${r2(y)}l${r2(-h * lean)} ${r2(h)}`);
  return parts.join('');
};

/** Thin wedge rays fanning from (cx, cy) between angles a0 and a1 (radians), every other one drawn. */
const raysPath = (cx: number, cy: number, r: number, count: number, a0: number, a1: number, spread: number): string => {
  const parts: string[] = [];
  for (let i = 0; i < count; i += 2) {
    const a = a0 + ((i + 0.5) / count) * (a1 - a0);
    const p1 = [cx + r * Math.cos(a - spread), cy + r * Math.sin(a - spread)];
    const p2 = [cx + r * Math.cos(a + spread), cy + r * Math.sin(a + spread)];
    parts.push(`M${r2(cx)} ${r2(cy)}L${r2(p1[0])} ${r2(p1[1])}L${r2(p2[0])} ${r2(p2[1])}Z`);
  }
  return parts.join('');
};

/** Straight spokes from radius r0 to r1 around (cx, cy) between angles a0 and a1. */
const spokesPath = (cx: number, cy: number, r0: number, r1: number, count: number, a0: number, a1: number): string => {
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const a = a0 + (i / Math.max(1, count - 1)) * (a1 - a0);
    parts.push(`M${r2(cx + r0 * Math.cos(a))} ${r2(cy + r0 * Math.sin(a))}L${r2(cx + r1 * Math.cos(a))} ${r2(cy + r1 * Math.sin(a))}`);
  }
  return parts.join('');
};

/** Seeded horizontal strokes (woodcut cut lines, chalk streaks): one per row from y0 to y1. */
const strokeRows = (seed: string, y0: number, y1: number, step: number, minLen: number, maxLen: number, maxX: number, tilt = 0): string => {
  const r = rng(seedOf(seed));
  const parts: string[] = [];
  for (let y = y0; y <= y1; y += step) parts.push(`M${r2(r() * maxX)} ${r2(y)}l${r2(minLen + r() * (maxLen - minLen))} ${r2(tilt)}`);
  return parts.join('');
};

/** Seeded lit windows on the skyline. */
const litWindows = (seed: string, count: number): Array<{ x: number; y: number; on: boolean }> => {
  const r = rng(seedOf(seed));
  return Array.from({ length: count }, (_, i) => ({ x: r2(4 + r() * 88), y: r2(78 + r() * 16), on: i % 3 !== 0 }));
};

/** The girl's head after the figure group's scale (the halo centre). */
const HEAD = { x: 40.55, y: 76.56 };

const LineProps = (l: Look['line']) => ({ stroke: l.color, strokeWidth: l.width, strokeOpacity: l.opacity, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const });

/** The shared composition, coloured by `look`; `drawn` toggles outlines. */
const Scene: React.FC<{ look: Look; uid: string; filter?: string }> = ({ look, uid, filter }) => {
  const line = LineProps(look.line);
  return (
    <g filter={filter}>
      <rect width={W} height={H} fill={`url(#${uid}-sky)`} />
      <path d={CITY} fill={look.city} />
      {/* Bakery: wall, warm window, awning, two hanging lanterns. */}
      <rect x={98} y={74} width={50} height={36} fill={look.wall} />
      <rect x={105} y={84} width={34} height={20} rx={1.5} fill={look.window} />
      <path d="M105 94h34M116.3 84v20M127.6 84v20" stroke={mix(look.window, look.wall, 0.45)} strokeWidth={0.9} />
      <path d="M100 74h46l-3 6h-40Z" fill={look.awning ?? look.coat} opacity={0.9} />
      <path d="M92 70v9M152 70v9" stroke={look.ink} strokeWidth={0.6} strokeOpacity={0.7} />
      <circle cx={92} cy={81} r={2.6} fill={look.lamp} />
      <circle cx={152} cy={81} r={2.6} fill={look.lamp} />
      {/* Canal + reflections; the arch's shadowed underside frames the water. */}
      <rect x={0} y={138} width={W} height={62} fill={look.water} />
      <path d="M20 154C20 132 48 125 80 125C112 125 140 132 140 154Z" fill={mix(look.water, look.ink, 0.45)} />
      <path d="M26 150C30 136 52 131 80 131C108 131 130 136 134 150" stroke={look.waterLine} strokeWidth={0.8} strokeOpacity={0.3} fill="none" />
      <path d="M8 164h20M36 172h30M112 182h26M122 160h18M60 190h24M10 186h14" stroke={look.waterLine} strokeWidth={1.1} strokeOpacity={0.55} strokeLinecap="round" />
      <path d="M118 158v26M126 160v18" stroke={look.window} strokeWidth={2.2} strokeOpacity={0.28} strokeLinecap="round" />
      {/* Bridge. */}
      <path d={BRIDGE} fill={look.stone} {...line} />
      <path d={PARAPET} fill={look.stoneShade} {...line} />
      <path d={STONES} stroke={look.stoneShade} strokeWidth={0.9} strokeLinecap="round" />
      {/* Paper boat. */}
      <path d={BOAT_HULL} fill={look.boat} {...line} />
      <path d={BOAT_SAIL} fill={look.boat} {...line} />
      {/* Girl in a raincoat pointing at the boat, and her terrier (scaled up from the deck so they read at thumbnail size). */}
      <g transform="translate(52 116) scale(1.45) translate(-52 -116)">
      <path d="M41.2 111v5M47 111v5" stroke={look.ink} strokeWidth={2} strokeLinecap="round" />
      <path d={COAT} fill={look.coat} {...line} />
      <circle cx={44.1} cy={88.8} r={4.4} fill={look.skin} {...line} />
      <path d={HOOD} fill={look.coat} {...line} />
      <path d={ARM} stroke={look.coat} strokeWidth={2.6} strokeLinecap="round" />
      <path d={ARM} stroke={look.line.color} strokeWidth={0.5} strokeOpacity={look.line.opacity * 0.6} strokeLinecap="round" />
      <path d="M60.4 111.6v4.4M68.6 111.6v4.4" stroke={look.ink} strokeWidth={1.4} strokeLinecap="round" />
      <path d={DOG_BODY} fill={look.dog} {...line} />
      <circle cx={70.6} cy={106.4} r={3} fill={look.dog} {...line} />
      <path d={DOG_EAR} fill={look.ink} />
      <path d={DOG_TAIL} stroke={look.dog} strokeWidth={1.6} strokeLinecap="round" fill="none" />
      </g>
    </g>
  );
};

/** Per-preset overlays and filters (drawn after the scene). */
const Treatment: React.FC<{ preset: StylePreset; look: Look; uid: string }> = ({ preset, look, uid }) => {
  switch (preset.id) {
    case 'noir-ink':
      return (
        <g>
          {/* Venetian-blind light slashes and rain. */}
          {[0, 1, 2, 3, 4].map((i) => (
            <path key={i} d={`M${-20 + i * 16} 0l${70} 0l-90 200h-6Z`} fill={look.paper} opacity={0.05 + (i % 2) * 0.03} />
          ))}
          <path d={rainPath(preset.id, { w: W, h: H, count: 46, slant: -0.22, len: 10 })} stroke="#d9d5cc" strokeWidth={0.5} strokeOpacity={0.45} strokeLinecap="round" />
          <circle cx={92} cy={81} r={7} fill={look.lamp} opacity={0.22} />
        </g>
      );
    case 'manga-screentone':
      return (
        <g>
          <rect width={W} height={64} fill={`url(#${uid}-tone)`} opacity={0.75} />
          <rect y={154} width={W} height={46} fill={`url(#${uid}-tone)`} opacity={0.4} />
          {speedLines(preset.id, 99, 166, { w: W, h: H, count: 30, inner: 0.24 }).map((l, i) => (
            <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="#111111" strokeWidth={l.w * 0.7} strokeOpacity={0.35} />
          ))}
        </g>
      );
    case 'retro-pop':
      return (
        <g>
          <rect width={W} height={96} fill={`url(#${uid}-benday)`} opacity={0.5} />
          {/* CMY misregistration on the figures. */}
          <g transform="translate(1.4 0.9) translate(52 116) scale(1.45) translate(-52 -116)" opacity={0.55} fill="none" stroke="#00a5d6" strokeWidth={0.8}>
            <path d={COAT} />
            <path d={DOG_BODY} />
          </g>
          <path d={BOAT_HULL} transform="translate(1.4 0.9)" fill="none" stroke="#00a5d6" strokeWidth={1.1} opacity={0.55} />
          <g transform="translate(-1.1 -0.6) translate(52 116) scale(1.45) translate(-52 -116)" opacity={0.45} fill="none" stroke="#e5007e" strokeWidth={0.7}>
            <path d={COAT} />
            <circle cx={44.1} cy={88.8} r={4.4} />
          </g>
        </g>
      );
    case 'indie-risograph':
      return (
        <g style={{ mixBlendMode: 'multiply' }}>
          <g transform="translate(1.6 1.1)" fill="none" stroke={preset.palette[0] || '#ff48b0'} strokeWidth={1.1} opacity={0.7}>
            <path d={BRIDGE} />
            <path d={CITY} />
          </g>
          <path d={COAT} transform="translate(1.6 1.1) translate(52 116) scale(1.45) translate(-52 -116)" fill="none" stroke={preset.palette[0] || '#ff48b0'} strokeWidth={0.8} opacity={0.7} />
          <rect width={W} height={H} filter={`url(#${uid}-grain)`} opacity={0.5} />
        </g>
      );
    case 'watercolor-storybook':
      return <rect width={W} height={H} filter={`url(#${uid}-grain)`} opacity={0.55} />;
    case 'webtoon-cel':
      return (
        <g filter={`url(#${uid}-blur)`}>
          {bokeh(preset.id, { w: W, h: 96, count: 10, minR: 3, maxR: 9 }).map((b, i) => (
            <circle key={i} cx={b.x} cy={b.y} r={b.r} fill={i % 2 ? look.paper : look.lamp} opacity={b.o * 0.7} />
          ))}
        </g>
      );
    case 'graphic-novel-painterly':
      return (
        <g>
          <ellipse cx={122} cy={94} rx={34} ry={22} fill={`url(#${uid}-glow)`} />
          <rect width={W} height={H} filter={`url(#${uid}-grain)`} opacity={0.35} />
        </g>
      );
    case 'dark-fantasy':
      return (
        <g>
          <rect y={118} width={W} height={46} fill={`url(#${uid}-fog)`} />
          <circle cx={92} cy={81} r={9} fill={`url(#${uid}-glow)`} />
          <circle cx={152} cy={81} r={9} fill={`url(#${uid}-glow)`} />
        </g>
      );
    case 'cozy-anime':
      return (
        <g>
          {[
            [6, 112, 13],
            [18, 104, 11],
            [2, 98, 9],
            [154, 140, 12],
            [146, 132, 9]
          ].map(([x, y, r], i) => (
            <circle key={i} cx={x} cy={y} r={r} fill={mix(preset.palette[0] || '#90be6d', '#3f6b3a', (i % 3) * 0.18)} />
          ))}
          <circle cx={30} cy={34} r={14} fill={look.lamp} opacity={0.35} filter={`url(#${uid}-blur)`} />
        </g>
      );
    case 'modern-heroic':
      return (
        <g>
          <path d={focusLines(preset.id, { w: W, h: H, count: 22, inner: 0.62 })} fill={look.paper} opacity={0.08} />
          {/* Rim light on the figures' far edges. */}
          <g transform="translate(52 116) scale(1.45) translate(-52 -116)" fill="none" stroke={look.lamp} strokeWidth={0.7} strokeLinecap="round">
            <path d="M47.9 93.4c2 5.6 3.4 11.4 4.6 17.4" />
            <path d="M48.3 86.6a4.4 4.4 0 0 1 0 4.4" />
            <path d="M71 108.4c-.1 1.4-.6 2.6-1.4 3.2" />
          </g>
        </g>
      );
    case 'cartoon-strip':
      return <rect x={1.5} y={1.5} width={W - 3} height={H - 3} rx={3} fill="none" stroke="#1a1a1a" strokeWidth={3} />;
    case 'ligne-claire':
      return null;
    // ── ST-4 looks ──
    case 'ink-one-colour':
      return (
        <g fill="none" strokeLinecap="round">
          {/* Pen hatching in the sky and under the arch; the one accent stays on the coat and the boat. */}
          <path d={hatchPath(0, 0, W, 56, 6)} stroke={look.ink} strokeWidth={0.5} strokeOpacity={0.3} />
          <path d={hatchPath(24, 140, 112, 12, 4, 0.4)} stroke={look.ink} strokeWidth={0.6} strokeOpacity={0.55} />
          <path d="M93 177h14M96 181h8" stroke={look.boat} strokeWidth={1.2} strokeOpacity={0.55} />
        </g>
      );
    case 'mono-wash':
      return (
        <g>
          {/* Hard-edged grey wash steps, no texture; the cool accent is the boat alone. */}
          <path d="M0 60H160V98H0Z" fill={look.ink} opacity={0.08} />
          <path d="M-2 140H162V154H140C140 146 118 141 80 141C42 141 20 146 20 154H-2Z" fill={look.ink} opacity={0.12} />
          <path d="M0 184H160V200H0Z" fill={look.ink} opacity={0.1} />
          <path d="M95 177h10" stroke={look.boat} strokeWidth={1} strokeOpacity={0.45} strokeLinecap="round" />
        </g>
      );
    case 'ink-wash':
      return (
        <g>
          {/* Mist over the town and the water, a dry-brush branch, paper fibre. */}
          <rect x={0} y={82} width={22} height={18} fill={look.paper} opacity={0.6} filter={`url(#${uid}-blur)`} />
          <rect x={86} y={82} width={74} height={18} fill={look.paper} opacity={0.6} filter={`url(#${uid}-blur)`} />
          <rect y={150} width={W} height={10} fill={look.paper} opacity={0.45} filter={`url(#${uid}-blur)`} />
          <path
            d="M118 4C128 12 136 16 156 18M132 13c-3 6-9 9-16 10M146 17c-1 5-5 9-11 11"
            stroke={look.ink}
            strokeWidth={2.6}
            strokeLinecap="round"
            strokeDasharray="7 1.5 4 1"
            fill="none"
            opacity={0.85}
          />
          <rect width={W} height={H} filter={`url(#${uid}-grain)`} opacity={0.3} />
        </g>
      );
    case 'indian-miniature': {
      const gold = preset.palette[3] || look.lamp;
      const red = preset.palette[1] || look.wall;
      const cream = preset.palette[4] || look.paper;
      const dots: Array<[number, number]> = [];
      for (let x = 8; x <= W - 8; x += 8) dots.push([x, 4], [x, H - 4]);
      for (let y = 12; y <= H - 12; y += 8) dots.push([4, y], [W - 4, y]);
      return (
        <g>
          {/* A flat gold sun, flowers on the parapet and an ornamental double border. */}
          <circle cx={128} cy={26} r={9} fill={gold} />
          <circle cx={128} cy={26} r={12.5} fill="none" stroke={gold} strokeWidth={0.8} strokeDasharray="2 2" />
          {[
            [14, 128],
            [34, 140],
            [124, 140],
            [146, 128]
          ].map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r={1.6} fill={red} />
          ))}
          <rect x={2} y={2} width={W - 4} height={H - 4} fill="none" stroke={gold} strokeWidth={4} />
          <rect x={7} y={7} width={W - 14} height={H - 14} fill="none" stroke={red} strokeWidth={1} />
          {dots.map(([x, y], i) => (
            <circle key={`d${i}`} cx={x} cy={y} r={0.9} fill={cream} />
          ))}
        </g>
      );
    }
    case 'woodcut':
      return (
        <g fill="none" strokeLinecap="round">
          {/* Carved cut lines: ink in the sky, paper through the black water, gouge marks on the stone. */}
          <path d={strokeRows(`${preset.id}-sky`, 6, 54, 6, 60, 150, 30)} stroke={look.ink} strokeWidth={1.3} />
          <path d={strokeRows(`${preset.id}-water`, 144, 196, 5, 40, 120, 40)} stroke={look.paper} strokeWidth={1.1} />
          <path d="M30 128q6-3 12 0M112 128q6-3 12 0M62 146q5-3 10 0M128 136q5-3 10 0" stroke={look.ink} strokeWidth={1.2} />
        </g>
      );
    case 'dieselpunk':
      return (
        <g>
          {/* Deco sunburst behind the town, an airship, smoky haze. */}
          <path d={raysPath(80, 98, 130, 18, Math.PI, 2 * Math.PI, 0.045)} fill={look.paper} opacity={0.14} />
          <rect y={58} width={W} height={40} fill={look.skyBottom} opacity={0.18} filter={`url(#${uid}-blur)`} />
          <g fill={look.ink}>
            <ellipse cx={40} cy={28} rx={22} ry={6.5} />
            <path d="M60 28l7-5v10Z" />
            <rect x={34} y={33} width={10} height={3} rx={1} />
          </g>
          <path d="M24 25.5h30" stroke={look.lamp} strokeWidth={0.8} opacity={0.7} strokeLinecap="round" />
        </g>
      );
    case 'brutalist': {
      const concrete = preset.palette[1] || look.city;
      return (
        <g>
          {/* Massive concrete blocks with slit windows; a hard diagonal shadow across the bridge. */}
          <rect x={104} y={6} width={56} height={62} fill={concrete} />
          {[0, 1, 2, 3, 4].map((i) => (
            <rect key={i} x={110 + i * 10} y={14} width={3} height={44} fill={look.ink} opacity={0.55} />
          ))}
          <rect x={0} y={18} width={40} height={40} fill={mix(concrete, look.ink, 0.3)} />
          <path d="M-2 108H70L40 154H-2Z" fill={look.ink} opacity={0.16} />
        </g>
      );
    }
    case 'surreal-dream':
      return (
        <g>
          {/* An oversized moon, stairs to nowhere, a paper boat floating in the sky. */}
          <circle cx={128} cy={34} r={22} fill={look.window} opacity={0.92} />
          <circle cx={120} cy={28} r={4} fill={look.skyBottom} opacity={0.35} />
          <circle cx={135} cy={42} r={2.6} fill={look.skyBottom} opacity={0.35} />
          {[
            [10, 54],
            [18, 48],
            [26, 42],
            [34, 36],
            [42, 30]
          ].map(([x, y], i) => (
            <rect key={i} x={x} y={y} width={10} height={3} fill={look.window} opacity={0.85} />
          ))}
          <path d="M42 30C58 18 52 6 38 10" stroke={look.window} strokeWidth={0.9} fill="none" opacity={0.6} />
          <g transform="translate(-70 -150)">
            <path d={BOAT_HULL} fill={look.boat} />
            <path d={BOAT_SAIL} fill={look.boat} />
          </g>
        </g>
      );
    case 'chalk-pastel':
      return (
        <g>
          {/* Chalk streaks on dark paper, haze around the lamps, grain. */}
          <path d={strokeRows(`${preset.id}-sky`, 4, 64, 3, 6, 18, 150, -3)} stroke={look.paper} strokeWidth={1.4} strokeOpacity={0.16} strokeLinecap="round" fill="none" />
          <circle cx={92} cy={81} r={12} fill={`url(#${uid}-glow)`} />
          <circle cx={152} cy={81} r={12} fill={`url(#${uid}-glow)`} />
          <rect width={W} height={H} filter={`url(#${uid}-grain)`} opacity={0.45} />
        </g>
      );
    case 'retrofuturism': {
      const sun = preset.palette[0] || look.wall;
      const ring = preset.palette[3] || look.paper;
      return (
        <g>
          {/* A striped poster sun, a ringed planet, a little rounded rocket. */}
          <circle cx={36} cy={36} r={18} fill={sun} />
          <rect x={18.1} y={38} width={35.8} height={2} fill={look.skyTop} />
          <rect x={19.4} y={43} width={33.2} height={2.5} fill={look.skyTop} />
          <rect x={22.6} y={48} width={26.8} height={3} fill={look.skyTop} />
          <circle cx={126} cy={26} r={7} fill={look.window} />
          <ellipse cx={126} cy={26} rx={15} ry={4} fill="none" stroke={ring} strokeWidth={1.2} transform="rotate(-15 126 26)" />
          <ellipse cx={148} cy={50} rx={3} ry={9} fill={ring} />
          <path d="M145 56l-3 5h3ZM151 56l3 5h-3Z" fill={sun} />
          <path d="M146.6 59.5l1.4 6 1.4-6Z" fill={look.window} />
        </g>
      );
    }
    case 'mythic-icon': {
      const gold = preset.palette[2] || look.lamp;
      const hex = Array.from({ length: 6 }, (_, i) => {
        const a = (Math.PI / 3) * i - Math.PI / 2;
        return `${r2(80 + 44 * Math.cos(a))} ${r2(60 + 44 * Math.sin(a))}`;
      });
      return (
        <g fill="none">
          {/* Sacred geometry in the sky, and a halo with rays behind the girl's head. */}
          <circle cx={80} cy={60} r={44} stroke={gold} strokeWidth={0.6} strokeOpacity={0.4} />
          <path d={`M${hex.join('L')}Z`} stroke={gold} strokeWidth={0.6} strokeOpacity={0.35} />
          <path d={spokesPath(HEAD.x, HEAD.y, 13, 30, 11, Math.PI * 1.05, Math.PI * 1.95)} stroke={gold} strokeWidth={0.7} strokeOpacity={0.6} strokeLinecap="round" />
          <circle cx={HEAD.x} cy={HEAD.y} r={10.5} stroke={gold} strokeWidth={1.3} />
          <circle cx={HEAD.x} cy={HEAD.y} r={14.5} stroke={gold} strokeWidth={0.6} strokeDasharray="1.5 1.5" />
        </g>
      );
    }
    case 'cyberpunk': {
      const magenta = preset.palette[1] || look.coat;
      const cyan = preset.palette[2] || look.lamp;
      return (
        <g>
          {/* Neon skyline edge (with a glow), lit windows, rain, neon streaks in the water. */}
          <path d={CITY} fill="none" stroke={magenta} strokeWidth={2.4} opacity={0.5} filter={`url(#${uid}-blur)`} />
          <path d={CITY} fill="none" stroke={magenta} strokeWidth={0.8} opacity={0.9} />
          {litWindows(preset.id, 18).map((w, i) => (
            <rect key={i} x={w.x} y={w.y} width={1.6} height={2.4} fill={w.on ? cyan : magenta} opacity={0.85} />
          ))}
          <path d={rainPath(preset.id, { w: W, h: H, count: 40, slant: -0.1, len: 9 })} stroke={cyan} strokeWidth={0.4} strokeOpacity={0.35} strokeLinecap="round" />
          <path d="M20 144v40M44 150v34M132 146v38M150 150v30" stroke={magenta} strokeWidth={1.4} strokeOpacity={0.35} strokeLinecap="round" />
        </g>
      );
    }
    default:
      return null;
  }
};

export const PresetThumb: React.FC<PresetThumbProps> = ({ preset, size }) => {
  const uid = `pt-${preset.id.replace(/[^a-z0-9-]/gi, '')}-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const look = lookFor(preset);
  const filter = look.filter === 'wet' ? `url(#${uid}-wet)` : look.filter === 'soft' ? `url(#${uid}-soft)` : undefined;
  const toneR = screentoneRadius(28) * 5;
  const dotInk = preset.palette[0] || '#d62828';
  return (
    <div
      aria-hidden
      data-preset-thumb={preset.id}
      className="relative aspect-[4/5] w-full overflow-hidden rounded-[inherit]"
      style={{ background: preset.swatch, ...(size ? { width: size } : {}) }}
    >
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 block h-full w-full"
        focusable="false"
        aria-hidden
      >
        <defs>
          <linearGradient id={`${uid}-sky`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={look.skyTop} />
            <stop offset="0.75" stopColor={look.skyBottom} />
          </linearGradient>
          <pattern id={`${uid}-tone`} width={5} height={5} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <circle cx={2.5} cy={2.5} r={toneR} fill="#111111" />
          </pattern>
          <pattern id={`${uid}-benday`} width={6} height={6} patternUnits="userSpaceOnUse">
            <circle cx={1.5} cy={1.5} r={1.15} fill={dotInk} />
            <circle cx={4.5} cy={4.5} r={1.15} fill={dotInk} />
          </pattern>
          <radialGradient id={`${uid}-glow`}>
            <stop offset="0" stopColor={look.lamp} stopOpacity={0.75} />
            <stop offset="1" stopColor={look.lamp} stopOpacity={0} />
          </radialGradient>
          <linearGradient id={`${uid}-fog`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#c9c1d6" stopOpacity={0} />
            <stop offset="0.5" stopColor="#c9c1d6" stopOpacity={0.28} />
            <stop offset="1" stopColor="#c9c1d6" stopOpacity={0} />
          </linearGradient>
          <filter id={`${uid}-grain`} x="0" y="0" width="100%" height="100%">
            <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={2} seed={7} stitchTiles="stitch" />
            <feColorMatrix values="0 0 0 0 0.3  0 0 0 0 0.26  0 0 0 0 0.2  0 0 0 0.55 0" />
          </filter>
          <filter id={`${uid}-wet`} x="-5%" y="-5%" width="110%" height="110%">
            <feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves={2} seed={3} result="n" />
            <feDisplacementMap in="SourceGraphic" in2="n" scale={3.2} />
          </filter>
          <filter id={`${uid}-soft`}>
            <feGaussianBlur stdDeviation={0.7} />
          </filter>
          <filter id={`${uid}-blur`}>
            <feGaussianBlur stdDeviation={1.6} />
          </filter>
        </defs>
        <Scene look={look} uid={uid} filter={filter} />
        <Treatment preset={preset} look={look} uid={uid} />
      </svg>
    </div>
  );
};

export default PresetThumb;
