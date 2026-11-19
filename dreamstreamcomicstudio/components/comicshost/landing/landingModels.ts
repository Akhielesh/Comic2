// The names and numbers the landing shows about the studio, read from the studio's own registries so the page cannot
// drift from what members get: the image model new comics start on (the Draft and Standard tiers' model), the other
// image models the studio's picker offers, the two quality levels every member can use, the page cap, the built-in
// looks and the languages a comic can be translated into. Only the names members see in the product (each model's
// nickname, each tier's label) and sizes leave this module: never a registry id, a price, a grade or a benchmark.

import { DOC_LIMITS } from '../../../shared/comic/limits';
import { LANGUAGES } from '../../../shared/comic/languages';
import { TIER_PRESETS, getImageModel, pickableImageModels, type ImageModelSpec } from '../../../shared/comic/models';
import { STYLE_PRESETS } from '../../../shared/comic/stylePresets';

const defaultSpec = getImageModel(TIER_PRESETS.standard.model);
if (!defaultSpec) throw new Error('The landing names the Standard tier’s image model, and the registry has no entry for it.');

/** The image model new comics are drawn with (the Standard tier's), as members see it named. */
export const DEFAULT_MODEL: Readonly<{ name: string; characters: number }> = Object.freeze({
  name: defaultSpec.nickname,
  characters: defaultSpec.refs.characters
});

/** "A, B and C" (or "A" / "A and B"). */
export function listOf(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const otherSpecs = pickableImageModels().filter((m) => m.id !== defaultSpec.id);

/**
 * Every other image model the studio's model picker offers today, by the name members see, in registry order. Only
 * accounts with model choice can pick them (modelLock.ts `modelFit`: an own key, among others); the default needs none.
 */
export const OTHER_MODELS: readonly string[] = Object.freeze(otherSpecs.map((m) => m.nickname));

/** How the registry marks a model that is not yet generally available, in the words the page uses. */
const STATUS_WORDS: Readonly<Partial<Record<ImageModelSpec['lifecycle'], string>>> = { experimental: 'experimental', preview: 'in preview' };

/** "A is experimental." / "A and B are experimental." for each non-GA lifecycle among `specs`, in registry order. */
export const statusNote = (specs: readonly Pick<ImageModelSpec, 'nickname' | 'lifecycle'>[]): string =>
  (Object.keys(STATUS_WORDS) as ImageModelSpec['lifecycle'][])
    .map((lifecycle) => {
      const names = specs.filter((m) => m.lifecycle === lifecycle).map((m) => m.nickname);
      return names.length ? ` ${listOf(names)} ${names.length === 1 ? 'is' : 'are'} ${STATUS_WORDS[lifecycle]}.` : '';
    })
    .join('');

/**
 * The two quality levels every member can use (Draft and Standard), in order: their names and page sizes. Pro is left
 * out: whether it runs depends on the account (StudioCaps.qualityTiers), so the page never promises it. The page says
 * Draft is the lower resolution in plain words; landingModels.test.ts holds the registry to that.
 */
export const QUALITY: ReadonlyArray<Readonly<{ name: string; pageSize: string }>> = Object.freeze(
  [TIER_PRESETS.draft, TIER_PRESETS.standard].map((tier) => Object.freeze({ name: tier.label, pageSize: tier.pageRes }))
);

/** The most pages one comic can have. */
export const PAGES_MAX: number = DOC_LIMITS.pages;
/** How many built-in looks the studio offers. */
export const LOOKS: number = STYLE_PRESETS.length;
/** How many languages a comic can be translated into (every supported language but English, the source). */
export const LANGS: number = LANGUAGES.length - 1;

/** Every `{NAME}` the landing's copy may use, filled from the registries above. */
export const LANDING_VALUES: Readonly<Record<string, string | number>> = Object.freeze({
  DEFAULT_MODEL: DEFAULT_MODEL.name,
  CHARACTERS: DEFAULT_MODEL.characters,
  OTHER_MODELS: listOf(OTHER_MODELS),
  /** The registry's own status of the other models (experimental, in preview), or nothing when all are GA. */
  OTHER_MODELS_STATUS: statusNote(otherSpecs),
  DRAFT: QUALITY[0].name,
  DRAFT_SIZE: QUALITY[0].pageSize,
  STANDARD: QUALITY[1].name,
  STANDARD_SIZE: QUALITY[1].pageSize,
  PAGES_MAX,
  LOOKS,
  LANGS
});
