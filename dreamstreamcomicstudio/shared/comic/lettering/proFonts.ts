// Pro lettering fonts (master plan §2.3 "Fonts", §2.6; PE-FONTS). 28 self-hosted @fontsource faces under OFL-1.1 or
// Apache-2.0, on top of the 26 base faces (FONT_IDS), so lettering has 54. Ids only, plus the picker's role words:
// the face metadata (families, weights, licences, metrics) is PRO_FONT_REGISTRY in lettering/fonts.ts, the files are
// in components/comicstudio/lettering/fontFiles.ts (loaded only when a face is asked for).
//
// Dependency-free at runtime (a type import only): lettering/style.ts (PE-LETTER) imports PRO_FONT_IDS to build
// DRAWN_FONTS and client acceptance, so this file must never import style.ts or fonts.ts at runtime (collisions B-2).
// Every id matches style.ts's STORED_FONT_ID_RE, so a Pro font a newer build stored survives a load on any build.
// Writing one from a client stays gated on PRO_EDIT_OPS_PATCHABLE (style.ts / the inspector, lead decision C-9).

import type { FontId } from './style.js';

/** A Pro lettering font id, in picker order (display, friendly dialogue, handwritten, genre). */
export type ProFontId =
  | 'bungee' | 'bungee-shade' | 'titan-one' | 'lilita-one' | 'black-ops-one' | 'sigmar-one' | 'bowlby-one-sc'
  | 'knewave' | 'rubik-mono-one'
  | 'boogaloo' | 'chewy' | 'fredoka' | 'grandstander' | 'comic-relief'
  | 'caveat' | 'gochi-hand' | 'schoolbell' | 'architects-daughter' | 'indie-flower' | 'rock-salt'
  | 'shadows-into-light' | 'gloria-hallelujah'
  | 'creepster' | 'press-start-2p' | 'vt323' | 'orbitron' | 'cinzel' | 'unifrakturmaguntia';

/** Every Pro font id, in picker order. */
export const PRO_FONT_IDS: readonly ProFontId[] = Object.freeze<ProFontId[]>([
  'bungee', 'bungee-shade', 'titan-one', 'lilita-one', 'black-ops-one', 'sigmar-one', 'bowlby-one-sc', 'knewave',
  'rubik-mono-one',
  'boogaloo', 'chewy', 'fredoka', 'grandstander', 'comic-relief',
  'caveat', 'gochi-hand', 'schoolbell', 'architects-daughter', 'indie-flower', 'rock-salt', 'shadows-into-light',
  'gloria-hallelujah',
  'creepster', 'press-start-2p', 'vt323', 'orbitron', 'cinzel', 'unifrakturmaguntia'
]);

/** Any lettering font: the base faces and the Pro ones. */
export type AnyFontId = FontId | ProFontId;

/** A Pro font id this build ships. */
export const isProFontId = (v: unknown): v is ProFontId => typeof v === 'string' && (PRO_FONT_IDS as readonly string[]).includes(v);

/** What each Pro face is for, in a few plain words (the font picker's second line). */
export const PRO_FONT_ROLES: Readonly<Record<ProFontId, string>> = Object.freeze({
  bungee: 'Signs, shouts',
  'bungee-shade': '3-D titles',
  'titan-one': 'Bold, friendly titles',
  'lilita-one': 'Punchy captions',
  'black-ops-one': 'Stencil, military',
  'sigmar-one': 'Heavy display',
  'bowlby-one-sc': 'Poster titles',
  knewave: 'Brush sound effects',
  'rubik-mono-one': 'Wide, blocky',
  boogaloo: 'Retro, groovy',
  chewy: 'Cartoon, kids',
  fredoka: 'Rounded, friendly',
  grandstander: 'Playful dialogue',
  'comic-relief': 'Comic dialogue',
  caveat: 'Handwritten notes',
  'gochi-hand': 'Marker handwriting',
  schoolbell: 'Chalkboard, school',
  'architects-daughter': 'Hand-drawn captions',
  'indie-flower': 'Bubbly handwriting',
  'rock-salt': 'Rough, scrawled',
  'shadows-into-light': 'Light handwriting',
  'gloria-hallelujah': 'Doodle handwriting',
  creepster: 'Horror',
  'press-start-2p': 'Pixel, video games',
  vt323: 'Computers, robots',
  orbitron: 'Sci-fi',
  cinzel: 'Epic, fantasy',
  unifrakturmaguntia: 'Gothic, medieval'
});
