/**
 * `@dreamstream/platform-core/prompts`: versioned prompt packs (`emailDraft.v1`, `deckOutline.v1`) and the helpers
 * hosts use around a model call: `buildPrompt` (checks the input, spotlights untrusted text), `parseModelJson` and
 * `repairMessage` (the one repair turn). A pack never changes once released; a new behaviour is a new version.
 */
import type { PromptPack } from './pack.js';
import { DECK_OUTLINE_V1 } from './deckOutline.v1.js';
import { EMAIL_DRAFT_V1 } from './emailDraft.v1.js';

export * from './pack.js';
export { EMAIL_DRAFT_V1, EMAIL_DRAFT_LIMITS, EmailDraftInputSchema, trimThread } from './emailDraft.v1.js';
export type { EmailDraftInput, EmailDraftThreadMessage } from './emailDraft.v1.js';
export { DECK_OUTLINE_V1, DECK_OUTLINE_LIMITS, DeckOutlineInputSchema, DeckOutlineSchema, OUTLINE_LAYOUT, outlineToDeck } from './deckOutline.v1.js';
export type { DeckOutline, DeckOutlineInput, OutlineToDeckOptions, OutlineToDeckResult } from './deckOutline.v1.js';

/** Every pack by its versioned name. */
export const PROMPT_PACKS: { readonly [name: string]: PromptPack<never> } = {
  [EMAIL_DRAFT_V1.name]: EMAIL_DRAFT_V1 as unknown as PromptPack<never>,
  [DECK_OUTLINE_V1.name]: DECK_OUTLINE_V1 as unknown as PromptPack<never>,
};

/** `prompts.emailDraft.v1`, as the plan names them. */
export const prompts = {
  emailDraft: { v1: EMAIL_DRAFT_V1 },
  deckOutline: { v1: DECK_OUTLINE_V1 },
} as const;
