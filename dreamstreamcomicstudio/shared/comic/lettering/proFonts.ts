// Pro lettering fonts (master plan §2.3 "Fonts", §2.6). EMPTY SEAM (PE-0): PE-FONTS fills it with about 28 self-hosted
// OFL / Apache faces (Bungee, Titan One, Creepster, Caveat…), so lettering/style.ts keeps one owner per wave.
//
// Until then there is no Pro font: ProFontId is `never`, PRO_FONT_IDS is empty, and the lettering sanitizer accepts
// only FONT_IDS from a client (style.ts). A font id a newer build stored is kept on load (sanitizeLetterStylePatch with
// keepStoredPro), so a rollback never strips it, and resolveLetterStyle draws the cascade's face instead.

import type { FontId } from './style.js';

/** A Pro lettering font id (none yet). */
export type ProFontId = never;
/** Every Pro font id, in picker order. */
export const PRO_FONT_IDS: readonly ProFontId[] = Object.freeze(new Array<ProFontId>());
/** Any lettering font: the base faces and the Pro ones. */
export type AnyFontId = FontId | ProFontId;
/** A Pro font id this build ships. */
export const isProFontId = (v: unknown): v is ProFontId => typeof v === 'string' && (PRO_FONT_IDS as readonly string[]).includes(v);
