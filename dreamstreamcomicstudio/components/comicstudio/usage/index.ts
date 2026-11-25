// Client feature module: money in the Comic Studio (P1-LIMITS; credit-safety.md). Registered through ../features.ts
// (contract §13.2):
//   - header slot `usage` (220): the "usage left" meter for people on DreamStream's allowance (percentages only);
//   - header slot `key-balance` (221): what the person's own OpenRouter key has left ("$12.40 left · 5 min ago");
//   - card `credit`: a run stopped on a key with no credit, or a paid step that would not fit what is left.

import type { FeatureModule } from '../extensions';
import { CreditCardView } from './CreditCard';
import { KEY_BALANCE_SLOT_ORDER, KeyBalanceSlot } from './KeyBalanceSlot';
import { USAGE_SLOT_ORDER, UsageSlot } from './UsageSlot';

export const feature: FeatureModule = {
  cards: [{ type: 'credit', Component: CreditCardView }],
  headerSlots: [
    { id: 'usage', order: USAGE_SLOT_ORDER, Component: UsageSlot },
    { id: 'key-balance', order: KEY_BALANCE_SLOT_ORDER, Component: KeyBalanceSlot }
  ]
};

export { USAGE_SLOT_ORDER, UsageSlot } from './UsageSlot';
export { KEY_BALANCE_SLOT_ORDER, KeyBalanceSlot } from './KeyBalanceSlot';
export { CreditCardView, creditWords } from './CreditCard';
