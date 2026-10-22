// Lazy per-script lettering fonts (i18n.md §6.1; owner P1-I18N).
// Wave 0 (P0-C) stub: `ensureFontsFor` resolves at once with {degraded:false} and loads nothing;
// `cssFontFamily` already answers from the shared font registry. P1-I18N injects the Google
// Fonts CSS2 link and awaits document.fonts.load with sample text (bounded by timeoutMs).

import { languageSpec } from '../../../shared/comic/languages';
import { FONT_REGISTRY } from '../../../shared/comic/lettering/fonts';

export type FontRole = 'dialogue' | 'legible' | 'sfx';

/** CSS font-family stack for a language's role face (`"Noto Sans Telugu", system-ui, sans-serif`). */
export const cssFontFamily = (lang: string, role: FontRole): string => {
  const id = languageSpec(lang)?.fonts[role];
  const meta = (id && FONT_REGISTRY[id]) || FONT_REGISTRY['comic-neue'];
  return `"${meta.family}", ${meta.fallback}`;
};

/**
 * Make sure the faces for these languages/roles are loaded before measuring or drawing text
 * (canvas measures with whatever font is ready). Never rejects; `degraded: true` means some
 * face did not load in time and a fallback font may be used.
 */
export const ensureFontsFor = (_langs: string[], _roles: FontRole[], _sampleText: string, _timeoutMs?: number): Promise<{ degraded: boolean }> =>
  Promise.resolve({ degraded: false });
