// The names and numbers the landing shows about the studio, read from the studio's own registries so the page cannot
// drift from what members get: the image model new comics start on (the Draft and Standard tiers' model), the other
// image models the studio's picker offers, the two quality levels a member picks between, the page cap, the built-in
// looks and the languages a comic can be translated into. Only the names members see in the product (each model's
// nickname, each tier's label) and sizes leave this module: never a registry id, a price, a grade or a benchmark.

import { DOC_LIMITS } from '../../../shared/comic/limits';
import { LANGUAGES } from '../../../shared/comic/languages';
import { TIER_PRESETS, getImageModel, pickableImageModels } from '../../../shared/comic/models';
import { STYLE_PRESETS } from '../../../shared/comic/stylePresets';

const defaultSpec = getImageModel(TIER_PRESETS.standard.model);
if (!defaultSpec) throw new Error('The landing names the Standard tier’s image model, and the registry has no entry for it.');

/** The image model new comics are drawn with (the Standard tier's), as members see it named. */
export const DEFAULT_MODEL: Readonly<{ name: string; characters: number }> = Object.freeze({
  name: defaultSpec.nickname,
  characters: defaultSpec.refs.characters
});

/** Every other image model the studio's model picker offers today, by the name members see, in registry order. */
export const OTHER_MODELS: readonly string[] = Object.freeze(
  pickableImageModels()
    .filter((m) => m.id !== defaultSpec.id)
    .map((m) => m.nickname)
);

/** The two quality levels every member can pick between, in order: their names and page sizes. */
export const QUALITY: ReadonlyArray<Readonly<{ name: string; pageSize: string }>> = Object.freeze(
  [TIER_PRESETS.draft, TIER_PRESETS.standard].map((tier) => Object.freeze({ name: tier.label, pageSize: tier.pageRes }))
);

/** The most pages one comic can have. */
export const PAGES_MAX: number = DOC_LIMITS.pages;
/** How many built-in looks the studio offers. */
export const LOOKS: number = STYLE_PRESETS.length;
/** How many languages a comic can be translated into (every supported language but English, the source). */
export const LANGS: number = LANGUAGES.length - 1;

/** "A, B and C" (or "A" / "A and B"). */
export const listOf = (names: readonly string[]): string =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** Every `{NAME}` the landing's copy may use, filled from the registries above. */
export const LANDING_VALUES: Readonly<Record<string, string | number>> = Object.freeze({
  DEFAULT_MODEL: DEFAULT_MODEL.name,
  CHARACTERS: DEFAULT_MODEL.characters,
  OTHER_MODELS: listOf(OTHER_MODELS),
  DRAFT: QUALITY[0].name,
  DRAFT_SIZE: QUALITY[0].pageSize,
  STANDARD: QUALITY[1].name,
  STANDARD_SIZE: QUALITY[1].pageSize,
  PAGES_MAX,
  LOOKS,
  LANGS
});
