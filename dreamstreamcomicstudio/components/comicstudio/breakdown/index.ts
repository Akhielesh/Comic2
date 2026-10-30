// Client feature module: the breakdown card (cards: breakdown). Owner: P1-BOOKMODEL.
// Registered through ../features.ts (contract §13.2). `plan` is a built-in card type, so the
// legacy plan card keeps rendering through CardRenderer until P2-CONVERSATION routes it here
// (BreakdownCard accepts both payloads).

import type { FeatureModule } from '../extensions';
import { BreakdownCard } from './BreakdownCard';

export const feature: FeatureModule = {
  cards: [{ type: 'breakdown', Component: BreakdownCard }]
};

export { BreakdownCard, fitWords, gateRenderAll, layoutFitFix, paidAmount } from './BreakdownCard';
export type { BreakdownCardData, BreakdownCardProps, BreakdownView, LegacyPlanCardData } from './BreakdownCard';
// The fit dot and the free layout fix, for other surfaces that show plan fit (the lettering chip, templates).
export { FIT_DOT_COLOR, PageWireframe, SHOT_GLYPH, fitDotOf } from './PageWireframe';
export type { FitDot } from './PageWireframe';
