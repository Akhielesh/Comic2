// Client feature module: the breakdown card (cards: breakdown). Owner: P1-BOOKMODEL.
// Registered through ../features.ts (contract §13.2). `plan` is a built-in card type, so the
// legacy plan card keeps rendering through CardRenderer until P2-CONVERSATION routes it here
// (BreakdownCard accepts both payloads).

import type { FeatureModule } from '../extensions';
import { BreakdownCard } from './BreakdownCard';

export const feature: FeatureModule = {
  cards: [{ type: 'breakdown', Component: BreakdownCard }]
};

export { BreakdownCard } from './BreakdownCard';
export type { BreakdownCardData, BreakdownCardProps, BreakdownView, LegacyPlanCardData } from './BreakdownCard';
export { PageWireframe, SHOT_GLYPH } from './PageWireframe';
